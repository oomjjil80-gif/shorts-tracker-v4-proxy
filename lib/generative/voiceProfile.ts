export type VoiceProfile = {
  id: string
  model: 'gpt-4o-mini-tts'
  voice: 'marin'
  instructions: string
  speed: number
  responseFormat: 'mp3'
}

// One shared narration voice contract. Shorts and Longform use this same default;
// future profiles should select/override a VoiceProfile instead of embedding provider settings.
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
