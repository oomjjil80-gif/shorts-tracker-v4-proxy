// Every Tracker picture is drawn by Gemini Nano Banana 2 (lib/generative/geminiImage.ts). No network, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GEMINI_IMAGE_MODEL, GEMINI_INTERACTIONS_URL, geminiImage, geminiImagePayload } from '../lib/generative/geminiImage.js'
import { geminiImageWithReference, geminiLongformImage, geminiPortraitImage, geminiWisdomImage } from '../lib/generative/providers.js'
import { geminiYadamImage, yadamReferences } from '../lib/generative/yadamStyle.js'
import { OPENAI_IMAGE_BLOCKED, estimateUsd, meteredFetch, usageOf } from '../lib/generative/usageLedger.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMG = Buffer.from('fake-image-bytes')
const ok = () => new Response(JSON.stringify({ id: 'i1', steps: [{ type: 'model_output', content: [{ type: 'image', data: IMG.toString('base64'), mime_type: 'image/png' }] }] }), { headers: { 'content-type': 'application/json' } })
function recorder(answer: () => Response = ok) {
  const seen: Array<{ url: string; key: string; body: any }> = []
  const f = (async (url: string, init: any) => { seen.push({ url, key: init.headers['x-goog-api-key'], body: JSON.parse(init.body) }); return answer() }) as unknown as typeof fetch
  return { seen, f }
}

test('one Gemini request: model, text first, references in order, native aspect ratio + size, key only in the header', async () => {
  const p = geminiImagePayload({ prompt: 'SCENE', aspectRatio: '16:9', imageSize: '1K', references: [{ bytes: Buffer.from('a'), mime: 'image/jpeg' }, { bytes: Buffer.from('b'), mime: 'image/png' }] })
  assert.equal(p.model, 'gemini-3.1-flash-image'); assert.equal(GEMINI_IMAGE_MODEL, 'gemini-3.1-flash-image')
  assert.deepEqual(p.input.map((x: any) => x.type), ['text', 'image', 'image']); assert.match((p.input[0] as any).text, /SCENE$/)
  assert.deepEqual(p.input.slice(1).map((x: any) => [x.data, x.mime_type]), [[Buffer.from('a').toString('base64'), 'image/jpeg'], [Buffer.from('b').toString('base64'), 'image/png']])
  assert.deepEqual(p.response_format, [{ type: 'image', aspect_ratio: '16:9', image_size: '1K' }])
  assert.equal((geminiImagePayload({ prompt: 'ONLY THIS', aspectRatio: '16:9' }, { oneImageLine: false }).input[0] as any).text, 'ONLY THIS', 'the sample test sends the scene text alone')
  assert.throws(() => geminiImagePayload({ prompt: 'x', aspectRatio: '7:3' as any }))
  const { seen, f } = recorder()
  const out = await geminiImage({ prompt: 'S', aspectRatio: '9:16' }, 'GKEY', f)
  assert.deepEqual([seen[0].url, seen[0].key, out.provider, out.model, out.contentType, out.bytes.equals(IMG)], [GEMINI_INTERACTIONS_URL, 'GKEY', 'gemini', GEMINI_IMAGE_MODEL, 'image/png', true])
  assert.ok(!JSON.stringify(seen[0].body).includes('GKEY'))
  // no key -> no request; billing / quota -> a stop (a stage never pays again for it); no image -> its own code
  await assert.rejects(() => geminiImage({ prompt: 'S', aspectRatio: '16:9' }, '', f), /GEMINI_API_KEY/); assert.equal(seen.length, 1)
  await assert.rejects(() => geminiImage({ prompt: 'S', aspectRatio: '16:9' }, 'k', recorder(() => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }), { status: 429 })).f), (e: any) => e.stop === true && e.status === 429)
  await assert.rejects(() => geminiImage({ prompt: 'S', aspectRatio: '16:9' }, 'k', recorder(() => new Response('{}', { status: 200 })).f), (e: any) => e.code === 'no_image')
})

