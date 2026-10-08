// Long-running Production Worker.
// ops: verify trigger for Golden #110 Hosting is deliberately not decided here: any always-on Node process
// (container/VM) with DATABASE_URL + BLOB_READ_WRITE_TOKEN can run `npm run worker`.
import { hostname } from 'node:os'
import { createPgDbFromEnv } from '../lib/jobs/db.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createVercelJobBlobStore } from '../lib/jobs/blobs.js'
import { getSourceAsset } from '../lib/sourceAssetRegistry.js'
import { runOnce } from './runJob.js'
import { installUsageMeter } from '../lib/generative/usageLedger.js'
import { runStartupRechecks } from './startupRechecks.js'
import { get as blobGet } from '../lib/objectStorage.js'
import { createBlobSourceFileResolver } from './sourceFile.js'
import { analyzeExecutor } from './stages/analyze.js'
import { createPlanExecutor } from './stages/plan.js'
import { compileExecutor } from './stages/compile.js'
import { renderExecutor } from './stages/render.js'
import { createAutoQcExecutor } from './stages/autoQc.js'
import { decisionExecutor, finalExecutor, packageExecutor } from './stages/finish.js'
import type { ReferenceProfile } from '../lib/reference/contracts.js'
import { generativePlanExecutor, createGenerativeAssetExecutor } from './stages/generative.js'
import { withWisdomThumbnail } from './stages/wisdomThumbnail.js'
import { createModuleRegistry, stageExecutorsFor } from './modules/registry.js'
import { createLongformPlanExecutor, createLongformAssetExecutor, longformRenderExecutor, longformPackageExecutor } from './stages/longform.js'

// every paid OpenAI call is metered (model, tokens, estimated USD) per job stage: see lib/generative/usageLedger.ts
installUsageMeter()
const workerId = process.env.WORKER_ID || `${hostname()}-${process.pid}`
const pollMs = Number(process.env.WORKER_POLL_MS || 2000)
// Model-assisted planning is a paid external call, so it is explicit opt-in even if a provider key exists.
const openAi = process.env.WORKER_AI_PLANNER === 'on' && process.env.OPENAI_API_KEY
  ? { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_PLAN_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini' }
  : null
async function jobReferenceProfile(job:any, blobs:any): Promise<ReferenceProfile|null> {
  const path=String(job.referenceProfileRef||'').trim(); if(!path) return null
  const p=await blobs.getJson(path) as ReferenceProfile | null
  if(!p||p.schema!=='reference-profile/1'||p.profileVersion!==1) throw new Error('job reference profile is invalid or missing')
  return p
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // Profile -> module wiring (lib/jobs/profiles.ts + worker/modules/registry.ts) is checked before anything runs.
  const apiKey = process.env.OPENAI_API_KEY
  const executors = stageExecutorsFor(createModuleRegistry({
    analyze: analyzeExecutor, sourcePlan: createPlanExecutor({ openAi, resolveReferenceProfile: jobReferenceProfile }),
    wisdomPlan: generativePlanExecutor, wisdomAsset: createGenerativeAssetExecutor({ apiKey }),
    compile: compileExecutor, render: renderExecutor, autoQc: createAutoQcExecutor(null, jobReferenceProfile),
    decision: decisionExecutor, final: finalExecutor, shortsPackage: withWisdomThumbnail(packageExecutor, { apiKey }),
    longformPlan: createLongformPlanExecutor({ apiKey }), longformAsset: createLongformAssetExecutor({ apiKey }),
    longformRender: longformRenderExecutor, longformPackage: longformPackageExecutor
  }))
  const db = await createPgDbFromEnv()
  const store = createJobStore(db)
  const assetRerunJobIds = await runStartupRechecks(store, process.env, (line) => console.log(`[worker ${workerId}] ${line}`))
  const decisionJobId = String(process.env.DECISION_RECOMMENDED_JOB_ID || '').trim()
  if (decisionJobId && assetRerunJobIds.has(decisionJobId)) console.log(`[worker ${workerId}] DECISION_RECOMMENDED_JOB_ID skipped: SUPERSEDED_BY_PLAN_OR_ASSET_RECHECK job=${decisionJobId}`)
  else if (decisionJobId) {
    try {
      const job = await store.approveRecommended({ jobId: decisionJobId })
      console.log(`[worker ${workerId}] DECISION_RECOMMENDED_JOB_ID job=${job.id} -> queued ${job.stage}`)
    } catch (e: any) {
      console.log(`[worker ${workerId}] DECISION_RECOMMENDED_JOB_ID skipped: ${String(e?.code || e?.message || e)}`)
    }
  }

  const blobs = createVercelJobBlobStore()
  const verifyFinalJobId = String(process.env.FINAL_VERIFY_JOB_ID || '').trim()
  if (verifyFinalJobId) {
    try {
      const runs = await store.listStageRuns(verifyFinalJobId)
      const fin = [...runs].reverse().find((r: any) => r.stage === 'FINAL' && r.status === 'SUCCEEDED')
      const ref = String(fin?.outputRef || '')
      if (!ref.startsWith('renders/')) throw new Error('FINAL_RENDER_MISSING')
      const signed = await blobs.presign?.(ref)
      if (!signed?.url) throw new Error('FINAL_RENDER_NOT_SIGNABLE')
      console.log(`[worker ${workerId}] FINAL_VERIFY_JOB_ID job=${verifyFinalJobId} url=${signed.url} validUntil=${signed.validUntil}`)
    } catch (e: any) {
      console.log(`[worker ${workerId}] FINAL_VERIFY_JOB_ID skipped: ${String(e?.code || e?.message || e)}`)
    }
  }
  let stopping = false
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true })
  console.log(`[worker ${workerId}] started`)
  while (!stopping) {
    try {
      const resolveSourceAsset = async (id:string) => {
        if (id.startsWith('src_gen_')) {
          const generated:any=await blobs.getJson(`generative-sources/${id}.json`)
          if(!generated) throw Object.assign(new Error('generated source asset not ready'),{code:'SOURCE_ASSET_NOT_FOUND'})
          return generated
        }
        return getSourceAsset(id) as any
      }
      const out = await runOnce({ store, blobs, workerId, executors, resolveSourceAsset, resolveSourceFile: createBlobSourceFileResolver(blobGet as any), leaseMs: 120_000 })
      if (out.ran) {
        let detail = ''
        if (out.outcome === 'failed' || out.outcome === 'retry') {
          try {
            const runs = await store.listStageRuns(out.jobId)
            const last = [...runs].reverse().find((r) => r.stage === out.stage && r.status === 'FAILED')
            if (last?.error) detail = ` error=${JSON.stringify(last.error)}`
          } catch (e: any) {
            detail = ` error_lookup_failed=${JSON.stringify(String(e?.message || e))}`
          }
        }
        console.log(`[worker ${workerId}] job=${out.jobId} stage=${out.stage} -> ${out.outcome}${detail}`)
      } else await sleep(pollMs)
    } catch (e: any) {
      console.error(`[worker ${workerId}] error`, e?.message || e)
      await sleep(pollMs)
    }
  }
  await db.close?.()
  console.log(`[worker ${workerId}] stopped`)
}

main().catch((e) => { console.error(e); process.exit(1) })
