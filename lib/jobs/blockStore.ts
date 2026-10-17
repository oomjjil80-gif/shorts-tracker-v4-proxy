// Server-side state of the block engine: the Recipe a job runs under and each block's progress and approval.
// All transitions are single transactions on the job row's lock, so a double click, a retry or two workers can never run or
// approve the same block twice. Nothing here calls a paid API.
import { createHash } from 'node:crypto'
import type { Queryable, SqlDb } from './db.js'
import { BLOCKS, type BlockId, type BlockProgress, type ContentRecipe } from './recipe.js'
import { nextBlockDecision } from './blockScheduler.js'
import { JobError, type JobStage } from './types.js'
import { recipeFor, recipeSnapshot, type RecipeBinding } from './recipes.js'

export type BlockRow = {
  block: BlockId
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'APPROVED'
  inputHash: string | null
  artifactHash: string | null
  outputRef: string | null
  outputHash: string | null
  result: unknown
  approvedHash: string | null
}
export type BoundRecipe = { recipeId: string; recipe: ContentRecipe; stageBlocks: Partial<Record<JobStage, BlockId>>; enforced: boolean }

export const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const mapRow = (r: any): BlockRow => ({ block: r.block, status: r.status, inputHash: r.input_hash, artifactHash: r.artifact_hash, outputRef: r.output_ref, outputHash: r.output_hash, result: r.result, approvedHash: r.approved_hash })
const isGate = (b: BoundRecipe, block: BlockId) => !!BLOCKS[block].approval && !Object.values(b.stageBlocks).includes(block)
const activeSteps = (r: ContentRecipe) => r.steps.filter((s) => s.skipReason === undefined).map((s) => s.block)

// A gate counts as APPROVED only while the approval is for the artifact the gate currently holds.
export function toProgress(b: BoundRecipe, rows: readonly BlockRow[]): BlockProgress[] {
  return rows.filter((r) => activeSteps(b.recipe).includes(r.block)).flatMap((r) => {
    if (r.status === 'PENDING') return []
    const valid = r.status === 'APPROVED' && r.approvedHash !== null && r.approvedHash === r.artifactHash
    const status = r.status === 'APPROVED' && !valid ? 'SUCCEEDED' : r.status
    return [{ block: r.block, status, inputHash: r.inputHash ?? undefined, artifactRef: r.outputRef ?? undefined } as BlockProgress]
  })
}

// What a block's result depends on: its stage executor's own input hash + everything upstream that was produced/approved.
export function blockInputHash(b: BoundRecipe, rows: readonly BlockRow[], block: BlockId, execInputHash: string): string {
  const upstream: string[] = []
  for (const step of b.recipe.steps) {
    if (step.block === block) break
    if (step.skipReason !== undefined) continue
    const row = rows.find((r) => r.block === step.block)
    upstream.push(`${step.block}:${row?.artifactHash ?? ''}:${row?.approvedHash ?? ''}`)
  }
  return sha(`${block}|${execInputHash}|${upstream.join(',')}`)
}

