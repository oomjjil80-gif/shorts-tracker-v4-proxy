// E-1: 확정된 나레이션은 그대로 두고 연출이 없는 장면의 연출만 GPT로 만든다(gpt-script-qc mode=fill_directions).
// 공급자는 메모리 mock fetch, 유료 호출 0. Run: npx tsx --test tools/fill-directions.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import { INTERNAL_AI_CALL } from '../lib/generative/internalCall.js'
import { isComplete, maxProviderCalls, planAiCall } from '../lib/generative/paidAiCall.js'
import gptScriptQc from '../api/gpt-script-qc.js'

const KEY = 'fill-directions-test-workspace-key-12345'
const scenes = Array.from({ length: 12 }, (_, i) => ({ sceneIndex: i + 1, label: `장면 ${i + 1}`, narration: `확정 나레이션 ${i + 1}`, prompt: i === 2 ? '직접 입력한 시각 설명' : '', direction: i < 7 ? `기존 연출 ${i + 1}` : '' }))
const targets = [8, 9, 10, 11, 12]
const input = { title: '제목', summary: '요약', scenes, targets }
const modelOutput = (indexes: number[], extra: any[] = []) => ({ directions: [...indexes.map((n) => ({ sceneIndex: n, direction: `GPT 연출 ${n}` })), ...extra] })
const openai = (parsed: any) => new Response(JSON.stringify({ model: 'gpt-test', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(parsed) }] }], usage: { total_tokens: 1 } }))

async function withOpenAi(respond: (body: any) => Response, fn: (calls: any[]) => Promise<void>) {
  const old = globalThis.fetch, oldKey = process.env.OPENAI_API_KEY, calls: any[] = []
  process.env.OPENAI_API_KEY = 'mock-free-test-key'
  globalThis.fetch = (async (_url: any, init: any) => { const body = JSON.parse(init.body); calls.push(body); return respond(body) }) as typeof fetch
  try { await fn(calls) } finally { globalThis.fetch = old; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey }
}
const run = async (handler: any, req: any) => { let status = 0, data: any; await handler(req, { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { data = v; return this }, send(v: any) { data = v; return this }, end() { return this } }); return { status, data } }
const direct = (body: any) => run(gptScriptQc, { method: 'POST', headers: {}, query: {}, body, [INTERNAL_AI_CALL]: true })

test('요청한 장면의 연출만 돌려준다: 공급자 호출 1회, 요청하지 않은 장면·나레이션은 응답에 없다', async () => {
  await withOpenAi(() => openai(modelOutput(targets, [{ sceneIndex: 3, direction: '요청하지 않은 장면 3 연출' }, { sceneIndex: 99, direction: '범위 밖' }])), async (calls) => {
    const r = await direct({ mode: 'fill_directions', input })
    assert.equal(r.status, 200); assert.equal(calls.length, 1)
    assert.deepEqual(r.data.directions, targets.map((n) => ({ sceneIndex: n, direction: `GPT 연출 ${n}` })))
    assert.equal(JSON.stringify(r.data).includes('확정 나레이션'), false)
    const sent = JSON.stringify(calls[0])
    assert.match(sent, /직접 입력한 시각 설명/)          // 수동 프롬프트는 맥락으로만 전달
    assert.equal(calls[0].text.format.strict, true); assert.deepEqual(calls[0].text.format.schema.required, ['directions'])
    assert.doesNotMatch(sent, /전체 대본을 다시|rewrite the whole/i)
  })
})

test('모델이 요청한 장면을 빠뜨리거나 비워 두면 성공이 아니다(502), 잘못된 입력은 공급자 호출 0회(400)', async () => {
  await withOpenAi(() => openai(modelOutput([8, 9, 10, 11])), async () => {
    const r = await direct({ mode: 'fill_directions', input }); assert.equal(r.status, 502); assert.equal(r.data.error.code, 'DIRECTIONS_INCOMPLETE')
  })
  await withOpenAi(() => openai({ directions: [...modelOutput([8, 9, 10, 11]).directions, { sceneIndex: 12, direction: '   ' }] }), async () => {
    assert.equal((await direct({ mode: 'fill_directions', input })).status, 502)
  })
  await withOpenAi(() => { throw new Error('provider must not be called') }, async (calls) => {
    for (const bad of [{ ...input, targets: [] }, { ...input, targets: [13] }, { ...input, scenes: [] }, { ...input, scenes: scenes.map((s, i) => (i === 0 ? { ...s, narration: '' } : s)) }]) {
      assert.equal((await direct({ mode: 'fill_directions', input: bad })).status, 400)
    }
    assert.equal(calls.length, 0)
  })
})

test('연출은 600자로 정리된다', async () => {
  await withOpenAi(() => openai({ directions: targets.map((n) => ({ sceneIndex: n, direction: '가'.repeat(900) })) }), async () => {
    const r = await direct({ mode: 'fill_directions', input }); assert.equal(Array.from(r.data.directions[0].direction).length, 600)
  })
})

test('완료 판정·견적: 연출 응답 계약을 채워야 성공, 호출 1회 견적', () => {
  const body = { mode: 'fill_directions' }
  assert.equal(isComplete('gpt-script-qc', { ok: true, directions: [{ sceneIndex: 8, direction: 'x' }] }, body), true)
  for (const bad of [{ ok: true }, { ok: true, directions: [] }, { ok: true, directions: [{ sceneIndex: 8, direction: ' ' }] }, { ok: true, directions: [{ sceneIndex: '8', direction: 'x' }] }, { ok: false, directions: [{ sceneIndex: 8, direction: 'x' }] }]) {
    assert.equal(isComplete('gpt-script-qc', bad, body), false)
  }
  assert.equal(maxProviderCalls('gpt-script-qc', { mode: 'fill_directions', input }), 1)
  assert.equal(planAiCall('gpt-script-qc', { mode: 'fill_directions', input }, false).calls, 1)
})

test('서버 승인 경로: 견적은 공급자 호출 0회, 승인 후 1회, 같은 요청 재시도는 저장 결과 복구(무과금), 직접 호출은 403', async () => {
  const handler = createCardnewsHttp({ blobs: createMemoryBlobStore() })
  const call = (body: any) => run(handler, { method: 'POST', headers: { 'x-sync-key': KEY }, body: { taskType: 'cardnews_ai_call', ...body } })
  await withOpenAi(() => openai(modelOutput(targets)), async (calls) => {
    const req = { target: 'gpt-script-qc', body: { mode: 'fill_directions', input } }
    assert.equal((await run(gptScriptQc, { method: 'POST', headers: { 'x-sync-key': KEY }, query: {}, body: req.body })).status, 403)
    const quote = await call(req); assert.equal(quote.status, 402); assert.equal(calls.length, 0)
    const approved = { ...req, approvalId: quote.data.approval.approvalId, costApproved: true, approvedUsd: quote.data.estimate.usd }
    const ok = await call(approved); assert.equal(ok.status, 200); assert.equal(calls.length, 1)
    assert.deepEqual(ok.data.directions.map((d: any) => d.sceneIndex), targets)
    const replay = await call(req); assert.equal(replay.status, 200); assert.equal(replay.data.recovered, true); assert.equal(calls.length, 1)
  })
})
