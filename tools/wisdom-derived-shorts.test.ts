// Wisdom Longform -> derived Shorts, end to end with stand-ins (no paid call). A Wisdom Longform job's PLAN writes its
// script, then ONE deriver call over the finished script + its own research proposes ideas; Tracker keeps only strong,
// grounded, non-overlapping ones (3 of 7 here). The Longform itself goes on (ASSET next). The user keeps 2 -> two
// ordinary Wisdom Shorts jobs (job_create with derivedFrom; the brief is built on the server from the parent's material)
// run the unchanged Wisdom Shorts pipeline: PLAN -> ASSET (new 9:16 pictures) -> ANALYZE -> COMPILE -> RENDER (Screen
// DNA) -> AUTO_QC -> DECISION (taken automatically: the one confirmation was the candidate choice) -> FINAL -> PACKAGE
// (upload text pointing to the parent Longform) -> COMPLETE. Research and derive are never called again.
// Run: node --import tsx --test tools/wisdom-derived-shorts.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { runOnce } from '../worker/runJob.js'
import { runOk, probe } from '../lib/media/ffmpeg.js'
import { createModuleRegistry, stageExecutorsFor } from '../worker/modules/registry.js'
import { createLongformPlanExecutor, createLongformAssetExecutor, longformRenderExecutor, longformPackageExecutor } from '../worker/stages/longform.js'
import { createGenerativePlanExecutor, createGenerativeAssetExecutor } from '../worker/stages/generative.js'
import { analyzeExecutor } from '../worker/stages/analyze.js'
import { compileExecutor } from '../worker/stages/compile.js'
import { renderExecutor } from '../worker/stages/render.js'
import { createAutoQcExecutor } from '../worker/stages/autoQc.js'
import { decisionExecutor, finalExecutor, packageExecutor } from '../worker/stages/finish.js'
import { withWisdomThumbnail } from '../worker/stages/wisdomThumbnail.js'
import { selectDerivedShorts, DERIVED } from '../lib/generative/derivedShorts.js'
import { uploadMetadataErrors } from '../lib/generative/uploadPackage.js'

