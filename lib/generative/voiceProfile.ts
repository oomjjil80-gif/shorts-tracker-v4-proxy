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
