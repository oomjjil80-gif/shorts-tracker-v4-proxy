// Creative Settings shared by every content type that makes narration (TTS) or pictures (IMAGE): who speaks, in which
// tone and speed, and in which picture style. ONE resolver: job_create turns the user's choices into a resolved profile
// that is stored in the brief ({ requested, resolved }); PLAN / ASSET / RENDER only read `resolved` and never guess again.
// What a user picks always wins; only 'auto' items are decided here, by the content type's rule below (and the topic).
import { GOLDEN_STYLE_IDS, goldenSpec, isGoldenStyle, type GoldenSpec } from './goldenStyle.js'
import {
  DEFAULT_VOICE_PROFILE, GENERAL_SHORTS_DEFAULT_VOICE_PROFILE, LONGFORM_VOICE_CHOICES, LONGFORM_VOICE_PROFILES, recommendLongformVoice, resolveLongformRuntimeVoice,
  parseLongformTone, parseLongformSpeed, toneInstruction, type LongformVoiceKey, type LongformVoiceTone, type LongformVoiceSpeed, type VoiceProfile
} from './voiceProfile.js'
import { VISUAL_STYLE_PROFILES, parseVisualStyle, type VisualStyleKey, type VisualStyleProfile } from './visualStyle.js'
import { YADAM_STYLE_ID, YADAM_STYLE_CONTRACT, YADAM_STYLE_RULES, YADAM_STYLE_TRAITS } from './yadamStyle.js'
import { YADAM_VOICE, YADAM_STORYTELLER } from './voiceProfile.js'

// Server Job profiles (wisdom, wisdom_longform, senior_longform, source_shorts) and the Story Writer content types (a
// content family x format, made in the browser: CUT images through /api/image, narration through CapCut).
export type CreativeContent = 'wisdom' | 'wisdom_longform' | 'senior_longform' | 'source_shorts'
  | 'senior_shorts' | 'yasa_shorts' | 'yasa_longform' | 'general_shorts' | 'general_longform' | 'economy_shorts' | 'economy_longform'
export const CONTENT_FAMILIES = ['senior', 'wisdom', 'yasa', 'general', 'economy'] as const
export type ContentFamily = (typeof CONTENT_FAMILIES)[number]
export type ContentFormat = 'shorts' | 'longform'
// (family, format) -> its content type: the one place the two axes meet
export function creativeContentFor(family: unknown, format: unknown): CreativeContent {
  const fam = String(family), fmt = format === 'longform' ? 'longform' : format === 'shorts' ? 'shorts' : ''
  if (!(CONTENT_FAMILIES as readonly string[]).includes(fam) || !fmt) throw new Error(`unknown content ${fam} / ${String(format)}`)
  if (fam === 'wisdom') return fmt === 'longform' ? 'wisdom_longform' : 'wisdom'
  return `${fam}_${fmt}` as CreativeContent
}
export type CreativeSettings = { voiceProfile: string; voiceTone: LongformVoiceTone; voiceSpeed: LongformVoiceSpeed; visualStyleProfile: string }
// 'house' = the content type's own established voice (Wisdom Shorts, source Shorts): kept byte-for-byte under AUTO.
// visualStyleProfile null = the content type makes no pictures (a source video is never restyled).
// golden: a Golden Style (goldenStyle.ts) is stored with its locked reference hash + prompt version, so the job draws with
// exactly that version for its whole life (a resume, a retry, a remaster child)
export type ResolvedCreativeProfile = { voiceProfile: LongformVoiceKey | 'house'; voiceTone: LongformVoiceTone; voiceSpeed: LongformVoiceSpeed; voiceProfileId: string; visualStyleProfile: VisualStyleKey | null; golden?: GoldenSpec }
export type CreativeProfile = { schema: 'creative-profile/1'; content: CreativeContent; requested: CreativeSettings; resolved: ResolvedCreativeProfile }

