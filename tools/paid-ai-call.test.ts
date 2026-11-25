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
    const quote = await call(req); assert.equal(quote.status, 402); assert.ok(Math.abs(quote.data.estimate.usd - 0.077) < 1e-9); assert.match(quote.data.estimate.note, /검수 1회/); assert.equal(quote.data.estimate.calls, 2)
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

// ── D-2 독립 검증 결함 재현(수정 전 실패 · 수정 후 통과): 공급자 호출 횟수는 정확한 수치로 단언한다 ──
import { planAiCall, maxProviderCalls, isComplete } from '../lib/generative/paidAiCall.js'
import { withCallBudget, CallLimitError } from '../lib/generative/callBudget.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { createVoicePreview } from '../lib/generative/voicePreview.js'
const aiHttp = (blobs: any = createMemoryBlobStore()) => { const handler = createCardnewsHttp({ blobs }); return { blobs, call: (body: any) => run(handler, { method: 'POST', headers: { 'x-sync-key': KEY }, body: { taskType: 'cardnews_ai_call', ...body } }) } }
const approveAi = async (call: any, req: any) => { const q = await call(req); assert.equal(q.status, 402, JSON.stringify(q.data)); return call({ ...req, approvalId: q.data.approval.approvalId, costApproved: true, approvedUsd: q.data.estimate.usd }) }

test('결함1 승인 범위: 견적은 실제 최대 호출 수·비용(PLAN 재호출·롱폼 분할 작성·이미지+QC)이고, 상한은 공급자 호출 직전에 강제된다', async () => {
  const q = (target: string, body: any, qc = false) => { const p = planAiCall(target, body, qc); return [p.calls, p.usd] }
  assert.deepEqual(q('story', { taskType: 'yasa_story_plan', input: {} }), [2, 0.1], 'PLAN is regenerated once when its structure check fails: 2 calls')
  assert.deepEqual(q('story', { taskType: 'longform_chapter', input: {} }), [1, 0.05])
  assert.deepEqual(q('claude-story', { input: { contentFormat: 'longform', targetMinutes: 20, chapterCount: 6 } }), [6, 1.8], 'split writing: one Claude call per chapter')
  assert.deepEqual(q('claude-story', { input: { contentFormat: 'longform', targetMinutes: 10, chapterCount: 5 } }), [1, 0.3])
  assert.deepEqual(q('claude-story', { mode: 'chapter', input: { targetMinutes: 30, chapterCount: 10 } }), [1, 0.3])
  assert.deepEqual(q('claude-story', { input: { contentFormat: 'shorts' } }), [1, 0.3])
  assert.deepEqual(q('image', imageBody(), true), [2, 0.077], 'image + automatic QC')
  assert.equal(maxProviderCalls('claude-story', { input: { contentFormat: 'longform', targetMinutes: 30, chapterCount: 10 } }), 10)
  // enforcement at the provider boundary: the approved number of calls is the most that ever leaves the server
  let reached = 0; const old = globalThis.fetch; globalThis.fetch = (async () => { reached++; return new Response('{}') }) as typeof fetch
  try {
    let blocked = 0
    const { used } = await withCallBudget(2, async () => { for (let i = 0; i < 5; i++) { try { await fetch('https://api.example.invalid/x') } catch (e) { if (e instanceof CallLimitError) blocked++ } } })
    assert.equal(reached, 2); assert.equal(used, 2); assert.equal(blocked, 3, 'calls beyond the approved cap never reach the provider')
    const none = await withCallBudget(3, async () => 'no provider call'); assert.equal(none.used, 0)
  } finally { globalThis.fetch = old }
})

