// 유료 AI 1회용 승인: 중복 요청·동시 요청·내용 바꿔치기·만료·$20 경고(차단 아님). 무료(가짜 공급자, 메모리 저장소).
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { requireApproval, recordSpend, payloadHash, ApprovalError } from '../lib/generative/paidApproval.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'

const WS = 'w'.repeat(64), KEY = 'k'.repeat(32), quote = { task: 'cardnews_review', usd: 0.03, calls: 1 }
const code = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e: any) { return e instanceof ApprovalError ? e.code : `OTHER:${e.message}` } }
const issue = async (blobs: any, input: any) => { try { await requireApproval(blobs, { ws: WS, input, quote }) } catch (e: any) { return e.extra.approval.approvalId as string } throw new Error('no approval issued') }

test('승인 없는 요청은 승인 ID만 발급(사용 안 됨), 같은 승인은 한 번만 통과', async () => {
  const blobs = createMemoryBlobStore(), input = { cards: [1, 2] }
  assert.equal(await code(requireApproval(blobs, { ws: WS, input, quote })), 'COST_APPROVAL_REQUIRED')
  const id = await issue(blobs, input)
  assert.equal(await code(requireApproval(blobs, { ws: WS, input: { ...input, approvalId: id, costApproved: true }, quote })), 'OK')
  assert.equal(await code(requireApproval(blobs, { ws: WS, input: { ...input, approvalId: id, costApproved: true }, quote })), 'APPROVAL_USED')
})

test('동시 요청 10개가 같은 승인을 써도 정확히 1개만 통과', async () => {
  const blobs = createMemoryBlobStore(), input = { cards: [1] }, id = await issue(blobs, input)
  const r = await Promise.all(Array.from({ length: 10 }, () => code(requireApproval(blobs, { ws: WS, input: { ...input, approvalId: id }, quote }))))
  assert.equal(r.filter((x) => x === 'OK').length, 1); assert.equal(r.filter((x) => x === 'APPROVAL_USED').length, 9)
})

test('승인을 다른 내용·다른 작업·더 큰 비용·다른 워크스페이스에 쓰지 못함, 만료되면 거절', async () => {
  const blobs = createMemoryBlobStore(), input = { cards: [1] }, id = await issue(blobs, input)
  assert.equal(await code(requireApproval(blobs, { ws: WS, input: { cards: [2], approvalId: id }, quote })), 'APPROVAL_MISMATCH')
  assert.equal(await code(requireApproval(blobs, { ws: WS, input: { ...input, approvalId: id }, quote: { ...quote, task: 'cardnews_fix' } })), 'APPROVAL_MISMATCH')
  assert.equal(await code(requireApproval(blobs, { ws: WS, input: { ...input, approvalId: id }, quote: { ...quote, usd: 0.5 } })), 'APPROVAL_MISMATCH')
  assert.equal(await code(requireApproval(blobs, { ws: 'x'.repeat(64), input: { ...input, approvalId: id }, quote })), 'COST_APPROVAL_REQUIRED')
  assert.equal(await code(requireApproval(blobs, { ws: WS, input: { ...input, approvalId: id }, quote, now: new Date(Date.now() + 16 * 60_000) })), 'APPROVAL_EXPIRED')
  assert.equal(await code(requireApproval(blobs, { ws: WS, input: { ...input, approvalId: id }, quote })), 'OK', 'the rejected attempts did not consume it')
  assert.equal(payloadHash({ a: 1, b: [1, { c: 2, d: 3 }] }), payloadHash({ b: [1, { d: 3, c: 2 }], a: 1, approvalId: 'x', costApproved: true }), 'key order and approval fields do not matter')
})

test('$20은 경고만: 넘어도 계속 기록·통과, 같은 승인은 두 번 기록되지 않음', async () => {
  const blobs = createMemoryBlobStore(), now = new Date('2026-10-26T04:00:00Z')
  let last: any
  for (let i = 0; i < 3; i++) last = await recordSpend(blobs, { ws: WS, now, approval: { approvalId: `a${i}`, ws: WS, task: 't', payloadHash: 'h', usd: 9, issuedAt: '', expiresAt: '' } })
  assert.equal(last.monthUsd, 27); assert.equal(last.warning, true); assert.equal(last.month, '202610')
  const again = await recordSpend(blobs, { ws: WS, now, approval: { approvalId: 'a2', ws: WS, task: 't', payloadHash: 'h', usd: 9, issuedAt: '', expiresAt: '' } })
  assert.equal(again.monthUsd, 27)
  // 경고 상태에서도 승인된 호출은 막지 않는다
  const id = await issue(blobs, { x: 1 }); assert.equal(await code(requireApproval(blobs, { ws: WS, input: { x: 1, approvalId: id }, quote })), 'OK')
})

test('카드뉴스 HTTP: 더블 클릭(같은 승인 2번·동시) → 공급자 호출 1회, 실패해도 승인 재사용 불가, 비용 기록·경고 응답', async () => {
  let paid = 0, fail = false
  const deps = { claude: async () => ({ text: '{"cards":[]}', model: 'm' }), gpt: async () => { paid++; if (fail) throw new Error('down'); return { findings: [] } } }
  const h = createCardnewsHttp({ blobs: createMemoryBlobStore(), deps: () => deps as any })
  const call = async (body: any) => { let status = 0, out: any; await h({ method: 'POST', headers: { 'x-sync-key': KEY }, body } as any, { setHeader() {}, status(s: number) { status = s; return this }, json(b: any) { out = b; return this } } as any); return { status, body: out } }
  const cover = { id: 'cv_abcd', title: '제목 넷글자', coverLine: '표지', promise: '약속하는 핵심 내용' }
  const cards = Array.from({ length: 6 }, (_, i) => ({ id: `c${i + 1}`, headline: `제목${i}`, body: `본문 ${i}` }))
  const body = { taskType: 'cardnews_review', cover, material: '소재'.repeat(20), cards }
  const q = await call(body); assert.equal(q.status, 402); assert.equal(paid, 0); const id = q.body.approval.approvalId
  assert.ok(id && q.body.estimate.usd > 0)
  const [a, b] = await Promise.all([call({ ...body, costApproved: true, approvedUsd: q.body.estimate.usd, approvalId: id }), call({ ...body, costApproved: true, approvedUsd: q.body.estimate.usd, approvalId: id })])
  assert.deepEqual([a.status, b.status].sort(), [200, 409]); assert.equal(paid, 1, 'exactly one paid call')
  const okRes = a.status === 200 ? a : b; assert.equal(okRes.body.budget.warning, false); assert.ok(okRes.body.budget.monthUsd > 0)
  assert.equal((await call({ ...body, costApproved: true, approvedUsd: 1, approvalId: id })).body.error.code, 'APPROVAL_USED'); assert.equal(paid, 1)
  // 공급자 실패: 승인은 소모됨(이미 과금됐을 수 있음) → 같은 승인으로 재시도 불가, 새 승인 필요
  fail = true; const q2 = await call(body), id2 = q2.body.approval.approvalId
  assert.equal((await call({ ...body, costApproved: true, approvedUsd: 1, approvalId: id2 })).status, 503)
  assert.equal((await call({ ...body, costApproved: true, approvedUsd: 1, approvalId: id2 })).status, 409); assert.equal(paid, 2)
  // 예전 방식(서버 승인 ID 없이 costApproved만)은 더 이상 호출하지 않음
  assert.equal((await call({ ...body, costApproved: true, approvedUsd: 5 })).status, 402); assert.equal(paid, 2)
})
