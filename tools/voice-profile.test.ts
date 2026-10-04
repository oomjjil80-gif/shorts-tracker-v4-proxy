import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VOICE_PROFILE } from '../lib/generative/voiceProfile.js'
import { openAiTts, openAiWisdomTts } from '../lib/generative/providers.js'

const fakeFetch = (seen:any[]) => (async (_url:any, init:any) => {
  seen.push(JSON.parse(String(init.body)))
  return new Response(Buffer.from('mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
}) as typeof fetch

test('shared voice profile locks the current Korean narration voice', () => {
  assert.deepEqual(DEFAULT_VOICE_PROFILE, {
    id: 'ko-calm-clear-v1',
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    instructions: '한국어로 차분하고 따뜻하게, 과장하지 말고 또렷하게 읽어주세요.',
    speed: 1,
    responseFormat: 'mp3'
  })
})

test('Wisdom compatibility wrapper and common TTS send the same provider request', async () => {
  const a:any[] = [], b:any[] = []
  await openAiWisdomTts('같은 문장', 'key', fakeFetch(a))
  await openAiTts('같은 문장', 'key', DEFAULT_VOICE_PROFILE, fakeFetch(b))
  assert.deepEqual(a, b)
})