// The AUTO rules, per content type, in one table.
//  voice: 'house' keeps the content's established voice; 'topic' picks one of the 6 voices from the topic (`fallback` when
//         no topic rule matches); 'topic-mature' does the same but never a young voice.
//  style: the AUTO picture style; `native` is the style the content's existing prompts already draw (no prompt change).
//  'fixed' = one AUTO voice for the content (`fixed`); `speed` = the AUTO speed when the request names none.
//  styles: the 그림체 this content offers the user (none = the shared list)
type ContentRule = { voice: 'house' | 'topic' | 'topic-mature' | 'fixed'; house?: VoiceProfile; fallback?: LongformVoiceKey; fixed?: LongformVoiceKey; speed?: LongformVoiceSpeed; style: VisualStyleKey | null; native?: VisualStyleKey; styles?: readonly VisualStyleKey[] }
const CONTENT_RULES: Readonly<Record<CreativeContent, ContentRule>> = {
  wisdom: { voice: 'house', house: DEFAULT_VOICE_PROFILE, style: 'wisdom-painterly', native: 'wisdom-painterly' },
  wisdom_longform: { voice: 'topic', style: 'wisdom-painterly', native: 'wisdom-painterly' },
  senior_longform: { voice: 'topic-mature', style: 'senior-warm-watercolor' },
  source_shorts: { voice: 'house', house: GENERAL_SHORTS_DEFAULT_VOICE_PROFILE, style: null },
  senior_shorts: { voice: 'topic-mature', style: 'senior-warm-watercolor' },
  // 야담 (쇼츠 and 롱폼): the ONE reference style contract (yadamStyle.ts); no other 야담 style can be chosen
  yasa_shorts: { voice: 'topic-mature', fallback: 'male-middle', style: YADAM_STYLE_ID, styles: [YADAM_STYLE_ID, ...GOLDEN_STYLE_IDS] },
  // 숨은야담 롱폼: an old tale told by a grandmother (female-senior, calm, 1.0x, the storyteller reading)
  yasa_longform: { voice: 'fixed', fixed: YADAM_VOICE.key, speed: YADAM_VOICE.speed, style: YADAM_STYLE_ID, styles: [YADAM_STYLE_ID, ...GOLDEN_STYLE_IDS] },
  general_shorts: { voice: 'topic', style: 'bright-editorial' },
  general_longform: { voice: 'topic', style: 'bright-editorial' },
  // the economy channel bible already draws a premium documentary/editorial look: AUTO keeps its prompts as they are
  economy_shorts: { voice: 'topic', fallback: 'male-middle', style: 'realistic-documentary', native: 'realistic-documentary' },
  economy_longform: { voice: 'topic', fallback: 'male-middle', style: 'realistic-documentary', native: 'realistic-documentary' }
}
// the 그림체 list a content offers (UI); AUTO resolves to rule.style
export const creativeStylesFor = (content: CreativeContent): readonly VisualStyleKey[] => CONTENT_RULES[content].styles ?? ['senior-warm-watercolor', 'wisdom-painterly', 'historical-dramatic', 'realistic-documentary', 'bright-editorial', ...GOLDEN_STYLE_IDS]
export const isCreativeContent = (c: unknown): c is CreativeContent => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CONTENT_RULES, c)

function autoVoice(content: CreativeContent, topic: string): LongformVoiceKey | 'house' {
  const { voice: rule, fallback, fixed } = CONTENT_RULES[content]
  if (rule === 'house') return 'house'
  if (rule === 'fixed' && fixed) return fixed
  const k = recommendLongformVoice(topic, fallback)
  return rule === 'topic-mature' && k.endsWith('-young') ? (k.replace('-young', '-middle') as LongformVoiceKey) : k
}
// A content type's house voice with a tone/speed: the default tone (calm) at 1.0x is the house voice itself.
function houseVoice(content: CreativeContent, tone: LongformVoiceTone, speed: LongformVoiceSpeed): VoiceProfile {
  const house = CONTENT_RULES[content].house ?? DEFAULT_VOICE_PROFILE
  if (tone === 'calm' && speed === 1) return house
  return { ...house, id: `${house.id}-${tone}-${speed.toFixed(1)}`, instructions: `${house.instructions} ${toneInstruction(tone)}`, speed }
}

