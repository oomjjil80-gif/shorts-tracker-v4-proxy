import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import imageHandler from '../api/image.js'

// Regression for mobile origin crash: non-enumerable headers must survive internal dispatch.
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
    assert.equal((await call(approved)).status, 409)
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
