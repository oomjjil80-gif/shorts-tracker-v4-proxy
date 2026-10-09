// 숨은야담 Longform as a server job, end to end with stand-ins (no paid call): job_create (45 min) -> PLAN (STORY DNA ->
// outline -> 8 acts (reveal at 80~92%, a first resolution and two further layers after it) -> COLD OPEN over the main
// story's own pictures -> upload text, every step checked against the DNA) -> ASSET (one picture per story scene through
// the shared IMAGE module; Tracker narration per sentence in the grandmother storyteller voice) -> RENDER (16:9 scenes,
// livelier cold-open cuts, bottom subtitles, thumbnail, output QC) -> PACKAGE -> COMPLETE. No user step in between.
// Run: node --import tsx --test tools/yasa-longform-job.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore, putAddressed } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { runOnce } from '../worker/runJob.js'
import { runOk, probe } from '../lib/media/ffmpeg.js'
import { withLongform, createLongformPlanExecutor, createLongformAssetExecutor, longformRenderExecutor, longformPackageExecutor } from '../worker/stages/longform.js'
import { LONGFORM, normalizeLongformBrief, longformRemasterBrief, sentencesOf, cardTimeline, validateLongformScript, longformCardsAss, yasaCaptionChunks, yasaCaptionsAss } from '../lib/generative/longform.js'
import { YASA_ACTS, YASA_REVEAL_ACT, YASA_REVEAL_WINDOW, COLD_OPEN, YADAM_STORYTELLER, yasaActChars, yasaRevealAt, yasaScriptErrors, coldOpenErrors, revealWords, coldOpenCandidates, coldOpenRejections } from '../lib/generative/yasaLongform.js'
import { characterLine, sceneRuns, seniorVideoArgv } from '../lib/generative/seniorLongform.js'
import { VISUAL_STYLE_PROFILES } from '../lib/generative/visualStyle.js'
import { PROFILES } from '../lib/jobs/profiles.js'
import { validateYasaStoryDna } from '../lib/story/yasaStoryDna.js'

