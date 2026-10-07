// 숨은야사 Longform as a server job, end to end with stand-ins (no paid call): job_create (25 min) -> PLAN (STORY DNA ->
// outline -> 6 acts -> upload text, every step checked against the DNA) -> ASSET (one picture per story scene through the
// shared IMAGE module, Tracker narration per sentence) -> RENDER (16:9 scenes + bottom subtitles + thumbnail + output QC)
// -> PACKAGE (MP4, thumbnail, title, description, tags, hashtags, pinned comment) -> COMPLETE. No user step in between.
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
import { LONGFORM, normalizeLongformBrief, sentencesOf, validateLongformScript } from '../lib/generative/longform.js'
import { YASA_ACTS, yasaActChars, yasaRevealAt, yasaScriptErrors } from '../lib/generative/yasaLongform.js'
import { characterLine } from '../lib/generative/seniorLongform.js'
import { VISUAL_STYLE_PROFILES } from '../lib/generative/visualStyle.js'
import { PROFILES } from '../lib/jobs/profiles.js'

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
  propArc: ['짐', '수상한 물건', '위험을 막는 도구', '마지막 비밀의 열쇠']
}
const CAST = [
  { id: 'bride', name: '윤씨', role: '며느리', gender: 'female', age: '28', face: 'gentle oval face, tired eyes', hair: 'neat Joseon chignon with a wooden binyeo', build: 'slender', outfit: 'faded indigo hanbok', colors: 'indigo, cream' },
  { id: 'mil', name: '최씨 부인', role: '시어머니', gender: 'female', age: '60', face: 'stern lined face', hair: 'grey chignon', build: 'small', outfit: 'grey hanbok with a dark jeogori', colors: 'grey, charcoal' }
]
// a sentence of ~300 characters (all acts long enough; the reveal act names the prop)
const say = (act: number, k: number) => {
  const core = act === 0 && k === 0 ? DNA.openingLine : act === 4 && k === 0 ? '마침내 썩은 메주가 갈라지자 그 속에서 금가락지와 땅문서가 나왔다.' : `${act + 1}막 ${k + 1}번째 장면에서 며느리는 썩은 메주를 지고 걷는다.`
  return (core + ' 바람이 차가웠고 사람들의 눈길은 더 차가웠다. 며느리는 이를 악물고 한 걸음씩 걸었다.'.repeat(6)).slice(0, 300)
}
const counts = yasaActChars(Math.round(1500 * LONGFORM.charsPerSecond)).map((c) => Math.ceil(c / 300))
const actScenes = (a: number): any[] => {
  const sc = [0, 1].map((j) => ({ id: `a${a + 1}s${j + 1}`, place: `장소 ${a + 1}-${j + 1}`, time: j ? '저녁' : '아침', characters: j ? ['bride', 'mil'] : ['bride'], action: `행동 ${a + 1}-${j + 1}`, mood: 'tense', visual: `visual ${a + 1}-${j + 1}${j === 0 ? ' 썩은 메주' : ''}` }))
  // the last act returns to the first act's opening picture (same place/time/people/action/visual): one picture, made once
  return a === 5 ? [{ ...actScenes(0)[0], id: 'a6s1' }, sc[1]] : sc
}
function fakePlanner(calls: Record<string, any[]>) {
  const log = (k: string, v: any) => { (calls[k] ||= []).push(v) }
  return {
    dna: async (brief: any) => { log('dna', brief.targetSeconds); return DNA },
    outline: async (brief: any, n: number) => { log('outline', { dna: brief.yasaStoryDNA, n, targetSeconds: brief.targetSeconds }); return { title: DNA.title, hook: DNA.openingLine, figure: { name: '윤씨', imagePrompt: 'a young Joseon bride' }, thumbnail: { lines: [{ text: '썩은 메주', color: 'red' }, { text: '그 속의 비밀', color: 'white' }] }, characters: CAST, sections: Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, heading: `${i + 1}막`, points: ['a', 'b'], scenes: actScenes(i) })) } },
    section: async (i: any) => {
      log('section', { index: i.index, targetChars: i.targetChars, dna: !!i.brief.yasaStoryDNA })
      const sc = i.outline.sections[i.index].scenes, n = counts[i.index]
      return { sentences: Array.from({ length: n }, (_, k) => ({ scene: sc[Math.min(sc.length - 1, Math.floor((k * sc.length) / n))].id, say: say(i.index, k), show: ['썩은 메주를', '지고 간 며느리'], accent: '썩은 메주', color: 'red' })) }
    },
    metadata: async () => { log('metadata', 1); return { title: DNA.title, description: '시집온 뒤 5년 동안 친정에 가지 못한 며느리가 있었습니다. 시어머니는 선물 대신 썩은 메주 한 덩이만 지워 보냈습니다. 길 위에서 쫓겨나고 도둑으로 몰리면서도 며느리는 그 짐을 내려놓지 않았습니다. 마지막에 밝혀지는 시어머니의 진짜 마음과 메주 속에 숨겨진 물건이 무엇이었는지, 그리고 그 물건이 친정 식구들을 어떻게 지켜 냈는지 끝까지 확인해 보세요. 조선 후기 한 양반가에서 전해 내려오는 이야기를 바탕으로 다시 구성했습니다.', tags: ['조선 야담', '며느리 이야기', '시어머니 사연', '메주 이야기', '숨은 야사', '고부 갈등', '조선 후기'], hashtags: ['#숨은야사', '#야담', '#조선이야기'], pinnedComment: '여러분이라면 썩은 메주를 받은 며느리처럼 끝까지 지고 갔을까요?' } }
  }
}
// narration stand-in: a short pause + a tone whose length varies by sentence (like real speech), mp3 like the OpenAI voice
let ttsN = 0
const shortTts = async () => { const n = ttsN++, r = await runOk(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.25', '-f', 'lavfi', '-i', `sine=f=${200 + (n % 7) * 40}:d=${(0.6 + (n % 5) * 0.15).toFixed(2)}`, '-filter_complex', '[0][1]concat=n=2:v=0:a=1,volume=0.5', '-c:a', 'libmp3lame', '-f', 'mp3', '-']); return { bytes: r.stdout, contentType: 'audio/mpeg', provider: 'standin', model: 'tone' } }
async function scenePicture(d: string, n: number) {
  const f = join(d, `p${n}.jpg`)
  await runOk(['-y', '-f', 'lavfi', '-i', `color=c=0x${((n * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}:s=1536x1024`, '-frames:v', '1', '-q:v', '3', f])
  return { bytes: await readFile(f), contentType: 'image/jpeg', provider: 'standin', model: 'scene' }
}

test('YASA job profile: the shared Longform engine, scenes mode, its own creative content (시대극 style)', () => {
  assert.deepEqual(PROFILES.yasa_longform.stages, ['PLAN', 'ASSET', 'RENDER', 'PACKAGE'])
  assert.deepEqual(PROFILES.yasa_longform.features, ['PLAN', 'IMAGE', 'TTS', 'CAPTION', 'LONGFORM_RENDER', 'THUMBNAIL', 'QC', 'PACKAGE'])
  const b = normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: 1500 }, 'yasa_longform')
  assert.equal(b.targetSeconds, 1500); assert.equal(b.creative!.resolved.visualStyleProfile, 'historical-dramatic')
  assert.throws(() => normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: 1500, yasaStoryDNA: { title: 'x' } }, 'yasa_longform'), /yasaStoryDNA is invalid/)
  assert.deepEqual(normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: 1500, yasaStoryDNA: DNA }, 'yasa_longform').yasaStoryDNA, DNA)
  // the acts ARE the DNA structure; the reveal act starts at 80% of the planned narration
  assert.deepEqual(YASA_ACTS.map((a) => a.key), ['hook', 'relation', 'pressure', 'proof_crisis', 'reveal', 'payoff'])
  assert.ok(Math.abs(YASA_ACTS.slice(0, 4).reduce((s, a) => s + a.share, 0) - 0.8) < 1e-9)
  const beats = YASA_ACTS.flatMap((a) => a.beats as readonly string[])
  for (const k of ['mystery.strangeAction', 'mystery.concreteProp', 'mystery.apparentMeaning', 'mystery.trueMeaning', 'mystery.mainQuestion', 'pressure.worseningEvents', 'reveal.partialProof', 'reveal.majorCrisis', 'reveal.majorReveal', 'reveal.emotionalReframe', 'payoff']) assert.ok(beats.includes(k), k)
})

