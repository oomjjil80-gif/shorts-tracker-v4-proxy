// D-3: 에피소드 클라우드 저장은 "로컬 사본이 실제로 기반한 revision"으로만 덮어쓴다. 실제 api/sync 핸들러 + R2 stand-in(fetch)로 검증.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import handler from '../api/sync/[...path].js'

const R2 = 'https://acct.r2.cloudflarestorage.com', BUCKET = 'tracker'
const ENV = { R2_ENDPOINT: R2, R2_BUCKET: BUCKET, R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secret', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore_secret' }
const KEY = 'sync-key-for-the-episode-revision-test-0123456789'
const EP = 'ep_revtest0001'

function installR2() {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v }
  const objects = new Map<string, Buffer>(); const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = String(init.method || 'GET')
    const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${BUCKET}/?`), ''))
    if (method === 'PUT') {
      if (init.headers?.['if-none-match'] === '*' && objects.has(key)) return new Response('', { status: 412 })
      objects.set(key, Buffer.from(typeof init.body === 'string' ? init.body : init.body ?? '')); return new Response('', { status: 200, headers: { etag: '"x"' } }) }
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || ''
      return new Response(`<ListBucketResult>${[...objects].filter(([k]) => k.startsWith(prefix)).map(([k, b]) => `<Contents><Key>${k}</Key><Size>${b.length}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`, { status: 200 })
    }
    const o = objects.get(key); if (!o) return new Response('', { status: 404 })
    return new Response(new Uint8Array(o), { status: 200, headers: { 'content-length': String(o.length) } })
  }) as any
  const agent = new MockAgent(); agent.disableNetConnect() // 옛 Vercel Blob: 항상 '없음'
  const notFound = () => ({ statusCode: 404, data: JSON.stringify({ error: { code: 'not_found', message: 'The requested blob does not exist' } }), responseOptions: { headers: { 'content-type': 'application/json' } } })
  agent.get('https://vercel.com').intercept({ path: () => true, method: () => true }).reply(notFound as any).persist()
  agent.get(/blob\.vercel-storage\.com$/).intercept({ path: () => true, method: () => true }).reply(notFound as any).persist()
  const prev = getGlobalDispatcher(); setGlobalDispatcher(agent)
  return { objects, restore() { setGlobalDispatcher(prev); globalThis.fetch = realFetch; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } } }
}

async function call(method: string, path: string, query: Record<string, string>, { base, body, client = 'client-default-1' }: { base?: string; body?: any; client?: string } = {}) {
  const qs = new URLSearchParams(query).toString()
  const headers: Record<string, string> = { 'x-sync-key': KEY, 'x-upload-client': client, ...(Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }) }
  if (base !== undefined) headers['x-episode-base'] = base
  const req: any = { method, url: `/api/sync/${path}?${qs}`, headers, query: { ...query }, body: Buffer.isBuffer(body) ? body : (body ?? {}) }
  let status = 200, payload: any = null, sent: any = null
  const res: any = { setHeader() {}, status(c: number) { status = c; return res }, json(p: any) { payload = p; return res }, send(b: any) { sent = b; return res }, end() { return res } }
  await handler(req, res)
  return { status, payload, sent }
}

// 한 번의 업로드(start → chunk → commit). base = 로컬 사본이 기반한 revision('' = 클라우드에 아직 없음, undefined = 모름)
async function upload(content: string, base?: string) {
  const q = { episodeId: EP }
  const s = await call('POST', 'start', { ...q, op: 'start' }, { base })
  if (s.status !== 200) return { stage: 'start', status: s.status, msg: s.payload?.error?.message }
  const slot = s.payload.slot
  const c = await call('POST', 'start', { ...q, op: 'chunk', slot, index: '0' }, { base, body: Buffer.from(content) })
  if (c.status !== 200) return { stage: 'chunk', status: c.status, msg: c.payload?.error?.message }
  const m = await call('POST', 'commit', { ...q, op: 'commit' }, { base, body: { slot, chunkCount: 1, byteLength: content.length, previousRevision: s.payload.previousRevision } })
  return { stage: 'commit', status: m.status, revision: m.payload?.manifest?.revision as string | undefined, slot }
}
async function cloud() {
  const man = await call('GET', 'manifest', { episodeId: EP, op: 'manifest' })
  const manifest = man.payload?.manifest; if (!manifest) return null
  const chunk = await call('GET', 'start', { episodeId: EP, op: 'chunk', slot: manifest.activeSlot, index: '0' })
  return { revision: manifest.revision, content: chunk.sent ? Buffer.from(chunk.sent).toString() : null }
}

