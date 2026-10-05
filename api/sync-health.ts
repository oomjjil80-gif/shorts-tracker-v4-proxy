import type { Request, Response } from 'express'
import { storageBackend } from '../lib/objectStorage.js'

function setCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || '')
  const configuredOrigin = String(process.env.TRACKER_WEB_ORIGIN || '').trim().replace(/\/$/, '')
  const allowed =
    (configuredOrigin !== '' && origin === configuredOrigin) ||
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker\.vercel\.app$/i.test(origin) ||
    /^https:\/\/shorts-production-tracker-[a-z0-9-]+\.vercel\.app$/i.test(origin)
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Sync-Key')
}

export default async function handler(req: Request, res: Response) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' })
  const backend = storageBackend()
  const configured = backend === 'r2'
    ? Boolean(process.env.R2_ENDPOINT && process.env.R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
    : Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID)
  return res.status(configured ? 200 : 503).json({
    ok: configured,
    provider: backend === 'r2' ? 'Cloudflare R2' : 'Vercel Blob',
    backend,
    access: 'private',
    configured
  })
}