const KEY = 'y'.repeat(32)
const TOPIC = '5년 만에 친정 가는 며느리에게 시어머니가 썩은 메주만 지워 보낸 이유'
const DNA = {
  title: '5년 만에 친정 가는 며느리에게 썩은 메주만 지워 보낸 시어머니, 그 이유', openingLine: '"이걸 친정까지 지고 가거라." 시어머니가 내민 것은 썩은 메주 한 덩이였다.',
  setting: { region: '조선', era: '후기 (18세기)', culturalNotes: '충청도 양반가, 초가와 기와집이 섞인 마을' }, storyBasis: 'inspired_fiction',
  hero: { role: '며느리', socialPosition: '몰락 양반가의 며느리', emotionalWound: '시집온 뒤 친정에 한 번도 못 감', desire: '친정 어머니를 만나는 것', immediateProblem: '빈손으로 친정에 가야 함' },
  mystery: { strangeAction: '시어머니가 선물 대신 썩은 메주만 지워 보낸다', concreteProp: '썩은 메주', apparentMeaning: '며느리를 망신 주려는 심술', trueMeaning: '메주 속에 친정을 살릴 금가락지와 땅문서를 숨겨 보낸 것', mainQuestion: '왜 하필 썩은 메주였나?', secondaryQuestion: '메주 속에는 무엇이 있나?' },
  pressure: { immediateLoss: '친정 앞에서 체면을 잃는다', humiliationOrMisunderstanding: '마을 사람들의 조롱', antagonistOrPressure: '친정 마을의 탐관오리', worseningEvents: ['길에서 냄새 때문에 쫓겨난다', '주막에서 도둑으로 몰린다', '친정이 빚 때문에 집을 뺏기기 직전이다'] },
  reveal: { partialProof: '메주가 이상하게 무겁다', majorCrisis: '탐관오리가 메주를 빼앗으려 한다', majorReveal: '메주 속에서 금가락지와 땅문서가 나온다', emotionalReframe: '시어머니의 심술은 사랑이었다' },
  payoff: { externalRewardOrResolution: '친정이 집을 지킨다', emotionalReward: '며느리와 시어머니의 화해', finalAfterglow: '이듬해 봄, 두 사람이 함께 메주를 쑨다' },
  aftermath: { firstResolution: '땅문서로 빚을 갚아 친정이 집을 되찾는다', postRevealLayers: ['탐관오리의 장부 조작이 드러나 마을의 다른 집들도 빚에서 풀려난다', '며느리는 시어머니도 젊은 날 친정을 잃었다는 것을 알게 된다'], lifeLesson: '' },
  propArc: ['짐', '수상한 물건', '위험을 막는 도구', '마지막 비밀의 열쇠']
}
const CAST = [
  { id: 'bride', name: '윤씨', role: '며느리', gender: 'female', age: '28', face: 'gentle oval face, tired eyes', hair: 'neat Joseon chignon with a wooden binyeo', build: 'slender', outfit: 'faded indigo hanbok', colors: 'indigo, cream' },
  { id: 'mil', name: '최씨 부인', role: '시어머니', gender: 'female', age: '60', face: 'stern lined face', hair: 'grey chignon', build: 'small', outfit: 'grey hanbok with a dark jeogori', colors: 'grey, charcoal' }
]
const MINUTES = 45, SECONDS = MINUTES * 60, SPEED = 1
// a main-story sentence of ~300 characters (every act long enough; the reveal act names the prop)
const say = (act: number, k: number) => {
  const core = act === YASA_REVEAL_ACT && k === 0 ? '마침내 썩은 메주가 갈라지자 그 속에서 금가락지와 땅문서가 나왔다.' : `${act + 1}막 ${k + 1}번째 장면에서 며느리는 썩은 메주를 지고 걷는다.`
  return (core + ' 바람이 차가웠고 사람들의 눈길은 더 차가웠다. 며느리는 이를 악물고 한 걸음씩 걸었다.'.repeat(6)).slice(0, 300)
}
const counts = yasaActChars(Math.round(SECONDS * LONGFORM.charsPerSecond)).map((c) => Math.ceil(c / 300))
const actScenes = (a: number): any[] => {
  const sc = [0, 1].map((j) => ({ id: `a${a + 1}s${j + 1}`, place: `장소 ${a + 1}-${j + 1}`, time: j ? '저녁' : '아침', characters: j ? ['bride', 'mil'] : ['bride'], action: `행동 ${a + 1}-${j + 1}`, mood: 'tense', visual: `visual ${a + 1}-${j + 1}${j === 0 ? ' 썩은 메주' : ''}` }))
  // the last act returns to the first act's opening picture (same place/time/people/action/visual): one picture, made once
  return a === YASA_ACTS.length - 1 ? [{ ...actScenes(0)[0], id: `a${a + 1}s1` }, sc[1]] : sc
}
// the cold open: 6 beats on 6 different main-story pictures, the strange act / the danger / the prop / the question,
// never the answer (no 금가락지 / 땅문서 / 빚을 갚 ...), never a main-story sentence; ~330 chars = ~53 s at 1.0x
const COLD = [
  ['a2s1', '"이걸 친정까지 지고 가거라." 오 년 만의 친정길, 시어머니가 내민 것은 썩은 메주 한 덩이였다.'],
  ['a3s1', '고갯길 사람들은 고약한 냄새 나는 짐을 진 젊은 며느리를 손가락질하며 마을 밖으로 매몰차게 쫓아냈다.'],
  ['a3s2', '주막에서는 도둑이라는 누명까지 쓰고 찬 이슬 내리는 마당에 밤새 꿇어앉아야 했다.'],
  ['a5s1', '그리고 마침내 탐관오리의 거친 손이 그 메주 보따리를 향해 천천히 뻗어 왔다.'],
  ['a4s1', '그래도 며느리는 이상하게 무거운 그 짐을 품에 꼭 끌어안고 끝내 단 한 번도 놓지 않았다.'],
  ['a5s2', '도대체 시어머니는 왜, 하필 썩은 메주 한 덩이를 지워 보냈던 걸까요?']
]
function fakePlanner(calls: Record<string, any[]>, o: { coldOpen?: (i: any) => any } = {}) {
  const log = (k: string, v: any) => { (calls[k] ||= []).push(v) }
  return {
    dna: async (brief: any) => { log('dna', brief.targetSeconds); return DNA },
    outline: async (brief: any, n: number) => { log('outline', { dna: brief.yasaStoryDNA, n, targetSeconds: brief.targetSeconds }); return { title: DNA.title, hook: DNA.openingLine, figure: { name: '윤씨', imagePrompt: 'a young Joseon bride' }, thumbnail: { lines: [{ text: '썩은 메주', color: 'red' }, { text: '그 속의 비밀', color: 'white' }] }, characters: CAST, sections: Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, heading: `${i + 1}막`, points: ['a', 'b'], scenes: actScenes(i) })) } },
    section: async (i: any) => {
      log('section', { index: i.index, targetChars: i.targetChars, dna: !!i.brief.yasaStoryDNA })
      const sc = i.outline.sections[i.index].scenes, n = counts[i.index]
      return { sentences: Array.from({ length: n }, (_, k) => ({ scene: sc[Math.min(sc.length - 1, Math.floor((k * sc.length) / n))].id, say: say(i.index, k), show: ['썩은 메주를', '지고 간 며느리'], accent: '썩은 메주', color: 'red' })) }
    },
    coldOpen: async (i: any) => { log('coldOpen', { targetChars: i.targetChars, scenes: i.sections.flatMap((x: any) => x.scenes).length }); return o.coldOpen ? o.coldOpen(i) : { sentences: COLD.map(([scene, s]) => ({ scene, say: s, show: ['썩은 메주', '왜 하필?'], accent: '썩은 메주', color: 'purple' })) } },
    metadata: async () => { log('metadata', 1); return { title: DNA.title, description: '시집온 뒤 5년 동안 친정에 가지 못한 며느리가 있었습니다. 시어머니는 선물 대신 썩은 메주 한 덩이만 지워 보냈습니다. 길 위에서 쫓겨나고 도둑으로 몰리면서도 며느리는 그 짐을 내려놓지 않았습니다. 마지막에 밝혀지는 시어머니의 진짜 마음과 메주 속에 숨겨진 물건이 무엇이었는지, 그리고 그 물건이 친정 식구들을 어떻게 지켜 냈는지 끝까지 확인해 보세요. 조선 후기 한 양반가에서 전해 내려오는 이야기를 바탕으로 다시 구성했습니다.', tags: ['조선 야담', '며느리 이야기', '시어머니 사연', '메주 이야기', '숨은 야담', '고부 갈등', '조선 후기'], hashtags: ['#숨은야담', '#야담', '#조선이야기'], pinnedComment: '여러분이라면 썩은 메주를 받은 며느리처럼 끝까지 지고 갔을까요?' } }
  }
}
// narration stand-in: a short pause + a tone whose length varies by sentence (like real speech), mp3 like the OpenAI voice
let ttsN = 0
const shortTts = async () => { const n = ttsN++, r = await runOk(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.25', '-f', 'lavfi', '-i', `sine=f=${200 + (n % 7) * 40}:d=${(0.6 + (n % 5) * 0.15).toFixed(2)}`, '-filter_complex', '[0][1]concat=n=2:v=0:a=1,volume=0.5', '-c:a', 'libmp3lame', '-f', 'mp3', '-']); return { bytes: r.stdout, contentType: 'audio/mpeg', provider: 'standin', model: 'tone' } }
// a scene picture stand-in: its own colour with a white grid (so on-screen motion is measurable)
async function scenePicture(d: string, n: number) {
  const f = join(d, `p${n}.jpg`)
  await runOk(['-y', '-f', 'lavfi', '-i', `color=c=0x${((n * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}:s=1536x1024,drawgrid=w=96:h=96:t=6:c=white@0.85`, '-frames:v', '1', '-q:v', '3', f])
  return { bytes: await readFile(f), contentType: 'image/jpeg', provider: 'standin', model: 'scene' }
}

test('Generic Longform remaster contract: one job_remaster shape works for Wisdom, Senior and YADAM; only changed creative settings are re-resolved', () => {
  const profiles = ['wisdom_longform', 'senior_longform', 'yasa_longform'] as const
  for (const profile of profiles) {
    const source = normalizeLongformBrief({ kind: 'topic', text: '사람의 선택이 운명을 바꾸는 이야기', targetSeconds: 900, voiceSpeed: 1 }, profile)
    const same = longformRemasterBrief(source, { sourceJobId: 'job_source_12345678', sourceScriptRef: 'generative-scripts/source.json', changes: {} })
    assert.equal(same.profile, profile); assert.deepEqual(same.creative, source.creative)
    assert.deepEqual(same.remaster, { schema: 'longform-remaster/1', sourceJobId: 'job_source_12345678', parentJobId: 'job_source_12345678', sourceScriptRef: 'generative-scripts/source.json', changes: {} })
  }
  const senior = normalizeLongformBrief({ kind: 'topic', text: '어머니와 아들의 오래된 약속', targetSeconds: 900 }, 'senior_longform')
  const restyled = longformRemasterBrief(senior, { sourceJobId: 'job_source_12345678', sourceScriptRef: 'generative-scripts/source.json', changes: { visualStyleProfile: 'historical-dramatic' } })
  assert.equal(restyled.creative!.resolved.visualStyleProfile, 'historical-dramatic')
  assert.equal(restyled.creative!.resolved.voiceProfileId, senior.creative!.resolved.voiceProfileId, 'style-only keeps the voice')
  const wisdom = normalizeLongformBrief({ kind: 'topic', text: '쇼펜하우어의 관계 조언', targetSeconds: 900 }, 'wisdom_longform')
  const voiced = longformRemasterBrief(wisdom, { sourceJobId: 'job_source_12345678', sourceScriptRef: 'generative-scripts/source.json', changes: { voiceSpeed: 1.1 } })
  assert.equal(voiced.creative!.resolved.voiceSpeed, 1.1)
  assert.equal(voiced.creative!.resolved.visualStyleProfile, wisdom.creative!.resolved.visualStyleProfile, 'voice-only keeps the picture style')
  assert.throws(() => longformRemasterBrief(senior, { sourceJobId: 'job_source_12345678', sourceScriptRef: 'x', changes: { refreshColdOpen: true } }), /only available for 숨은야담/)
  assert.throws(() => longformRemasterBrief(wisdom, { sourceJobId: 'job_source_12345678', sourceScriptRef: 'x', changes: { magicChange: true } }), /unknown remaster changes/)
})

test('YADAM profile: shared Longform engine, scenes mode; AUTO = grandmother storyteller (female-senior, calm, 1.0x) + the one 야담 style; 8 acts = the DNA structure', () => {
  assert.deepEqual(PROFILES.yasa_longform.stages, ['PLAN', 'ASSET', 'RENDER', 'PACKAGE'])
  assert.deepEqual(PROFILES.yasa_longform.features, ['PLAN', 'IMAGE', 'TTS', 'CAPTION', 'LONGFORM_RENDER', 'THUMBNAIL', 'QC', 'PACKAGE'])
  const b = normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS }, 'yasa_longform')
  assert.equal(b.targetSeconds, 2700); assert.equal(b.creative!.resolved.visualStyleProfile, 'yadam_reference')
  assert.deepEqual([b.creative!.resolved.voiceProfile, b.creative!.resolved.voiceTone, b.creative!.resolved.voiceSpeed], ['female-senior', 'calm', 1])
  // the user's choice wins
  const mine = normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS, voiceProfile: 'male-middle', voiceSpeed: 1.1 }, 'yasa_longform')
  assert.deepEqual([mine.creative!.resolved.voiceProfile, mine.creative!.resolved.voiceSpeed], ['male-middle', 1.1])
  assert.throws(() => normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS, yasaStoryDNA: { title: 'x' } }, 'yasa_longform'), /yasaStoryDNA is invalid/)
  assert.deepEqual(YASA_ACTS.map((a) => a.key), ['hook', 'relation', 'pressure', 'proof', 'crisis', 'reveal', 'aftermath', 'payoff'])
  const revealStart = YASA_ACTS.slice(0, YASA_REVEAL_ACT).reduce((s, a) => s + a.share, 0)
  assert.ok(revealStart >= YASA_REVEAL_WINDOW.min && revealStart <= YASA_REVEAL_WINDOW.max, `${revealStart}`); assert.deepEqual(YASA_REVEAL_WINDOW, { min: 0.8, max: 0.92 })
  const beats = YASA_ACTS.flatMap((a) => a.beats as readonly string[])
  for (const k of ['mystery.strangeAction', 'mystery.concreteProp', 'mystery.apparentMeaning', 'pressure.worseningEvents', 'reveal.partialProof', 'reveal.majorCrisis', 'reveal.majorReveal', 'aftermath.firstResolution', 'aftermath.postRevealLayers', 'reveal.emotionalReframe', 'payoff']) assert.ok(beats.includes(k), k)
  // single-reveal stories are refused: a longform DNA needs a first resolution and two different further layers
  const one = structuredClone(DNA); one.aftermath.postRevealLayers = [one.aftermath.postRevealLayers[0]]
  assert.match(validateYasaStoryDna(one, 'longform', { layers: true }).errors.join(';'), /at least 2 different layers/)
  const noFirst = structuredClone(DNA); noFirst.aftermath.firstResolution = ''
  assert.match(validateYasaStoryDna(noFirst, 'longform', { layers: true }).errors.join(';'), /firstResolution/)
  // a PLAN made before the layers existed (an Episode already in production) still passes the script endpoints
  const legacy: any = structuredClone(DNA); delete legacy.aftermath
  assert.equal(validateYasaStoryDna(legacy, 'longform').ok, true); assert.equal(validateYasaStoryDna(legacy, 'longform', { layers: true }).ok, false)
  assert.equal(validateYasaStoryDna({ ...structuredClone(DNA), aftermath: { firstResolution: '', postRevealLayers: [], lifeLesson: '' } }, 'shorts').ok, true, 'shorts keep their single payoff')
})

