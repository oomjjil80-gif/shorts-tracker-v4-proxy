// Production Golden re-plan (PLAN_RECHECK) fail-closed: the semantic outcome is explicit, a recovery PLAN that does not get
// a validated, presentation-complete semantic plan never completes, and nothing downstream (COMPILE/RENDER) runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { computeHighlights, type SourceAnalysis } from '../lib/media/analyze.js'
import { aiAnalyzeStory } from '../lib/media/aiPlanner.js'
import { createPlanExecutor } from '../worker/stages/plan.js'
import { compileExecutor } from '../worker/stages/compile.js'
import { runOnce } from '../worker/runJob.js'

const a: SourceAnalysis = {
  schema: 'source-analysis/1', sourceAssetId: 'src_golden_replan_01', sha256: 'a'.repeat(64),
  media: { duration: 31, width: 576, height: 1024, fps: 30, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', orientation: 'portrait' },
  scenes: [{ start: 0, end: 31 }], timeline: Array.from({ length: 31 }, (_, t) => ({ t, visual: 0.1 + ((t * 7) % 5) / 100, audioDb: -25 })),
  ranges: { black: [], freeze: [], silent: [] }, audio: { silentRatio: 0, intentionallySilent: false }, highlights: [], usable: [{ start: 0, end: 31 }], analyzer: { name: 'ffmpeg-signals', version: 1 }
}
a.highlights = computeHighlights(a.timeline)
const JPEG = Buffer.from('jpg')

// CASE A answer: validated, two-word hook, captions-only rhythm
const good = {
  storyType: 'single_event', confidence: 0.9, causalStart: 1.5,
  setupRanges: [{ start: 1.5, end: 7 }], escalationRanges: [{ start: 7, end: 18 }], payoffRange: { start: 18, end: 20 }, recommendedEnd: 20.3,
  excludeRanges: [{ start: 0, end: 1.5, reason: 'foreign_text' }, { start: 24.5, end: 31, reason: 'product_demo' }],
  hookStrategy: 'chronological', previewRange: null, hookConfidence: 0.1, hookReason: '',
  openingHook: { start: 1.5, end: 3, text: '왜 바닥을 기어갈까?', basis: 'adult visibly crawls' },
  minimalCaptions: [
    { kind: 'context', start: 5.5, end: 7, text: '갑자기 기어가기 시작', basis: 'adult starts crawling' },
    { kind: 'context', start: 10.5, end: 12, text: '아이가 지켜본다', basis: 'child watches' },
    { kind: 'context', start: 14.5, end: 16, text: '그걸 본 아이가', basis: 'child moves' },
    { kind: 'payoff', start: 18.2, end: 19.8, text: '결국 아이도 따라간다', basis: 'child follows' }
  ], publishabilityWarnings: []
}
// CASE B answer: exactly what Production's model returned for the Golden source (2026-10-03)
const productionUnclear = {
  ...good, storyType: 'unclear', confidence: 0.28,
  setupRanges: [{ start: 1.5, end: 7 }], escalationRanges: [{ start: 7, end: 22 }], payoffRange: { start: 22, end: 24.5 }, recommendedEnd: 25,
  excludeRanges: [{ start: 0, end: 1.5, reason: 'foreign_text' }, { start: 24.5, end: 31, reason: 'product_demo' }]
}

type Reply = { body?: any; text?: string; throws?: string; status?: number }
function provider(replies: Reply[]) {
  let i = 0
  const f = (async () => {
    const r = replies[Math.min(i++, replies.length - 1)]
    if (r.throws) throw new Error(r.throws)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => (r.status && r.status >= 400 ? { error: { message: 'upstream' } } : { model: 'gpt-test', output_text: r.text ?? JSON.stringify(r.body) }) }
  }) as unknown as typeof fetch
  return { f, calls: () => i }
}

