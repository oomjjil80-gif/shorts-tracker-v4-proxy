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
import { planAiCall, maxProviderCalls, isComplete, AI_CALL_TARGETS } from '../lib/generative/paidAiCall.js'
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
  assert.equal(isComplete('claude-longform-revise', { ok: true, draft: { chapters: [{ chapterNo: 1 }] } }), true); assert.equal(isComplete('image', { image: { base64: 'AAAA' } }), true)
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
    const mk = (sceneId: string, prompt: string, b: any = batch) => ({ target: 'image', sceneId, batch: b, qc: { prompt, context: {} }, body: { input: { ...imageBody(prompt).input, cutIndex: Number(sceneId.slice(6)) - 1 } } })
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

test('결함5 voicePreview: 어떤 키(미등록·임의 문자열 포함)로도 캐시 미스의 유료 생성은 견적·승인·공급자 호출 0회로 차단, 캐시 HIT만 무료 — 모듈의 공유 claim·캐시 복구는 유지', async () => {
  const voice = { voiceProfile: 'female-middle', voiceTone: 'calm', voiceSpeed: 1 }
  const post = (handler: any, key: string, body: any = {}) => run(handler, { method: 'POST', headers: { 'x-sync-key': key }, query: {}, body: { taskType: 'job_voice_preview', ...voice, ...body } })
  // HTTP route: every key, both request shapes
  { const blobs: any = createMemoryBlobStore(); let n = 0
    const preview = createVoicePreview({ blobs, tts: async () => { n++; return { bytes: Buffer.from('ID3x'), contentType: 'audio/mpeg' } }, apiKey: () => 'k', log: () => {} })
    const h = createJobsHttp({ getStore: async () => { throw new Error('no db') }, blobs, voicePreview: preview })
    for (const key of ['unregistered-workspace-key-0123456789', 'a'.repeat(40), 'x'.repeat(24), KEY]) for (const taskType of ['job_voice_preview', 'longform_voice_preview']) {
      const r = await post(h, key, { taskType }); assert.equal(r.status, 403, `${key}/${taskType}`); assert.equal(r.data.error.code, 'VOICE_PREVIEW_UNAVAILABLE'); assert.equal(r.data.approval, undefined, 'no approval is even offered')
    }
    assert.equal(n, 0, 'provider calls: 0'); assert.deepEqual([...blobs.files.keys(), ...blobs.binaries.keys()].filter((k: string) => /paid-approvals|ai-spend|voice-preview/.test(k)), [], 'no approval/ledger/preview record created')
    assert.equal((await run(h, { method: 'POST', headers: {}, query: {}, body: { taskType: 'job_voice_preview', ...voice } })).status, 401, 'no key at all: still unauthenticated')
    await preview(voice); assert.equal(n, 1) // warmed outside the route
    const hit = await post(h, 'unregistered-workspace-key-0123456789'); assert.equal(hit.status, 200); assert.equal(hit.data.cache, 'HIT'); assert.equal(n, 1, 'a cached preview is free') }
  // module: concurrent identical previews → one provider call; cache read error → no call; transient failure → not repeated; billed-but-unsaved → not repeated
  const mk = (blobs: any, tts: () => Promise<any>) => createVoicePreview({ blobs, tts, apiKey: () => 'k', log: () => {} })
  { const blobs: any = createMemoryBlobStore(); let n = 0; const p = mk(blobs, async () => { n++; return { bytes: Buffer.from('ID3x'), contentType: 'audio/mpeg' } })
    await Promise.all([p(voice), p(voice)]); assert.equal(n, 1) }
  { const blobs: any = createMemoryBlobStore(); const get = blobs.getJson.bind(blobs); blobs.getJson = async (path: string) => { if (String(path).startsWith('voice-preview/')) throw new Error('read failed'); return get(path) }
    let n = 0; const p = mk(blobs, async () => { n++; return { bytes: Buffer.from('ID3x'), contentType: 'audio/mpeg' } })
    await assert.rejects(p(voice)); assert.equal(n, 0) }
  { const blobs: any = createMemoryBlobStore(); let n = 0; const p = mk(blobs, async () => { n++; throw new Error('OpenAI TTS failed 503: upstream') })
    await assert.rejects(p(voice)); assert.equal(n, 1); await assert.rejects(p(voice), (e: any) => e.code === 'PREVIEW_STATE_UNKNOWN'); assert.equal(n, 1) }
  { const blobs: any = createMemoryBlobStore(); const put = blobs.putBytes.bind(blobs); blobs.putBytes = async (path: string, ...r: any[]) => { if (String(path).startsWith('voice-preview/')) throw new Error('store down'); return (put as any)(path, ...r) }
    let n = 0; const p = mk(blobs, async () => { n++; return { bytes: Buffer.from('ID3x'), contentType: 'audio/mpeg' } })
    await assert.rejects(p(voice)); assert.equal(n, 1); await assert.rejects(p(voice), (e: any) => e.code === 'PREVIEW_STATE_UNKNOWN'); assert.equal(n, 1) }
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

// ── D-2 잔여 결함 재현(실제 실행 경로, 공급자 호출 횟수 정확히 단언) ──
const aiCallWith = (blobs: any, key = KEY) => { const handler = createCardnewsHttp({ blobs }); return (body: any) => run(handler, { method: 'POST', headers: { 'x-sync-key': key }, body: { taskType: 'cardnews_ai_call', ...body } }) }

test('정상 응답 manual_required: 공급자 호출 없이 정상 계약 그대로 돌려주고(수동 수정 안내), 불완전 응답으로 오인하지 않는다', async () => {
  await withProviders(() => { throw new Error('provider must not be called') }, async (calls) => {
    const call = aiCallWith(createMemoryBlobStore())
    const unmappable = { draft: { title: 't', chapters: [] }, qc: { status: 'revision_required', issues: [{ severity: 'required', location: 'overall', problem: 'cannot be mapped to a segment' }] } }
    for (const [target, body] of [['gpt-script-qc', { mode: 'revise_partial', input: unmappable }], ['claude-longform-revise', { input: { ...unmappable, partial: true } }]] as const) {
      const r = await approveAi(call, { target, body })
      assert.equal(r.status, 200, target); assert.equal(r.data.scope, 'manual_required', target); assert.equal(r.data.ok, true); assert.ok(r.data.reason)
      assert.equal(isComplete(target, { ok: true, scope: 'manual_required', reason: 'x' }), true)
    }
    assert.equal(calls.length, 0, 'no provider call for a manual_required answer')
    const again = await call({ target: 'gpt-script-qc', body: { mode: 'revise_partial', input: unmappable } }); assert.equal(again.status, 200); assert.equal(again.data.recovered, true); assert.equal(again.data.scope, 'manual_required')
  })
})

test('서버 저장: 결과 파일과 복구 기록이 모두 저장돼야 성공 — 기록 저장만 실패해도 정상 성공 금지, 같은 요청은 결과 파일부터 복구(추가 호출 0)', async () => {
  const blobs: any = createMemoryBlobStore(), putJson = blobs.putJson.bind(blobs)
  let failRecord = true
  blobs.putJson = async (path: string, ...rest: any[]) => { if (failRecord && /ai-flight\/.*\.result\.json$/.test(String(path))) throw new Error('record store down'); return (putJson as any)(path, ...rest) }
  await withProviders(() => gemini(), async (calls) => {
    const call = aiCallWith(blobs), req = { target: 'image', body: imageBody('A prompt whose recovery record cannot be written the first time, no text') }
    const first = await approveAi(call, req); assert.equal(first.status, 502); assert.equal(first.data.error.code, 'AI_RESULT_NOT_SAVED'); assert.equal(first.data.image, undefined); assert.equal(calls.length, 1)
    failRecord = false
    const again = await call(req); assert.equal(again.status, 200); assert.equal(again.data.recovered, true); assert.ok(again.data.image.base64); assert.equal(calls.length, 1, 'recovered from the stored result file: no second provider call')
  })
  // an unreadable stored result is never a success
  const bad: any = createMemoryBlobStore()
  await withProviders(() => gemini(), async (calls) => {
    const call = aiCallWith(bad), req = { target: 'image', body: imageBody('A prompt whose stored result file gets corrupted afterwards, no text inside') }
    assert.equal((await approveAi(call, req)).status, 200); assert.equal(calls.length, 1)
    for (const k of [...bad.binaries.keys()]) if (String(k).startsWith('ai-results/')) bad.binaries.set(k, Buffer.from('{not json'))
    const r = await call(req); assert.equal(r.status, 409); assert.equal(r.data.error.code, 'AI_STATE_UNKNOWN'); assert.equal(calls.length, 1)
  })
})

test('대본 일괄 승인: 프로젝트·작업 유형·누적 견적 상한을 서버가 강제(다른 프로젝트·이미지 작업·상한 초과는 공급자 호출 0회)', async () => {
  await withProviders(() => new Response('{"error":{"message":"overloaded"}}', { status: 529 }), async (calls) => {
    const call = aiCallWith(createMemoryBlobStore())
    const batch = { id: 'scriptbatch-0001', kind: 'script', projectId: 'ep-1', limitUsd: 0.5 }
    const story = (title: string, extra: any = {}) => ({ target: 'claude-story', projectId: 'ep-1', scriptBatch: batch, body: { input: { title, targetMinutes: 10, chapterCount: 5 } }, ...extra })
    const a = await approveAi(call, story('first')); assert.ok(a.status >= 400 && a.status !== 402, 'reserved 0.30 of 0.50 and the (mock) provider was called once'); assert.equal(calls.length, 1)
    const over = await approveAi(call, story('second')); assert.equal(over.status, 402); assert.equal(over.data.error.code, 'BATCH_LIMIT_EXCEEDED'); assert.equal(calls.length, 1, 'cumulative cap exceeded: no provider call')
    const cheap = await approveAi(call, { target: 'gpt-script-qc', projectId: 'ep-1', scriptBatch: batch, body: { mode: 'revise_partial', input: { draft: { chapters: [] }, qc: { status: 'revision_required', issues: [{ severity: 'required', location: 'overall', problem: 'x' }] } } } })
    assert.equal(cheap.status, 200, 'a 0.05 job still fits in the remaining 0.20'); assert.equal(calls.length, 1)
    // another project can neither reuse this batch id nor pass its own project id through it
    assert.equal((await call(story('third', { projectId: 'ep-2' }))).status, 402); assert.equal((await call(story('fourth', { scriptBatch: { ...batch, projectId: 'ep-2' }, projectId: 'ep-2' }))).status, 402)
    // an image job can never use a script batch; a script job can never use an image batch
    assert.equal((await call({ target: 'image', projectId: 'ep-1', scriptBatch: batch, body: imageBody() })).status, 400)
    assert.equal((await call({ target: 'claude-story', batch: { id: 'cutbatch12345', projectId: 'ep-1', scenes: ['scene-01'], limitUsd: 0.077 }, sceneId: 'scene-01', body: { input: {} } })).status, 400)
    assert.equal((await call(story('fifth', { scriptBatch: { ...batch, limitUsd: 0 } }))).status, 402)
    assert.equal(calls.length, 1)
  })
})

test('이미지 승인 범위: cutIndex -1(숫자·문자열) 차단, 승인된 sceneId와 실제 CUT 번호·요청 불일치는 공급자 호출 0회', async () => {
  await withProviders(() => gemini(), async (calls) => {
    const call = aiCallWith(createMemoryBlobStore())
    for (const ci of [-1, '-1', -1.0]) assert.equal((await call({ target: 'image', body: { input: { ...imageBody().input, cutIndex: ci } } })).status, 400, String(ci))
    const batch = { id: 'cutbatch67890', projectId: 'ep-3', scenes: ['scene-01', 'scene-02'], limitUsd: 0.154 }
    const mk = (sceneId: string, cutIndex: any, prompt: string) => ({ target: 'image', sceneId, batch, qc: { prompt, context: {} }, body: { input: { ...imageBody(prompt).input, cutIndex } } })
    for (const [sceneId, cut] of [['scene-02', 0], ['scene-01', 1], ['scene-01', '0'], ['scene-01', 0.5], ['scene-01', -1]] as const) { const r = await call(mk(sceneId, cut, 'Prompt for the scene/cut consistency check, no text inside')); assert.ok(r.status === 402 || r.status === 400, `${sceneId}/${cut} → ${r.status}`); assert.ok(r.data.error.code === 'BATCH_LIMIT_EXCEEDED' || r.data.error.code === 'BAD_REQUEST') }
    assert.equal(calls.length, 0)
    assert.equal((await approveAi(call, mk('scene-02', 1, 'Matching scene 2 and CUT index 1 passes the approved scope, no text'))).status, 200); assert.equal(calls.filter((u) => !u.includes('openai')).length, 1)
  })
})

test('유료 승인 경로(cardnews_ai_call)는 길이만 맞춘 반복 키를 받지 않는다(워크스페이스 소유 검증이 아니라 최소 강도 확인)', async () => {
  await withProviders(() => { throw new Error('provider must not be called') }, async (calls) => {
    assert.equal((await aiCallWith(createMemoryBlobStore(), 'a'.repeat(40))({ target: 'image', body: imageBody() })).status, 401)
    assert.equal(calls.length, 0)
  })
})

test('작업 유형별 정상 응답 계약: {"ok":true}만 있는 200은 성공이 아니고(서버 실제 경로), 호출은 정확히 1회·자동 재호출 없음, manual_required는 계속 정상', async () => {
  const targets: Array<[string, any]> = [['claude-story', { input: { title: 't', targetMinutes: 10, chapterCount: 5 } }], ['claude-longform-revise', { input: { partial: true, draft: { chapters: [] }, qc: { status: 'revision_required', issues: [] } } }],
    ['gpt-script-qc', { input: { handoff: {}, draft: {} } }], ['gpt-script-qc', { mode: 'finalize', input: { draft: { chapters: [] } } }], ['story', { taskType: 'yasa_story_plan', input: { topic: 't' } }],
    ['story', { taskType: 'longform_chapter', input: {} }], ['story', { taskType: 'visual_director', input: {} }], ['story', { taskType: 'story_draft', input: { topic: 't' } }], ['story', { input: { topic: 't' } }]]
  for (const [target, body] of targets) {
    const spec = AI_CALL_TARGETS[target], realLoad = spec.load
    let provider = 0
    spec.load = async () => ({ default: async (_req: any, res: any) => { provider++; await fetch('https://api.example.invalid/provider'); res.status(200).json({ ok: true }) } })
    try {
      await withProviders(() => new Response('{}'), async () => {
        const call = aiCallWith(createMemoryBlobStore()), req = { target, body: { ...body, marker: `${target}-${body.taskType ?? body.mode ?? 'x'}` } }
        const first = await approveAi(call, req); assert.equal(first.status, 502, `${target}/${body.taskType ?? body.mode}`); assert.equal(first.data.error.code, 'AI_RESULT_INVALID'); assert.equal(provider, 1)
        const again = await call(req); assert.equal(again.status, 409); assert.equal(again.data.error.code, 'AI_STATE_UNKNOWN'); assert.equal(provider, 1, 'not repeated automatically')
      })
    } finally { spec.load = realLoad }
  }
  // a complete answer per task type is accepted
  const chapters = { chapters: [{ chapterNo: 1 }] }
  for (const [target, out, body] of [['claude-story', { ok: true, draft: chapters }, {}], ['claude-story', { ok: true, text: 'hi' }, { test: true }], ['claude-longform-revise', { ok: true, draft: chapters }, {}], ['gpt-script-qc', { ok: true, qc: { status: 'approved' } }, {}],
    ['gpt-script-qc', { ok: true, draft: chapters }, { mode: 'revise' }], ['story', { ok: true, dna: { title: 't' } }, { taskType: 'yasa_story_plan' }], ['story', { ok: true, draft: chapters }, { taskType: 'longform_chapter' }],
    ['story', { ok: true, plan: { cuts: [{}] } }, { taskType: 'visual_director' }], ['story', { draft: { cuts: [{}] }, meta: {} }, { taskType: 'story_draft' }]] as const) assert.equal(isComplete(target, out, body), true, `${target}/${JSON.stringify(body)}`)
  for (const [target, body] of [['claude-story', {}], ['claude-longform-revise', {}], ['gpt-script-qc', {}], ['gpt-script-qc', { mode: 'revise' }], ['story', { taskType: 'yasa_story_plan' }], ['story', { taskType: 'longform_chapter' }], ['story', { taskType: 'visual_director' }], ['story', { taskType: 'story_draft' }], ['story', {}]] as const)
    assert.equal(isComplete(target, { ok: true }, body), false, `${target}/${JSON.stringify(body)}`)
  assert.equal(isComplete('gpt-script-qc', { ok: true, scope: 'manual_required', reason: 'x' }, { mode: 'revise_partial' }), true)
})