test('YADAM 45-minute job: job_create -> PLAN (DNA, 8 acts, cold open) -> ASSET -> RENDER -> PACKAGE -> COMPLETE with zero user steps', async () => {
  const d = await mkdtemp(join(tmpdir(), 'yadam-job-'))
  const db = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  ;(blobs as any).presign = async (ref: string) => ({ url: `memory://${ref}`, validUntil: 'x' })
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  const call = async (method: string, opts: { body?: any; query?: any } = {}) => {
    let status = 0, json: any = null
    const req: any = { method, headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: opts.query || {}, body: opts.body }
    const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }
    await handler(req, res); return { status, json }
  }
  const created = await call('POST', { body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'yadam-lf-45-0001', budgetUsd: 5, input: { kind: 'topic', text: TOPIC, targetSeconds: SECONDS, language: 'ko', aspectRatio: '16:9' } } })
  assert.equal(created.status, 201, JSON.stringify(created.json)); const jobId = created.json.job.id

  const calls: Record<string, any[]> = {}, prompts: string[] = [], voices: any[] = []
  const executors = withLongform([], [
    createLongformPlanExecutor({ apiKey: 'k', research: async () => { throw new Error('a yadam story is not researched') }, log: () => {}, planner: fakePlanner(calls) as any }),
    createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk', image: async () => { throw new Error('a 야담 picture never bypasses the style contract') }, yadam: async (p: string) => { prompts.push(p); return scenePicture(d, prompts.length) }, tts: async (_t: string, _k: string, v: any) => { voices.push(v); return shortTts() } } as any),
    longformRenderExecutor, longformPackageExecutor
  ])
  let record: any = null
  for (let i = 0; i < 8; i++) { const r: any = await runOnce({ store, blobs, executors, resolveSourceAsset: async () => { throw new Error('no source asset') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 }); if (!r.ran) break; record = r.job; assert.ok(r.ran && r.outcome === 'completed', JSON.stringify(r)) }
  const job = (await call('GET', { query: { taskType: 'job_get', id: jobId } })).json.job
  assert.equal(job.status, 'COMPLETE', JSON.stringify(job.runs)); assert.equal(job.final.publishable, true)
  const runs = await store.listStageRuns(jobId), ok = (st: string) => runs.find((r: any) => r.stage === st && r.status === 'SUCCEEDED') as any
  assert.deepEqual(['PLAN', 'ASSET', 'RENDER', 'PACKAGE'].map((st) => !!ok(st)), [true, true, true, true])

  // 45 minutes all the way: brief -> DNA -> outline -> each act's target (no 15/22/30 rounding)
  assert.equal(ok('PLAN').result.targetSeconds, 2700)
  assert.deepEqual(calls.dna, [2700]); assert.equal(calls.outline[0].targetSeconds, 2700); assert.deepEqual(calls.outline[0].dna, DNA); assert.equal(calls.outline[0].n, 8)
  assert.deepEqual(calls.section.map((x: any) => x.targetChars), yasaActChars(16740)); assert.ok(calls.section.every((x: any) => x.dna))
  assert.equal(calls.coldOpen.length, 1); assert.equal(calls.coldOpen[0].targetChars, Math.round(COLD_OPEN.seconds.target * LONGFORM.charsPerSecond * SPEED))
  // the DNA is in the final script and checked (deterministic): 8 acts, reveal at 80~92% of the main story, the layers
  const script: any = await blobs.getJson(ok('PLAN').result.scriptRef)
  assert.equal(script.schema, 'yasa-longform-script/1'); assert.deepEqual(script.yasaStoryDNA, DNA)
  assert.deepEqual(script.sections.map((s: any) => s.act), YASA_ACTS.map((a) => a.key))
  assert.deepEqual(yasaScriptErrors(script, { speed: SPEED }), [])
  const at = yasaRevealAt(script.sections); assert.ok(at >= 0.8 && at <= 0.92, `reveal at ${at}`); assert.equal(ok('PLAN').result.yasa.revealAt, Number(at.toFixed(3)))
  assert.ok(script.sections[YASA_REVEAL_ACT + 1].sentences.length >= 1 && script.sections[YASA_REVEAL_ACT + 2].sentences.length >= 1, 'aftermath + payoff acts after the reveal')
  // the cold open: before the main story, 5~8 beats, 45~60 s at 1.0x, no answer, no main-story sentence
  const cold = script.coldOpen.sentences
  assert.ok(cold.length >= 5 && cold.length <= 8)
  const coldSec = [...cold.map((x: any) => x.say).join(' ')].length / (LONGFORM.charsPerSecond * SPEED)
  assert.ok(coldSec >= 45 && coldSec <= 60, `${coldSec}`); assert.deepEqual(ok('PLAN').result.yasa.coldOpen.beats, 6)
  assert.ok(!revealWords(DNA).some((w) => cold.map((x: any) => x.say).join(' ').includes(w)), 'no trueMeaning / majorReveal in the cold open')
  assert.deepEqual(sentencesOf(script).slice(0, cold.length).map((x: any) => x.say), cold.map((x: any) => x.say), 'the cold open is told first')

  // pictures: one per story scene, all through the ONE 야담 style contract (the drawer gets only WHAT is shown: scene,
  // setting, Character Bible, prop — never a style text); the repeated scene is made once; the cold open adds no picture
  const scenes = script.sections.flatMap((s: any) => s.scenes)
  assert.equal(scenes.length, 16); assert.equal(prompts.length, 15, 'the repeated opening picture is generated once; the cold open reuses main-story pictures')
  assert.ok(prompts.every((p) => p.includes('조선, 후기 (18세기)') && p.includes('Joseon hanbok') && p.includes('Qing queue') && p.includes(characterLine(CAST[0] as any)) && /another country or era/.test(p)))
  assert.ok(prompts.every((p) => !/Style:|watercolor|storybook|painterly|webtoon|illustration|sepia|muted/i.test(p)), 'no style words reach the drawer: the contract adds the style')
  assert.ok(prompts.filter((p) => p.includes('"썩은 메주" looks exactly the same')).length === 7)
  // narration: one Tracker TTS call per sentence (cold open + main story), the grandmother storyteller voice
  const sentences = sentencesOf(script).length
  assert.equal(voices.length, sentences); assert.equal(sentences, cold.length + counts.reduce((a, b) => a + b, 0))
  assert.ok(voices.every((v) => v.id === 'ko-lf-female-senior-calm-1.0-yadam-v1' && v.speed === 1 && v.voice === 'sage' && v.instructions.startsWith(YADAM_STORYTELLER)))

  // the package: final MP4 (16:9, narration, the measured length) + thumbnail + upload text
  const pk = (await call('GET', { query: { taskType: 'job_package', id: jobId } })).json
  assert.match(pk.videoUrl, /^memory:\/\/renders\/.+\.mp4$/); assert.match(pk.thumbnailUrl, /^memory:\/\/renders\/.+\.jpg$/)
  for (const k of ['title', 'description', 'tags', 'hashtags', 'pinnedComment']) assert.ok(pk.upload[k] && String(pk.upload[k]).length, k)
  const mp4 = join(d, 'final.mp4'), thumb = join(d, 'thumb.jpg')
  await writeFile(mp4, blobs.binaries.get(pk.package.finalRenderRef)); await writeFile(thumb, blobs.binaries.get(pk.package.thumbnailRef))
  const info = await probe(mp4), tinfo = await probe(thumb), assets: any = await blobs.getJson(ok('ASSET').result.assetSpecRef)
  assert.deepEqual([info.width, info.height, info.hasAudio], [1920, 1080, true])
  assert.ok(Math.abs(Number(info.duration) - assets.narration.seconds) < 0.5)
  assert.deepEqual([tinfo.width, tinfo.height], [1280, 720])
  assert.equal(ok('RENDER').result.scenePictures, 16) // 16 scenes on screen, 15 pictures made
  // the cold open on screen: its own runs first (one per beat, on the main-story pictures), always moving
  const tl = cardTimeline(script, assets.chunks, assets.chunks.map((c: any) => c.seconds)), spans = sceneRuns(script, tl)
  assert.deepEqual(spans.filter((s) => s.cold).map((s) => s.sceneId), cold.map((x: any) => x.scene)); assert.ok(spans.slice(0, cold.length).every((s) => s.cold) && !spans[cold.length].cold)
  const frame = async (t: number) => (await runOk(['-ss', t.toFixed(3), '-i', mp4, '-frames:v', '1', '-vf', 'crop=1600:600:160:120,scale=160:60', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])).stdout
  const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length }
  for (const s of spans.filter((x) => x.cold)) assert.ok(mad(await frame(s.start + 0.05), await frame(s.end - 0.08)) > 2, `cold beat ${s.sceneId} moves`)
  const argv = seniorVideoArgv({ images: ['a.jpg', 'b.jpg'], runs: [{ image: 0, seconds: 2, cold: true }, { image: 1, seconds: 2 }], audio: 'n.m4a', ass: 'c.ass', fontsDir: 'f', out: 'o.mp4', seconds: 4, threads: 2 }).join(' ')
  assert.ok(argv.includes('1+0.16*t') && argv.includes('1+0.06*t') === false && /scale=2380:1340/.test(argv), 'cold beats: stronger push-in; story scenes keep the gentle motion')
  // an ASSET retry pays for nothing (every picture and sentence is cached)
  prompts.length = 0; voices.length = 0
  await createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk', image: async () => { throw new Error('a 야담 picture never bypasses the style contract') }, yadam: async (p: string) => { prompts.push(p); return scenePicture(d, 99) }, tts: async (_t: string, _k: string, v: any) => { voices.push(v); return shortTts() } } as any).run({ job: record, blobs, previous: async (st: string) => ok(st), signal: new AbortController().signal } as any)
  assert.deepEqual([prompts.length, voices.length], [0, 0])
})

