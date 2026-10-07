// Tracker TTS for every content (no CapCut): the ONE narration engine behind tts_clips / tts_assemble. The voice is the
// Episode's resolved Creative profile through the same function as the voice preview; clips are cached per
// voice+tone+speed+text; billing/auth errors stop at once; a transient error is retried once; the narration is levelled
// once (~-17 LUFS) and its probed length is authoritative. Stand-in TTS (real mp3 from ffmpeg); no paid calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { createTrackerTts, trackerVoice } from '../lib/generative/trackerTts.js'
import { narrationChunks, NARRATION_LOUDNORM } from '../lib/generative/narration.js'
import { previewVoice } from '../lib/generative/voicePreview.js'
import { CONTENT_FAMILIES } from '../lib/generative/creativeProfile.js'
import { openAiTts } from '../lib/generative/providers.js'
import { runOk, runFfmpeg } from '../lib/media/ffmpeg.js'

const FORMATS = ['shorts', 'longform'] as const
const AUTO = { voiceProfile: 'auto', voiceTone: 'calm', voiceSpeed: 1, visualStyleProfile: 'auto' }
// stand-in TTS: a quiet tone whose length follows the text, mp3 like the real voice; every call is recorded
function standIn(fail?: (n: number) => { status: number; body: string } | null) {
  const calls: Array<{ text: string; voice: string; speed: number; instructions: string }> = []
  const tts = async (text: string, _k: string, v: any) => {
    calls.push({ text, voice: v.id, speed: v.speed, instructions: v.instructions })
    const f = fail?.(calls.length); if (f) throw new Error(`speech generation failed ${f.status}: ${f.body}`)
    const sec = Math.max(0.4, [...text].length * 0.05)
    const r = await runOk(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=0.15', '-f', 'lavfi', '-i', `sine=f=300:d=${sec.toFixed(2)}`, '-filter_complex', '[0][1]concat=n=2:v=0:a=1,volume=0.05', '-c:a', 'libmp3lame', '-f', 'mp3', '-'])
    return { bytes: r.stdout, contentType: 'audio/mpeg', provider: 'standin', model: 'gpt-4o-mini-tts' }
  }
  return { tts, calls }
}
const http = (handler: any, body: any) => new Promise<{ status: number; json: any }>((resolve) => {
  let status = 0
  handler({ method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': 'k'.repeat(32) }, query: {}, body } as any,
    { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { resolve({ status, json: b }); return this }, end() { return this } } as any)
})
const CLIPS = [{ id: 'c1', text: '금리가 오르면 대출 이자가 먼저 늘어납니다.' }, { id: 'c2', text: '그래서 월급은 그대로인데 쓸 돈이 줄어듭니다. 이게 체감 물가입니다.' }, { id: 'c3', text: '오늘은 그 이유를 세 가지로 정리합니다.' }]

test('1-4 + 9: every family x format voices through the resolver; the narration voice IS the preview voice (voice, tone, speed)', async () => {
  for (const family of CONTENT_FAMILIES) for (const format of FORMATS) {
    for (const creative of [{ requested: AUTO }, { requested: { ...AUTO, voiceProfile: 'female-middle', voiceTone: 'neutral', voiceSpeed: 1.1 } }]) {
      const v = trackerVoice({ family, format, topic: '금리', creative }).voice
      assert.equal(v.id, previewVoice({ family, format, topic: '금리', ...creative.requested }).id, `${family}/${format}`)
    }
  }
  // the stored server-resolved profile is used as is (no second AUTO decision)
  const stored = { requested: AUTO, resolved: { voiceProfile: 'male-middle', voiceTone: 'calm', voiceSpeed: 0.9, voiceProfileId: 'x', visualStyleProfile: 'historical-dramatic' } }
  assert.equal(trackerVoice({ family: 'yasa', format: 'shorts', creative: stored }).voice.id, 'ko-lf-male-middle-calm-0.9-v2')
  // tone and speed reach the real TTS request
  const sent: any[] = []
  const f: any = async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(Buffer.from('x'), { status: 200 }) }
  await openAiTts('문장', 'k', trackerVoice({ family: 'economy', format: 'shorts', creative: { requested: { ...AUTO, voiceProfile: 'male-middle', voiceTone: 'neutral', voiceSpeed: 1.1 } } }).voice, f)
  assert.equal(sent[0].speed, 1.1); assert.match(sent[0].instructions, /자연스럽고 또렷한/); assert.equal(sent[0].model, 'gpt-4o-mini-tts')
  assert.throws(() => trackerVoice({ family: 'source', format: 'shorts' }), /unknown content/) // source Shorts keep their own audio path
})

test('5-6 + 14: clips are cached per voice+tone+speed+text (same -> 0 calls, any change -> new audio); the measured length is returned', async () => {
  const blobs: any = createMemoryBlobStore(), s = standIn()
  const t = createTrackerTts({ blobs, tts: s.tts, apiKey: () => 'k', log: () => {} })
  const body = { family: 'economy', format: 'shorts', creative: { requested: { ...AUTO, voiceProfile: 'male-middle', voiceTone: 'neutral' } }, clips: CLIPS }
  const a = await t.clips(body)
  assert.equal(a.ttsCalls, 3); assert.equal(s.calls.length, 3); assert.ok(a.clips.every((c: any) => c.seconds > 0.4 && c.chunks.every((k: any) => /^generative-assets\/audio\/[0-9a-f]{64}\.mp3$/.test(k.ref))))
  assert.ok(s.calls.every((c) => c.voice === 'ko-lf-male-middle-neutral-1.0-v2'))
  const b = await t.clips(body)
  assert.equal(b.ttsCalls, 0); assert.equal(b.cacheHits, 3); assert.equal(s.calls.length, 3); assert.deepEqual(b.clips.map((c: any) => c.seconds), a.clips.map((c: any) => c.seconds))
  await t.clips({ ...body, creative: { requested: { ...AUTO, voiceProfile: 'male-middle', voiceTone: 'calm' } } }) // another tone
  await t.clips({ ...body, creative: { requested: { ...AUTO, voiceProfile: 'male-middle', voiceTone: 'neutral', voiceSpeed: 0.9 } } }) // another speed
  await t.clips({ ...body, creative: { requested: { ...AUTO, voiceProfile: 'female-middle', voiceTone: 'neutral' } } }) // another voice
  assert.equal(s.calls.length, 12)
  // a long text is voiced in sentence chunks (never the whole script in one call)
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1}번째 문장은 이렇게 이어집니다.`).join(' ')
  const chunks = narrationChunks(long, 200)
  assert.ok(chunks.length > 3 && chunks.every((c) => [...c].length <= 200) && chunks.join(' ') === long)
})

test('7-8: billing/auth stop at once (1 call, nothing stored); a transient error is retried once; a second failure stops', async () => {
  for (const [status, body, code] of [[429, '{"error":{"code":"credit_balance_exhausted"}}', 'PROVIDER_BILLING'], [429, '{"error":{"code":"insufficient_quota"}}', 'PROVIDER_BILLING'], [400, '{"error":{"code":"billing_hard_limit_reached"}}', 'PROVIDER_BILLING'], [401, '{"error":{"code":"invalid_api_key"}}', 'PROVIDER_STOP'], [403, '{}', 'PROVIDER_STOP']] as const) {
    const blobs: any = createMemoryBlobStore(), s = standIn(() => ({ status, body }))
    const handler = createJobsHttp({ getStore: async () => { throw new Error('no database') }, blobs, trackerTts: createTrackerTts({ blobs, tts: s.tts, apiKey: () => 'k', log: () => {} }) })
    const r = await http(handler, { taskType: 'tts_clips', family: 'yasa', format: 'shorts', creative: { requested: AUTO }, clips: [CLIPS[0]] })
    assert.equal(r.json.error.code, code); assert.equal(r.status, 503); assert.equal(s.calls.length, 1, code)
    assert.equal([...blobs.files.keys()].filter((k: string) => k.startsWith('generative-cache/tts/')).length, 0)
  }
  const once = standIn((n) => (n === 1 ? { status: 503, body: 'upstream' } : null))
  const ok = await createTrackerTts({ blobs: createMemoryBlobStore(), tts: once.tts, apiKey: () => 'k', log: () => {} }).clips({ family: 'general', format: 'shorts', creative: { requested: AUTO }, clips: [CLIPS[0]] })
  assert.equal(once.calls.length, 2); assert.equal(ok.clips[0].chunks.length, 1)
  const twice = standIn(() => ({ status: 502, body: 'bad gateway' }))
  await assert.rejects(() => createTrackerTts({ blobs: createMemoryBlobStore(), tts: twice.tts, apiKey: () => 'k', log: () => {} }).clips({ family: 'general', format: 'shorts', creative: { requested: AUTO }, clips: [CLIPS[0]] }), (e: any) => e.code === 'TTS_FAILED')
  assert.equal(twice.calls.length, 2, 'never a third call')
})

test('13-14: one levelled narration (~-17 LUFS, no clipping); its probed length is authoritative and matches the clips; assembly cached', async () => {
  const blobs: any = createMemoryBlobStore(), s = standIn()
  const t = createTrackerTts({ blobs, tts: s.tts, apiKey: () => 'k', log: () => {} })
  const body = { family: 'senior', format: 'shorts', creative: { requested: AUTO }, clips: CLIPS }
  const c = await t.clips(body)
  const refs = c.clips.flatMap((x: any) => x.chunks.map((k: any) => k.ref)), sum = c.clips.reduce((s: number, x: any) => s + x.seconds, 0)
  const n = await t.assemble({ ...body, refs })
  assert.equal(n.cache, 'MISS'); assert.equal(n.loudness, NARRATION_LOUDNORM); assert.match(n.ref, /^generative-assets\/audio\/[0-9a-f]{64}\.m4a$/)
  assert.ok(n.seconds >= sum - 0.05 && n.seconds <= sum + 0.15, `${n.seconds} vs ${sum}`)
  assert.equal(n.playbackUrl, `memory://${n.ref}`)
  const d = await mkdtemp(join(tmpdir(), 'tts-')), file = join(d, 'n.m4a'); await writeFile(file, blobs.binaries.get(n.ref))
  const meter = (await runFfmpeg(['-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'])).stderr, sum2 = meter.slice(meter.lastIndexOf('Summary:'))
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(sum2)![1]), peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(sum2)![1])
  assert.ok(lufs >= -18.5 && lufs <= -15.5 && peak <= -1, `${lufs} LUFS, peak ${peak}`)
  const again = await t.assemble({ ...body, refs })
  assert.equal(again.cache, 'HIT'); assert.equal(again.seconds, n.seconds); assert.equal(s.calls.length, 3)
  await assert.rejects(() => t.assemble({ ...body, refs: ['../etc/passwd'] }), (e: any) => e.code === 'BAD_REQUEST')
  // the browser takes the narration bytes through the API (tts_audio), never any other stored object
  const handler = createJobsHttp({ getStore: async () => { throw new Error('no database') }, blobs, trackerTts: t })
  const got = await new Promise<{ status: number; type: string; bytes: Buffer }>((resolve) => {
    const h: Record<string, string> = {}; let status = 0
    handler({ method: 'GET', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': 'k'.repeat(32) }, query: { taskType: 'tts_audio', ref: n.ref } } as any,
      { setHeader(k: string, v: string) { h[k] = v }, status(c: number) { status = c; return this }, json(b: any) { resolve({ status, type: 'json', bytes: Buffer.from(JSON.stringify(b)) }); return this }, end(b: Buffer) { resolve({ status, type: h['Content-Type'], bytes: b }); return this } } as any)
  })
  assert.equal(got.status, 200); assert.equal(got.type, 'audio/mp4'); assert.ok(got.bytes.equals(blobs.binaries.get(n.ref)))
  await assert.rejects(() => t.audio(refs[0]), (e: any) => e.code === 'BAD_REQUEST')
})
