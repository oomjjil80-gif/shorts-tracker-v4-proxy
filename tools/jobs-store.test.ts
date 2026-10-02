import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { JobError, LeaseLostError } from '../lib/jobs/types.js'

async function setup() {
  const clockState = { now: new Date('2026-09-29T00:00:00.000Z') }
  const db = await createTestDb()
  const store = createJobStore(db, { clock: () => clockState.now, maxAttempts: 3, retryBackoffMs: () => 1000 })
  const advance = (ms: number) => { clockState.now = new Date(clockState.now.getTime() + ms) }
  const base = { workspaceId: 'ws1', profile: 'source_shorts', sourceAssetId: 'src_1' }
  return { db, store, advance, base }
}
const HASH = 'a'.repeat(64)

test('T1 same idempotencyKey -> same job (no duplicate row)', async () => {
  const { db, store, base } = await setup()
  const a = await store.createJob({ ...base, idempotencyKey: 'k1' })
  const b = await store.createJob({ ...base, idempotencyKey: 'k1' })
  assert.equal(a.created, true); assert.equal(b.created, false)
  assert.equal(a.job.id, b.job.id)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM production_jobs')).rows[0].n, 1)
  await assert.rejects(() => store.createJob({ ...base, sourceAssetId: 'src_other', idempotencyKey: 'k1' }), (e: any) => e instanceof JobError && e.code === 'IDEMPOTENCY_KEY_REUSED')
  // concurrent duplicates still collapse to one job
  const [c, d] = await Promise.all([store.createJob({ ...base, idempotencyKey: 'k2' }), store.createJob({ ...base, idempotencyKey: 'k2' })])
  assert.equal(c.job.id, d.job.id)
})

test('T2 different idempotencyKey (or workspace) -> different job', async () => {
  const { store, base } = await setup()
  const a = await store.createJob({ ...base, idempotencyKey: 'k1' })
  const b = await store.createJob({ ...base, idempotencyKey: 'k2' })
  const c = await store.createJob({ ...base, workspaceId: 'ws2', idempotencyKey: 'k1' })
  assert.equal(new Set([a.job.id, b.job.id, c.job.id]).size, 3)
  assert.equal(a.job.status, 'QUEUED'); assert.equal(a.job.stage, 'ANALYZE')
  assert.equal((await store.createJob({ ...base, idempotencyKey: 'k3', planRef: 'plans/x.json' })).job.stage, 'COMPILE')
  assert.equal(await store.getJob(a.job.id, 'ws2'), null, 'workspace isolation')
})

test('T3 lease claim conflict: one worker wins, concurrent claims never share a job', async () => {
  const { store, base } = await setup()
  await store.createJob({ ...base, idempotencyKey: 'k1', planRef: 'p' })
  const [w1, w2] = await Promise.all([store.claimJob({ workerId: 'w1', stages: ['COMPILE'] }), store.claimJob({ workerId: 'w2', stages: ['COMPILE'] })])
  assert.equal([w1, w2].filter(Boolean).length, 1)
  assert.equal(await store.claimJob({ workerId: 'w3', stages: ['COMPILE'] }), null)
  // stage filter: a worker without an executor for the stage never claims it
  await store.createJob({ ...base, idempotencyKey: 'k2' })
  assert.equal(await store.claimJob({ workerId: 'w1', stages: ['COMPILE'] }), null)
})

test('T4 expired lease can be reclaimed; the stale worker is fenced out', async () => {
  const { store, advance, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'k1', planRef: 'p' })
  const c1 = (await store.claimJob({ workerId: 'w1', stages: ['COMPILE'], leaseMs: 10_000 }))!
  const run1 = await store.startStageRun({ jobId: job.id, workerId: 'w1' })
  advance(5_000)
  assert.equal(await store.claimJob({ workerId: 'w2', stages: ['COMPILE'] }), null, 'live lease is not stealable')
  advance(6_000) // w1 crashed: lease expired
  const c2 = await store.claimJob({ workerId: 'w2', stages: ['COMPILE'], leaseMs: 10_000 })
  assert.equal(c2?.id, c1.id); assert.equal(c2?.leaseOwner, 'w2')
  await assert.rejects(() => store.completeStage({ jobId: job.id, workerId: 'w1', attempt: run1.attempt }), (e: any) => e instanceof LeaseLostError)
  assert.deepEqual(await store.heartbeat({ jobId: job.id, workerId: 'w1' }), { ok: false, cancelRequested: false })
  const run2 = await store.startStageRun({ jobId: job.id, workerId: 'w2' })
  assert.equal(run2.attempt, 2)
  const runs = await store.listStageRuns(job.id)
  assert.ok(runs.some((r) => r.attempt === 1 && r.status === 'FAILED' && (r.error as any).code === 'LEASE_EXPIRED'), 'orphaned attempt is closed in the log')
})

