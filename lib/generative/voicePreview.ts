// Wisdom Longform voice preview: one short sentence spoken with the chosen (voice, tone, speed). Made by ONE TTS call
// the first time a combination is asked for and stored as a private object; every later request (any user, any job)
// is a cache HIT with 0 provider calls. At most 6 voices x 3 tones x 3 speeds = 54 previews can ever exist.
// No automatic retry: a billing/auth error stops at once; any other failure is reported and the user may press again.
import { createHash } from 'node:crypto'
import type { JobBlobStore } from '../jobs/blobs.js'
import { classifyOpenAiError } from './longformResearch.js'
import { readFlight, claimFlight, recordFlight } from './paidFlight.js'
import type { VoiceProfile } from './voiceProfile.js'
import { resolveCreativeProfile, creativeVoice, isCreativeContent, creativeContentFor } from './creativeProfile.js'

export const VOICE_PREVIEW_VERSION = 'longform-voice-preview/1'
export const VOICE_PREVIEW_TEXT = '오늘도 편안한 마음으로, 천천히 이야기를 시작해보겠습니다.'
export type PreviewTts = (text: string, apiKey: string, profile: VoiceProfile) => Promise<{ bytes: Buffer; contentType: string }>
// beforeProvider: 캐시 미스일 때만, 공급자를 부르기 전에 실행된다(서버 견적·승인). 던지면 호출하지 않는다.
export type PreviewContext = { beforeProvider?: () => Promise<void> }
export type VoicePreviewResult = { playbackUrl: string; validUntil: number; cache: 'HIT' | 'MISS' }

export const voicePreviewPath = (p: VoiceProfile) =>
  `voice-preview/${createHash('sha256').update([VOICE_PREVIEW_VERSION, p.id, p.voice, p.instructions, p.speed, VOICE_PREVIEW_TEXT].join('|')).digest('hex')}.mp3`

export class PreviewError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'PreviewError' } }

