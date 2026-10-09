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

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'style-distance')
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
    const x = await representativeCheck({ jobId: `j-${a}-${b}`, blobs, record, reference: { bytes: pic[a], sha: 's', features: feat[a], text: styleFeatureText(feat[a]), thumbnailRef: 't' }, prompt: 'p', sceneId: 's1', apiKey: 'k', imageKey: 'gk', tries: 1,
      drawRef: async () => ({ bytes: pic[b], contentType: 'image/jpeg', provider: 'fixture', model: 'real' }) as any,
      judge: async () => { judgeCalls++; return { same: false, score: 20, differences: ['different medium'] } } })
    assert.equal(x, null, `${b} must not pass as ${a}`); assert.equal(record.representative.status, 'mismatch')
    if (freeFails(a, b)) assert.equal(judgeCalls, 0, `${a}/${b}: no AI call when the free check already fails`)
  }
  // the same picture: a pass needs the judge's yes (no judge / a low score = never a pass)
  for (const [judge, want] of [[undefined, false], [async () => ({ same: true, score: 60, differences: [] }), false], [async () => ({ same: true, score: 90, differences: [] }), true]] as const) {
    const record: any = { schema: 'style-approval/1', status: 'approved', attempts: [] }
    const x = await representativeCheck({ jobId: 'j-same', blobs, record, reference: { bytes: pic.webtoon_historical, sha: 's', features: feat.webtoon_historical, text: '', thumbnailRef: 't' }, prompt: 'p', sceneId: 's1', apiKey: 'k', imageKey: 'gk', tries: 1, judge: judge as any,
      drawRef: async () => ({ bytes: pic.webtoon_historical, contentType: 'image/jpeg', provider: 'fixture', model: 'real' }) as any })
    assert.equal(!!x, want)
  }
})

test('style-locked picture: Gemini with the approved picture attached as the one reference image (16:9); a quota stop is never retried', async () => {
  const { geminiImageWithReference } = await import('../lib/generative/providers.js')
  const seen: any[] = [], ok = () => new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', data: Buffer.from('x').toString('base64'), mime_type: 'image/png' }] }] }), { status: 200 })
  const ref = Buffer.from('approved-picture')
  const f1: any = async (url: string, init: any) => { seen.push({ url, body: JSON.parse(init.body) }); return ok() }
  const a = await geminiImageWithReference('p', ref, 'k', f1)
  assert.equal(seen.length, 1); assert.match(seen[0].url, /generativelanguage\.googleapis\.com\/v1beta\/interactions$/)
  assert.deepEqual(seen[0].body.input.slice(1).map((x: any) => x.data), [ref.toString('base64')]); assert.equal(seen[0].body.response_format[0].aspect_ratio, '16:9'); assert.equal(a.model, 'gemini-3.1-flash-image')
  let n = 0
  const f3: any = async () => { n++; return new Response('{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}', { status: 429 }) }
  await assert.rejects(geminiImageWithReference('p', ref, 'k', f3), (e: any) => e.stop === true); assert.equal(n, 1)
})
