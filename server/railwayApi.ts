import express, { type Request, type Response, type NextFunction } from 'express'
import storyHandler from '../api/story.js'
import syncHandler from '../api/sync/[...path].js'
import syncHealthHandler from '../api/sync-health.js'
import healthHandler from '../api/health.js'
import { storageBackend } from '../lib/objectStorage.js'

const app = express()
app.disable('x-powered-by')
const frontendOrigin = String(process.env.TRACKER_FRONTEND_ORIGIN || 'https://shorts-production-tracker.vercel.app').replace(/\/$/, '')

app.use('/api/story', express.json({ limit: '32mb' }))
app.use('/api/sync', express.raw({ type: 'application/octet-stream', limit: '3mb' }))
app.use('/api/sync', express.json({ type: 'application/json', limit: '1mb' }))

function route(handler: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next)
  }
}

app.get('/api/continuity-health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'tracker-continuity-api',
    storage: storageBackend(),
    frontendOrigin
  })
})
app.all('/api/story', route(storyHandler))
app.all('/api/sync-health', route(syncHealthHandler))
app.all('/api/sync/*', route(syncHandler))
app.all('/api/health', route(healthHandler))

// Continuity UI: reuse the already-working Production Tracker frontend while
// keeping all backend calls on this Railway origin. This avoids requiring a
// second frontend deployment when Vercel blocks new deployments.
app.get('*', async (req, res, next) => {
  try {
    if (req.path.startsWith('/api/')) return next()
    const target = new URL(req.originalUrl || '/', frontendOrigin)
    const upstream = await fetch(target, {
      headers: {
        Accept: String(req.headers.accept || '*/*'),
        'User-Agent': String(req.headers['user-agent'] || 'Tracker-Continuity')
      },
      redirect: 'follow'
    })
    if (!upstream.ok) {
      return res.status(upstream.status).send(await upstream.text())
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
    res.setHeader('Content-Type', contentType)

    const textual =
      contentType.includes('text/html') ||
      contentType.includes('javascript') ||
      contentType.includes('text/css')

    if (textual) {
      let body = await upstream.text()
      body = body.replaceAll('https://shorts-tracker-v4-proxy.vercel.app', '')
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).send(body)
    }

    const bytes = Buffer.from(await upstream.arrayBuffer())
    res.setHeader('Content-Length', String(bytes.length))
    res.setHeader('Cache-Control', upstream.headers.get('cache-control') || 'public, max-age=300')
    return res.status(200).end(bytes)
  } catch (e) {
    next(e)
  }
})

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[continuity-api]', err?.message || err)
  if (res.headersSent) return
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'internal error' } })
})

const port = Number(process.env.PORT || 3000)
app.listen(port, '0.0.0.0', () => {
  console.log(`[continuity-api] listening port=${port} storage=${storageBackend()}`)
})
