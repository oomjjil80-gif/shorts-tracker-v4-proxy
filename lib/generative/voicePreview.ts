// Wisdom Longform voice preview: one short sentence spoken with the chosen (voice, tone, speed). Made by ONE TTS call
// the first time a combination is asked for and stored as a private object; every later request (any user, any job)
// is a cache HIT with 0 provider calls. At most 6 voices x 3 tones x 3 speeds = 54 previews can ever exist.
// No automatic retry: a billing/auth error stops at once; any other failure is reported and the user may press again.
import { createHash } from 'node:crypto'
import type { JobBlobStore } from '../jobs/blobs.js'
import { classifyOpenAiError } from './longformResearch.js'
import { recommendLongformVoice, resolveLongformRuntimeVoice, parseLongformTone, parseLongformSpeed, LONGFORM_VOICE_CHOICES, type LongformVoiceKey, type VoiceProfile } from './voiceProfile.js'

export const VOICE_PREVIEW_VERSION = 'longform-voice-preview/1'
export const VOICE_PREVIEW_TEXT = '오늘도 편안한 마음으로, 천천히 이야기를 시작해보겠습니다.'
export type PreviewTts = (text: string, apiKey: string, profile: VoiceProfile) => Promise<{ bytes: Buffer; contentType: string }>
export type VoicePreviewResult = { playbackUrl: string; validUntil: number; cache: 'HIT' | 'MISS' }

export const voicePreviewPath = (p: VoiceProfile) =>
  `voice-preview/${createHash('sha256').update([VOICE_PREVIEW_VERSION, p.id, p.voice, p.instructions, p.speed, VOICE_PREVIEW_TEXT].join('|')).digest('hex')}.mp3`

export class PreviewError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'PreviewError' } }

// the request -> the runtime voice (the provider voice id never leaves the server); 'auto' follows the topic rule
export function previewVoice(input: any): VoiceProfile {
  const choice = String(input?.voiceProfile ?? 'auto')
  if (!(LONGFORM_VOICE_CHOICES as readonly string[]).includes(choice)) throw new PreviewError('BAD_REQUEST', `voiceProfile must be one of ${LONGFORM_VOICE_CHOICES.join(', ')}`)
  const key = (choice === 'auto' ? recommendLongformVoice(String(input?.topic || '')) : choice) as LongformVoiceKey
  try { return resolveLongformRuntimeVoice({ voiceKey: key, tone: parseLongformTone(input?.voiceTone), speed: parseLongformSpeed(input?.voiceSpeed) }) }
  catch (e: any) { throw new PreviewError('BAD_REQUEST', String(e?.message || e)) }
}

export function createVoicePreview(deps: { blobs: JobBlobStore; tts: PreviewTts; apiKey?: () => string; log?: (line: string) => void }) {
  const inflight = new Map<string, Promise<VoicePreviewResult>>() // the same preview asked twice at once: made once
  const log = deps.log ?? ((l: string) => console.log(l))
  const sign = async (path: string) => {
    const s = await deps.blobs.presign?.(path, 30 * 60_000)
    if (!s) throw new PreviewError('PREVIEW_FAILED', 'playback URL unavailable')
    return s
  }
  async function make(profile: VoiceProfile, path: string): Promise<VoicePreviewResult> {
    const marker = `${path.replace(/\.mp3$/, '')}.json`
    if (await deps.blobs.getJson(marker).catch(() => null)) {
      const s = await sign(path)
      log(`[voice-preview] ${JSON.stringify({ cache: 'HIT', profile: profile.id, ttsCalls: 0 })}`)
      return { playbackUrl: s.url, validUntil: s.validUntil, cache: 'HIT' }
    }
    const apiKey = deps.apiKey?.() ?? process.env.OPENAI_API_KEY ?? ''
    if (!apiKey) throw new PreviewError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured')
    let audio: { bytes: Buffer; contentType: string }
    try { audio = await deps.tts(VOICE_PREVIEW_TEXT, apiKey, profile) }
    catch (e: any) {
      const m = /failed (\d{3}): ([\s\S]*)$/.exec(String(e?.message || ''))
      const c = m ? classifyOpenAiError(Number(m[1]), m[2]) : null
      const code = c?.stop ? (/quota|credit_balance/.test(c.code) ? 'PROVIDER_BILLING' : 'PROVIDER_STOP') : 'PREVIEW_FAILED'
      log(`[voice-preview] ${JSON.stringify({ cache: 'MISS', profile: profile.id, ttsCalls: 1, code: c?.code ?? code })}`)
      throw new PreviewError(code, code === 'PREVIEW_FAILED' ? '미리듣기를 만들지 못했습니다. 잠시 후 다시 눌러주세요.' : '음성 서비스를 지금 사용할 수 없습니다.')
    }
    if (!audio?.bytes?.length) throw new PreviewError('PREVIEW_FAILED', 'empty preview audio')
    await deps.blobs.putBytes(path, audio.bytes, 'audio/mpeg')
    await deps.blobs.putJson(marker, { ref: path, profile: profile.id, bytes: audio.bytes.length, version: VOICE_PREVIEW_VERSION })
    const s = await sign(path)
    log(`[voice-preview] ${JSON.stringify({ cache: 'MISS', profile: profile.id, ttsCalls: 1 })}`)
    return { playbackUrl: s.url, validUntil: s.validUntil, cache: 'MISS' }
  }
  return async function preview(input: any): Promise<VoicePreviewResult> {
    const profile = previewVoice(input), path = voicePreviewPath(profile)
    const running = inflight.get(path)
    if (running) return running
    const p = make(profile, path).finally(() => inflight.delete(path))
    inflight.set(path, p)
    return p
  }
}
