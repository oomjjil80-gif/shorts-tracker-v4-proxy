import type { JobBlobStore } from '../lib/jobs/blobs.js'
import type { Job, StageRunKind, WaitReason } from '../lib/jobs/types.js'

export type SourceAssetLike = { sourceAssetId: string; blobPath: string; sha256?: string | null; duration?: number | null; width?: number | null; height?: number | null }

export type StageContext = {
  job: Job
  attempt: number
  blobs: JobBlobStore
  resolveSourceAsset: (sourceAssetId: string) => Promise<SourceAssetLike>
  signal: AbortSignal
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
