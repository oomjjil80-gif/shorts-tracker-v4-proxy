// Long-running Production Worker. Hosting is deliberately not decided here: any always-on Node process
// (container/VM) with DATABASE_URL + BLOB_READ_WRITE_TOKEN can run `npm run worker`.
import { hostname } from 'node:os'
import { createPgDbFromEnv } from '../lib/jobs/db.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createVercelJobBlobStore } from '../lib/jobs/blobs.js'
import { getSourceAsset } from '../lib/sourceAssetRegistry.js'
import { runOnce } from './runJob.js'
import { compileExecutor } from './stages/compile.js'

const workerId = process.env.WORKER_ID || `${hostname()}-${process.pid}`
const pollMs = Number(process.env.WORKER_POLL_MS || 2000)
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
      const out = await runOnce({ store, blobs, workerId, executors: [compileExecutor], resolveSourceAsset: (id) => getSourceAsset(id) as any })
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
