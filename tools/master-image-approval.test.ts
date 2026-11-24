import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import imageHandler from '../api/image.js'

// No network calls or paid usage: provider is replaced by an in-memory fetch mock.
test('MASTER 16:9: reference bytes, quote, one-time approval, no TTS or render', async () => {
  const handler = createCardnewsHttp({ blobs: createMemoryBlobStore() })
  const key = 'master-image-test-workspace-key-12345'
  const call = async (body: any) => {
    let status = 0, data: any
    // Express/Node can expose headers through a prototype getter, not an own enumerable field.
    const req = Object.assign(Object.create({ get headers() { return { 'x-sync-key': key, origin: 'https://shorts-production-tracker.vercel.app' } } }), { method: 'POST', body })
    await handler(req as any,
      { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { data = v; return this } } as any)
    return { status, data }
  }
  const reference = Buffer.from('reference storyboard bytes for scene layout and character consistency'.repeat(3)).toString('base64')
  const body = { taskType: 'cardnews_master_image_generate', sceneId: 'scene-01',
    imageInput: { profile: 'master-longform', aspectRatio: '16:9',
      prompt: 'A cinematic illustrated cheese workshop scene with no identity reveal; approved scene 01',
      references: [{ data: reference, mimeType: 'image/png' }] } }
  let calls = 0
  const oldFetch = globalThis.fetch, oldKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'mock-free-test-key'
  globalThis.fetch = (async (_url: any, init: any) => {
    const payload = JSON.parse(init.body)
    assert.equal(payload.response_format[0].aspect_ratio, '16:9')
    assert.equal(payload.input[1].type, 'image')
    assert.equal(payload.input[1].data, reference)
    calls++
    return new Response(JSON.stringify({ output_image: { data: Buffer.from('fake-image').toString('base64'), mime_type: 'image/png' } }))
  }) as typeof fetch
  try {
    assert.equal((await call({ ...body, imageInput: { ...body.imageInput, aspectRatio: '9:16' } })).status, 400, '9:16 needs the shorts profile')
    assert.equal((await call({ ...body, sceneId: 'scene-00' })).status, 400)
    assert.equal((await call({ ...body, sceneId: 'scene-100' })).status, 400)
    assert.equal((await call({ ...body, imageInput: { ...body.imageInput, aspectRatio: '4:5' } })).status, 400)
    assert.equal(calls, 0)
    const quote = await call(body)
    assert.equal(quote.status, 402)
    assert.equal(calls, 0)
    const approved = { ...body, approvalId: quote.data.approval.approvalId, costApproved: true, approvedUsd: quote.data.estimate.usd }
    const generated = await call(approved)
    assert.equal(generated.status, 200)
    assert.equal(generated.data.image.mimeType, 'image/png')
    assert.equal(calls, 1)
    // 같은 요청을 다시 보내면(응답 유실 후 재시도) 저장된 결과를 승인·과금 없이 복구한다
    const replay = await call(approved)
    assert.equal(replay.status, 200); assert.equal(replay.data.recovered, true); assert.equal(replay.data.image.base64, generated.data.image.base64)
    assert.equal(calls, 1)
    const next = await call({ ...body, sceneId: 'scene-02' })
    assert.equal(next.status, 402)
    assert.equal(calls, 1)
    // Profile cannot bypass approval through the public image endpoint.
    let directStatus = 0
    await imageHandler({ method: 'POST', headers: {}, body: { input: body.imageInput } } as any,
      { setHeader() {}, status(s: number) { directStatus = s; return this }, json() { return this } } as any)
    assert.equal(directStatus, 403)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = oldFetch
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = oldKey
  }
})

