import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { canonicalize } from '../lib/tracker-core/renderManifest.js'
import { createPgDbFromEnv } from '../lib/jobs/db.js'
import { createJobStore, type JobStore } from '../lib/jobs/store.js'
import { createVercelJobBlobStore, putAddressed, type JobBlobStore } from '../lib/jobs/blobs.js'
import { PIPELINES } from '../lib/jobs/pipeline.js'
import { JobError, type Job, type StageRun } from '../lib/jobs/types.js'

// Short requests only: validate, write DB rows, return. Rendering / AI never runs inside a Vercel request.
// Workspace = sha256(X-Sync-Key), the same isolation the cloud-sync API uses.

const MAX_PLAN_BYTES = 200_000
const DEFAULT_BUDGET_USD = Number(process.env.JOB_DEFAULT_BUDGET_USD || 5)
const MAX_BUDGET_USD = 50

export type JobsDeps = {
  getStore: () => Promise<JobStore>
  blobs: JobBlobStore
  sourceExists?: (sourceAssetId: string) => Promise<boolean>
}

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  const allowed =
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker-[a-z0-9-]+\.vercel\.app$/i.test(origin)
  if (allowed) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Sync-Key')
}

function workspaceOf(req: Request): string {
  const key = String(req.headers['x-sync-key'] || '').trim()
  if (key.length < 24) throw new JobError('UNAUTHORIZED', '유효한 X-Sync-Key가 필요합니다.')
  return createHash('sha256').update(key).digest('hex')
}

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401, NOT_FOUND: 404, BAD_REQUEST: 400, IDEMPOTENCY_KEY_REUSED: 409, NOT_AWAITING_DECISION: 409, JOB_CLOSED: 409,
  JOB_BUSY: 409, PLAN_REV_CONFLICT: 409, UNKNOWN_MANIFEST: 422, QC_NOT_PASSED: 422, SOURCE_ASSET_NOT_FOUND: 404, JOBS_DB_NOT_CONFIGURED: 503
}

function view(job: Job, runs: StageRun[]) {
  const compile = [...runs].reverse().find((r) => r.stage === 'COMPILE' && r.status === 'SUCCEEDED')
  return {
    id: job.id, profile: job.profile, sourceAssetId: job.sourceAssetId, status: job.status, stage: job.stage, waitReason: job.waitReason,
    budgetUsd: job.budgetUsd, spentUsd: job.spentUsd, planRev: job.planRev, approvedManifestHash: job.approvedManifestHash,
    cancelRequested: job.cancelRequested, createdAt: job.createdAt, updatedAt: job.updatedAt,
    manifest: compile ? { hash: compile.outputHash, ref: compile.outputRef, gate: (compile.result as any)?.gate ?? null } : null,
    runs: runs.map((r) => ({ stage: r.stage, kind: r.kind, attempt: r.attempt, status: r.status, error: r.error, finishedAt: r.finishedAt }))
  }
}

function matching(value: unknown, re: RegExp, message: string): string {
  const v = String(value ?? '')
  if (!re.test(v)) throw new JobError('BAD_REQUEST', message)
  return v
}

function need<T>(cond: T, message: string): NonNullable<T> {
  if (!cond) throw new JobError('BAD_REQUEST', message)
  return cond as NonNullable<T>
}

