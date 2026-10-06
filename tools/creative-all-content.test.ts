// Creative Settings on EVERY generated-content type: 5 families x 2 formats through the ONE resolver, the creative_resolve
// task the browser uses for Story Writer content, the picture style applied at /api/image (keys in, style text added
// server-side, legacy Episodes untouched), and the voice preview by family. Fake providers; no paid calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCreativeProfile, creativeContentFor, imageStyleFor, withVisualStyle, creativeVoice, CONTENT_FAMILIES } from '../lib/generative/creativeProfile.js'
import { VISUAL_STYLE_PROFILES } from '../lib/generative/visualStyle.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { previewVoice } from '../lib/generative/voicePreview.js'
import imageHandler from '../api/image.js'

const FORMATS = ['shorts', 'longform'] as const
const AUTO_STYLE: Record<string, string> = { senior: 'senior-warm-watercolor', wisdom: 'wisdom-painterly', yasa: 'historical-dramatic', general: 'bright-editorial', economy: 'realistic-documentary' }
const http = (handler: any, body: any) => new Promise<{ status: number; json: any }>((resolve) => {
  let status = 0
  handler({ method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': 'k'.repeat(32) }, query: {}, body } as any,
    { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { resolve({ status, json: b }); return this }, end() { return this } } as any)
})

test('matrix: every family x format resolves through the one resolver; AUTO style per family; explicit choices always win', () => {
  assert.deepEqual([...CONTENT_FAMILIES], ['senior', 'wisdom', 'yasa', 'general', 'economy'])
  for (const fam of CONTENT_FAMILIES) for (const fmt of FORMATS) {
    const content = creativeContentFor(fam, fmt)
    const auto = resolveCreativeProfile(content, {}, '평범한 이야기').resolved
    assert.equal(auto.visualStyleProfile, AUTO_STYLE[fam], `${fam}/${fmt}`)
    const mine = resolveCreativeProfile(content, { voiceProfile: 'female-middle', voiceTone: 'neutral', voiceSpeed: 1.1, visualStyleProfile: 'senior-warm-watercolor' }, '').resolved
    assert.deepEqual([mine.voiceProfile, mine.voiceTone, mine.voiceSpeed, mine.visualStyleProfile], ['female-middle', 'neutral', 1.1, 'senior-warm-watercolor'], `${fam}/${fmt}`)
  }
  assert.deepEqual(FORMATS.map((f) => creativeContentFor('wisdom', f)), ['wisdom', 'wisdom_longform']) // the existing server profiles
  assert.equal(creativeContentFor('senior', 'longform'), 'senior_longform')
  assert.throws(() => creativeContentFor('horror', 'shorts')); assert.throws(() => creativeContentFor('general', 'reel'))
})

test('AUTO voice per family: Senior and Yasa never a young voice (Yasa/Economy default to a mature male voice); Wisdom Shorts keeps its house voice', () => {
  const v = (fam: string, fmt: string, topic: string) => resolveCreativeProfile(creativeContentFor(fam, fmt), {}, topic).resolved.voiceProfile
  const YOUTH = '20대 청춘의 도전과 습관'
  for (const fmt of FORMATS) {
    assert.equal(v('senior', fmt, YOUTH), 'male-middle'); assert.equal(v('yasa', fmt, YOUTH), 'male-middle')
    assert.equal(v('yasa', fmt, '조선 왕실의 비밀'), 'male-middle'); assert.equal(v('economy', fmt, '금리와 환율'), 'male-middle')
    assert.equal(v('general', fmt, YOUTH), 'male-young'); assert.equal(v('general', fmt, '평범한 하루'), 'female-middle')
  }
  assert.equal(v('wisdom', 'shorts', '아무 주제'), 'house')
})

test('creative_resolve: the browser asks the server (keys in, resolved profile out; no database, no paid call)', async () => {
  const handler = createJobsHttp({ getStore: async () => { throw new Error('no database for creative_resolve') }, blobs: createMemoryBlobStore(), voicePreview: async () => { throw new Error('unused') } })
  const r = await http(handler, { taskType: 'creative_resolve', family: 'economy', format: 'shorts', topic: '금리와 환율', voiceProfile: 'female-middle', voiceTone: 'neutral', voiceSpeed: 1.1, visualStyleProfile: 'auto' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.creative.requested, { voiceProfile: 'female-middle', voiceTone: 'neutral', voiceSpeed: 1.1, visualStyleProfile: 'auto' })
  assert.deepEqual(r.json.creative.resolved, { voiceProfile: 'female-middle', voiceTone: 'neutral', voiceSpeed: 1.1, voiceProfileId: 'ko-lf-female-middle-neutral-1.1-v2', visualStyleProfile: 'realistic-documentary' })
  assert.deepEqual([r.json.creative.content, r.json.creative.family, r.json.creative.format], ['economy_shorts', 'economy', 'shorts'])
  assert.doesNotMatch(JSON.stringify(r.json), /marin|cedar|onyx|nova|sage|"ash"|promptPrefix|Watercolor|documentary-style/) // keys only
  for (const bad of [{ family: 'horror', format: 'shorts' }, { family: 'yasa', format: 'shorts', voiceSpeed: 1.3 }, { family: 'yasa', format: 'shorts', visualStyleProfile: 'anime' }]) assert.equal((await http(handler, { taskType: 'creative_resolve', ...bad })).status, 400)
})

test('/api/image style: legacy Episodes unchanged; AUTO per family; explicit wins; stored resolved wins; economy AUTO keeps its prompts', () => {
  assert.equal(imageStyleFor(undefined), null) // an Episode from before Creative Settings
  const c = (family: string, format: string, requested: any = {}, resolved?: any) => imageStyleFor({ family, format, requested, ...(resolved ? { resolved } : {}) })?.id ?? null
  assert.equal(c('general', 'shorts'), 'bright-editorial'); assert.equal(c('yasa', 'longform'), 'historical-dramatic'); assert.equal(c('senior', 'shorts'), 'senior-warm-watercolor')
  assert.equal(c('economy', 'shorts'), null); assert.equal(c('economy', 'longform'), null) // native: the economy bible already draws it
  assert.equal(c('wisdom', 'shorts'), null) // Wisdom Shorts native style
  assert.equal(c('economy', 'shorts', { visualStyleProfile: 'senior-warm-watercolor' }), 'senior-warm-watercolor')
  assert.equal(c('general', 'shorts', { visualStyleProfile: 'auto' }, { visualStyleProfile: 'historical-dramatic' }), 'historical-dramatic')
  // composition: style block first, then the whole channel/episode bible + CUT scene (kept), negatives last
  const base = '[CHANNEL STYLE BIBLE]\nSTYLE: premium cinematic 3D\n\n[EPISODE GLOBAL VISUAL BIBLE]\n...\n\n[CUT 01 SCENE]\n시장 골목의 할머니'
  const w = withVisualStyle(base, VISUAL_STYLE_PROFILES['historical-dramatic'])
  const at = ['[VISUAL STYLE PROFILE', base, '[VISUAL STYLE NEGATIVE]'].map((k) => w.indexOf(k))
  assert.ok(at.every((i) => i >= 0) && at[0] < at[1] && at[1] < at[2], JSON.stringify(at))
  assert.ok(w.includes(VISUAL_STYLE_PROFILES['historical-dramatic'].promptPrefix)); assert.equal(withVisualStyle(base, null), base)
})

async function callImage(input: any) {
  const prevKey = process.env.GEMINI_API_KEY, prevFetch = globalThis.fetch
  process.env.GEMINI_API_KEY = 'test-key'
  const sent: any[] = []
  globalThis.fetch = (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'r1', output_image: { data: Buffer.from('img').toString('base64'), mime_type: 'image/png' } }), { status: 200 }) }) as any
  try {
    let status = 0, json: any = null
    await imageHandler({ method: 'POST', query: {}, headers: {}, body: { contractVersion: '1.5', taskType: 'cut_image', input } } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this }, send() { return this } } as any)
    return { status, json, text: sent[0]?.input?.[0]?.text as string }
  } finally { globalThis.fetch = prevFetch; if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey }
}

