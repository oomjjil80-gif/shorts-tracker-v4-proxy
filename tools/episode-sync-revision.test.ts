// D-3: 에피소드 클라우드 저장은 "로컬 사본이 실제로 기반한 revision"으로만 덮어쓴다. 실제 api/sync 핸들러 + R2 stand-in(fetch)로 검증.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import handler from '../api/sync/[...path].js'

const R2 = 'https://acct.r2.cloudflarestorage.com', BUCKET = 'tracker'
const ENV = { R2_ENDPOINT: R2, R2_BUCKET: BUCKET, R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secret', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore_secret' }
const KEY = 'sync-key-for-the-episode-revision-test-0123456789'
const EP = 'ep_revtest0001'

type Gate = { match: (k: string) => boolean; used: boolean; release: Promise<void>; reached: () => void }
const gates: Gate[] = [], failures: { match: (k: string) => boolean; used: boolean }[] = []
function delayNextPut(match: (k: string) => boolean) {
  let open!: () => void, reached!: () => void
  const release = new Promise<void>((r) => { open = r }), seen = new Promise<void>((r) => { reached = r })
  gates.push({ match, used: false, release, reached })
  return { open, seen }
}
const rejects: { match: (k: string) => boolean; remaining: number }[] = []
function reject412(match: (k: string) => boolean, times: number) { rejects.push({ match, remaining: times }) } // 저장소가 조건 불일치(412)를 돌려주는 상황
function failNextPut(match: (k: string) => boolean) { failures.push({ match, used: false }) }
function installR2() {
  gates.length = 0; failures.length = 0; rejects.length = 0
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v }
  const objects = new Map<string, Buffer>(), etags = new Map<string, string>(), wire: { method: string; key: string; headers: Record<string, string> }[] = []; let etagSeq = 0; const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = String(init.method || 'GET')
    const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${BUCKET}/?`), ''))
    if (method === 'PUT') {
      const gate = gates.find((g) => g.match(key) && !g.used); if (gate) { gate.used = true; gate.reached(); await gate.release } // 요청은 권한 확인을 통과했지만 쓰기 완료가 지연되는 상황
      const fail = failures.find((f) => f.match(key) && !f.used); if (fail) { fail.used = true; return new Response('boom', { status: 500 }) }
      const rj = rejects.find((r) => r.match(key) && r.remaining > 0); if (rj) { rj.remaining--; return new Response('', { status: 412 }) }
      // 실제 R2와 같은 조건부 쓰기: If-None-Match: * (이미 있으면 412) · If-Match: <etag> (현재 ETag와 다르거나 없으면 412). 조건은 요청이 서버에 도착한 시점에 평가한다.
      wire.push({ method, key, headers: { ...(init.headers || {}) } })
      if (init.headers?.['if-none-match'] === '*' && objects.has(key)) return new Response('', { status: 412 })
      if (init.headers?.['if-match'] !== undefined && (!objects.has(key) || etags.get(key) !== init.headers['if-match'])) return new Response('', { status: 412 })
      objects.set(key, Buffer.from(typeof init.body === 'string' ? init.body : init.body ?? '')); etags.set(key, `"e${++etagSeq}"`)
      return new Response('', { status: 200, headers: { etag: etags.get(key)! } }) }
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || ''
      return new Response(`<ListBucketResult>${[...objects].filter(([k]) => k.startsWith(prefix)).map(([k, b]) => `<Contents><Key>${k}</Key><Size>${b.length}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`, { status: 200 })
    }
    const o = objects.get(key); if (!o) return new Response('', { status: 404 })
    return new Response(new Uint8Array(o), { status: 200, headers: { 'content-length': String(o.length), etag: etags.get(key)! } })
  }) as any
  const agent = new MockAgent(); agent.disableNetConnect() // 옛 Vercel Blob: 항상 '없음'
  const notFound = () => ({ statusCode: 404, data: JSON.stringify({ error: { code: 'not_found', message: 'The requested blob does not exist' } }), responseOptions: { headers: { 'content-type': 'application/json' } } })
  agent.get('https://vercel.com').intercept({ path: () => true, method: () => true }).reply(notFound as any).persist()
  agent.get(/blob\.vercel-storage\.com$/).intercept({ path: () => true, method: () => true }).reply(notFound as any).persist()
  const prev = getGlobalDispatcher(); setGlobalDispatcher(agent)
  return { objects, wire, restore() { setGlobalDispatcher(prev); globalThis.fetch = realFetch; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } } }
}

