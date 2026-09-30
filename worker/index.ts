// Long-running Production Worker. Hosting is deliberately not decided here: any always-on Node process
// (container/VM) with DATABASE_URL + BLOB_READ_WRITE_TOKEN can run `npm run worker`.
import { hostname } from 'node:os'
import { createPgDbFromEnv } from '../lib/jobs/db.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createVercelJobBlobStore } from '../lib/jobs/blobs.js'
import { getSourceAsset } from '../lib/sourceAssetRegistry.js'
import { runOnce } from './runJob.js'
import { get as blobGet } from '@vercel/blob'
import { createBlobSourceFileResolver } from './sourceFile.js'
import { analyzeExecutor } from './stages/analyze.js'
import { createPlanExecutor } from './stages/plan.js'
import { compileExecutor } from './stages/compile.js'
import { renderExecutor } from './stages/render.js'
import { autoQcExecutor } from './stages/autoQc.js'
import { decisionExecutor, finalExecutor, packageExecutor } from './stages/finish.js'
import { get } from '@vercel/blob'
import type { ReferenceProfile } from '../lib/reference/contracts.js'

const workerId = process.env.WORKER_ID || `${hostname()}-${process.pid}`
const pollMs = Number(process.env.WORKER_POLL_MS || 2000)
// Model-assisted planning is a paid external call, so it is explicit opt-in even if a provider key exists.
const openAi = process.env.WORKER_AI_PLANNER === 'on' && process.env.OPENAI_API_KEY
  ? { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_PLAN_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini' }
  : null
async function configuredReferenceProfile(): Promise<ReferenceProfile | null> {
  const path=String(process.env.WORKER_REFERENCE_PROFILE_PATH||'').trim(); if(!path) return null
  const r:any=await get(path,{access:'private',useCache:false}); if(!r||r.statusCode!==200||!r.stream) throw new Error('configured reference profile not found')
  const p=JSON.parse(await new Response(r.stream).text()) as ReferenceProfile
  if(p.schema!=='reference-profile/1'||p.profileVersion!==1) throw new Error('configured reference profile is invalid')
  return p
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const db = await createPgDbFromEnv()
  const store = createJobStore(db)
  const referenceProfile = await configuredReferenceProfile()
  const executors = [analyzeExecutor, createPlanExecutor({ openAi, referenceProfile }), compileExecutor, renderExecutor, autoQcExecutor, decisionExecutor, finalExecutor, packageExecutor]
  const blobs = createVercelJobBlobStore()
  let stopping = false
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true })
  console.log(`[worker ${workerId}] started`)
  while (!stopping) {
    try {
      const out = await runOnce({ store, blobs, workerId, executors, resolveSourceAsset: (id) => getSourceAsset(id) as any, resolveSourceFile: createBlobSourceFileResolver(blobGet as any), leaseMs: 120_000 })
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
