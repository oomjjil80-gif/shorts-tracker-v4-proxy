// D-2: 직접 호출 유료 AI의 서버 승인 경로(cardnews_ai_call). 공급자는 메모리 mock fetch, 유료 호출 0.
// Run: npx tsx --test tools/paid-ai-call.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import imageHandler from '../api/image.js'
import claudeStory from '../api/claude-story.js'
import claudeRevise from '../api/claude-longform-revise.js'
import gptScriptQc from '../api/gpt-script-qc.js'
import gptImageQc from '../api/gpt-image-qc.js'
import storyRouter from '../api/story.js'

const KEY = 'paid-ai-call-test-workspace-key-12345'
const run = async (handler: any, req: any) => { let status = 0, data: any; await handler(req, { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { data = v; return this }, send(v: any) { data = v; return this }, end() { return this } }); return { status, data } }
const withProviders = async (respond: (url: string, init: any) => Response | Promise<Response>, fn: (calls: string[]) => Promise<void>) => {
  const old = globalThis.fetch, keys = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].map((k) => [k, process.env[k]] as const), calls: string[] = []
  for (const [k] of keys) process.env[k] = 'mock-free-test-key'
  globalThis.fetch = (async (url: any, init: any) => { calls.push(String(url)); return respond(String(url), init) }) as typeof fetch
  try { await fn(calls) } finally { globalThis.fetch = old; for (const [k, v] of keys) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const gemini = () => new Response(JSON.stringify({ output_image: { data: Buffer.from('fake-image').toString('base64'), mime_type: 'image/png' } }))
const imageBody = (prompt = 'An ordinary cut image of the approved story scene, no text inside the picture') => ({ input: { prompt, aspectRatio: '9:16', imageSize: '1K', cutIndex: 0, references: [], profile: '' } })

test('직접 호출 5곳 + 구형 스토리 작업: 서버 승인 경로 밖의 POST는 공급자 호출 0회로 403', async () => {
  await withProviders(() => { throw new Error('provider must not be called') }, async (calls) => {
    const post = (handler: any, body: any) => run(handler, { method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: {}, body })
    for (const [name, handler, body] of [
      ['claude-story', claudeStory, { input: { title: 't' } }], ['claude-longform-revise', claudeRevise, { input: {} }], ['gpt-script-qc', gptScriptQc, { input: {} }],
      ['gpt-image-qc', gptImageQc, { input: { prompt: 'p', imageBase64: 'AAAA', mimeType: 'image/png' } }], ['image', imageHandler, imageBody()],
      ['story(yasa_story_plan)', storyRouter, { taskType: 'yasa_story_plan', input: { topic: 't' } }], ['story(longform_chapter)', storyRouter, { taskType: 'longform_chapter', input: {} }],
      ['story(visual_director)', storyRouter, { taskType: 'visual_director', input: {} }], ['story(default)', storyRouter, { input: {} }],
    ] as const) {
      const r = await post(handler, body)
      assert.equal(r.status, 403, name); assert.equal(r.data.error.code, 'AI_APPROVAL_REQUIRED', name)
    }
    assert.equal(calls.length, 0)
  })
})

test('cardnews_ai_call: 인증 없으면 401, 견적 단계는 공급자 호출 0회, 승인 후 1회, 같은 요청 재시도는 저장 결과 복구, 중복 클릭은 1회만', async () => {
  const handler = createCardnewsHttp({ blobs: createMemoryBlobStore() })
  const call = (body: any, key: string | null = KEY) => run(handler, { method: 'POST', headers: key ? { 'x-sync-key': key } : {}, body: { taskType: 'cardnews_ai_call', ...body } })
  await withProviders(() => gemini(), async (calls) => {
    const req = { target: 'image', body: imageBody() }
    assert.equal((await call(req, null)).status, 401)
    const quote = await call(req); assert.equal(quote.status, 402); assert.match(quote.data.estimate.note, /Gemini 이미지/); assert.equal(calls.length, 0, 'quote: no provider call')
    const approved = { ...req, approvalId: quote.data.approval.approvalId, costApproved: true, approvedUsd: quote.data.estimate.usd }
    assert.equal((await call({ ...approved, approvedUsd: 0 })).status, 402); assert.equal(calls.length, 0, 'no consent amount: no provider call')
    // double click: two concurrent requests with the same approval → exactly one provider call
    const [a, b] = await Promise.all([call(approved), call(approved)])
    assert.deepEqual([a.status, b.status].sort(), [200, 409].sort()); assert.equal(calls.length, 1)
    const ok = a.status === 200 ? a : b; assert.equal(ok.data.image.mimeType, 'image/png')
    // lost response → the same request again: stored result, no approval, no provider call
    const replay = await call(req); assert.equal(replay.status, 200); assert.equal(replay.data.recovered, true); assert.equal(replay.data.image.base64, ok.data.image.base64); assert.equal(calls.length, 1)
    // a deliberate new run (regenerate id) is a NEW request: it needs its own approval
    const next = await call({ ...req, regenerate: 'r1' }); assert.equal(next.status, 402); assert.equal(calls.length, 1)
  })
})

test('이미지 + 자동 검수: 한 번의 승인 안에서 이미지 1회·검수 1회, 검수가 실패해도 이미지는 그대로, 복구 때 검수를 다시 호출하지 않는다', async () => {
  const handler = createCardnewsHttp({ blobs: createMemoryBlobStore() })
  const call = (body: any) => run(handler, { method: 'POST', headers: { 'x-sync-key': KEY }, body: { taskType: 'cardnews_ai_call', ...body } })
  await withProviders((url) => url.includes('openai') ? new Response('{"error":"qc down"}', { status: 500 }) : gemini(), async (calls) => {
    const req = { target: 'image', body: imageBody('A different cut image prompt for the QC inclusion test, no text'), qc: { prompt: 'cut prompt', context: { cutIndex: 0 } } }
    const quote = await call(req); assert.equal(quote.status, 402); assert.ok(Math.abs(quote.data.estimate.usd - 0.077) < 1e-9); assert.match(quote.data.estimate.note, /검수 포함/)
    const done = await call({ ...req, approvalId: quote.data.approval.approvalId, costApproved: true, approvedUsd: quote.data.estimate.usd })
    assert.equal(done.status, 200); assert.ok(done.data.image.base64); assert.equal(done.data.qc, null, 'a failed QC never blocks the image')
    assert.equal(calls.filter((u) => u.includes('openai')).length >= 1, true); const total = calls.length
    const replay = await call(req); assert.equal(replay.data.recovered, true); assert.equal(calls.length, total, 'recovery calls neither Gemini nor QC')
    assert.equal((await call({ target: 'gpt-image-qc', body: { input: {} }, qc: { prompt: 'x' } })).status, 400, 'qc belongs to image calls only')
  })
})

test('결과가 불확실한 호출(공급자 5xx·응답 없음)은 자동으로 다시 호출하지 않는다 — 그대로 막히고, 호출 전 거절(4xx)은 새 승인으로 다시 할 수 있다', async () => {
  const handler = createCardnewsHttp({ blobs: createMemoryBlobStore() })
  const call = (body: any) => run(handler, { method: 'POST', headers: { 'x-sync-key': KEY }, body: { taskType: 'cardnews_ai_call', ...body } })
  const approve = async (req: any) => { const q = await call(req); assert.equal(q.status, 402, JSON.stringify(q.data)); return call({ ...req, approvalId: q.data.approval.approvalId, costApproved: true, approvedUsd: q.data.estimate.usd }) }
  await withProviders(() => new Response('{"error":{"message":"overloaded"}}', { status: 503 }), async (calls) => {
    const req = { target: 'image', body: imageBody('An image whose provider answer is lost or fails with a server error, no text inside') }
    const first = await approve(req); assert.ok(first.status >= 400); const used = calls.length
    const again = await call(req); assert.equal(again.status, 409); assert.equal(again.data.error.code, 'AI_STATE_UNKNOWN'); assert.equal(calls.length, used, 'no automatic re-call / re-bill')
    // the user deliberately starts a new run (new regenerate id) → needs a new approval, never automatic
    assert.equal((await call({ ...req, regenerate: 'r2' })).status, 402); assert.equal(calls.length, used)
  })
  await withProviders(() => { throw new Error('provider must not be called') }, async (calls) => {
    // validation failure inside our own handler (400 before any provider call) → failed_safe: the same request may be approved again
    const bad = { target: 'gpt-image-qc', body: { input: {} } }
    const r1 = await approve(bad); assert.equal(r1.status, 400); const r2 = await call(bad); assert.equal(r2.status, 402, 'a safely failed request can be approved again'); assert.equal(calls.length, 0)
  })
})

test('구형 스토리 작업은 허용된 taskType만 통과하고, 다른 라우터(job_* 등)로는 닿지 않는다', async () => {
  const handler = createCardnewsHttp({ blobs: createMemoryBlobStore() })
  const call = (body: any) => run(handler, { method: 'POST', headers: { 'x-sync-key': KEY }, body: { taskType: 'cardnews_ai_call', ...body } })
  assert.equal((await call({ target: 'story', body: { taskType: 'job_create', input: {} } })).status, 400)
  assert.equal((await call({ target: 'story', body: { taskType: 'source_collect', url: 'x' } })).status, 400)
  assert.equal((await call({ target: 'nope', body: {} })).status, 400)
  assert.equal((await call({ target: 'story', body: { taskType: 'yasa_story_plan', input: { topic: 't' } } })).status, 402)
})
