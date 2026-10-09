// Golden Style 1~5 (issue #179): the locked references + text, the resolver, and every content's request. No network,
// no paid call: Gemini is a recorder.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GOLDEN_PROMPT_VERSION, GOLDEN_REFERENCE_DIR, GOLDEN_STYLES, GOLDEN_STYLE_IDS, GOLDEN_STYLE_INSTRUCTION, goldenCacheTag, goldenImage, goldenPrompt, goldenReference, goldenSpec } from '../lib/generative/goldenStyle.js'
import { creativeGolden, creativeStylesFor, imageStyleFor, resolveCreativeProfile } from '../lib/generative/creativeProfile.js'
import { VISUAL_STYLE_KEYS, VISUAL_STYLE_PROFILES, composeImagePrompt } from '../lib/generative/visualStyle.js'
import { applyVisualBible, styledVisualBible } from '../lib/generative/planner.js'
import imageHandler from '../api/image.js'

// the round-2 text the user approved (style-examples/publish-gemini-ref-test-2/.../run.json), character for character
const CREATIVE_CONTENTS = ['wisdom', 'wisdom_longform', 'senior_longform', 'source_shorts', 'senior_shorts', 'yasa_shorts', 'yasa_longform', 'general_shorts', 'general_longform', 'economy_shorts', 'economy_longform'] as const
const ROUND2 = '첨부 이미지는 그림체 참고용입니다. 첨부 이미지의 선화, 채색, 명암, 질감 등 시각적 표현 방식을 최대한 동일하게 재현하세요. 인물과 구도는 복사하지 말고 새로운 장면을 그리세요. 실사 사진으로 만들지 마세요.\n\n장면: 조선시대 낡은 한옥 앞마당에서 젊은 여인이 작은 보자기를 할머니에게 건넵니다. 할머니는 놀라움과 고마움이 섞인 표정으로 받아 듭니다. 뒤에는 돌담과 기와집이 보입니다.\n\n16:9 가로 화면, 글자 없음.'
const ROUND2_SCENE = '조선시대 낡은 한옥 앞마당에서 젊은 여인이 작은 보자기를 할머니에게 건넵니다. 할머니는 놀라움과 고마움이 섞인 표정으로 받아 듭니다. 뒤에는 돌담과 기와집이 보입니다.'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
function gemini() {
  const sent: any[] = []
  const f = (async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', data: PNG.toString('base64'), mime_type: 'image/png' }] }] }), { status: 200 }) }) as unknown as typeof fetch
  return { sent, f }
}

test('Golden 1~5 are LOCKED: the user\'s original files (sha256), the round-2 text, text first then ONE picture, 16:9 1K', async () => {
  assert.deepEqual([...GOLDEN_STYLE_IDS], ['golden-1', 'golden-2', 'golden-3', 'golden-4', 'golden-5']); assert.equal(GOLDEN_PROMPT_VERSION, 'golden-style/1')
  for (const id of GOLDEN_STYLE_IDS) {
    const b = await readFile(join(GOLDEN_REFERENCE_DIR, GOLDEN_STYLES[id].file))
    assert.equal(createHash('sha256').update(b).digest('hex'), GOLDEN_STYLES[id].sha256, id)
    assert.ok((await goldenReference(id)).equals(b))
  }
  assert.equal(goldenPrompt(ROUND2_SCENE, '16:9'), ROUND2, 'exactly the approved text')
  assert.ok(ROUND2.startsWith(GOLDEN_STYLE_INSTRUCTION))
  assert.equal(goldenPrompt('S', '9:16').split('\n\n').at(-1), '9:16 세로 화면, 글자 없음.'); assert.equal(goldenPrompt('S', '2:3').split('\n\n').at(-1), '2:3 세로 화면, 글자 없음.')
  const { sent, f } = gemini()
  const out = await goldenImage(goldenSpec('golden-4'), ROUND2_SCENE, '16:9', 'GK', f)
  const body = sent[0].body
  assert.equal(sent[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions'); assert.equal(body.model, 'gemini-3.1-flash-image')
  assert.deepEqual(body.input.map((x: any) => x.type), ['text', 'image']); assert.equal(body.input[0].text, ROUND2, 'no extra line before or after')
  assert.equal(body.input[1].data, (await readFile(join(GOLDEN_REFERENCE_DIR, 'ref-4.jpg'))).toString('base64')); assert.equal(body.input[1].mime_type, 'image/jpeg')
  assert.deepEqual(body.response_format, [{ type: 'image', aspect_ratio: '16:9', image_size: '1K' }])
  assert.equal(out.model, 'gemini-3.1-flash-image+golden-4+golden-style/1')
  // a job keeps its version: another version / another file stops before any call
  await assert.rejects(() => goldenImage({ ...goldenSpec('golden-1'), refSha256: 'x'.repeat(64) }, 'S', '16:9', 'GK', f), (e: any) => e.code === 'GOLDEN_STYLE_CHANGED')
  await assert.rejects(() => goldenImage({ ...goldenSpec('golden-1'), promptVersion: 'golden-style/0' }, 'S', '16:9', 'GK', f), (e: any) => e.code === 'GOLDEN_STYLE_CHANGED')
  const d = await mkdtemp(join(tmpdir(), 'golden-')); for (const id of GOLDEN_STYLE_IDS) await copyFile(join(GOLDEN_REFERENCE_DIR, GOLDEN_STYLES[id].file), join(d, GOLDEN_STYLES[id].file))
  await writeFile(join(d, 'ref-2.jpg'), Buffer.from('another picture'))
  await assert.rejects(() => goldenReference('golden-2', d), (e: any) => e.code === 'GOLDEN_REFERENCE_CHANGED')
  await assert.rejects(() => goldenReference('golden-3', join(d, 'none')), (e: any) => e.code === 'GOLDEN_REFERENCE_MISSING')
  assert.equal(sent.length, 1)
  assert.equal(goldenCacheTag(goldenSpec('golden-5')), `|golden:golden-5:${GOLDEN_STYLES['golden-5'].sha256}:golden-style/1`)
})

test('every content that makes pictures offers its default + Golden 1~5; the job stores the locked version; no style words', () => {
  for (const c of CREATIVE_CONTENTS) {
    const offered = creativeStylesFor(c)
    for (const id of GOLDEN_STYLE_IDS) assert.ok(offered.includes(id as any), `${c} offers ${id}`)
    const r = resolveCreativeProfile(c, { visualStyleProfile: 'golden-2' }, '').resolved
    if (c === 'source_shorts') { assert.equal(r.visualStyleProfile, null, 'the source video: no picture is made'); assert.equal(r.golden, undefined); continue }
    assert.deepEqual([r.visualStyleProfile, r.golden], ['golden-2', { id: 'golden-2', refSha256: GOLDEN_STYLES['golden-2'].sha256, promptVersion: 'golden-style/1' }], c)
    assert.equal(resolveCreativeProfile(c, {}, '').resolved.golden, undefined, `${c}: AUTO = the default, no Golden`)
  }
  assert.throws(() => resolveCreativeProfile('wisdom', { visualStyleProfile: 'golden-6' }, ''))
  assert.equal(creativeGolden(resolveCreativeProfile('yasa_longform', { visualStyleProfile: 'golden-5' }, ''))?.id, 'golden-5')
  assert.equal(creativeGolden(resolveCreativeProfile('yasa_longform', {}, '')), null)
  // the registry: the 5 old profiles unchanged (other tests pin their text); Golden entries carry no words
  assert.deepEqual(VISUAL_STYLE_KEYS.slice(-5), [...GOLDEN_STYLE_IDS])
  for (const id of GOLDEN_STYLE_IDS) { const p = VISUAL_STYLE_PROFILES[id]; assert.deepEqual([p.promptPrefix, p.negativePrompt, p.compositionHints, p.golden], ['', '', '', id]) }
  const composed = composeImagePrompt({ content: 'A grandmother', style: VISUAL_STYLE_PROFILES['golden-1'], composition: 'Wide 16:9 story frame.' })
  assert.equal(composed, 'Content: A grandmother. Composition: Wide 16:9 story frame.')
  const bible: any = { style: 'painterly', palette: 'muted', lighting: 'soft', characterPolicy: 'one man', negative: 'logos' }
  const beats: any = { beats: [{ id: 'b1', visualGoal: 'g', imagePrompt: 'a man at a window' }] }
  assert.equal(applyVisualBible(beats, styledVisualBible(bible, VISUAL_STYLE_PROFILES['golden-3'])).beats[0].imagePrompt.startsWith('Composition: center-safe'), true)
  assert.match(applyVisualBible(beats, styledVisualBible(bible, null)).beats[0].imagePrompt, /^painterly\. Palette: muted\. Lighting: soft\. Composition: center-safe/, 'Wisdom LOCK: the default prompt is byte-for-byte the old one')
})

async function callImage(input: any) {
  const prevKey = process.env.GEMINI_API_KEY, prevFetch = globalThis.fetch
  process.env.GEMINI_API_KEY = 'test-key'
  const sent: any[] = []
  globalThis.fetch = (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'r1', output_image: { data: PNG.toString('base64'), mime_type: 'image/png' } }), { status: 200 }) }) as any
  try {
    let status = 0, json: any = null
    await imageHandler({ method: 'POST', query: {}, headers: {}, body: { contractVersion: '1.5', taskType: 'cut_image', input } } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } } as any)
    return { status, json, sent: sent[0] }
  } finally { globalThis.fetch = prevFetch; if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey }
}

