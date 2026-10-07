// The single place where narration voices are defined: provider voice ids and speaking instructions live ONLY here.
// UI strings never carry provider values; jobs carry a choice key (e.g. 'female-middle') and its resolved profile id.
export type VoiceProfile = {
  id: string
  model: 'gpt-4o-mini-tts'
  voice: 'marin' | 'cedar' | 'ash' | 'onyx' | 'nova' | 'sage'
  instructions: string
  speed: number
  responseFormat: 'mp3'
}

// One shared narration voice contract. Wisdom Shorts uses this default (unchanged); Longform jobs created before voice
// selection existed also keep it (and their original TTS cache keys).
export const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  id: 'ko-calm-clear-v1',
  model: 'gpt-4o-mini-tts',
  voice: 'marin',
  instructions: '한국어로 차분하고 따뜻하게, 과장하지 말고 또렷하게 읽어주세요.',
  speed: 1,
  responseFormat: 'mp3'
}

export const GENERAL_SHORTS_DEFAULT_VOICE_PROFILE: VoiceProfile = {
  id: 'ko-general-shorts-v1',
  model: 'gpt-4o-mini-tts',
  voice: 'marin',
  instructions: '한국어 쇼츠 더빙처럼 자연스럽고 친근하게 읽어주세요. 화면을 설명하듯 딱딱하게 읽지 말고, 관계와 감정의 의미가 살아나도록 가볍게 리듬을 주세요. 과장된 광고 톤은 피해주세요.',
  speed: 1.05,
  responseFormat: 'mp3'
}

// ---------------- Wisdom Longform voice selection ----------------
export const LONGFORM_VOICE_CHOICES = ['auto', 'male-young', 'male-middle', 'male-senior', 'female-young', 'female-middle', 'female-senior'] as const
export type LongformVoiceChoice = (typeof LONGFORM_VOICE_CHOICES)[number]
export type LongformVoiceKey = Exclude<LongformVoiceChoice, 'auto'>
const lf = (key: LongformVoiceKey, voice: VoiceProfile['voice'], instructions: string, speed = 1): VoiceProfile =>
  ({ id: `ko-lf-${key}-v1`, model: 'gpt-4o-mini-tts', voice, instructions, speed, responseFormat: 'mp3' })
