// Tracker TTS for browser-made content (Simple Production / Story Writer: senior·yasa·general·economy, shorts and longform):
// the SAME narration engine as the Longform worker (lib/generative/narration.ts) behind two short Job API calls, so a long
// script is voiced in small resumable batches and never as one giant request.
//   tts_clips    { family, format, topic?, creative, clips: [{ id, text }] } -> per clip: its cached chunks + measured seconds
//   tts_assemble { family, format, creative, refs: [chunk refs in order] }  -> ONE levelled narration (R2, presigned URL)
// The voice is the Episode's resolved Creative profile through the same function the voice preview uses, so the preview
// and the real narration are always the same voice/tone/speed. Every clip/assembly is cached: a retry pays for nothing.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, sha256File, type JobBlobStore } from '../jobs/blobs.js'
import { cachedTts, clipToWav, assembleNarration, narrationChunks, NARRATION_LOUDNORM, type TtsFn } from './narration.js'
import { creativeContentFor, creativeVoiceFor, resolveCreativeProfile, type CreativeContent, type ResolvedCreativeProfile } from './creativeProfile.js'
import { LONGFORM_VOICE_PROFILES, LONGFORM_VOICE_TONES, LONGFORM_VOICE_SPEEDS, type VoiceProfile } from './voiceProfile.js'

export class TrackerTtsError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'TrackerTtsError' } }
const MAX_CLIPS = 24, MAX_CLIP_CHARS = 6000, MAX_REFS = 4000
const REF = /^generative-assets\/audio\/[0-9a-f]{64}\.mp3$/

// the narration voice of an Episode: its stored resolved profile (from creative_resolve), else the same resolver
export function trackerVoice(input: any): { content: CreativeContent; voice: VoiceProfile } {
  let content: CreativeContent
  try { content = creativeContentFor(input?.family, input?.format) } catch (e: any) { throw new TrackerTtsError('BAD_REQUEST', String(e?.message || e)) }
  const r = input?.creative?.resolved
  const valid = r && (r.voiceProfile === 'house' || (LONGFORM_VOICE_PROFILES as any)[r.voiceProfile]) && (LONGFORM_VOICE_TONES as readonly string[]).includes(r.voiceTone) && (LONGFORM_VOICE_SPEEDS as readonly number[]).includes(Number(r.voiceSpeed))
  try {
    const resolved: ResolvedCreativeProfile = valid ? { ...r, voiceSpeed: Number(r.voiceSpeed) } : resolveCreativeProfile(content, input?.creative?.requested ?? {}, String(input?.topic || '')).resolved
    return { content, voice: creativeVoiceFor(content, resolved) }
  } catch (e: any) { throw new TrackerTtsError('BAD_REQUEST', String(e?.message || e)) }
}
const stopCode = (e: any) => (e?.stop ? (/quota|credit_balance/.test(String(e?.code)) ? 'PROVIDER_BILLING' : 'PROVIDER_STOP') : 'TTS_FAILED')

