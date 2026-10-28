// 카드뉴스 서버 기능: 비용 승인 전 공급자 호출 0회, GPT 구성 → Claude 독립 검수 → 문제 장만 수정, 저장/복구(낙관적 잠금). 모두 가짜 공급자(네트워크·유료 호출 없음).
// Run: node --import tsx --test tools/cardnews.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import { parseReview, cardnewsEstimate } from '../lib/cardnews/cardnews.js'
import { createVercelJobBlobStore } from '../lib/jobs/blobs.js'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

test('R2 cardnews: issue approval without legacy probe; inaccessible legacy data is never treated as absent', async (t) => {
  const env = { R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_BUCKET: 'tracker', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore_secret' }
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const objects = new Map<string, string>(), writes: string[] = []
  const originalFetch = globalThis.fetch, dispatcher = getGlobalDispatcher()
  const agent = new MockAgent(); agent.disableNetConnect()
  let legacyCalls = 0, providers = 0
  const forbidden = () => { legacyCalls++; return { statusCode: 403, data: JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden' } }) } }
  agent.get('https://vercel.com').intercept({ path: () => true, method: () => true }).reply(forbidden).persist()
  agent.get(/blob\.vercel-storage\.com$/).intercept({ path: () => true, method: () => true }).reply(forbidden).persist()
  setGlobalDispatcher(agent)
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input)); assert.equal(url.origin, env.R2_ENDPOINT)
    const key = decodeURIComponent(url.pathname.slice('/tracker/'.length)), method = init.method || 'GET'
    if (method === 'PUT') {
      if (init.headers['if-none-match'] === '*' && objects.has(key)) return new Response('', { status: 412 })
      writes.push(key); objects.set(key, String(init.body)); return new Response('', { status: 200 })
    }
    const value = objects.get(key)
    return value === undefined ? new Response(null, { status: 404 }) : new Response(method === 'HEAD' ? null : value, { status: 200, headers: { 'content-length': String(Buffer.byteLength(value)) } })
  }) as any
  try {
    const blobs = createVercelJobBlobStore()
    await t.test('fresh approval is a conditional R2 create, with no legacy read and no provider call', async () => {
      const h = createCardnewsHttp({ blobs, deps: () => { providers++; throw new Error('paid provider forbidden') } })
      let status = 0, body: any
      await h({ method: 'POST', headers: { 'x-sync-key': 'k'.repeat(32) }, body: { taskType: 'cardnews_compose', material: '월급날 통장이 비는 이유를 설명하는 소재입니다.' } } as any,
        { setHeader() {}, status(s: number) { status = s; return this }, json(b: any) { body = b; return this } } as any)
      assert.equal(status, 402); assert.equal(body.error.code, 'COST_APPROVAL_REQUIRED')
      assert.equal(providers, 0); assert.equal(legacyCalls, 0)
      assert.equal(writes.length, 1); assert.match(writes[0], /^paid-approvals\/.*\.issued\.json$/)
      const approval: any = await blobs.getJson(writes[0]); assert.equal(approval.approvalId, body.approval.approvalId)
      assert.equal(await blobs.claim!(writes[0], { overwritten: true }), false)
      assert.deepEqual(await blobs.getJson(writes[0]), approval)
    })
    await t.test('legacy 403 stays an error for reads and existence checks, preventing shadow overwrite', async () => {
      await assert.rejects(blobs.getJson('cardnews/legacy/state.json'))
      const before = writes.length
      await assert.rejects(blobs.putJson('cardnews/legacy/state.json', { rev: 0 }))
      assert.equal(writes.length, before)
    })
    await t.test('existing R2 script and images remain readable without legacy access', async () => {
      const value = { rev: 4, state: { cards: [{ headline: '기존 대본', imageRef: 'cardnews/images/old.png' }] } }
      objects.set('cardnews/current/state.json', JSON.stringify(value))
      const before = legacyCalls
      assert.deepEqual(await blobs.getJson('cardnews/current/state.json'), value)
      assert.equal(legacyCalls, before)
    })
  } finally {
    globalThis.fetch = originalFetch; setGlobalDispatcher(dispatcher); await agent.close()
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

const KEY = 'k'.repeat(32), OTHER = 'z'.repeat(32)
const cover = { id: 'cv_1a2b3c4d', title: '월급날 통장이 비는 진짜 이유', coverLine: '월급날 통장', promise: '자동이체 날짜가 통장을 비운다' }
const mk = (n: number): any[] => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, role: i === 0 ? 'hook' : i === n - 1 ? 'ending' : 'body', headline: `제목${i + 1}`, body: `본문${i + 1}` }))
function rig() {
  const calls: string[] = []
  // 작성(대본·수정) = Claude(JSON 텍스트), 검수 = GPT(구조화 출력)
  const ai = (name: string, input: string): any => {
      if (name === 'cardnews_review') return { findings: [{ cardId: 'c3', code: 'WEAK_HOOK', severity: 'required', message: '전개가 약하다' }] }
      if (name === 'cardnews_compose') return { cards: Array.from({ length: 6 }, (_, i) => ({ headline: `새제목${i + 1}`, body: `새본문${i + 1}`, visualPlan: { subject: `새제목${i + 1} 장면의 핵심 사물 ${['우물','가야금','서생','등불','달빛','마을'][i]}`, composition: ['와이드','접사','부감','측면','역광','로우앵글'][i] + ' 구도', distinction: `${i}장과 다른 시점` } })) }
      const t = JSON.parse(input).다시쓸장 as any[]
      return { cards: [...t.map((c) => ({ id: c.id, headline: '고친제목', body: '고친본문' })), { id: 'c1', headline: '몰래바꿈', body: 'x' }] }
  }
  const deps = {
    gpt: async (name: string, _s: any, _i: string, input: string) => { calls.push('gpt:' + name); return ai(name, input) },
    claude: async (_sys: string, input: string, name = '') => { calls.push('claude:' + name); return { text: '```json\n' + JSON.stringify(ai(name, input)) + '\n```', model: 'claude-test' } }
  }
  const blobs = createMemoryBlobStore(), h = createCardnewsHttp({ blobs, deps: () => deps as any })
  const raw = async (method: string, body: any, key: string | null = KEY) => {
    let status = 0, out: any
    const res: any = { setHeader() {}, status(s: number) { status = s; return this }, json(b: any) { out = b; return this } }
    await h({ method, headers: key ? { 'x-sync-key': key } : {}, body: method === 'POST' ? body : undefined, query: method === 'GET' ? body : undefined } as any, res)
    return { status, body: out }
  }
  // 승인된 요청(costApproved:true)은 실제 화면처럼 2단계: 승인 없이 보내 서버 발급 approvalId를 받고, 그 ID로 다시 보낸다.
  const call = async (method: string, body: any, key: string | null = KEY) => {
    if (method !== 'POST' || body?.costApproved !== true || body?.approvalId) return raw(method, body, key)
    const q = await raw(method, { ...body, costApproved: false }, key)
    return q.status === 402 && q.body?.approval?.approvalId ? raw(method, { ...body, approvalId: q.body.approval.approvalId }, key) : q
  }
  return { calls, call, blobs }
}
const ok = { costApproved: true, approvedUsd: 1 }