test('결함2 실패 분류: 공급자 호출이 나간 뒤의 실패는 자동 재과금 차단(정확히 1회), 호출 전 거절만 새 승인으로 재시도', async () => {
  await withProviders(() => new Response('{"error":{"message":"bad request"}}', { status: 400 }), async (calls) => {
    const { call } = aiHttp(), req = { target: 'image', body: imageBody('A prompt the provider will reject with a client error, no text at all') }
    const first = await approveAi(call, req); assert.ok(first.status >= 400); assert.equal(calls.length, 1)
    const again = await call(req); assert.equal(again.status, 409); assert.equal(again.data.error.code, 'AI_STATE_UNKNOWN'); assert.equal(calls.length, 1, 'provider 4xx after the call went out is NOT failed_safe')
  })
  await withProviders(() => { throw new Error('provider must not be called') }, async (calls) => {
    const { call } = aiHttp(), req = { target: 'gpt-image-qc', body: { input: {} } }
    assert.equal((await approveAi(call, req)).status, 400); assert.equal((await call(req)).status, 402, 'rejected before the provider: may be approved again'); assert.equal(calls.length, 0)
  })
})

test('결함3 불완전 200·서버 결과 저장 실패는 성공이 아니고 자동으로 다시 호출하지 않는다', async () => {
  for (const out of [{}, { image: {} }, { image: { base64: '' } }]) assert.equal(isComplete('image', out), false)
  assert.equal(isComplete('claude-story', { ok: true }), false); assert.equal(isComplete('gpt-image-qc', {}), false); assert.equal(isComplete('gpt-script-qc', { ok: true }), false)
  assert.equal(isComplete('claude-longform-revise', { ok: true, draft: {} }), true); assert.equal(isComplete('image', { image: { base64: 'AAAA' } }), true)
  // a 200 from the provider without an image: the handler fails it; nothing is stored as a success and nothing repeats by itself
  await withProviders(() => new Response(JSON.stringify({ output_image: { data: '' } })), async (calls) => {
    const { call } = aiHttp(), req = { target: 'image', body: imageBody('A prompt whose provider answer comes back without any picture, no text') }
    const first = await approveAi(call, req); assert.notEqual(first.status, 200); assert.equal(calls.length, 1)
    assert.equal((await call(req)).data.error.code, 'AI_STATE_UNKNOWN'); assert.equal(calls.length, 1)
  })
  // the result cannot be stored on the server: not a normal success, and the paid call is never repeated automatically
  const blobs: any = createMemoryBlobStore(), put = blobs.putBytes.bind(blobs)
  blobs.putBytes = async (path: string, ...rest: any[]) => { if (String(path).startsWith('ai-results/')) throw new Error('store down'); return (put as any)(path, ...rest) }
  await withProviders(() => gemini(), async (calls) => {
    const { call } = aiHttp(blobs), req = { target: 'image', body: imageBody('A prompt whose result the server cannot store afterwards, no text inside') }
    const r = await approveAi(call, req); assert.equal(r.status, 502); assert.equal(r.data.error.code, 'AI_RESULT_NOT_SAVED'); assert.equal(r.data.image, undefined); assert.equal(calls.length, 1)
    const again = await call(req); assert.equal(again.status, 409); assert.equal(again.data.error.code, 'AI_STATE_UNKNOWN'); assert.equal(calls.length, 1)
  })
})

test('결함4 일반 이미지 경로는 MASTER·썸네일·카드뉴스 전용 프로필·요청을 만들 수 없다(공급자 호출 0회)', async () => {
  await withProviders(() => { throw new Error('provider must not be called') }, async (calls) => {
    const { call } = aiHttp()
    for (const profile of ['master-shorts', 'master-longform', ' Master-Shorts ', 'THUMBNAIL-SHORTS', 'thumbnail-longform', 'cardnews', 'Cardnews']) {
      const r = await call({ target: 'image', body: { input: { ...imageBody().input, profile, aspectRatio: profile.toLowerCase().includes('long') ? '16:9' : '9:16' } } })
      assert.equal(r.status, 400, profile)
    }
    assert.equal(calls.length, 0)
    assert.equal((await call({ target: 'image', body: imageBody() })).status, 402, 'an ordinary profile still goes through the approval path')
  })
})

