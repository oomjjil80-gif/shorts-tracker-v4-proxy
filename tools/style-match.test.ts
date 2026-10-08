// STYLE MATCH on real pictures (the 5 그림체 previews: the SAME Joseon scene drawn in 5 art styles; no AI call).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOk } from '../lib/media/ffmpeg.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { representativeCheck } from '../worker/stages/styleGate.js'
import { imageStyleFeatures, styleDistance, textureDistance, styleFeatureText, STYLE_MATCH, TEXTURE_MATCH } from '../lib/generative/styleApproval.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'style-examples', 'yadam')
const names = ['classic_storybook', 'fairytale_illustration', 'korean_drama_illustration', 'oriental_painterly', 'webtoon_historical']

test('colour + brightness alone never pass; a different art style of the same scene is rejected; the same style passes only with the judge', async () => {
  const d = await mkdtemp(join(tmpdir(), 'style-real-')), pic: Record<string, Buffer> = {}, feat: Record<string, any> = {}
  for (const n of names) { pic[n] = await readFile(join(dir, `${n}.jpg`)); feat[n] = await imageStyleFeatures(join(dir, `${n}.jpg`)) }
  const freeFails = (a: string, b: string) => styleDistance(feat[a], feat[b]) > STYLE_MATCH || textureDistance(feat[a].texture, feat[b].texture) > TEXTURE_MATCH
  let colourOnly = 0, freeRejected = 0
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    if (styleDistance(feat[names[i]], feat[names[j]]) <= STYLE_MATCH) colourOnly++
    if (freeFails(names[i], names[j])) freeRejected++
  }
  assert.ok(colourOnly >= 8, `the colour-only check would call ${colourOnly}/10 different styles a match`)
  assert.ok(freeRejected >= 6, `the free texture check rejects ${freeRejected}/10 different styles without an AI call`)
  // the same style, another composition (left / right part of the same picture, same pixel scale): passes the free checks
  for (const n of names) {
    const a = join(d, `${n}-l.jpg`), b = join(d, `${n}-r.jpg`)
    await runOk(['-y', '-i', join(dir, `${n}.jpg`), '-vf', 'crop=iw*0.55:ih:0:0', '-q:v', '3', a])
    await runOk(['-y', '-i', join(dir, `${n}.jpg`), '-vf', 'crop=iw*0.55:ih:iw*0.45:0', '-q:v', '3', b])
    const fa = await imageStyleFeatures(a), fb = await imageStyleFeatures(b)
    assert.ok(styleDistance(fa, fb) <= STYLE_MATCH && textureDistance(fa.texture, fb.texture) <= TEXTURE_MATCH, `${n}: same style passes the free checks`)
  }
  // through the real check: every different style is a mismatch, and the free check stops most without a judge call
  const blobs: any = createMemoryBlobStore()
  for (const a of names) for (const b of names) {
    if (a === b) continue
    let judgeCalls = 0
    const record: any = { schema: 'style-approval/1', status: 'approved', attempts: [] }
    const x = await representativeCheck({ jobId: `j-${a}-${b}`, blobs, record, reference: { bytes: pic[a], sha: 's', features: feat[a], text: styleFeatureText(feat[a]), thumbnailRef: 't' }, prompt: 'p', sceneId: 's1', apiKey: 'k', tries: 1,
      drawRef: async () => ({ bytes: pic[b], contentType: 'image/jpeg', provider: 'fixture', model: 'real' }) as any,
      judge: async () => { judgeCalls++; return { same: false, score: 20, differences: ['different medium'] } } })
    assert.equal(x, null, `${b} must not pass as ${a}`); assert.equal(record.representative.status, 'mismatch')
    if (freeFails(a, b)) assert.equal(judgeCalls, 0, `${a}/${b}: no AI call when the free check already fails`)
  }
  // the same picture: a pass needs the judge's yes (no judge / a low score = never a pass)
  for (const [judge, want] of [[undefined, false], [async () => ({ same: true, score: 60, differences: [] }), false], [async () => ({ same: true, score: 90, differences: [] }), true]] as const) {
    const record: any = { schema: 'style-approval/1', status: 'approved', attempts: [] }
    const x = await representativeCheck({ jobId: 'j-same', blobs, record, reference: { bytes: pic.webtoon_historical, sha: 's', features: feat.webtoon_historical, text: '', thumbnailRef: 't' }, prompt: 'p', sceneId: 's1', apiKey: 'k', tries: 1, judge: judge as any,
      drawRef: async () => ({ bytes: pic.webtoon_historical, contentType: 'image/jpeg', provider: 'fixture', model: 'real' }) as any })
    assert.equal(!!x, want)
  }
})

test('style-locked picture: gpt-image-1-mini by default with the approved picture attached; falls back to gpt-image-1 only when the model cannot take a reference', async () => {
  const { openAiImageWithReference } = await import('../lib/generative/providers.js')
  const seen: string[] = [], ok = (m: string) => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(m).toString('base64') }] }), { status: 200 })
  const ref = Buffer.from('approved-picture')
  const f1: any = async (url: string, init: any) => { const fd = init.body as FormData; seen.push(`${url}|${fd.get('model')}|${(fd.get('image[]') as Blob)?.size}`); return ok('x') }
  const a = await openAiImageWithReference('p', ref, 'k', f1)
  assert.deepEqual(seen, [`https://api.openai.com/v1/images/edits|gpt-image-1-mini|${ref.length}`]); assert.equal(a.model, 'gpt-image-1-mini')
  seen.length = 0
  const f2: any = async (_u: string, init: any) => { const m = (init.body as FormData).get('model'); seen.push(String(m)); return m === 'gpt-image-1-mini' ? new Response('{"error":{"message":"model does not support image edits"}}', { status: 400 }) : ok('y') }
  assert.equal((await openAiImageWithReference('p', ref, 'k', f2)).model, 'gpt-image-1'); assert.deepEqual(seen, ['gpt-image-1-mini', 'gpt-image-1'])
  const f3: any = async () => new Response('{"error":{"message":"Billing hard limit has been reached"}}', { status: 400 })
  await assert.rejects(openAiImageWithReference('p', ref, 'k', f3), /400/) // billing is never retried on a pricier model
})