export function resolveCreativeProfile(content: CreativeContent, input: any, topic: string): CreativeProfile {
  if (!isCreativeContent(content)) throw new Error(`no creative settings for ${content}`)
  const choice = String(input?.voiceProfile ?? 'auto')
  if (!(LONGFORM_VOICE_CHOICES as readonly string[]).includes(choice)) throw new Error(`voiceProfile must be one of ${LONGFORM_VOICE_CHOICES.join(', ')}`)
  const rule = CONTENT_RULES[content]
  const voiceTone = parseLongformTone(input?.voiceTone), voiceSpeed = parseLongformSpeed(input?.voiceSpeed ?? rule.speed), style = parseVisualStyle(input?.visualStyleProfile)
  const voiceProfile = choice === 'auto' ? autoVoice(content, topic) : (choice as LongformVoiceKey)
  // a content with its own fixed list (야담) never takes another style
  if (rule.styles && style !== 'auto' && !(rule.styles as readonly string[]).includes(style)) throw new Error(`visualStyleProfile must be auto or one of ${rule.styles.join(', ')}`)
  const visualStyleProfile = rule.style === null ? null : style === 'auto' ? rule.style : style
  const resolved: ResolvedCreativeProfile = { voiceProfile, voiceTone, voiceSpeed, voiceProfileId: '', visualStyleProfile, ...(isGoldenStyle(visualStyleProfile) ? { golden: goldenSpec(visualStyleProfile) } : {}) }
  resolved.voiceProfileId = creativeVoiceFor(content, resolved).id
  return { schema: 'creative-profile/1', content, requested: { voiceProfile: choice, voiceTone, voiceSpeed, visualStyleProfile: style }, resolved }
}

// The narration voice of a resolved profile (provider values stay on the server).
export function creativeVoiceFor(content: CreativeContent, r: ResolvedCreativeProfile): VoiceProfile {
  if (r.voiceProfile === 'house') return houseVoice(content, r.voiceTone, r.voiceSpeed)
  const v = resolveLongformRuntimeVoice({ voiceKey: r.voiceProfile, tone: r.voiceTone, speed: r.voiceSpeed })
  // 숨은야담 롱폼 with its grandmother voice reads like an old tale (its own id, so its audio is cached apart)
  if (content === 'yasa_longform' && r.voiceProfile === YADAM_VOICE.key) return { ...v, id: v.id.replace(/-v2$/, '-yadam-v1'), instructions: `${YADAM_STORYTELLER} ${v.instructions}` }
  return v
}
export const creativeVoice = (c: CreativeProfile) => creativeVoiceFor(c.content, c.resolved)
// The picture style to compose with, or null when the content's own (native) prompts already draw this style and must
// stay exactly as they are (Wisdom Shorts / Wisdom Longform under AUTO), or when the content makes no pictures.
export function creativeStyleOverride(c: CreativeProfile | null | undefined): VisualStyleProfile | null {
  const k = c?.resolved?.visualStyleProfile
  if (!c || !k || k === CONTENT_RULES[c.content].native) return null
  return VISUAL_STYLE_PROFILES[k]
}
// the Golden Style a job draws with (the version stored at job_create), or null
export function creativeGolden(c: CreativeProfile | null | undefined): GoldenSpec | null {
  const k = c?.resolved?.visualStyleProfile
  if (!isGoldenStyle(k)) return null
  const g = c!.resolved.golden
  return g && g.id === k ? g : goldenSpec(k)
}
export const creativeStyle = (c: CreativeProfile): VisualStyleProfile | null => (c.resolved.visualStyleProfile ? VISUAL_STYLE_PROFILES[c.resolved.visualStyleProfile] : null)
// what AUTO would pick for a content type (the phone shows it next to "자동 추천")
export const creativeAutoDefaults = (content: CreativeContent, topic = '') => resolveCreativeProfile(content, {}, topic).resolved

