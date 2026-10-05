import type { JobStage } from '../../lib/jobs/types.js'
import type { StageContext, StageExecutor, StageResult } from '../types.js'

// The minimal module contract: an id, what it needs from earlier stages, what it hands on, and run(context).
// inputHash/estimateUsd are the existing executor's own (the worker's run/retry/budget logic is unchanged).
export type PipelineModule = {
  id: string
  stage: JobStage
  requires: readonly string[]
  produces: readonly string[]
  run: (ctx: StageContext) => Promise<StageResult>
  inputHash: StageExecutor['inputHash']
  estimateUsd: StageExecutor['estimateUsd']
}

// Adapter: an existing stage executor, unchanged, under a module id.
export const adapt = (id: string, requires: readonly string[], produces: readonly string[], exec: StageExecutor): PipelineModule => ({
  id, stage: exec.stage, requires, produces,
  run: (ctx) => exec.run(ctx), inputHash: (job) => exec.inputHash(job), estimateUsd: (job) => exec.estimateUsd(job)
})
