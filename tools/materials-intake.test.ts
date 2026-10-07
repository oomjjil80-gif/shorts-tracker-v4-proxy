// 소재 보관함 auto intake: a scheduled GPT task posts curated materials (no paste); R2 keeps them at
// materials/v1/production/; the browser reads them. In-memory store, no network, no AI call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createMaterials, createMaterialsHttp, MATERIALS_INDEX, normalizeUrl } from '../lib/materials/intake.js'

const TOKEN = 'intake-token-'.padEnd(40, 'x')
const call = (fn: any, { method = 'POST', headers = {}, body = {} }: any = {}) => new Promise<{ status: number; json: any }>((resolve) => {
  let status = 0
  fn({ method, headers, body, query: {} } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { resolve({ status, json: b }); return this }, end() { resolve({ status, json: null }); return this } } as any)
})
function setup() {
  const blobs: any = createMemoryBlobStore()
  const http = createMaterialsHttp({ materials: createMaterials({ blobs }), intakeToken: () => TOKEN })
  const post = (body: any, token = TOKEN) => call(http.intake, { headers: { authorization: `Bearer ${token}` }, body })
  const get = (key = 'k'.repeat(32)) => call(http.list, { method: 'GET', headers: { 'x-sync-key': key } })
  return { blobs, http, post, get }
}
const VIDEO = { materialKind: 'source_video', title: '구조된 강아지가 처음 웃는 순간', sourceUrl: 'https://www.instagram.com/reel/AAA111/?utm_source=ig', summary: '해외 원본', reviewStatus: 'approved', channelKey: 'odd_today' }
const TOPIC = { materialKind: 'topic', title: '금리 인하가 내 대출에 주는 영향', summary: '경제 이슈', sourceUrl: 'https://www.youtube.com/watch?v=ref', reviewStatus: 'approved', channelKey: 'economy_current', scores: { hook: 80 } }

test('source_video and topic are stored as Tracker idea records under materials/v1/production/', async () => {
  const { blobs, post, get } = setup()
  const r = await post({ materials: [VIDEO] })
  assert.equal(r.status, 200); assert.equal(r.json.saved.length, 1); assert.equal(r.json.saved[0].materialKind, 'source_video')
  const t = await post({ materials: [TOPIC] })
  assert.equal(t.json.saved[0].materialKind, 'topic')
  assert.ok(MATERIALS_INDEX.startsWith('materials/v1/production/')); assert.ok(blobs.files.has(MATERIALS_INDEX))
  const g = await get()
  assert.equal(g.status, 200); assert.equal(g.json.materials.length, 2)
  const [v, p] = g.json.materials
  assert.equal(v.recordType, 'idea'); assert.equal(v.materialKind, 'source_video'); assert.equal(v.sourceUrl, VIDEO.sourceUrl); assert.equal(v.origin, 'auto_intake'); assert.match(v.id, /^mat_[0-9a-f]{20}$/)
  assert.equal(p.materialKind, 'topic'); assert.equal(p.reviewStatus, 'approved'); assert.equal(p.channelKey, 'economy_current'); assert.deepEqual(p.scores, { hook: 80 })
  assert.equal(p.sourceUrl, TOPIC.sourceUrl, 'a topic may carry a video URL and stays a topic')
})

test('batch intake + duplicates never stored (same request twice -> nothing new)', async () => {
  const { post, get } = setup()
  const batch = { materials: [VIDEO, TOPIC, { ...TOPIC, title: '금리 인하가 내 대출에 주는 영향!!' }, { ...VIDEO, title: '다른 제목', sourceUrl: 'https://instagram.com/reel/AAA111' }, { materialKind: 'topic', title: '새 소재 두 번째' }] }
  const a = await post(batch)
  assert.equal(a.json.saved.length, 3); assert.equal(a.json.duplicates.length, 2, 'same URL (normalized) / same title (normalized) inside one batch')
  const b = await post(batch)
  assert.equal(b.json.saved.length, 0); assert.equal(b.json.duplicates.length, 5); assert.equal(b.json.total, 3)
  assert.equal((await get()).json.materials.length, 3)
  assert.equal(normalizeUrl('https://m.YouTube.com/watch?v=x&utm_campaign=y#t'), 'https://youtube.com/watch?v=x')
})

test('invalid items are reported, not stored; materialKind is required', async () => {
  const { post } = setup()
  const r = await post({ materials: [{ title: '종류 없음' }, { materialKind: 'source_video', title: 'URL 없음' }, { materialKind: 'topic' }, TOPIC] })
  assert.equal(r.json.saved.length, 1); assert.deepEqual(r.json.invalid.map((x: any) => x.index), [0, 1, 2])
  assert.equal((await post({ materials: [] })).status, 400)
  assert.equal((await post({ materials: Array.from({ length: 201 }, (_, i) => ({ materialKind: 'topic', title: `t${i}` })) })).status, 400)
})

test('auth: intake needs the server token (never the browser key); not configured -> closed; list needs X-Sync-Key', async () => {
  const { post, get, http } = setup()
  assert.equal((await post({ materials: [TOPIC] }, 'wrong'.padEnd(40, 'y'))).status, 401)
  assert.equal((await call(http.intake, { headers: { 'x-sync-key': 'k'.repeat(32) }, body: { materials: [TOPIC] } })).status, 401)
  const closed = createMaterialsHttp({ materials: createMaterials({ blobs: createMemoryBlobStore() }), intakeToken: () => '' })
  assert.equal((await call(closed.intake, { headers: { authorization: 'Bearer ' }, body: { materials: [TOPIC] } })).status, 503)
  assert.equal((await get('short')).status, 401)
  assert.equal((await call(http.intake, { method: 'GET' })).status, 405)
  const src = readFileSync(new URL('../server/railwayApi.ts', import.meta.url), 'utf8')
  assert.match(src, /app\.all\('\/api\/materials\/intake'/); assert.match(src, /app\.all\('\/api\/materials'/)
})

test('concurrent intakes do not lose each other (one writer at a time)', async () => {
  const { post, get } = setup()
  await Promise.all([post({ materials: [{ materialKind: 'topic', title: 'A' }] }), post({ materials: [{ materialKind: 'topic', title: 'B' }] }), post({ materials: [{ materialKind: 'topic', title: 'A' }] })])
  assert.deepEqual((await get()).json.materials.map((m: any) => m.title).sort(), ['A', 'B'])
})
