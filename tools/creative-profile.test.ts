// Creative Settings for every content type that makes narration or pictures: ONE resolver (voice + tone + speed + picture
// style), AUTO rules per content type, explicit choices always win, resolved values stored at job_create / PLAN and used
// by TTS + IMAGE, cache keys per voice/tone/speed/style, legacy jobs unchanged. Fake providers; no paid calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCreativeProfile, creativeVoice, creativeVoiceFor, creativeStyleOverride, creativeAutoDefaults, briefVoice, type CreativeContent } from '../lib/generative/creativeProfile.js'
import { VISUAL_STYLE_PROFILES, VISUAL_STYLE_KEYS, composeImagePrompt } from '../lib/generative/visualStyle.js'
import { DEFAULT_VOICE_PROFILE, GENERAL_SHORTS_DEFAULT_VOICE_PROFILE, LONGFORM_VOICE_PROFILES, ttsCacheIdentity } from '../lib/generative/voiceProfile.js'
import { normalizeGenerativeBrief } from '../lib/generative/contracts.js'
import { normalizeLongformBrief, longformImagePrompt } from '../lib/generative/longform.js'
import { applyVisualBible, styledVisualBible } from '../lib/generative/planner.js'
import { openAiTts, openAiWisdomTts } from '../lib/generative/providers.js'
import { createGenerativePlanExecutor } from '../worker/stages/generative.js'
import { anchorNamedThinkerVisual } from '../lib/generative/wisdom.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { PROFILES } from '../lib/jobs/profiles.js'

const BUDDHA = '부처님이 말한 인생의 마지막 공부', YOUTH = '20대 청춘의 도전과 습관', FAMILY = '어머니와 아들의 마지막 겨울'
const CONTENTS: CreativeContent[] = ['source_shorts', 'wisdom', 'wisdom_longform', 'senior_longform', 'yasa_longform']

test('A1-2: every real profile resolves through the one resolver; AUTO voice per content type', () => {
  for (const p of Object.keys(PROFILES)) assert.ok(CONTENTS.includes(p as CreativeContent), `profile ${p} has creative rules`)
  for (const c of CONTENTS) { const r = resolveCreativeProfile(c, {}, BUDDHA); assert.equal(r.schema, 'creative-profile/1'); assert.ok(r.resolved.voiceProfileId) }
  // Wisdom Shorts / source Shorts: their established house voice, byte for byte
  assert.equal(creativeVoice(resolveCreativeProfile('wisdom', {}, BUDDHA)), DEFAULT_VOICE_PROFILE)
  assert.equal(creativeVoice(resolveCreativeProfile('source_shorts', {}, BUDDHA)), GENERAL_SHORTS_DEFAULT_VOICE_PROFILE)
  // Longform: the topic rule (Buddha -> male-senior); Senior never picks a young voice
  assert.equal(resolveCreativeProfile('wisdom_longform', {}, BUDDHA).resolved.voiceProfile, 'male-senior')
  assert.equal(resolveCreativeProfile('wisdom_longform', {}, YOUTH).resolved.voiceProfile, 'male-young')
  assert.equal(resolveCreativeProfile('senior_longform', {}, YOUTH).resolved.voiceProfile, 'male-middle')
  assert.equal(resolveCreativeProfile('senior_longform', {}, '평범한 하루').resolved.voiceProfile, 'female-middle')
  assert.deepEqual(creativeAutoDefaults('senior_longform'), { voiceProfile: 'female-middle', voiceTone: 'calm', voiceSpeed: 1, voiceProfileId: 'ko-lf-female-middle-calm-1.0-v2', visualStyleProfile: 'senior-warm-watercolor' })
})

test('A3-5: an explicit voice / tone / speed is never overridden by AUTO, on every content type', async () => {
  for (const c of CONTENTS) {
    const r = resolveCreativeProfile(c, { voiceProfile: 'female-senior', voiceTone: 'bright', voiceSpeed: 0.9 }, BUDDHA)
    assert.deepEqual([r.resolved.voiceProfile, r.resolved.voiceTone, r.resolved.voiceSpeed], ['female-senior', 'bright', 0.9], c)
    const v = creativeVoice(r)
    assert.equal(v.voice, LONGFORM_VOICE_PROFILES['female-senior'].voice); assert.equal(v.speed, 0.9); assert.match(v.instructions, /밝고 생기 있게/)
  }
  // the house voice with another tone/speed keeps its own instruction and adds the tone; the speed is the chosen one
  const h = creativeVoice(resolveCreativeProfile('wisdom', { voiceTone: 'neutral', voiceSpeed: 1.1 }, BUDDHA))
  assert.equal(h.voice, DEFAULT_VOICE_PROFILE.voice); assert.ok(h.instructions.startsWith(DEFAULT_VOICE_PROFILE.instructions)); assert.match(h.instructions, /자연스럽고 또렷한/); assert.equal(h.speed, 1.1)
  const sent: any[] = []
  await openAiTts('문장', 'k', h, (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(Buffer.from('x'), { status: 200 }) }) as any)
  assert.equal(sent[0].speed, 1.1); assert.equal(sent[0].voice, 'marin')
  for (const bad of [{ voiceProfile: 'marin' }, { voiceTone: 'loud' }, { voiceSpeed: 1.05 }, { visualStyleProfile: 'anime' }]) assert.throws(() => resolveCreativeProfile('wisdom_longform', bad, BUDDHA))
})

