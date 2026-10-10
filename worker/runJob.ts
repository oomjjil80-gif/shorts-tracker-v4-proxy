import type { JobStore } from '../lib/jobs/store.js'
import type { JobBlobStore } from '../lib/jobs/blobs.js'
import { LeaseLostError, type Job } from '../lib/jobs/types.js'
import { StageError, type SourceAssetLike, type SourceFile, type StageExecutor } from './types.js'
import { summarize, summaryUsd, withUsageLedger } from '../lib/generative/usageLedger.js'

export type RunDeps = {
  store: JobStore
  blobs: JobBlobStore
  executors: StageExecutor[]
  resolveSourceAsset: (id: string) => Promise<SourceAssetLike>
  resolveSourceFile?: (asset: SourceAssetLike) => Promise<SourceFile>
  workerId: string
  leaseMs?: number
  heartbeatMs?: number
}

export type RunOutcome =
  | { ran: false }
  | { ran: true; jobId: string; stage: Job['stage']; outcome: 'completed' | 'waiting' | 'failed' | 'retry' | 'cancelled' | 'budget_wait' | 'lease_lost'; job?: Job }

// claim -> (budget check) -> start run -> execute with heartbeat -> record result / advance -> lease released.
// Exactly one stage per call; the next stage is claimed on the next call (by any worker), so a crash between
// stages loses nothing and a crash inside a stage is recovered once the lease expires.
export async function runOnce(deps: RunDeps): Promise<RunOutcome> {
  const { store, blobs, workerId } = deps
  const leaseMs = deps.leaseMs ?? 60_000
  const executors = new Map(deps.executors.map((e) => [e.stage, e]))
  const job = await store.claimJob({ workerId, stages: [...executors.keys()], leaseMs })
  if (!job) return { ran: false }
  const exec = executors.get(job.stage)!

  if (job.spentUsd + exec.estimateUsd(job) > job.budgetUsd) {
    const parked = await store.setWaiting({ jobId: job.id, workerId, reason: 'BUDGET' })
    return { ran: true, jobId: job.id, stage: job.stage, outcome: 'budget_wait', job: parked }
  }

  const abort = new AbortController()
  let leaseLost = false
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const { attempt } = await store.startStageRun({ jobId: job.id, workerId, inputHash: exec.inputHash(job) })
    timer = setInterval(() => {
      store.heartbeat({ jobId: job.id, workerId, leaseMs }).then((hb) => {
        if (!hb.ok) { leaseLost = true; abort.abort(new LeaseLostError(job.id)) }
        else if (hb.cancelRequested) abort.abort(new Error('cancel requested'))
      }).catch(() => { /* transient DB error: the next beat retries; the lease itself decides */ })
    }, deps.heartbeatMs ?? Math.max(1000, Math.floor(leaseMs / 3)))

    // every paid call of this run is counted (usage JSON of the stage run; never spent_usd, so budgets behave as before)
    const metered = withUsageLedger(`job=${job.id} stage=${job.stage} attempt=${attempt}`, () => exec.run({
        job, attempt, blobs, resolveSourceAsset: deps.resolveSourceAsset, signal: abort.signal,
        resolveSourceFile: deps.resolveSourceFile ?? (async () => { throw new StageError('NO_SOURCE_FILE_RESOLVER', 'worker has no source file resolver') }),
        previous: (stage) => store.getLatestSucceeded(job.id, stage),
        costSoFar: async () => (await store.listStageRuns(job.id)).reduce((a, r: any) => { const x = summaryUsd(r.usage?.schema === 'usage/1' ? r.usage : r.usage?.ledger); return { confirmed: a.confirmed + x.confirmed, unconfirmed: a.unconfirmed + x.unconfirmed } }, { confirmed: 0, unconfirmed: 0 })
      }))
    const spend = () => { const u = summarize(metered.ledger.calls); if (u.paidCalls) console.log(`[cost] job=${job.id} stage=${job.stage} attempt=${attempt} paidCalls=${u.paidCalls} est=${u.estUsd === null ? 'n/a' : '$' + u.estUsd}${u.unconfirmedUsd ? ` unconfirmed=~$${u.unconfirmedUsd}` : ''}${u.unpricedModels.length ? ` unpriced=${u.unpricedModels.join(',')}` : ''}`); return u }
    try {
      const res = await metered.run
      if (leaseLost) return { ran: true, jobId: job.id, stage: job.stage, outcome: 'lease_lost' }
      let done = await store.completeStage({ jobId: job.id, workerId, attempt, outputRef: res.outputRef, outputHash: res.outputHash, result: res.result, usage: res.usage !== undefined && res.usage !== null && typeof res.usage === "object" ? { ...(res.usage as object), ledger: spend() } : spend(), costUsd: res.costUsd, provider: res.provider, model: res.model, kind: res.kind, wait: res.wait, planRef: res.planRef })
      // a derived Short takes its recommended publishable variant without a second confirmation (else it waits as usual)
      if (done.status === 'WAITING_USER' && done.waitReason === 'DECISION' && (res.result as any)?.autoApprove === true) done = await store.approveRecommended({ jobId: job.id }).catch(() => done)
      return { ran: true, jobId: job.id, stage: job.stage, outcome: done.status === 'CANCELLED' ? 'cancelled' : done.status === 'WAITING_USER' ? 'waiting' : 'completed', job: done }
    } catch (e: any) {
      if (leaseLost || e instanceof LeaseLostError) { spend(); return { ran: true, jobId: job.id, stage: job.stage, outcome: 'lease_lost' } }
      const retryable = e instanceof StageError ? e.retryable : true
      const failed = await store.failStage({ jobId: job.id, workerId, attempt, retryable, usage: spend(), error: { code: e?.code || 'STAGE_FAILED', message: String(e?.message || e), details: e?.details ?? null } })
      return { ran: true, jobId: job.id, stage: job.stage, outcome: failed.status === 'CANCELLED' ? 'cancelled' : failed.status === 'FAILED' ? 'failed' : 'retry', job: failed }
    }
  } catch (e: any) {
    if (e instanceof LeaseLostError) return { ran: true, jobId: job.id, stage: job.stage, outcome: 'lease_lost' }
    await store.releaseLease({ jobId: job.id, workerId }).catch(() => {})
    throw e
  } finally {
    if (timer) clearInterval(timer)
  }
}