test('일반 CUT 일괄: 장면 목록·최대 장수·총액을 한 번 승인하고 서버가 슬롯·상한을 강제(이미지+검수 장면당 정확히 2회 호출)', async () => {
  await withProviders((url) => url.includes('openai') ? new Response('{"error":"qc down"}', { status: 500 }) : gemini(), async (calls) => {
    const { call } = aiHttp(), unit = 0.077
    const batch = { id: 'cutbatch12345', projectId: 'ep-1', scenes: ['scene-01', 'scene-02'], limitUsd: 0.154 }
    const mk = (sceneId: string, prompt: string, b: any = batch) => ({ target: 'image', sceneId, batch: b, qc: { prompt, context: {} }, body: imageBody(prompt) })
    assert.equal((await call(mk('scene-01', 'First batch scene prompt for the cut image batch test, no text', { ...batch, limitUsd: 0.2 }))).status, 402, 'wrong total refused before any approval/provider call')
    assert.equal((await call(mk('scene-03', 'Third scene is not part of the approved batch scene list, no text', batch))).status, 402)
    assert.equal(calls.length, 0)
    const quote = await call(mk('scene-01', 'First batch scene prompt for the cut image batch test, no text')); assert.equal(quote.status, 402); assert.ok(Math.abs(quote.data.estimate.usd - unit) < 1e-9)
    const a = await call({ ...mk('scene-01', 'First batch scene prompt for the cut image batch test, no text'), approvalId: quote.data.approval.approvalId, costApproved: true, approvedUsd: quote.data.estimate.usd })
    assert.equal(a.status, 200); assert.equal(calls.length, 2, 'scene 1 = exactly one image call + one QC call')
    const b = await approveAi(call, mk('scene-02', 'Second batch scene prompt for the cut image batch test, no text')); assert.equal(b.status, 200); assert.equal(calls.length, 4)
    // a second, different request for an already-reserved scene gets no slot and no provider call
    const dup = await approveAi(call, mk('scene-01', 'A different prompt for the same reserved scene must not bill again, no text')); assert.equal(dup.status, 402); assert.equal(calls.length, 4)
  })
})