test('/api/image (cut_image): a legacy request is sent exactly as before; a Story Writer Episode request carries its style', async () => {
  const prompt = '[CHANNEL STYLE BIBLE]\nSTYLE: premium cinematic 3D animation\n\n[CUT 01 SCENE]\n조선 궁궐 앞의 내관'
  const legacy = await callImage({ prompt, aspectRatio: '9:16' })
  assert.equal(legacy.text, 'Generate exactly ONE final image for this CUT. Do not return a candidate sheet, variations, collage, triptych, or contact sheet.\n\n' + prompt)
  assert.equal(legacy.json?.meta?.visualStyleProfile ?? null, null)
  const yasa = await callImage({ prompt, aspectRatio: '9:16', creative: { family: 'yasa', format: 'shorts', requested: { visualStyleProfile: 'auto' }, resolved: { visualStyleProfile: 'historical-dramatic' } } })
  assert.ok(yasa.text.includes(VISUAL_STYLE_PROFILES['historical-dramatic'].promptPrefix) && yasa.text.includes(prompt) && yasa.text.includes(VISUAL_STYLE_PROFILES['historical-dramatic'].negativePrompt))
  assert.equal(yasa.json.meta.visualStyleProfile, 'historical-dramatic')
  // another style = another prompt (no image is ever reused across styles)
  const water = await callImage({ prompt, aspectRatio: '9:16', creative: { family: 'yasa', format: 'shorts', requested: { visualStyleProfile: 'senior-warm-watercolor' } } })
  assert.notEqual(water.text, yasa.text); assert.equal(water.json.meta.visualStyleProfile, 'senior-warm-watercolor')
  assert.equal((await callImage({ prompt, creative: { family: 'horror', format: 'shorts' } })).status, 400)
})

test('voice preview by family + format: AUTO is that content\'s rule; same resolver', () => {
  assert.equal(previewVoice({ family: 'yasa', format: 'shorts', topic: '20대 청춘' }).id, 'ko-lf-male-middle-calm-1.0-v2')
  assert.equal(previewVoice({ family: 'economy', format: 'longform' }).id, 'ko-lf-male-middle-calm-1.0-v2')
  assert.equal(previewVoice({ family: 'general', format: 'shorts', voiceProfile: 'female-young', voiceTone: 'bright', voiceSpeed: 1.1 }).id, 'ko-lf-female-young-bright-1.1-v2')
  assert.equal(previewVoice({ family: 'wisdom', format: 'shorts' }).id, 'ko-calm-clear-v1') // the Wisdom Shorts house voice
  assert.throws(() => previewVoice({ family: 'horror', format: 'shorts' }))
  assert.equal(creativeVoice(resolveCreativeProfile('senior_shorts', {}, '')).id, 'ko-lf-female-middle-calm-1.0-v2')
})
