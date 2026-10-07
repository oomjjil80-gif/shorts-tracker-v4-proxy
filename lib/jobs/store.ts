import { createHash, randomUUID } from 'node:crypto'
import type { Queryable, SqlDb } from './db.js'
import { firstStage, nextStage } from './pipeline.js'
import { PIPELINES } from './pipeline.js'
import { JobError, LeaseLostError, WAIT_REASONS, type Job, type JobStage, type StageRun, type StageRunKind, type WaitReason } from './types.js'

export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_LEASE_MS = 60_000

export type StoreOptions = { clock?: () => Date; maxAttempts?: number; retryBackoffMs?: (attempt: number) => number }

const iso = (d: Date) => d.toISOString()
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
const date = (v: unknown) => (v ? new Date(v as string) : null)

function mapJob(r: any): Job {
  return {
    id: r.id, workspaceId: r.workspace_id, profile: r.profile, sourceAssetId: r.source_asset_id, referenceProfileRef: r.reference_profile_ref ?? null, status: r.status, stage: r.stage,
    waitReason: r.wait_reason ?? null, idempotencyKey: r.idempotency_key, requestHash: r.request_hash,
    leaseOwner: r.lease_owner ?? null, leaseUntil: date(r.lease_until), heartbeatAt: date(r.heartbeat_at), runAfter: date(r.run_after),
    budgetUsd: num(r.budget_usd), spentUsd: num(r.spent_usd), planRev: Number(r.plan_rev), planRef: r.plan_ref ?? null,
    approvedManifestHash: r.approved_manifest_hash ?? null, cancelRequested: !!r.cancel_requested,
    createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at)
  }
}
function mapRun(r: any): StageRun {
  return {
    id: Number(r.id), jobId: r.job_id, stage: r.stage, kind: r.kind, attempt: r.attempt, status: r.status, inputHash: r.input_hash ?? null,
    outputRef: r.output_ref ?? null, outputHash: r.output_hash ?? null, provider: r.provider ?? null, model: r.model ?? null,
    usage: r.usage_json ?? null, result: r.result_json ?? null, costUsd: num(r.cost_usd), error: r.error_json ?? null,
    startedAt: date(r.started_at), finishedAt: date(r.finished_at)
  }
}

export type StageRunInput = {
  jobId: string; stage: JobStage; kind?: StageRunKind; attempt: number; status: 'STARTED' | 'SUCCEEDED' | 'FAILED'
  inputHash?: string | null; outputRef?: string | null; outputHash?: string | null; provider?: string | null; model?: string | null
  usage?: unknown; result?: unknown; costUsd?: number; error?: unknown; startedAt?: Date | null; finishedAt?: Date | null
}

async function insertRun(q: Queryable, r: StageRunInput): Promise<StageRun> {
  const res = await q.query(
    `INSERT INTO job_stage_runs (job_id, stage, kind, attempt, status, input_hash, output_ref, output_hash, provider, model, usage_json, result_json, cost_usd, error_json, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16) RETURNING *`,
    [r.jobId, r.stage, r.kind ?? 'run', r.attempt, r.status, r.inputHash ?? null, r.outputRef ?? null, r.outputHash ?? null, r.provider ?? null, r.model ?? null,
      r.usage === undefined ? null : JSON.stringify(r.usage), r.result === undefined ? null : JSON.stringify(r.result), r.costUsd ?? 0,
      r.error === undefined ? null : JSON.stringify(r.error), r.startedAt ? iso(r.startedAt) : null, r.finishedAt ? iso(r.finishedAt) : null]
  )
  return mapRun(res.rows[0])
}

