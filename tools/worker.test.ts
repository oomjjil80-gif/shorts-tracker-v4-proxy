import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore, putAddressed } from '../lib/jobs/blobs.js'
import { runOnce } from '../worker/runJob.js'
import { compileExecutor } from '../worker/stages/compile.js'
import { StageError, type StageExecutor } from '../worker/types.js'

const golden = JSON.parse(readFileSync(new URL('../lib/tracker-core/job-compile-golden.json', import.meta.url), 'utf8'))

async function setup(opts: { sourceAsset?: any; maxAttempts?: number } = {}) {
  const clock = { now: new Date('2026-09-29T00:00:00.000Z') }
  const db = await createTestDb()
  const store = createJobStore(db, { clock: () => clock.now, maxAttempts: opts.maxAttempts ?? 3, retryBackoffMs: () => 1000 })
  const blobs = createMemoryBlobStore()
  const sourceAsset = opts.sourceAsset ?? golden.sourceAsset
  const resolveSourceAsset = async (id: string) => { if (id !== sourceAsset.sourceAssetId) throw Object.assign(new Error('nf'), { code: 'SOURCE_ASSET_NOT_FOUND' }); return sourceAsset }
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms) }
  const submit = async (key: string, plan = golden.plan, extra: any = {}) => {
    const { path } = await putAddressed(blobs, 'plans', plan)
    return (await store.createJob({ workspaceId: 'ws', profile: 'source_shorts', sourceAssetId: plan.sourceAssetId, idempotencyKey: key, planRef: path, budgetUsd: 5, ...extra })).job
  }
  const run = (workerId = 'w1', executors: StageExecutor[] = [compileExecutor], more: any = {}) => runOnce({ store, blobs, executors, resolveSourceAsset, workerId, leaseMs: 10_000, heartbeatMs: 3_600_000, ...more })
  return { db, store, blobs, submit, run, advance }
}

test('COMPILE stage: plan -> immutable manifest blob + PASS gate -> job advances to RENDER (no executor yet, stays queued)', async () => {
  const { store, blobs, submit, run } = await setup()
  const job = await submit('idem-compile-1')
  const out = await run()
  assert.equal(out.ran && out.outcome, 'completed')
  const after = (await store.getJob(job.id))!
  assert.deepEqual([after.status, after.stage], ['QUEUED', 'RENDER'])
  const runs = await store.listStageRuns(job.id)
  const done = runs.find((r) => r.status === 'SUCCEEDED')!
  assert.equal(done.outputHash, golden.expected.manifestHash)
  assert.equal((done.result as any).gate.decision, 'PASS')
  const manifest: any = await blobs.getJson(done.outputRef!)
  assert.equal(manifest.manifestHash, golden.expected.manifestHash)
  assert.deepEqual(manifest.identity, golden.expected.identity)
  assert.ok(!JSON.stringify(manifest).includes('signed.example'))
  assert.deepEqual(await run(), { ran: false }, 'nothing left for a COMPILE-only worker')
})

test('same plan + source in two jobs -> same manifestHash and one shared manifest blob (dedupe by hash)', async () => {
  const { store, blobs, submit, run } = await setup()
  const a = await submit('idem-a-0001'), b = await submit('idem-b-0001')
  await run(); await run()
  const ha = (await store.listStageRuns(a.id)).find((r) => r.status === 'SUCCEEDED')!
  const hb = (await store.listStageRuns(b.id)).find((r) => r.status === 'SUCCEEDED')!
  assert.equal(ha.outputHash, golden.expected.manifestHash)
  assert.equal(ha.outputHash, hb.outputHash)
  assert.equal(ha.outputRef, hb.outputRef)
  assert.equal([...blobs.files.keys()].filter((k) => k.startsWith('manifests/')).length, 1)
})

test('missing sha256 in the Source Registry => required identity check FAILs => QC_BLOCKED, never PASS', async () => {
  const { store, submit, run } = await setup({ sourceAsset: { ...golden.sourceAsset, sha256: undefined } })
  const job = await submit('idem-nosha-01')
  const out = await run()
  assert.equal(out.ran && out.outcome, 'waiting')
  const after = (await store.getJob(job.id))!
  assert.deepEqual([after.status, after.stage, after.waitReason], ['WAITING_USER', 'COMPILE', 'QC_BLOCKED'])
  const gate = ((await store.listStageRuns(job.id)).find((r) => r.status === 'SUCCEEDED')!.result as any).gate
  assert.equal(gate.decision, 'BLOCK')
  assert.ok(gate.reasons.some((r: string) => r.includes('source.identity_complete')))
})

test('plan revision => new manifestHash, job recompiles from the new plan', async () => {
  const { store, blobs, submit, run } = await setup()
  const job = await submit('idem-rev-0001')
  await run()
  const h1 = (await store.listStageRuns(job.id)).find((r) => r.status === 'SUCCEEDED')!.outputHash
  const plan2 = JSON.parse(JSON.stringify(golden.plan)); plan2.variantPlan.headline = '수정된 제목'
  const { path } = await putAddressed(blobs, 'plans', plan2)
  await store.revisePlan({ jobId: job.id, workspaceId: 'ws', expectedRev: 1, planRef: path })
  await run()
  const hashes = (await store.listStageRuns(job.id)).filter((r) => r.stage === 'COMPILE' && r.status === 'SUCCEEDED').map((r) => r.outputHash)
  assert.equal(hashes.length, 2); assert.notEqual(hashes[0], hashes[1]); assert.equal(hashes[0], h1)
})

