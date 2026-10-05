import type { JobStage } from '../../lib/jobs/types.js'
import type { FeatureId } from '../../lib/jobs/profiles.js'
import type { StageContext, StageExecutor, StageResult } from '../types.js'

// The minimal module contract: an id, what it needs from earlier stages, what it hands on, and run(context).
// inputHash/estimateUsd are the existing executor's own (the worker's run/retry/budget logic is unchanged).
export type PipelineModule = {
  id: string
  stage: JobStage
  requires: readonly string[]
  produces: readonly string[]
  // features this module cannot work without (checked against the Profile before anything runs)
  needs: readonly FeatureId[]
  run: (ctx: StageContext) => Promise<StageResult>
  inputHash: StageExecutor['inputHash']
  estimateUsd: StageExecutor['estimateUsd']
}

// Adapter: an existing stage executor, unchanged, under a module id.
export const adapt = (id: string, requires: readonly string[], produces: readonly string[], exec: StageExecutor, needs: readonly FeatureId[] = []): PipelineModule => ({
  id, stage: exec.stage, requires, produces, needs,
  run: (ctx) => exec.run(ctx), inputHash: (job) => exec.inputHash(job), estimateUsd: (job) => exec.estimateUsd(job)
})
