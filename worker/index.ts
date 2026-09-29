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

const workerId = process.env.WORKER_ID || `${hostname()}-${process.pid}`
const pollMs = Number(process.env.WORKER_POLL_MS || 2000)
const openAi = process.env.OPENAI_API_KEY && process.env.WORKER_AI_PLANNER !== 'off'
  ? { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_PLAN_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini' }
  : null
const executors = [analyzeExecutor, createPlanExecutor({ openAi }), compileExecutor, renderExecutor, autoQcExecutor, decisionExecutor, finalExecutor, packageExecutor]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const db = await createPgDbFromEnv()
  const store = createJobStore(db)
  const blobs = createVercelJobBlobStore()
  let stopping = false
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true })
  console.log(`[worker ${workerId}] started`)
  while (!stopping) {
    try {
      const out = await runOnce({ store, blobs, workerId, executors, resolveSourceAsset: (id) => getSourceAsset(id) as any, resolveSourceFile: createBlobSourceFileResolver(blobGet as any), leaseMs: 120_000 })
      if (out.ran) console.log(`[worker ${workerId}] job=${out.jobId} stage=${out.stage} -> ${out.outcome}`)
      else await sleep(pollMs)
    } catch (e: any) {
      console.error(`[worker ${workerId}] error`, e?.message || e)
      await sleep(pollMs)
    }
  }
  await db.close?.()
  console.log(`[worker ${workerId}] stopped`)
}

main().catch((e) => { console.error(e); process.exit(1) })