test('A6-8: the TTS cache key changes with the voice, the tone or the speed; same choice -> same key', () => {
  const key = (c: CreativeContent, input: any) => ttsCacheIdentity(creativeVoice(resolveCreativeProfile(c, input, BUDDHA)), '같은 문장')
  for (const c of CONTENTS) {
    const a = key(c, { voiceProfile: 'male-middle' })
    assert.notEqual(a, key(c, { voiceProfile: 'female-middle' }))
    assert.notEqual(a, key(c, { voiceProfile: 'male-middle', voiceTone: 'bright' }))
    assert.notEqual(a, key(c, { voiceProfile: 'male-middle', voiceSpeed: 1.1 }))
    assert.equal(a, key(c, { voiceProfile: 'male-middle' }))
  }
  // house voice: calm/1.0 keeps the legacy key; another tone or speed is another key
  assert.equal(key('wisdom', {}), 'tts-v1|같은 문장')
  assert.notEqual(key('wisdom', { voiceTone: 'bright' }), key('wisdom', {}))
  assert.notEqual(key('wisdom', { voiceSpeed: 0.9 }), key('wisdom', {}))
})

test('A9-10: legacy Wisdom Shorts voice and legacy Longform jobs are unchanged', async () => {
  const sent: any[] = []
  const f: any = async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(Buffer.from('x'), { status: 200 }) }
  await openAiWisdomTts('같은 문장', 'k', f)
  await openAiTts('같은 문장', 'k', briefVoice(normalizeGenerativeBrief({ kind: 'topic', text: '말을 아끼는 사람', targetSeconds: 40 }) as any, 'wisdom'), f)
  assert.deepEqual(sent[1], sent[0], 'a new AUTO Wisdom Shorts job sends exactly the old request')
  assert.equal(briefVoice({}, 'wisdom'), DEFAULT_VOICE_PROFILE) // a brief from before Creative Settings
  // Longform briefs from before: voice selection only -> that profile (cache key unchanged); nothing -> the default
  assert.equal(briefVoice({ voice: { key: 'female-senior' } }, 'wisdom_longform'), LONGFORM_VOICE_PROFILES['female-senior'])
  assert.equal(ttsCacheIdentity(briefVoice({ voice: { key: 'female-senior' } }, 'wisdom_longform'), '문'), 'tts-v2|ko-lf-female-senior-v1|문')
  assert.equal(briefVoice({}, 'wisdom_longform'), DEFAULT_VOICE_PROFILE)
})

test('B11-12: AUTO picture style per content type; an explicit style always wins; a source video has no picture style', () => {
  assert.equal(resolveCreativeProfile('wisdom', {}, BUDDHA).resolved.visualStyleProfile, 'wisdom-painterly')
  assert.equal(resolveCreativeProfile('wisdom_longform', {}, BUDDHA).resolved.visualStyleProfile, 'wisdom-painterly')
  assert.equal(resolveCreativeProfile('senior_longform', {}, FAMILY).resolved.visualStyleProfile, 'senior-warm-watercolor')
  for (const c of ['wisdom', 'wisdom_longform', 'senior_longform'] as CreativeContent[]) for (const k of VISUAL_STYLE_KEYS) assert.equal(resolveCreativeProfile(c, { visualStyleProfile: k }, BUDDHA).resolved.visualStyleProfile, k)
  // B16: source Shorts never restyle the source video, whatever is asked
  assert.equal(resolveCreativeProfile('source_shorts', { visualStyleProfile: 'senior-warm-watercolor' }, '').resolved.visualStyleProfile, null)
  assert.equal(PROFILES.source_shorts.features.includes('IMAGE'), false)
  // every style has the registry fields; no planner writes a style of its own
  // every text style has its words; a Golden Style has none (its locked reference picture is the style: goldenStyle.ts)
  for (const s of Object.values(VISUAL_STYLE_PROFILES)) for (const k of s.golden ? ['id', 'label'] : ['id', 'label', 'promptPrefix', 'negativePrompt', 'compositionHints']) assert.ok(String((s as any)[k]).length >= 2, `${s.id}.${k}`)
})