// 공통 MASTER 생성: 쇼츠 9:16(master-shorts)과 참고 이미지 없는 장면도 같은 승인·Ledger 경로. 유료 호출 0(모의).
test('MASTER 9:16 shorts and no-reference scenes use the same single-use approval path', async () => {
  const handler = createCardnewsHttp({ blobs: createMemoryBlobStore() })
  const call = async (body: any) => {
    let status = 0, data: any
    await handler({ method: 'POST', headers: { 'x-sync-key': 'master-image-test-workspace-key-67890' }, body } as any,
      { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { data = v; return this } } as any)
    return { status, data }
  }
  const reference = Buffer.from('storyboard panel bytes for one shorts scene'.repeat(4)).toString('base64')
  const shorts = { taskType: 'cardnews_master_image_generate', sceneId: 'scene-02',
    imageInput: { profile: 'master-shorts', aspectRatio: '9:16', prompt: 'Approved scene 02 prompt for a vertical shorts MASTER image', references: [{ data: reference, mimeType: 'image/png' }] } }
  const sent: any[] = []
  const oldFetch = globalThis.fetch, oldKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'mock-free-test-key'
  globalThis.fetch = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ output_image: { data: Buffer.from('fake').toString('base64'), mime_type: 'image/png' } })) }) as typeof fetch
  const run = async (body: any) => { const q = await call(body); assert.equal(q.status, 402, JSON.stringify(q.data)); return call({ ...body, approvalId: q.data.approval.approvalId, costApproved: true, approvedUsd: q.data.estimate.usd }) }
  try {
    assert.equal((await call({ ...shorts, imageInput: { ...shorts.imageInput, aspectRatio: '16:9' } })).status, 400, 'profile and ratio must match')
    assert.equal(sent.length, 0)
    assert.equal((await run(shorts)).status, 200)
    assert.equal(sent[0].response_format[0].aspect_ratio, '9:16')
    assert.equal(sent[0].input[1].data, reference, 'the scene panel is a real image input')
    const noRef = { ...shorts, sceneId: 'scene-03', imageInput: { ...shorts.imageInput, prompt: 'Approved scene 03 prompt without any storyboard reference', references: [] } }
    assert.equal((await run(noRef)).status, 200)
    assert.equal(sent.length, 2)
    assert.equal(sent[1].input.length, 1, 'no reference → text-only request')
    let direct = 0
    await imageHandler({ method: 'POST', headers: {}, body: { input: shorts.imageInput } } as any, { setHeader() {}, status(s: number) { direct = s; return this }, json() { return this } } as any)
    assert.equal(direct, 403, 'master-shorts cannot bypass approval')
    assert.equal(sent.length, 2)
  } finally {
    globalThis.fetch = oldFetch
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = oldKey
  }
})

