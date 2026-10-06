// Wisdom Longform voice: tone (calm/neutral/bright) + speed (0.9/1.0/1.1) on top of the 6 voices, TTS cache identity per
// (voice, tone, speed), legacy briefs unchanged, and the cached voice preview (MISS = 1 TTS call, HIT = 0, billing stops).
// Fake providers only; no paid calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LONGFORM_VOICE_CHOICES, LONGFORM_VOICE_PROFILES, LONGFORM_VOICE_TONES, LONGFORM_VOICE_SPEEDS, DEFAULT_VOICE_PROFILE,
  resolveLongformRuntimeVoice, ttsCacheIdentity, recommendLongformVoice
} from '../lib/generative/voiceProfile.js'
import { resolveCreativeProfile, briefVoice } from '../lib/generative/creativeProfile.js'
// the Longform voice through the common Creative resolver, in the shape these tests compare
const resolveLongformVoice = (choice: any, topic: string, voiceTone?: any, voiceSpeed?: any) => { const r = resolveCreativeProfile('wisdom_longform', { voiceProfile: choice, voiceTone, voiceSpeed }, topic); return { choice: r.requested.voiceProfile, key: r.resolved.voiceProfile, profileId: r.resolved.voiceProfileId, tone: r.resolved.voiceTone, speed: r.resolved.voiceSpeed } }
const longformVoiceProfile = (brief: any) => briefVoice(brief, 'wisdom_longform')
import { normalizeLongformBrief } from '../lib/generative/longform.js'
import { openAiTts, openAiWisdomTts } from '../lib/generative/providers.js'
import { createVoicePreview, voicePreviewPath, previewVoice, VOICE_PREVIEW_TEXT } from '../lib/generative/voicePreview.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'

const KEY = 'k'.repeat(32), BUDDHA = '부처님이 말한 인생의 마지막 공부'
const http = (handler: any, body: any) => new Promise<{ status: number; json: any }>((resolve) => {
  let status = 0
  handler({ method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: {}, body } as any,
    { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { resolve({ status, json: b }); return this }, end() { return this } } as any)
})

test('1-2: 7 voice choices resolve; auto keeps the topic rule while tone/speed stay the user\'s', () => {
  assert.deepEqual([...LONGFORM_VOICE_CHOICES], ['auto', 'male-young', 'male-middle', 'male-senior', 'female-young', 'female-middle', 'female-senior'])
  for (const c of LONGFORM_VOICE_CHOICES) {
    const r = resolveLongformVoice(c, BUDDHA)
    assert.ok(LONGFORM_VOICE_PROFILES[r.key as Exclude<typeof r.key, "house">]); assert.equal(r.tone, 'calm'); assert.equal(r.speed, 1)
  }
  assert.equal(recommendLongformVoice(BUDDHA), 'male-senior')
  assert.deepEqual(resolveLongformVoice('auto', BUDDHA, 'calm', 0.9), { choice: 'auto', key: 'male-senior', profileId: 'ko-lf-male-senior-calm-0.9-v2', tone: 'calm', speed: 0.9 })
  assert.equal(resolveLongformVoice('auto', '지친 마음을 위로하는 말', 'bright', 1.1).key, 'female-middle')
  for (const [t, s] of [['loud', 1], ['calm', 1.05], ['calm', 2], ['calm', 'fast']]) assert.throws(() => resolveLongformVoice('female-middle', BUDDHA, t, s))
})

test('3-4: tone adds its instruction to the voice\'s own (kept); the chosen speed is sent to TTS (senior 0.95 is replaced)', async () => {
  const base = LONGFORM_VOICE_PROFILES['female-middle'].instructions
  const ins = LONGFORM_VOICE_TONES.map((tone) => resolveLongformRuntimeVoice({ voiceKey: 'female-middle', tone, speed: 1 }).instructions)
  assert.equal(new Set(ins).size, 3)
  for (const i of ins) assert.ok(i.startsWith(`${base} `), 'the gender/age instruction is kept')
  assert.match(ins[0], /차분한 호흡/); assert.match(ins[1], /자연스럽고 또렷한/); assert.match(ins[2], /밝고 생기 있게.*광고처럼 과장하지 마세요/)
  const sent: any[] = []
  const f: any = async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(Buffer.from('x'), { status: 200 }) }
  for (const speed of LONGFORM_VOICE_SPEEDS) await openAiTts('문장', 'k', resolveLongformRuntimeVoice({ voiceKey: 'male-senior', tone: 'calm', speed }), f)
  assert.deepEqual(sent.map((b) => b.speed), [0.9, 1, 1.1])
  assert.ok(sent.every((b) => b.voice === LONGFORM_VOICE_PROFILES['male-senior'].voice && b.model === 'gpt-4o-mini-tts'))
  assert.equal(LONGFORM_VOICE_PROFILES['male-senior'].speed, 0.95) // the legacy profile itself is unchanged
})

