// 야담 그림체 = ONE contract (yadamStyle.ts): the 3 user frames + one text. No network, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOk } from '../lib/media/ffmpeg.js'
import { YADAM_REFERENCES, YADAM_REFERENCE_CROP, YADAM_REFERENCE_DIR, YADAM_STYLE_CONTRACT, YADAM_STYLE_ID, YADAM_STYLE_TRAITS, openAiYadamImage, yadamImageForm, yadamImagePrompt, yadamReferences } from '../lib/generative/yadamStyle.js'
import { VISUAL_STYLE_KEYS, VISUAL_STYLE_PROFILES } from '../lib/generative/visualStyle.js'
import { creativeStylesFor } from '../lib/generative/creativeProfile.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const raw = async (args: string[]) => (await runOk([...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])).stdout as Buffer

test('the ONE 야담 style: the 3 sent frames are exactly the user captures (bars, subtitles, AI label removed; no stretching), face close-up first', async () => {
  const refs = await yadamReferences()
  assert.deepEqual(refs.map((r) => r.name), ['capture-2.png', 'capture-1.png', 'capture-3.png'])
  for (const [i, r] of refs.entries()) {
    assert.deepEqual([r.width, r.height, r.file], [1920, 800, YADAM_REFERENCES[i].file])
    // the committed frame = the capture through YADAM_REFERENCE_CROP, pixel for pixel
    const fromCapture = await raw(['-i', join(YADAM_REFERENCE_DIR, r.file), '-vf', YADAM_REFERENCE_CROP, '-frames:v', '1'])
    const sent = await raw(['-i', join(YADAM_REFERENCE_DIR, 'sent', r.name), '-frames:v', '1'])
    assert.ok(fromCapture.equals(sent), `${r.name} is the capture as cropped`)
    // no burned subtitle in the bottom band
    const band = await raw(['-i', join(YADAM_REFERENCE_DIR, 'sent', r.name), '-vf', 'crop=1920:60:0:740', '-frames:v', '1'])
    let white = 0; for (let k = 0; k < band.length; k += 3) if (band[k] > 235 && band[k + 1] > 235 && band[k + 2] > 235) white++
    assert.ok(white / (band.length / 3) < 0.02)
  }
  await assert.rejects(() => yadamReferences(join(ROOT, 'tools')), (e: any) => e.code === 'YADAM_REFERENCE_MISSING', 'a missing frame stops; no fallback')
})

test('every 야담 image request: gpt-image-1 image edit, input_fidelity high, the 3 frames first (+ the approved picture last), the contract text around the scene', async () => {
  const refs = await yadamReferences()
  const form = await yadamImageForm({ scene: 'SCENE TEXT', quality: 'medium', approved: Buffer.from('approved') })
  assert.deepEqual(['model', 'size', 'quality', 'input_fidelity', 'output_format', 'n'].map((k) => form.get(k)), ['gpt-image-1', '1536x1024', 'medium', 'high', 'jpeg', '1'])
  const imgs = form.getAll('image[]') as any[]
  assert.deepEqual(imgs.map((x) => x.name), ['capture-2.png', 'capture-1.png', 'capture-3.png', 'approved-thumbnail.jpg'])
  for (const [i, r] of refs.entries()) assert.ok(Buffer.from(await imgs[i].arrayBuffer()).equals(r.bytes))
  const p = String(form.get('prompt'))
  assert.equal(p, yadamImagePrompt('SCENE TEXT')); assert.ok(p.startsWith(YADAM_STYLE_CONTRACT) && p.includes(YADAM_STYLE_TRAITS) && p.includes('Scene: SCENE TEXT'))
  assert.doesNotMatch(p, /watercolor|storybook|painterly|folk|textbook|vintage|sepia|muted|earth brown|soft overcast/i)
  assert.equal((await yadamImageForm({ scene: 'S', quality: 'high' })).getAll('image[]').length, 3, 'before approval: the 3 frames only')
  // the drawer sends exactly that request
  const seen: any[] = []
  const draw = openAiYadamImage((async (url: string, init: any) => { seen.push({ url, form: init.body }); return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('x').toString('base64') }] }), { headers: { 'content-type': 'application/json' } }) }) as any)
  const out = await draw('S', 'k', { quality: 'high' })
  assert.equal(seen[0].url, 'https://api.openai.com/v1/images/edits'); assert.equal(seen[0].form.get('quality'), 'high'); assert.equal(seen[0].form.getAll('image[]').length, 3)
  assert.equal(out.model, 'gpt-image-1+yadam-style/1')
})

test('nothing of the old 야담 styles is left on a production path; the other contents\' styles are byte-for-byte the same', async () => {
  // one 야담 style id, offered to 야담 only
  assert.deepEqual([...creativeStylesFor('yasa_longform')], [YADAM_STYLE_ID]); assert.deepEqual([...creativeStylesFor('yasa_shorts')], [YADAM_STYLE_ID])
  assert.deepEqual([...VISUAL_STYLE_KEYS], ['senior-warm-watercolor', 'wisdom-painterly', 'historical-dramatic', 'realistic-documentary', 'bright-editorial', YADAM_STYLE_ID])
  // senior / wisdom / general / economy styles: exactly the definitions on main before this change
  const keep = ['senior-warm-watercolor', 'wisdom-painterly', 'historical-dramatic', 'realistic-documentary', 'bright-editorial']
  assert.equal(createHash('sha256').update(JSON.stringify(keep.map((k) => (VISUAL_STYLE_PROFILES as any)[k]))).digest('hex'), 'ac092f3b1d1ccdd0313c1055ef383c918b7c4ff1ef6465d2082cea80f8a214d1')
  // no source on a production path (api, lib, worker) mentions an old 야담 style, example picture or experiment
  const OLD = /korean_drama_illustration|oriental_painterly|webtoon_historical|fairytale_illustration|classic_storybook|joseon_clean_watercolor|YADAM_AUTO_STYLE|YADAM_STYLE_KEYS|YADAM_NO_PHOTO|styleExamples|style-examples\/yadam|STYLE EXAMPLE ATTACHED|yadamStyleCandidates|yadamReferenceStyle|old Korean folk-tale|old storybook/
  const files: string[] = []
  const walk = async (d: string) => { for (const e of await readdir(join(ROOT, d), { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else if (/\.(ts|js|mjs)$/.test(e.name)) files.push(p) } }
  for (const d of ['api', 'lib', 'worker']) await walk(d)
  const hits: string[] = []
  for (const f of files) { const t = await readFile(join(ROOT, f), 'utf8'); if (OLD.test(t)) hits.push(f) }
  assert.deepEqual(hits, [], 'old 야담 style code left on a production path')
  // and no old example picture is shipped with the server
  assert.equal(await readdir(join(ROOT, 'assets', 'style-examples')).then((x) => x.length, () => 0), 0)
})
