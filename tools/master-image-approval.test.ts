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
    await handler({ method: 'POST', headers: { 'x-sync-key': key }, body } as any,
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
    assert.equal((await call({ ...body, imageInput: { ...body.imageInput, references: [] } })).status, 400)
    assert.equal((await call({ ...body, sceneId: 'scene-13' })).status, 400)
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
    await imageHandler({ method: 'POST', body: { input: body.imageInput } } as any,
      { setHeader() {}, status(s: number) { directStatus = s; return this }, json() { return this } } as any)
    assert.equal(directStatus, 403)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = oldFetch
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = oldKey
  }
})
