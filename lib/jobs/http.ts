import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { canonicalize } from '../tracker-core/renderManifest.js'
import { createPgDbFromEnv } from './db.js'
import { createJobStore, type JobStore } from './store.js'
import { createVercelJobBlobStore, putAddressed, type JobBlobStore } from './blobs.js'
import { PIPELINES } from './pipeline.js'
import { JobError, type Job, type StageRun } from './types.js'
import { validateReferenceProfile, stableHash } from '../reference/contracts.js'
import { analyzeRegisteredReference } from '../reference/serverPipeline.js'
import { buildReferenceProductionBrief } from '../reference/profile.js'

// HTTP adapter for Production Jobs. It is NOT a Vercel function: api/story.ts routes taskType job_* here
// (Hobby plan allows 12 functions). CORS is applied by the router. Domain logic stays in store/gate/pipeline.
// Short requests only: validate, write DB rows, return. Rendering / AI never runs inside a Vercel request.
// Workspace = sha256(X-Sync-Key), the same isolation the cloud-sync API uses.

const MAX_PLAN_BYTES = 200_000
const DEFAULT_BUDGET_USD = Number(process.env.JOB_DEFAULT_BUDGET_USD || 5)
const MAX_BUDGET_USD = 50

export type JobsDeps = {
  getStore: () => Promise<JobStore>
  blobs: JobBlobStore
  sourceExists?: (sourceAssetId: string) => Promise<boolean>
  analyzeReference?: typeof analyzeRegisteredReference
}

function workspaceOf(req: Request): string {
  const key = String(req.headers['x-sync-key'] || '').trim()
  if (key.length < 24) throw new JobError('UNAUTHORIZED', '유효한 X-Sync-Key가 필요합니다.')
  return createHash('sha256').update(key).digest('hex')
}

export const JOB_TASK_TYPES = ['job_create', 'job_get', 'job_preview', 'job_decision', 'job_cancel'] as const
export type JobTaskType = (typeof JOB_TASK_TYPES)[number]
export const isJobTaskType = (t: unknown): boolean => typeof t === 'string' && t.startsWith('job_')

const STATUS_BY_CODE: Record<string, number> = {
  METHOD_NOT_ALLOWED: 405, UNAUTHORIZED: 401, NOT_FOUND: 404, BAD_REQUEST: 400, IDEMPOTENCY_KEY_REUSED: 409, NOT_AWAITING_DECISION: 409, JOB_CLOSED: 409,
  JOB_BUSY: 409, PLAN_REV_CONFLICT: 409, UNKNOWN_MANIFEST: 422, QC_NOT_PASSED: 422, SOURCE_ASSET_NOT_FOUND: 404, JOBS_DB_NOT_CONFIGURED: 503
}

const latest = (runs: StageRun[], stage: string) => [...runs].reverse().find((r) => r.stage === stage && r.status === 'SUCCEEDED')

