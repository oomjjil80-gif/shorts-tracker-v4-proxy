// Local end-to-end harness: the REAL job HTTP adapter + store (PGlite) + all stage executors + ffmpeg, behind an
// Express server that plays the role of the Vercel API and the Blob CDN. Not used in production.
//   npx tsx tools/e2e-local.ts [--port 8790] [--source /path/to/source.mp4]
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore, sha256 } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { runOnce } from '../worker/runJob.js'
import { analyzeExecutor } from '../worker/stages/analyze.js'
import { createPlanExecutor } from '../worker/stages/plan.js'
import { compileExecutor } from '../worker/stages/compile.js'
import { renderExecutor } from '../worker/stages/render.js'
import { autoQcExecutor } from '../worker/stages/autoQc.js'
import { decisionExecutor, finalExecutor, packageExecutor } from '../worker/stages/finish.js'
import { makeSyntheticSource } from './fixtures/makeVideo.js'

export async function startHarness(o: { port?: number; sourcePath?: string } = {}) {
  const port = o.port ?? 8790
  const dir = mkdtempSync(join(tmpdir(), 'e2e-local-'))
  const sourcePath = o.sourcePath ?? (await makeSyntheticSource(join(dir, 'source.mp4')))
  const asset = { sourceAssetId: 'src_e2e_local_0001', blobPath: 'source-collector/e2e/source.mp4', sha256: sha256(readFileSync(sourcePath)), duration: 12, width: 576, height: 1024, filename: 'source.mp4', bytes: readFileSync(sourcePath).length, title: 'E2E 테스트 소스' }
  const db = await createTestDb()
  const store = createJobStore(db)
  const memory = createMemoryBlobStore()
  const blobs = Object.assign(Object.create(memory), { presign: async (p: string) => (memory.binaries.has(p) ? { url: `http://127.0.0.1:${port}/blob/${p}`, validUntil: Date.now() + 3_600_000 } : null) })
  const jobs = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async (id) => id === asset.sourceAssetId })
  const executors = [analyzeExecutor, createPlanExecutor(), compileExecutor, renderExecutor, autoQcExecutor, decisionExecutor, finalExecutor, packageExecutor]
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      try { const out = await runOnce({ store, blobs, executors, workerId: 'e2e', resolveSourceAsset: async () => asset, resolveSourceFile: async () => ({ path: sourcePath, cleanup: async () => {} }), leaseMs: 60_000 }); if (!out.ran) await new Promise((r) => setTimeout(r, 300)) }
      catch (e) { console.error('worker error', e); await new Promise((r) => setTimeout(r, 500)) }
    }
  })()

  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Sync-Key'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); if (req.method === 'OPTIONS') return res.status(204).end(); next() })
  app.all('/api/story', (req, res) => {
    const t = String((req.method === 'GET' ? req.query : req.body)?.taskType || '')
    if (t.startsWith('job_')) return jobs(req as any, res as any)
    if (t === 'source_latest') return res.json({ ok: true, source: asset, sources: [asset], hasMore: false, cursor: null })
    if (t === 'source_playback') return res.json({ ok: true, playbackUrl: `http://127.0.0.1:${port}/source.mp4`, validUntil: Date.now() + 3_600_000 })
    res.status(400).json({ ok: false, error: { message: `harness: unsupported ${t}` } })
  })
  app.get('/source.mp4', (req, res) => res.sendFile(sourcePath))
  app.get('/blob/*', (req, res) => {
    const p = (req.params as any)[0] as string
    const b = memory.binaries.get(p)
    if (!b) return res.status(404).end()
    const type = p.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4'
    const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range || ''))
    if (range) {
      const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Math.min(Number(range[2]), b.length - 1) : b.length - 1
      res.status(206).set({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${b.length}`, 'Content-Length': String(end - start + 1) }).end(b.subarray(start, end + 1))
    } else res.set({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(b.length) }).end(b)
  })
  const server = createServer(app)
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
  return { port, asset, store, blobs: memory, stop: async () => { stopped = true; await loop; server.close() } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port'), j = process.argv.indexOf('--source')
  const h = await startHarness({ port: i > 0 ? Number(process.argv[i + 1]) : 8790, sourcePath: j > 0 ? process.argv[j + 1] : undefined })
  console.log(`harness ready on http://127.0.0.1:${h.port}  source=${h.asset.sourceAssetId}`)
}