test('every picture path is Gemini: Wisdom Shorts beats, Wisdom thumbnail, Longform, style-locked, 야담 (3 frames + approved)', async () => {
  const { seen, f } = recorder()
  await geminiWisdomImage('beat', 'k', f); await geminiPortraitImage('thumb', 'k', f); await geminiLongformImage('long', 'k', f)
  await geminiImageWithReference('locked', Buffer.from([0xff, 0xd8, 1]), 'k', f)
  await geminiYadamImage(f)('yadam scene', 'k', { approved: Buffer.from([0x89, 0x50, 1]) })
  assert.ok(seen.every((x) => x.url === GEMINI_INTERACTIONS_URL && x.body.model === GEMINI_IMAGE_MODEL))
  assert.deepEqual(seen.map((x) => x.body.response_format[0].aspect_ratio), ['2:3', '9:16', '16:9', '16:9', '16:9'])
  assert.deepEqual(seen.map((x) => x.body.input.length - 1), [0, 0, 0, 1, 4], 'reference images: none / none / none / the approved picture / 3 frames + approved')
  const refs = await yadamReferences()
  assert.deepEqual(seen[4].body.input.slice(1, 4).map((x: any) => x.data), refs.map((r) => r.bytes.toString('base64')), '야담: the 3 frames first, in order')
  assert.equal(seen[4].body.input[4].mime_type, 'image/png'); assert.equal(seen[3].body.input[1].mime_type, 'image/jpeg')
})

test('OpenAI image API: refused before it is sent (fail closed); Gemini calls are metered with their price', async () => {
  let sent = 0, lines: string[] = []
  const base = (async () => { sent++; return ok() }) as unknown as typeof fetch
  const mf = meteredFetch(base, (l) => lines.push(l))
  for (const u of ['https://api.openai.com/v1/images/generations', 'https://api.openai.com/v1/images/edits']) await assert.rejects(() => mf(u, { method: 'POST', body: '{}' }), (e: any) => e.code === OPENAI_IMAGE_BLOCKED && e.stop === true)
  assert.equal(sent, 0, 'nothing reached OpenAI')
  await mf(GEMINI_INTERACTIONS_URL, { method: 'POST', body: JSON.stringify(geminiImagePayload({ prompt: 'S', aspectRatio: '16:9', imageSize: '1K' })) }); assert.equal(sent, 1)
  const u = usageOf(GEMINI_INTERACTIONS_URL, geminiImagePayload({ prompt: 'S', aspectRatio: '16:9', imageSize: '2K' }), { steps: [{ type: 'model_output', content: [{ type: 'image', data: 'x' }] }], usage: { total_input_tokens: 1000 } })!
  assert.deepEqual([u.api, u.model, u.images, u.imageSize], ['image', GEMINI_IMAGE_MODEL, 1, '2K'])
  assert.equal(estimateUsd(u), 0.1015)
  assert.ok(lines.some((l) => /cost.*api=image|image model=gemini-3.1-flash-image/.test(l)) || lines.some((l) => l.includes('gemini-3.1-flash-image')))
})

test('no source on an execution path calls an OpenAI image endpoint or names an OpenAI image model', async () => {
  const files: string[] = []
  const walk = async (d: string) => { for (const e of await readdir(join(ROOT, d), { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else if (/\.(ts|js|mjs)$/.test(e.name)) files.push(p) } }
  for (const d of ['api', 'lib', 'worker', 'server']) await walk(d).catch(() => {})
  const hits: string[] = []
  for (const f of files) {
    const t = await readFile(join(ROOT, f), 'utf8')
    if (/\/v1\/images\/(generations|edits|variations)/.test(t) && f !== join('lib', 'generative', 'usageLedger.ts')) hits.push(`${f}: images endpoint`)
    if (/gpt-image-1|dall-e/i.test(t) && f !== join('lib', 'generative', 'usageLedger.ts')) hits.push(`${f}: OpenAI image model`)
  }
  assert.deepEqual(hits, [])
})