const KEY = 'w'.repeat(32)
const TITLE = '나이 들수록 인간관계를 줄여야 하는 이유'
const SENTS = [
  ['사람이 많을수록 오히려 더 외로워지는 순간이 있습니다.', '모임이 늘어날수록 진짜 내 이야기를 할 사람은 줄어듭니다.', '쇼펜하우어는 혼자 있을 수 있는 사람만이 자유롭다고 말했습니다.', '그는 외로움을 견디지 못하면 평생 남에게 끌려간다고 보았습니다.'],
  ['좋은 사람에게도 거리를 둬야 하는 순간이 있습니다.', '착한 사람일수록 거절하지 못해 자기 시간을 잃습니다.', '선을 긋는 것은 관계를 끊는 것이 아니라 지키는 일입니다.', '거리를 둔 뒤에야 오래 가는 관계가 남습니다.'],
  ['나이가 들면 관계의 수보다 깊이가 중요해집니다.', '열 명의 지인보다 한 명의 친구가 더 큰 힘이 됩니다.', '그래서 줄이는 것은 잃는 것이 아니라 고르는 일입니다.', '오늘 내 시간을 누구에게 주고 있는지 돌아보세요.']
]
const SAMPLE: any = { schema: 'wisdom-longform-script/1', title: TITLE, hook: SENTS[0][0], figure: { name: '쇼펜하우어', imagePrompt: 'Arthur Schopenhauer' }, thumbnail: { lines: [{ text: '관계 정리', color: 'red' }, { text: '외로움의 비밀', color: 'white' }] } }
const card = (say: string) => ({ say, show: ['관계를', '줄이는 이유'], accent: '관계', color: 'red' })
const META = { title: TITLE, description: '나이가 들수록 관계를 넓히기보다 깊게 가꾸는 것이 왜 중요한지 이야기합니다. 쇼펜하우어가 혼자를 두려워하지 않은 이유와 좋은 사람에게도 거리를 둬야 하는 순간을 함께 살펴봅니다. 관계의 수보다 깊이를 고르는 법을 정리했습니다. 오래 남는 관계와 나를 지키는 혼자의 시간을 어떻게 나눌지, 오늘 바로 돌아볼 수 있는 질문도 함께 남겨 두었습니다.', tags: ['인간관계 정리', '쇼펜하우어', '혼자의 시간', '거리 두기', '노년의 관계', '진짜 친구'], hashtags: ['#인간관계', '#쇼펜하우어', '#관계정리'], pinnedComment: '여러분은 요즘 누구에게 가장 많은 시간을 쓰고 계신가요?' }
const planner = (calls: Record<string, number>) => ({
  outline: async (_b: any, n: number) => { calls.outline = (calls.outline || 0) + 1; return { title: TITLE, hook: SENTS[0][0], figure: SAMPLE.figure, thumbnail: SAMPLE.thumbnail, sections: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, heading: `h${i + 1}`, points: ['a', 'b'] })) } },
  section: async (i: any) => { calls.section = (calls.section || 0) + 1; return { sentences: SENTS[i.index % 3].map(card) } },
  metadata: async () => { calls.metadata = (calls.metadata || 0) + 1; return META }
})
const research = (calls: Record<string, number>) => async (_i: any) => { calls.research = (calls.research || 0) + 1; return { bundle: { topic: TITLE, model: 'stand-in', researchedAt: 'now', fragments: ['쇼펜하우어: 고독을 견디는 힘이 자유다', '선을 긋는 것은 관계를 지키는 일', '관계의 수보다 깊이'].map((claim, k) => ({ id: `f${k + 1}`, type: 'interpretation', claim, story: '', sourceTitle: 's', sourceUrl: 'https://example.org', confidence: 'high', usableAsDirectBuddhaQuote: false })), sectionMap: [1, 2, 3].map((section) => ({ section, fragmentIds: [`f${section}`], purpose: 'p' })) }, requests: 1, webSearchCalls: 1 } }
const strong = { hook: 5, standalone: 5, clarity: 5, payoff: 4, distinct: 5 }
// 7 ideas: 3 strong and different, 2 weak, 1 near-duplicate of #1, 1 citing a sentence the script does not have
const IDEAS = { ideas: [
  { shortTitle: '쇼펜하우어가 혼자를 두려워하지 않은 이유', hook: '외로움을 견디지 못하면 평생 남에게 끌려갑니다.', corePoint: '혼자 있을 수 있어야 자유롭다', payoff: '혼자의 시간은 나를 지키는 힘이다', sourceClaim: '쇼펜하우어: 혼자 있을 수 있는 사람만이 자유롭다', thinker: '쇼펜하우어', sourceRefs: [{ section: 0, sentence: 2 }, { section: 0, sentence: 3 }], scores: strong },
  { shortTitle: '좋은 사람에게도 거리를 둬야 하는 순간', hook: '착한 사람일수록 이 선을 늦게 배웁니다.', corePoint: '선을 긋는 것은 관계를 지키는 일', payoff: '거리를 둬야 오래 가는 관계가 남는다', sourceClaim: '선을 긋는 것은 관계를 끊는 것이 아니라 지키는 일', thinker: '', sourceRefs: [{ section: 1, sentence: 1 }, { section: 1, sentence: 2 }], scores: { ...strong, payoff: 5 } },
  { shortTitle: '나이 들수록 인간관계를 줄여야 하는 이유', hook: '사람이 많을수록 외로운 이유가 있습니다.', corePoint: '관계의 수보다 깊이', payoff: '줄이는 것은 잃는 것이 아니라 고르는 일', sourceClaim: '열 명의 지인보다 한 명의 친구', thinker: '', sourceRefs: [{ section: 2, sentence: 1 }, { section: 2, sentence: 2 }], scores: { ...strong, hook: 4 } },
  { shortTitle: '모임이 많은 사람의 특징', hook: '모임이 많다고 행복할까요?', corePoint: '모임 이야기', payoff: '글쎄요', sourceClaim: '모임이 늘어날수록', thinker: '', sourceRefs: [{ section: 0, sentence: 1 }], scores: { hook: 3, standalone: 2, clarity: 3, payoff: 2, distinct: 4 } },
  { shortTitle: '관계에 대한 배경 설명', hook: '먼저 배경부터 보겠습니다.', corePoint: '배경', payoff: '없음', sourceClaim: '나이가 들면', thinker: '', sourceRefs: [{ section: 2, sentence: 0 }], scores: { hook: 2, standalone: 2, clarity: 4, payoff: 1, distinct: 4 } },
  { shortTitle: '쇼펜하우어가 혼자를 두려워하지 않았던 이유', hook: '혼자일 수 있어야 자유롭습니다.', corePoint: '혼자 있을 수 있어야 자유롭다', payoff: '혼자의 시간이 힘이다', sourceClaim: '쇼펜하우어', thinker: '쇼펜하우어', sourceRefs: [{ section: 0, sentence: 2 }], scores: { hook: 4, standalone: 4, clarity: 4, payoff: 4, distinct: 4 } },
  { shortTitle: '없는 문장에서 나온 쇼츠', hook: '이런 말은 없었습니다.', corePoint: 'x', payoff: 'y', sourceClaim: 'z', thinker: '', sourceRefs: [{ section: 9, sentence: 9 }], scores: strong }
] }
const mp3 = async (sec: number, f = 330) => (await runOk(['-f', 'lavfi', '-i', `sine=f=${f}:d=${sec}`, '-af', 'volume=0.4', '-c:a', 'libmp3lame', '-f', 'mp3', '-'])).stdout
const portrait = async (n: number) => (await runOk(['-f', 'lavfi', '-i', `testsrc2=s=1024x1536:d=1`, '-vf', `hue=h=${(n * 47) % 360}`, '-frames:v', '1', '-f', 'mjpeg', '-'])).stdout
// a Wisdom Shorts script made from the child brief (the planner stand-in reads the parent's material it was given)
function wisdomPlan(seen: any[]) {
  return async (brief: any) => {
    seen.push(brief)
    // (the brief text is one line: job_create normalises whitespace)
    const field = (label: string, next: string) => String(brief.text).split(label)[1]?.split(next)[0]?.trim()
    const hook = field('첫 문장(훅): ', ' 핵심 메시지:') ?? '시작합니다'
    const thinker = /인물: (\S+)/.exec(brief.text)?.[1]
    const title = field('쇼츠 제목: ', ' 첫 문장') ?? 't'
    const lines = [hook, '많은 사람이 관계를 넓혀야 행복해진다고 믿습니다.', '하지만 관계가 많을수록 진짜 내 이야기는 줄어듭니다.', thinker ? `${thinker}는 혼자 있을 수 있는 사람만이 자유롭다고 보았습니다.` : '선을 긋는 것은 관계를 끊는 것이 아니라 지키는 일입니다.', '그래서 줄이는 것은 잃는 것이 아니라 고르는 일입니다.', '오늘 내 시간을 누구에게 주고 있는지 돌아보세요.']
    return { script: { schema: 'wisdom-script/1', title, hook, ending: lines.at(-1), totalSeconds: 30, beats: lines.map((narration, i) => ({ id: `b${i + 1}`, narration, visualGoal: 'g', imagePrompt: `scene ${i + 1} of "${title}": an older Korean person in a quiet room`, durationSec: 5 })) }, visualBible: { schema: 'wisdom-visual-bible/1', style: 'painterly', palette: 'warm', lighting: 'soft', composition: 'center', characterPolicy: 'consistent', negative: 'text' } }
  }
}
const KIT = (input: any) => ({ lines: [{ text: '관계 정리', color: 'red' }, { text: '고르는 법', color: 'white' }], figure: 'an older Korean person', metadata: { title: input.title.includes('쇼펜하우어') ? input.title : `${input.title}, 그 이유`, description: '관계를 넓히기보다 고르는 것이 왜 중요한지 짧게 정리했습니다. 거리를 두는 것이 관계를 지키는 방법이 되는 순간을 이야기합니다.', tags: ['인간관계', '관계 정리', '거리 두기', '혼자의 시간', '진짜 친구', '노년의 관계'], hashtags: ['#인간관계', '#관계정리', '#쇼츠'], pinnedComment: '여러분은 요즘 누구에게 가장 많은 시간을 쓰고 계신가요?' } })