// The voice a brief narrates with. New briefs carry `creative`; a Longform brief from before Creative Settings keeps its
// old voice exactly (and so its cached audio): `voice` (voice selection only) -> that profile, nothing -> the default.
export function briefVoice(brief: { creative?: CreativeProfile; voice?: { key?: string } } | null | undefined, content: CreativeContent): VoiceProfile {
  if (brief?.creative?.resolved) return creativeVoice(brief.creative)
  const key = brief?.voice?.key as LongformVoiceKey | undefined
  if (key && LONGFORM_VOICE_PROFILES[key]) return LONGFORM_VOICE_PROFILES[key]
  return CONTENT_RULES[content].house ?? DEFAULT_VOICE_PROFILE
}

// ---------------- Story Writer CUT images (/api/image) ----------------
// The browser sends only keys ({ family, format, requested, resolved? } or { content, ... }); the picture style is applied
// here so the style text has ONE home. resolved (from creative_resolve, stored on the Episode) wins; otherwise the same
// resolver decides. null = nothing to add (no creative settings = a legacy Episode, or the content's native style).
export function imageStyleFor(creative: any): VisualStyleProfile | null {
  if (!creative || typeof creative !== 'object') return null
  const content = isCreativeContent(creative.content) ? creative.content : creativeContentFor(creative.family, creative.format)
  const offeredReq = CONTENT_RULES[content as CreativeContent]?.styles, req = creative.requested ?? {}
  const base = resolveCreativeProfile(content, offeredReq && req.visualStyleProfile && !(offeredReq as readonly string[]).includes(req.visualStyleProfile) ? { ...req, visualStyleProfile: 'auto' } : req, String(creative.topic || ''))
  // a stored style the content no longer offers (an old 야담 Episode) is never used: the content's own style is
  const offered = CONTENT_RULES[content as CreativeContent]?.styles, storedRaw = creative.resolved?.visualStyleProfile as VisualStyleKey | undefined
  const stored = storedRaw && (!offered || (offered as readonly string[]).includes(storedRaw)) ? storedRaw : undefined
  return creativeStyleOverride(stored && VISUAL_STYLE_PROFILES[stored] && base.resolved.visualStyleProfile !== null ? { ...base, resolved: { ...base.resolved, visualStyleProfile: stored } } : base)
}
// Visual Style Profile = the base art style (medium, brushwork, light); the channel/episode bible and the CUT scene
// that follow keep their roles (characters, brand, composition, recurring rules, what this CUT shows). Neither is dropped.
// The text around a prompt for a style (also handed to the browser for prompts the user copies to Gemini by hand, kept
// in memory there and never stored): the style block before, the style negatives after.
export function visualStyleWrap(style: VisualStyleProfile | null): { head: string; tail: string } | null {
  if (!style) return null
  // 야담: the one contract's own text (the same words /api/image and the jobs send); a hand-copied prompt also needs the
  // 3 reference frames attached — the text alone is not the style
  if (style.id === YADAM_STYLE_ID) return { head: [YADAM_STYLE_CONTRACT, YADAM_STYLE_TRAITS].join('\n\n'), tail: `${YADAM_STYLE_RULES}\n[ATTACH] the 3 야담 style reference frames (assets/style-reference/yadam/sent) as the style reference images.` }
  return {
    head: [
      `[VISUAL STYLE PROFILE — BASE ART STYLE: ${style.id}]`,
      `Style: ${style.promptPrefix}. ${style.compositionHints}.`,
      'STYLE PRIORITY: render the whole image in this style. The channel/episode visual bible below still decides characters, brand, composition and recurring rules, and the CUT scene decides what is shown; only rendering-medium words in them (e.g. 3D animation, photorealistic) yield to this style.'
    ].join('\n'),
    tail: `[VISUAL STYLE NEGATIVE] Avoid: ${style.negativePrompt}.`
  }
}
export function withVisualStyle(prompt: string, style: VisualStyleProfile | null): string {
  const w = visualStyleWrap(style)
  return w ? [w.head, '', prompt, '', w.tail].join('\n') : prompt
}