test('T5 heartbeat extends the lease', async () => {
  const { store, advance, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'k1', planRef: 'p' })
  await store.claimJob({ workerId: 'w1', stages: ['COMPILE'], leaseMs: 10_000 })
  for (let i = 0; i < 4; i++) { advance(8_000); assert.equal((await store.heartbeat({ jobId: job.id, workerId: 'w1', leaseMs: 10_000 })).ok, true) }
  assert.equal(await store.claimJob({ workerId: 'w2', stages: ['COMPILE'] }), null, 'still owned after 32s thanks to heartbeats')
  assert.ok((await store.getJob(job.id))!.leaseUntil!.getTime() > new Date('2026-09-29T00:00:32.000Z').getTime())
})

test('T6 cancel_requested: live lease -> worker stops at stage boundary; idle -> cancelled at once; never claimed', async () => {
  const { store, base } = await setup()
  const running = (await store.createJob({ ...base, idempotencyKey: 'a', planRef: 'p' })).job
  await store.claimJob({ workerId: 'w1', stages: ['COMPILE'] })
  const { attempt } = await store.startStageRun({ jobId: running.id, workerId: 'w1' })
  const req = await store.requestCancel({ jobId: running.id, workspaceId: 'ws1' })
  assert.equal(req.cancelRequested, true); assert.equal(req.status, 'RUNNING')
  assert.deepEqual(await store.heartbeat({ jobId: running.id, workerId: 'w1' }), { ok: true, cancelRequested: true })
  const done = await store.completeStage({ jobId: running.id, workerId: 'w1', attempt })
  assert.equal(done.status, 'CANCELLED'); assert.equal(done.stage, 'COMPILE'); assert.equal(done.leaseOwner, null)
  const idle = (await store.createJob({ ...base, idempotencyKey: 'b', planRef: 'p' })).job
  assert.equal((await store.requestCancel({ jobId: idle.id, workspaceId: 'ws1' })).status, 'CANCELLED')
  assert.equal(await store.claimJob({ workerId: 'w1', stages: ['COMPILE'] }), null)
  await assert.rejects(() => store.requestCancel({ jobId: idle.id, workspaceId: 'wsX' }), /not found/)
})

test('T6b crashed worker + cancel_requested: job is closed on next claim, not resurrected', async () => {
  const { store, advance, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'a', planRef: 'p' })
  await store.claimJob({ workerId: 'w1', stages: ['COMPILE'], leaseMs: 1000 })
  await store.requestCancel({ jobId: job.id, workspaceId: 'ws1' })
  advance(2000)
  assert.equal(await store.claimJob({ workerId: 'w2', stages: ['COMPILE'] }), null)
  assert.equal((await store.getJob(job.id))!.status, 'CANCELLED')
})

test('T7 job_stage_runs is append-only (UPDATE/DELETE rejected by the database)', async () => {
  const { db, store, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'k1', planRef: 'p' })
  await store.claimJob({ workerId: 'w1', stages: ['COMPILE'] })
  const { attempt } = await store.startStageRun({ jobId: job.id, workerId: 'w1' })
  await store.completeStage({ jobId: job.id, workerId: 'w1', attempt, outputHash: HASH, costUsd: 0.25 })
  const runs = await store.listStageRuns(job.id)
  assert.deepEqual(runs.map((r) => r.status), ['STARTED', 'SUCCEEDED'])
  await assert.rejects(() => db.query(`UPDATE job_stage_runs SET status='FAILED' WHERE job_id=$1`, [job.id]), /append-only/)
  await assert.rejects(() => db.query(`DELETE FROM job_stage_runs WHERE job_id=$1`, [job.id]), /append-only/)
  assert.equal((await store.listStageRuns(job.id)).length, 2)
})

