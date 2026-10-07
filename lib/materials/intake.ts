// 소재 보관함 auto intake: a scheduled GPT task posts the day's curated materials; the Tracker 소재 보관함 reads them.
// Same R2 bucket as every job (JobBlobStore), one prefix, one index file; no database, no queue.
//   POST /api/materials/intake  Authorization: Bearer <MATERIALS_INTAKE_TOKEN>  { materials: [ SPT-IDEA-1 idea + materialKind ] }
//   GET  /api/materials         X-Sync-Key (the browser's existing key)        -> { materials: [...] }
// materialKind is required: "source_video" (영상소재, needs its original video URL) | "topic" (일반소재).
// Duplicates are never stored: source_video by its normalized URL, topic by its normalized title (or topicKey). Re-sending
// the same request stores nothing new.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import type { JobBlobStore } from '../jobs/blobs.js'

export const MATERIALS_PREFIX = 'materials/v1/production/'
export const MATERIALS_INDEX = `${MATERIALS_PREFIX}index.json`
export const MATERIAL_KINDS = ['source_video', 'topic'] as const
const MAX_PER_REQUEST = 200
const MAX_TOTAL = 5000

const str = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max)
const list = (v: unknown, max = 40) => (Array.isArray(v) ? v.map((x) => str(x, 500)).filter(Boolean).slice(0, max) : [])
const ts = (v: unknown) => { const n = typeof v === 'number' ? v : Date.parse(String(v ?? '')); return Number.isFinite(n) && n > 0 ? n : null }

export function normalizeUrl(raw: unknown): string {
  const s = str(raw)
  try {
    const u = new URL(s)
    if (!/^https?:$/.test(u.protocol)) return ''
    u.hash = ''
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|igshid$|si$|feature$|ref$)/i.test(k)) u.searchParams.delete(k)
    return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, '')}${u.searchParams.toString() ? `?${u.searchParams}` : ''}`
  } catch { return '' }
}
export const normalizeTopic = (raw: unknown) => str(raw).toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '')

export function dedupeKey(m: { materialKind: string; sourceUrl?: string; title?: string; topicKey?: string }): string {
  return m.materialKind === 'source_video' ? `source_video|${normalizeUrl(m.sourceUrl)}` : `topic|${normalizeTopic(m.topicKey || m.title)}`
}

// one posted item -> the Tracker idea record (the same fields the browser's SPT-IDEA-1 import keeps)
export function normalizeMaterial(raw: any, now = Date.now()): { ok: true; material: any } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' }
  const materialKind = str(raw.materialKind)
  if (!(MATERIAL_KINDS as readonly string[]).includes(materialKind)) return { ok: false, reason: 'materialKind must be source_video or topic' }
  const title = str(raw.title, 300)
  if (!title) return { ok: false, reason: 'title is required' }
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 20).map((s: any) => ({ name: str(s?.name, 200), url: str(s?.url), publishedAt: str(s?.publishedAt, 60) })).filter((s: any) => s.name || s.url)
  const sourceUrl = str(raw.sourceUrl || sources[0]?.url)
  if (materialKind === 'source_video' && !normalizeUrl(sourceUrl)) return { ok: false, reason: 'source_video needs its original video URL (sourceUrl)' }
  const key = dedupeKey({ materialKind, sourceUrl, title, topicKey: str(raw.topicKey) })
  if (key.endsWith('|')) return { ok: false, reason: 'nothing to identify the material' }
  const scores = raw.scores && typeof raw.scores === 'object' ? Object.fromEntries(Object.entries(raw.scores).filter(([, v]) => Number.isFinite(Number(v))).slice(0, 20).map(([k, v]) => [k, Math.max(0, Math.min(100, Number(v)))])) : null
  return {
    ok: true,
    material: {
      id: `mat_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
      recordType: 'idea', schemaVersion: str(raw.schemaVersion || 'SPT-IDEA-1', 40), materialKind, dedupeKey: key, origin: 'auto_intake',
      title, summary: str(raw.summary, 4000), topicKey: str(raw.topicKey, 300),
      sourceUrl, sourceName: str(raw.sourceName || sources[0]?.name, 200), sources,
      publishedAt: ts(raw.publishedAt || sources[0]?.publishedAt),
      category: str(raw.category, 80), keywords: Array.isArray(raw.keywords) ? list(raw.keywords).join(', ') : str(raw.keywords, 500),
      channelKey: str(raw.channelKey, 60) || 'unassigned', contentFormat: raw.contentFormat === 'longform' ? 'longform' : 'shorts', productionProfile: str(raw.productionProfile, 30) || 'standard',
      whyNow: str(raw.whyNow), viewerValue: str(raw.viewerValue), coreQuestion: str(raw.coreQuestion), riskNote: str(raw.riskNote),
      hookCandidates: list(raw.hookCandidates), verifiedFacts: list(raw.verifiedFacts), claimsToVerify: list(raw.claimsToVerify),
      scores, reviewStatus: ['approved', 'needs_review', 'hold', 'rejected'].includes(raw.reviewStatus) ? raw.reviewStatus : 'needs_review', reviewNote: str(raw.reviewNote),
      collector: str(raw.collector, 80), reviewer: str(raw.reviewer, 80),
      status: 'inbox', collectedAt: ts(raw.collectedAt) || now, createdAt: now, updatedAt: now,
    },
  }
}