async function call(method: string, path: string, query: Record<string, string>, { base, body, client = 'client-default-1', revision }: { base?: string; body?: any; client?: string; revision?: string } = {}) {
  const qs = new URLSearchParams(query).toString()
  const headers: Record<string, string> = { 'x-sync-key': KEY, 'x-upload-client': client, ...(Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }) }
  if (base !== undefined) headers['x-episode-base'] = base
  if (revision !== undefined) headers['x-episode-revision'] = revision
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
  const m = await call('POST', 'commit', { ...q, op: 'commit' }, { base, body: { slot, chunkCount: 1, byteLength: Buffer.byteLength(content), previousRevision: s.payload.previousRevision } })
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

const slotKey = (slot: string) => (k: string) => k.includes(`/${slot}/chunk-0.bin`)
const commitOf = (c: any, slot: string, n: number, len: number, a: any) => call('POST', 'commit', { episodeId: EP, op: 'commit' }, { ...c, body: { slot, chunkCount: n, byteLength: len, previousRevision: a.previousRevision } })
const putChunk = (c: any, slot: string, text: string) => call('POST', 'start', { episodeId: EP, op: 'chunk', slot, index: '0' }, { ...c, body: Buffer.from(text) })

test('4. 동시 저장: 같은 기준에서 둘 다 올려도 먼저 확정된 저장만 남고 늦은 쪽 커밋은 거절된다', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const A = { base: base.revision, client: 'client-aaaaaaaa' }, B = { base: base.revision, client: 'client-bbbbbbbb' }
    const a = await call('POST', 'start', { episodeId: EP, op: 'start' }, A), b = await call('POST', 'start', { episodeId: EP, op: 'start' }, B)
    assert.equal(a.status, 200); assert.equal(b.status, 200)
    assert.notEqual(a.payload.slot, b.payload.slot, '저장 요청마다 청크 경로가 분리된다')
    assert.equal((await putChunk(A, a.payload.slot, 'A-data')).status, 200)
    assert.equal((await putChunk(B, b.payload.slot, 'B-data')).status, 200)
    const bCommit = await commitOf(B, b.payload.slot, 1, 6, b.payload)
    assert.equal(bCommit.status, 200)
    assert.equal((await commitOf(A, a.payload.slot, 1, 6, a.payload)).status, 409)
    assert.deepEqual(await cloud(), { revision: bCommit.payload.manifest.revision, content: 'B-data' })
  } finally { r2.restore() }
})

test('4b. A 저장 지연 → 선점/시간 경과 → B 저장 완료 → A의 지연된 쓰기 완료: B의 청크·manifest는 바뀌지 않는다', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const A = { base: base.revision, client: 'client-aaaaaaaa' }, B = { base: base.revision, client: 'client-bbbbbbbb' }
    const a = await call('POST', 'start', { episodeId: EP, op: 'start' }, A)
    const gate = delayNextPut(slotKey(a.payload.slot))
    const aWrite = putChunk(A, a.payload.slot, 'A-STALE-DELAYED') // 권한 확인은 통과, 쓰기 완료만 지연
    await gate.seen
    for (const k of r2.objects.keys()) if (k.includes('/claims/')) r2.objects.set(k, Buffer.from(JSON.stringify({ client: 'client-aaaaaaaa', at: Date.now() - 31 * 60 * 1000 }))) // (이전 방식의) 선점 만료
    const b = await call('POST', 'start', { episodeId: EP, op: 'start' }, B)
    assert.equal(b.status, 200)
    assert.equal((await putChunk(B, b.payload.slot, 'B-FINAL')).status, 200)
    const bCommit = await commitOf(B, b.payload.slot, 1, 7, b.payload)
    assert.equal(bCommit.status, 200)
    const before = await cloud()
    gate.open(); await aWrite // A의 지연된 쓰기가 이제 완료된다
    assert.deepEqual(await cloud(), before)
    assert.deepEqual(before, { revision: bCommit.payload.manifest.revision, content: 'B-FINAL' })
    assert.equal((await commitOf(A, a.payload.slot, 1, 15, a.payload)).status, 409)
    assert.deepEqual(await cloud(), before)
  } finally { r2.restore() }
})