test('5-8: TTS cache identity changes with voice, tone or speed, and is identical for the same combination', () => {
  const id = (voiceKey: any, tone: any, speed: any) => ttsCacheIdentity(resolveLongformRuntimeVoice({ voiceKey, tone, speed }), '같은 문장')
  const a = id('female-middle', 'calm', 1)
  assert.notEqual(a, id('male-middle', 'calm', 1))
  assert.notEqual(a, id('female-middle', 'neutral', 1))
  assert.notEqual(a, id('female-middle', 'calm', 1.1))
  assert.equal(a, id('female-middle', 'calm', 1))
  assert.equal(a, 'tts-v2|ko-lf-female-middle-calm-1.0-v2|같은 문장')
  const all = new Set<string>()
  for (const k of Object.keys(LONGFORM_VOICE_PROFILES)) for (const t of LONGFORM_VOICE_TONES) for (const s of LONGFORM_VOICE_SPEEDS) all.add(id(k, t, s))
  assert.equal(all.size, 6 * 3 * 3)
})

test('9: legacy jobs keep their voice and cache keys; new job input keeps voiceProfile/voiceTone/voiceSpeed; Shorts unchanged', async () => {
  // a brief created before tone/speed existed narrates with the old profile (same id -> same cached audio)
  const legacy = { voice: { choice: 'female-senior', key: 'female-senior', profileId: 'ko-lf-female-senior-v1' } }
  assert.equal(longformVoiceProfile(legacy), LONGFORM_VOICE_PROFILES['female-senior'])
  assert.equal(longformVoiceProfile(legacy).speed, 0.95)
  assert.equal(ttsCacheIdentity(longformVoiceProfile(legacy), '문장'), 'tts-v2|ko-lf-female-senior-v1|문장')
  assert.equal(longformVoiceProfile({} as any), DEFAULT_VOICE_PROFILE) // before voice selection existed
  assert.equal(ttsCacheIdentity(DEFAULT_VOICE_PROFILE, '문장'), 'tts-v1|문장')
  // a new brief carries the three choices; defaults are calm / 1.0
  const b = normalizeLongformBrief({ kind: 'topic', text: BUDDHA, targetSeconds: 3600, voiceProfile: 'female-young', voiceTone: 'bright', voiceSpeed: 1.1 })
  assert.deepEqual(b.creative!.requested, { voiceProfile: 'female-young', voiceTone: 'bright', voiceSpeed: 1.1, visualStyleProfile: 'auto' })
  assert.deepEqual(b.creative!.resolved, { voiceProfile: 'female-young', voiceTone: 'bright', voiceSpeed: 1.1, voiceProfileId: 'ko-lf-female-young-bright-1.1-v2', visualStyleProfile: 'wisdom-painterly' })
  assert.equal(longformVoiceProfile(b).id, 'ko-lf-female-young-bright-1.1-v2'); assert.equal(longformVoiceProfile(b).speed, 1.1)
  assert.deepEqual(normalizeLongformBrief({ kind: 'topic', text: BUDDHA, targetSeconds: 3600 }).creative!.resolved, { voiceProfile: 'male-senior', voiceTone: 'calm', voiceSpeed: 1, voiceProfileId: 'ko-lf-male-senior-calm-1.0-v2', visualStyleProfile: 'wisdom-painterly' })
  // through job_create: stored in the brief unchanged
  const db = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  const r = await http(createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true, voicePreview: async () => { throw new Error('unused') } }),
    { taskType: 'job_create', profile: 'wisdom_longform', idempotencyKey: 'lf-voice-tone-0001', budgetUsd: 5, input: { kind: 'topic', text: BUDDHA, targetSeconds: 3600, voiceProfile: 'auto', voiceTone: 'calm', voiceSpeed: 0.9, aspectRatio: '16:9' } })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  const job: any = await store.getJob(r.json.job.id, r.json.job.workspaceId) ?? r.json.job
  const brief: any = await blobs.getJson(job.planRef)
  assert.deepEqual(brief.creative.resolved, { voiceProfile: 'male-senior', voiceTone: 'calm', voiceSpeed: 0.9, voiceProfileId: 'ko-lf-male-senior-calm-0.9-v2', visualStyleProfile: 'wisdom-painterly' })
  const bad = await http(createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true }), { taskType: 'job_create', profile: 'wisdom_longform', idempotencyKey: 'lf-voice-tone-0002', budgetUsd: 5, input: { kind: 'topic', text: BUDDHA, targetSeconds: 3600, voiceSpeed: 1.3, aspectRatio: '16:9' } })
  assert.equal(bad.status, 400)
  // Wisdom Shorts TTS request is byte-for-byte the same as before
  const sent: any[] = []
  await openAiWisdomTts('같은 문장', 'k', (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(Buffer.from('x'), { status: 200 }) }) as any)
  assert.deepEqual(sent[0], { model: 'gpt-4o-mini-tts', voice: 'marin', input: '같은 문장', instructions: '한국어로 차분하고 따뜻하게, 과장하지 말고 또렷하게 읽어주세요.', response_format: 'mp3', speed: 1 })
})

function fakeTts(fail?: { status: number; body: string }) {
  const calls: any[] = []
  const tts = async (text: string, apiKey: string, p: any) => {
    calls.push({ text, profile: p.id })
    const f: any = async () => (fail ? new Response(fail.body, { status: fail.status }) : new Response(Buffer.from(`mp3:${p.id}`), { status: 200 }))
    return openAiTts(text, apiKey, p, f)
  }
  return { tts, calls }
}