test('1. 최신 사본은 정상 저장된다(첫 저장 → 기준 revision으로 다음 저장)', async () => {
  const r2 = installR2()
  try {
    const a = await upload('v1: MP4+썸네일', '')
    assert.equal(a.status, 200, JSON.stringify(a))
    const b = await upload('v2: 업로드 정보 수정', a.revision)
    assert.equal(b.status, 200)
    assert.deepEqual(await cloud(), { revision: b.revision, content: 'v2: 업로드 정보 수정' })
  } finally { r2.restore() }
})

test('2. 오래된 사본의 저장은 막히고 최신 클라우드 MP4·썸네일이 그대로 남는다', async () => {
  const r2 = installR2()
  try {
    const first = await upload('v1', '')
    const newer = await upload('v2: 다른 기기의 최신 MP4+썸네일', first.revision) // 다른 기기
    const stale = await upload('STALE: 오래된 사본의 업로드 정보', first.revision) // 이 브라우저는 v1 기반
    assert.equal(stale.status, 409); assert.equal(stale.stage, 'start')
    assert.deepEqual(await cloud(), { revision: newer.revision, content: 'v2: 다른 기기의 최신 MP4+썸네일' })
  } finally { r2.restore() }
})

test('3. 기준 revision을 모르면(첫 저장 제외) 덮어쓰지 않는다', async () => {
  const r2 = installR2()
  try {
    const fresh = await upload('first', undefined) // 클라우드에 아무것도 없으면 허용
    assert.equal(fresh.status, 200)
    const unknown = await upload('UNKNOWN-BASE', undefined)
    assert.equal(unknown.status, 409)
    assert.equal((await cloud())?.content, 'first')
  } finally { r2.restore() }
})

test('4. 동시 저장: 같은 기준에서 시작한 늦은 저장은 청크를 쓰기 전에 거절되어 먼저 진행한 저장이 손상되지 않는다', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const q = { episodeId: EP }
    const A = { base: base.revision, client: 'client-aaaaaaaa' }, B = { base: base.revision, client: 'client-bbbbbbbb' }
    const a = await call('POST', 'start', { ...q, op: 'start' }, A)
    assert.equal(a.status, 200)
    const b = await call('POST', 'start', { ...q, op: 'start' }, B) // 같은 기준·같은 슬롯이 될 늦은 저장
    assert.equal(b.status, 409)
    const bChunk = await call('POST', 'start', { ...q, op: 'chunk', slot: a.payload.slot, index: '0' }, { ...B, body: Buffer.from('B-late') })
    assert.equal(bChunk.status, 409)
    await call('POST', 'start', { ...q, op: 'chunk', slot: a.payload.slot, index: '0' }, { ...A, body: Buffer.from('A-wins') })
    const bCommit = await call('POST', 'commit', { ...q, op: 'commit' }, { ...B, body: { slot: a.payload.slot, chunkCount: 1, byteLength: 6, previousRevision: a.payload.previousRevision } })
    assert.equal(bCommit.status, 409)
    const aCommit = await call('POST', 'commit', { ...q, op: 'commit' }, { ...A, body: { slot: a.payload.slot, chunkCount: 1, byteLength: 6, previousRevision: a.payload.previousRevision } })
    assert.equal(aCommit.status, 200)
    assert.deepEqual(await cloud(), { revision: aCommit.payload.manifest.revision, content: 'A-wins' })
    // 같은 클라이언트의 재시도는 허용된다
    const base2 = aCommit.payload.manifest.revision
    const r1 = await call('POST', 'start', { ...q, op: 'start' }, { base: base2, client: 'client-aaaaaaaa' })
    const r2b = await call('POST', 'start', { ...q, op: 'start' }, { base: base2, client: 'client-aaaaaaaa' })
    assert.equal(r1.status, 200); assert.equal(r2b.status, 200)
  } finally { r2.restore() }
})

test('4b. 멈춘(30분 초과) 선점은 버려진 것으로 보고 다른 저장이 이어받는다', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const q = { episodeId: EP }
    const a = await call('POST', 'start', { ...q, op: 'start' }, { base: base.revision, client: 'client-aaaaaaaa' })
    assert.equal(a.status, 200)
    const claim = [...r2.objects.keys()].find((k) => k.includes('/claims/') && k.endsWith(`${base.revision}.json`))!
    r2.objects.set(claim, Buffer.from(JSON.stringify({ client: 'client-aaaaaaaa', at: Date.now() - 31 * 60 * 1000 })))
    const b = await call('POST', 'start', { ...q, op: 'start' }, { base: base.revision, client: 'client-bbbbbbbb' })
    assert.equal(b.status, 200)
  } finally { r2.restore() }
})

test('5. 브라우저가 보내는 기준 revision 헤더가 CORS로 허용된다', async () => {
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync(new URL('../api/sync/[...path].ts', import.meta.url), 'utf8'), /Access-Control-Allow-Headers', '[^']*X-Episode-Base/)
})