// the request -> the runtime voice through the ONE Creative resolver (the provider voice id never leaves the server);
// 'auto' follows the content type's rule (`profile`, default Wisdom Longform) and the topic
export function previewVoice(input: any): VoiceProfile {
  // a server profile (wisdom, senior_longform, ...) or a content family + format (Story Writer); default Wisdom Longform
  let content: unknown = input?.profile === undefined ? 'wisdom_longform' : input.profile
  if (input?.family !== undefined) { try { content = creativeContentFor(input.family, input.format) } catch (e: any) { throw new PreviewError('BAD_REQUEST', String(e?.message || e)) } }
  if (!isCreativeContent(content) || content === 'source_shorts') throw new PreviewError('BAD_REQUEST', 'profile has no voice preview')
  try { return creativeVoice(resolveCreativeProfile(content, input, String(input?.topic || ''))) }
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
  async function make(profile: VoiceProfile, path: string, ctx: PreviewContext): Promise<VoicePreviewResult> {
    const marker = `${path.replace(/\.mp3$/, '')}.json`
    // 캐시 조회·저장소 오류는 "없음"이 아니다: 확인할 수 없으면 유료 호출을 하지 않는다.
    const readMarker = async () => { try { return await deps.blobs.getJson(marker) } catch { throw new PreviewError('PREVIEW_FAILED', '미리듣기 저장소를 확인하지 못해 호출하지 않았습니다. 잠시 후 다시 눌러주세요.') } }
    const hit = async () => { const s = await sign(path); log(`[voice-preview] ${JSON.stringify({ cache: 'HIT', profile: profile.id, ttsCalls: 0 })}`); return { playbackUrl: s.url, validUntil: s.validUntil, cache: 'HIT' as const } }
    if (await readMarker()) return hit()
    // 이전에 음성 파일은 저장됐지만 표식만 없는 경우: 다시 만들지 않고 표식만 복구한다(무과금).
    let existing: Buffer | null
    try { existing = await deps.blobs.getBytes(path) } catch { throw new PreviewError('PREVIEW_FAILED', '미리듣기 저장소를 확인하지 못해 호출하지 않았습니다. 잠시 후 다시 눌러주세요.') }
    if (existing?.length) { await deps.blobs.putJson(marker, { ref: path, profile: profile.id, bytes: existing.length, version: VOICE_PREVIEW_VERSION }); return hit() }
    // 캐시 미스의 유료 생성: 호출 경로가 허용하지 않으면(beforeProvider가 던지면) 키 확인·기록·승인·공급자 호출 어느 것도 하지 않는다.
    await ctx.beforeProvider?.()
    const apiKey = deps.apiKey?.() ?? process.env.OPENAI_API_KEY ?? ''
    if (!apiKey) throw new PreviewError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured')
    // 같은 미리듣기의 이전 호출 기록(공유 저장소의 원자적 claim): 진행 중이면 대기, 처리 여부가 불명확하면 자동으로 다시 호출하지 않는다.
    const flightBase = `voice-preview-flight/${path.replace(/^voice-preview\//, '').replace(/\.mp3$/, '')}`
    const prior = await readFlight(deps.blobs, flightBase)
    if (prior.state === 'in_progress') throw new PreviewError('PREVIEW_IN_PROGRESS', '같은 미리듣기를 만들고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
    if (prior.state !== 'free') throw new PreviewError('PREVIEW_STATE_UNKNOWN', '이전 미리듣기 요청의 처리 여부를 확인할 수 없습니다(이미 호출·과금되었을 수 있음). 자동으로 다시 호출하지 않았습니다.')
    if (!(await claimFlight(deps.blobs, flightBase, prior.gen))) throw new PreviewError('PREVIEW_IN_PROGRESS', '같은 미리듣기를 만들고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
    let audio: { bytes: Buffer; contentType: string }
    try { audio = await deps.tts(VOICE_PREVIEW_TEXT, apiKey, profile) }
    catch (e: any) {
      const m = /failed (\d{3}): ([\s\S]*)$/.exec(String(e?.message || ''))
      const c = m ? classifyOpenAiError(Number(m[1]), m[2]) : null
      const code = c?.stop ? (/quota|credit_balance/.test(c.code) ? 'PROVIDER_BILLING' : 'PROVIDER_STOP') : 'PREVIEW_FAILED'
      // 공급자가 거절(과금·인증 정지)한 것만 생성되지 않았음이 확실하다. 그 밖의 실패는 불명확해 자동으로 다시 호출하지 않는다.
      await recordFlight(deps.blobs, flightBase, prior.gen, c?.stop ? { status: 'failed_safe', code } : { status: 'unknown', code })
      log(`[voice-preview] ${JSON.stringify({ cache: 'MISS', profile: profile.id, ttsCalls: 1, code: c?.code ?? code })}`)
      throw new PreviewError(code, code === 'PREVIEW_FAILED' ? '미리듣기를 만들지 못했습니다. 이미 과금되었을 수 있어 자동으로 다시 호출하지 않았습니다.' : '음성 서비스를 지금 사용할 수 없습니다.')
    }
    if (!audio?.bytes?.length) { await recordFlight(deps.blobs, flightBase, prior.gen, { status: 'unknown', code: 'empty_audio' }); throw new PreviewError('PREVIEW_FAILED', '미리듣기 음성이 비어 있습니다. 이미 과금되었을 수 있어 자동으로 다시 호출하지 않았습니다.') }
    // 저장에 실패하면 이미 과금된 상태다: 성공으로 돌려주지 않고 자동으로 다시 호출하지 않는다(음성 파일이 저장됐다면 다음 요청이 표식만 복구한다).
    try {
      await deps.blobs.putBytes(path, audio.bytes, 'audio/mpeg')
      await deps.blobs.putJson(marker, { ref: path, profile: profile.id, bytes: audio.bytes.length, version: VOICE_PREVIEW_VERSION })
    } catch { await recordFlight(deps.blobs, flightBase, prior.gen, { status: 'paid_unsaved' }); throw new PreviewError('PREVIEW_FAILED', '미리듣기를 저장하지 못했습니다. 이미 과금되었을 수 있어 자동으로 다시 호출하지 않았습니다.') }
    await recordFlight(deps.blobs, flightBase, prior.gen, { status: 'done' })
    const s = await sign(path)
    log(`[voice-preview] ${JSON.stringify({ cache: 'MISS', profile: profile.id, ttsCalls: 1 })}`)
    return { playbackUrl: s.url, validUntil: s.validUntil, cache: 'MISS' }
  }
  return async function preview(input: any, ctx: PreviewContext = {}): Promise<VoicePreviewResult> {
    const profile = previewVoice(input), path = voicePreviewPath(profile)
    const running = inflight.get(path)
    if (running) return running
    const p = make(profile, path, ctx).finally(() => inflight.delete(path))
    inflight.set(path, p)
    return p
  }
}