test('4c. 확정된 청크는 변경되지 않는다(같은 경로 재쓰기는 같은 크기만 멱등, 다르면 거절)', async () => {
  const r2 = installR2()
  try {
    const first = await upload('v1', '')
    const q = { episodeId: EP }
    const s1 = await call('POST', 'start', { ...q, op: 'start' }, { base: first.revision })
    assert.equal((await putChunk({ base: first.revision }, s1.payload.slot, 'v2-data')).status, 200)
    assert.equal((await putChunk({ base: first.revision }, s1.payload.slot, 'v2-data')).status, 200) // 같은 재시도
    assert.equal((await putChunk({ base: first.revision }, s1.payload.slot, 'DIFFERENT-LENGTH')).status, 409)
    const c = await commitOf({ base: first.revision }, s1.payload.slot, 1, 7, s1.payload)
    assert.equal(c.status, 200)
    assert.equal((await putChunk({ base: c.payload.manifest.revision }, s1.payload.slot, 'v2-XXXX')).status, 200) // 같은 크기 재쓰기는 기존 값을 그대로 둔다
    assert.equal((await cloud())?.content, 'v2-data')
  } finally { r2.restore() }
})

test('4d. 확정(link) 직후 manifest 쓰기가 실패해도 같은 저장의 재시도는 이어서 완료되고, 다른 저장이 먼저 도착하면 그 결과를 완성해 준다', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const A = { base: base.revision, client: 'client-aaaaaaaa' }, B = { base: base.revision, client: 'client-bbbbbbbb' }
    const a = await call('POST', 'start', { episodeId: EP, op: 'start' }, A), b = await call('POST', 'start', { episodeId: EP, op: 'start' }, B)
    await putChunk(A, a.payload.slot, 'A-data'); await putChunk(B, b.payload.slot, 'B-data')
    failNextPut((k) => k.endsWith(`/episodes/${EP}.json`))
    assert.equal((await commitOf(A, a.payload.slot, 1, 6, a.payload)).status, 400) // A: 연결은 확정됐지만 manifest 쓰기 실패
    assert.equal((await commitOf(B, b.payload.slot, 1, 6, b.payload)).status, 409)  // B: 거절되고, 확정된 A의 manifest를 완성해 둔다
    assert.equal((await cloud())?.content, 'A-data')
    const again = await commitOf(A, a.payload.slot, 1, 6, a.payload) // A의 지연 재시도: 이미 완료된 같은 저장 → 멱등
    assert.equal(again.status, 200) // 이미 확정된 같은 저장의 재시도는 멱등 성공
    assert.equal((await cloud())?.content, 'A-data')
  } finally { r2.restore() }
})

const manifestKey = (k: string) => k.endsWith(`/episodes/${EP}.json`)

test('4e. A 확정 요청 지연 → B 및 후속 revision 확정 → A 지연 요청 완료: 최신 manifest와 MP4·썸네일 청크가 그대로다', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const A = { base: base.revision, client: 'client-aaaaaaaa' }, B = { base: base.revision, client: 'client-bbbbbbbb' }
    const a = await call('POST', 'start', { episodeId: EP, op: 'start' }, A), b = await call('POST', 'start', { episodeId: EP, op: 'start' }, B)
    await putChunk(A, a.payload.slot, 'A-data'); await putChunk(B, b.payload.slot, 'B-data')
    const gate = delayNextPut(manifestKey) // A의 최종 manifest 쓰기 요청이 네트워크에서 지연된다
    const aCommit = commitOf(A, a.payload.slot, 1, 6, a.payload)
    await gate.seen
    const bCommit = await commitOf(B, b.payload.slot, 1, 6, b.payload) // B: link는 A가 가졌다 → A의 확정을 완성해 두고 거절된다
    assert.equal(bCommit.status, 409)
    const mid = await cloud(); assert.equal(mid?.content, 'A-data')
    const c = await upload('C-data(후속 revision: 최신 MP4·썸네일)', mid!.revision) // 후속 저장
    assert.equal(c.status, 200)
    const latest = await cloud(); assert.deepEqual(latest, { revision: c.revision, content: 'C-data(후속 revision: 최신 MP4·썸네일)' })
    gate.open() // A의 지연된 manifest 쓰기가 이제 서버에 도착한다
    const aDone = await aCommit
    assert.deepEqual(await cloud(), latest, '최신 manifest와 청크는 그대로')
    assert.equal(aDone.status, 200); assert.equal(aDone.payload.manifest.revision, mid!.revision) // A의 저장은 이미 반영된 revision으로 응답한다
  } finally { r2.restore() }
})

