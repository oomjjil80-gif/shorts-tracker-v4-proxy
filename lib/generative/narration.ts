// The ONE narration engine (Tracker TTS): every content that speaks uses it — the Wisdom / Senior Longform ASSET stage on
// the worker and the browser-made contents (Simple Production / Story Writer: senior·yasa·general·economy shorts and
// longforms) through the Job API. Same voice resolver, same sentence/clip cache, same guards, same loudness pass.
//  - cache: generative-cache/tts/<sha(ttsCacheIdentity(voice, text))>.json -> the mp3 (voice id carries voice+tone+speed)
//  - guards: billing/auth errors stop at once (0 retries); a transient network/5xx/rate error is retried once
//  - assembly: the clips back to back, ONE loudnorm pass on the whole track, then probed again (the real length rules)
import { randomUUID } from 'node:crypto'
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

// one TTS call with the guards: a billing/auth error throws a stop error at once; a transient one is retried once.
// `retryUnknown:false` (used by the paid, durable path): a failure WITHOUT any provider response (network drop, timeout) may
// already have been billed, so it is never repeated automatically; only an answered error (HTTP status) is retried once.
export async function guardedTts(tts: TtsFn, text: string, apiKey: string, voice: VoiceProfile, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), opts: { retryUnknown?: boolean } = {}) {
  let last: ProviderError | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(2000)
    try { return await tts(text, apiKey, voice) }
    catch (e: any) {
      const m = /failed (\d{3}): ([\s\S]*)$/.exec(String(e?.message || ''))
      last = m ? classifyOpenAiError(Number(m[1]), m[2]) : e?.stop !== undefined ? e : new ProviderError(`TTS network error: ${String(e?.message || e).slice(0, 200)}`, 'network', false)
      if (last!.stop) break
      if (opts.retryUnknown === false && last!.status === undefined) break
    }
  }
  throw last
}

// ---------- paid clip: cache -> durable single flight -> ONE guarded call ----------
export type CachedTtsResult = { bytes: Buffer; ref: string; sha256: string; cache: 'HIT' | 'MISS' }
export type TtsCallBudget = { remaining: number }
// Another request/instance is generating the same clip right now (nothing was repeated; ask again shortly).
export class TtsPendingError extends Error { code = 'TTS_IN_PROGRESS'; constructor(m: string) { super(m); this.name = 'TtsPendingError' } }
// Whether the provider already processed (and billed) this clip is NOT known. No automatic repeat; only an approved forced regeneration may.
export class TtsUnknownError extends Error { code = 'TTS_STATE_UNKNOWN'; constructor(m: string) { super(m); this.name = 'TtsUnknownError' } }
// More paid calls than the approval covered.
export class TtsBudgetError extends Error { code = 'TTS_APPROVAL_EXCEEDED'; constructor(m: string) { super(m); this.name = 'TtsBudgetError' } }
type CachedTtsOptions = { blobs: JobBlobStore; voice: VoiceProfile; text: string; tts: TtsFn; apiKey: string; forceRegenerate?: boolean; budget?: TtsCallBudget; flightId?: string; wait?: { waitMs?: number; pollMs?: number; staleMs?: number }; inflight?: Map<string, Promise<CachedTtsResult>> /* a separate process-local map: lets tests model an independent instance */ }

// The cached clip (mp3 + canonical metadata), or null. Free: never calls the provider.
export async function ttsCacheLookup(blobs: JobBlobStore, voice: VoiceProfile, text: string): Promise<{ bytes: Buffer; ref: string; sha256: string } | null> {
  try {
    const m: any = await blobs.getJson(`generative-cache/tts/${sha256(ttsCacheIdentity(voice, text))}.json`)
    const bytes = m?.ref ? await blobs.getBytes(m.ref) : null
    if (bytes && cacheEntryIsCanonical({ ...m, bytes }, m.ref, sha256(bytes))) return { bytes, ref: m.ref, sha256: sha256(bytes) }
  } catch {}
  return null
}