test('YADAM checks: opening, prop in the reveal, reveal 80~92%, lecture ending, cold open (beats, length, answer, repeats); the PLAN retry reuses stored steps', async () => {
  const blobs: any = createMemoryBlobStore()
  const brief = normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS }, 'yasa_longform')
  const stored = await putAddressed(blobs, 'generative-briefs', brief)
  const job = { id: 'y1', profile: 'yasa_longform', planRev: 1, planRef: stored.path }
  const ctx = () => ({ job, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  // act 1 that starts with background (banned) is repaired once, then the step fails (retryable; checkpoints kept)
  const calls: Record<string, any[]> = {}
  const bad = fakePlanner(calls), badSection = bad.section
  ;(bad as any).section = async (i: any) => { const r = await badSection(i); if (i.index === 0) r.sentences[0].say = '옛날 조선시대에는 며느리가 많았다. ' + r.sentences[0].say; return r }
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: bad as any }).run(ctx()), (e: any) => e.code === 'SECTION_INVALID' && /yasa\.opening/.test(e.message) && e.retryable === true)
  assert.equal(calls.section.length, 2, 'one repair with the exact errors'); assert.equal(calls.dna.length, 1)
  // a cold open that gives the answer away is repaired once, then fails
  const leak: Record<string, any[]> = {}
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner(leak, { coldOpen: () => ({ sentences: COLD.map(([scene, s], i) => ({ scene, say: i === 5 ? '그 메주 속에는 금가락지와 땅문서가 들어 있었다.' : s, show: ['썩은 메주', '왜?'], accent: '썩은 메주', color: 'red' })) }) }) as any }).run(ctx()), (e: any) => e.code === 'COLD_OPEN_INVALID' && /reveals_answer: .*(금가락지|땅문서)/.test(e.message))
  assert.equal(leak.coldOpen.length, 3, 'up to 3 tries per stage attempt'); assert.equal(leak.dna, undefined, 'DNA reused'); assert.equal(leak.section.length, 8, 'each act written once (none had passed before)')
  // the retry reuses the stored DNA + outline + acts; only the cold open is written again — told what was refused (the
  // scene that carried the answer three times is replaced)
  const again: Record<string, any[]> = {}
  const told: any[] = []
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner(again, { coldOpen: (i: any) => { told.push(i.rejected); return { sentences: COLD.map(([scene, s]) => ({ scene: i.rejected.avoidScenes.includes(scene) ? 'a4s2' : scene, say: s, show: ['썩은 메주', '왜'], accent: '썩은 메주', color: 'red' })) } } }) as any }).run(ctx())
  assert.deepEqual(told[0].avoidScenes, ['a5s2']); assert.ok(told[0].terms.length > 0)
  assert.deepEqual([again.dna, again.outline, again.section, again.coldOpen?.length], [undefined, undefined, undefined, 1])
  const script: any = await blobs.getJson(out.result.scriptRef)
  assert.deepEqual(validateLongformScript(script, brief), [])
  const noProp = structuredClone(script); noProp.sections[YASA_REVEAL_ACT].sentences.forEach((x: any) => { x.say = x.say.replace(/메주/g, '보따리') })
  assert.match(yasaScriptErrors(noProp, { speed: SPEED }).join(';'), /reveal: concreteProp/)
  const late = structuredClone(script); late.sections.slice(YASA_REVEAL_ACT).forEach((x: any) => { x.sentences = x.sentences.slice(0, 1) }) // the reveal pushed past 92%
  assert.match(yasaScriptErrors(late, { speed: SPEED }).join(';'), /reveal_at 9[3-9]%/)
  const early = structuredClone(script); early.sections[YASA_REVEAL_ACT].sentences.push(...early.sections[YASA_REVEAL_ACT].sentences, ...early.sections[YASA_REVEAL_ACT].sentences)
  assert.match(yasaScriptErrors(early, { speed: SPEED }).join(';'), /reveal_at [67]\d%/)
  const lecture = structuredClone(script); lecture.sections.at(-1).sentences.at(-1).say += ' 그러므로 우리는 부모의 사랑을 잊지 말아야 합니다.'
  assert.match(yasaScriptErrors(lecture, { speed: SPEED }).join(';'), /lesson/)
  const noDna = structuredClone(script); delete noDna.yasaStoryDNA
  assert.match(validateLongformScript(noDna, brief).join(';'), /yasa\.dna/)
  // the cold open rules on their own
  const ids = new Set<string>(script.sections.flatMap((s: any) => s.scenes.map((x: any) => x.id))), main = script.sections.flatMap((s: any) => s.sentences.map((x: any) => x.say))
  const co = (sents: any[]) => coldOpenErrors(sents, { dna: DNA, sceneIds: ids, mainSentences: main, speed: SPEED, charsPerSecond: LONGFORM.charsPerSecond }).join(';')
  const good = script.coldOpen.sentences
  assert.equal(co(good), '')
  assert.match(co(good.slice(0, 4)), /cold_open\.beats 4/)
  assert.match(co([...good, ...good.slice(0, 3).map((x: any) => ({ ...x, say: x.say + ' 그날 밤 마을은 조용하지 않았다.' }))]), /cold_open\.(beats|length)/)
  assert.match(co(good.map((x: any, i: number) => (i === 2 ? { ...x, say: main[0] } : x))), /repeats_main_story/)
  assert.match(co(good.map((x: any, i: number) => (i === 1 ? { ...x, scene: good[0].scene } : x))), /different picture/)
  assert.match(co(good.map((x: any, i: number) => (i === 1 ? { ...x, scene: 'nope' } : x))), /main story's scenes/)
})

test('YADAM planner requests (stubbed fetch, no paid call): DNA schema + rules; outline/acts/cold open carry the DNA and their job', async () => {
  const { openAiYasaPlanner } = await import('../lib/generative/yasaPlanner.js')
  const sent: any[] = []
  const f: any = async (_u: string, init: any) => { const b = JSON.parse(init.body); sent.push(b); return new Response(JSON.stringify({ output_text: JSON.stringify(b.text.format.name === 'yasa_story_dna' ? DNA : {}) }), { status: 200 }) }
  const p = openAiYasaPlanner(f)
  const brief: any = { ...normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS }, 'yasa_longform') }
  assert.deepEqual(await p.dna(brief, 'k'), DNA)
  assert.equal(sent[0].text.format.name, 'yasa_story_dna'); assert.equal(sent[0].text.format.strict, true)
  assert.ok(sent[0].text.format.schema.required.includes('aftermath'))
  assert.match(sent[0].instructions, /숨은야담/); assert.match(sent[0].instructions, /목표 길이 약 2700초/); assert.match(sent[0].instructions, /POST-REVEAL LAYER 최소 2개/); assert.match(sent[0].input, /썩은 메주/)
  await p.outline({ ...brief, yasaStoryDNA: DNA }, 8, 'k')
  assert.equal(sent[1].text.format.name, 'yasa_longform_outline'); assert.match(sent[1].instructions, /about 45 minutes/)
  assert.ok(sent[1].instructions.includes(JSON.stringify(DNA, null, 2)), 'the outline is written from the DNA as is')
  const outline: any = { title: DNA.title, hook: DNA.openingLine, sections: YASA_ACTS.map((a, i) => ({ id: `a${i + 1}`, heading: a.key, points: ['x', 'y'], scenes: [{ id: `a${i + 1}s1`, place: 'p', time: 't', action: 'a', mood: 'm', visual: 'v', characters: [] }] })), characters: [] }
  await p.section({ brief: { ...brief, yasaStoryDNA: DNA }, outline, index: 0, previousTail: [], targetChars: 1674 }, 'k')
  await p.section({ brief: { ...brief, yasaStoryDNA: DNA }, outline, index: YASA_REVEAL_ACT + 1, previousTail: ['…'], targetChars: 1172 }, 'k')
  assert.match(sent[2].instructions, /separate cold open/); assert.match(sent[2].instructions, /about 1674 Korean characters/); assert.match(sent[2].instructions, /Never repeat a hardship/)
  assert.ok(sent[3].instructions.includes(YASA_ACTS[YASA_REVEAL_ACT + 1].role) && /postRevealLayers/.test(sent[3].instructions))
  await p.coldOpen({ brief: { ...brief, yasaStoryDNA: DNA }, outline, sections: outline.sections.map((s: any) => ({ ...s, sentences: [] })), targetChars: 290 }, 'k')
  assert.equal(sent[4].text.format.name, 'yasa_longform_cold_open'); assert.match(sent[4].instructions, /NEVER reveal/); assert.match(sent[4].instructions, /about 290 Korean characters/)
  assert.deepEqual(sent[4].text.format.schema.properties.sentences.properties ?? sent[4].text.format.schema.properties.sentences.items.properties.scene.enum, outline.sections.map((s: any) => s.scenes[0].id))
  assert.ok([sent[2], sent[3], sent[4]].every((b) => b.instructions.includes(JSON.stringify(DNA, null, 2))))
})