test('YASA 25-minute job: job_create -> PLAN -> ASSET -> RENDER -> PACKAGE -> COMPLETE with zero user steps', async () => {
  const d = await mkdtemp(join(tmpdir(), 'yasa-job-'))
  const db = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  ;(blobs as any).presign = async (ref: string) => ({ url: `memory://${ref}`, validUntil: 'x' })
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  const call = async (method: string, opts: { body?: any; query?: any } = {}) => {
    let status = 0, json: any = null
    const req: any = { method, headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: opts.query || {}, body: opts.body }
    const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }
    await handler(req, res); return { status, json }
  }
  const created = await call('POST', { body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'yasa-lf-25-0001', budgetUsd: 5, input: { kind: 'topic', text: TOPIC, targetSeconds: 25 * 60, language: 'ko', aspectRatio: '16:9' } } })
  assert.equal(created.status, 201, JSON.stringify(created.json)); const jobId = created.json.job.id

  const calls: Record<string, any[]> = {}, prompts: string[] = [], voices: string[] = []
  const executors = withLongform([], [
    createLongformPlanExecutor({ apiKey: 'k', research: async () => { throw new Error('a yasa story is not researched') }, log: () => {}, planner: fakePlanner(calls) as any }),
    createLongformAssetExecutor({ apiKey: 'k', image: async (p: string) => { prompts.push(p); return scenePicture(d, prompts.length) }, tts: async (_t: string, _k: string, v: any) => { voices.push(v.id); return shortTts() } } as any),
    longformRenderExecutor, longformPackageExecutor
  ])
  let record: any = null
  for (let i = 0; i < 8; i++) { const r: any = await runOnce({ store, blobs, executors, resolveSourceAsset: async () => { throw new Error('no source asset') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 }); if (!r.ran) break; record = r.job; assert.ok(r.ran && r.outcome === "completed", JSON.stringify(r)) }
  const job = (await call('GET', { query: { taskType: 'job_get', id: jobId } })).json.job
  assert.equal(job.status, 'COMPLETE', JSON.stringify(job.runs)); assert.equal(job.final.publishable, true)
  const runs = await store.listStageRuns(jobId), ok = (st: string) => runs.find((r: any) => r.stage === st && r.status === 'SUCCEEDED') as any
  assert.deepEqual(['PLAN', 'ASSET', 'RENDER', 'PACKAGE'].map((st) => !!ok(st)), [true, true, true, true])

  // 25 minutes all the way: brief -> DNA -> outline -> each act's target (no 15/22/30 rounding)
  assert.equal(ok('PLAN').result.targetSeconds, 1500)
  assert.deepEqual(calls.dna, [1500]); assert.equal(calls.outline[0].targetSeconds, 1500); assert.deepEqual(calls.outline[0].dna, DNA)
  assert.deepEqual(calls.section.map((x: any) => x.targetChars), yasaActChars(9300)); assert.ok(calls.section.every((x: any) => x.dna))
  // the DNA is in the final script and checked against it (deterministic): opening, prop, reveal at ~80%
  const script: any = await blobs.getJson(ok('PLAN').result.scriptRef)
  assert.equal(script.schema, 'yasa-longform-script/1'); assert.deepEqual(script.yasaStoryDNA, DNA)
  assert.deepEqual(script.sections.map((s: any) => s.act), YASA_ACTS.map((a) => a.key))
  assert.deepEqual(yasaScriptErrors(script), [])
  const at = yasaRevealAt(script.sections); assert.ok(at >= 0.75 && at <= 0.85, `reveal at ${at}`); assert.equal(ok('PLAN').result.yasa.revealAt, Number(at.toFixed(3)))
  assert.equal(ok('PLAN').result.yasa.dna, 'plan')

  // pictures: one per story scene through the shared IMAGE module, the 시대극 style, the setting, the Character Bible,
  // the prop's one look; the repeated scene is made once
  const scenes = script.sections.flatMap((s: any) => s.scenes)
  assert.equal(scenes.length, 12); assert.equal(prompts.length, 11, 'the repeated opening picture is generated once')
  const hd = VISUAL_STYLE_PROFILES['historical-dramatic']
  assert.ok(prompts.every((p) => p.includes(hd.promptPrefix) && p.includes('Setting: 조선, 후기 (18세기)') && p.includes(characterLine(CAST[0] as any)) && /another country or era/.test(p)))
  assert.ok(prompts.filter((p) => p.includes('"썩은 메주" looks exactly the same')).length === 5) // the 6 scenes that show the prop, one of them the reused opening picture
  // narration: one Tracker TTS call per sentence, one resolved voice
  const sentences = sentencesOf(script).length
  assert.equal(voices.length, sentences); assert.equal(new Set(voices).size, 1)
  assert.equal(sentences, counts.reduce((a, b) => a + b, 0))

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
  assert.equal(ok('RENDER').result.scenePictures, 12)
  // an ASSET retry pays for nothing (every picture and sentence is cached)
  prompts.length = 0; voices.length = 0
  await createLongformAssetExecutor({ apiKey: 'k', image: async (p: string) => { prompts.push(p); return scenePicture(d, 99) }, tts: async (_t: string, _k: string, v: any) => { voices.push(v.id); return shortTts() } } as any).run({ job: record, blobs, previous: async (st: string) => ok(st), signal: new AbortController().signal } as any)
  assert.deepEqual([prompts.length, voices.length], [0, 0])
})

