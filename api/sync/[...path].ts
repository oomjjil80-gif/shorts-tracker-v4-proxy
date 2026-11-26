import type { Request, Response } from 'express'
import { put, putIfAbsent, putIfMatch, get, head, list, storageBackend } from '../../lib/objectStorage.js'
import { createHash, randomUUID } from 'node:crypto'

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  const configuredOrigin = String(process.env.TRACKER_WEB_ORIGIN || '').trim().replace(/\/$/, '')
  const allowed =
    (configuredOrigin !== '' && origin === configuredOrigin) ||
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker-[a-z0-9-]+\.vercel\.app$/i.test(origin)
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Sync-Key, X-Episode-Revision, X-Episode-Base, X-Upload-Client')
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
function episodeId(v: unknown) {
  const id = String(v || '')
  if (!/^ep_[a-z0-9]{8,40}$/i.test(id)) throw new Error('잘못된 에피소드 ID입니다.')
  return id
}
function episodePath(key: string, id: string) { return `${syncBase(key)}/episodes/${id}.spbak` }
function episodeManifestPath(key: string, id: string) { return `${syncBase(key)}/episodes/${id}.json` }
function scopedManifestPath(key: string, id: string | null) {
  return id ? episodeManifestPath(key, id) : manifestPath(key)
}
function scopedChunkPath(key: string, id: string | null, slot: string, index: number) {
  return id ? `${syncBase(key)}/episodes/${id}/${slot}/chunk-${index}.bin` : chunkPath(key, slot, index)
}
// 에피소드 단위: 슬롯은 서버가 저장 요청마다 발급한 uploadId(읽기는 예전 a/b 슬롯도 허용). 쓰기는 uploadId 경로에만 허용한다.
function validSlot(v: unknown, scoped = false, write = false) {
  const slot = String(v || '')
  if (scoped && UPLOAD_SLOT.test(slot)) return slot
  if (scoped && write) throw new Error('잘못된 업로드 ID입니다.')
  if (slot !== 'a' && slot !== 'b') throw new Error('잘못된 동기화 슬롯입니다.')
  return slot
}
function validIndex(v: unknown) {
  const index = Number(v)
  if (!Number.isInteger(index) || index < 0 || index > 10000) throw new Error('잘못된 청크 번호입니다.')
  return index
}

