// Paid-call ledger (no network): what each OpenAI / Gemini response cost, per run; requests and responses are never changed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { meteredFetch, withUsageLedger, summarize, usageOf, estimateUsd } from '../lib/generative/usageLedger.js'

test('metered fetch counts text, image and speech calls of the running stage only; never alters the response; unknown prices stay n/a', async () => {
  const lines: string[] = []
  const base: any = async (url: string) => url.includes('generativelanguage.googleapis.com')
    ? new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', data: 'AAAA' }] }], usage: { total_input_tokens: 300 } }), { headers: { 'content-type': 'application/json' } })
    : url.includes('/audio/speech') ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })
    : url.includes('api.openai.com') ? new Response(JSON.stringify({ model: 'gpt-5-mini', output_text: '{}', usage: { input_tokens: 2000, output_tokens: 100 } }), { headers: { 'content-type': 'application/json' } })
    : new Response('ok')
  const f = meteredFetch(base, (l) => lines.push(l))
  const { ledger, run } = withUsageLedger('job=j1 stage=ASSET attempt=1', async () => {
    const r = await f('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-5-mini', text: { format: { name: 'judge' } } }) })
    assert.equal((await r.json()).output_text, '{}', 'the caller still reads the body')
    await f('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', body: JSON.stringify({ model: 'gemini-3.1-flash-image', input: [], response_format: [{ type: 'image', aspect_ratio: '16:9', image_size: '1K' }] }) })
    await f('https://api.openai.com/v1/audio/speech', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: '가'.repeat(372) }) })
    await f('https://example.com/x')
  })
  await run
  const s = summarize(ledger.calls)
  assert.equal(s.paidCalls, 3)
  assert.deepEqual(Object.keys(s.byModel).sort(), ['gemini-3.1-flash-image', 'gpt-4o-mini-tts', 'gpt-5-mini'])
  assert.equal(s.byModel['gpt-5-mini'].estUsd, 0.0007); assert.equal(s.byModel['gemini-3.1-flash-image'].images, 1); assert.equal(s.byModel['gemini-3.1-flash-image'].estUsd, 0.06715, '1K picture $0.067 + 300 input tokens'); assert.equal(s.byModel['gpt-4o-mini-tts'].ttsChars, 372)
  assert.equal(s.byModel['gpt-4o-mini-tts'].estUsd, 0.015, '372 chars = 1 minute of narration')
  assert.ok(lines.every((l) => l.includes('job=j1 stage=ASSET')) && lines.length === 3)
  // outside a stage: logged, not attached to any run
  await f('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' }); assert.equal(ledger.calls.length, 3)
  assert.equal(estimateUsd({ ...usageOf('https://api.openai.com/v1/responses', { model: 'some-new-model' }, { usage: { input_tokens: 5, output_tokens: 5 } })!, model: 'some-new-model' }), null)
  // a failed call is never counted (nothing billed for it here) and its body stays intact
  const bad = meteredFetch(async () => new Response('{"error":1}', { status: 500, headers: { 'content-type': 'application/json' } }), () => {})
  assert.equal(await (await bad('https://api.openai.com/v1/responses', {})).text(), '{"error":1}')
})