test('10-11: preview MISS -> 1 TTS call + stored; HIT (also a fresh server process) -> 0 calls; the same combination at once -> 1 call', async () => {
  const blobs: any = createMemoryBlobStore(), t = fakeTts(), logs: string[] = []
  const preview = createVoicePreview({ blobs, tts: t.tts, apiKey: () => 'k', log: (l) => logs.push(l) })
  const req = { voiceProfile: 'female-middle', voiceTone: 'neutral', voiceSpeed: 1.0 }
  const first = await preview(req)
  assert.equal(first.cache, 'MISS'); assert.equal(t.calls.length, 1)
  assert.deepEqual(t.calls[0], { text: VOICE_PREVIEW_TEXT, profile: 'ko-lf-female-middle-neutral-1.0-v2' })
  const path = voicePreviewPath(previewVoice(req))
  assert.match(path, /^voice-preview\/[0-9a-f]{64}\.mp3$/)
  assert.equal(blobs.binaries.get(path).toString(), 'mp3:ko-lf-female-middle-neutral-1.0-v2')
  assert.equal(first.playbackUrl, `memory://${path}`)
  const again = await preview(req)
  assert.equal(again.cache, 'HIT'); assert.equal(t.calls.length, 1)
  const restarted = createVoicePreview({ blobs, tts: t.tts, apiKey: () => 'k', log: () => {} })
  assert.equal((await restarted(req)).cache, 'HIT'); assert.equal(t.calls.length, 1)
  // another tone or speed is another preview
  await preview({ ...req, voiceTone: 'bright' }); await preview({ ...req, voiceSpeed: 1.1 })
  assert.equal(t.calls.length, 3)
  // three presses of a new combination at once: ONE provider call
  const burst = await Promise.all([1, 2, 3].map(() => preview({ voiceProfile: 'male-senior', voiceTone: 'calm', voiceSpeed: 0.9 })))
  assert.equal(t.calls.length, 4); assert.ok(burst.every((b) => b.playbackUrl === burst[0].playbackUrl))
  // auto follows the topic rule
  await preview({ voiceProfile: 'auto', topic: BUDDHA, voiceTone: 'calm', voiceSpeed: 0.9 })
  assert.equal(t.calls.length, 4, 'auto + Buddha topic = male-senior calm 0.9: already cached')
  assert.match(logs.join('\n'), /"cache":"MISS".*"ttsCalls":1/); assert.match(logs.join('\n'), /"cache":"HIT".*"ttsCalls":0/)
  assert.doesNotMatch(JSON.stringify(first) + logs.join(''), /marin|cedar|onyx|nova|sage|ash"|Bearer/) // no provider values
})

test('12: preview billing/auth errors stop at once (0 retries, nothing stored); a transient error is not retried automatically', async () => {
  for (const [status, body, code] of [[429, '{"error":{"code":"credit_balance_exhausted"}}', 'PROVIDER_BILLING'], [429, '{"error":{"code":"insufficient_quota"}}', 'PROVIDER_BILLING'], [401, '{"error":{"code":"invalid_api_key"}}', 'PROVIDER_STOP'], [503, 'upstream', 'PREVIEW_FAILED']] as const) {
    const blobs: any = createMemoryBlobStore(), t = fakeTts({ status, body })
    const handler = createJobsHttp({ getStore: async () => { throw new Error('no database for a preview') }, blobs, voicePreview: createVoicePreview({ blobs, tts: t.tts, apiKey: () => 'k', log: () => {} }) })
    const r = await http(handler, { taskType: 'longform_voice_preview', voiceProfile: 'female-young', voiceTone: 'bright', voiceSpeed: 1.1 })
    assert.equal(r.json.ok, false); assert.equal(r.json.error.code, code); assert.ok(r.status >= 500)
    assert.equal(t.calls.length, 1, `${code}: exactly one provider call`)
    assert.equal(blobs.binaries.size + blobs.files.size, 0)
  }
  // the HTTP route: POST only, a sync key is required, bad values are refused before any provider call
  const blobs: any = createMemoryBlobStore(), t = fakeTts()
  const handler = createJobsHttp({ getStore: async () => { throw new Error('no database for a preview') }, blobs, voicePreview: createVoicePreview({ blobs, tts: t.tts, apiKey: () => 'k', log: () => {} }) })
  const ok = await http(handler, { taskType: 'longform_voice_preview', voiceProfile: 'female-middle', voiceTone: 'calm', voiceSpeed: 1 })
  assert.equal(ok.status, 200); assert.deepEqual(Object.keys(ok.json).sort(), ['cache', 'ok', 'playbackUrl', 'validUntil'])
  assert.equal((await http(handler, { taskType: 'longform_voice_preview', voiceProfile: 'marin' })).status, 400)
  assert.equal((await http(handler, { taskType: 'longform_voice_preview', voiceProfile: 'female-middle', voiceSpeed: 1.25 })).status, 400)
  assert.equal(t.calls.length, 1)
})