const wisdomFixture = () => {
  const beats = Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, narration: [`관계의 숫자보다 마음의 깊이를 보세요.`, `많은 관계는 때로 마음을 지치게 합니다.`, `하지만 중요한 건 서로를 편안하게 하는 깊이입니다.`, `관계는 숫자보다 깊이가 오래 남습니다.`][i], visualGoal: `goal ${i + 1}`, imagePrompt: `scene ${i + 1}`, durationSec: 10 }))
  const script: any = { schema: 'wisdom-script/1', title: '관계의 깊이', hook: '많은 사람이 꼭 필요할까요?', beats, ending: '편안한 몇 사람이면 충분합니다.', totalSeconds: 40 }
  const bible: any = { schema: 'wisdom-visual-bible/1', style: 'planner painterly style', palette: 'warm muted', lighting: 'soft', composition: 'single focus', characterPolicy: 'consistent recurring person', negative: 'text, watermark' }
  return { script, bible }
}
async function wisdomPlan(input: any) {
  const blobs = createMemoryBlobStore(), brief = normalizeGenerativeBrief({ kind: 'text', text: '관계는 숫자보다 깊이가 중요합니다.', targetSeconds: 40, ...input }); await blobs.putJson('brief.json', brief)
  const { script, bible } = wisdomFixture()
  const out: any = await createGenerativePlanExecutor({ apiKey: 'test', plan: async () => ({ script, visualBible: bible }) }).run({ job: { id: 'j', profile: 'wisdom', planRef: 'brief.json', sourceAssetId: 'src_gen_x' } as any, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  return { out, saved: (await blobs.getJson(out.result.scriptRef)) as any, script, bible }
}

test('B13-15: the resolved profile is stored (brief + PLAN); the picture prompt carries the style; another style = another image key', async () => {
  // Wisdom Shorts AUTO: the prompts are exactly the planner's (the Wisdom style as before)
  const auto = await wisdomPlan({})
  assert.deepEqual(auto.out.result.creative.resolved, { voiceProfile: 'house', voiceTone: 'calm', voiceSpeed: 1, voiceProfileId: 'ko-calm-clear-v1', visualStyleProfile: 'wisdom-painterly' })
  assert.deepEqual(auto.saved.beats.map((b: any) => b.imagePrompt), anchorNamedThinkerVisual(applyVisualBible(auto.script, auto.bible), '관계는 숫자보다 깊이가 중요합니다.').script.beats.map((b: any) => b.imagePrompt))
  // explicit 밝은 일러스트: the registry style replaces the planner's style line (Screen DNA framing + scene stay)
  const bright = await wisdomPlan({ visualStyleProfile: 'bright-editorial' })
  for (const b of bright.saved.beats) {
    assert.ok(b.imagePrompt.startsWith(VISUAL_STYLE_PROFILES['bright-editorial'].promptPrefix), b.imagePrompt.slice(0, 80))
    assert.doesNotMatch(b.imagePrompt, /planner painterly style/); assert.match(b.imagePrompt, /center-safe for a 1080x1200/); assert.match(b.imagePrompt, /dark muddy colors/)
  }
  assert.notEqual(bright.saved.beats[0].imagePrompt, auto.saved.beats[0].imagePrompt) // -> another image-v1|prompt key
  assert.equal(styledVisualBible(auto.bible, null), auto.bible)
  // Wisdom Longform: AUTO = the exact prompt as before; an explicit style keeps the mandatory figure-right composition
  const lf = normalizeLongformBrief({ kind: 'topic', text: BUDDHA, targetSeconds: 3600 })
  assert.equal(creativeStyleOverride(lf.creative), null)
  const s: any = { figure: { imagePrompt: 'Gautama Buddha' } }
  const legacy = longformImagePrompt(s), styled = longformImagePrompt(s, creativeStyleOverride(normalizeLongformBrief({ kind: 'topic', text: BUDDHA, targetSeconds: 3600, visualStyleProfile: 'realistic-documentary' }).creative))
  assert.match(legacy, /^Wide 16:9 cinematic still .*Painterly realistic portrait/)
  assert.match(styled, /^Content: .*Style: Realistic documentary-style.*Composition: MANDATORY: the person in the RIGHT third.*Avoid: cartoon/)
  assert.notEqual(legacy, styled)
  // the composer order: content -> style -> composition -> characters -> negative
  const p = composeImagePrompt({ content: 'C', style: VISUAL_STYLE_PROFILES['senior-warm-watercolor'], composition: 'K', characters: ['X'], negative: 'N' })
  const at = ['Content:', 'Style:', 'Composition:', 'Characters', 'Avoid:'].map((k) => p.indexOf(k))
  assert.deepEqual([...at].sort((a, b) => a - b), at); assert.ok(at.every((i) => i >= 0))
  // the voice resolved at job_create is what ASSET narrates with (no second AUTO decision)
  const sb = normalizeLongformBrief({ kind: 'topic', text: FAMILY, targetSeconds: 3600 }, 'senior_longform')
  assert.equal(briefVoice(sb, 'senior_longform').id, sb.creative!.resolved.voiceProfileId)
  assert.equal(creativeVoiceFor('senior_longform', sb.creative!.resolved).id, 'ko-lf-female-senior-calm-1.0-v2') // 어머니 -> female-senior (topic rule)
})

test('voice preview resolves through the same resolver: AUTO follows the content type (Wisdom Shorts house voice, Senior mature voice)', async () => {
  const { previewVoice } = await import('../lib/generative/voicePreview.js')
  assert.equal(previewVoice({ profile: 'wisdom' }), DEFAULT_VOICE_PROFILE)
  assert.equal(previewVoice({ profile: 'senior_longform', topic: YOUTH }).id, 'ko-lf-male-middle-calm-1.0-v2')
  assert.equal(previewVoice({ voiceProfile: 'auto', topic: BUDDHA }).id, 'ko-lf-male-senior-calm-1.0-v2') // default: Wisdom Longform
  assert.throws(() => previewVoice({ profile: 'source_shorts' }), /no voice preview/)
  assert.throws(() => previewVoice({ profile: 'nope' }), /no voice preview/)
})

test('야담 그림체: the reference contract by default (+ Golden 1~5), no other 야담 style can be chosen; the scene prompt says only what is shown, with the Joseon LOCK', async () => {
  const { creativeStylesFor } = await import('../lib/generative/creativeProfile.js')
  const { YADAM_STYLE_ID } = await import('../lib/generative/yadamStyle.js')
  const { yasaScenePrompt, JOSEON_LOCK, JOSEON_FORBIDDEN } = await import('../lib/generative/yasaLongform.js')
  for (const c of ['yasa_longform', 'yasa_shorts'] as const) {
    assert.deepEqual([...creativeStylesFor(c)], [YADAM_STYLE_ID, 'golden-1', 'golden-2', 'golden-3', 'golden-4', 'golden-5']); assert.equal(creativeAutoDefaults(c).visualStyleProfile, YADAM_STYLE_ID)
    for (const old of ['korean_drama_illustration', 'webtoon_historical', 'historical-dramatic', 'senior-warm-watercolor']) assert.throws(() => resolveCreativeProfile(c, { visualStyleProfile: old }, ''), /visualStyleProfile/)
  }
  assert.deepEqual(creativeAutoDefaults('yasa_longform'), { voiceProfile: 'female-senior', voiceTone: 'calm', voiceSpeed: 1, voiceProfileId: 'ko-lf-female-senior-calm-1.0-yadam-v1', visualStyleProfile: YADAM_STYLE_ID })
  assert.equal(resolveCreativeProfile('yasa_longform', { voiceSpeed: 0.9 }, '').resolved.voiceSpeed, 0.9, '0.9x only when chosen')
  // other contents keep their list and AUTO (the 야담 style is not offered to them)
  assert.ok(!creativeStylesFor('senior_longform').includes(YADAM_STYLE_ID)); assert.equal(creativeAutoDefaults('senior_longform').visualStyleProfile, 'senior-warm-watercolor')
  const script: any = { characters: [{ id: 'bride', name: '윤씨', role: 'r', age: 22, gender: 'female', appearance: 'oval face', hair: 'long braid', outfit: 'pale pink hanbok', props: '' }], yasaStoryDNA: { setting: { region: '조선', era: '후기 (18세기)' }, mystery: { concreteProp: '메주' } } }
  const scene: any = { id: 's1', place: '부엌 앞', time: '아침', characters: ['bride'], action: '메주를 든다', mood: '진지', visual: 'a bride holds a block of meju' }
  const p = yasaScenePrompt(script, scene), at = (x: string) => p.indexOf(x)
  assert.ok(at('Content:') < at(JOSEON_LOCK) && at(JOSEON_LOCK) < at('Characters') && at('Characters') < at('Framing:') && at('Framing:') < at('Never show:'), 'scene -> era LOCK -> Character Bible -> framing -> content negatives')
  assert.ok(p.includes(JOSEON_FORBIDDEN) && p.includes('pale pink hanbok'))
  assert.doesNotMatch(p, /Style:|watercolor|storybook|painterly|illustration|webtoon|muted|sepia|photo/i, 'no style words in the content prompt')
  assert.ok(!yasaScenePrompt({ ...script, yasaStoryDNA: { setting: { region: '당나라', era: '8세기 중국' } } }, scene).includes(JOSEON_LOCK), 'a story set elsewhere is not forced into Joseon')
})