test('selection: only strong, grounded, non-overlapping ideas; at most 5; zero is an answer', () => {
  const sc: any = { ...SAMPLE, sections: SENTS.map((s, i) => ({ id: `s${i + 1}`, sentences: s.map(card) })) }
  const r = selectDerivedShorts(IDEAS, sc)
  assert.deepEqual(r.candidates.map((c) => c.shortTitle), ['좋은 사람에게도 거리를 둬야 하는 순간', '쇼펜하우어가 혼자를 두려워하지 않은 이유', '나이 들수록 인간관계를 줄여야 하는 이유'])
  assert.deepEqual(r.excluded.map((x) => x.reason.split(' ')[0]).sort(), ['overlaps', 'source', 'weak', 'weak'])
  const many = { ideas: Array.from({ length: 8 }, (_, i) => ({ ...IDEAS.ideas[0], shortTitle: `완전히 다른 주제 ${'가나다라마바사아'[i]}${i}번째 이야기`, corePoint: `서로 다른 핵심 ${'자차카타파하거너'[i]} ${i}`, sourceRefs: [{ section: i % 3, sentence: i % 4 }] })) }
  assert.ok(selectDerivedShorts(many, sc).candidates.length <= DERIVED.max)
  assert.deepEqual(selectDerivedShorts({ ideas: IDEAS.ideas.slice(3, 5) }, sc).candidates, [], 'only weak ideas -> none recommended')
})

