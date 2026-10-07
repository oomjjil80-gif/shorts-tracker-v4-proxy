// The ONE narration engine (Tracker TTS): every content that speaks uses it — the Wisdom / Senior Longform ASSET stage on
// the worker and the browser-made contents (Simple Production / Story Writer: senior·yasa·general·economy shorts and
// longforms) through the Job API. Same voice resolver, same sentence/clip cache, same guards, same loudness pass.
//  - cache: generative-cache/tts/<sha(ttsCacheIdentity(voice, text))>.json -> the mp3 (voice id carries voice+tone+speed)
//  - guards: billing/auth errors stop at once (0 retries); a transient network/5xx/rate error is retried once
//  - assembly: the clips back to back, ONE loudnorm pass on the whole track, then probed again (the real length rules)
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256 } from '../jobs/blobs.js'
import type { JobBlobStore } from '../jobs/blobs.js'
import { runOk, probe } from '../media/ffmpeg.js'
import { classifyOpenAiError, ProviderError } from './longformResearch.js'
import { ttsCacheIdentity, type VoiceProfile } from './voiceProfile.js'
import { cacheEntryIsCanonical } from './cache.js'

export const NARRATION_LOUDNORM = 'loudnorm=I=-17:TP=-1.5:LRA=11'
export type TtsFn = (text: string, apiKey: string, voice: VoiceProfile) => Promise<{ bytes: Buffer; contentType: string; provider?: string; model?: string }>
export const narrationConcatTimeoutMs = (seconds: number) => Math.max(15 * 60_000, Math.round(seconds * 250) + 10 * 60_000)

// one TTS call with the guards: a billing/auth error throws a stop error at once; a transient one is retried once
export async function guardedTts(tts: TtsFn, text: string, apiKey: string, voice: VoiceProfile, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  let last: ProviderError | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(2000)
    try { return await tts(text, apiKey, voice) }
    catch (e: any) {
      const m = /failed (\d{3}): ([\s\S]*)$/.exec(String(e?.message || ''))
      last = m ? classifyOpenAiError(Number(m[1]), m[2]) : e?.stop !== undefined ? e : new ProviderError(`TTS network error: ${String(e?.message || e).slice(0, 200)}`, 'network', false)
      if (last!.stop) break
    }
  }
  throw last
}

// one clip from the cache, or ONE guarded paid call stored in the cache
export async function cachedTts(o: { blobs: JobBlobStore; voice: VoiceProfile; text: string; tts: TtsFn; apiKey: string }): Promise<{ bytes: Buffer; ref: string; sha256: string; cache: 'HIT' | 'MISS' }> {
  const key = sha256(ttsCacheIdentity(o.voice, o.text))
  try {
    const m: any = await o.blobs.getJson(`generative-cache/tts/${key}.json`)
    const bytes = m?.ref ? await o.blobs.getBytes(m.ref) : null
    if (bytes && cacheEntryIsCanonical({ ...m, bytes }, m.ref, sha256(bytes))) return { bytes, ref: m.ref, sha256: sha256(bytes), cache: 'HIT' }
  } catch {}
  if (!o.apiKey) throw new ProviderError('OPENAI_API_KEY is not configured', 'no_api_key', true)
  const au = await guardedTts(o.tts, o.text, o.apiKey, o.voice)
  const h = sha256(au.bytes), ref = `generative-assets/audio/${h}.mp3`
  await o.blobs.putBytes(ref, au.bytes, au.contentType)
  await o.blobs.putJson(`generative-cache/tts/${key}.json`, { ref, sha256: h, contentType: au.contentType, provider: au.provider, model: au.model }, { overwrite: true })
  return { bytes: au.bytes, ref, sha256: h, cache: 'MISS' }
}

// mp3 -> mono 24 kHz WAV (the assembly format) and its measured length
export async function clipToWav(bytes: Buffer, dir: string, name: string, signal?: AbortSignal): Promise<{ wav: string; seconds: number }> {
  const mp3 = join(dir, `${name}.mp3`), wav = join(dir, `${name}.wav`)
  await writeFile(mp3, bytes); await runOk(['-y', '-i', mp3, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { signal }); await rm(mp3, { force: true })
  return { wav, seconds: Number(Number((await probe(wav)).duration || 0).toFixed(3)) }
}

// ONE continuous narration track: the clips back to back (no gap, no overlap), loudness levelled ONCE on the whole track
// (about -17 LUFS, true peak <= -1.5 dBTP; never per sentence). loudnorm keeps every sample in place, so the clip timing
// is unchanged; it only rounds the end up to its 100 ms frame. The encoded track is probed again: that is its length.
export async function assembleNarration(o: { wavs: string[]; dir: string; out: string; totalSeconds: number; signal?: AbortSignal }): Promise<number> {
  const list = join(o.dir, 'narration-list.txt'); await writeFile(list, o.wavs.map((w) => `file '${w}'`).join('\n'))
  await runOk(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-af', NARRATION_LOUDNORM, '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', o.out], { signal: o.signal, timeoutMs: narrationConcatTimeoutMs(o.totalSeconds) })
  const seconds = Number(Number((await probe(o.out)).duration || 0).toFixed(3))
  if (!(seconds >= o.totalSeconds - 0.05 && seconds <= o.totalSeconds + 0.15)) throw new Error(`NARRATION_TIMING: narration ${seconds}s != clips ${o.totalSeconds}s`)
  return seconds
}

// a clip's text in stable TTS units: whole sentences, at most `max` characters each (never the whole script at once)
export function narrationChunks(text: string, max = 1200): string[] {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?。？！…]+[.!?。？！…]*["'”’)]*\s*/g) ?? [clean]
  const out: string[] = []; let cur = ''
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if (cur && [...cur].length + 1 + [...s].length > max) { out.push(cur); cur = '' }
    if ([...s].length > max) { for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max)); continue }
    cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out
}