test('YADAM quality: cold open from the middle (never the first 10% / the reveal / a near repeat); captions = the narration word for word; REMASTER child reuses the source script + TTS', async () => {
  const db = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  const call = async (body: any) => { let status = 0, json: any = null; const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }; await handler({ method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: {}, body } as any, res); return { status, json } }
  const d = await mkdtemp(join(tmpdir(), 'yadam-remaster-'))
  const src = await call({ taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'yadam-src-00001', budgetUsd: 5, input: { kind: 'topic', text: TOPIC, targetSeconds: SECONDS, voiceSpeed: 0.9 } })
  const sourceId = src.json.job.id
  // stand-ins that count every paid call (no real AI / image / TTS call anywhere)
  const calls: Record<string, any[]> = {}, prompts: string[] = [], ttsTexts: string[] = [], voiceIds: string[] = []
  let seen: any = null
  const planner: any = fakePlanner(calls, { coldOpen: (i: any) => { seen = i; return { sentences: COLD.map(([scene, s]) => ({ scene, say: s, show: ['썩은 메주', '왜'], accent: '썩은 메주', color: 'red' })) } } })
  const tick = (pl: any) => runOnce({ store, blobs, executors: withLongform([], [createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: pl }), createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk', image: async () => { throw new Error('a 야담 picture never bypasses the style contract') }, yadam: async (p: string) => { prompts.push(p); return scenePicture(d, prompts.length) }, tts: async (t: string, _k: string, v: any) => { ttsTexts.push(t); voiceIds.push(v.id); return shortTts() } } as any)]), resolveSourceAsset: async () => { throw new Error('none') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 } as any)
  await tick(planner); await tick(planner) // source PLAN + ASSET
  const sourceRuns = await store.listStageRuns(sourceId), splan: any = sourceRuns.find((r: any) => r.stage === 'PLAN' && r.status === 'SUCCEEDED')
  const script: any = await blobs.getJson(splan.result.scriptRef)

  // 1-3: the cold open may use only scenes past the first 10% and before the reveal; the 15~65% middle first
  const cand = coldOpenCandidates(script.sections)
  assert.ok(cand.list.every((c) => c.at >= 0.1 && c.act < YASA_REVEAL_ACT), JSON.stringify(cand.list))
  assert.ok(!cand.allowed.has('a1s1') && ![...cand.allowed].some((id) => /^a[678]s/.test(id)), 'no opening scene, no reveal / aftermath / payoff scene')
  assert.ok(cand.list.filter((c) => c.preferred).every((c) => c.at >= 0.15 && c.at <= 0.65) && cand.preferred.size >= 2)
  assert.deepEqual(seen.candidates.map((c: any) => c.id).sort(), [...cand.allowed].sort(), 'the planner is offered only these')
  const ids = new Set<string>(script.sections.flatMap((s: any) => s.scenes.map((x: any) => x.id))), main = script.sections.flatMap((s: any) => s.sentences.map((x: any) => x.say))
  const co = (sents: any[]) => coldOpenErrors(sents, { dna: DNA, sceneIds: ids, mainSentences: main, speed: 0.9, charsPerSecond: LONGFORM.charsPerSecond, candidates: cand }).join(';')
  const good = script.coldOpen.sentences
  assert.equal(co(good), '')
  assert.match(co(good.map((x: any, i: number) => (i === 0 ? { ...x, scene: 'a1s1' } : x))), /cold_open\[0\]\.scene a1s1: not from the first 10%/)
  assert.match(co(good.map((x: any, i: number) => (i === 1 ? { ...x, scene: 'a7s1' } : x))), /cold_open\[1\]\.scene a7s1: not from the first 10% of the story nor from the reveal/)
  const late = [...cand.list].filter((c) => !c.preferred).map((c) => c.id)
  assert.match(co(good.map((x: any, i: number) => ({ ...x, scene: late[i % late.length] === good[i - 1]?.scene ? late[(i + 1) % late.length] : late[i % late.length] }))), /cold_open\.middle 0\/6/)
  // 4: the same event in almost the same words is refused (exact copies already were)
  const near = main[12].replace('걷는다', '걸었다')
  assert.match(co(good.map((x: any, i: number) => (i === 2 ? { ...x, say: near } : x))), /cold_open\[2\]\.near_repeats_main_story/)

  // 5-6: 숨은야담 captions are the narration itself: chunks joined = the sentence; inside its audio span, no gap / overlap
  const long = '노파는 떨리는 손으로 낡은 열쇠를 소년의 손에 쥐여 주었습니다. "이것만은 절대 잃어버리면 안 된다." 소년은 고개를 끄덕였지만, 그 열쇠가 무엇을 여는지는 아무도 말해 주지 않았습니다.'
  for (const say of [long, ...sentencesOf(script).map((x: any) => x.say)]) {
    const chunks = yasaCaptionChunks(say)
    assert.equal(chunks.map((c) => c.text).join(' '), say.replace(/\s+/g, ' ').trim(), 'every letter of the narration, in order')
    assert.ok(chunks.every((c) => c.lines.length >= 1 && c.lines.length <= 2))
  }
  assert.ok(yasaCaptionChunks(long).length >= 2, 'a long sentence is several caption events')
  const sa: any = await blobs.getJson((sourceRuns.find((r: any) => r.stage === 'ASSET' && r.status === 'SUCCEEDED') as any).result.assetSpecRef)
  const tl = cardTimeline(script, sa.chunks, sa.chunks.map((c: any) => c.seconds)), cap = yasaCaptionsAss(script, tl)
  assert.equal(cap.sentences, sentencesOf(script).length)
  for (const t of tl) {
    const ev = cap.cards.filter((c) => c.k === t.k)
    assert.equal(ev.map((c) => c.lines.join(' ')).join(' '), sentencesOf(script)[t.k].say.replace(/\s+/g, ' ').trim())
    assert.equal(ev[0].start, t.start); assert.equal(ev.at(-1)!.end, t.end)
    for (let i = 1; i < ev.length; i++) assert.equal(ev[i].start, ev[i - 1].end, 'no gap, no overlap')
  }
  assert.ok(!cap.ass.includes('지고 간 며느리'), 'the planner\'s short "show" lines are never the 숨은야담 caption')
  // 7: Wisdom / Senior keep their sentence cards (one card per sentence, the "show" lines)
  const cards = longformCardsAss(script, tl, 'bottom')
  assert.equal(cards.cards.length, tl.length); assert.ok(cards.ass.includes('지고 간 며느리'))

  // 8: REMASTER — a new child job from the source (kept as it is): a new cold open; 야담 has one 그림체, so no style change
  const before = { prompts: prompts.length, tts: ttsTexts.length }
  assert.equal((await call({ taskType: 'job_remaster', sourceJobId: sourceId, changes: { visualStyleProfile: 'senior-warm-watercolor', refreshColdOpen: true } })).status, 400, 'only the content profile\'s picture styles')
  assert.equal((await call({ taskType: 'job_remaster', sourceJobId: 'job_nope', changes: {} })).status, 404)
  // legacy alias stays compatible, but production code and future UI use job_remaster.
  assert.equal((await call({ taskType: 'job_remaster_yasa', sourceJobId: sourceId, visualStyleProfile: 'webtoon_historical', idempotencyKey: 'legacy-alias-check-1' })).status, 201)
  assert.equal((await call({ taskType: 'job_remaster', sourceJobId: sourceId, changes: { visualStyleProfile: 'webtoon_historical', refreshColdOpen: true } })).status, 400, 'an old 야담 style is not a choice any more')
  const rm = await call({ taskType: 'job_remaster', sourceJobId: sourceId, changes: { refreshColdOpen: true }, idempotencyKey: 'generic-remaster-check-1' })
  assert.equal(rm.status, 201, JSON.stringify(rm.json)); const childId = rm.json.job.id
  assert.notEqual(childId, sourceId)
  // the remaster writes ONLY a new cold open (a different one); DNA / outline / acts / upload text are never asked for
  const newCold = COLD.map(([scene, s]) => [scene, `${s.slice(0, -1)}…`]) // every line new, same length
  const only: any = { coldOpen: async () => ({ sentences: newCold.map(([scene, s]) => ({ scene, say: s, show: ['썩은 메주', '왜'], accent: '썩은 메주', color: 'red' })) }), dna: async () => { throw new Error('no DNA') }, outline: async () => { throw new Error('no outline') }, section: async () => { throw new Error('no act') }, metadata: async () => { throw new Error('no metadata') } }
  for (let i = 0; i < 4; i++) { const r: any = await tick(only); if (!r.ran) break }
  const childRuns = await store.listStageRuns(childId), cplan: any = childRuns.find((r: any) => r.stage === 'PLAN' && r.status === 'SUCCEEDED')
  assert.ok(cplan && childRuns.some((r: any) => r.stage === 'ASSET' && r.status === 'SUCCEEDED'), JSON.stringify(childRuns.map((r: any) => [r.stage, r.status, r.error])))
  assert.deepEqual([cplan.result.remaster.sourceJobId, cplan.result.remaster.sourceScriptRef], [sourceId, splan.result.scriptRef])
  const child: any = await blobs.getJson(cplan.result.scriptRef)
  assert.deepEqual([child.sections, child.yasaStoryDNA, child.metadata, child.title, child.characters], [script.sections, script.yasaStoryDNA, script.metadata, script.title, script.characters], 'the story, acts, narration and upload text are the source\'s')
  assert.deepEqual(child.coldOpen.sentences.map((x: any) => x.say), newCold.map(([, s]) => s))
  // TTS: only the new cold open lines (the main narration comes from the cache: same voice, same text); pictures: all reused
  const childTts = ttsTexts.slice(before.tts)
  assert.deepEqual(childTts.sort(), newCold.map(([, s]) => s).sort(), 'no main-story TTS again')
  assert.ok(new Set(voiceIds).size === 1 && voiceIds[0] === 'ko-lf-female-senior-calm-0.9-yadam-v1', 'the source voice (0.9x) is kept')
  const childPrompts = prompts.slice(before.prompts)
  assert.equal(childPrompts.length, 0, 'the same story in the same (only) style: every picture comes from the cache')
  // the source job keeps its own script
  assert.equal(((await store.listStageRuns(sourceId)).find((r: any) => r.stage === 'PLAN' && r.status === 'SUCCEEDED') as any).result.scriptRef, splan.result.scriptRef)
})

test('COLD OPEN REPAIR MEMORY: a refused answer word, sentence and scene are carried into every next attempt (also across stage retries); same word twice -> the scene is replaced; the checks stay as strict', async () => {
  const blobs: any = createMemoryBlobStore()
  const brief = normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS }, 'yasa_longform')
  const stored = await putAddressed(blobs, 'generative-briefs', brief)
  const job = { id: 'ymem', profile: 'yasa_longform', planRev: 1, planRef: stored.path }
  const ctx = () => ({ job, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  const word = revealWords(DNA)[0] // a word of the answer (never allowed in a cold open)
  const beats = (leakAt: number | null, scene3 = 'a5s1') => COLD.map(([scene, s], i) => ({ scene: i === 3 ? scene3 : scene, say: i === leakAt ? `${s.slice(0, -1)} ${word}.` : s, show: ['썩은 메주', '왜'], accent: '썩은 메주', color: 'red' }))
  const seen: any[] = []
  // A: try 1 leaks the word, try 2 leaks it AGAIN on the same scene, try 3 (given the memory) uses another middle scene
  const plan: any = fakePlanner({}, { coldOpen: (i: any) => { seen.push(i.rejected); const n = seen.length; return { sentences: n <= 2 ? beats(3) : beats(null, i.rejected.avoidScenes.includes('a5s1') ? 'a4s2' : 'a5s1') } } })
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: plan }).run(ctx())
  assert.equal(seen.length, 3, 'FAIL, FAIL, PASS within one stage attempt')
  // B: what the next attempt was told
  assert.deepEqual([seen[0].terms, seen[0].sentences], [[], []], 'the first attempt has nothing to avoid')
  assert.deepEqual(seen[1].terms, [word]); assert.ok(seen[1].sentences.some((x: string) => x.includes(word))); assert.deepEqual(seen[1].avoidScenes, [], 'one failure: the wording changes')
  assert.deepEqual(seen[2].terms, [word]); assert.deepEqual(seen[2].avoidScenes, ['a5s1'], 'the same word twice: the scene that carried it is replaced')
  const script: any = await blobs.getJson(out.result.scriptRef)
  assert.equal(script.coldOpen.sentences[3].scene, 'a4s2'); assert.ok(!script.coldOpen.sentences.some((x: any) => x.say.includes(word)))
  assert.deepEqual(validateLongformScript(script, brief), [], 'the passing cold open meets every rule')

  // B (across stage retries): every try of a stage attempt fails -> the NEXT stage attempt starts with that memory
  const blobs2: any = createMemoryBlobStore(), stored2 = await putAddressed(blobs2, 'generative-briefs', brief)
  const ctx2 = () => ({ job: { ...job, id: 'ymem2', planRef: stored2.path }, blobs: blobs2, previous: async () => null, signal: new AbortController().signal } as any)
  const first: any[] = []
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner({}, { coldOpen: (i: any) => { first.push(i.rejected); return { sentences: beats(3) } } }) as any }).run(ctx2()), (e: any) => e.code === 'COLD_OPEN_INVALID' && e.message.includes(`reveals_answer: ${word}`) && e.retryable)
  assert.equal(first.length, 3)
  const retry: any[] = []
  const again: any = await createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner({}, { coldOpen: (i: any) => { retry.push(i.rejected); return { sentences: beats(null, i.rejected.avoidScenes.includes('a5s1') ? 'a4s2' : 'a5s1') } } }) as any }).run(ctx2())
  assert.equal(retry.length, 1); assert.deepEqual([retry[0].terms, retry[0].avoidScenes], [[word], ['a5s1']], 'the stage retry knows what was refused before')
  assert.ok(again.result.scriptRef)

  // C: the checks are as strict as before — the same leak is refused with or without memory, an avoided scene too
  const ids = new Set<string>(script.sections.flatMap((s: any) => s.scenes.map((x: any) => x.id))), main = script.sections.flatMap((s: any) => s.sentences.map((x: any) => x.say))
  const co = (sents: any[], avoid?: Set<string>) => coldOpenErrors(sents, { dna: DNA, sceneIds: ids, mainSentences: main, speed: 1, charsPerSecond: LONGFORM.charsPerSecond, candidates: coldOpenCandidates(script.sections), avoidScenes: avoid }).join(';')
  assert.match(co(beats(3)), new RegExp(`reveals_answer: ${word}`))
  assert.match(co(beats(null), new Set(['a5s1'])), /cold_open\[3\]\.scene a5s1: rejected before/)
  assert.equal(co(beats(null, 'a4s2'), new Set(['a5s1'])), '')
  // never narrowed below what a cold open needs: with too few scenes left the scene rule is not applied (the wording rules are)
  const r = coldOpenRejections([{ errors: [`cold_open.reveals_answer: ${word}`], sentences: beats(3) }, { errors: [`cold_open.reveals_answer: ${word}`], sentences: beats(3) }], { allowed: new Set(['a5s1', 'a4s2']) })
  assert.deepEqual([r.terms, [...r.avoidScenes]], [[word], []])
})