// `lookup` resolves a recipe id to its binding (the registry by default; tests and new content types pass their own)
export function createBlockStore(db: SqlDb, clock: () => Date = () => new Date(), lookup: (id: string) => RecipeBinding | null = recipeFor) {
  const iso = (d: Date) => d.toISOString()
  const bindingOf = async (q: Queryable, jobId: string): Promise<BoundRecipe | null> => {
    const r = await q.query('SELECT recipe_id, recipe, stage_blocks FROM job_recipes WHERE job_id=$1', [jobId])
    const row = r.rows[0]
    if (!row) return null
    return { recipeId: row.recipe_id, recipe: row.recipe, stageBlocks: row.stage_blocks, enforced: lookup(row.recipe_id)?.enforced ?? true }
  }
  const rowsOf = async (q: Queryable, jobId: string): Promise<BlockRow[]> =>
    (await q.query('SELECT * FROM job_blocks WHERE job_id=$1', [jobId])).rows.map(mapRow)
  const lockJob = async (tx: Queryable, jobId: string, workspaceId?: string) => {
    const r = await tx.query('SELECT id, workspace_id, status, wait_reason, stage, profile, cancel_requested FROM production_jobs WHERE id=$1 FOR UPDATE', [jobId])
    const job = r.rows[0]
    if (!job || (workspaceId !== undefined && job.workspace_id !== workspaceId)) throw new JobError('NOT_FOUND', 'job not found')
    return job
  }
  const upsert = async (tx: Queryable, jobId: string, block: BlockId, f: Partial<Record<string, unknown>>) => {
    const cols = Object.keys(f)
    await tx.query(
      `INSERT INTO job_blocks (job_id, block, status, updated_at${cols.filter((c) => c !== 'status').map((c) => `, ${c}`).join('')})
       VALUES ($1,$2,$3,$4${cols.filter((c) => c !== 'status').map((_, i) => `, $${i + 5}`).join('')})
       ON CONFLICT (job_id, block) DO UPDATE SET status=EXCLUDED.status, updated_at=EXCLUDED.updated_at${cols.filter((c) => c !== 'status').map((c) => `, ${c}=EXCLUDED.${c}`).join('')}`,
      [jobId, block, f.status, iso(clock()), ...cols.filter((c) => c !== 'status').map((c) => (c === 'result' && f[c] !== null ? JSON.stringify(f[c]) : f[c]))])
  }

  // After a block finishes (or an approval is recorded), every gate whose earlier work is complete becomes ready for approval.
  // A gate whose artifact changed loses its approval; one whose artifact is identical to what was approved before stays approved.
  async function readyGates(tx: Queryable, jobId: string, b: BoundRecipe): Promise<void> {
    const rows = await rowsOf(tx, jobId)
    const prior: string[] = []
    let open = true
    for (const step of b.recipe.steps) {
      if (step.skipReason !== undefined) continue
      const row = rows.find((r) => r.block === step.block)
      if (!isGate(b, step.block)) {
        if (!row || (row.status !== 'SUCCEEDED' && row.status !== 'APPROVED')) open = false
        if (open) prior.push(`${step.block}:${row!.artifactHash}`)
        continue
      }
      if (!open) break
      const artifactHash = sha(prior.join(','))
      if (row && row.artifactHash === artifactHash && (row.status === 'SUCCEEDED' || (row.status === 'APPROVED' && row.approvedHash === artifactHash))) { prior.push(`${step.block}:${artifactHash}`); if (row.status !== 'APPROVED') open = false; continue }
      const keep = row?.approvedHash === artifactHash
      await upsert(tx, jobId, step.block, { status: keep ? 'APPROVED' : 'SUCCEEDED', artifact_hash: artifactHash, approved_hash: keep ? artifactHash : null })
      prior.push(`${step.block}:${artifactHash}`)
      if (!keep) open = false
    }
  }

  return {
    bindingOf: (jobId: string) => bindingOf(db, jobId),
    rows: (jobId: string) => rowsOf(db, jobId),

    // Save the recipe snapshot of a job that has NOT started (normally createJob does this atomically; this is for tests and tools).
    // A job whose stages already ran can never be bound afterwards: that would be a fail-open gate.
    async bind(jobId: string, profile: string, recipeId: string): Promise<{ recipeId: string; created: boolean }> {
      let snap
      try { snap = recipeSnapshot(recipeId, profile, lookup) } catch (e: any) { throw new JobError('BAD_REQUEST', String(e?.message || e)) }
      return db.transaction(async (tx) => {
        await lockJob(tx, jobId)
        const have = await bindingOf(tx, jobId)
        if (have) { if (have.recipeId !== recipeId) throw new JobError('IDEMPOTENCY_KEY_REUSED', `job already runs under recipe ${have.recipeId}`); return { recipeId, created: false } }
        const ran = await tx.query(`SELECT 1 FROM job_stage_runs WHERE job_id=$1 LIMIT 1`, [jobId])
        if (ran.rows[0]) throw new JobError('JOB_ALREADY_STARTED', 'a recipe cannot be added to a job whose stages have already run')
        await tx.query(`INSERT INTO job_recipes (job_id, recipe_id, recipe, stage_blocks, recipe_hash) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)`, [jobId, snap.recipeId, snap.recipeJson, snap.stageBlocksJson, snap.hash])
        return { recipeId, created: true }
      })
    },

    // Called by the worker right before a bound stage would run. RUN = go ahead and pay; REUSE = identical inputs were done
    // before, use the stored result; anything else never reaches a paid call.
    async begin(jobId: string, block: BlockId, inputHash: string): Promise<{ action: 'RUN' } | { action: 'REUSE'; row: BlockRow }> {
      return db.transaction(async (tx) => {
        await lockJob(tx, jobId)
        const b = (await bindingOf(tx, jobId))!
        const row = (await rowsOf(tx, jobId)).find((r) => r.block === block)
        if (row && row.inputHash === inputHash && row.outputRef !== null && (row.status === 'SUCCEEDED' || row.status === 'APPROVED' || row.status === 'PENDING')) {
          if (row.status === 'PENDING') { await upsert(tx, jobId, block, { status: 'SUCCEEDED' }); await readyGates(tx, jobId, b) }
          return { action: 'REUSE', row: { ...row, status: row.status === 'PENDING' ? 'SUCCEEDED' : row.status } }
        }
        if (row && (row.status === 'SUCCEEDED' || row.status === 'APPROVED')) await this_invalidateAfter(tx, jobId, b, block) // inputs changed
        await upsert(tx, jobId, block, { status: 'RUNNING', input_hash: inputHash, artifact_hash: null, output_ref: null, output_hash: null, result: null, approved_hash: null })
        return { action: 'RUN' }
      })
    },

    // The block's stage finished: record its result and open the approval gates that follow.
    async complete(jobId: string, block: BlockId, rec: { inputHash: string; outputRef: string | null; outputHash: string | null; result: unknown }): Promise<void> {
      await db.transaction(async (tx) => {
        await lockJob(tx, jobId)
        const b = (await bindingOf(tx, jobId))!
        const row = (await rowsOf(tx, jobId)).find((r) => r.block === block)
        if (!row || row.status !== 'RUNNING' || row.inputHash !== rec.inputHash) return // a stale completion never overwrites newer work
        await upsert(tx, jobId, block, { status: 'SUCCEEDED', output_ref: rec.outputRef, output_hash: rec.outputHash, artifact_hash: rec.outputHash ?? sha(JSON.stringify(rec.result ?? null)), result: rec.result ?? null })
        await readyGates(tx, jobId, b)
      })
    },

    // The user approves one gate for exactly the artifact they saw. Idempotent; a stale artifact is refused.
    async approve(jobId: string, workspaceId: string, block: BlockId, artifactHash: string): Promise<{ already: boolean; requeued: boolean }> {
      return db.transaction(async (tx) => {
        const job = await lockJob(tx, jobId, workspaceId)
        const b = await bindingOf(tx, jobId)
        if (!b || !b.enforced || !activeSteps(b.recipe).includes(block) || !isGate(b, block)) throw new JobError('BAD_REQUEST', `${block} is not an approval step of this job`)
        if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(job.status) || job.cancel_requested) throw new JobError('JOB_CLOSED', `job is ${job.status}`)
        const row = (await rowsOf(tx, jobId)).find((r) => r.block === block)
        if (row?.status === 'APPROVED' && row.approvedHash === artifactHash && row.artifactHash === artifactHash) return { already: true, requeued: false }
        if (!row || row.status !== 'SUCCEEDED') throw new JobError('NOT_AWAITING_APPROVAL', `${block} is not waiting for approval`)
        if (row.artifactHash !== artifactHash) throw new JobError('STALE_APPROVAL', `the result changed after you looked at it; review the current ${block} again`)
        await upsert(tx, jobId, block, { status: 'APPROVED', approved_hash: artifactHash })
        await readyGates(tx, jobId, b)
        const rows = await rowsOf(tx, jobId)
        const decision = nextBlockDecision(b.recipe, toProgress(b, rows))
        let requeued = false
        if (job.status === 'WAITING_USER' && job.wait_reason === 'BLOCK_APPROVAL' && decision.state !== 'WAITING_APPROVAL') {
          await tx.query(`UPDATE production_jobs SET status='QUEUED', wait_reason=NULL, run_after=NULL, updated_at=$2::timestamptz WHERE id=$1`, [jobId, iso(clock())])
          requeued = true
        }
        return { already: false, requeued }
      })
    },

    // The user changes a block: it and everything after it is invalidated (results kept for reuse when the inputs turn out
    // identical); blocks before it, and their approvals, are untouched. The job goes back to that block's stage.
    async edit(jobId: string, workspaceId: string, block: BlockId): Promise<{ stage: JobStage; invalidated: BlockId[] }> {
      return db.transaction(async (tx) => {
        const job = await lockJob(tx, jobId, workspaceId)
        const b = await bindingOf(tx, jobId)
        const stage = b && (Object.entries(b.stageBlocks).find(([, v]) => v === block)?.[0] as JobStage | undefined)
        if (!b || !b.enforced || !stage) throw new JobError('BAD_REQUEST', `${block} cannot be edited in this job`)
        if (job.status !== 'WAITING_USER' || job.wait_reason !== 'BLOCK_APPROVAL') throw new JobError('NOT_EDITABLE', `job is ${job.status}/${job.wait_reason}`)
        const invalidated = await this_invalidateAfter(tx, jobId, b, block, true)
        // An explicit user edit must re-run the selected stage even when its upstream input is unchanged.
        // Keep its prior output for audit; downstream stages may still reuse matching results.
        await tx.query(`UPDATE job_blocks SET input_hash=NULL, updated_at=now() WHERE job_id=$1 AND block=$2`, [jobId, block])
        await tx.query(`UPDATE production_jobs SET stage=$2, status='QUEUED', wait_reason=NULL, run_after=NULL, updated_at=$3::timestamptz WHERE id=$1`, [jobId, stage, iso(clock())])
        return { stage, invalidated }
      })
    }
  }
}

// block (optional) + every later active block go back to PENDING; results/approvals stay on the row for reuse.
async function this_invalidateAfter(tx: Queryable, jobId: string, b: BoundRecipe, block: BlockId, includeSelf = false): Promise<BlockId[]> {
  const order = b.recipe.steps.filter((s) => s.skipReason === undefined).map((s) => s.block)
  const from = order.indexOf(block)
  const hit = order.slice(includeSelf ? from : from + 1)
  if (hit.length) await tx.query(`UPDATE job_blocks SET status='PENDING', updated_at=now() WHERE job_id=$1 AND block = ANY($2::text[]) AND status IN ('SUCCEEDED','APPROVED','RUNNING')`, [jobId, hit])
  return hit
}

export type BlockStore = ReturnType<typeof createBlockStore>
