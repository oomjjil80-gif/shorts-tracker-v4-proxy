import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { reviewCardImage } from '../lib/cardnews/visionReview.js'

const input = { card: { id: 'c1', headline: '치즈', body: '손상된 치즈', visualPlan: {} }, cover: { title: '거인' }, dataUrl: 'data:image/png;base64,aGVsbG8=', rules: { secrecyEye: true } }
const env = { OPENAI_API_KEY: 'test-only' }
const mock = (payload: any, status = 200) => async (_url: any, init: any) => {
  const body = JSON.parse(init.body)
  assert.equal(body.messages[1].content[1].type, 'image_url')
  assert.equal(body.messages[1].content[0].text.includes('"secrecyEye":true'), true)
  return { ok: status === 200, status, json: async () => payload } as any
}
test('vision reviewer accepts valid passing result', async () => {
  const r = await reviewCardImage(input, env, mock({ choices: [{ message: { content: JSON.stringify({ pass: true, violations: [] }) } }] }) as any)
  assert.equal(r.pass, true)
})
test('vision reviewer rejects early reveal and attributes card', async () => {
  const r = await reviewCardImage(input, env, mock({ choices: [{ message: { content: JSON.stringify({ pass: false, violations: [{ code: 'EARLY_REVEAL', reason: 'one eye visible' }] }) } }] }) as any)
  assert.equal(r.pass, false)
  assert.equal(r.violations[0].cardId, 'c1')
})
test('vision reviewer fails closed on malformed provider response', async () => {
  await assert.rejects(reviewCardImage(input, env, mock({ choices: [{ message: { content: 'not json' } }] }) as any), { code: 'REVIEW_INVALID' })
})
test('vision reviewer fails closed on provider outage', async () => {
  await assert.rejects(reviewCardImage(input, env, mock({}, 503) as any), { code: 'PROVIDER_DOWN' })
})
test('vision reviewer requires credentials before network call', async () => {
  await assert.rejects(reviewCardImage(input, {}, mock({}) as any), { code: 'PROVIDER_DOWN' })
})