test('Story Writer / Simple Production CUT images (/api/image) for every browser content: Golden = the locked text + ONE picture; default unchanged', async () => {
  const ref3 = (await readFile(join(GOLDEN_REFERENCE_DIR, 'ref-3.jpg'))).toString('base64')
  for (const [family, format, ratio] of [['senior', 'shorts', '9:16'], ['yasa', 'shorts', '9:16'], ['general', 'shorts', '9:16'], ['general', 'longform', '16:9'], ['economy', 'shorts', '9:16'], ['economy', 'longform', '16:9']] as const) {
    const r = await callImage({ prompt: 'CUT 01 a grandmother at the gate', aspectRatio: ratio, references: [{ data: 'aGVsbG8=', mimeType: 'image/png' }], creative: { family, format, requested: { visualStyleProfile: 'golden-3' } } })
    assert.equal(r.status, 200, `${family} ${format}`)
    assert.deepEqual(r.sent.input.map((x: any) => x.type), ['text', 'image'], 'the ONE Golden picture; the episode references are not sent with a Golden Style')
    assert.equal(r.sent.input[0].text, goldenPrompt('CUT 01 a grandmother at the gate', ratio)); assert.equal(r.sent.input[1].data, ref3)
    assert.equal(r.sent.response_format[0].aspect_ratio, ratio); assert.equal(r.json.meta.golden.id, 'golden-3')
  }
  // economy longform keeps its 16:9 frame with a Golden Style; without one its server guard is unchanged
  const eco = await callImage({ prompt: 'CUT 02', aspectRatio: '9:16', profile: 'economy-longform-v01', creative: { family: 'economy', format: 'longform', requested: { visualStyleProfile: 'golden-1' } } })
  assert.equal(eco.sent.response_format[0].aspect_ratio, '16:9'); assert.equal(eco.sent.input[0].text, goldenPrompt('CUT 02', '16:9'))
  // the default: exactly as before (no Golden text, the episode references kept)
  const def = await callImage({ prompt: 'CUT 01 a grandmother at the gate', aspectRatio: '9:16', references: [{ data: 'aGVsbG8=', mimeType: 'image/png' }], creative: { family: 'general', format: 'shorts', requested: { visualStyleProfile: 'auto' } } })
  assert.ok(!def.sent.input[0].text.includes(GOLDEN_STYLE_INSTRUCTION)); assert.equal(def.sent.input.length, 2); assert.equal(def.sent.input[1].data, 'aGVsbG8=')
  const legacy = await callImage({ prompt: 'CUT 01', aspectRatio: '9:16' }); assert.ok(!legacy.sent.input[0].text.includes(GOLDEN_STYLE_INSTRUCTION))
  assert.equal(imageStyleFor({ family: 'yasa', format: 'longform', requested: { visualStyleProfile: 'golden-2' } })?.golden, 'golden-2')
})