test('REMASTER RETRY: the same remaster after a FAILED child makes a NEW child job; a queued / complete one is still the same job; the source never changes', async () => {
  const db: any = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  const call = async (body: any) => { let status = 0, json: any = null; const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }; await handler({ method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: {}, body } as any, res); return { status, json } }
  const src = await call({ taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'yadam-retry-src-01', budgetUsd: 5, input: { kind: 'topic', text: TOPIC, targetSeconds: SECONDS } })
  const sourceId = src.json.job.id
  await runOnce({ store, blobs, executors: withLongform([], [createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner({}) as any })]), resolveSourceAsset: async () => { throw new Error('none') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 } as any)
  const before = await store.getJob(sourceId)
  const ask = () => call({ taskType: 'job_remaster', sourceJobId: sourceId, changes: { refreshColdOpen: true } })
  const a = await ask(); assert.equal(a.status, 201, JSON.stringify(a.json))
  const again = await ask(); assert.equal(again.json.job.id, a.json.job.id, 'queued: the same request is the same job')
  await db.query(`UPDATE production_jobs SET status = 'FAILED' WHERE id = $1`, [a.json.job.id])
  const b = await ask()
  assert.equal(b.status, 201); assert.notEqual(b.json.job.id, a.json.job.id, 'after a FAILED remaster the same request makes a NEW child')
  assert.equal((await store.getJob(a.json.job.id))!.status, 'FAILED', 'the failed child is kept as it is')
  assert.equal((await ask()).json.job.id, b.json.job.id, 'the new child is again the same job while it runs')
  await db.query(`UPDATE production_jobs SET status = 'COMPLETE' WHERE id = $1`, [b.json.job.id])
  assert.equal((await ask()).json.job.id, b.json.job.id, 'a COMPLETE remaster is still returned (policy unchanged)')
  const after = await store.getJob(sourceId)
  assert.deepEqual([after!.status, after!.stage, after!.planRef], [before!.status, before!.stage, before!.planRef], 'the source job never changes')
  // the child still reuses the source script (the unchanged-asset reuse contract)
  const brief: any = await blobs.getJson((await store.getJob(b.json.job.id))!.planRef!)
  assert.equal(brief.remaster.sourceJobId, sourceId)
})

test('JOB LIST: the server lists this workspace\'s jobs (a COMPLETE source + its FAILED remaster child), never another workspace\'s; job_get names a child\'s source', async () => {
  const db: any = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  const call = async (method: string, o: { body?: any; query?: any; key?: string } = {}) => { let status = 0, json: any = null; const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }; await handler({ method, headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': o.key ?? KEY }, query: o.query || {}, body: o.body } as any, res); return { status, json } }
  const src = await call('POST', { body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'yadam-list-src-01', budgetUsd: 5, input: { kind: 'topic', text: TOPIC, targetSeconds: SECONDS } } })
  const sourceId = src.json.job.id
  await runOnce({ store, blobs, executors: withLongform([], [createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner({}) as any })]), resolveSourceAsset: async () => { throw new Error('none') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 } as any)
  await db.query(`UPDATE production_jobs SET status = 'COMPLETE', stage = 'PACKAGE' WHERE id = $1`, [sourceId])
  const child = await call('POST', { body: { taskType: 'job_remaster', sourceJobId: sourceId, changes: { refreshColdOpen: true } } })
  await db.query(`UPDATE production_jobs SET status = 'FAILED' WHERE id = $1`, [child.json.job.id])
  await call('POST', { key: 'z'.repeat(32), body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'other-ws-job-01', budgetUsd: 5, input: { kind: 'topic', text: '다른 작업 공간의 이야기', targetSeconds: SECONDS } } })
  const list = await call('GET', { query: { taskType: 'job_list' } })
  assert.equal(list.status, 200, JSON.stringify(list.json))
  const byId = new Map(list.json.jobs.map((j: any) => [j.id, j]))
  assert.equal(list.json.jobs.length, 2, 'only this workspace')
  const s: any = byId.get(sourceId), c: any = byId.get(child.json.job.id)
  assert.deepEqual([s.status, s.profile, s.title, s.remasterOf], ['COMPLETE', 'yasa_longform', TOPIC, null])
  assert.deepEqual([c.status, c.remasterOf], ['FAILED', sourceId])
  assert.equal((await call('GET', { query: { taskType: 'job_get', id: child.json.job.id } })).json.job.remasterOf, sourceId)
  assert.equal((await call('GET', { query: { taskType: 'job_get', id: sourceId } })).json.job.remasterOf, null)
  assert.equal((await call('POST', { body: { taskType: 'job_list' } })).status, 405, 'GET only')
})