async function harness(prevPlan: boolean) {
  const blobs = createMemoryBlobStore()
  const ref = (await blobs.putJson('analysis/g.json', a)).path
  const sheet = (await blobs.putBytes('analysis/keyframes/g.jpg', JPEG, 'image/jpeg')).path
  const previous = async (stage: string) => (stage === 'ANALYZE' ? { outputRef: ref, result: { keyframeSheetRef: sheet } } : stage === 'PLAN' && prevPlan ? { outputRef: 'plans/old.json', result: { variants: [] } } : null) as any
  return { blobs, previous, job: { id: 'job_golden', sourceAssetId: a.sourceAssetId, planRev: 1, referenceProfileRef: null } as any }
}
const plan = (replies: Reply[] | null) => { const p = replies ? provider(replies) : null; return { p, ex: createPlanExecutor(p ? { openAi: { apiKey: 'k', model: 'm', fetchImpl: p.f } } : {}) } }
const capture = async (f: () => Promise<any>) => { const logs: string[] = []; const orig = console.info; console.info = (...x: any[]) => { logs.push(x.join(' ')) }; try { return { out: await f().catch((e) => ({ error: e })), logs } } finally { console.info = orig } }

test('semantic outcome is explicit: OK / LOW_CONFIDENCE / REQUEST / PARSE / SCHEMA / REPAIR / INPUT failures', async () => {
  const r = async (replies: Reply[], sheet: Buffer | null = JPEG) => aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: sheet, fetchImpl: provider(replies).f })
  assert.equal((await r([{ body: good }])).outcome, 'AI_OK')
  const low = await r([{ body: productionUnclear }]); assert.deepEqual([low.outcome, low.status, low.story?.confidence], ['AI_LOW_CONFIDENCE', 'low_confidence', 0.28])
  assert.equal((await r([{ throws: 'ECONNRESET' }])).outcome, 'AI_REQUEST_FAILED')
  assert.equal((await r([{ status: 429 }])).outcome, 'AI_REQUEST_FAILED')
  assert.equal((await r([{ text: '{not json' }, { text: 'still not json' }])).outcome, 'AI_PARSE_FAILED')
  assert.equal((await r([{ body: { ...good, payoffRange: { start: 40, end: 41 } } }, { body: { ...good, payoffRange: { start: 40, end: 41 } } }])).outcome, 'AI_SCHEMA_FAILED')
  assert.equal((await r([{ text: '{not json' }, { throws: 'timeout' }])).outcome, 'AI_REPAIR_FAILED')
  assert.equal((await r([{ body: good }], null)).outcome, 'AI_INPUT_MISSING')
})

test('CASE A: recovery re-plan with a validated AI story completes with a presentation-complete plan; COMPILE allowed', async () => {
  const h = await harness(true)
  const { ex } = plan([{ body: good }])
  const { out, logs } = await capture(() => ex.run({ job: h.job, blobs: h.blobs, previous: h.previous, signal: new AbortController().signal } as any))
  assert.ok(!out.error, String(out.error))
  assert.deepEqual([out.result.recovery, out.result.planContract.ok, out.result.semantic.outcome, out.result.provider], [true, true, 'AI_OK', 'openai'])
  assert.match(logs.join('\n'), /semantic_status=AI_OK .*provider_called=openai .*fallback=none .*recovery=true/)
  const stored: any = await h.blobs.getJson(out.planRef)
  assert.equal(stored.variantPlan.headline, '왜 바닥을 기어갈까?')
  // COMPILE entry accepts it (it fails later only for unrelated fixture reasons, never on the plan contract)
  const err = await compileExecutor.run({ job: { ...h.job, profile: 'source_shorts', planRef: out.planRef }, blobs: h.blobs, previous: async (s: string) => (s === 'PLAN' ? { outputRef: out.planRef, result: out.result } : null), resolveSourceAsset: async () => ({ sourceAssetId: a.sourceAssetId, blobPath: 'source-collector/g.mp4', sha256: 'a'.repeat(64), duration: 31 }), signal: new AbortController().signal } as any).then(() => null, (e: any) => e)
  assert.notEqual(err?.code, 'PLAN_CONTRACT_NOT_MET')
})