test('A. 비용 승인 없이는 모든 AI 작업이 공급자 호출 0회 + 예상 비용 반환 (승인 금액이 부족해도 거절)', async () => {
  const { calls, call } = rig()
  for (const [taskType, extra] of [['cardnews_compose', { material: '월급날마다 통장이 비는 이유를 설명하는 충분히 긴 소재입니다.' }], ['cardnews_review', { cards: mk(6) }], ['cardnews_fix', { cards: mk(6), issues: [{ cardId: 'c3', message: 'm' }] }]] as const) {
    for (const approval of [{}, { costApproved: true }, { costApproved: true, approvedUsd: 0.0001 }, { costApproved: 'yes', approvedUsd: 5 }]) {
      const r = await call('POST', { taskType, cover, ...extra, ...approval })
      assert.equal(r.status, 402); assert.equal(r.body.error.code, 'COST_APPROVAL_REQUIRED'); assert.equal(r.body.estimate.confirmed, false); assert.ok(r.body.estimate.usd > 0)
    }
  }
  assert.deepEqual(calls, [], 'no provider call before approval')
})

test('B. 자동 경로: Claude 대본 → GPT 독립 검수 → 문제 장(c3)만 Claude 수정, 다른 장은 그대로', async () => {
  const { calls, call } = rig()
  const c = await call('POST', { taskType: 'cardnews_compose', cover, material: '월급날마다 통장이 비는 이유를 설명하는 충분히 긴 소재입니다.', count: 6, ...ok })
  assert.equal(c.status, 200); assert.equal(c.body.cards.length, 6); assert.deepEqual(c.body.cards.map((x: any) => x.role), ['hook', 'body', 'body', 'body', 'body', 'ending'])
  const r = await call('POST', { taskType: 'cardnews_review', cover, cards: c.body.cards, ...ok })
  assert.equal(r.body.reviewerModel, 'gpt'); assert.equal(r.body.issues[0].cardId, 'c3')
  const f = await call('POST', { taskType: 'cardnews_fix', cover, cards: c.body.cards, issues: r.body.issues, ...ok })
  assert.deepEqual(f.body.changed, ['c3'])
  f.body.cards.forEach((x: any, i: number) => { if (x.id === 'c3') assert.equal(x.headline, '고친제목'); else assert.deepEqual(x, c.body.cards[i], `card ${x.id} untouched (model's stray c1 edit ignored)`) })
  assert.deepEqual(calls, ['claude:cardnews_compose', 'gpt:cardnews_review', 'claude:cardnews_fix'])
  assert.deepEqual(f.body.order, ['claude:compose', 'gpt:review', 'claude:fix'])
})

