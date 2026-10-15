import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import { createVercelJobBlobStore, type JobBlobStore } from '../jobs/blobs.js'
import { CardnewsError, composeCards, reviewCardsWithClaude, fixFlaggedWithGpt, getSaved, putSaved, depsFromEnv, type CardnewsDeps } from './cardnews.js'

// api/story.ts routes taskType cardnews_* here (not a separate Vercel function). Same X-Sync-Key workspace rule as the Job API.
export const CARDNEWS_TASKS = ['cardnews_get', 'cardnews_save', 'cardnews_compose', 'cardnews_review', 'cardnews_fix'] as const
export const isCardnewsTask = (t: unknown) => typeof t === 'string' && (CARDNEWS_TASKS as readonly string[]).includes(t)
const STATUS: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, COST_APPROVAL_REQUIRED: 402, REV_CONFLICT: 409, STATE_TOO_LARGE: 413, PROVIDER_DOWN: 503, REVIEW_INVALID: 502, FIX_INCOMPLETE: 502, METHOD_NOT_ALLOWED: 405 }

export function createCardnewsHttp(o: { blobs: JobBlobStore; deps?: () => CardnewsDeps }) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    try {
      const key = String(req.headers['x-sync-key'] || '').trim()
      if (key.length < 24) throw new CardnewsError('UNAUTHORIZED', '유효한 X-Sync-Key가 필요합니다.')
      const ws = createHash('sha256').update(key).digest('hex')
      const input: any = req.method === 'GET' ? req.query || {} : req.body && typeof req.body === 'object' ? req.body : {}
      const task = String(input.taskType || '')
      const want = task === 'cardnews_get' ? 'GET' : 'POST'
      if (!isCardnewsTask(task)) throw new CardnewsError('BAD_REQUEST', `unknown cardnews taskType: ${task}`)
      if (req.method !== want) throw new CardnewsError('METHOD_NOT_ALLOWED', `${task} requires ${want}`)
      if (task === 'cardnews_get') return res.status(200).json({ ok: true, saved: await getSaved(o.blobs, ws) })
      if (task === 'cardnews_save') return res.status(200).json({ ok: true, saved: await putSaved(o.blobs, ws, input) })
      const deps = (o.deps ?? depsFromEnv)()
      const r = task === 'cardnews_compose' ? await composeCards(input, deps) : task === 'cardnews_review' ? await reviewCardsWithClaude(input, deps) : await fixFlaggedWithGpt(input, deps)
      return res.status(200).json({ ok: true, ...r })
    } catch (e: any) {
      if (e instanceof CardnewsError) return res.status(STATUS[e.code] ?? 400).json({ ok: false, error: { code: e.code, message: e.message }, ...e.extra })
      console.error('[cardnews]', e?.message || e)
      // provider/billing failures: the browser keeps the copy-and-paste path
      return res.status(503).json({ ok: false, error: { code: 'PROVIDER_DOWN', message: String(e?.message || 'AI 호출에 실패했습니다. 복사·붙여넣기로 계속할 수 있습니다.').slice(0, 300) } })
    }
  }
}
let blobs: JobBlobStore | null = null
export const defaultCardnewsHttp = (req: Request, res: Response) => createCardnewsHttp({ blobs: (blobs ??= createVercelJobBlobStore()) })(req, res)
