export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'WAITING_USER', 'COMPLETE', 'FAILED', 'CANCELLED'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const JOB_STAGES = ['ANALYZE', 'PLAN', 'ASSET', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE'] as const
export type JobStage = (typeof JOB_STAGES)[number]

export const WAIT_REASONS = ['DECISION', 'BUDGET', 'QC_BLOCKED', 'PROVIDER_DOWN'] as const
export type WaitReason = (typeof WAIT_REASONS)[number]

// REPAIR is not a status: it is a kind of stage run.
export type StageRunKind = 'run' | 'repair'
export type StageRunStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED'

export type Job = {
  id: string
  workspaceId: string
  profile: string
  sourceAssetId: string
  referenceProfileRef: string | null
  status: JobStatus
  stage: JobStage
  waitReason: WaitReason | null
  idempotencyKey: string
  requestHash: string
  leaseOwner: string | null
  leaseUntil: Date | null
  heartbeatAt: Date | null
  runAfter: Date | null
  budgetUsd: number
  spentUsd: number
  planRev: number
  planRef: string | null
  approvedManifestHash: string | null
  cancelRequested: boolean
  createdAt: Date
  updatedAt: Date
}

export type StageRun = {
  id: number
  jobId: string
  stage: JobStage
  kind: StageRunKind
  attempt: number
  status: StageRunStatus
  inputHash: string | null
  outputRef: string | null
  outputHash: string | null
  provider: string | null
  model: string | null
  usage: unknown
  result: unknown
  costUsd: number
  error: unknown
  startedAt: Date | null
  finishedAt: Date | null
}

export class JobError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'JobError' }
}
export class LeaseLostError extends JobError {
  constructor(jobId: string) { super('LEASE_LOST', `lease for job ${jobId} is no longer held`) }
}