const CALM = '긴 강연을 듣는 사람이 편안하게 끝까지 들을 수 있도록, 과장 없이 또렷하고 일정한 속도로 읽어주세요.'
export const LONGFORM_VOICE_PROFILES: Readonly<Record<LongformVoiceKey, VoiceProfile>> = {
  'male-young': lf('male-young', 'ash', `20~30대 한국 남성의 맑고 성실한 목소리로 읽어주세요. ${CALM}`),
  'male-middle': lf('male-middle', 'cedar', `40~50대 한국 남성의 안정감 있고 신뢰감 있는 낮은 목소리로 읽어주세요. ${CALM}`),
  'male-senior': lf('male-senior', 'onyx', `60~70대 한국 남성 어른이 조용히 지혜를 들려주듯, 깊고 느긋한 목소리로 읽어주세요. ${CALM}`, 0.95),
  'female-young': lf('female-young', 'nova', `20~30대 한국 여성의 밝고 다정한 목소리로 읽어주세요. ${CALM}`),
  'female-middle': lf('female-middle', 'marin', `40~50대 한국 여성의 차분하고 따뜻한, 공감하는 목소리로 읽어주세요. ${CALM}`),
  'female-senior': lf('female-senior', 'sage', `60~70대 한국 여성 어른이 손주에게 이야기하듯, 부드럽고 깊이 있는 목소리로 읽어주세요. ${CALM}`, 0.95)
}
// 'auto': ONE profile chosen from the topic's character (the rule is fixed and testable; no model call).
const AUTO_RULES: Array<[RegExp, LongformVoiceKey]> = [
  [/부처|붓다|석가|불교|불경|법구경|명상|선(?:禪|불)|스님|노자|장자|공자|논어|buddha|zen/i, 'male-senior'],
  [/쇼펜하우어|니체|소크라테스|세네카|마르쿠스|철학|스토아|stoic/i, 'male-middle'],
  [/청춘|도전|성공|습관|동기|자기계발|공부|20대|30대/, 'male-young'],
  [/할머니|어머니|엄마|노후|황혼|인생 후반/, 'female-senior'],
  [/위로|마음|관계|사랑|외로움|가족|상처|감정|공감/, 'female-middle']
]
export function recommendLongformVoice(topic: string, fallback: LongformVoiceKey = 'female-middle'): LongformVoiceKey {
  return AUTO_RULES.find(([re]) => re.test(String(topic || '')))?.[1] ?? fallback
}
// Tone (말투) and speed (속도) the user picks for a Longform voice. The tone is spoken style only (no pitch DSP): it is
// added to the profile's own instruction, which is kept, so the gender/age character stays the same.
export const LONGFORM_VOICE_TONES = ['calm', 'neutral', 'bright'] as const
export type LongformVoiceTone = (typeof LONGFORM_VOICE_TONES)[number]
export const LONGFORM_VOICE_SPEEDS = [0.9, 1, 1.1] as const
export type LongformVoiceSpeed = (typeof LONGFORM_VOICE_SPEEDS)[number]
export const DEFAULT_LONGFORM_TONE: LongformVoiceTone = 'calm'
export const DEFAULT_LONGFORM_SPEED: LongformVoiceSpeed = 1
const TONE_INSTRUCTIONS: Readonly<Record<LongformVoiceTone, string>> = {
  calm: '조용하고 안정적으로, 감정을 과장하지 않고 편안하고 차분한 호흡으로 읽어주세요.',
  neutral: '자연스럽고 또렷한 한국어 말투로, 과장 없이 편안하게 읽어주세요.',
  bright: '조금 더 밝고 생기 있게, 친근하고 자연스러운 리듬으로 읽어주세요. 광고처럼 과장하지 마세요.'
}
export const toneInstruction = (t: LongformVoiceTone) => TONE_INSTRUCTIONS[t]
export function parseLongformTone(v: unknown): LongformVoiceTone {
  const t = String(v ?? DEFAULT_LONGFORM_TONE)
  if (!(LONGFORM_VOICE_TONES as readonly string[]).includes(t)) throw new Error(`voiceTone must be one of ${LONGFORM_VOICE_TONES.join(', ')}`)
  return t as LongformVoiceTone
}
export function parseLongformSpeed(v: unknown): LongformVoiceSpeed {
  const n = v === undefined || v === null || v === '' ? DEFAULT_LONGFORM_SPEED : Number(v)
  const hit = LONGFORM_VOICE_SPEEDS.find((x) => Math.abs(x - n) < 1e-9)
  if (hit === undefined) throw new Error(`voiceSpeed must be one of ${LONGFORM_VOICE_SPEEDS.join(', ')}`)
  return hit
}
// The runtime voice for a (voice, tone, speed) choice. Its id carries all three, so the TTS cache never mixes them.
// The chosen speed is final (it replaces the profile's own speed, e.g. 0.95 of the senior voices).
export function resolveLongformRuntimeVoice(o: { voiceKey: LongformVoiceKey; tone: LongformVoiceTone; speed: LongformVoiceSpeed }): VoiceProfile {
  const base = LONGFORM_VOICE_PROFILES[o.voiceKey]
  if (!base) throw new Error(`unknown Longform voice ${o.voiceKey}`)
  return { ...base, id: `ko-lf-${o.voiceKey}-${o.tone}-${o.speed.toFixed(1)}-v2`, instructions: `${base.instructions} ${TONE_INSTRUCTIONS[o.tone]}`, speed: o.speed }
}
// TTS cache identity: the voice is part of the key, so another voice never reuses this audio. The default voice keeps
// the original key so existing Longform caches stay valid.
export const ttsCacheIdentity = (profile: VoiceProfile, text: string) =>
  profile.id === DEFAULT_VOICE_PROFILE.id ? `tts-v1|${text}` : `tts-v2|${profile.id}|${text}`

// 숨은야담 롱폼 AUTO voice: a grandmother telling an old tale (lib/generative/creativeProfile.ts uses these)
export const YADAM_VOICE = { key: 'female-senior', tone: 'calm', speed: 0.9 } as const
export const YADAM_STORYTELLER = '60~70대 한국 여성 어른이 손주에게 오래된 옛날이야기를 들려주듯 읽어주세요. 따뜻하고 깊은 목소리로, 서두르지 말고 문장과 문장 사이에 호흡이 느껴지게. 감정을 지나치게 연기하지 말고, 중요한 순간은 조금 눌러 읽어주세요. 광고·뉴스·강의 톤은 피해주세요.'