// Layer 1, same process: the same voice+text being generated right now is paid once (double click, repeated line in one request).
// Layer 2, any instance / after a restart: cachedTtsOnce claims the generation in the shared store with an atomic create-once.
const ttsInFlight = new Map<string, Promise<CachedTtsResult>>()
export function cachedTts(o: CachedTtsOptions): Promise<CachedTtsResult> {
  const flight = `${sha256(ttsCacheIdentity(o.voice, o.text))}|${o.forceRegenerate ? `force:${o.flightId ?? randomUUID()}` : 'normal'}`
  const local = o.inflight ?? ttsInFlight
  const running = local.get(flight)
  if (running) return running.then((r) => ({ ...r, cache: 'HIT' as const }))
  const p = cachedTtsOnce(o)
  local.set(flight, p)
  const done = () => { if (local.get(flight) === p) local.delete(flight) }
  p.then(done, done)
  return p
}
const MAX_TTS_GENERATIONS = 8
async function cachedTtsOnce(o: CachedTtsOptions): Promise<CachedTtsResult> {
  const key = sha256(ttsCacheIdentity(o.voice, o.text)), force = o.forceRegenerate === true
  const cachePath = `generative-cache/tts/${key}.json`
  if (!force) { const hit = await ttsCacheLookup(o.blobs, o.voice, o.text); if (hit) return { ...hit, cache: 'HIT' } }
  if (!o.apiKey) throw new ProviderError('OPENAI_API_KEY is not configured', 'no_api_key', true)
  const claim = o.blobs.claim?.bind(o.blobs)
  const reserve = () => { if (o.budget) { if (o.budget.remaining <= 0) throw new TtsBudgetError('승인된 음성 생성 횟수를 넘어 호출하지 않았습니다.'); o.budget.remaining -= 1 } }
  if (!claim) { reserve(); return generateAndStore(o, key, cachePath, null) } // store without atomic claim: single process only
  const wait = { waitMs: 30_000, pollMs: 300, staleMs: 5 * 60_000, ...o.wait }
  const base = force ? `tts-flight/${key}.f-${o.flightId ?? randomUUID()}` : `tts-flight/${key}`
  for (let gen = 0; gen < MAX_TTS_GENERATIONS; gen++) {
    const claimPath = `${base}.g${gen}.json`, resultPath = `${base}.g${gen}.result.json`
    let owner: any = await o.blobs.getJson(claimPath)
    if (!owner) {
      reserve() // synchronously, before the atomic claim, so concurrent workers cannot overshoot the approved calls
      if (await claim(claimPath, { startedAt: Date.now(), gen })) return generateAndStore(o, key, cachePath, resultPath)
      if (o.budget) o.budget.remaining += 1 // lost the race: somebody else is paying, this request is not
      owner = (await o.blobs.getJson(claimPath)) ?? { startedAt: Date.now() }
    }
    const t0 = Date.now()
    for (;;) {
      if (!force) { const hit = await ttsCacheLookup(o.blobs, o.voice, o.text); if (hit) return { ...hit, cache: 'HIT' } }
      const r: any = await o.blobs.getJson(resultPath).catch(() => null)
      if (r?.status === 'done') {
        const bytes = await o.blobs.getBytes(r.ref)
        if (bytes && sha256(bytes) === r.sha256) return { bytes, ref: r.ref, sha256: r.sha256, cache: 'HIT' }
        throw new TtsUnknownError('이미 생성된 음성 파일을 읽지 못했습니다. 비용이 중복되지 않도록 자동으로 다시 호출하지 않습니다.')
      }
      if (r?.status === 'failed_safe') break // the provider answered with an error: nothing was generated, a new attempt is safe
      if (r) throw new TtsUnknownError('이 문구의 음성 생성 결과를 확인하지 못했습니다(이미 처리·과금되었을 수 있음). 자동으로 다시 호출하지 않습니다. 직접 다시 만들기로 승인해야 새로 요청합니다.')
      if (Date.now() - Number(owner?.startedAt ?? 0) > wait.staleMs) throw new TtsUnknownError('이 문구의 이전 음성 요청이 끝났는지 확인할 수 없습니다(이미 과금되었을 수 있음). 자동으로 다시 호출하지 않습니다. 직접 다시 만들기로 승인해야 새로 요청합니다.')
      if (Date.now() - t0 >= wait.waitMs) throw new TtsPendingError('같은 문구의 음성을 다른 요청이 만들고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
      await new Promise((res) => setTimeout(res, wait.pollMs))
    }
  }
  throw new TtsUnknownError('같은 문구의 음성 생성이 여러 번 실패해 더 호출하지 않았습니다.')
}
async function retry3(fn: () => Promise<unknown>): Promise<boolean> {
  for (let i = 0; i < 3; i++) { try { await fn(); return true } catch { if (i < 2) await new Promise((r) => setTimeout(r, 150 * (i + 1))) } }
  return false
}
// Owner of one generation: ONE guarded paid call. The outcome is recorded in the shared store (restart-proof):
//  failed_safe = the provider answered with an error (nothing generated, a new attempt is allowed)
//  unknown / paid_unsaved = no answer / generated but not stored (maybe billed: NO automatic repeat)
//  done = stored; a clip whose cache entry failed to save is still recovered from this record
async function generateAndStore(o: CachedTtsOptions, key: string, cachePath: string, resultPath: string | null): Promise<CachedTtsResult> {
  const record = async (v: Record<string, unknown>) => (resultPath ? retry3(() => o.blobs.putJson(resultPath, { ...v, at: new Date().toISOString() }, { overwrite: true })) : true)
  let au: Awaited<ReturnType<typeof guardedTts>>
  try { au = await guardedTts(o.tts, o.text, o.apiKey, o.voice, undefined, { retryUnknown: false }) }
  catch (e: any) {
    if (e?.status !== undefined || e?.code === 'no_api_key') { await record({ status: 'failed_safe', code: e?.code ?? null, http: e?.status ?? null }); throw e }
    await record({ status: 'unknown', reason: 'no_provider_response' })
    throw new TtsUnknownError('음성 서비스의 응답을 확인하지 못했습니다(연결 끊김·시간 초과). 이미 처리·과금되었을 수 있어 자동으로 다시 호출하지 않습니다.')
  }
  const h = sha256(au.bytes), ref = `generative-assets/audio/${h}.mp3`
  if (!(await retry3(() => o.blobs.putBytes(ref, au.bytes, au.contentType)))) {
    await record({ status: 'paid_unsaved', sha256: h })
    throw new TtsUnknownError('음성은 만들어졌지만 저장하지 못했습니다(과금되었을 수 있음). 자동으로 다시 호출하지 않습니다.')
  }
  const meta = { ref, sha256: h, contentType: au.contentType, provider: au.provider, model: au.model }
  await record({ status: 'done', ...meta })
  await retry3(() => o.blobs.putJson(cachePath, meta, { overwrite: true })) // best effort: the record above already makes the clip recoverable
  return { bytes: au.bytes, ref, sha256: h, cache: 'MISS' }
}

// mp3 -> mono 24 kHz WAV (the assembly format) and its measured length
export async function clipToWav(bytes: Buffer, dir: string, name: string, signal?: AbortSignal): Promise<{ wav: string; seconds: number }> {
  const mp3 = join(dir, `${name}.mp3`), wav = join(dir, `${name}.wav`)
  await writeFile(mp3, bytes); await runOk(['-y', '-i', mp3, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { signal }); await rm(mp3, { force: true })
  return { wav, seconds: Number(Number((await probe(wav)).duration || 0).toFixed(3)) }
}

/** Offline correction of one anomalously slow WAV; cached original TTS remains untouched. */
export async function speedUpNarrationClip(wav: string, out: string, factor: number, signal?: AbortSignal): Promise<number> {
  if (!Number.isFinite(factor) || factor < 1 || factor > 2.5) throw new Error('TTS_CADENCE_REVIEW_REQUIRED: unsafe speed factor')
  await runOk(['-y', '-i', wav, '-af', `atempo=${factor.toFixed(4)}`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', out], { signal })
  const seconds = Number(Number((await probe(out)).duration || 0).toFixed(3))
  if (!(seconds > 0)) throw new Error('TTS_CADENCE_REVIEW_REQUIRED: invalid corrected clip')
  return seconds
}

/** Relative speech-rate correction; return null if insufficient samples or correction is unsafe. */
export function narrationCorrectionFactor(parts: Array<{ chars: number; seconds: number }>, index: number): number | null {
  const valid = parts.filter(p => Number.isFinite(p.chars) && Number.isFinite(p.seconds) && p.chars >= 12 && p.seconds > 0)
  if (valid.length < 5) return null
  const rates = valid.map(p => p.chars / p.seconds).sort((a,b) => a-b)
  const mid = Math.floor(rates.length/2)
  const median = rates.length % 2 ? rates[mid] : (rates[mid-1]+rates[mid])/2
  const p = parts[index]
  if (!p || !(p.seconds > 0) || p.chars < 12) return null
  const factor = median / (p.chars/p.seconds)
  return factor >= 2.2 && factor <= 2.5 ? factor : null
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


/** Diagnostic only: flag unusually slow clips relative to the same narration.
 * Does not change audio, retry providers, or incur additional TTS calls.
 * Short clips are excluded because punctuation/pauses dominate their duration.
 */
export function slowNarrationClipIndices(parts: Array<{ chars: number; seconds: number }>): number[] {
  const eligible = parts.map((p, index) => ({ ...p, index }))
    .filter((p) => Number.isFinite(p.chars) && Number.isFinite(p.seconds) && p.chars >= 12 && p.seconds > 0)
  if (eligible.length < 5) return []
  const rates = eligible.map((p) => p.chars / p.seconds).sort((a, b) => a - b)
  const mid = Math.floor(rates.length / 2)
  const median = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2
  return eligible.filter((p) => p.chars / p.seconds < median / 2.2).map((p) => p.index)
}