// What the phone needs: one progress line, the variants, and (later) the final file. No logs, no JSON.
function view(job: Job, runs: StageRun[]) {
  const compile = latest(runs, 'COMPILE')
  const qc = latest(runs, 'AUTO_QC')
  const render = latest(runs, 'RENDER')
  const plan = latest(runs, 'PLAN')
  const pkg = latest(runs, 'PACKAGE')
  const rq: any[] = (qc?.result as any)?.variants || []
  const rr: any[] = (render?.result as any)?.variants || []
  const cv: any[] = (compile?.result as any)?.variants || []
  const recommended = (qc?.result as any)?.recommendedVariantId ?? null
  const variants = (rq.length ? rq : rr.length ? rr : cv).map((v) => ({
    id: v.variantId, label: v.label, manifestHash: v.manifestHash, durationSec: v.duration ?? v.totalDuration ?? null,
    rendered: rr.some((x) => x.variantId === v.variantId), qc: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.gate?.decision ?? null) : null,
    qcReasons: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.gate?.reasons ?? []) : [],
    contentQc: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.contentGate?.decision ?? null) : null,
    contentQcReasons: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.contentGate?.reasons ?? []) : [],
    referenceQc: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.referenceGate?.decision ?? null) : null,
    referenceQcReasons: rq.length ? (rq.find((x) => x.variantId === v.variantId)?.referenceGate?.reasons ?? []) : [],
    publishable: rq.length ? rq.find((x) => x.variantId === v.variantId)?.publishable === true : false,
    recommended: v.variantId === recommended, approved: !!job.approvedManifestHash && v.manifestHash === job.approvedManifestHash
  }))
  const lastFail = [...runs].reverse().find((r) => r.status === 'FAILED')
  const stages = (PIPELINES[job.profile] || []).map((stage, i, all) => ({
    stage, state: job.status === 'COMPLETE' || all.indexOf(job.stage) > i ? 'done' : stage === job.stage ? (job.status === 'FAILED' || job.status === 'CANCELLED' ? 'stopped' : job.status === 'WAITING_USER' ? 'waiting' : 'active') : 'pending'
  }))
  return {
    id: job.id, profile: job.profile, sourceAssetId: job.sourceAssetId, status: job.status, stage: job.stage, waitReason: job.waitReason,
    budgetUsd: job.budgetUsd, spentUsd: job.spentUsd, planRev: job.planRev, approvedManifestHash: job.approvedManifestHash,
    cancelRequested: job.cancelRequested, createdAt: job.createdAt, updatedAt: job.updatedAt,
    stages, variants, planner: plan ? { provider: (plan.result as any)?.provider ?? null, semantic: (plan.result as any)?.semantic?.status ?? null, fallback: (plan.result as any)?.fallback ?? null } : null,
    manifest: compile ? { hash: compile.outputHash, ref: compile.outputRef, gate: (compile.result as any)?.gate ?? null } : null,
    final: pkg ? { packageRef: (pkg.result as any)?.packageRef ?? null, renderHash: (pkg.result as any)?.renderHash ?? null, durationSec: (pkg.result as any)?.durationSec ?? null, publishable: (pkg.result as any)?.publishable === true } : null,
    error: job.status === 'FAILED' ? (lastFail?.error as any)?.message ?? 'failed' : null,
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

export function createJobsHttp(deps: JobsDeps) {
  return async function handler(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'private, no-store')
    try {
      const workspaceId = workspaceOf(req)
      const input: any = req.method === 'GET' ? req.query || {} : req.body && typeof req.body === 'object' ? req.body : {}
      const taskType = String(input.taskType || '')
      const expectedMethod = taskType === 'job_get' || taskType === 'job_preview' ? 'GET' : 'POST'
      if (!JOB_TASK_TYPES.includes(taskType as JobTaskType)) throw new JobError('BAD_REQUEST', `unknown job taskType: ${taskType || '(none)'}`)
      if (req.method !== expectedMethod) throw new JobError('METHOD_NOT_ALLOWED', `${taskType} requires ${expectedMethod}`)

      // routing/validation errors never need the database
      const store = await deps.getStore()

      if (taskType === 'job_preview') {
        // Short-lived playback URLs for renders that belong to THIS job (paths come from its own stage results, never from the caller).
        const id = need(String(req.query?.id || ''), 'id is required')
        const job = await store.getJob(id, workspaceId)
        if (!job) throw new JobError('NOT_FOUND', 'job not found')
        const runs = await store.listStageRuns(job.id)
        const qc = latest(runs, 'AUTO_QC'), render = latest(runs, 'RENDER')
        const rows: any[] = (qc?.result as any)?.variants || (render?.result as any)?.variants || []
        const recommended = (qc?.result as any)?.recommendedVariantId ?? null
        const previews = []
        for (const v of rows) {
          if (typeof v.renderRef !== 'string' || !v.renderRef.startsWith('renders/')) continue
          const signed = await deps.blobs.presign?.(v.renderRef)
          const sheet = typeof v.posterRef === 'string' && v.posterRef.startsWith('renders/') ? await deps.blobs.presign?.(v.posterRef) : null
          if (!signed) continue
          previews.push({ variantId: v.variantId, label: v.label, durationSec: v.duration ?? null, qc: v.gate?.decision ?? null, qcReasons: v.gate?.reasons ?? [], contentQc: v.contentGate?.decision ?? null, contentQcReasons: v.contentGate?.reasons ?? [], referenceQc: v.referenceGate?.decision ?? null, referenceQcReasons: v.referenceGate?.reasons ?? [], publishable: v.publishable === true, recommended: v.variantId === recommended, approved: !!job.approvedManifestHash && v.manifestHash === job.approvedManifestHash, url: signed.url, validUntil: signed.validUntil, posterUrl: sheet?.url ?? null })
        }
        return res.status(200).json({ ok: true, jobId: job.id, status: job.status, stage: job.stage, previews })
      }

      if (taskType === 'job_get') {
        const id = need(String(req.query?.id || ''), 'id is required')
        const job = await store.getJob(id, workspaceId)
        if (!job) throw new JobError('NOT_FOUND', 'job not found')
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

      const body: any = input

      if (taskType === 'job_create') {
        const profile = String(body.profile || '')
        need(PIPELINES[profile], `unknown profile: ${profile}`)
        const sourceAssetId = matching(body.sourceAssetId, /^src_[A-Za-z0-9_]{8,120}$/, 'sourceAssetId is invalid')
        const idempotencyKey = matching(body.idempotencyKey, /^[A-Za-z0-9_.:-]{8,128}$/, 'idempotencyKey must be 8-128 chars [A-Za-z0-9_.:-]')
        const budgetUsd = body.budgetUsd === undefined ? DEFAULT_BUDGET_USD : Number(body.budgetUsd)
        need(Number.isFinite(budgetUsd) && budgetUsd >= 0 && budgetUsd <= MAX_BUDGET_USD, `budgetUsd must be 0..${MAX_BUDGET_USD}`)
        if (deps.sourceExists && !(await deps.sourceExists(sourceAssetId))) throw new JobError('SOURCE_ASSET_NOT_FOUND', 'source asset not found')

        let planRef: string | null = null
        let planHash = ''
        let referenceProfileRef: string | null = null
        let referenceProfileHash = ''
        if (body.plan !== undefined) {
          const plan = body.plan
          need(plan && typeof plan === 'object' && plan.schema === 'job-plan/1', 'plan.schema must be job-plan/1')
          need(plan.profile === profile && plan.sourceAssetId === sourceAssetId, 'plan.profile/sourceAssetId must match the job')
          need(plan.variantPlan && Array.isArray(plan.variantPlan.beats) && plan.variantPlan.beats.length > 0, 'plan.variantPlan.beats is required')
          need(canonicalize(plan).length <= MAX_PLAN_BYTES, 'plan is too large')
          const stored = await putAddressed(deps.blobs, 'plans', plan)
          planRef = stored.path; planHash = stored.sha256
        }
        need(body.referenceProfile === undefined, 'referenceProfile is server-owned; send referenceAssetIds instead')
        if (body.referenceAssetIds !== undefined) {
          need(Array.isArray(body.referenceAssetIds) && body.referenceAssetIds.length > 0 && body.referenceAssetIds.length <= 4, 'referenceAssetIds must contain 1..4 references')
          const ids=[...new Set(body.referenceAssetIds.map((x:unknown)=>matching(x,/^ref_[a-f0-9]{64}$/,'referenceAssetId is invalid')))]
          need(ids.length===body.referenceAssetIds.length,'referenceAssetIds must be unique')
          const analyses=[]
          const analyzeReference=deps.analyzeReference ?? analyzeRegisteredReference
          for(const id of ids as string[]) analyses.push((await analyzeReference(id)).analysis)
          const bundle=buildReferenceProductionBrief({profile,sourceAssetId,analyses})
          const errors=validateReferenceProfile(bundle.profile)
          need(errors.length===0,`server referenceProfile is invalid: ${errors.join(',')}`)
          const stored=await putAddressed(deps.blobs,'reference-profiles',bundle.profile)
          referenceProfileRef=stored.path
          referenceProfileHash=bundle.profileHash
          await putAddressed(deps.blobs,'production-briefs',bundle.brief)
        }
        const { job, created } = await store.createJob({ workspaceId, profile, sourceAssetId, idempotencyKey, budgetUsd, planRef, referenceProfileRef, requestFingerprint: `${profile}|${sourceAssetId}|${planHash}|${referenceProfileHash}` })
        return res.status(created ? 201 : 200).json({ ok: true, created, job: view(job, await store.listStageRuns(job.id)) })
      }

      if (taskType === 'job_decision') {
        const jobId = need(String(body.jobId || ''), 'jobId is required')
        const manifestHash = matching(body.manifestHash, /^[0-9a-f]{64}$/, 'manifestHash must be a SHA-256 hex')
        const reason = body.override ? String(body.override.reason || '') : ''
        const job = await store.recordDecision({ jobId, workspaceId, manifestHash, ...(body.override ? { override: { reason } } : {}) })
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

      if (taskType === 'job_cancel') {
        const jobId = need(String(body.jobId || ''), 'jobId is required')
        const job = await store.requestCancel({ jobId, workspaceId })
        return res.status(200).json({ ok: true, job: view(job, await store.listStageRuns(job.id)) })
      }

    } catch (e: any) {
      const code = e instanceof JobError ? e.code : 'INTERNAL'
      const status = STATUS_BY_CODE[code] ?? (e instanceof JobError ? 400 : 500)
      if (status === 500) console.error('[jobs]', e)
      return res.status(status).json({ ok: false, error: { code, message: status === 500 ? 'internal error' : String(e?.message || e) } })
    }
  }
}

let cachedStore: Promise<JobStore> | null = null
export const defaultJobsHttp = createJobsHttp({
  getStore: () => {
    if (!process.env.DATABASE_URL) return Promise.reject(new JobError('JOBS_DB_NOT_CONFIGURED', 'Production Job database (DATABASE_URL) is not configured'))
    cachedStore ??= createPgDbFromEnv().then((db) => createJobStore(db))
    cachedStore.catch(() => { cachedStore = null })
    return cachedStore
  },
  blobs: createVercelJobBlobStore(),
  sourceExists: async (id) => {
    const { getSourceAsset } = await import('../sourceAssetRegistry.js')
    try { await getSourceAsset(id); return true } catch (e: any) { if (e?.code === 'SOURCE_ASSET_NOT_FOUND') return false; throw e }
  }
})