test('state machine: complete advances stage; retry with backoff then FAILED; repair is a run kind, not a status', async () => {
  const { store, advance, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'k1', planRef: 'p' })
  await store.claimJob({ workerId: 'w', stages: ['COMPILE'] })
  let r = await store.startStageRun({ jobId: job.id, workerId: 'w' })
  const after = await store.completeStage({ jobId: job.id, workerId: 'w', attempt: r.attempt, costUsd: 1.5 })
  assert.deepEqual([after.status, after.stage, after.spentUsd], ['QUEUED', 'RENDER', 1.5])
  // failing stage: 3 attempts then FAILED
  const j2 = (await store.createJob({ ...base, idempotencyKey: 'k2', planRef: 'p' })).job
  for (let n = 1; n <= 3; n++) {
    let c = await store.claimJob({ workerId: 'w', stages: ['COMPILE'] })
    if (!c) { advance(1500); c = await store.claimJob({ workerId: 'w', stages: ['COMPILE'] }) }
    assert.equal(c!.id, j2.id)
    r = await store.startStageRun({ jobId: j2.id, workerId: 'w' })
    assert.equal(r.attempt, n)
    const f = await store.failStage({ jobId: j2.id, workerId: 'w', attempt: r.attempt, error: { message: 'boom' } })
    assert.equal(f.status, n < 3 ? 'QUEUED' : 'FAILED')
    if (n < 3) { assert.equal(await store.claimJob({ workerId: 'w', stages: ['COMPILE'] }), null, 'backoff respected') }
  }
  // a repair pass is recorded as kind=repair on the same stage
  const j3 = (await store.createJob({ ...base, idempotencyKey: 'k3', planRef: 'p' })).job
  await store.claimJob({ workerId: 'w', stages: ['COMPILE'] })
  const rep = await store.startStageRun({ jobId: j3.id, workerId: 'w', kind: 'repair' })
  await store.completeStage({ jobId: j3.id, workerId: 'w', attempt: rep.attempt, kind: 'repair' })
  assert.ok((await store.listStageRuns(j3.id)).every((x) => x.kind === 'repair'))
})

test('waiting: BUDGET park + resume; QC_BLOCKED via completeStage.wait; DB rejects status/wait_reason mismatch', async () => {
  const { db, store, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'k1', planRef: 'p', budgetUsd: 1 })
  await store.claimJob({ workerId: 'w', stages: ['COMPILE'] })
  const parked = await store.setWaiting({ jobId: job.id, workerId: 'w', reason: 'BUDGET' })
  assert.deepEqual([parked.status, parked.waitReason, parked.leaseOwner], ['WAITING_USER', 'BUDGET', null])
  assert.equal(await store.claimJob({ workerId: 'w', stages: ['COMPILE'] }), null)
  await assert.rejects(() => store.resumeJob({ jobId: job.id, workspaceId: 'ws1', budgetUsd: 0 }), (e: any) => e.code === 'BUDGET_TOO_LOW')
  assert.equal((await store.resumeJob({ jobId: job.id, workspaceId: 'ws1', budgetUsd: 5 })).status, 'QUEUED')
  await store.claimJob({ workerId: 'w', stages: ['COMPILE'] })
  const { attempt } = await store.startStageRun({ jobId: job.id, workerId: 'w' })
  const blocked = await store.completeStage({ jobId: job.id, workerId: 'w', attempt, wait: 'QC_BLOCKED' })
  assert.deepEqual([blocked.status, blocked.stage, blocked.waitReason], ['WAITING_USER', 'COMPILE', 'QC_BLOCKED'])
  await assert.rejects(() => db.query(`UPDATE production_jobs SET wait_reason=NULL WHERE id=$1`, [job.id]))
  await assert.rejects(() => db.query(`UPDATE production_jobs SET status='REPAIR' WHERE id=$1`, [job.id]))
})

