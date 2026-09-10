import type { Request, Response } from 'express'
import { put, get } from '@vercel/blob'
import { createHash, randomUUID } from 'node:crypto'

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  const allowed =
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker-[a-z0-9-]+\.vercel\.app$/i.test(origin)
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Sync-Key')
}

function getSyncKey(req: Request) {
  const key = String(req.headers['x-sync-key'] || '').trim()
  if (key.length < 24) throw new Error('유효한 X-Sync-Key가 필요합니다.')
  return key
}

function workspaceId(key: string) {
  return createHash('sha256').update(key).digest('hex')
}
function syncBase(key: string) { return `tracker-sync/${workspaceId(key)}` }
function manifestPath(key: string) { return `${syncBase(key)}/manifest.json` }
function chunkPath(key: string, slot: string, index: number) { return `${syncBase(key)}/${slot}/chunk-${index}.bin` }
function validSlot(v: unknown) {
  const slot = String(v || '')
  if (slot !== 'a' && slot !== 'b') throw new Error('잘못된 동기화 슬롯입니다.')
  return slot
}
function validIndex(v: unknown) {
  const index = Number(v)
  if (!Number.isInteger(index) || index < 0 || index > 10000) throw new Error('잘못된 청크 번호입니다.')
  return index
}

async function readPrivate(path: string) {
  const result: any = await get(path, { access: 'private', useCache: false })
  if (!result || result.statusCode !== 200 || !result.stream) return null
  return result
}
async function readJson(path: string) {
  const result = await readPrivate(path)
  if (!result) return null
  return JSON.parse(await new Response(result.stream).text())
}

async function readBody(req: Request): Promise<any> {
  if (req.body !== undefined && req.body !== null) return req.body
  const chunks: Buffer[] = []
  for await (const chunk of req as any) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const buf = Buffer.concat(chunks)
  const type = String(req.headers['content-type'] || '')
  if (type.includes('application/json')) {
    const text = buf.toString('utf8')
    return text ? JSON.parse(text) : {}
  }
  return buf
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  try {
    const rawPath = (req.query as any).path
    const urlPath = String((req as any).url || '').split('?')[0]
    const fallbackPath = urlPath.replace(/^\/api\/sync\/?/, '')
    const parts = Array.isArray(rawPath)
      ? rawPath.map(String)
      : String(rawPath || fallbackPath || '').split('/').filter(Boolean)
    const key = getSyncKey(req)

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'manifest') {
      const manifest = await readJson(manifestPath(key))
      return res.status(200).json({ ok: true, manifest: manifest || null })
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'start') {
      const current = await readJson(manifestPath(key))
      const slot = current?.activeSlot === 'a' ? 'b' : 'a'
      return res.status(200).json({ ok: true, slot, chunkBytes: 2 * 1024 * 1024, previousRevision: current?.revision || null })
    }

    if (parts.length === 3 && parts[0] === 'chunk') {
      const slot = validSlot(parts[1])
      const index = validIndex(parts[2])
      if (req.method === 'POST') {
        const incoming = await readBody(req)
        let body: Buffer
        if (Buffer.isBuffer(incoming)) body = incoming
        else if (incoming instanceof Uint8Array) body = Buffer.from(incoming)
        else if (typeof incoming === 'string') body = Buffer.from(incoming)
        else if (incoming && typeof incoming === 'object' && incoming.type === 'Buffer' && Array.isArray(incoming.data)) body = Buffer.from(incoming.data)
        else body = Buffer.from([])
        if (!body.length) throw new Error('업로드 청크가 비어 있습니다.')
        const blob: any = await put(chunkPath(key, slot, index), body, {
          access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream'
        })
        return res.status(200).json({ ok: true, slot, index, size: body.length, etag: blob.etag || null })
      }
      if (req.method === 'GET') {
        const result: any = await readPrivate(chunkPath(key, slot, index))
        if (!result) return res.status(404).json({ error: { message: '클라우드 청크를 찾을 수 없습니다.' } })
        const buffer = Buffer.from(await new Response(result.stream).arrayBuffer())
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', String(buffer.length))
        return res.status(200).send(buffer)
      }
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'commit') {
      const body = await readBody(req)
      const slot = validSlot(body?.slot)
      const chunkCount = Number(body?.chunkCount)
      const byteLength = Number(body?.byteLength)
      if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 10000) throw new Error('잘못된 청크 개수입니다.')
      if (!Number.isFinite(byteLength) || byteLength < 1) throw new Error('잘못된 백업 크기입니다.')
      const current = await readJson(manifestPath(key))
      const previousRevision = body?.previousRevision ?? null
      if ((current?.revision || null) !== previousRevision) {
        return res.status(409).json({ error: { message: '다른 기기에서 클라우드 작업이 먼저 변경되었습니다. 연결 확인 후 다시 업로드해주세요.' } })
      }
      const manifest = {
        format: 'SPB1-CLOUD', version: 1, activeSlot: slot, chunkCount, byteLength,
        revision: randomUUID(), updatedAt: new Date().toISOString()
      }
      await put(manifestPath(key), JSON.stringify(manifest), {
        access: 'private', allowOverwrite: true, addRandomSuffix: false,
        contentType: 'application/json', cacheControlMaxAge: 60
      })
      return res.status(200).json({ ok: true, manifest })
    }

    return res.status(404).json({ error: { message: 'Sync route not found' } })
  } catch (error: any) {
    return res.status(400).json({ error: { message: error?.message || String(error) } })
  }
}