// 에피소드 단위 저장은 "로컬 사본이 실제로 기반한 revision"(X-Episode-Base)과 서버의 현재 revision이 같을 때만 허용한다.
//  - 헤더 값 ''  : 클라우드에 아직 없다고 알고 있는 사본(첫 저장)
//  - 헤더 없음   : 기준을 모르는 사본 → 클라우드에 이미 있으면 거절(덮어쓰지 않는다)
async function episodeBaseConflict(req: Request, key: string, id: string) {
  const current = await readJson(episodeManifestPath(key, id))
  const raw = req.headers['x-episode-base']
  const base = raw === undefined ? null : String(raw)
  const ok = base === null ? !current : (current?.revision || '') === base
  return ok ? null : current
}
// 저장 요청(start)마다 서버가 새 uploadId를 발급하고, 청크는 그 요청 전용 경로(`episodes/<id>/<uploadId>/chunk-N.bin`)에만 쓴다.
//  - 청크는 create-once(If-None-Match)라 한 번 만들어진 청크는 이전 요청이나 지연된 재시도가 바꿀 수 없다.
//  - 확정(commit)은 기준 revision마다 한 번만 만들 수 있는 link 객체(create-once)로 원자적으로 결정한다. link를 얻은 저장만 manifest가 된다.
//  - 어느 저장의 link가 이미 있고 manifest가 아직 쓰이지 않았다면, 다른 요청이 그 확정된 저장의 manifest를 완성해 준다(중단 복구).
const UPLOAD_SLOT = /^u[0-9a-f]{32}$/
const linkPath = (key: string, id: string, baseRevision: string) => `${syncBase(key)}/episodes/${id}/links/${baseRevision || 'first'}.json`
// manifest와 그 ETag를 한 번의 읽기로 가져온다(이 ETag가 이후 조건부 쓰기의 기준이다).
async function readJsonWithEtag(path: string): Promise<{ json: any; etag: string | null }> {
  const result: any = await readPrivate(path)
  if (!result) return { json: null, etag: null }
  const etag = result.blob?.etag || result.etag || null
  return { json: JSON.parse(await new Response(result.stream).text()), etag }
}
// 조건부 manifest 확정(CAS): 읽은 manifest의 ETag가 그대로일 때만 쓴다(최초는 If-None-Match: *). 불일치는 { ok:false } — 무조건 쓰기로 폴백하지 않는다.
// 이 저장(link)의 결과가 실제 manifest에 확정되었는지 manifest 자체로 확인한다.
//  - 현재 manifest가 이 저장이다 → 그 manifest
//  - 현재 manifest가 이 저장 바로 다음 저장이고, 교체한 manifest(previous)가 이 저장이다 → 이 저장의 revision
//  - 그 밖에는 확인할 수 없다 → null (호출부는 200을 돌려주지 않는다)
function confirmedManifest(id: string, link: any, live: any) {
  if (!link || !live) return null
  if (live.revision === link.revision && live.uploadId === link.uploadId) return live
  if (live.previous?.uploadId === link.uploadId && live.previous?.chunkCount === link.chunkCount) return manifestFromLink(id, link, null)
  return null
}
function legacyObjectPath(key: string, id: string, token: string) { return `${syncBase(key)}/episodes/${id}/legacy/${token}.spbak` }
async function tombstone(path: string) {
  if (!path) return
  try { await put(path, Buffer.from('x'), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream' }) } catch { /* best effort */ }
}
function manifestFromLink(id: string, link: any, previous: any) {
  return {
    episodeId: id, format: 'SPB1-CLOUD', version: 1, activeSlot: link.uploadId, uploadId: link.uploadId, chunkCount: link.chunkCount, byteLength: link.byteLength,
    revision: link.revision, updatedAt: link.updatedAt, ...(previous?.uploadId ? { previous: { uploadId: previous.uploadId, chunkCount: previous.chunkCount } } : {})
  }
}
async function writeEpisodeManifest(key: string, id: string, link: any, previous: any, previousEtag: string | null) {
  if (previous && !previousEtag) throw new Error('저장소가 manifest ETag를 돌려주지 않아 안전하게 확정할 수 없습니다.')
  const manifest = manifestFromLink(id, link, previous)
  const written = await putIfMatch(episodeManifestPath(key, id), JSON.stringify(manifest), previous ? previousEtag : null, { contentType: 'application/json', cacheControlMaxAge: 60 })
  return written.ok ? manifest : null
}
// 두 세대 전 저장의 청크는 더 이상 참조되지 않는다: 용량을 돌려주기 위해 비운다(삭제 API 없이 기존 put만 사용, 실패해도 무시).
async function reclaimOldChunks(key: string, id: string, old: any) {
  if (!old?.uploadId || !UPLOAD_SLOT.test(old.uploadId)) return
  for (let i = 0; i < Math.min(Number(old.chunkCount) || 0, 10000); i++) {
    try { await put(scopedChunkPath(key, id, old.uploadId, i), Buffer.from('x'), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream' }) } catch { /* best effort */ }
  }
}
const EPISODE_CONFLICT = { error: { code: 'EPISODE_BASE_CONFLICT', message: '다른 기기에서 이 에피소드의 클라우드본이 먼저 변경되었거나 이 사본의 기준 버전을 알 수 없습니다. 덮어쓰지 않았습니다. 클라우드 최신본을 먼저 불러온 뒤 다시 저장해주세요.' } }

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
    const requestUrl = new URL(String((req as any).url || '/'), 'https://sync.local')
    const rawPath = (req.query as any)?.path
    const fallbackPath = requestUrl.pathname.replace(/^\/api\/sync\/?/, '')
    const parts = Array.isArray(rawPath)
      ? rawPath.map(String)
      : String(rawPath || fallbackPath || '').split('/').filter(Boolean)
    const key = getSyncKey(req)
    const op = String(requestUrl.searchParams.get('op') || (req.query as any)?.op || parts[0] || '')
    const scopeIdRaw = requestUrl.searchParams.get('episodeId') || (req.query as any)?.episodeId
    const scopeId = scopeIdRaw ? episodeId(scopeIdRaw) : null
    const querySlot = requestUrl.searchParams.get('slot') || (req.query as any)?.slot
    const queryIndex = requestUrl.searchParams.get('index') || (req.query as any)?.index

    // Episode-scoped backup: independent of the full workspace manifest.
    // A single episode upload can never replace the other 26 projects.
    if (parts[0] === 'episode' && parts.length === 2) {
      const id = episodeId(parts[1])
      const manifestFile = episodeManifestPath(key, id)
      if (req.method === 'GET') {
        const manifest = await readJson(manifestFile)
        if (!manifest) return res.status(404).json({ error: { message: '에피소드 백업이 없습니다.' } })
        // 분할(chunk) 저장본은 이 단일 파일 경로로 읽을 수 없다(다른 revision의 데이터를 돌려주지 않는다).
        if (manifest.uploadId) return res.status(409).json({ error: { message: '분할 저장된 에피소드입니다. 분할 다운로드 경로를 사용해주세요.' } })
        const stored = await readPrivate(manifest.object || episodePath(key, id))
        if (!stored) return res.status(404).json({ error: { message: '에피소드 파일이 없습니다.' } })
        const buffer = Buffer.from(await new Response(stored.stream).arrayBuffer())
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('X-Episode-Revision', manifest.revision)
        res.setHeader('Access-Control-Expose-Headers', 'X-Episode-Revision')
        return res.status(200).send(buffer)
      }
      if (req.method === 'POST') {
        // 읽은 manifest의 ETag를 기준으로 조건부 확정(CAS)한다. 기준 revision(X-Episode-Revision)이 현재와 다르거나 비어 있는데 이미 있으면 409.
        const previousRevision = String(req.headers['x-episode-revision'] || '')
        const { json: current, etag } = await readJsonWithEtag(manifestFile)
        if ((current?.revision || '') !== previousRevision) {
          return res.status(409).json({ error: { message: '에피소드가 다른 기기에서 수정되었습니다. 먼저 최신본을 확인해주세요.' } })
        }
        if (current && !etag) throw new Error('저장소가 manifest ETag를 돌려주지 않아 안전하게 확정할 수 없습니다.')
        const incoming = await readBody(req)
        const buffer = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming || [])
        if (buffer.length < 8 || buffer.subarray(0, 4).toString('utf8') !== 'SPB1') {
          return res.status(400).json({ error: { message: 'SPB1 백업 파일이 필요합니다.' } })
        }
        const headerLength = buffer.readUInt32LE(4)
        if (headerLength < 2 || headerLength > 10 * 1024 * 1024 || 8 + headerLength > buffer.length) {
          return res.status(400).json({ error: { message: 'SPB1 헤더가 올바르지 않습니다.' } })
        }
        const backupHeader = JSON.parse(buffer.subarray(8, 8 + headerLength).toString('utf8'))
        if (backupHeader.episodeCount !== 1 || backupHeader.episodes?.length !== 1 || backupHeader.episodes[0]?.id !== id) {
          return res.status(400).json({ error: { message: '요청한 에피소드 하나만 포함해야 합니다.' } })
        }
        // 데이터는 이 요청 전용 새 경로에 쓴다(오래된 요청이 확정된 최신 파일을 덮어쓸 수 없다). 확정은 manifest CAS 하나로 결정한다.
        const object = legacyObjectPath(key, id, randomUUID())
        await put(object, buffer, { access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/octet-stream' })
        const manifest = {
          revision: randomUUID(), updatedAt: new Date().toISOString(), episodeId: id, byteLength: buffer.length, object,
          ...(current?.object ? { previousObject: current.object } : {})
        }
        const written = await putIfMatch(manifestFile, JSON.stringify(manifest), current ? etag : null, { contentType: 'application/json' })
        if (!written.ok) {
          await tombstone(object) // 확정되지 못한 데이터는 비운다
          return res.status(409).json({ error: { message: '에피소드가 다른 기기에서 수정되었습니다. 먼저 최신본을 확인해주세요.' } })
        }
        await tombstone(current?.previousObject || '') // 두 세대 전 파일 정리(기존 put만 사용)
        await reclaimOldChunks(key, id, current?.previous)
        return res.status(200).json({ ok: true, manifest })
      }
    }

    // 이 동기화 키(작업공간)의 에피소드별 클라우드 백업 목록: 새 브라우저가 복원할 에피소드 ID를 찾는 용도. 읽기 전용.
    if (req.method === 'GET' && op === 'episodes' && parts.length === 1) {
      const prefix = `${syncBase(key)}/episodes/`
      const found: Array<{ episodeId: string; revision: string; updatedAt: string; byteLength: number }> = []
      let cursor: string | undefined
      for (let page = 0; page < 5; page++) {
        const listed: any = await list({ prefix, limit: 200, cursor })
        for (const blob of listed?.blobs || []) {
          const m = String(blob.pathname || '').slice(prefix.length).match(/^([^/]+)\.json$/)
          if (!m || !/^ep_[a-z0-9]{8,40}$/i.test(m[1])) continue
          const manifest = await readJson(String(blob.pathname)).catch(() => null)
          if (manifest?.revision) found.push({ episodeId: m[1], revision: String(manifest.revision), updatedAt: String(manifest.updatedAt || ''), byteLength: Number(manifest.byteLength || 0) })
        }
        if (!listed?.hasMore || !listed?.cursor) break
        cursor = listed.cursor
      }
      found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return res.status(200).json({ ok: true, episodes: found })
    }

    if (req.method === 'GET' && op === 'manifest') {
      try {
        const manifest = await readJson(scopedManifestPath(key, scopeId))
        return res.status(200).json({ ok: true, manifest: manifest || null })
      } catch (error: unknown) {
        if (storageBackend() !== 'r2' || !(error instanceof Error) || !/^Vercel Blob: .*\b403 Forbidden\b/i.test(error.message)) throw error
        return res.status(503).json({
          error: {
            code: 'LEGACY_SYNC_STORAGE_UNAVAILABLE',
            message: '이 동기화 코드의 R2 백업을 찾지 못했고 이전 클라우드에도 접근할 수 없습니다. 2화를 클라우드에 저장한 기기의 동기화 코드와 같은지 확인해 주세요.'
          }
        })
      }
    }

    if (req.method === 'POST' && op === 'start') {
      if (scopeId && await episodeBaseConflict(req, key, scopeId)) return res.status(409).json(EPISODE_CONFLICT)
      const current = await readJson(scopedManifestPath(key, scopeId))
      const slot = scopeId ? `u${randomUUID().replace(/-/g, '')}` : current?.activeSlot === 'a' ? 'b' : 'a'
      return res.status(200).json({ ok: true, slot, chunkBytes: 2 * 1024 * 1024, previousRevision: current?.revision || null })
    }

    if (op === 'chunk') {
      const slot = validSlot(parts.length >= 3 ? parts[1] : querySlot, !!scopeId, !!scopeId && req.method === 'POST')
      const index = validIndex(parts.length >= 3 ? parts[2] : queryIndex)
      if (req.method === 'POST') {
        const incoming = await readBody(req)
        let body: Buffer
        if (Buffer.isBuffer(incoming)) body = incoming
        else if (incoming instanceof Uint8Array) body = Buffer.from(incoming)
        else if (typeof incoming === 'string') body = Buffer.from(incoming)
        else if (incoming && typeof incoming === 'object' && incoming.type === 'Buffer' && Array.isArray(incoming.data)) body = Buffer.from(incoming.data)
        else body = Buffer.from([])
        if (!body.length) throw new Error('업로드 청크가 비어 있습니다.')
        if (scopeId) {
          // 저장 요청 전용 경로에 create-once로 쓴다: 이미 있는 청크는 어떤 요청·재시도도 바꿀 수 없다(같은 크기의 재시도만 멱등 성공).
          const path = scopedChunkPath(key, scopeId, slot, index)
          if (!(await putIfAbsent(path, body as unknown as string, 'application/octet-stream'))) {
            const existing: any = await head(path)
            if (Number(existing?.size) !== body.length) return res.status(409).json(EPISODE_CONFLICT)
          }
          return res.status(200).json({ ok: true, slot, index, size: body.length })
        }
        const blob: any = await put(scopedChunkPath(key, scopeId, slot, index), body, {
          access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream'
        })
        return res.status(200).json({ ok: true, slot, index, size: body.length, etag: blob.etag || null })
      }
      if (req.method === 'GET') {
        const result: any = await readPrivate(scopedChunkPath(key, scopeId, slot, index))
        if (!result) return res.status(404).json({ error: { message: '클라우드 청크를 찾을 수 없습니다.' } })
        const buffer = Buffer.from(await new Response(result.stream).arrayBuffer())
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', String(buffer.length))
        return res.status(200).send(buffer)
      }
    }

    if (req.method === 'POST' && op === 'commit') {
      const body = await readBody(req)
      const slot = validSlot(body?.slot, !!scopeId, !!scopeId)
      const chunkCount = Number(body?.chunkCount)
      const byteLength = Number(body?.byteLength)
      if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 10000) throw new Error('잘못된 청크 개수입니다.')
      if (!Number.isFinite(byteLength) || byteLength < 1) throw new Error('잘못된 백업 크기입니다.')
      if (scopeId && chunkCount * 2 * 1024 * 1024 < byteLength) throw new Error('청크 개수와 백업 크기가 일치하지 않습니다.')
      if (scopeId) {
        const rawBase = req.headers['x-episode-base']
        const current = await readJson(episodeManifestPath(key, scopeId))
        if (current?.uploadId === slot && current.chunkCount === chunkCount && current.byteLength === byteLength) return res.status(200).json({ ok: true, manifest: current }) // 이미 확정된 같은 저장의 재시도(멱등)
        const base = rawBase === undefined ? (current ? null : '') : String(rawBase)
        // 이미 확정된 같은 저장의 재시도: 이 기준에서 이 저장이 link를 가졌고 manifest로 확인될 때만 성공(바로 다음 저장이 전진했어도 같은 revision).
        if (base !== null) {
          const prior = await readJson(linkPath(key, scopeId, base))
          const done = prior?.uploadId === slot && prior.chunkCount === chunkCount && prior.byteLength === byteLength ? confirmedManifest(scopeId, prior, current) : null
          if (done) return res.status(200).json({ ok: true, manifest: done })
        }
        if (base === null || (current?.revision || '') !== base) return res.status(409).json(EPISODE_CONFLICT)
        // 모든 청크가 완성되어 있고 크기가 맞을 때만 확정 후보가 된다.
        let total = 0
        for (let i = 0; i < chunkCount; i++) {
          const info: any = await head(scopedChunkPath(key, scopeId, slot, i))
          if (!info) throw new Error(`청크 ${i + 1}이(가) 아직 올라오지 않았습니다.`)
          total += Number(info.size) || 0
        }
        if (total !== byteLength) throw new Error('올라온 청크 크기와 백업 크기가 일치하지 않습니다.')
        // 원자적 확정: 이 기준 revision에서 link를 만들 수 있는 저장은 단 하나. 이긴 저장만 manifest가 된다.
        const mine = { uploadId: slot, chunkCount, byteLength, revision: randomUUID(), updatedAt: new Date().toISOString() }
        const path = linkPath(key, scopeId, base)
        let link: any = mine
        if (!(await putIfAbsent(path, JSON.stringify(mine)))) link = await readJson(path)
        // link를 가진 저장의 manifest가 아직 없으면(중단됐거나 방금 확정됨) 누가 도착하든 그 저장의 manifest를 완성한다.
        // 읽은 manifest의 ETag로 조건부 쓰기(CAS)한다: 읽은 뒤 다른 저장이 manifest를 바꿨다면 실패하고 최신 manifest는 보존된다.
        let manifest: any = null
        for (let attempt = 0; attempt < 3; attempt++) {
          const { json: live, etag } = await readJsonWithEtag(episodeManifestPath(key, scopeId))
          manifest = live
          if ((live?.revision || '') !== base) break // 이 기준에서 이미 다른 revision으로 전진했다(이 link는 그때 반영되었다)
          const written = await writeEpisodeManifest(key, scopeId, link, live, etag)
          if (written) { manifest = written; await reclaimOldChunks(key, scopeId, live?.previous); break }
        }
        if (link.uploadId !== slot) return res.status(409).json(EPISODE_CONFLICT) // 다른 저장이 먼저 확정되었다
        // 실제 manifest에서 이 저장의 결과가 확정된 것을 확인한 경우에만 성공을 돌려준다. 확인할 수 없으면 409(로컬 데이터는 그대로, 같은 저장의 재시도로 이어서 확정된다).
        const confirmed = confirmedManifest(scopeId, link, manifest)
        if (!confirmed) return res.status(409).json(EPISODE_CONFLICT)
        return res.status(200).json({ ok: true, manifest: confirmed })
      }
      // 여기에는 전체 작업공간 스냅샷만 도달한다(에피소드 단위는 위에서 모두 처리되어 반환된다). 에피소드 manifest는 이 경로로 쓰지 않는다.
      if (scopeId) throw new Error('에피소드 확정 경로 오류')
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