test('THUMBNAIL FIRST + STYLE LOCK: one thumbnail before approval, regenerate on the same job, approved picture = reference for every picture, representative mismatch blocks the rest, retries never pay twice', async () => {
  const { thumbnailCopyIssues, styleApprovalRef, STYLE_APPROVAL } = await import('../lib/generative/styleApproval.js')
  const db: any = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  ;(blobs as any).presign = async (ref: string) => ({ url: `memory://${ref}`, validUntil: 'x' })
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  const call = async (method: string, o: { body?: any; query?: any } = {}) => { let status = 0, json: any = null; const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }; await handler({ method, headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: o.query || {}, body: o.body } as any, res); return { status, json } }
  const d = await mkdtemp(join(tmpdir(), 'style-lock-'))
  const created = await call('POST', { body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'yadam-style-lock-01', budgetUsd: 5, input: { kind: 'topic', text: TOPIC, targetSeconds: SECONDS, thumbnailFirst: true } } })
  const jobId = created.json.job.id
  const calls = { image: 0, thumb: 0, ref: 0, tts: 0 }, judged: number[] = [], refSeen: Buffer[] = [], refPrompts: string[] = [], thumbPrompts: string[] = []
  let refMode: 'off' | 'same' = 'off'
  const off = await (async () => { const f = join(d, 'off.jpg'); await runOk(['-y', '-f', 'lavfi', '-i', 'color=c=0x0a3d0a:s=1536x1024', '-frames:v', '1', '-q:v', '3', f]); return { bytes: await readFile(f), contentType: 'image/jpeg', provider: 'standin', model: 'off-style' } })()
  const asset = createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk',
    // 야담: every picture goes through the ONE style contract drawer; the plain image / reference drawers must never be used
    image: async () => { calls.image++; throw new Error('a 야담 picture never bypasses the style contract') },
    imageRef: async () => { calls.image++; throw new Error('a 야담 picture never bypasses the style contract') },
    yadam: async (p: string, _k: string, o: any = {}) => {
      if (!o.approved) { calls.thumb++; thumbPrompts.push(p); const f = join(d, `th${calls.thumb}.jpg`); await runOk(['-y', '-f', 'lavfi', '-i', `testsrc2=s=1536x1024,hue=h=${calls.thumb * 40}`, '-frames:v', '1', '-q:v', '3', f]); return { bytes: await readFile(f), contentType: 'image/jpeg', provider: 'standin', model: 'yadam' } }
      calls.ref++; refSeen.push(o.approved); refPrompts.push(p); return refMode === 'same' ? { bytes: o.approved, contentType: 'image/jpeg', provider: 'standin', model: 'ref' } : off
    },
    tts: async () => { calls.tts++; return shortTts() },
    styleJudge: async () => { judged.push(1); return { same: true, score: 92, differences: [] } },
    copyWriter: async () => { throw new Error('the copy passes its checks: no rewrite call') } } as any)
  const tick = () => runOnce({ store, blobs, executors: withLongform([], [createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner({}) as any }), asset]), resolveSourceAsset: async () => { throw new Error('none') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 } as any)
  const job = async () => (await call('GET', { query: { taskType: 'job_get', id: jobId } })).json.job
  await tick(); await tick() // PLAN, then ASSET (thumbnail only)
  let j = await job()
  // 1: before approval only ONE picture (the thumbnail background); no scene picture, no reference picture, no narration
  assert.deepEqual([j.status, j.waitReason, j.stage], ['WAITING_USER', 'DECISION', 'ASSET'])
  assert.deepEqual(calls, { image: 0, thumb: 1, ref: 0, tts: 0 }, 'the first thumbnail is drawn by the 야담 style contract (no plain drawing)')
  assert.ok(!/Clean, bright|lively|not muddy|STYLE/.test(thumbPrompts[0]), 'the thumbnail background prompt carries no style / colour words: the contract decides the look')
  let st = (await call('GET', { query: { taskType: 'job_style', id: jobId } })).json.style
  assert.equal(st.awaiting, true); assert.equal(st.attempt, 1); assert.match(st.thumbnailUrl, /^memory:\/\/style-approval\/thumbnails\//)
  const thumb1: any = (await blobs.getJson(styleApprovalRef(jobId))).attempts[0]
  const info = await (async () => { const f = join(d, 't1.jpg'); await writeFile(f, await blobs.getBytes(thumb1.thumbnailRef)); return probe(f) })()
  assert.deepEqual([info.width, info.height], [1280, 720], '16:9 1280x720 with the copy composited')
  assert.equal((await tick() as any).ran, false, 'a waiting job is not run again')
  // 3: 다시 생성 -> the SAME job draws one new thumbnail and waits again
  assert.equal((await call('POST', { body: { taskType: 'job_style_decision', jobId, action: 'approve', attempt: 9 } })).status, 409, 'only the thumbnail the user saw')
  const rg = await call('POST', { body: { taskType: 'job_style_decision', jobId, action: 'regenerate', attempt: 1 } })
  assert.equal(rg.status, 200, JSON.stringify(rg.json)); assert.equal(rg.json.job.id, jobId)
  await tick()
  st = (await call('GET', { query: { taskType: 'job_style', id: jobId } })).json.style
  assert.deepEqual([st.awaiting, st.attempt, st.attempts], [true, 2, 2]); assert.deepEqual(calls, { image: 0, thumb: 2, ref: 0, tts: 0 })
  // 2 + 5: approved -> the representative picture first; it does NOT match -> nothing else is drawn, the stage stops (retryable)
  assert.equal((await call('POST', { body: { taskType: 'job_style_decision', jobId, action: 'approve', attempt: 2 } })).status, 200)
  await tick()
  j = await job()
  assert.deepEqual([j.status, j.waitReason, j.stage], ['WAITING_USER', 'DECISION', 'ASSET'], 'a mismatch waits for the user (no paid automatic retries)')
  assert.deepEqual(calls, { image: 0, thumb: 2, ref: 2, tts: 0 }, 'only the representative (twice), no other picture, no narration')
  assert.equal(judged.length, 0, 'a picture that fails the free colour / texture checks never costs a judge call')
  assert.equal((await tick() as any).ran, false)
  st = (await call('GET', { query: { taskType: 'job_style', id: jobId } })).json.style
  assert.equal(st.representative.status, 'mismatch'); assert.match(st.representative.url, /^memory:\/\/style-approval\/representative\//)
  const rec: any = await blobs.getJson(styleApprovalRef(jobId))
  assert.deepEqual([rec.status, rec.approved.n, rec.representative.status], ['approved', 2, 'mismatch'])
  // 4: every reference call carried the APPROVED picture itself + its measured features (not a style name)
  const approvedBg = await blobs.getBytes(rec.approved.backgroundRef)
  assert.ok(refSeen.every((b) => b.equals(approvedBg))); assert.ok(refPrompts.every((p) => !p.includes('STYLE LOCK') && !/palette|muted|saturated colors/.test(p)), '야담: no measured-colour text, the contract (with the approved picture) is the style')
  // retry: the representative matches -> the rest of the pictures are drawn from the reference, then the narration
  refMode = 'same'
  assert.equal((await call('POST', { body: { taskType: 'job_style_decision', jobId, action: 'representative' } })).status, 200, 'redraw only the representative')
  await tick()
  j = await job()
  assert.equal(j.stage, 'RENDER', JSON.stringify(j.runs?.slice(-3)))
  const runs = await store.listStageRuns(jobId), last: any = runs.filter((r: any) => r.stage === 'ASSET' && r.status === 'SUCCEEDED').at(-1)
  const manifest: any = await blobs.getJson(last.result.assetSpecRef)
  assert.equal(manifest.approvedThumbnail.ref, rec.approved.thumbnailRef, 'the approved thumbnail is the video thumbnail')
  assert.deepEqual([calls.image, calls.thumb], [0, 2], 'after approval every picture is drawn by the contract with the approved picture (never a plain drawing)')
  assert.equal(judged.length, 1, 'one judge call for the representative that passed the free checks')
  const pics = manifest.images.length, refCalls = calls.ref
  assert.ok(refCalls >= pics, `${refCalls} reference calls for ${pics} pictures`)
  // RENDER: the delivered thumbnail = the APPROVED background + the video's FINAL title, exactly
  const { composeTitleThumbnail } = await import('../lib/generative/titleThumbnail.js')
  const scriptNow: any = await blobs.getJson((runs.find((r: any) => r.stage === 'PLAN' && r.status === 'SUCCEEDED') as any).result.scriptRef)
  const { longformTitleThumbnail } = await import('../worker/stages/longform.js')
  const want = await composeTitleThumbnail({ background: approvedBg, title: scriptNow.title })
  const picture = async () => { throw new Error('the approved background is used, not a scene picture') }
  assert.ok((await longformTitleThumbnail({ jobId, blobs, assets: manifest, title: scriptNow.title, picture })).equals(want.bytes), 'approved background + exact title')
  // a manifest written before this change (no backgroundRef): the approval record names the background
  assert.ok((await longformTitleThumbnail({ jobId, blobs, assets: { approvedThumbnail: { ref: manifest.approvedThumbnail.ref } }, title: scriptNow.title, picture })).equals(want.bytes))
  assert.equal(want.lines.join(' '), scriptNow.title)
  st = (await call('GET', { query: { taskType: 'job_style', id: jobId } })).json.style
  assert.equal(st.copy.join(' '), scriptNow.title, 'the approval screen shows the same title')
  // 8 + 9: running ASSET again (a restart) keeps the approval and pays for nothing
  const before = { ...calls }
  const again: any = await asset.run({ job: { ...(await store.getJob(jobId)), stage: 'ASSET' }, blobs, previous: async (s: string) => (runs.filter((r: any) => r.stage === s && r.status === 'SUCCEEDED').at(-1) as any) ?? null, signal: new AbortController().signal } as any)
  assert.ok(again.result.assetSpecRef); assert.deepEqual(calls, before, 'no image / reference / narration call again'); assert.equal(judged.length, 1, 'no judge call again')
  assert.equal((await blobs.getJson(styleApprovalRef(jobId))).status, 'approved')
  // copy checks (no AI): a spoiler of the answer, broken Hangul; a job without thumbnailFirst is unchanged (no flag, no wait)
  const plan: any = runs.find((r: any) => r.stage === 'PLAN' && r.status === 'SUCCEEDED'), script: any = await blobs.getJson(plan.result.scriptRef)
  assert.deepEqual(thumbnailCopyIssues(script, 'yasa_longform'), [])
  assert.ok(thumbnailCopyIssues({ ...script, thumbnail: { lines: [{ text: '금가락지', color: 'red' }, { text: 'ㅋㅋ 비밀', color: 'white' }] } }, 'yasa_longform').some((x: string) => /spoiler|broken_hangul/.test(x)))
  const plainBrief = normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS }, 'yasa_longform')
  assert.equal((plainBrief as any).thumbnailFirst, undefined)
  assert.equal((normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS, thumbnailFirst: true }, 'yasa_longform') as any).thumbnailFirst, true)
  assert.equal(STYLE_APPROVAL.wisdom.enabled, false, 'Wisdom Shorts LOCK untouched')
})