test('CASE B: the exact Production answer (unclear, 0.28) blocks the recovery PLAN with a one-line diagnosis', async () => {
  const h = await harness(true)
  const { ex, p } = plan([{ body: productionUnclear }])
  const { out, logs } = await capture(() => ex.run({ job: h.job, blobs: h.blobs, previous: h.previous, signal: new AbortController().signal } as any))
  assert.equal(p!.calls(), 1) // the AI WAS called and answered; this is not a request failure
  assert.equal(out.error?.code, 'SEMANTIC_RECOVERY_BLOCKED'); assert.equal(out.error.retryable, false)
  assert.deepEqual([out.error.details.semanticStatus, out.error.details.providerCalled, out.error.details.confidence, out.error.details.storyType], ['AI_LOW_CONFIDENCE', 'openai', 0.28, 'unclear'])
  const line = logs.find((l) => l.includes('semantic_status='))!
  assert.match(line, /semantic_status=AI_LOW_CONFIDENCE semantic=low_confidence provider_called=openai model=gpt-test calls=1 fallback=heuristic confidence=0.28 storyType=unclear recovery=true reason="storyType=unclear confidence=0.28"/)
  assert.ok(!/Bearer|apiKey|"k"/.test(logs.join('\n'))) // no key in logs
  assert.ok(logs.some((l) => l.includes('RECOVERY_BLOCKED')))
})

test('CASE C/D/E: request failure (retryable), parse / schema / repair failure and AI-not-configured all block recovery', async () => {
  const cases: Array<[Reply[] | null, string, boolean]> = [
    [[{ throws: 'socket hang up' }], 'AI_REQUEST_FAILED', true],
    [[{ text: '{nope' }, { text: 'nope' }], 'AI_PARSE_FAILED', false],
    [[{ body: { ...good, payoffRange: { start: 40, end: 41 } } }, { body: { ...good, payoffRange: { start: 40, end: 41 } } }], 'AI_SCHEMA_FAILED', false],
    [[{ text: '{nope' }, { throws: 'timeout' }], 'AI_REPAIR_FAILED', false],
    [[{ body: { ...good, storyType: 'unclear', confidence: 0.2 } }], 'AI_LOW_CONFIDENCE', false],
    [null, 'AI_NOT_CONFIGURED', false]
  ]
  for (const [replies, outcome, retryable] of cases) {
    const h = await harness(true)
    const { out } = await capture(() => plan(replies).ex.run({ job: h.job, blobs: h.blobs, previous: h.previous, signal: new AbortController().signal } as any))
    assert.equal(out.error?.code, 'SEMANTIC_RECOVERY_BLOCKED', outcome)
    assert.equal(out.error.details.semanticStatus, outcome); assert.equal(out.error.retryable, retryable, outcome)
  }
})

test('CASE F: a normal first PLAN keeps the existing heuristic-fallback policy (recorded, not blocked)', async () => {
  const h = await harness(false)
  const { out } = await capture(() => plan([{ body: productionUnclear }]).ex.run({ job: h.job, blobs: h.blobs, previous: h.previous, signal: new AbortController().signal } as any))
  assert.ok(!out.error, String(out.error))
  assert.deepEqual([out.result.recovery, out.result.planContract.ok, out.result.semantic.outcome, out.result.provider], [false, false, 'AI_LOW_CONFIDENCE', 'heuristic'])
  assert.ok(out.result.planContract.reasons.some((r: string) => /semantic story not usable/.test(r)))
})

test('COMPILE entry refuses a recovery plan whose contract is not met (defense in depth)', async () => {
  const blobs = createMemoryBlobStore()
  const err = await compileExecutor.run({ job: { id: 'j', profile: 'source_shorts', planRef: 'plans/x.json', sourceAssetId: a.sourceAssetId, planRev: 1 }, blobs, previous: async (s: string) => (s === 'PLAN' ? { outputRef: 'plans/x.json', result: { recovery: true, planContract: { ok: false, reasons: ['no Korean headline'] } } } : null), resolveSourceAsset: async () => ({ sourceAssetId: a.sourceAssetId, blobPath: 'source-collector/g.mp4', sha256: 'a'.repeat(64), duration: 31 }), signal: new AbortController().signal } as any).then(() => null, (e: any) => e)
  assert.equal(err?.code, 'PLAN_CONTRACT_NOT_MET')
})