test('decision: only a manifest this job compiled, with a PASSing gate (or explicit override); plan revision resets approval', async () => {
  const { store, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'k1', planRef: 'plans/1.json' })
  // drive COMPILE -> RENDER -> AUTO_QC -> DECISION
  const runStage = async (result?: unknown, outputHash?: string) => {
    await store.claimJob({ workerId: 'w', stages: ['COMPILE', 'RENDER', 'AUTO_QC'] })
    const { attempt } = await store.startStageRun({ jobId: job.id, workerId: 'w' })
    return store.completeStage({ jobId: job.id, workerId: 'w', attempt, result, outputHash })
  }
  await runStage({ gate: { decision: 'BLOCK' } }, HASH)
  await runStage(); await runStage()
  await store.claimJob({ workerId: 'w', stages: ['DECISION'] }) // nothing runs DECISION
  assert.equal((await store.getJob(job.id))!.stage, 'DECISION')
  await assert.rejects(() => store.recordDecision({ jobId: job.id, workspaceId: 'ws1', manifestHash: HASH }), (e: any) => e.code === 'NOT_AWAITING_DECISION')
  // park for the user decision
  await store.claimJob({ workerId: 'w', stages: ['DECISION'] })
  await store.setWaiting({ jobId: job.id, workerId: 'w', reason: 'DECISION' }).catch(() => {})
  const cur = (await store.getJob(job.id))!
  assert.equal(cur.waitReason, 'DECISION')
  await assert.rejects(() => store.recordDecision({ jobId: job.id, workspaceId: 'ws1', manifestHash: 'b'.repeat(64) }), (e: any) => e.code === 'UNKNOWN_MANIFEST')
  await assert.rejects(() => store.recordDecision({ jobId: job.id, workspaceId: 'ws1', manifestHash: HASH }), (e: any) => e.code === 'QC_NOT_PASSED')
  const ok = await store.recordDecision({ jobId: job.id, workspaceId: 'ws1', manifestHash: HASH, override: { reason: '수동 확인 완료' } })
  assert.deepEqual([ok.status, ok.stage, ok.approvedManifestHash], ['QUEUED', 'FINAL', HASH])
  const revised = await store.revisePlan({ jobId: job.id, workspaceId: 'ws1', expectedRev: 1, planRef: 'plans/2.json' })
  assert.deepEqual([revised.stage, revised.planRev, revised.approvedManifestHash, revised.planRef], ['COMPILE', 2, null, 'plans/2.json'])
  await assert.rejects(() => store.revisePlan({ jobId: job.id, workspaceId: 'ws1', expectedRev: 1, planRef: 'plans/3.json' }), (e: any) => e.code === 'PLAN_REV_CONFLICT')
})

test('P1: PLAN sets plan_ref/plan_rev; decision uses AUTO_QC per-variant gates (BLOCKed variant needs an override reason)', async () => {
  const { store, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'p1-decide' })
  assert.equal(job.stage, 'ANALYZE')
  const H1 = 'c'.repeat(64), H2 = 'd'.repeat(64)
  const step = async (stages: any[], extra: any = {}) => {
    await store.claimJob({ workerId: 'w', stages })
    const { attempt } = await store.startStageRun({ jobId: job.id, workerId: 'w' })
    return store.completeStage({ jobId: job.id, workerId: 'w', attempt, ...extra })
  }
  await step(['ANALYZE'])
  const afterPlan = await step(['PLAN'], { planRef: 'plans/a.json', outputRef: 'plans/a.json' })
  assert.deepEqual([afterPlan.stage, afterPlan.planRev, afterPlan.planRef], ['COMPILE', 1, 'plans/a.json'])
  await step(['COMPILE'], { outputHash: H1, result: { variants: [{ manifestHash: H1, gate: { decision: 'PASS' } }, { manifestHash: H2, gate: { decision: 'PASS' } }] } })
  await step(['RENDER'])
  await step(['AUTO_QC'], { result: { variants: [{ manifestHash: H1, gate: { decision: 'PASS' }, contentGate: { decision: 'PASS' }, referenceGate: { decision: 'PASS' }, publishable: true }, { manifestHash: H2, gate: { decision: 'BLOCK' }, contentGate: { decision: 'PASS' }, referenceGate: { decision: 'PASS' }, publishable: false }] } })
  await store.claimJob({ workerId: 'w', stages: ['DECISION'] })
  await store.setWaiting({ jobId: job.id, workerId: 'w', reason: 'DECISION' })
  await assert.rejects(() => store.recordDecision({ jobId: job.id, workspaceId: 'ws1', manifestHash: H2 }), (e: any) => e.code === 'QC_NOT_PASSED')
  await assert.rejects(() => store.recordDecision({ jobId: job.id, workspaceId: 'ws1', manifestHash: 'e'.repeat(64) }), (e: any) => e.code === 'UNKNOWN_MANIFEST')
  const ok = await store.recordDecision({ jobId: job.id, workspaceId: 'ws1', manifestHash: H1 })
  assert.deepEqual([ok.stage, ok.approvedManifestHash], ['FINAL', H1])
})