test('YASA checks: a script that loses the DNA is refused (opening, prop in the reveal, reveal position); the PLAN retry reuses the stored DNA', async () => {
  const blobs: any = createMemoryBlobStore()
  const brief = normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: 1500 }, 'yasa_longform')
  const stored = await putAddressed(blobs, 'generative-briefs', brief)
  const job = { id: 'y1', profile: 'yasa_longform', planRev: 1, planRef: stored.path }
  const ctx = () => ({ job, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  // act 1 that starts with background (banned) is repaired once, then the step fails (retryable; checkpoints kept)
  const calls: Record<string, any[]> = {}
  const bad = fakePlanner(calls), badSection = bad.section
  ;(bad as any).section = async (i: any) => { const r = await badSection(i); if (i.index === 0) r.sentences[0].say = '옛날 조선시대에는 며느리가 많았다. ' + r.sentences[0].say; return r }
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: bad as any }).run(ctx()), (e: any) => e.code === 'SECTION_INVALID' && /yasa\.opening/.test(e.message) && e.retryable === true)
  assert.equal(calls.section.length, 2, 'one repair with the exact errors'); assert.equal(calls.dna.length, 1)
  // the retry reuses the stored DNA + outline (no second DNA call)
  const again: Record<string, any[]> = {}
  await createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner(again) as any }).run(ctx())
  assert.equal(again.dna, undefined); assert.equal(again.outline, undefined); assert.equal(again.section.length, 6)
  // the whole-script check
  const script: any = await blobs.getJson(((await createLongformPlanExecutor({ apiKey: 'k', log: () => {}, planner: fakePlanner({}) as any }).run(ctx())).result as any).scriptRef)
  assert.deepEqual(validateLongformScript(script, brief), [])
  const noProp = structuredClone(script); noProp.sections[4].sentences.forEach((x: any) => { x.say = x.say.replace(/메주/g, '보따리') })
  assert.match(yasaScriptErrors(noProp).join(';'), /reveal: concreteProp/)
  const early = structuredClone(script); early.sections[4].sentences.push(...early.sections[4].sentences, ...early.sections[4].sentences, ...early.sections[4].sentences, ...early.sections[4].sentences)
  assert.match(yasaScriptErrors(early).join(';'), /reveal_at/)
  const noDna = structuredClone(script); delete noDna.yasaStoryDNA
  assert.match(validateLongformScript(noDna, brief).join(';'), /yasa\.dna/)
})

