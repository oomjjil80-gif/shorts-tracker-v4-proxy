import { createHash, createHmac } from 'node:crypto'
import * as vercelBlob from '@vercel/blob'

type PutOpts = {
  access?: 'private' | 'public'
  addRandomSuffix?: boolean
  allowOverwrite?: boolean
  contentType?: string
  cacheControlMaxAge?: number
}
type GetOpts = { access?: 'private' | 'public'; useCache?: boolean }
type ListOpts = { prefix?: string; limit?: number; cursor?: string }

const r2Configured = () => Boolean(
  process.env.R2_ENDPOINT &&
  process.env.R2_BUCKET &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
)

const awsEncode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const keyUri = (path: string) => '/' + [String(process.env.R2_BUCKET || ''), ...String(path).split('/')].map(awsEncode).join('/')

const endpoint = () => {
  const raw = String(process.env.R2_ENDPOINT || '').trim().replace(/\/$/, '')
  if (!raw) throw new Error('R2_ENDPOINT is not configured')
  return new URL(raw)
}

const sha256Hex = (body: string | Buffer) => createHash('sha256').update(body).digest('hex')
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest()
const hmacHex = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest('hex')

function amzNow(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

function signingKey(secret: string, dateStamp: string) {
  const date = hmac('AWS4' + secret, dateStamp)
  const region = hmac(date, 'auto')
  const service = hmac(region, 's3')
  return hmac(service, 'aws4_request')
}

function queryString(entries: Array<[string, string]>) {
  return entries
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function credentials() {
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
  if (!accessKeyId || !secretAccessKey) throw new Error('R2 credentials are not configured')
  return { accessKeyId, secretAccessKey }
}

async function signedFetch(
  method: 'GET' | 'PUT' | 'HEAD',
  path: string,
  opts: { body?: string | Buffer; contentType?: string; query?: Array<[string, string]> } = {}
) {
  const base = endpoint()
  const { accessKeyId, secretAccessKey } = credentials()
  const { amzDate, dateStamp } = amzNow()
  const body = opts.body ?? ''
  const payloadHash = sha256Hex(body)
  const canonicalUri = keyUri(path)
  const canonicalQuery = queryString(opts.query || [])
  const host = base.host
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (opts.contentType) headers['content-type'] = opts.contentType
  const signedHeaderNames = Object.keys(headers).sort()
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k].trim()}\n`).join('')
  const signedHeaders = signedHeaderNames.join(';')
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/auto/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(signingKey(secretAccessKey, dateStamp), stringToSign)
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const url = `${base.origin}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`
  const requestHeaders: Record<string, string> = { ...headers, Authorization: authorization }
  delete requestHeaders.host
  return fetch(url, {
    method,
    headers: requestHeaders,
    ...(method === 'PUT' ? { body: typeof body === 'string' ? body : new Uint8Array(body) } : {}),
  })
}

function xmlDecode(value: string) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

async function r2Put(path: string, body: string | Buffer, opts: PutOpts = {}) {
  const res = await signedFetch('PUT', path, { body, contentType: opts.contentType })
  if (!res.ok) throw new Error(`R2 PUT failed (${res.status}): ${await res.text()}`)
  return { url: `${endpoint().origin}${keyUri(path)}`, etag: res.headers.get('etag') || null }
}

async function r2Get(path: string) {
  const res = await signedFetch('GET', path)
  if (res.status === 404) return null
  if (!res.ok || !res.body) throw new Error(`R2 GET failed (${res.status}): ${await res.text()}`)
  return {
    statusCode: 200,
    stream: res.body,
    blob: {
      size: Number(res.headers.get('content-length') || 0),
      pathname: path,
      contentType: res.headers.get('content-type') || undefined,
    },
  }
}

async function r2Head(path: string) {
  const res = await signedFetch('HEAD', path)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`R2 HEAD failed (${res.status})`)
  let sizeHeader = res.headers.get('content-length')
  let contentType = res.headers.get('content-type') || undefined
  let etag = res.headers.get('etag') || undefined

  // Some R2 responses omit Content-Length on HEAD. Probe only response headers
  // with GET and cancel the body immediately so metadata checks stay correct
  // without downloading the object.
  if (sizeHeader === null) {
    const probe = await signedFetch('GET', path)
    if (probe.status === 404) return null
    if (!probe.ok) throw new Error(`R2 metadata probe failed (${probe.status})`)
    sizeHeader = probe.headers.get('content-length')
    contentType ||= probe.headers.get('content-type') || undefined
    etag ||= probe.headers.get('etag') || undefined
    try { await probe.body?.cancel() } catch {}
  }

  return {
    pathname: path,
    size: Number(sizeHeader || 0),
    contentType,
    etag,
  }
}

async function r2List(opts: ListOpts = {}) {
  const query: Array<[string, string]> = [
    ['list-type', '2'],
    ['prefix', String(opts.prefix || '')],
    ['max-keys', String(Math.max(1, Math.min(1000, Number(opts.limit || 100))))],
  ]
  if (opts.cursor) query.push(['continuation-token', String(opts.cursor)])
  const res = await signedFetch('GET', '', { query })
  if (!res.ok) throw new Error(`R2 LIST failed (${res.status}): ${await res.text()}`)
  const xml = await res.text()
  const blobs = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)]
    .map((m) => ({ pathname: xmlDecode(m[1]) }))
  const hasMore = /<IsTruncated>true<\/IsTruncated>/.test(xml)
  const cursorMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)
  return { blobs, hasMore, cursor: cursorMatch ? xmlDecode(cursorMatch[1]) : null }
}

async function r2Presign(path: string, validForMs = 60 * 60 * 1000) {
  const base = endpoint()
  const { accessKeyId, secretAccessKey } = credentials()
  const { amzDate, dateStamp } = amzNow()
  const scope = `${dateStamp}/auto/s3/aws4_request`
  const expires = Math.max(1, Math.min(604800, Math.floor(validForMs / 1000)))
  const canonicalUri = keyUri(path)
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  const canonicalQuery = queryString(query)
  const canonicalHeaders = `host:${base.host}\n`
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(signingKey(secretAccessKey, dateStamp), stringToSign)
  const url = `${base.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
  return { url, validUntil: Date.now() + expires * 1000 }
}

// New writes go to R2 when configured. Reads fall back to the old private
// Vercel Blob store so existing source assets/jobs keep working during cutover.
export async function put(path: string, body: string | Buffer, opts: PutOpts = {}) {
  if (r2Configured()) return r2Put(path, body, opts)
  return (vercelBlob as any).put(path, body, opts)
}

export async function get(path: string, opts: GetOpts = {}) {
  if (r2Configured()) {
    const value = await r2Get(path)
    if (value) return value
  }
  return (vercelBlob as any).get(path, opts)
}

export async function head(path: string) {
  if (r2Configured()) {
    const value = await r2Head(path)
    if (value) return value
  }
  return (vercelBlob as any).head(path)
}

export async function list(opts: ListOpts = {}) {
  if (r2Configured()) return r2List(opts)
  return (vercelBlob as any).list(opts)
}

export async function presign(path: string, validForMs = 60 * 60 * 1000) {
  if (r2Configured()) {
    const exists = await r2Head(path)
    if (exists) return r2Presign(path, validForMs)
  }
  const mod: any = vercelBlob
  if (!mod.issueSignedToken || !mod.presignUrl) return null
  const token = await mod.issueSignedToken({ pathname: path, operations: ['get'] })
  const validUntil = Date.now() + validForMs
  const signed = await mod.presignUrl(token, { pathname: path, operation: 'get', validUntil, access: 'private' })
  return { url: signed.presignedUrl, validUntil }
}

export function storageBackend() {
  return r2Configured() ? 'r2' : 'vercel-blob'
}