// ── 과금 안전성: 승인 의사·금액 검증과 일괄 한도(서버 원자적 예약). 공급자는 메모리 mock, 유료 호출 없음 ──
test('MASTER 이미지: 승인 의사·금액이 올바르지 않으면 호출 0회, 일괄 한도는 동시 요청에서도 승인 장수를 넘지 못하고, 단일 재생성은 유지', async () => {
  const blobs = createMemoryBlobStore(), handler = createCardnewsHttp({ blobs })
  const key = 'master-batch-test-workspace-key-12345'
  const call = async (body: any) => {
    let status = 0, data: any
    const req = Object.assign(Object.create({ get headers() { return { 'x-sync-key': key, origin: 'https://shorts-production-tracker.vercel.app' } } }), { method: 'POST', body })
    await handler(req as any, { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { data = v; return this } } as any)
    return { status, data }
  }
  const scene = (n: number, extra: any = {}) => ({ taskType: 'cardnews_master_image_generate', sceneId: `scene-${String(n).padStart(2, '0')}`,
    imageInput: { profile: 'master-longform', aspectRatio: '16:9', prompt: `A cinematic illustrated scene number ${n}, approved by the user for production`, references: [] }, ...extra })
  // the real client's two steps; `consent` is what the user's confirmation puts in the second request
  const approve = async (body: any, consent: any = (e: any) => ({ costApproved: true, approvedUsd: e.usd })) => {
    const q = await call(body); assert.equal(q.status, 402); assert.equal(q.data.error.code, 'COST_APPROVAL_REQUIRED')
    return call({ ...body, approvalId: q.data.approval.approvalId, ...consent(q.data.estimate) })
  }
  let providerCalls = 0
  const oldFetch = globalThis.fetch, oldKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'mock-free-test-key'
  globalThis.fetch = (async () => { providerCalls++; await new Promise((r) => setTimeout(r, 5)); return new Response(JSON.stringify({ output_image: { data: Buffer.from('fake-image').toString('base64'), mime_type: 'image/png' } })) }) as typeof fetch
  try {
    // 1) 승인 의사 false / 금액 0·음수·NaN·부족 → 유효한 승인 ID가 있어도 공급자 호출 0회
    for (const consent of [{ costApproved: false, approvedUsd: 0.067 }, { approvedUsd: 0.067 }, { costApproved: true }, { costApproved: true, approvedUsd: 0 }, { costApproved: true, approvedUsd: -1 }, { costApproved: true, approvedUsd: 'abc' }, { costApproved: true, approvedUsd: 0.01 }, { costApproved: 'true', approvedUsd: 1 }]) {
      const r = await approve(scene(1), () => consent)
      assert.equal(r.status, 402, JSON.stringify(consent)); assert.equal(r.data.error.code, 'COST_APPROVAL_REQUIRED')
    }
    assert.equal(providerCalls, 0)
    // 2) 일괄(2장 승인): 3번째는 슬롯이 없어 공급자 호출 없음, 단일 재생성(batch 없음)은 그대로 가능
    const batch = { id: 'batch-aaaa1111', count: 2, limitUsd: 0.134 }
    assert.equal((await approve(scene(1, { batch }))).status, 200)
    assert.equal((await approve(scene(2, { batch }))).status, 200); assert.equal(providerCalls, 2)
    const over = await approve(scene(3, { batch })); assert.equal(over.status, 402); assert.equal(over.data.error.code, 'BATCH_LIMIT_EXCEEDED'); assert.equal(providerCalls, 2)
    assert.equal((await approve(scene(2, { regenerate: 'regen-0001' }))).status, 200, 'a normal single scene regeneration is untouched'); assert.equal(providerCalls, 3)
    // 3) 같은 batch id에 다른 조건(한도 부풀리기)은 거절, 잘못된 batch 정보도 호출 없음
    for (const bad of [{ ...batch, limitUsd: 5 }, { ...batch, count: 50 }, { id: 'x', count: 1, limitUsd: 1 }, { id: 'batch-bbbb2222', count: 0, limitUsd: 1 }, { id: 'batch-cccc3333', count: 2, limitUsd: 0.01 }]) {
      const r = await approve(scene(4, { batch: bad })); assert.equal(r.data.error.code, 'BATCH_LIMIT_EXCEEDED', JSON.stringify(bad))
    }
    assert.equal(providerCalls, 3)
    // 4) 동시 요청: 장당 승인 1개씩 받은 6개를 동시에 보내도 승인된 3장(한도 0.201)만 호출
    const cb = { id: 'batch-dddd4444', count: 6, limitUsd: 0.201 }
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => approve(scene(n, { batch: cb, regenerate: `regen-b${n}` }))))
    assert.equal(results.filter((r) => r.status === 200).length, 3); assert.equal(results.filter((r) => r.data?.error?.code === 'BATCH_LIMIT_EXCEEDED').length, 3)
    assert.equal(providerCalls, 6)
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey }
})

