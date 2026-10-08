import type { JobStore } from '../lib/jobs/store.js'

// Operator startup hooks that move a job back to an earlier stage, deepest first: PLAN_RECHECK_JOB_ID (source-first
// re-plan) and ASSET_RECHECK_JOB_ID (generative asset rerun) re-render anyway. A stale RENDER/COMPILE/QC hook left on the same job would otherwise
// move it to QUEUED/RENDER first, after which the ASSET recheck is refused (NOT_ASSET_RECHECKABLE). Once ASSET is queued,
// every other hook naming the same job is skipped as superseded instead of pulling it off ASSET.
type Recheck = { env: string; stage: string; run: (store: JobStore, jobId: string) => Promise<{ id: string }> }
const RECHECKS: Recheck[] = [
  { env: 'PLAN_RECHECK_JOB_ID', stage: 'PLAN', run: (s, jobId) => s.recheckPlan({ jobId }) },
  { env: 'ASSET_RECHECK_JOB_ID', stage: 'ASSET', run: (s, jobId) => s.recheckAsset({ jobId }) },
  { env: 'COMPILE_RECHECK_JOB_ID', stage: 'COMPILE', run: (s, jobId) => s.recheckCompile({ jobId }) },
  { env: 'LONGFORM_RENDER_RECOVERY_JOB_ID', stage: 'RENDER', run: (s, jobId) => s.recoverLongformRender({ jobId }) },
  { env: 'RENDER_RECHECK_JOB_ID', stage: 'RENDER', run: (s, jobId) => s.recheckRender({ jobId }) },
  { env: 'QC_RECHECK_JOB_ID', stage: 'AUTO_QC', run: (s, jobId) => s.recheckQc({ jobId }) },
]

// Returns the job ids queued for a PLAN/ASSET rerun, so later hooks (e.g. DECISION_RECOMMENDED_JOB_ID) can skip them too.
export async function runStartupRechecks(store: JobStore, env: Record<string, string | undefined>, log: (line: string) => void): Promise<Set<string>> {
  const assetRerun = new Set<string>()
  const rerunBy = new Map<string, string>()
  for (const r of RECHECKS) {
    const jobId = String(env[r.env] || '').trim()
    if (!jobId) continue
    // a source-first re-plan without the semantic planner yields no story, hence no headline/captions: refuse up front
    if (r.stage === 'PLAN' && !(env.WORKER_AI_PLANNER === 'on' && String(env.OPENAI_API_KEY || '').trim())) { log(`${r.env} skipped: SEMANTIC_PLANNER_OFF (set WORKER_AI_PLANNER=on with OPENAI_API_KEY) job=${jobId}`); continue }
    if (assetRerun.has(jobId)) { log(`${r.env} skipped: SUPERSEDED_BY_${rerunBy.get(jobId)}_RECHECK job=${jobId}`); continue }
    try {
      const job = await r.run(store, jobId)
      if (r.stage === 'PLAN' || r.stage === 'ASSET') { assetRerun.add(job.id); rerunBy.set(job.id, r.stage) }
      log(`${r.env} job=${job.id} -> queued ${r.stage}`)
    } catch (e: any) {
      log(`${r.env} skipped: ${String(e?.code || e?.message || e)}`)
    }
  }
  return assetRerun
}
