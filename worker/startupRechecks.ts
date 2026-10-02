import type { JobStore } from '../lib/jobs/store.js'

// Operator startup hooks that move a job back to an earlier stage. ASSET_RECHECK_JOB_ID runs FIRST: it is the deepest
// rerun (ASSET -> ... -> PACKAGE re-renders anyway). A stale RENDER/COMPILE/QC hook left on the same job would otherwise
// move it to QUEUED/RENDER first, after which the ASSET recheck is refused (NOT_ASSET_RECHECKABLE). Once ASSET is queued,
// every other hook naming the same job is skipped as superseded instead of pulling it off ASSET.
type Recheck = { env: string; stage: string; run: (store: JobStore, jobId: string) => Promise<{ id: string }> }
const RECHECKS: Recheck[] = [
  { env: 'ASSET_RECHECK_JOB_ID', stage: 'ASSET', run: (s, jobId) => s.recheckAsset({ jobId }) },
  { env: 'COMPILE_RECHECK_JOB_ID', stage: 'COMPILE', run: (s, jobId) => s.recheckCompile({ jobId }) },
  { env: 'RENDER_RECHECK_JOB_ID', stage: 'RENDER', run: (s, jobId) => s.recheckRender({ jobId }) },
  { env: 'QC_RECHECK_JOB_ID', stage: 'AUTO_QC', run: (s, jobId) => s.recheckQc({ jobId }) },
]

// Returns the job ids queued for an ASSET rerun, so later hooks (e.g. DECISION_RECOMMENDED_JOB_ID) can skip them too.
export async function runStartupRechecks(store: JobStore, env: Record<string, string | undefined>, log: (line: string) => void): Promise<Set<string>> {
  const assetRerun = new Set<string>()
  for (const r of RECHECKS) {
    const jobId = String(env[r.env] || '').trim()
    if (!jobId) continue
    if (assetRerun.has(jobId)) { log(`${r.env} skipped: SUPERSEDED_BY_ASSET_RECHECK job=${jobId}`); continue }
    try {
      const job = await r.run(store, jobId)
      if (r.stage === 'ASSET') assetRerun.add(job.id)
      log(`${r.env} job=${job.id} -> queued ${r.stage}`)
    } catch (e: any) {
      log(`${r.env} skipped: ${String(e?.code || e?.message || e)}`)
    }
  }
  return assetRerun
}