// ── 이미지 응답 유실: 같은 요청은 저장된 결과를 복구하고, 처리 여부가 불명확하면 자동 재호출하지 않는다 (공급자는 mock) ──
test('MASTER 이미지: 응답 유실 후 재시도는 결과 복구(무과금), 불명확한 실패는 재호출 보류, 선택 재생성은 새 요청으로 유지', async () => {
  const mem: any = createMemoryBlobStore()
  const key = 'master-flight-test-workspace-key-12345'
  const mkCall = (blobs: any) => { const handler = createCardnewsHttp({ blobs }); return async (body: any) => {
    let status = 0, data: any
    const req = Object.assign(Object.create({ get headers() { return { 'x-sync-key': key, origin: 'https://shorts-production-tracker.vercel.app' } } }), { method: 'POST', body })
    await handler(req as any, { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { data = v; return this } } as any)
    return { status, data }
  } }
  const scene = (n: number, extra: any = {}) => ({ taskType: 'cardnews_master_image_generate', sceneId: `scene-${String(n).padStart(2, '0')}`,
    imageInput: { profile: 'master-shorts', aspectRatio: '9:16', prompt: `A cinematic illustrated vertical scene ${n}, approved for production by the user`, references: [] }, ...extra })
  const approve = async (call: any, body: any) => { const q = await call(body); if (q.status !== 402) return q; return call({ ...body, approvalId: q.data.approval.approvalId, costApproved: true, approvedUsd: q.data.estimate.usd }) }
  let providerCalls = 0, mode: 'ok' | 'lost' | 'error400' | 'error500' = 'ok'
  const oldFetch = globalThis.fetch, oldKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'mock-free-test-key'
  globalThis.fetch = (async () => {
    providerCalls++; await new Promise((r) => setTimeout(r, 10))
    if (mode === 'lost') throw new Error('socket hang up')
    if (mode === 'error400') return new Response(JSON.stringify({ error: { message: 'blocked' } }), { status: 400 })
    if (mode === 'error500') return new Response(JSON.stringify({ error: { message: 'upstream' } }), { status: 500 })
    return new Response(JSON.stringify({ output_image: { data: Buffer.from(`image-${providerCalls}`).toString('base64'), mime_type: 'image/png' } }))
  }) as typeof fetch
  try {
    const call = mkCall(mem)
    // 1) 응답 유실 후 재시도: 서버는 만들었지만 브라우저가 못 받음 → 같은 요청 재전송은 승인·과금 없이 저장본 복구
    const first = await approve(call, scene(1)); assert.equal(first.status, 200); assert.equal(providerCalls, 1)
    const direct = await call(scene(1)) // 승인 없이 그대로 보내도 결과가 있으면 복구(견적·승인 불필요)
    assert.equal(direct.status, 200); assert.equal(direct.data.recovered, true); assert.equal(direct.data.image.base64, first.data.image.base64); assert.equal(providerCalls, 1)
    const viaOtherInstance = await approve(mkCall(mem), scene(1)); assert.equal(viaOtherInstance.data.recovered, true); assert.equal(providerCalls, 1) // 다른 인스턴스
    // 2) 정상적인 선택 장면 재생성: regenerate 값이 다르면 새 요청 → 새 승인으로 새로 생성
    const regen = await approve(call, scene(1, { regenerate: 'regen-0001' })); assert.equal(regen.status, 200); assert.notEqual(regen.data.image.base64, first.data.image.base64); assert.equal(providerCalls, 2)
    // 3) 공급자가 오류로 답함(생성되지 않음이 확실): 새 시도 허용
    mode = 'error400'; const rej = await approve(call, scene(2)); assert.equal(rej.status, 400); assert.equal(providerCalls, 3)
    mode = 'ok'; assert.equal((await approve(call, scene(2))).status, 200); assert.equal(providerCalls, 4)
    mode = 'error500'; assert.equal((await approve(call, scene(3))).status, 500); mode = 'ok'; assert.equal((await approve(call, scene(3))).status, 200); assert.equal(providerCalls, 6)
    // 4) 공급자 응답 없음(연결 끊김·시간 초과): 이미 과금됐을 수 있어 같은 요청은 자동 재호출 보류(승인 소비 없음)
    mode = 'lost'; assert.equal((await approve(call, scene(4))).status, 500); assert.equal(providerCalls, 7)
    mode = 'ok'
    const held = await approve(call, scene(4)); assert.equal(held.status, 409); assert.equal(held.data.error.code, 'IMAGE_STATE_UNKNOWN'); assert.equal(providerCalls, 7)
    assert.equal((await approve(mkCall(mem), scene(4))).data.error.code, 'IMAGE_STATE_UNKNOWN') // 다른 인스턴스·재시작 뒤에도
    assert.equal(providerCalls, 7)
    const forced = await approve(call, scene(4, { regenerate: 'user-confirmed-new-1' })); assert.equal(forced.status, 200); assert.equal(providerCalls, 8) // 사용자가 확인하고 새로 요청
    // 5) 생성 성공 뒤 결과 저장 실패: 응답은 돌려주되, 같은 요청 재호출은 보류
    const noStore: any = { ...mem, getJson: mem.getJson, claim: mem.claim, getBytes: mem.getBytes, putJson: mem.putJson, putBytes: async () => { throw new Error('storage down') } }
    const c2 = mkCall(noStore)
    assert.equal((await approve(c2, scene(5))).status, 200); assert.equal(providerCalls, 9)
    assert.equal((await approve(c2, scene(5))).data.error.code, 'IMAGE_STATE_UNKNOWN'); assert.equal(providerCalls, 9)
    // 6) 같은 새 요청 두 개가 동시에(두 번 클릭·두 인스턴스): 공급자 호출은 한 번
    const before = providerCalls
    const [a, b] = await Promise.all([approve(call, scene(6)), approve(mkCall(mem), scene(6))])
    assert.equal(providerCalls - before, 1); assert.deepEqual([a.status, b.status].sort(), [200, 409])
    assert.equal([a, b].find((r) => r.status === 409)!.data.error.code, 'IMAGE_IN_PROGRESS')
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey }
})