test('4f. 조건부 쓰기는 실제 R2 요청에 실린다(서명된 If-Match / If-None-Match), 실패 후 무조건 쓰기로 폴백하지 않는다', async () => {
  const r2 = installR2()
  try {
    const first = await upload('v1', '')
    const second = await upload('v2', first.revision)
    const manifestPuts = r2.wire.filter((w) => w.method === 'PUT' && manifestKey(w.key))
    assert.equal(manifestPuts.length, 2)
    assert.equal(manifestPuts[0].headers['if-none-match'], '*')                       // 최초 manifest
    assert.match(String(manifestPuts[1].headers['if-match']), /^"e\d+"$/)               // 기존 manifest: 읽은 ETag
    for (const w of manifestPuts) assert.match(w.headers.Authorization, /SignedHeaders=[^,]*if-(none-)?match/) // 서명에 포함
    // 조건 불일치(412) 후 manifest에 무조건 PUT이 나가지 않는다
    r2.wire.length = 0
    const stale = await upload('STALE', first.revision)
    assert.equal(stale.status, 409)
    assert.equal(r2.wire.filter((w) => manifestKey(w.key)).length, 0)
    assert.equal(r2.wire.filter((w) => manifestKey(w.key) && w.headers['if-match'] === undefined && w.headers['if-none-match'] === undefined).length, 0)
    assert.equal((await cloud())?.revision, second.revision)
  } finally { r2.restore() }
})

// ---- 기존 단일 에피소드 POST(episode/<id>)와 신규 chunk/commit 경로의 교차 보호 ----
const spb1 = (payload: string) => { const head = Buffer.from(JSON.stringify({ episodeCount: 1, episodes: [{ id: EP }] })); const len = Buffer.alloc(4); len.writeUInt32LE(head.length); return Buffer.concat([Buffer.from('SPB1'), len, head, Buffer.from(payload)]) }
const legacyPost = (payload: string, revision: string) => call('POST', `episode/${EP}`, {}, { body: spb1(payload), revision })
const legacyGet = async () => { const r = await call('GET', `episode/${EP}`, {}); return { status: r.status, text: r.sent ? Buffer.from(r.sent).toString().replace(/^SPB1[\s\S]*?\}\]\}/, '') : null, message: r.payload?.error?.message as string | undefined } }

test('6. 기존 단일 POST: 최신 사본 정상 저장, 오래된 사본·기준 미확인 요청의 덮어쓰기는 409로 막힌다', async () => {
  const r2 = installR2()
  try {
    const a = await legacyPost('legacy-v1', ''); assert.equal(a.status, 200)
    const b = await legacyPost('legacy-v2', a.payload.manifest.revision); assert.equal(b.status, 200)
    assert.equal((await legacyGet()).text, 'legacy-v2')
    assert.equal((await legacyPost('STALE-v1', a.payload.manifest.revision)).status, 409) // 오래된 로컬 사본
    assert.equal((await legacyPost('NO-BASE', '')).status, 409)                           // 기준 revision 미확인(첫 저장 취급)
    assert.equal((await legacyGet()).text, 'legacy-v2', '오래된 요청이 최신 제작물을 덮어쓰지 못한다')
    r2.wire.length = 0
    await legacyPost('STALE-again', a.payload.manifest.revision)
    assert.equal(r2.wire.filter((w) => manifestKey(w.key) && w.headers['if-match'] === undefined && w.headers['if-none-match'] === undefined).length, 0, 'manifest 무조건 쓰기 없음')
  } finally { r2.restore() }
})

test('6b. 기존 POST가 manifest 쓰기 직전에 지연 → 신규 commit이 먼저 확정 → 지연된 POST 도착: 최신 manifest·청크 보존, POST는 409', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const gate = delayNextPut(manifestKey)
    const stalePost = legacyPost('LEGACY-DELAYED', base.revision!)
    await gate.seen
    const s1 = await call('POST', 'start', { episodeId: EP, op: 'start' }, { base: base.revision })
    await putChunk({ base: base.revision }, s1.payload.slot, 'CHUNKED-NEW')
    const c = await commitOf({ base: base.revision }, s1.payload.slot, 1, 11, s1.payload)
    // (같은 manifest 쓰기 게이트는 이미 POST가 잡고 있으므로 commit의 manifest 쓰기는 통과)
    assert.equal(c.status, 200)
    const latest = await cloud(); assert.deepEqual(latest, { revision: c.payload.manifest.revision, content: 'CHUNKED-NEW' })
    gate.open()
    assert.equal((await stalePost).status, 409)
    assert.deepEqual(await cloud(), latest, '신규 commit 결과(manifest·청크)가 그대로다')
  } finally { r2.restore() }
})