test('COST: a failing cold open keeps exactly its normal chances (9 = 3 stage attempts x 3) and never more on a re-queue; provider errors are not counted; acts are never written twice; every paid call is counted per run and per job, the same brief while it runs is one job', async () => {
  const { meteredFetch } = await import('../lib/generative/usageLedger.js')
  const oldPrices = process.env.OPENAI_PRICES_JSON
  process.env.OPENAI_PRICES_JSON = JSON.stringify({ 'gpt-5.6': { in: 1.25, cached: 0.125, out: 10 } })
  try {
    const db: any = await createTestDb(), store = createJobStore(db, { retryBackoffMs: () => 0 }), blobs: any = createMemoryBlobStore()
    const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
    const call = async (method: string, o: { body?: any; query?: any } = {}) => { let status = 0, json: any = null; const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }; await handler({ method, headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: o.query || {}, body: o.body } as any, res); return { status, json } }
    const input = { kind: 'topic', text: TOPIC, targetSeconds: SECONDS }
    const a = await call('POST', { body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'cost-job-1', budgetUsd: 5, input } })
    // the same brief again (another tap / key) while the first is still queued: the same job, nothing new to pay for
    const b = await call('POST', { body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'cost-job-2', budgetUsd: 5, input } })
    assert.equal(a.status, 201, JSON.stringify(a.json)); assert.equal(b.json.job?.id, a.json.job.id, JSON.stringify(b.json)); assert.equal(b.json.created, false)
    // every planner call goes through the metered fetch (a stand-in OpenAI response with a usage block)
    const openai = meteredFetch(async () => new Response(JSON.stringify({ model: 'gpt-5.6', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 200 } } }), { headers: { 'content-type': 'application/json' } }), () => {})
    const paid = () => openai('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-5.6', text: { format: { name: 'x' } } }) })
    const calls: Record<string, any[]> = {}, base: any = fakePlanner(calls, { coldOpen: () => ({ sentences: COLD.map(([scene, s], i) => ({ scene, say: i === 5 ? '그 메주 속에는 금가락지와 땅문서가 들어 있었다.' : s, show: ['썩은 메주', '왜?'], accent: '썩은 메주', color: 'red' })) }) })
    const planner: any = Object.fromEntries(Object.entries(base).map(([k, fn]: any) => [k, async (...x: any[]) => { await paid(); return fn(...x) }]))
    const tick = () => runOnce({ store, blobs, executors: withLongform([], [createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner })]), resolveSourceAsset: async () => { throw new Error('none') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 } as any)
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) { const r: any = await tick(); if (!r.ran) break; outcomes.push(r.outcome) }
    assert.deepEqual(outcomes, ['retry', 'retry', 'failed'])
    assert.equal(calls.coldOpen.length, 9, 'the same chances as before the cap: completion rate unchanged')
    assert.deepEqual([calls.dna.length, calls.outline.length, calls.section.length], [1, 1, 8], 'DNA, outline and every act written once; retries reuse them')
    const j = (await call('GET', { query: { taskType: 'job_get', id: a.json.job.id } })).json.job
    assert.equal(j.status, 'FAILED'); assert.match(j.error, /COLD_OPEN|cold-open/)
    assert.equal(j.cost.paidCalls, 19); assert.deepEqual(j.cost.byStage.PLAN, { paidCalls: 19, estUsd: 0.1102, attempts: 3 })
    assert.deepEqual(j.cost.byModel['gpt-5.6'], { calls: 19, estUsd: 0.1102, outputTokens: 9500, reasoningTokens: 3800 }); assert.equal(j.cost.estUsd, 0.1102)
    assert.deepEqual(j.runs.filter((r: any) => r.status === 'FAILED').map((r: any) => r.paidCalls), [10 + 3, 3, 3], JSON.stringify(j.runs))
    // a 4th run of the same PLAN (an operator re-queue / a lease loss): the step has used its chances -> stops, pays nothing
    const exec = createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner }), jobRow = await store.getJob(a.json.job.id)
    await assert.rejects(() => exec.run({ job: jobRow, blobs, previous: async () => null, signal: new AbortController().signal } as any), (e: any) => /retry limit reached/.test(e.message) && e.retryable === false)
    assert.equal(calls.coldOpen.length, 9, 'no paid call past the normal chances')
    // provider errors (nothing answered) never use up a chance: 9 errors then a good cold open still completes
    const blobs2: any = createMemoryBlobStore(), store2 = createJobStore(await createTestDb(), { retryBackoffMs: () => 0 })
    const brief2 = normalizeLongformBrief(input, 'yasa_longform'), ref2 = (await putAddressed(blobs2, 'generative-briefs', brief2)).path
    let errorsLeft = 9; const calls2: Record<string, any[]> = {}, p2: any = fakePlanner(calls2), okCold = p2.coldOpen
    p2.coldOpen = async (x: any) => { if (errorsLeft-- > 0) throw new Error('OpenAI 503'); return okCold(x) }
    const ctx2 = { job: { id: 'job-errors', profile: 'yasa_longform', planRev: 1, planRef: ref2 }, blobs: blobs2, previous: async () => null, signal: new AbortController().signal } as any
    const e2 = createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: p2 })
    for (let k = 0; k < 3; k++) await assert.rejects(() => e2.run(ctx2), (e: any) => e.retryable === true)
    assert.ok((await e2.run(ctx2) as any).result.scriptRef, 'completes after transient errors'); void store2
    // a finished (failed) job no longer blocks the same brief: a new request makes a new job
    const c = await call('POST', { body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'cost-job-3', budgetUsd: 5, input } })
    assert.notEqual(c.json.job.id, a.json.job.id); assert.equal(c.json.created, true)
  } finally { if (oldPrices === undefined) delete process.env.OPENAI_PRICES_JSON; else process.env.OPENAI_PRICES_JSON = oldPrices }
})

test('Golden Style (issue #179): a 야담 longform job with Golden 2 draws every scene with Gemini + the ONE locked reference (not the 야담 contract), content-only scenes, 16:9; AUTO stays the 야담 contract', async () => {
  const { goldenPrompt, GOLDEN_REFERENCE_DIR } = await import('../lib/generative/goldenStyle.js')
  const { YADAM_STYLE_CONTRACT } = await import('../lib/generative/yadamStyle.js')
  const { readFile: rf } = await import('node:fs/promises')
  const d = await mkdtemp(join(tmpdir(), 'yadam-golden-'))
  const blobs: any = createMemoryBlobStore()
  const brief = normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: SECONDS, visualStyleProfile: 'golden-2' }, 'yasa_longform')
  assert.equal(brief.creative!.resolved.golden!.id, 'golden-2')
  const stored = await putAddressed(blobs, 'generative-briefs', brief)
  const job = { id: 'yg1', profile: 'yasa_longform', planRev: 1, planRef: stored.path }
  const runs: any = {}
  const ctx = () => ({ job, blobs, previous: async (st: string) => runs[st] ?? null, signal: new AbortController().signal } as any)
  runs.PLAN = await createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner({}) as any }).run(ctx())
  const pic = await scenePicture(d, 1), sent: any[] = []
  const imageFetch: any = async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', data: pic.bytes.toString('base64'), mime_type: 'image/jpeg' }] }] }), { status: 200 }) }
  const out: any = await createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk', imageFetch, image: async () => { throw new Error('no default drawer') }, yadam: async () => { throw new Error('a Golden 야담 job does not use the 야담 contract') }, tts: async () => shortTts() } as any).run(ctx())
  const m: any = await blobs.getJson(out.result.assetSpecRef)
  assert.ok(sent.length > 0 && sent.length === new Set(m.images.map((x: any) => x.prompt ?? x.sha256)).size, 'one Golden call per distinct scene picture (a repeated scene is drawn once)')
  const ref2 = (await rf(join(GOLDEN_REFERENCE_DIR, 'ref-2.jpg'))).toString('base64')
  for (const x of sent) {
    assert.deepEqual([x.body.model, x.body.response_format[0].aspect_ratio, x.body.input.length, x.body.input[1].data], ['gemini-3.1-flash-image', '16:9', 2, ref2])
    const t = x.body.input[0].text; assert.equal(t, goldenPrompt(t.split('장면: ')[1].split('\n\n')[0], '16:9')); assert.ok(!t.includes(YADAM_STYLE_CONTRACT))
  }
})