test('Golden PLAN_RECHECK end-to-end (real store + worker loop): unclear answer -> PLAN FAILED, COMPILE never runs; retry with a good answer -> COMPILE queued', async () => {
  const db = await createTestDb()
  const store = createJobStore(db, { maxAttempts: 3, retryBackoffMs: () => 0 })
  const blobs = createMemoryBlobStore()
  const ref = (await blobs.putJson('analysis/g.json', a)).path
  const sheet = (await blobs.putBytes('analysis/keyframes/g.jpg', JPEG, 'image/jpeg')).path
  const { job } = await store.createJob({ workspaceId: 'ws1', profile: 'source_shorts', sourceAssetId: a.sourceAssetId, idempotencyKey: 'golden-replan', budgetUsd: 5 })
  const step = async (stage: string, extra: any = {}) => {
    await store.claimJob({ workerId: 'w', stages: [stage as any] })
    const { attempt } = await store.startStageRun({ jobId: job.id, workerId: 'w' })
    return store.completeStage({ jobId: job.id, workerId: 'w', attempt, ...extra })
  }
  await step('ANALYZE', { outputRef: ref, result: { keyframeSheetRef: sheet } })
  await step('PLAN', { outputRef: 'plans/legacy.json', planRef: 'plans/legacy.json', result: { variants: [] } }) // the 09-30 legacy plan
  for (const s of ['COMPILE', 'RENDER']) await step(s)
  await step('AUTO_QC', { wait: 'QC_BLOCKED' })
  const count = async (stage: string) => (await store.listStageRuns(job.id)).filter((r) => r.stage === stage).length
  const compileRunsBefore = await count('COMPILE')

  await store.recheckPlan({ jobId: job.id })
  const deps = (replies: Reply[]) => ({ store, blobs, workerId: 'w', executors: [createPlanExecutor({ openAi: { apiKey: 'k', model: 'm', fetchImpl: provider(replies).f } }), compileExecutor], resolveSourceAsset: async () => ({ sourceAssetId: a.sourceAssetId, blobPath: 'source-collector/g.mp4', sha256: 'a'.repeat(64), duration: 31 }) as any, leaseMs: 60_000 })
  const r1: any = await capture(() => runOnce(deps([{ body: productionUnclear }]) as any))
  assert.equal(r1.out.outcome, 'failed')
  const failed = await store.getJob(job.id, 'ws1')
  assert.deepEqual([failed?.status, failed?.stage], ['FAILED', 'PLAN'])
  const lastPlan = (await store.listStageRuns(job.id)).filter((r) => r.stage === 'PLAN').at(-1)!
  assert.deepEqual([lastPlan.status, (lastPlan.error as any)?.code, (lastPlan.error as any)?.details?.semanticStatus], ['FAILED', 'SEMANTIC_RECOVERY_BLOCKED', 'AI_LOW_CONFIDENCE'])
  assert.equal(await count('COMPILE'), compileRunsBefore) // nothing downstream ran
  assert.equal((await runOnce(deps([{ body: good }]) as any)).ran, false) // a FAILED job is never picked up

  // operator retries the recovery; this time the model returns a validated story
  await store.recheckPlan({ jobId: job.id })
  const r2: any = await capture(() => runOnce(deps([{ body: good }]) as any))
  assert.equal(r2.out.outcome, 'completed', JSON.stringify(r2.out))
  const after = await store.getJob(job.id, 'ws1')
  assert.deepEqual([after?.status, after?.stage], ['QUEUED', 'COMPILE'])
  const okPlan: any = await store.getLatestSucceeded(job.id, 'PLAN')
  assert.deepEqual([okPlan.result.recovery, okPlan.result.planContract.ok, okPlan.result.semantic.outcome], [true, true, 'AI_OK'])
})