export class MaterialsError extends Error { constructor(public status: number, public code: string, message: string) { super(message) } }

export function createMaterials(deps: { blobs: JobBlobStore; now?: () => number }) {
  const now = deps.now ?? Date.now
  let chain: Promise<unknown> = Promise.resolve() // one writer at a time (the index is read-modify-write)
  const readAll = async (): Promise<any[]> => { const j: any = await deps.blobs.getJson(MATERIALS_INDEX); return Array.isArray(j?.materials) ? j.materials : [] }
  async function intake(body: any) {
    const items = Array.isArray(body?.materials) ? body.materials : Array.isArray(body?.ideas) ? body.ideas : null
    if (!items || !items.length) throw new MaterialsError(400, 'BAD_REQUEST', 'materials must be a non-empty array')
    if (items.length > MAX_PER_REQUEST) throw new MaterialsError(400, 'BAD_REQUEST', `at most ${MAX_PER_REQUEST} materials per request`)
    const run = chain.then(async () => {
      const existing = await readAll()
      const keys = new Set(existing.map((m) => m.dedupeKey))
      const saved: any[] = [], duplicates: any[] = [], invalid: any[] = []
      items.forEach((raw: any, index: number) => {
        const r = normalizeMaterial(raw, now())
        if (!r.ok) { invalid.push({ index, title: str(raw?.title, 120), reason: r.reason }); return }
        if (keys.has(r.material.dedupeKey)) { duplicates.push({ index, title: r.material.title, materialKind: r.material.materialKind }); return }
        keys.add(r.material.dedupeKey); saved.push(r.material)
      })
      if (saved.length) {
        if (existing.length + saved.length > MAX_TOTAL) throw new MaterialsError(409, 'MATERIALS_FULL', `the material box holds at most ${MAX_TOTAL} items`)
        await deps.blobs.putJson(MATERIALS_INDEX, { schema: 'tracker-materials/1', updatedAt: now(), materials: [...existing, ...saved] }, { overwrite: true })
      }
      return { saved: saved.map((m) => ({ id: m.id, title: m.title, materialKind: m.materialKind })), duplicates, invalid, total: existing.length + saved.length }
    })
    chain = run.catch(() => {})
    return run
  }
  async function listAll() { return { materials: await readAll() } }
  return { intake, list: listAll }
}

const sameSecret = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }

// Express handlers. Intake: server-to-server only (a secret the scheduled task holds; never sent to the browser).
// List: the browser's existing X-Sync-Key, like every other Tracker API call.
export function createMaterialsHttp(deps: { materials: ReturnType<typeof createMaterials>; intakeToken?: () => string; cors?: (req: Request, res: Response) => void }) {
  const token = () => deps.intakeToken?.() ?? String(process.env.MATERIALS_INTAKE_TOKEN || '').trim()
  const fail = (res: Response, e: any) => {
    if (e instanceof MaterialsError) return res.status(e.status).json({ ok: false, error: { code: e.code, message: e.message } })
    console.error('[materials]', e?.message || e)
    return res.status(500).json({ ok: false, error: { code: 'MATERIALS_FAILED', message: 'materials storage failed' } })
  }
  return {
    async intake(req: Request, res: Response) {
      res.setHeader('Cache-Control', 'private, no-store')
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } })
      const expected = token()
      if (expected.length < 24) return res.status(503).json({ ok: false, error: { code: 'INTAKE_NOT_CONFIGURED', message: 'materials intake is not configured' } })
      const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      if (!got || !sameSecret(got, expected)) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'invalid intake token' } })
      try { const r = await deps.materials.intake(req.body); console.log(`[materials] intake saved=${r.saved.length} duplicates=${r.duplicates.length} invalid=${r.invalid.length}`); return res.status(200).json({ ok: true, ...r }) }
      catch (e) { return fail(res, e) }
    },
    async list(req: Request, res: Response) {
      deps.cors?.(req, res)
      res.setHeader('Cache-Control', 'private, no-store')
      if (req.method === 'OPTIONS') return res.status(204).end()
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } })
      if (String(req.headers['x-sync-key'] || '').trim().length < 24) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '유효한 X-Sync-Key가 필요합니다.' } })
      try { return res.status(200).json({ ok: true, ...(await deps.materials.list()) }) }
      catch (e) { return fail(res, e) }
    },
  }
}
