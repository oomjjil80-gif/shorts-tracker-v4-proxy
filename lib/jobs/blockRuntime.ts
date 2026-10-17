// The gate the worker consults before it runs a stage (worker/runJob.ts). A job without a saved recipe (every job that existed
// before the block engine) is never gated: PASS. A recipe-bound job may not start a block until every earlier approval is
// recorded for the CURRENT result, and a block whose inputs were already done is reused instead of paid for again.
import type { BlockStore } from './blockStore.js'
import { blockInputHash, toProgress } from './blockStore.js'
import { canExecuteBlock, type BlockId } from './recipe.js'
import { nextBlockDecision } from './blockScheduler.js'
import type { Job, JobStage } from './types.js'

export type GateDecision =
  | { kind: 'PASS' }
  | { kind: 'RUN'; block: BlockId; inputHash: string }
  | { kind: 'REUSE'; block: BlockId; inputHash: string; outputRef: string | null; outputHash: string | null; result: unknown; planRef: string | null }
  | { kind: 'WAIT'; block: BlockId }
  | { kind: 'INVALID'; reason: string }

export type LatestRun = { inputHash: string | null; outputRef: string | null; outputHash: string | null; result: unknown } | null
// what a block keeps of its stage run, enough to record that stage again without running it
const keep = (result: unknown, planRef: string | null | undefined) => ({ r: result ?? null, planRef: planRef ?? null })
export type BlockGate = {
  before(job: Job, execInputHash: string): Promise<GateDecision>
  after(job: Job, d: Extract<GateDecision, { kind: 'RUN' }>, res: { outputRef?: string | null; outputHash?: string | null; result?: unknown; planRef?: string | null }): Promise<void>
}

export function createBlockGate(blocks: BlockStore, latestRun: (jobId: string, stage: JobStage) => Promise<LatestRun>): BlockGate {
  return {
    async before(job, execInputHash) {
      const b = await blocks.bindingOf(job.id)
      if (!b || !b.enforced) return { kind: 'PASS' }
      const block = b.stageBlocks[job.stage]
      if (!block) return { kind: 'PASS' }
      // Self-heal: a stage that finished while the engine could not record it (crash between the two writes, a job bound after
      // its first stage had started) is recorded now from the stored stage run — never by running it again.
      for (const [stage, earlier] of Object.entries(b.stageBlocks) as [JobStage, BlockId][]) {
        if (stage === job.stage) continue
        const have = (await blocks.rows(job.id)).find((r) => r.block === earlier)
        if (have && (have.status === 'SUCCEEDED' || have.status === 'APPROVED')) continue
        const run = await latestRun(job.id, stage)
        if (!run) continue
        const rows = await blocks.rows(job.id)
        const input = blockInputHash(b, rows, earlier, run.inputHash ?? '')
        const started = await blocks.begin(job.id, earlier, input)
        if (started.action === 'RUN') await blocks.complete(job.id, earlier, { inputHash: input, outputRef: run.outputRef, outputHash: run.outputHash, result: keep(run.result, (run.result as any)?.planRef) })
      }
      const rows = await blocks.rows(job.id)
      const progress = toProgress(b, rows)
      if (!canExecuteBlock(b.recipe, progress, block)) {
        const d = nextBlockDecision(b.recipe, progress)
        // Waiting for the user is the only reason a paid block may be held; anything else is a wiring fault, not a retry.
        if (d.state === 'WAITING_APPROVAL') return { kind: 'WAIT', block: d.block }
        return { kind: 'INVALID', reason: `block ${block} is not executable (${d.state})` }
      }
      const inputHash = blockInputHash(b, rows, block, execInputHash)
      const began = await blocks.begin(job.id, block, inputHash)
      if (began.action === 'REUSE') return { kind: 'REUSE', block, inputHash, outputRef: began.row.outputRef, outputHash: began.row.outputHash, result: (began.row.result as any)?.r ?? null, planRef: (began.row.result as any)?.planRef ?? null }
      return { kind: 'RUN', block, inputHash }
    },
    async after(job, d, res) {
      await blocks.complete(job.id, d.block, { inputHash: d.inputHash, outputRef: res.outputRef ?? null, outputHash: res.outputHash ?? null, result: keep(res.result, res.planRef) })
    }
  }
}