test('WISDOM LONGFORM -> 3 recommended Shorts -> user keeps 2 -> two Wisdom Shorts jobs COMPLETE (Screen DNA, thinker guard, parent link)', async () => {
  const d = await mkdtemp(join(tmpdir(), 'derived-'))
  const db = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  ;(blobs as any).presign = async (ref: string) => ({ url: `memory://${ref}`, validUntil: 'x' })
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  const call = async (method: string, opts: { body?: any; query?: any } = {}) => {
    let status = 0, json: any = null
    const req: any = { method, headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: opts.query || {}, body: opts.body }
    const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }
    await handler(req, res); return { status, json }
  }
  const calls: Record<string, number> = {}, seenBriefs: any[] = [], imagePrompts: string[] = [], deriveInputs: any[] = []
  const derive = async (i: any) => { calls.derive = (calls.derive || 0) + 1; deriveInputs.push(i); return IDEAS }
  const executors = stageExecutorsFor(createModuleRegistry({
    analyze: analyzeExecutor, sourcePlan: { stage: 'PLAN', estimateUsd: () => 0, inputHash: () => 'x', run: async () => { throw new Error('no source shorts here') } } as any,
    wisdomPlan: createGenerativePlanExecutor({ apiKey: 'k', plan: wisdomPlan(seenBriefs) as any }),
    wisdomAsset: createGenerativeAssetExecutor({ apiKey: 'k', image: async (p: string) => { imagePrompts.push(p); return { bytes: await portrait(imagePrompts.length), contentType: 'image/jpeg', provider: 'standin', model: 'portrait' } }, tts: async (t: string) => ({ bytes: await mp3(Math.max(2.5, [...t].length / 7)), contentType: 'audio/mpeg', provider: 'standin', model: 'tone' }) } as any),
    compile: compileExecutor, render: renderExecutor, autoQc: createAutoQcExecutor(null, async () => null),
    decision: decisionExecutor, final: finalExecutor,
    shortsPackage: withWisdomThumbnail(packageExecutor, { apiKey: 'k', kit: async (i: any) => { calls.kit = (calls.kit || 0) + 1; return KIT(i) as any }, image: async () => ({ bytes: await portrait(99), contentType: 'image/jpeg', provider: 'standin', model: 'thumb' }) as any }),
    longformPlan: createLongformPlanExecutor({ apiKey: 'k', planner: planner(calls) as any, research: research(calls) as any, derive: derive as any, log: () => {} }),
    longformAsset: createLongformAssetExecutor({ apiKey: 'k', image: async () => { throw new Error('the longform picture is not needed in this test') }, tts: async () => { throw new Error('no longform voice in this test') } } as any),
    longformRender: longformRenderExecutor, longformPackage: longformPackageExecutor
  }))
  const resolveSourceAsset = async (id: string) => { const g: any = await blobs.getJson(`generative-sources/${id}.json`); if (!g) throw Object.assign(new Error('not ready'), { code: 'SOURCE_ASSET_NOT_FOUND' }); return g }
  const resolveSourceFile = async (asset: any) => { const p = join(d, `${asset.sourceAssetId}.mp4`); await writeFile(p, blobs.binaries.get(asset.blobPath)); return { path: p, cleanup: async () => {} } }
  const tick = () => runOnce({ store, blobs, executors, resolveSourceAsset, resolveSourceFile, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 } as any)

  // 1) the Wisdom Longform (파생 쇼츠 자동 추천 is ON by default)
  const lf = await call('POST', { body: { taskType: 'job_create', profile: 'wisdom_longform', idempotencyKey: 'wisdom-lf-derive-1', budgetUsd: 5, input: { kind: 'topic', text: TITLE, targetSeconds: 600, aspectRatio: '16:9' } } })
  assert.equal(lf.status, 201, JSON.stringify(lf.json)); const parentId = lf.json.job.id
  assert.equal((await call('GET', { query: { taskType: 'job_derived', id: parentId } })).json.status, 'pending')
  const r1: any = await tick(); assert.equal(r1.stage, 'PLAN'); assert.equal(r1.outcome, 'completed')
  assert.equal(r1.job.stage, 'ASSET', 'the Longform goes on by itself (no stop for the recommendation)')
  assert.deepEqual([calls.research, calls.derive], [1, 1])
  assert.equal(deriveInputs[0].research.fragments[0].id, 'f1', 'the deriver gets the research the Longform already made')
  assert.equal(deriveInputs[0].script.title, TITLE)
  const rec = (await call('GET', { query: { taskType: 'job_derived', id: parentId } })).json
  assert.equal(rec.status, 'ready'); assert.equal(rec.parent.title, TITLE)
  assert.deepEqual(rec.candidates.map((c: any) => c.shortTitle), ['좋은 사람에게도 거리를 둬야 하는 순간', '쇼펜하우어가 혼자를 두려워하지 않은 이유', '나이 들수록 인간관계를 줄여야 하는 이유'])
  assert.ok(rec.candidates.every((c: any) => c.id && c.hook && c.corePoint && c.payoff && c.sourceClaim && c.sourceRefs.length))
  // a PLAN retry never pays for the deriver again (checkpoint)
  const parentJob = await store.getJob(parentId, (await store.getJob(parentId as any, r1.job.workspaceId))!.workspaceId)
  await createLongformPlanExecutor({ apiKey: 'k', planner: planner({}) as any, research: research(calls) as any, derive: derive as any, log: () => {} }).run({ job: { ...parentJob, planRef: parentJob!.planRef }, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  assert.deepEqual([calls.derive, calls.research], [1, 1])

  // 2) the user keeps 2 of 3 (#2 unchecked) -> two child jobs, made on the server from the parent's material
  const keep = [rec.candidates[1], rec.candidates[0]]
  const kids: string[] = []
  for (const c of keep) {
    const r = await call('POST', { body: { taskType: 'job_create', profile: 'wisdom', idempotencyKey: `derived-${parentId}-${c.id}`, budgetUsd: 5, input: { derivedFrom: { parentJobId: parentId, candidateId: c.id }, targetSeconds: 40, language: 'ko', aspectRatio: '9:16' } } })
    assert.equal(r.status, 201, JSON.stringify(r.json)); kids.push(r.json.job.id)
  }
  assert.equal((await call('POST', { body: { taskType: 'job_create', profile: 'wisdom', idempotencyKey: 'derived-bad-1', budgetUsd: 5, input: { derivedFrom: { parentJobId: parentId, candidateId: 'nope' }, targetSeconds: 40 } } })).status, 404)
  const again = await call('POST', { body: { taskType: 'job_create', profile: 'wisdom', idempotencyKey: `derived-${parentId}-${keep[0].id}`, budgetUsd: 5, input: { derivedFrom: { parentJobId: parentId, candidateId: keep[0].id }, targetSeconds: 40, language: 'ko', aspectRatio: '9:16' } } })
  assert.equal(again.json.created, false, 'the same choice twice is the same job')
  assert.deepEqual((await call('GET', { query: { taskType: 'job_derived', id: parentId } })).json.children.map((x: any) => x.jobId).sort(), [...kids].sort())

  // 3) run every queued job: the two children go the whole Wisdom Shorts way (the Longform stops at its stand-in ASSET)
  for (let i = 0; i < 40; i++) { const r: any = await tick(); if (!r.ran) break }
  for (const [k, id] of kids.entries()) {
    const job = (await call('GET', { query: { taskType: 'job_get', id } })).json.job
    assert.equal(job.status, 'COMPLETE', JSON.stringify({ k, status: job.status, stage: job.stage, wait: job.waitReason, error: job.error }))
    const runs = await store.listStageRuns(id), ok = (st: string) => [...runs].reverse().find((r: any) => r.stage === st && r.status === 'SUCCEEDED') as any
    assert.deepEqual(['PLAN', 'ASSET', 'ANALYZE', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE'].map((st) => !!ok(st)), Array(9).fill(true))
    assert.equal(ok('DECISION').result.selected, 'recommended-publishable', 'no second confirmation for a derived Short')
    // Screen DNA / QC of the existing Wisdom Shorts pipeline
    const v = ok('AUTO_QC').result.variants.find((x: any) => x.variantId === ok('AUTO_QC').result.recommendedVariantId)
    assert.equal(v.publishable, true); assert.equal(v.gate.decision, 'PASS')
    const pk = (await call('GET', { query: { taskType: 'job_package', id } })).json
    const mp4 = join(d, `kid${k}.mp4`); await writeFile(mp4, blobs.binaries.get(pk.package.finalRenderRef))
    const info = await probe(mp4); assert.deepEqual([info.width, info.height], [1080, 1920])
    // parent link: description + pinned comment name the Longform; no made-up URL
    assert.equal(pk.package.derivedFrom.parentLongformJobId, parentId); assert.equal(pk.package.derivedFrom.parentLongformUrl, null)
    assert.ok(pk.upload.description.includes(`롱폼 「${TITLE}」`) && !/https?:\/\//.test(pk.upload.description), pk.upload.description)
    assert.ok(pk.upload.pinnedComment.includes(`롱폼 「${TITLE}」`))
    assert.deepEqual(uploadMetadataErrors({ ...pk.upload, description: pk.upload.description.split('\n\n#')[0] }, { narration: 'x', format: 'shorts' }).filter((e) => !/not_about_content|copies/.test(e)), [])
  }
  // the brief is the parent's own material (source sentences + rules); the thinker guard puts Schopenhauer in the picture
  const schopen = seenBriefs.find((b) => b.derivedFrom.candidateId === keep[0].id)
  assert.equal(schopen.kind, 'text'); assert.equal(schopen.derivedFrom.parentLongformJobId, parentId)
  assert.ok(schopen.text.includes('쇼펜하우어는 혼자 있을 수 있는 사람만이 자유롭다고 말했습니다.') && schopen.text.includes('새로운 사실'))
  assert.ok(imagePrompts.some((p) => /Schopenhauer/i.test(p)), 'named-thinker guard: the Schopenhauer Short shows Schopenhauer')
  assert.ok(imagePrompts.length >= 12, `new 9:16 pictures for each Short (${imagePrompts.length})`)
  // nothing paid twice: one research, one derive, for the whole bundle
  assert.deepEqual([calls.research, calls.derive], [1, 1])
})

test('파생 쇼츠 자동 추천 OFF: no deriver call; the recommendation says off; other briefs unchanged', async () => {
  const { normalizeLongformBrief } = await import('../lib/generative/longform.js')
  assert.equal(normalizeLongformBrief({ kind: 'topic', text: TITLE, targetSeconds: 600 }, 'wisdom_longform').deriveShorts, undefined, 'ON by default; the brief stays as before')
  assert.equal(normalizeLongformBrief({ kind: 'topic', text: TITLE, targetSeconds: 600, deriveShorts: false }, 'wisdom_longform').deriveShorts, false)
  assert.equal(normalizeLongformBrief({ kind: 'topic', text: '어머니의 밥상 이야기', targetSeconds: 600, deriveShorts: false }, 'senior_longform').deriveShorts, undefined)
  const blobs: any = createMemoryBlobStore(), { putAddressed } = await import('../lib/jobs/blobs.js')
  const b = await putAddressed(blobs, 'generative-briefs', normalizeLongformBrief({ kind: 'topic', text: TITLE, targetSeconds: 600, deriveShorts: false }, 'wisdom_longform'))
  let n = 0
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', planner: planner({}) as any, research: research({}) as any, derive: (async () => { n++; return IDEAS }) as any, log: () => {} }).run({ job: { id: 'off1', profile: 'wisdom_longform', planRev: 1, planRef: b.path }, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  assert.equal(n, 0); assert.deepEqual(out.result.derived, { status: 'off' })
  // a failing deriver never stops the Longform
  const b2 = await putAddressed(blobs, 'generative-briefs', normalizeLongformBrief({ kind: 'topic', text: TITLE + ' 2', targetSeconds: 600 }, 'wisdom_longform'))
  const out2: any = await createLongformPlanExecutor({ apiKey: 'k', planner: planner({}) as any, research: research({}) as any, derive: (async () => { throw Object.assign(new Error('quota'), { stop: true, code: 'insufficient_quota' }) }) as any, log: () => {} }).run({ job: { id: 'off2', profile: 'wisdom_longform', planRev: 1, planRef: b2.path }, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  assert.equal(out2.result.derived.status, 'failed'); assert.ok(out2.result.scriptRef)
})

test('deriver request (stubbed fetch, no paid call): ONE low-cost call over the numbered script + existing research; no web search', async () => {
  const { openAiDeriveShorts, DERIVE_SCHEMA } = await import('../lib/generative/derivedShorts.js')
  const sent: any[] = []
  const f: any = async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ output_text: JSON.stringify(IDEAS) }), { status: 200 }) }
  const sc: any = { ...SAMPLE, sections: SENTS.map((s, i) => ({ id: `s${i + 1}`, sentences: s.map(card) })) }
  const out = await openAiDeriveShorts({ script: sc, research: { topic: TITLE, model: 'm', researchedAt: 'x', fragments: [{ id: 'f1', claim: '고독을 견디는 힘이 자유다' }] as any, sectionMap: [] } }, 'k', f)
  assert.equal(sent.length, 1); assert.equal(out.ideas.length, 7)
  assert.equal(sent[0].body.model, 'gpt-5-mini'); assert.equal(sent[0].body.tools, undefined, 'no web search: the Longform research is reused')
  assert.equal(sent[0].body.text.format.name, 'derived_shorts'); assert.deepEqual(sent[0].body.text.format.schema, DERIVE_SCHEMA)
  assert.ok(sent[0].body.input.includes('[0.2] 쇼펜하우어는 혼자 있을 수 있는 사람만이 자유롭다고 말했습니다.') && sent[0].body.input.includes('f1: 고독을 견디는 힘이 자유다'))
  assert.match(sent[0].body.instructions, /no new facts/); assert.match(sent[0].body.instructions, /never "the answer is in the longform"/)
})
