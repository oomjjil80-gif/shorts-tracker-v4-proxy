import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import { createVercelJobBlobStore, type JobBlobStore } from '../jobs/blobs.js'
import { CardnewsError, putImage, getImage, composeCards, reviewCardsWithGpt, fixFlaggedWithClaude, getSaved, putSaved, depsFromEnv, cardnewsEstimate, type CardnewsDeps } from './cardnews.js'
import { ApprovalError, requireApproval, recordSpend } from '../generative/paidApproval.js'

// api/story.ts routes taskType cardnews_* here (not a separate Vercel function). Same X-Sync-Key workspace rule as the Job API.
export const CARDNEWS_TASKS = ['cardnews_get', 'cardnews_save', 'cardnews_compose', 'cardnews_review', 'cardnews_fix', 'cardnews_image_put', 'cardnews_image_get'] as const
export const isCardnewsTask = (t: unknown) => typeof t === 'string' && (CARDNEWS_TASKS as readonly string[]).includes(t)
const STATUS: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, COST_APPROVAL_REQUIRED: 402, REV_CONFLICT: 409, APPROVAL_USED: 409, APPROVAL_MISMATCH: 402, APPROVAL_EXPIRED: 402, NOT_FOUND: 404, STORE_FAILED: 502, STATE_TOO_LARGE: 413, PROVIDER_DOWN: 503, REVIEW_INVALID: 502, FIX_INCOMPLETE: 502, METHOD_NOT_ALLOWED: 405 }

export function createCardnewsHttp(o: { blobs: JobBlobStore; deps?: () => CardnewsDeps }) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    try {
      const key = String(req.headers['x-sync-key'] || '').trim()
      if (key.length < 24) throw new CardnewsError('UNAUTHORIZED', '유효한 X-Sync-Key가 필요합니다.')
      const ws = createHash('sha256').update(key).digest('hex')
      const input: any = req.method === 'GET' ? req.query || {} : req.body && typeof req.body === 'object' ? req.body : {}
      const task = String(input.taskType || '')
      const want = task === 'cardnews_get' || task === 'cardnews_image_get' ? 'GET' : 'POST'
      if (!isCardnewsTask(task)) throw new CardnewsError('BAD_REQUEST', `unknown cardnews taskType: ${task}`)
      if (req.method !== want) throw new CardnewsError('METHOD_NOT_ALLOWED', `${task} requires ${want}`)
      if (task === 'cardnews_get') return res.status(200).json({ ok: true, saved: await getSaved(o.blobs, ws) })
      if (task === 'cardnews_save') return res.status(200).json({ ok: true, saved: await putSaved(o.blobs, ws, input) })
      if (task === 'cardnews_image_put') return res.status(200).json({ ok: true, ...(await putImage(o.blobs, ws, input)) })
      if (task === 'cardnews_image_get') return res.status(200).json({ ok: true, ...(await getImage(o.blobs, ws, String(input.ref || ''))) })
      // 유료: 서버가 발급한 1회용 승인이 있어야 하고, 공급자 호출 전에 '사용됨'이 원자적으로 기록된다(중복 호출·이중 결제 차단).
      const kind = task === 'cardnews_compose' ? 'compose' : task === 'cardnews_review' ? 'review' : 'fix', est = cardnewsEstimate(kind)
      const approval = await requireApproval(o.blobs, { ws, input, quote: { task, usd: est.usd, calls: est.calls, note: est.note } })
      const deps = (o.deps ?? depsFromEnv)()
      let r: any, budget: any
      try { r = kind === 'compose' ? await composeCards(input, deps) : kind === 'review' ? await reviewCardsWithGpt(input, deps) : await fixFlaggedWithClaude(input, deps) }
      finally { budget = await recordSpend(o.blobs, { ws, approval }) } // 실패해도 과금됐을 수 있어 기록은 남긴다($20은 경고만)
      return res.status(200).json({ ok: true, ...r, budget })
    } catch (e: any) {
      if (e instanceof ApprovalError) return res.status(STATUS[e.code] ?? 402).json({ ok: false, error: { code: e.code, message: e.message }, ...e.extra })
      if (e instanceof CardnewsError) return res.status(STATUS[e.code] ?? 400).json({ ok: false, error: { code: e.code, message: e.message }, ...e.extra })
      console.error('[cardnews]', e?.message || e)
      // provider/billing failures: the browser keeps the copy-and-paste path
      return res.status(503).json({ ok: false, error: { code: 'PROVIDER_DOWN', message: String(e?.message || 'AI 호출에 실패했습니다. 복사·붙여넣기로 계속할 수 있습니다.').slice(0, 300) } })
    }
  }
}
let blobs: JobBlobStore | null = null
export const defaultCardnewsHttp = (req: Request, res: Response) => createCardnewsHttp({ blobs: (blobs ??= createVercelJobBlobStore()) })(req, res)