export function createJobStore(db: SqlDb, options: StoreOptions = {}) {
  const clock = options.clock ?? (() => new Date())
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoff = options.retryBackoffMs ?? ((attempt: number) => Math.min(5 * 60_000, 2_000 * 2 ** (attempt - 1)))

  async function lockedJob(tx: Queryable, id: string): Promise<Job> {
    const r = await tx.query('SELECT * FROM production_jobs WHERE id = $1 FOR UPDATE', [id])
    if (!r.rows[0]) throw new JobError('NOT_FOUND', `job ${id} not found`)
    return mapJob(r.rows[0])
  }
  // Fencing: only the current, unexpired lease holder may write results.
  async function leasedJob(tx: Queryable, id: string, workerId: string, now: Date): Promise<Job> {
    const job = await lockedJob(tx, id)
    if (job.status !== 'RUNNING' || job.leaseOwner !== workerId || !job.leaseUntil || job.leaseUntil < now) throw new LeaseLostError(id)
    return job
  }
  const cleared = `lease_owner = NULL, lease_until = NULL, heartbeat_at = NULL`

  return {
    async createJob(input: {
      workspaceId: string; profile: string; sourceAssetId: string; idempotencyKey: string
      budgetUsd?: number; planRef?: string | null; referenceProfileRef?: string | null; requestFingerprint?: string
    }): Promise<{ job: Job; created: boolean }> {
      const now = clock()
      const hasPlan = !!input.planRef
      const stage = firstStage(input.profile, hasPlan)
      const requestHash = createHash('sha256').update(input.requestFingerprint ?? `${input.profile}|${input.sourceAssetId}`).digest('hex')
      const id = `job_${randomUUID()}`
      const ins = await db.query(
        `INSERT INTO production_jobs (id, workspace_id, profile, source_asset_id, reference_profile_ref, status, stage, idempotency_key, request_hash, budget_usd, plan_rev, plan_ref, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'QUEUED',$6,$7,$8,$9,$10,$11,$12,$12)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *`,
        [id, input.workspaceId, input.profile, input.sourceAssetId, input.referenceProfileRef ?? null, stage, input.idempotencyKey, requestHash, input.budgetUsd ?? 0, hasPlan ? 1 : 0, input.planRef ?? null, iso(now)]
      )
      if (ins.rows[0]) return { job: mapJob(ins.rows[0]), created: true }
      const ex = await db.query('SELECT * FROM production_jobs WHERE workspace_id = $1 AND idempotency_key = $2', [input.workspaceId, input.idempotencyKey])
      const job = mapJob(ex.rows[0])
      if (job.requestHash !== requestHash) throw new JobError('IDEMPOTENCY_KEY_REUSED', 'idempotencyKey was already used with a different request')
      return { job, created: false }
    },

    async getJob(id: string, workspaceId?: string): Promise<Job | null> {
      const r = await db.query('SELECT * FROM production_jobs WHERE id = $1' + (workspaceId ? ' AND workspace_id = $2' : ''), workspaceId ? [id, workspaceId] : [id])
      return r.rows[0] ? mapJob(r.rows[0]) : null
    },

    async listStageRuns(jobId: string): Promise<StageRun[]> {
      const r = await db.query('SELECT * FROM job_stage_runs WHERE job_id = $1 ORDER BY id', [jobId])
      return r.rows.map(mapRun)
    },

    async appendStageRun(run: StageRunInput): Promise<StageRun> { return insertRun(db, run) },

    // Latest successful run of a stage: how stages hand data to each other without extra job columns.
    async getLatestSucceeded(jobId: string, stage: JobStage): Promise<StageRun | null> {
      const r = await db.query(`SELECT * FROM job_stage_runs WHERE job_id=$1 AND stage=$2 AND status='SUCCEEDED' ORDER BY id DESC LIMIT 1`, [jobId, stage])
      return r.rows[0] ? mapRun(r.rows[0]) : null
    },

    // Atomically take the oldest runnable job for one of `stages`. A RUNNING job whose lease expired
    // (crashed worker) is runnable again. Cancel-requested jobs are never claimed; orphaned ones are closed first.
    async claimJob(input: { workerId: string; stages: readonly JobStage[]; leaseMs?: number }): Promise<Job | null> {
      const now = clock()
      const until = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS))
      await db.query(
        `UPDATE production_jobs SET status='CANCELLED', ${cleared}, updated_at=$1::timestamptz
         WHERE cancel_requested AND status IN ('QUEUED','RUNNING') AND (lease_until IS NULL OR lease_until < $1::timestamptz)`, [iso(now)])
      const r = await db.query(
        `UPDATE production_jobs SET status='RUNNING', wait_reason=NULL, lease_owner=$1, lease_until=$2::timestamptz, heartbeat_at=$3::timestamptz, updated_at=$3::timestamptz
         WHERE id = (
           SELECT id FROM production_jobs
           WHERE NOT cancel_requested AND stage = ANY($4::text[])
             AND (run_after IS NULL OR run_after <= $3::timestamptz)
             AND (status='QUEUED' OR (status='RUNNING' AND lease_until < $3::timestamptz))
           ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [input.workerId, iso(until), iso(now), [...input.stages]])
      return r.rows[0] ? mapJob(r.rows[0]) : null
    },

    // Extends the lease. { ok:false } means the lease was lost: the worker must stop and write nothing.
    async heartbeat(input: { jobId: string; workerId: string; leaseMs?: number }): Promise<{ ok: boolean; cancelRequested: boolean }> {
      const now = clock()
      const until = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS))
      const r = await db.query(
        `UPDATE production_jobs SET lease_until=$3::timestamptz, heartbeat_at=$4::timestamptz, updated_at=$4::timestamptz
         WHERE id=$1 AND lease_owner=$2 AND status='RUNNING' AND lease_until >= $4::timestamptz RETURNING cancel_requested`,
        [input.jobId, input.workerId, iso(until), iso(now)])
      return r.rows[0] ? { ok: true, cancelRequested: !!r.rows[0].cancel_requested } : { ok: false, cancelRequested: false }
    },

    // Graceful give-back (shutdown/abort): job returns to QUEUED at the same stage.
    async releaseLease(input: { jobId: string; workerId: string }): Promise<boolean> {
      const r = await db.query(
        `UPDATE production_jobs SET status='QUEUED', ${cleared}, updated_at=$3::timestamptz WHERE id=$1 AND lease_owner=$2 AND status='RUNNING'`,
        [input.jobId, input.workerId, iso(clock())])
      return r.rowCount > 0
    },

    // Opens a new attempt. Attempts orphaned by a crashed worker get a FAILED(LEASE_EXPIRED) row (append-only).
    async startStageRun(input: { jobId: string; workerId: string; kind?: StageRunKind; inputHash?: string | null; provider?: string | null; model?: string | null }): Promise<{ attempt: number; job: Job }> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await leasedJob(tx, input.jobId, input.workerId, now)
        const kind = input.kind ?? 'run'
        await tx.query(
          `INSERT INTO job_stage_runs (job_id, stage, kind, attempt, status, error_json, finished_at)
           SELECT s.job_id, s.stage, s.kind, s.attempt, 'FAILED', '{"code":"LEASE_EXPIRED"}'::jsonb, $3::timestamptz
           FROM job_stage_runs s WHERE s.job_id=$1 AND s.stage=$2 AND s.status='STARTED'
             AND NOT EXISTS (SELECT 1 FROM job_stage_runs t WHERE t.job_id=s.job_id AND t.stage=s.stage AND t.kind=s.kind AND t.attempt=s.attempt AND t.status<>'STARTED')`,
          [job.id, job.stage, iso(now)])
        const a = await tx.query('SELECT COALESCE(MAX(attempt),0)+1 AS n FROM job_stage_runs WHERE job_id=$1 AND stage=$2 AND kind=$3', [job.id, job.stage, kind])
        const attempt = Number(a.rows[0].n)
        await insertRun(tx, { jobId: job.id, stage: job.stage, kind, attempt, status: 'STARTED', inputHash: input.inputHash, provider: input.provider, model: input.model, startedAt: now })
        return { attempt, job }
      })
    },

    // Ends the current stage successfully. Cancel requests are honoured here (between stages).
    // outcome.wait keeps the job on this stage in WAITING_USER (e.g. QC_BLOCKED) instead of advancing.
    async completeStage(input: {
      jobId: string; workerId: string; attempt: number; kind?: StageRunKind; outputRef?: string | null; outputHash?: string | null
      result?: unknown; usage?: unknown; costUsd?: number; provider?: string | null; model?: string | null; wait?: WaitReason
      // PLAN stage: the plan blob the job continues from (bumps plan_rev)
      planRef?: string | null
    }): Promise<Job> {
      const now = clock()
      if (input.wait && !WAIT_REASONS.includes(input.wait)) throw new JobError('BAD_WAIT_REASON', String(input.wait))
      return db.transaction(async (tx) => {
        const job = await leasedJob(tx, input.jobId, input.workerId, now)
        await insertRun(tx, { jobId: job.id, stage: job.stage, kind: input.kind, attempt: input.attempt, status: 'SUCCEEDED', outputRef: input.outputRef, outputHash: input.outputHash,
          result: input.result, usage: input.usage, costUsd: input.costUsd, provider: input.provider, model: input.model, finishedAt: now })
        let status: string, stage: JobStage = job.stage, wait: WaitReason | null = null
        if (job.cancelRequested) status = 'CANCELLED'
        else if (input.wait) { status = 'WAITING_USER'; wait = input.wait }
        else {
          const next = nextStage(job.profile, job.stage)
          if (next) { status = 'QUEUED'; stage = next } else status = 'COMPLETE'
        }
        const r = await tx.query(
          `UPDATE production_jobs SET status=$2, stage=$3, wait_reason=$4, spent_usd=spent_usd+$5, ${cleared}, run_after=NULL, updated_at=$6::timestamptz,
             plan_ref = COALESCE($7, plan_ref), plan_rev = plan_rev + CASE WHEN $7::text IS NULL THEN 0 ELSE 1 END WHERE id=$1 RETURNING *`,
          [job.id, status, stage, wait, input.costUsd ?? 0, iso(now), input.planRef ?? null])
        return mapJob(r.rows[0])
      })
    },

    // retryable failures go back to QUEUED with backoff until maxAttempts; then FAILED.
    async failStage(input: { jobId: string; workerId: string; attempt: number; kind?: StageRunKind; error: unknown; retryable?: boolean; costUsd?: number; provider?: string | null; model?: string | null }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await leasedJob(tx, input.jobId, input.workerId, now)
        await insertRun(tx, { jobId: job.id, stage: job.stage, kind: input.kind, attempt: input.attempt, status: 'FAILED', error: input.error, costUsd: input.costUsd, provider: input.provider, model: input.model, finishedAt: now })
        const retry = !job.cancelRequested && input.retryable !== false && input.attempt < maxAttempts
        const status = job.cancelRequested ? 'CANCELLED' : retry ? 'QUEUED' : 'FAILED'
        const runAfter = retry ? iso(new Date(now.getTime() + backoff(input.attempt))) : null
        const r = await tx.query(
          `UPDATE production_jobs SET status=$2, spent_usd=spent_usd+$3, ${cleared}, run_after=$4::timestamptz, updated_at=$5::timestamptz WHERE id=$1 RETURNING *`,
          [job.id, status, input.costUsd ?? 0, runAfter, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Worker parks the job (BUDGET / PROVIDER_DOWN / QC_BLOCKED / DECISION) and gives up its lease.
    async setWaiting(input: { jobId: string; workerId: string; reason: WaitReason; stage?: JobStage }): Promise<Job> {
      const now = clock()
      if (!WAIT_REASONS.includes(input.reason)) throw new JobError('BAD_WAIT_REASON', String(input.reason))
      return db.transaction(async (tx) => {
        const job = await leasedJob(tx, input.jobId, input.workerId, now)
        const status = job.cancelRequested ? 'CANCELLED' : 'WAITING_USER'
        const r = await tx.query(
          `UPDATE production_jobs SET status=$2, wait_reason=$3, stage=$4, ${cleared}, updated_at=$5::timestamptz WHERE id=$1 RETURNING *`,
          [job.id, status, status === 'WAITING_USER' ? input.reason : null, input.stage ?? job.stage, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Re-run only COMPILE for a QC_BLOCKED job after successful paid ASSET/ANALYZE.
    // This preserves PLAN/ASSET bytes and is intentionally narrower than a general retry.
    async recheckCompile(input: { jobId: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        if (job.status !== 'WAITING_USER' || job.waitReason !== 'QC_BLOCKED' || job.stage !== 'COMPILE') throw new JobError('NOT_RECHECKABLE', `job is ${job.status}/${job.stage}/${job.waitReason}`)
        const asset = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='ASSET' AND status='SUCCEEDED' LIMIT 1`, [job.id])
        const analyzed = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='ANALYZE' AND status='SUCCEEDED' LIMIT 1`, [job.id])
        if (!asset.rows[0] || !analyzed.rows[0]) throw new JobError('PREREQUISITE_MISSING', 'COMPILE recheck requires successful ASSET and ANALYZE')
        const r = await tx.query(`UPDATE production_jobs SET status='QUEUED', wait_reason=NULL, run_after=NULL, updated_at=$2::timestamptz WHERE id=$1 RETURNING *`, [job.id, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Same-job RENDER retry for a Longform that FAILED at RENDER after PLAN and ASSET succeeded: the job goes back to
    // RENDER (QUEUED) and reuses every stored script, picture and narration — no PLAN / IMAGE / TTS call is made again,
    // and segments already rendered are reused (render-segments/<job>/...). One attempt per request.
    async retryLongformRender(input: { jobId: string; workspaceId: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        if (job.workspaceId !== input.workspaceId) throw new JobError('NOT_FOUND', 'job not found')
        if (!['wisdom_longform', 'senior_longform', 'yasa_longform'].includes(job.profile) || job.status !== 'FAILED' || job.stage !== 'RENDER') throw new JobError('NOT_RENDER_RETRYABLE', `job is ${job.profile} ${job.status}/${job.stage}`)
        for (const st of ['PLAN', 'ASSET']) {
          const ok = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage=$2 AND status='SUCCEEDED' LIMIT 1`, [job.id, st])
          if (!ok.rows[0]) throw new JobError('PREREQUISITE_MISSING', `RENDER retry requires a successful ${st}`)
        }
        const r = await tx.query(`UPDATE production_jobs SET status='QUEUED', wait_reason=NULL, run_after=NULL, updated_at=$2::timestamptz WHERE id=$1 RETURNING *`, [job.id, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Re-run RENDER for a QC-blocked Wisdom job after a renderer-only fix. Paid PLAN/ASSET/ANALYZE/COMPILE artifacts are preserved.
    async recheckRender(input: { jobId: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        const qcBlocked = job.status === 'WAITING_USER' && job.waitReason === 'QC_BLOCKED' && job.stage === 'AUTO_QC'
        const completed = job.status === 'COMPLETE' && job.stage === 'PACKAGE'
        const queuedQc = job.status === 'QUEUED' && job.stage === 'AUTO_QC'
        const awaitingDecision = job.status === 'WAITING_USER' && job.waitReason === 'DECISION' && job.stage === 'DECISION'
        // Any Shorts profile (all share the Common Screen DNA renderer). Paid stages are never re-run: RENDER re-renders the
        // existing compiled manifest from the existing source; ASSET is required only where the pipeline has one.
        const stages = PIPELINES[job.profile] || []
        if (!stages.includes('RENDER') || (!qcBlocked && !completed && !queuedQc && !awaitingDecision)) throw new JobError('NOT_RENDER_RECHECKABLE', 'job is not a safe Shorts rerender state')
        const compiled = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='COMPILE' AND status='SUCCEEDED' LIMIT 1`, [job.id])
        const asset = stages.includes('ASSET') ? await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='ASSET' AND status='SUCCEEDED' LIMIT 1`, [job.id]) : { rows: [true] }
        if (!compiled.rows[0] || !asset.rows[0]) throw new JobError('PREREQUISITE_MISSING', 'RENDER recheck requires successful COMPILE (and ASSET where the pipeline has one)')
        const r = await tx.query(`UPDATE production_jobs SET stage='RENDER', status='QUEUED', wait_reason=NULL, run_after=NULL, updated_at=$2::timestamptz WHERE id=$1 RETURNING *`, [job.id, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Re-run PLAN -> COMPILE -> RENDER -> ... for a source-first job whose plan predates the current presentation rules
    // (e.g. no headline / captions). Only for pipelines WITHOUT paid generated media: re-planning a generative job would
    // orphan its paid narration/images. The new manifests replace the old ones, so a prior approval is cleared.
    async recheckPlan(input: { jobId: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        const stages = PIPELINES[job.profile] || []
        const qcBlocked = job.status === 'WAITING_USER' && job.waitReason === 'QC_BLOCKED' && job.stage === 'AUTO_QC'
        const completed = job.status === 'COMPLETE' && job.stage === 'PACKAGE'
        const awaitingDecision = job.status === 'WAITING_USER' && job.waitReason === 'DECISION' && job.stage === 'DECISION'
        const generativeWisdom = job.profile === 'wisdom'
        const failedPlan = generativeWisdom && job.status === 'FAILED' && job.stage === 'PLAN'
        if (!stages.includes('PLAN') || (stages.includes('ASSET') && !generativeWisdom) || (!qcBlocked && !completed && !awaitingDecision && !failedPlan)) throw new JobError('NOT_PLAN_RECHECKABLE', 'job is not a safe re-plan state')
        const analyzed = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='ANALYZE' AND status='SUCCEEDED' LIMIT 1`, [job.id])
        if (!analyzed.rows[0]) throw new JobError('PREREQUISITE_MISSING', 'PLAN recheck requires a successful ANALYZE')
        const r = await tx.query(`UPDATE production_jobs SET stage='PLAN', status='QUEUED', wait_reason=NULL, approved_manifest_hash=NULL, run_after=NULL, updated_at=$2::timestamptz WHERE id=$1 RETURNING *`, [job.id, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Re-run Wisdom ASSET -> ... -> PACKAGE reusing the stored PLAN script and cached paid media (the ASSET stage itself
    // refuses any paid call except the named-thinker anchor image). The render changes, so a prior approval is cleared.
    async recheckAsset(input: { jobId: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        const qcBlocked = job.status === 'WAITING_USER' && job.waitReason === 'QC_BLOCKED' && job.stage === 'AUTO_QC'
        const completed = job.status === 'COMPLETE' && job.stage === 'PACKAGE'
        const awaitingDecision = job.status === 'WAITING_USER' && job.waitReason === 'DECISION' && job.stage === 'DECISION'
        if (job.profile !== 'wisdom' || (!qcBlocked && !completed && !awaitingDecision)) throw new JobError('NOT_ASSET_RECHECKABLE', 'job is not a safe Wisdom asset recheck state')
        const plan = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='PLAN' AND status='SUCCEEDED' LIMIT 1`, [job.id])
        const asset = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='ASSET' AND status='SUCCEEDED' LIMIT 1`, [job.id])
        if (!plan.rows[0] || !asset.rows[0]) throw new JobError('PREREQUISITE_MISSING', 'ASSET recheck requires successful PLAN and ASSET')
        const r = await tx.query(`UPDATE production_jobs SET stage='ASSET', status='QUEUED', wait_reason=NULL, approved_manifest_hash=NULL, run_after=NULL, updated_at=$2::timestamptz WHERE id=$1 RETURNING *`, [job.id, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Re-run only AUTO_QC for an already rendered QC_BLOCKED job. This preserves paid PLAN/ASSET/RENDER artifacts.
    async recheckQc(input: { jobId: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        const qcBlocked = job.status === 'WAITING_USER' && job.waitReason === 'QC_BLOCKED' && job.stage === 'AUTO_QC'
        const awaitingDecision = job.status === 'WAITING_USER' && job.waitReason === 'DECISION' && job.stage === 'DECISION'
        if (!qcBlocked && !awaitingDecision) throw new JobError('NOT_RECHECKABLE', `job is ${job.status}/${job.stage}/${job.waitReason}`)
        const rendered = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='RENDER' AND status='SUCCEEDED' LIMIT 1`, [job.id])
        if (!rendered.rows[0]) throw new JobError('RENDER_MISSING', 'QC recheck requires an existing successful render')
        const r = await tx.query(`UPDATE production_jobs SET stage='AUTO_QC', status='QUEUED', wait_reason=NULL, run_after=NULL, updated_at=$2::timestamptz WHERE id=$1 RETURNING *`, [job.id, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Guarded operator path: approve only the latest server-recommended variant when it is fully publishable.
    async approveRecommended(input: { jobId: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        const awaitingDecision = job.status === 'WAITING_USER' && job.waitReason === 'DECISION' && job.stage === 'DECISION'
        const qcBlocked = job.status === 'WAITING_USER' && job.waitReason === 'QC_BLOCKED' && job.stage === 'AUTO_QC'
        if (!awaitingDecision && !qcBlocked) throw new JobError('NOT_AWAITING_DECISION', `job is ${job.status}/${job.stage}`)
        const qc = await tx.query(`SELECT result_json FROM job_stage_runs WHERE job_id=$1 AND stage='AUTO_QC' AND status='SUCCEEDED' ORDER BY id DESC LIMIT 1`, [job.id])
        const result = qc.rows[0]?.result_json
        const recommended = String(result?.recommendedVariantId || '')
        const variants = Array.isArray(result?.variants) ? result.variants : []
        const entry = variants.find((v: any) => v?.variantId === recommended) || variants.find((v: any) => /^[0-9a-f]{64}$/.test(String(v?.manifestHash || '')))
        // Automatic recommendation may advance only a server-confirmed publishable variant.
        if (!entry || !/^[0-9a-f]{64}$/.test(String(entry.manifestHash || ''))) throw new JobError('NO_RENDERED_VARIANT', 'no rendered variant with a valid manifest')
        if (entry.publishable !== true) throw new JobError('QC_NOT_PASSED', 'recommended variant is not publishable')
        const manifestHash = String(entry.manifestHash)
        const compiled = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 AND stage='COMPILE' AND status='SUCCEEDED' AND (output_hash=$2 OR result_json->'variants' @> jsonb_build_array(jsonb_build_object('manifestHash', $2::text))) LIMIT 1`, [job.id, manifestHash])
        if (!compiled.rows[0]) throw new JobError('UNKNOWN_MANIFEST', 'recommended manifest was not produced by this job')
        const a = await tx.query(`SELECT COALESCE(MAX(attempt),0)+1 AS n FROM job_stage_runs WHERE job_id=$1 AND stage='DECISION' AND kind='run'`, [job.id])
        await insertRun(tx, { jobId: job.id, stage: 'DECISION', attempt: Number(a.rows[0].n), status: 'SUCCEEDED', outputHash: manifestHash, result: { manifestHash, override: null, selected: 'recommended-publishable' }, startedAt: now, finishedAt: now })
        const next = nextStage(job.profile, 'DECISION')!
        const r = await tx.query(`UPDATE production_jobs SET approved_manifest_hash=$2, stage=$3, status='QUEUED', wait_reason=NULL, run_after=NULL, updated_at=$4::timestamptz WHERE id=$1 RETURNING *`, [job.id, manifestHash, next, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // User/API side: continue a job parked for BUDGET or PROVIDER_DOWN (optionally with a larger budget).
    async resumeJob(input: { jobId: string; workspaceId: string; budgetUsd?: number }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        if (job.workspaceId !== input.workspaceId) throw new JobError('NOT_FOUND', 'job not found')
        if (job.status !== 'WAITING_USER' || (job.waitReason !== 'BUDGET' && job.waitReason !== 'PROVIDER_DOWN')) throw new JobError('NOT_RESUMABLE', `job is ${job.status}/${job.waitReason}`)
        const budget = input.budgetUsd ?? job.budgetUsd
        if (job.waitReason === 'BUDGET' && !(budget > job.spentUsd)) throw new JobError('BUDGET_TOO_LOW', 'budget must exceed spent amount')
        const r = await tx.query(`UPDATE production_jobs SET status='QUEUED', wait_reason=NULL, budget_usd=$2, run_after=NULL, updated_at=$3::timestamptz WHERE id=$1 RETURNING *`, [job.id, budget, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // New plan revision => COMPILE again (=> new manifestHash). Compare-and-set on plan_rev; invalidates any approval.
    async revisePlan(input: { jobId: string; workspaceId: string; expectedRev: number; planRef: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        if (job.workspaceId !== input.workspaceId) throw new JobError('NOT_FOUND', 'job not found')
        if (job.planRev !== input.expectedRev) throw new JobError('PLAN_REV_CONFLICT', `plan_rev is ${job.planRev}, expected ${input.expectedRev}`)
        if (job.status === 'RUNNING' && job.leaseUntil && job.leaseUntil >= now) throw new JobError('JOB_BUSY', 'job is running; retry later')
        if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(job.status) || job.cancelRequested) throw new JobError('JOB_CLOSED', `job is ${job.status}`)
        const r = await tx.query(
          `UPDATE production_jobs SET plan_rev=plan_rev+1, plan_ref=$2, stage='COMPILE', status='QUEUED', wait_reason=NULL, approved_manifest_hash=NULL, ${cleared}, run_after=NULL, updated_at=$3::timestamptz WHERE id=$1 RETURNING *`,
          [job.id, input.planRef, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // Idle jobs cancel immediately; a job with a live lease gets cancel_requested and is stopped by its worker.
    async requestCancel(input: { jobId: string; workspaceId: string }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        if (job.workspaceId !== input.workspaceId) throw new JobError('NOT_FOUND', 'job not found')
        if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(job.status)) return job
        const live = job.status === 'RUNNING' && !!job.leaseUntil && job.leaseUntil >= now
        const r = await tx.query(
          live
            ? `UPDATE production_jobs SET cancel_requested=true, updated_at=$2::timestamptz WHERE id=$1 RETURNING *`
            : `UPDATE production_jobs SET cancel_requested=true, status='CANCELLED', wait_reason=NULL, ${cleared}, updated_at=$2::timestamptz WHERE id=$1 RETURNING *`,
          [job.id, iso(now)])
        return mapJob(r.rows[0])
      })
    },

    // The only way past DECISION: the hash must be a manifest this job actually compiled, and its gate must
    // have passed (or the user gives an explicit override reason, which is recorded).
    async recordDecision(input: { jobId: string; workspaceId: string; manifestHash: string; override?: { reason: string } }): Promise<Job> {
      const now = clock()
      return db.transaction(async (tx) => {
        const job = await lockedJob(tx, input.jobId)
        if (job.workspaceId !== input.workspaceId) throw new JobError('NOT_FOUND', 'job not found')
        if (job.cancelRequested) throw new JobError('JOB_CLOSED', 'cancel requested')
        if (job.status !== 'WAITING_USER' || job.waitReason !== 'DECISION' || job.stage !== 'DECISION') throw new JobError('NOT_AWAITING_DECISION', `job is ${job.status}/${job.stage}`)
        // The hash must be a manifest this job compiled (single-variant P0 jobs: output_hash; P1 jobs: one of result.variants).
        const runs = await tx.query(
          `SELECT result_json FROM job_stage_runs WHERE job_id=$1 AND stage='COMPILE' AND status='SUCCEEDED'
             AND (output_hash=$2 OR result_json->'variants' @> jsonb_build_array(jsonb_build_object('manifestHash', $2::text))) ORDER BY id DESC LIMIT 1`, [job.id, input.manifestHash])
        if (!runs.rows[0]) throw new JobError('UNKNOWN_MANIFEST', 'manifestHash was not produced by this job')
        // The deciding gate is AUTO_QC's verdict for exactly this manifest when the job has one (P1), else the compile gate (P0).
        const qc = await tx.query(
          `SELECT result_json FROM job_stage_runs WHERE job_id=$1 AND stage='AUTO_QC' AND status='SUCCEEDED' ORDER BY id DESC LIMIT 1`, [job.id])
        let gatePass: boolean
        if (qc.rows[0]) {
          const entry = (qc.rows[0].result_json?.variants || []).find((v: any) => v?.manifestHash === input.manifestHash)
          // Reference conformance is a mandatory server-owned gate and is never bypassed by a manual override.
          if (entry?.referenceGate && entry.referenceGate.decision !== 'PASS') throw new JobError('QC_NOT_PASSED', 'reference conformance has not passed')
          gatePass = entry?.publishable === true
        } else gatePass = runs.rows[0].result_json?.gate?.decision === 'PASS' || (runs.rows[0].result_json?.variants || []).find((v: any) => v?.manifestHash === input.manifestHash)?.gate?.decision === 'PASS'
        const reason = String(input.override?.reason || '').trim()
        if (!gatePass && !reason) throw new JobError('QC_NOT_PASSED', 'required QC checks have not all passed; an override reason is required')
        const a = await tx.query(`SELECT COALESCE(MAX(attempt),0)+1 AS n FROM job_stage_runs WHERE job_id=$1 AND stage='DECISION' AND kind='run'`, [job.id])
        await insertRun(tx, { jobId: job.id, stage: 'DECISION', attempt: Number(a.rows[0].n), status: 'SUCCEEDED', outputHash: input.manifestHash, result: { manifestHash: input.manifestHash, override: gatePass ? null : { reason } }, startedAt: now, finishedAt: now })
        const next = nextStage(job.profile, 'DECISION')!
        const r = await tx.query(
          `UPDATE production_jobs SET approved_manifest_hash=$2, stage=$3, status='QUEUED', wait_reason=NULL, run_after=NULL, updated_at=$4::timestamptz WHERE id=$1 RETURNING *`,
          [job.id, input.manifestHash, next, iso(now)])
        return mapJob(r.rows[0])
      })
    }
  }
}

export type JobStore = ReturnType<typeof createJobStore>
