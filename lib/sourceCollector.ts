import { put } from '@vercel/blob'
import { randomUUID } from 'node:crypto'
import { resolveDouyin, validateDouyinMedia } from './douyinResolver.js'

const SOURCE_HOSTS = new Set(['instagram.com','www.instagram.com','tiktok.com','www.tiktok.com','vm.tiktok.com','reddit.com','www.reddit.com','v.redd.it','x.com','www.x.com','twitter.com','www.twitter.com','youtube.com','www.youtube.com','youtu.be','facebook.com','www.facebook.com','fb.watch','bilibili.com','www.bilibili.com','xiaohongshu.com','www.xiaohongshu.com','douyin.com','www.douyin.com','v.douyin.com'])
const defaults = { fetch, put, resolveDouyin, env: process.env }
type Dependencies = typeof defaults

export async function readSourceBytes(response: globalThis.Response, max: number): Promise<Buffer> {
  if (!response.ok) throw new Error('media fetch failed: ' + response.status)
  if (Number(response.headers.get('content-length') || 0) > max) {
    await response.body?.cancel()
    throw new Error('source media exceeds size limit')
  }
  if (!response.body) throw new Error('source media is empty')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > max) { await reader.cancel(); throw new Error('source media exceeds size limit') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  if (!bytes) throw new Error('source media is empty')
  return Buffer.concat(chunks, bytes)
}

export async function collectSource(body: any, deps: Dependencies = defaults) {
  const raw = String(body?.sourceUrl || '').trim()
  if (!raw) throw new Error('sourceUrl is required')
  const src = new URL(raw)
  if (src.protocol !== 'https:' || src.username || src.password || src.port || !SOURCE_HOSTS.has(src.hostname.toLowerCase())) {
    throw new Error('unsupported source host')
  }
  const douyin = src.hostname === 'douyin.com' || src.hostname.endsWith('.douyin.com')
  let mediaUrl = '', mediaTitle = '', videoId = ''
  let resolver = '', resolveMs = 0
  let mediaHeaders: Record<string, string>

  if (douyin) {
    const result = await deps.resolveDouyin(src.href)
    mediaUrl = result.mediaUrl
    mediaTitle = result.filename
    mediaHeaders = result.headers
    videoId = result.videoId
    resolver = result.resolver
    resolveMs = result.resolveMs
  } else {
    // Keep the working Cobalt request and picker response contract unchanged.
    const cobaltBase = String(deps.env.COBALT_API_URL || '').trim().replace(/\/$/, '')
    if (!cobaltBase) {
      const error: any = new Error('COBALT_API_URL is not configured')
      error.code = 'COLLECTOR_NOT_CONFIGURED'
      throw error
    }
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
    const key = String(deps.env.COBALT_API_KEY || '').trim()
    if (key) headers.Authorization = 'Api-Key ' + key
    const response = await deps.fetch(cobaltBase + '/', {
      method: 'POST', headers,
      body: JSON.stringify({ url: src.toString(), downloadMode: 'auto', videoQuality: String(body?.videoQuality || '1080'), filenameStyle: 'basic', youtubeVideoCodec: 'h264' })
    })
    const rawResponse = await response.text()
    let data: any = {}
    try { data = rawResponse ? JSON.parse(rawResponse) : {} } catch {}
    if (!response.ok || data?.status === 'error') throw new Error(data?.error?.code || data?.error?.message || rawResponse || 'cobalt request failed')
    if (data?.status === 'picker') return { ok: true, needsSelection: true, sourceUrl: src.toString(), picker: data }
    if (!['tunnel', 'redirect'].includes(data?.status) || !data?.url) throw new Error('No downloadable media URL returned')
    mediaUrl = String(data.url)
    mediaTitle = String(data.filename || '')
    mediaHeaders = { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1', Referer: 'https://www.douyin.com/' }
    if (key) mediaHeaders.Authorization = 'Api-Key ' + key
  }

  let response: globalThis.Response
  if (douyin) {
    // Validate every CDN redirect, not just the initial player URL.
    for (let redirects = 0; ; redirects++) {
      validateDouyinMedia(mediaUrl, videoId)
      response = await deps.fetch(mediaUrl, { headers: mediaHeaders, redirect: 'manual', signal: AbortSignal.timeout(45_000) })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      await response.body?.cancel()
      if (redirects >= 4) throw new Error('too many Douyin media redirects')
      const location = response.headers.get('location')
      if (!location) throw new Error('invalid Douyin media redirect')
      mediaUrl = new URL(location, mediaUrl).href
    }
  } else {
    response = await deps.fetch(mediaUrl, { headers: mediaHeaders, redirect: 'follow' })
  }
  const limit = Number(deps.env.SOURCE_COLLECTOR_MAX_BYTES || 150 * 1024 * 1024)
  const max = Number.isFinite(limit) && limit > 0 ? limit : 150 * 1024 * 1024
  const buf = await readSourceBytes(response, max)
  if (douyin && (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp')) {
    throw new Error('Douyin media response is not an MP4 file')
  }
  const id = randomUUID()
  const filename = String(mediaTitle || ('source-' + id + '.mp4')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160)
  const path = 'source-collector/' + new Date().toISOString().slice(0, 10) + '/' + id + '-' + filename
  const contentType = douyin ? 'video/mp4' : response.headers.get('content-type') || 'video/mp4'
  const blob = await deps.put(path, buf, { access: 'private', addRandomSuffix: false, contentType })
  return {
    ok: true, needsSelection: false,
    source: { id, originalUrl: src.toString(), platform: src.hostname, filename, bytes: buf.length, contentType, blobPath: path, blobUrl: blob.url || null, collectedAt: new Date().toISOString(), ...(douyin ? { resolver, resolveMs, videoId } : {}) }
  }
}