test('YASA planner requests (stubbed fetch, no paid call): DNA schema + rules, then outline/acts carry the DNA and the act job', async () => {
  const { openAiYasaPlanner } = await import('../lib/generative/yasaPlanner.js')
  const sent: any[] = []
  const f: any = async (_u: string, init: any) => { const b = JSON.parse(init.body); sent.push(b); return new Response(JSON.stringify({ output_text: JSON.stringify(b.text.format.name === 'yasa_story_dna' ? DNA : {}) }), { status: 200 }) }
  const p = openAiYasaPlanner(f)
  const brief: any = { ...normalizeLongformBrief({ kind: 'topic', text: TOPIC, targetSeconds: 1500 }, 'yasa_longform') }
  assert.deepEqual(await p.dna(brief, 'k'), DNA)
  assert.equal(sent[0].text.format.name, 'yasa_story_dna'); assert.equal(sent[0].text.format.strict, true)
  assert.match(sent[0].instructions, /숨은야사/); assert.match(sent[0].instructions, /목표 길이 약 1500초/); assert.match(sent[0].input, /썩은 메주/)
  await p.outline({ ...brief, yasaStoryDNA: DNA }, 6, 'k')
  assert.equal(sent[1].text.format.name, 'yasa_longform_outline'); assert.match(sent[1].instructions, /about 25 minutes/)
  assert.ok(sent[1].instructions.includes(JSON.stringify(DNA, null, 2)), 'the outline is written from the DNA as is')
  const outline: any = { title: DNA.title, hook: DNA.openingLine, sections: YASA_ACTS.map((a, i) => ({ id: `a${i + 1}`, heading: a.key, points: ['x', 'y'], scenes: [{ id: `a${i + 1}s1`, place: 'p', time: 't', action: 'a', mood: 'm', visual: 'v', characters: [] }] })), characters: [] }
  await p.section({ brief: { ...brief, yasaStoryDNA: DNA }, outline, index: 0, previousTail: [], targetChars: 1116 }, 'k')
  await p.section({ brief: { ...brief, yasaStoryDNA: DNA }, outline, index: 4, previousTail: ['…'], targetChars: 1116 }, 'k')
  assert.ok(sent[2].instructions.includes(`The FIRST sentence is the openingLine: "${DNA.openingLine}"`)); assert.match(sent[2].instructions, /about 1116 Korean characters/)
  assert.ok(sent[3].instructions.includes(YASA_ACTS[4].role) && /MAJOR REVEAL/.test(sent[3].instructions))
  assert.ok([sent[2], sent[3]].every((b) => b.instructions.includes(JSON.stringify(DNA, null, 2))))
})