test('P1.5: Reference BLOCK cannot be bypassed at DECISION, even with a manual override', async () => {
  const { store, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'p15-ref-block', planRef: 'plans/1.json' })
  const H = 'f'.repeat(64)
  const step = async (stages: any[], extra: any = {}) => {
    await store.claimJob({ workerId: 'w', stages })
    const { attempt } = await store.startStageRun({ jobId: job.id, workerId: 'w' })
    return store.completeStage({ jobId: job.id, workerId: 'w', attempt, ...extra })
  }
  await step(['COMPILE'], { outputHash: H, result: { variants: [{ manifestHash: H, gate: { decision: 'PASS' } }] } })
  await step(['RENDER'])
  await step(['AUTO_QC'], { result: { variants: [{ manifestHash: H, gate: { decision: 'PASS' }, contentGate: { decision: 'PASS' }, referenceGate: { decision: 'BLOCK', checks: [{ featureId: 'caption.layout', status: 'UNKNOWN' }] }, publishable: false }] } })
  await store.claimJob({ workerId: 'w', stages: ['DECISION'] })
  await store.setWaiting({ jobId: job.id, workerId: 'w', reason: 'DECISION' })
  await assert.rejects(() => store.recordDecision({ jobId: job.id, workspaceId: 'ws1', manifestHash: H, override: { reason: 'manual' } }), (e: any) => e.code === 'QC_NOT_PASSED' && /reference conformance/.test(e.message))
})


test('QC_BLOCKED can recheck only AUTO_QC without regenerating paid stages', async () => {
  const { store, base } = await setup()
  const { job } = await store.createJob({ ...base, idempotencyKey: 'qc-recheck', planRef: 'p' })
  const step = async (stages: any[], extra: any = {}) => {
    await store.claimJob({ workerId: 'w', stages })
    const { attempt } = await store.startStageRun({ jobId: job.id, workerId: 'w' })
    return store.completeStage({ jobId: job.id, workerId: 'w', attempt, ...extra })
  }
  await step(['COMPILE']); await step(['RENDER'])
  const blocked = await step(['AUTO_QC'], { wait: 'QC_BLOCKED' })
  assert.deepEqual([blocked.status, blocked.stage, blocked.waitReason], ['WAITING_USER', 'AUTO_QC', 'QC_BLOCKED'])
  const requeued = await store.recheckQc({ jobId: job.id })
  assert.deepEqual([requeued.status, requeued.stage, requeued.waitReason], ['QUEUED', 'AUTO_QC', null])
  const runs = await store.listStageRuns(job.id)
  assert.equal(runs.filter(x => x.stage === 'RENDER' && x.status === 'SUCCEEDED').length, 1)
  assert.equal(runs.filter(x => x.stage === 'COMPILE' && x.status === 'SUCCEEDED').length, 1)
  await assert.rejects(() => store.recheckQc({ jobId: job.id }), (e:any) => e.code === 'NOT_RECHECKABLE')
})


test('Wisdom ASSET recheck requeues ASSET from a safe state, keeps paid runs, clears a stale approval', async () => {
  const { db, store, base } = await setup()
  const { job } = await store.createJob({ ...base, profile: 'wisdom', sourceAssetId: 'src_gen_w', idempotencyKey: 'asset-recheck', planRef: 'briefs/b.json' })
  const step = async (stages: any[], extra: any = {}) => {
    await store.claimJob({ workerId: 'w', stages })
    const { attempt } = await store.startStageRun({ jobId: job.id, workerId: 'w' })
    return store.completeStage({ jobId: job.id, workerId: 'w', attempt, ...extra })
  }
  await assert.rejects(() => store.recheckAsset({ jobId: job.id }), (e: any) => e.code === 'NOT_ASSET_RECHECKABLE')
  for (const s of ['PLAN', 'ASSET', 'ANALYZE', 'COMPILE', 'RENDER']) await step([s])
  const blocked = await step(['AUTO_QC'], { wait: 'QC_BLOCKED' })
  assert.deepEqual([blocked.stage, blocked.waitReason], ['AUTO_QC', 'QC_BLOCKED'])
  await db.query(`UPDATE production_jobs SET approved_manifest_hash=$2 WHERE id=$1`, [job.id, HASH])
  const requeued = await store.recheckAsset({ jobId: job.id })
  assert.deepEqual([requeued.status, requeued.stage, requeued.waitReason, requeued.approvedManifestHash], ['QUEUED', 'ASSET', null, null])
  const runs = await store.listStageRuns(job.id)
  assert.equal(runs.filter(x => x.stage === 'PLAN' && x.status === 'SUCCEEDED').length, 1)
  assert.equal(runs.filter(x => x.stage === 'ASSET' && x.status === 'SUCCEEDED').length, 1)
  await assert.rejects(() => store.recheckAsset({ jobId: job.id }), (e: any) => e.code === 'NOT_ASSET_RECHECKABLE')
  const other = (await store.createJob({ ...base, idempotencyKey: 'asset-recheck-src', planRef: 'p' })).job
  await assert.rejects(() => store.recheckAsset({ jobId: other.id }), (e: any) => e.code === 'NOT_ASSET_RECHECKABLE')
})
