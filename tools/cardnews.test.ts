// 카드뉴스 서버 기능: 비용 승인 전 공급자 호출 0회, GPT 구성 → Claude 독립 검수 → 문제 장만 수정, 저장/복구(낙관적 잠금). 모두 가짜 공급자(네트워크·유료 호출 없음).
// Run: node --import tsx --test tools/cardnews.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import { parseReview, cardnewsEstimate } from '../lib/cardnews/cardnews.js'

const KEY = 'k'.repeat(32), OTHER = 'z'.repeat(32)
const cover = { id: 'cv_1a2b3c4d', title: '월급날 통장이 비는 진짜 이유', coverLine: '월급날 통장', promise: '자동이체 날짜가 통장을 비운다' }
const mk = (n: number): any[] => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, role: i === 0 ? 'hook' : i === n - 1 ? 'ending' : 'body', headline: `제목${i + 1}`, body: `본문${i + 1}` }))
function rig() {
  const calls: string[] = []
  const deps = {
    gpt: async (name: string, _s: any, _i: string, input: string) => {
      calls.push('gpt:' + name)
      if (name === 'cardnews_compose') return { cards: Array.from({ length: 6 }, (_, i) => ({ headline: `새제목${i + 1}`, body: `새본문${i + 1}`, visualPlan: { subject: `새제목${i + 1} 장면의 핵심 사물 ${['우물','가야금','서생','등불','달빛','마을'][i]}`, composition: ['와이드','접사','부감','측면','역광','로우앵글'][i] + ' 구도', distinction: `${i}장과 다른 시점` } })) }
      const t = JSON.parse(input).다시쓸장 as any[]
      return { cards: [...t.map((c) => ({ id: c.id, headline: '고친제목', body: '고친본문' })), { id: 'c1', headline: '몰래바꿈', body: 'x' }] }
    },
    claude: async () => { calls.push('claude:review'); return { text: '{"findings":[{"cardId":"c3","code":"WEAK_HOOK","severity":"required","message":"전개가 약하다"}]}', model: 'claude-test' } }
  }
  const blobs = createMemoryBlobStore(), h = createCardnewsHttp({ blobs, deps: () => deps as any })
  const call = async (method: string, body: any, key: string | null = KEY) => {
    let status = 0, out: any
    const res: any = { setHeader() {}, status(s: number) { status = s; return this }, json(b: any) { out = b; return this } }
    await h({ method, headers: key ? { 'x-sync-key': key } : {}, body: method === 'POST' ? body : undefined, query: method === 'GET' ? body : undefined } as any, res)
    return { status, body: out }
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

test('B. 자동 경로: GPT 구성 → Claude 독립 검수 → 문제 장(c3)만 GPT 수정, 다른 장은 그대로', async () => {
  const { calls, call } = rig()
  const c = await call('POST', { taskType: 'cardnews_compose', cover, material: '월급날마다 통장이 비는 이유를 설명하는 충분히 긴 소재입니다.', count: 6, ...ok })
  assert.equal(c.status, 200); assert.equal(c.body.cards.length, 6); assert.deepEqual(c.body.cards.map((x: any) => x.role), ['hook', 'body', 'body', 'body', 'body', 'ending'])
  const r = await call('POST', { taskType: 'cardnews_review', cover, cards: c.body.cards, ...ok })
  assert.equal(r.body.reviewerModel, 'claude-test'); assert.equal(r.body.issues[0].cardId, 'c3')
  const f = await call('POST', { taskType: 'cardnews_fix', cover, cards: c.body.cards, issues: r.body.issues, ...ok })
  assert.deepEqual(f.body.changed, ['c3'])
  f.body.cards.forEach((x: any, i: number) => { if (x.id === 'c3') assert.equal(x.headline, '고친제목'); else assert.deepEqual(x, c.body.cards[i], `card ${x.id} untouched (model's stray c1 edit ignored)`) })
  assert.deepEqual(calls, ['gpt:cardnews_compose', 'claude:review', 'gpt:cardnews_fix'])
  assert.deepEqual(f.body.order, ['gpt:compose', 'claude:review', 'gpt:fix'])
})

test('C. 입력 검증과 실패: 표지 없음/지적 없음/모델이 요청 장을 빠뜨림/공급자 오류 → 안전하게 거절(복사·붙여넣기 폴백 가능)', async () => {
  const { call } = rig()
  assert.equal((await call('POST', { taskType: 'cardnews_compose', cover: { id: 'x' }, material: 'm'.repeat(30), ...ok })).status, 400)
  assert.equal((await call('POST', { taskType: 'cardnews_fix', cover, cards: mk(6), issues: [], ...ok })).status, 400)
  const miss = createCardnewsHttp({ blobs: createMemoryBlobStore(), deps: () => ({ gpt: async () => ({ cards: [] }), claude: async () => { throw new Error('down') } }) as any })
  const run = async (b: any) => { let st = 0, out: any; await miss({ method: 'POST', headers: { 'x-sync-key': KEY }, body: b } as any, { setHeader() {}, status(s: number) { st = s; return this }, json(x: any) { out = x; return this } } as any); return { st, out } }
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