test('deterministic failures are not retried (bad plan, unknown source); transient ones are, with backoff', async () => {
  const { store, blobs, submit, run, advance } = await setup()
  const badPlan = { ...golden.plan, variantPlan: { beats: [{ trimStart: 5, trimEnd: 5 }] } }
  const j1 = await submit('idem-bad-0001', badPlan)
  const o1 = await run()
  assert.equal(o1.ran && o1.outcome, 'failed')
  assert.equal((await store.getJob(j1.id))!.status, 'FAILED')
  const flaky: StageExecutor = { stage: 'COMPILE', estimateUsd: () => 0, inputHash: () => 'x', run: async () => { throw new Error('network down') } }
  const j2 = await submit('idem-flaky-01')
  const o2 = await run('w1', [flaky])
  assert.equal(o2.ran && o2.outcome, 'retry')
  assert.equal(await store.claimJob({ workerId: 'w9', stages: ['COMPILE'] }), null, 'backoff')
  advance(1500)
  const o3 = await run('w1')
  assert.equal(o3.ran && o3.outcome, 'completed')
  assert.equal((await store.getJob(j2.id))!.stage, 'RENDER')
  void blobs
})

test('crash recovery: a worker dies mid-stage, lease expires, another worker finishes; the dead worker cannot write', async () => {
  const { store, submit, run, advance } = await setup()
  const job = await submit('idem-crash-01')
  let release!: () => void
  const hang: StageExecutor = { stage: 'COMPILE', estimateUsd: () => 0, inputHash: () => 'x', run: () => new Promise((res) => { release = () => res({ outputHash: 'f'.repeat(64) }) }) }
  const dead = run('dead-worker', [hang]) // never awaited: the process "crashed"
  await new Promise((r) => setTimeout(r, 50))
  assert.equal((await store.getJob(job.id))!.leaseOwner, 'dead-worker')
  advance(11_000)
  const out = await run('w2')
  assert.equal(out.ran && out.outcome, 'completed')
  const after = (await store.getJob(job.id))!
  assert.deepEqual([after.stage, after.status], ['RENDER', 'QUEUED'])
  release() // the zombie finishes late
  const zombie = await dead
  assert.equal(zombie.ran && zombie.outcome, 'lease_lost')
  assert.deepEqual([(await store.getJob(job.id))!.stage], ['RENDER'], 'zombie result was discarded')
  const attempts = (await store.listStageRuns(job.id)).filter((r) => r.stage === 'COMPILE')
  assert.ok(attempts.some((r) => r.attempt === 1 && r.status === 'FAILED'))
  assert.ok(attempts.some((r) => r.attempt === 2 && r.status === 'SUCCEEDED'))
})

test('heartbeat during a long stage keeps the lease; cancel is seen via heartbeat and honoured at the stage boundary', async () => {
  const { store, submit, run, advance } = await setup()
  const job = await submit('idem-hb-00001')
  let sawAbort = false
  const slow: StageExecutor = {
    stage: 'COMPILE', estimateUsd: () => 0, inputHash: () => 'x',
    run: (ctx) => new Promise((res) => {
      ctx.signal.addEventListener('abort', () => { sawAbort = true; res({ outputHash: 'f'.repeat(64) }) })
    })
  }
  const p = run('w1', [slow], { heartbeatMs: 20 })
  await new Promise((r) => setTimeout(r, 60))
  advance(5_000) // within the 10s lease, extended by beats
  await store.requestCancel({ jobId: job.id, workspaceId: 'ws' })
  const out = await p
  assert.equal(sawAbort, true)
  assert.equal(out.ran && out.outcome, 'cancelled')
  assert.equal((await store.getJob(job.id))!.status, 'CANCELLED')
})

test('budget stop: a stage that would exceed the budget parks the job in WAITING_USER/BUDGET without running', async () => {
  const { store, submit, run } = await setup()
  const job = await submit('idem-budget-1', golden.plan, { budgetUsd: 0.5 })
  let ran = false
  const paid: StageExecutor = { stage: 'COMPILE', estimateUsd: () => 1, inputHash: () => 'x', run: async () => { ran = true; return {} } }
  const out = await run('w1', [paid])
  assert.equal(out.ran && out.outcome, 'budget_wait'); assert.equal(ran, false)
  const j = (await store.getJob(job.id))!
  assert.deepEqual([j.status, j.waitReason], ['WAITING_USER', 'BUDGET'])
  assert.equal((await store.listStageRuns(job.id)).length, 0, 'no attempt was started')
  await store.resumeJob({ jobId: job.id, workspaceId: 'ws', budgetUsd: 3 })
  assert.equal((await run('w1', [paid])).ran && (await store.getJob(job.id))!.stage, 'RENDER')
})

test('StageError carries retryability', () => {
  assert.equal(new StageError('X', 'm').retryable, false)
  assert.equal(new StageError('X', 'm', true).retryable, true)
})


test('orphan recovery: RUNNING job with a null lease is reclaimable instead of staying stuck forever', async () => {
  const { db, store, submit, run } = await setup()
  const job = await submit('idem-null-lease-01')
  await db.query(`UPDATE production_jobs SET status='RUNNING', lease_owner=NULL, lease_until=NULL, heartbeat_at=NULL WHERE id=$1`, [job.id])
  const out = await run('recovery-worker')
  assert.equal(out.ran && out.outcome, 'completed')
  const after = (await store.getJob(job.id))!
  assert.deepEqual([after.status, after.stage], ['QUEUED', 'RENDER'])
})
