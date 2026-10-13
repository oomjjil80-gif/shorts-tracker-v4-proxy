import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import { createPgDbFromEnv, type SqlDb } from '../jobs/db.js'
import { trendingSnapshot } from './trending.js'

export const TRENDING_TASK = 'trending_get'
let cached: Promise<SqlDb> | null = null
// GET trending_get — same X-Sync-Key rule as the Job API; read-only, no collection, no paid call.
export function createTrendingHttp(getDb: () => Promise<SqlDb>) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `${TRENDING_TASK} requires GET` } })
    if (String(req.headers['x-sync-key'] || '').trim().length < 24) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '유효한 X-Sync-Key가 필요합니다.' } })
    try { return res.status(200).json({ ok: true, ...(await trendingSnapshot(await getDb())) }) }
    catch (e: any) { console.error('[trending]', e?.message || e); return res.status(503).json({ ok: false, error: { code: 'TRENDING_UNAVAILABLE', message: process.env.DATABASE_URL ? 'trending data could not be read' : 'DATABASE_URL is not configured' } }) }
  }
}
export const defaultTrendingHttp = createTrendingHttp(() => {
  if (!process.env.DATABASE_URL) return Promise.reject(new Error('no db'))
  cached ??= createPgDbFromEnv(); cached.catch(() => { cached = null }); return cached
})
