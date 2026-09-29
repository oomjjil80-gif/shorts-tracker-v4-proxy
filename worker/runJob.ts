import type { JobStore } from '../lib/jobs/store.js'
import type { JobBlobStore } from '../lib/jobs/blobs.js'
import { LeaseLostError, type Job } from '../lib/jobs/types.js'
import { StageError, type SourceAssetLike, type StageExecutor } from './types.js'

export type RunDeps = {
  store: JobStore
  blobs: JobBlobStore
  executors: StageExecutor[]
  resolveSourceAsset: (id: string) => Promise<SourceAssetLike>
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

    try {
      const res = await exec.run({ job, attempt, blobs, resolveSourceAsset: deps.resolveSourceAsset, signal: abort.signal })
      if (leaseLost) return { ran: true, jobId: job.id, stage: job.stage, outcome: 'lease_lost' }
      const done = await store.completeStage({ jobId: job.id, workerId, attempt, outputRef: res.outputRef, outputHash: res.outputHash, result: res.result, usage: res.usage, costUsd: res.costUsd, provider: res.provider, model: res.model, kind: res.kind, wait: res.wait })
      return { ran: true, jobId: job.id, stage: job.stage, outcome: done.status === 'CANCELLED' ? 'cancelled' : done.status === 'WAITING_USER' ? 'waiting' : 'completed', job: done }
    } catch (e: any) {
      if (leaseLost || e instanceof LeaseLostError) return { ran: true, jobId: job.id, stage: job.stage, outcome: 'lease_lost' }
      const retryable = e instanceof StageError ? e.retryable : true
      const failed = await store.failStage({ jobId: job.id, workerId, attempt, retryable, error: { code: e?.code || 'STAGE_FAILED', message: String(e?.message || e), details: e?.details ?? null } })
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