test('6c. 신규 commit이 manifest 쓰기 직전에 지연 → 기존 POST가 먼저 확정 → 지연된 commit 도착: 거짓 성공 없이 409, 최신 보존', async () => {
  const r2 = installR2()
  try {
    const first = await legacyPost('legacy-v1', ''); const base = first.payload.manifest.revision
    const s1 = await call('POST', 'start', { episodeId: EP, op: 'start' }, { base })
    await putChunk({ base }, s1.payload.slot, 'CHUNKED')
    const gate = delayNextPut(manifestKey)
    const aCommit = commitOf({ base }, s1.payload.slot, 1, 7, s1.payload)
    await gate.seen
    const post = await legacyPost('legacy-v2-wins', base); assert.equal(post.status, 200)
    gate.open()
    const a = await aCommit
    assert.equal(a.status, 409, '확정되지 않은 저장을 200으로 돌려주지 않는다')
    assert.equal((await legacyGet()).text, 'legacy-v2-wins')
    assert.equal((await call('GET', 'manifest', { episodeId: EP, op: 'manifest' })).payload.manifest.revision, post.payload.manifest.revision)
  } finally { r2.restore() }
})

test('7. CAS가 반복 실패해 manifest에 반영되지 못한 저장은 200이 아니라 409이고, 이후 정상 재시도는 같은 저장으로 확정된다', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const s1 = await call('POST', 'start', { episodeId: EP, op: 'start' }, { base: base.revision })
    await putChunk({ base: base.revision }, s1.payload.slot, 'A-DATA')
    reject412(manifestKey, 3) // 저장소가 3번 모두 조건 불일치를 돌려준다(manifest는 그대로 base)
    const a = await commitOf({ base: base.revision }, s1.payload.slot, 1, 6, s1.payload)
    assert.equal(a.status, 409)
    assert.equal((await cloud())?.content, 'base', '미확정 결과는 manifest에 없다')
    const retry = await commitOf({ base: base.revision }, s1.payload.slot, 1, 6, s1.payload)
    assert.equal(retry.status, 200)
    assert.deepEqual(await cloud(), { revision: retry.payload.manifest.revision, content: 'A-DATA' })
  } finally { r2.restore() }
})

test('7b. 확정된 저장의 정상 재시도: 바로 다음 저장이 이어 전진했어도 같은 revision으로 성공한다(다른 요청에는 성공을 주지 않는다)', async () => {
  const r2 = installR2()
  try {
    const base = await upload('base', '')
    const A = { base: base.revision, client: 'client-aaaaaaaa' }
    const s1 = await call('POST', 'start', { episodeId: EP, op: 'start' }, A)
    await putChunk(A, s1.payload.slot, 'A-DATA')
    const a = await commitOf(A, s1.payload.slot, 1, 6, s1.payload); assert.equal(a.status, 200)
    const c = await upload('C-DATA', a.payload.manifest.revision); assert.equal(c.status, 200) // A 바로 다음 저장
    const again = await commitOf(A, s1.payload.slot, 1, 6, s1.payload)
    assert.equal(again.status, 200); assert.equal(again.payload.manifest.revision, a.payload.manifest.revision)
    assert.equal((await cloud())?.content, 'C-DATA')
    // 같은 기준에서 시작한 다른 저장은 성공을 받지 못한다
    const s2 = await call('POST', 'start', { episodeId: EP, op: 'start' }, { base: a.payload.manifest.revision })
    assert.equal(s2.status, 409)
  } finally { r2.restore() }
})

test('8. manifest(<id>.json)를 쓰는 경로는 조건부 쓰기(putIfMatch) 하나뿐이다', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../api/sync/[...path].ts', import.meta.url), 'utf8')
  assert.equal([...src.matchAll(/\bput\(\s*(episodeManifestPath|manifestFile|scopedManifestPath)/g)].length, 0, '에피소드 manifest 무조건 put 없음')
  assert.equal([...src.matchAll(/putIfMatch\(episodeManifestPath|putIfMatch\(manifestFile/g)].length, 2, '신규 commit과 기존 POST 두 경로가 모두 CAS')
})

test('5. 브라우저가 보내는 기준 revision 헤더가 CORS로 허용된다', async () => {
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync(new URL('../api/sync/[...path].ts', import.meta.url), 'utf8'), /Access-Control-Allow-Headers', '[^']*X-Episode-Base/)
})
