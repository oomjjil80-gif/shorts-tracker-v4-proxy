import type { JobBlobStore } from '../lib/jobs/blobs.js'
import type { Job, JobStage, StageRun, StageRunKind, WaitReason } from '../lib/jobs/types.js'

export type SourceAssetLike = { sourceAssetId: string; blobPath: string; sha256?: string | null; duration?: number | null; width?: number | null; height?: number | null }

// A local copy of the registered source video. Its bytes are verified against the Registry sha256 before use.
export type SourceFile = { path: string; cleanup: () => Promise<void> }

export type StageContext = {
  job: Job
  attempt: number
  blobs: JobBlobStore
  resolveSourceAsset: (sourceAssetId: string) => Promise<SourceAssetLike>
  resolveSourceFile: (asset: SourceAssetLike) => Promise<SourceFile>
  // Output of the latest successful run of an earlier stage (how stages hand data forward).
  previous: (stage: JobStage) => Promise<StageRun | null>
  signal: AbortSignal
  // estimated USD of every EARLIER run of this job (all stages and attempts, from their usage ledgers; unpriced = 0)
  costSoFar?: () => Promise<number>
}

export type StageResult = {
  outputRef?: string | null
  outputHash?: string | null
  result?: unknown
  usage?: unknown
  costUsd?: number
  provider?: string | null
  model?: string | null
  wait?: WaitReason
  kind?: StageRunKind
  // PLAN only: the plan blob the job continues from
  planRef?: string | null
}

export type StageExecutor = {
  stage: Job['stage']
  estimateUsd: (job: Job) => number
  inputHash: (job: Job) => string
  run: (ctx: StageContext) => Promise<StageResult>
}

// Deterministic failures (bad plan, missing source) must not be retried.
export class StageError extends Error {
  constructor(public code: string, message: string, public retryable = false, public details?: unknown) { super(message); this.name = 'StageError' }
}