export function createTrackerTts(deps: { blobs: JobBlobStore; tts: TtsFn; apiKey?: () => string; log?: (line: string) => void }) {
  const log = deps.log ?? ((l: string) => console.log(l))
  const key = () => deps.apiKey?.() ?? process.env.OPENAI_API_KEY ?? ''
  async function clips(input: any) {
    const { voice } = trackerVoice(input)
    const list = Array.isArray(input?.clips) ? input.clips : []
    if (!list.length || list.length > MAX_CLIPS) throw new TrackerTtsError('BAD_REQUEST', `clips must be 1..${MAX_CLIPS}`)
    const units = list.map((c: any, i: number) => {
      const text = String(c?.text || '').trim()
      if (!text || [...text].length > MAX_CLIP_CHARS) throw new TrackerTtsError('BAD_REQUEST', `clip ${i + 1}: text must be 1..${MAX_CLIP_CHARS} characters`)
      return { id: String(c?.id ?? i), chunks: narrationChunks(text) }
    })
    const work = await mkdtemp(join(tmpdir(), 'tracker-tts-'))
    let calls = 0, hits = 0
    try {
      const jobs = units.flatMap((u: any, ui: number) => u.chunks.map((text: string, ci: number) => ({ ui, ci, text })))
      const done: any[] = new Array(jobs.length)
      let next = 0
      const worker = async () => {
        for (let i = next++; i < jobs.length; i = next++) {
          const j = jobs[i]
          const c = await cachedTts({ blobs: deps.blobs, voice, text: j.text, tts: deps.tts, apiKey: key() })
          if (c.cache === 'HIT') hits++; else calls++
          const { seconds } = await clipToWav(c.bytes, work, `c${i}`)
          if (!(seconds > 0)) throw new TrackerTtsError('TTS_FAILED', `clip ${j.ui + 1} has no audio`)
          done[i] = { ref: c.ref, seconds, cache: c.cache }
        }
      }
      try { await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker)) }
      catch (e: any) { if (e instanceof TrackerTtsError) throw e; log(`[tracker-tts] ${JSON.stringify({ step: 'clips', voice: voice.id, ttsCalls: calls + 1, code: e?.code ?? 'TTS_FAILED' })}`); throw new TrackerTtsError(stopCode(e), e?.stop ? '음성 서비스를 지금 사용할 수 없습니다.' : '음성을 만들지 못했습니다. 다시 시도해 주세요.') }
      const out = units.map((u: any, ui: number) => {
        const chunks = jobs.map((j: any, i: number) => (j.ui === ui ? done[i] : null)).filter(Boolean)
        return { id: u.id, chunks, seconds: Number(chunks.reduce((s: number, c: any) => s + c.seconds, 0).toFixed(3)) }
      })
      log(`[tracker-tts] ${JSON.stringify({ step: 'clips', voice: voice.id, clips: units.length, chunks: jobs.length, ttsCalls: calls, cacheHits: hits })}`)
      return { voiceProfileId: voice.id, clips: out, ttsCalls: calls, cacheHits: hits }
    } finally { await rm(work, { recursive: true, force: true }) }
  }
  async function assemble(input: any) {
    const { voice } = trackerVoice(input)
    const refs: string[] = Array.isArray(input?.refs) ? input.refs.map(String) : []
    if (!refs.length || refs.length > MAX_REFS || refs.some((r) => !REF.test(r))) throw new TrackerTtsError('BAD_REQUEST', 'refs must be the chunk refs returned by tts_clips')
    const cacheKey = sha256(`narration-v1|${NARRATION_LOUDNORM}|${voice.id}|${refs.join('|')}`), cachePath = `generative-cache/narration/${cacheKey}.json`
    const sign = async (ref: string) => { const s = await deps.blobs.presign?.(ref, 60 * 60_000); if (!s) throw new TrackerTtsError('TTS_FAILED', 'playback URL unavailable'); return s }
    const hit: any = await deps.blobs.getJson(cachePath).catch(() => null)
    if (hit?.ref) { const s = await sign(hit.ref); log(`[tracker-tts] ${JSON.stringify({ step: 'assemble', cache: 'HIT', voice: voice.id })}`); return { ref: hit.ref, seconds: hit.seconds, clipsSeconds: hit.clipsSeconds, loudness: NARRATION_LOUDNORM, playbackUrl: s.url, validUntil: s.validUntil, cache: 'HIT' } }
    const work = await mkdtemp(join(tmpdir(), 'tracker-narration-'))
    try {
      const wavs: string[] = []; let total = 0
      for (const [i, ref] of refs.entries()) {
        const bytes = await deps.blobs.getBytes(ref)
        if (!bytes) throw new TrackerTtsError('BAD_REQUEST', `chunk ${i + 1} is missing; make the clips again`)
        const w = await clipToWav(bytes, work, `n${i}`); wavs.push(w.wav); total += w.seconds
      }
      const clipsSeconds = Number(total.toFixed(3)), out = join(work, 'narration.m4a')
      let seconds: number
      try { seconds = await assembleNarration({ wavs, dir: work, out, totalSeconds: clipsSeconds }) } catch (e: any) { throw new TrackerTtsError('TTS_FAILED', String(e?.message || e).slice(0, 200)) }
      const ref = `generative-assets/audio/${await sha256File(out)}.m4a`
      await deps.blobs.putFile(ref, out, 'audio/mp4')
      await deps.blobs.putJson(cachePath, { ref, seconds, clipsSeconds, voiceProfileId: voice.id, chunks: refs.length }, { overwrite: true })
      const s = await sign(ref)
      log(`[tracker-tts] ${JSON.stringify({ step: 'assemble', cache: 'MISS', voice: voice.id, chunks: refs.length, seconds })}`)
      return { ref, seconds, clipsSeconds, loudness: NARRATION_LOUDNORM, playbackUrl: s.url, validUntil: s.validUntil, cache: 'MISS' }
    } finally { await rm(work, { recursive: true, force: true }) }
  }
  return { clips, assemble }
}