test('C. 입력 검증과 실패: 표지 없음/지적 없음/모델이 요청 장을 빠뜨림/공급자 오류 → 안전하게 거절(복사·붙여넣기 폴백 가능)', async () => {
  const { call } = rig()
  assert.equal((await call('POST', { taskType: 'cardnews_compose', cover: { id: 'x' }, material: 'm'.repeat(30), ...ok })).status, 400)
  assert.equal((await call('POST', { taskType: 'cardnews_fix', cover, cards: mk(6), issues: [], ...ok })).status, 400)
  const miss = createCardnewsHttp({ blobs: createMemoryBlobStore(), deps: () => ({ claude: async () => ({ text: '{"cards":[]}', model: 'm' }), gpt: async () => { throw new Error('down') } }) as any })
  const run = async (b: any): Promise<{ st: number; out: any }> => { if (b.costApproved === true && !b.approvalId) { const q = await run({ ...b, costApproved: false }); if (q.st === 402) return run({ ...b, approvalId: q.out.approval.approvalId }) } let st = 0, out: any; await miss({ method: 'POST', headers: { 'x-sync-key': KEY }, body: b } as any, { setHeader() {}, status(s: number) { st = s; return this }, json(x: any) { out = x; return this } } as any); return { st, out } }
  assert.equal((await run({ taskType: 'cardnews_fix', cover, cards: mk(6), issues: [{ cardId: 'c2', message: 'm' }], ...ok })).out.error.code, 'FIX_INCOMPLETE')
  const down = await run({ taskType: 'cardnews_review', cover, cards: mk(6), ...ok }); assert.equal(down.st, 503); assert.equal(down.out.error.code, 'PROVIDER_DOWN')
  assert.throws(() => parseReview('no json', mk(6)), /JSON/); assert.throws(() => parseReview('{"findings":[{"cardId":"c1","message":""}]}', mk(6)), /이유/)
  assert.equal(parseReview('{"findings":[{"cardId":"zz","code":"X","severity":"required","message":"m"}]}', mk(6))[0].cardId, null)
  assert.equal(cardnewsEstimate('compose').confirmed, false)
})

test('D. 서버 저장/복구: 승인 상태 포함 왕복, 다른 워크스페이스는 못 봄, 오래된 baseRev는 409, 이미지 데이터 미저장', async () => {
  const { call, blobs } = rig()
  assert.equal((await call('GET', { taskType: 'cardnews_get' })).body.saved, null)
  const state = { material: '소재', count: 6, form: { title: cover.title, coverLine: cover.coverLine, promise: cover.promise }, cover, cards: mk(6), review: { ok: true, issues: [] }, theme: 'night', pendingAiIds: null, bgImages: { c1: 'data:image/png;base64,AAAA' } }
  const s1 = await call('POST', { taskType: 'cardnews_save', state, baseRev: 0 }); assert.equal(s1.body.saved.rev, 1)
  const g = await call('GET', { taskType: 'cardnews_get' }); assert.deepEqual(g.body.saved.state.cover, cover); assert.equal(g.body.saved.state.cards.length, 6); assert.ok(!JSON.stringify(g.body.saved).includes('data:image'))
  assert.equal((await call('GET', { taskType: 'cardnews_get' }, OTHER)).body.saved, null)
  const stale = await call('POST', { taskType: 'cardnews_save', state, baseRev: 0 }); assert.equal(stale.status, 409); assert.equal(stale.body.server.rev, 1)
  assert.equal((await call('POST', { taskType: 'cardnews_save', state, baseRev: 1 })).body.saved.rev, 2)
  assert.equal((await call('POST', { taskType: 'cardnews_save', state: { ...state, cover: { id: 'bad' } }, baseRev: 2 })).status, 400)
  assert.equal((await call('POST', { taskType: 'cardnews_save', state: { ...state, material: 'x'.repeat(6000), cards: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, headline: 'h'.repeat(200), body: 'b'.repeat(800) })) }, baseRev: 2 })).status, 200)
  assert.equal((await call('GET', { taskType: 'cardnews_get' }, null)).status, 401)
  assert.ok([...blobs.files.keys()].every((k) => k.startsWith('cardnews/')))
})

test('E. 라우팅·범위: api/story.ts가 cardnews_*만 새 어댑터로 보내고, 기존 Job/Wisdom 파일은 이 변경에 없음', () => {
  const story = readFileSync(new URL('../api/story.ts', import.meta.url), 'utf8')
  assert.match(story, /taskType\.startsWith\('cardnews_'\)[\s\S]*lib\/cardnews\/http\.js/)
  const http = readFileSync(new URL('../lib/cardnews/http.ts', import.meta.url), 'utf8')
  assert.match(http, /x-sync-key/); assert.ok(!/lib\/jobs\/http/.test(http))
})