test('결함5 voicePreview: HIT 무료, MISS는 서버 견적·승인 후 정확히 1회, 동시·재시도·저장소 오류·불명 상태에서 자동 호출 없음', async () => {
  const mkPreview = (blobs: any, tts: () => Promise<any>) => createJobsHttp({ getStore: async () => { throw new Error('no db') }, blobs, voicePreview: createVoicePreview({ blobs, tts, apiKey: () => 'k', log: () => {} }) })
  const post = (handler: any, body: any) => run(handler, { method: 'POST', headers: { 'x-sync-key': KEY }, query: {}, body: { taskType: 'longform_voice_preview', voiceProfile: 'female-middle', voiceTone: 'calm', voiceSpeed: 1, ...body } })
  const approvedPost = async (handler: any, body: any = {}) => { const q = await post(handler, body); assert.equal(q.status, 402, JSON.stringify(q.data)); return post(handler, { ...body, approvalId: q.data.approval.approvalId, costApproved: true, approvedUsd: q.data.estimate.usd }) }
  // workspace auth is kept
  { const blobs: any = createMemoryBlobStore(); let n = 0; const h = mkPreviewHandler(blobs, async () => { n++; return { bytes: Buffer.from('ID3x'), contentType: 'audio/mpeg' } })
    assert.equal((await run(h, { method: 'POST', headers: {}, query: {}, body: { taskType: 'longform_voice_preview' } })).status, 401); assert.equal(n, 0) }
  function mkPreviewHandler(blobs: any, tts: () => Promise<any>) { return mkPreview(blobs, tts) }
  // MISS: quote (0 calls) → approved (1 call) → same again is a free HIT; a concurrent double click makes ONE call
  { const blobs: any = createMemoryBlobStore(); let n = 0; const h = mkPreview(blobs, async () => { n++; return { bytes: Buffer.from('ID3x'), contentType: 'audio/mpeg' } })
    const quote = await post(h, {}); assert.equal(quote.status, 402); assert.equal(n, 0)
    const ap = { approvalId: quote.data.approval.approvalId, costApproved: true, approvedUsd: quote.data.estimate.usd }
    const [x, y] = await Promise.all([post(h, ap), post(h, ap)]); assert.ok([x.status, y.status].every((c) => c === 200 || c === 409)); assert.ok([x.status, y.status].includes(200)); assert.equal(n, 1)
    const hit = await post(h, {}); assert.equal(hit.status, 200); assert.equal(hit.data.cache, 'HIT'); assert.equal(n, 1) }
  // cache read error: not a MISS → no provider call
  { const blobs: any = createMemoryBlobStore(); const get = blobs.getJson.bind(blobs); blobs.getJson = async (p: string) => { if (String(p).startsWith('voice-preview/')) throw new Error('read failed'); return get(p) }
    let n = 0; const h = mkPreview(blobs, async () => { n++; return { bytes: Buffer.from('ID3x'), contentType: 'audio/mpeg' } })
    const r = await post(h, {}); assert.ok(r.status >= 400 && r.status !== 402); assert.equal(n, 0) }
  // provider answer lost (transient error): the same preview is NOT regenerated automatically — exactly one call
  { const blobs: any = createMemoryBlobStore(); let n = 0; const h = mkPreview(blobs, async () => { n++; throw new Error('OpenAI TTS failed 503: upstream') })
    const first = await approvedPost(h); assert.ok(first.status >= 400); assert.equal(n, 1)
    const again = await post(h, {}); assert.equal(again.status, 409); assert.equal(again.data.error.code, 'PREVIEW_STATE_UNKNOWN'); assert.equal(n, 1) }
  // billed but the audio cannot be stored: never reported as a success, never repeated automatically
  { const blobs: any = createMemoryBlobStore(); const put = blobs.putBytes.bind(blobs); blobs.putBytes = async (p: string, ...r: any[]) => { if (String(p).startsWith('voice-preview/')) throw new Error('store down'); return (put as any)(p, ...r) }
    let n = 0; const h = mkPreview(blobs, async () => { n++; return { bytes: Buffer.from('ID3x'), contentType: 'audio/mpeg' } })
    const r = await approvedPost(h); assert.ok(r.status >= 400); assert.equal(n, 1); assert.equal((await post(h, {})).data.error.code, 'PREVIEW_STATE_UNKNOWN'); assert.equal(n, 1) }
})

test('경제 V4/V5·벤치마크: 신규 유료 생성은 차단 유지, 기존 조회(GET 진단·헬스)는 막지 않는다', async () => {
  await withProviders(() => { throw new Error('provider must not be called') }, async (calls) => {
    const post = (body: any) => run(imageHandler, { method: 'POST', headers: {}, query: {}, body })
    assert.equal((await post({ contractVersion: '1.5', taskType: 'cut_image', input: { prompt: 'Economy V5 scene pack direct generation attempt', aspectRatio: '16:9', imageSize: '1K', cutIndex: 3, references: [], profile: 'economy-longform-v01' } })).status, 403)
    assert.equal((await post({ input: { prompt: 'benchmark clone generation attempt through the public image endpoint', aspectRatio: '16:9', cutIndex: 0, references: [], profile: 'benchmark' } })).status, 403)
    assert.equal(calls.length, 0)
    const get = await run(imageHandler, { method: 'GET', headers: {}, query: {}, body: {} }); assert.notEqual(get.status, 403, 'read-only GET is not gated')
    const health = await run(claudeRevise, { method: 'GET', headers: {}, query: {}, body: {} }); assert.notEqual(health.status, 403)
  })
})
