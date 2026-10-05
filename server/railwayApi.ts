import express, { type Request, type Response, type NextFunction } from 'express'
import storyHandler from '../api/story.js'
import syncHandler from '../api/sync/[...path].js'
import syncHealthHandler from '../api/sync-health.js'
import healthHandler from '../api/health.js'
import { storageBackend } from '../lib/objectStorage.js'

const app = express()
app.disable('x-powered-by')

app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'tracker-continuity-api',
    storage: storageBackend()
  })
})

app.use('/api/story', express.json({ limit: '32mb' }))
app.use('/api/sync', express.raw({ type: 'application/octet-stream', limit: '3mb' }))
app.use('/api/sync', express.json({ type: 'application/json', limit: '1mb' }))

function route(handler: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next)
  }
}

app.all('/api/story', route(storyHandler))
app.all('/api/sync-health', route(syncHealthHandler))
app.all('/api/sync/*', route(syncHandler))
app.all('/api/health', route(healthHandler))

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[continuity-api]', err?.message || err)
  if (res.headersSent) return
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'internal error' } })
})

const port = Number(process.env.PORT || 3000)
app.listen(port, '0.0.0.0', () => {
  console.log(`[continuity-api] listening port=${port} storage=${storageBackend()}`)
})
