// Creative Settings shared by every content type that makes narration (TTS) or pictures (IMAGE): who speaks, in which
// tone and speed, and in which picture style. ONE resolver: job_create turns the user's choices into a resolved profile
// that is stored in the brief ({ requested, resolved }); PLAN / ASSET / RENDER only read `resolved` and never guess again.
// What a user picks always wins; only 'auto' items are decided here, by the content type's rule below (and the topic).
import {
  DEFAULT_VOICE_PROFILE, GENERAL_SHORTS_DEFAULT_VOICE_PROFILE, LONGFORM_VOICE_CHOICES, LONGFORM_VOICE_PROFILES, recommendLongformVoice, resolveLongformRuntimeVoice,
  parseLongformTone, parseLongformSpeed, toneInstruction, type LongformVoiceKey, type LongformVoiceTone, type LongformVoiceSpeed, type VoiceProfile
} from './voiceProfile.js'
import { VISUAL_STYLE_PROFILES, parseVisualStyle, type VisualStyleKey, type VisualStyleProfile } from './visualStyle.js'

export type CreativeContent = 'wisdom' | 'wisdom_longform' | 'senior_longform' | 'source_shorts'
export type CreativeSettings = { voiceProfile: string; voiceTone: LongformVoiceTone; voiceSpeed: LongformVoiceSpeed; visualStyleProfile: string }
// 'house' = the content type's own established voice (Wisdom Shorts, source Shorts): kept byte-for-byte under AUTO.
// visualStyleProfile null = the content type makes no pictures (a source video is never restyled).
export type ResolvedCreativeProfile = { voiceProfile: LongformVoiceKey | 'house'; voiceTone: LongformVoiceTone; voiceSpeed: LongformVoiceSpeed; voiceProfileId: string; visualStyleProfile: VisualStyleKey | null }
export type CreativeProfile = { schema: 'creative-profile/1'; content: CreativeContent; requested: CreativeSettings; resolved: ResolvedCreativeProfile }

// The AUTO rules, per content type, in one table.
//  voice: 'house' keeps the content's established voice; 'topic' picks one of the 6 voices from the topic;
//         'topic-mature' does the same but never a young voice (senior viewers).
//  style: the AUTO picture style; `native` is the style the content's existing prompts already draw (no prompt change).
const CONTENT_RULES: Readonly<Record<CreativeContent, { voice: 'house' | 'topic' | 'topic-mature'; house?: VoiceProfile; style: VisualStyleKey | null; native?: VisualStyleKey }>> = {
  wisdom: { voice: 'house', house: DEFAULT_VOICE_PROFILE, style: 'wisdom-painterly', native: 'wisdom-painterly' },
  wisdom_longform: { voice: 'topic', style: 'wisdom-painterly', native: 'wisdom-painterly' },
  senior_longform: { voice: 'topic-mature', style: 'senior-warm-watercolor' },
  source_shorts: { voice: 'house', house: GENERAL_SHORTS_DEFAULT_VOICE_PROFILE, style: null }
}
export const isCreativeContent = (c: unknown): c is CreativeContent => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CONTENT_RULES, c)

function autoVoice(content: CreativeContent, topic: string): LongformVoiceKey | 'house' {
  const rule = CONTENT_RULES[content].voice
  if (rule === 'house') return 'house'
  const k = recommendLongformVoice(topic)
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
  const voiceTone = parseLongformTone(input?.voiceTone), voiceSpeed = parseLongformSpeed(input?.voiceSpeed), style = parseVisualStyle(input?.visualStyleProfile)
  const rule = CONTENT_RULES[content]
  const voiceProfile = choice === 'auto' ? autoVoice(content, topic) : (choice as LongformVoiceKey)
  const visualStyleProfile = rule.style === null ? null : style === 'auto' ? rule.style : style
  const resolved: ResolvedCreativeProfile = { voiceProfile, voiceTone, voiceSpeed, voiceProfileId: '', visualStyleProfile }
  resolved.voiceProfileId = creativeVoiceFor(content, resolved).id
  return { schema: 'creative-profile/1', content, requested: { voiceProfile: choice, voiceTone, voiceSpeed, visualStyleProfile: style }, resolved }
}

// The narration voice of a resolved profile (provider values stay on the server).
export function creativeVoiceFor(content: CreativeContent, r: ResolvedCreativeProfile): VoiceProfile {
  return r.voiceProfile === 'house' ? houseVoice(content, r.voiceTone, r.voiceSpeed) : resolveLongformRuntimeVoice({ voiceKey: r.voiceProfile, tone: r.voiceTone, speed: r.voiceSpeed })
}
export const creativeVoice = (c: CreativeProfile) => creativeVoiceFor(c.content, c.resolved)
// The picture style to compose with, or null when the content's own (native) prompts already draw this style and must
// stay exactly as they are (Wisdom Shorts / Wisdom Longform under AUTO), or when the content makes no pictures.
export function creativeStyleOverride(c: CreativeProfile | null | undefined): VisualStyleProfile | null {
  const k = c?.resolved?.visualStyleProfile
  if (!c || !k || k === CONTENT_RULES[c.content].native) return null
  return VISUAL_STYLE_PROFILES[k]
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