export function createJobsHandler(deps: JobsDeps) {
  return async function handler(req: Request, res: Response) {
    setCors(req, res)
    if (req.method === 'OPTIONS') return res.status(204).end()
    try {
      if (req.method !== 'GET' && req.method !== 'POST') throw new JobError('BAD_REQUEST', 'Method not allowed')
      const workspaceId = workspaceOf(req)
      const store = await deps.getStore()

      if (req.method === 'GET') {
        const id = need(String(req.query?.id || ''), 'id is required')
        const job = await store.getJob(id, workspaceId)
        if (!job) throw new JobError('NOT_FOUND', 'job not found')
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

      const body: any = req.body && typeof req.body === 'object' ? req.body : {}
      const action = String(body.action || '')

      if (action === 'create') {
        const profile = String(body.profile || '')
        need(PIPELINES[profile], `unknown profile: ${profile}`)
        const sourceAssetId = matching(body.sourceAssetId, /^src_[A-Za-z0-9_]{8,120}$/, 'sourceAssetId is invalid')
        const idempotencyKey = matching(body.idempotencyKey, /^[A-Za-z0-9_.:-]{8,128}$/, 'idempotencyKey must be 8-128 chars [A-Za-z0-9_.:-]')
        const budgetUsd = body.budgetUsd === undefined ? DEFAULT_BUDGET_USD : Number(body.budgetUsd)
        need(Number.isFinite(budgetUsd) && budgetUsd >= 0 && budgetUsd <= MAX_BUDGET_USD, `budgetUsd must be 0..${MAX_BUDGET_USD}`)
        if (deps.sourceExists && !(await deps.sourceExists(sourceAssetId))) throw new JobError('SOURCE_ASSET_NOT_FOUND', 'source asset not found')

        let planRef: string | null = null
        let planHash = ''
        if (body.plan !== undefined) {
          const plan = body.plan
          need(plan && typeof plan === 'object' && plan.schema === 'job-plan/1', 'plan.schema must be job-plan/1')
          need(plan.profile === profile && plan.sourceAssetId === sourceAssetId, 'plan.profile/sourceAssetId must match the job')
          need(plan.variantPlan && Array.isArray(plan.variantPlan.beats) && plan.variantPlan.beats.length > 0, 'plan.variantPlan.beats is required')
          need(canonicalize(plan).length <= MAX_PLAN_BYTES, 'plan is too large')
          const stored = await putAddressed(deps.blobs, 'plans', plan)
          planRef = stored.path; planHash = stored.sha256
        }
        const { job, created } = await store.createJob({ workspaceId, profile, sourceAssetId, idempotencyKey, budgetUsd, planRef, requestFingerprint: `${profile}|${sourceAssetId}|${planHash}` })
        return res.status(created ? 201 : 200).json({ ok: true, created, job: view(job, await store.listStageRuns(job.id)) })
      }

      if (action === 'decision') {
        const jobId = need(String(body.jobId || ''), 'jobId is required')
        const manifestHash = matching(body.manifestHash, /^[0-9a-f]{64}$/, 'manifestHash must be a SHA-256 hex')
        const reason = body.override ? String(body.override.reason || '') : ''
        const job = await store.recordDecision({ jobId, workspaceId, manifestHash, ...(body.override ? { override: { reason } } : {}) })
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

      if (action === 'cancel') {
        const jobId = need(String(body.jobId || ''), 'jobId is required')
        const job = await store.requestCancel({ jobId, workspaceId })
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

      throw new JobError('BAD_REQUEST', `unknown action: ${action || '(none)'}`)
    } catch (e: any) {
      const code = e instanceof JobError ? e.code : 'INTERNAL'
      const status = STATUS_BY_CODE[code] ?? (e instanceof JobError ? 400 : 500)
      if (status === 500) console.error('[jobs]', e)
      return res.status(status).json({ ok: false, error: { code, message: status === 500 ? 'internal error' : String(e?.message || e) } })
    }
  }
}

let cachedStore: Promise<JobStore> | null = null
const defaultHandler = createJobsHandler({
  getStore: () => {
    if (!process.env.DATABASE_URL) return Promise.reject(new JobError('JOBS_DB_NOT_CONFIGURED', 'Production Job database (DATABASE_URL) is not configured'))
    cachedStore ??= createPgDbFromEnv().then((db) => createJobStore(db))
    cachedStore.catch(() => { cachedStore = null })
    return cachedStore
  },
  blobs: createVercelJobBlobStore(),
  sourceExists: async (id) => {
    const { getSourceAsset } = await import('../lib/sourceAssetRegistry.js')
    try { await getSourceAsset(id); return true } catch (e: any) { if (e?.code === 'SOURCE_ASSET_NOT_FOUND') return false; throw e }
  }
})

export default defaultHandler
