import imageHandler, { INTERNAL_IMAGE_CALL } from '../../api/image.js'
import { planForCardnewsState } from './productionPlan.js'
import { createHash } from 'node:crypto'
import { reviewCardImage } from './visionReview.js'
import { zipNinePanels } from './zipNinePanels.js'
import type { Request, Response } from 'express'
import { createVercelJobBlobStore, sha256, type JobBlobStore } from '../jobs/blobs.js'
import { readFlight, claimFlight, recordFlight, retryStore } from '../generative/paidFlight.js'
import { CardnewsError, putImage, getImage, composeCards, storyboardForExistingCards, reviewCardsWithGpt, fixFlaggedWithClaude, getSaved, putSaved, listProjects, projectIdOf, depsFromEnv, cardnewsEstimate, type CardnewsDeps } from './cardnews.js'
import { ApprovalError, requireApproval, recordSpend, reserveBatchSlot, validateBatchTerms, payloadHash } from '../generative/paidApproval.js'

// api/story.ts routes taskType cardnews_* here (not a separate Vercel function). Same X-Sync-Key workspace rule as the Job API.
export const CARDNEWS_TASKS = ['cardnews_get', 'cardnews_list', 'cardnews_save', 'cardnews_compose', 'cardnews_storyboard', 'cardnews_review', 'cardnews_fix', 'cardnews_image_put', 'cardnews_image_get', 'cardnews_image_review', 'cardnews_zip_get', 'cardnews_image_generate', 'cardnews_image_direct', 'cardnews_master_image_generate'] as const
export const isCardnewsTask = (t: unknown) => typeof t === 'string' && (CARDNEWS_TASKS as readonly string[]).includes(t)
const STATUS: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, COST_APPROVAL_REQUIRED: 402, REV_CONFLICT: 409, APPROVAL_USED: 409, APPROVAL_MISMATCH: 402, APPROVAL_EXPIRED: 402, BATCH_LIMIT_EXCEEDED: 402, IMAGE_IN_PROGRESS: 409, IMAGE_STATE_UNKNOWN: 409, NOT_FOUND: 404, STORE_FAILED: 502, STATE_TOO_LARGE: 413, PROVIDER_DOWN: 503, REVIEW_INVALID: 502, FIX_INCOMPLETE: 502, METHOD_NOT_ALLOWED: 405 }

export function createCardnewsHttp(o: { blobs: JobBlobStore; deps?: () => CardnewsDeps }) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store')
    try {
      const key = String(req.headers['x-sync-key'] || '').trim()
      if (key.length < 24) throw new CardnewsError('UNAUTHORIZED', '유효한 X-Sync-Key가 필요합니다.')
      const ws = createHash('sha256').update(key).digest('hex')
      const input: any = req.method === 'GET' ? req.query || {} : req.body && typeof req.body === 'object' ? req.body : {}
      const task = String(input.taskType || '')
      const want = task === 'cardnews_get' || task === 'cardnews_list' || task === 'cardnews_image_get' || task === 'cardnews_zip_get' ? 'GET' : 'POST'
      if (!isCardnewsTask(task)) throw new CardnewsError('BAD_REQUEST', `unknown cardnews taskType: ${task}`)
      if (req.method !== want) throw new CardnewsError('METHOD_NOT_ALLOWED', `${task} requires ${want}`)
      if (task === 'cardnews_get') return res.status(200).json({ ok: true, saved: await getSaved(o.blobs, ws, projectIdOf(input.projectId)) })
      if (task === 'cardnews_list') return res.status(200).json({ ok: true, projects: await listProjects(o.blobs, ws) })
      if (task === 'cardnews_save') return res.status(200).json({ ok: true, saved: await putSaved(o.blobs, ws, input) })
      if (task === 'cardnews_image_put') return res.status(200).json({ ok: true, ...(await putImage(o.blobs, ws, input)) })
      if (task === 'cardnews_image_get') return res.status(200).json({ ok: true, ...(await getImage(o.blobs, ws, String(input.ref || ''))) })
      if (task === 'cardnews_zip_get') {
        const saved = await getSaved(o.blobs, ws, projectIdOf(input.projectId))
        if (!saved) throw new CardnewsError('NOT_FOUND', '저장된 카드뉴스가 없습니다.')
        const state = saved.state
        const ids = [state?.cover ? 'cover' : null, ...(Array.isArray(state?.cards) ? state.cards.map((c: any) => c.id) : [])]
        if (ids.length !== 9 || ids.some((id: unknown) => typeof id !== 'string' || !id)) throw new CardnewsError('BAD_REQUEST', '표지 포함 정확히 9장이 필요합니다.')
        if (!state.scriptConfirmedAt || state.review?.ok !== true) throw new CardnewsError('BAD_REQUEST', '확정·검수된 대본이 필요합니다.')
        const temporary = new Set([...(state.refs?.panels || []), ...Object.values(state.refs?.storyboard || {})].map((x: any) => x.ref))
        const entries: {name:string;bytes:Buffer}[] = []
        for (let i=0;i<ids.length;i++) {
          const item=state?.images?.[ids[i]]
          const version=item?.versions?.find((v:any)=>v.id===item.selected)
          const ref=String(version?.ref ?? '')
          if (!ref.startsWith('cardnews/'+ws+'/images/') || !/^[0-9a-f]{64}\.(png|jpg|webp)$/.test(ref.slice(('cardnews/'+ws+'/images/').length))) throw new CardnewsError('BAD_REQUEST', '저장된 '+(i+1)+'번 이미지가 없습니다.')
          if (temporary.has(ref)) throw new CardnewsError('BAD_REQUEST', '스토리보드 임시 이미지는 게시용 완성본이 아닙니다.')
          const bytes=await o.blobs.getBytes(ref)
          if (!bytes) throw new CardnewsError('NOT_FOUND', (i+1)+'번 이미지 원본이 없습니다.')
          entries.push({name:'panel-'+String(i+1).padStart(2,'0')+'.'+ref.split('.').pop(),bytes})
        }
        const zip=zipNinePanels(entries)
        res.setHeader('Content-Type','application/zip')
        res.setHeader('Content-Disposition','attachment; filename="cardnews-nine-panels.zip"')
        return res.status(200).send(zip)
      }
      if (task === 'cardnews_image_generate') {
        const saved = await getSaved(o.blobs, ws, projectIdOf(input.projectId))
        if (!saved || saved.rev !== input.baseRev) throw new CardnewsError('REV_CONFLICT', '최신 저장본을 확인한 뒤 이미지를 생성해주세요.')
        const state = saved.state
        const plan = planForCardnewsState(state)
        const step = plan?.steps.find(s => s.kind === 'image' && s.sceneId === input.cardId)
        if (!step || !state.scriptConfirmedAt || state.review?.ok !== true) throw new CardnewsError('BAD_REQUEST', '확정된 9장 제작 계획이 필요합니다.')
      }
      // MASTER image-only (롱폼 16:9 · 쇼츠 9:16): one approved scene, no TTS/render/job creation.
      // The caller provides an explicit scene identifier and the approved prompt; storyboard references are optional (0~4).
      if (task === 'cardnews_master_image_generate') {
        const im = input.imageInput
        const formatOk = (im?.aspectRatio === '16:9' && im?.profile === 'master-longform') || (im?.aspectRatio === '9:16' && im?.profile === 'master-shorts')
        if (!im || !formatOk ||
            !/^scene-(0[1-9]|[1-9][0-9])$/.test(String(input.sceneId || '')) ||
            typeof im.prompt !== 'string' || im.prompt.trim().length < 20 || im.prompt.length > 12000 ||
            !Array.isArray(im.references) || im.references.length > 4 ||
            im.references.some((r: any) => typeof r?.data !== 'string' || r.data.length < 100 || r.data.length > 12_000_000 ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(r.data) || !['image/png', 'image/jpeg', 'image/webp'].includes(String(r.mimeType || r.mime_type || '')))) {
          throw new CardnewsError('BAD_REQUEST', 'MASTER 장면 ID·규격(16:9/9:16)·프롬프트가 필요합니다.')
        }
        // 같은 요청(장면·프롬프트·참조·재생성 의도, 일괄 id는 제외)의 이전 호출 기록: 결과가 있으면 승인·과금 없이 복구하고,
        // 처리 여부가 불명확하면 자동으로 다시 호출하지 않는다. 선택 장면 '다시 생성'은 새 regenerate 값으로 새 요청이 된다.
        // 일괄 요청이면 승인 대상(프로젝트·장면 목록·총액)과 이 장면이 맞는지 승인 소비 전에 검증한다
        if (input.batch !== undefined) validateBatchTerms(input.batch, String(input.sceneId), 0.067)
        const flightBase = `image-flight/${ws}/${payloadHash({ sceneId: input.sceneId, imageInput: im, regenerate: input.regenerate ?? null })}`
        const prior = await readFlight(o.blobs, flightBase)
        if (prior.state === 'done') {
          const bytes = await o.blobs.getBytes(prior.result.ref)
          if (bytes && sha256(bytes) === prior.result.sha256) return res.status(200).json({ image: { base64: bytes.toString('base64'), mimeType: prior.result.mimeType }, meta: { recovered: true }, recovered: true, budget: null })
          throw new CardnewsError('IMAGE_STATE_UNKNOWN', '이전에 만든 이미지 파일을 읽지 못했습니다. 과금이 중복되지 않도록 자동으로 다시 호출하지 않았습니다.')
        }
        if (prior.state === 'in_progress') throw new CardnewsError('IMAGE_IN_PROGRESS', '같은 이미지를 다른 요청이 만들고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
        if (prior.state === 'unknown') throw new CardnewsError('IMAGE_STATE_UNKNOWN', '같은 이미지 요청의 처리 여부를 확인할 수 없습니다(이미 생성·과금되었을 수 있음). 자동으로 다시 호출하지 않았습니다. 새로 만들려면 확인 후 다시 생성을 선택하세요.')
        const approval = await requireApproval(o.blobs, { ws, input, quote: { task, usd: 0.067, calls: 1, note: 'Gemini MASTER 이미지 1장 예상 비용(확정 단가 아님)' } })
        // 공급자 호출 전에 이 요청의 실행권을 원자적으로 확보(독립 인스턴스·동시 요청 중 하나만 호출)
        if (!(await claimFlight(o.blobs, flightBase, prior.gen))) throw new CardnewsError('IMAGE_IN_PROGRESS', '같은 이미지를 다른 요청이 만들고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
        // 일괄 제작이면 승인된 총액·장수를 서버가 원자적으로 예약한다(동시 요청·다른 탭이 한도를 넘길 수 없다). 슬롯이 없으면 공급자 호출 없음.
        try { if (input.batch !== undefined) await reserveBatchSlot(o.blobs, { ws, batch: input.batch, sceneId: String(input.sceneId), unitUsd: 0.067 }) }
        catch (e) { await recordFlight(o.blobs, flightBase, prior.gen, { status: 'failed_safe', reason: 'batch_limit' }); throw e }
        let status = 500, output: any, budget: any
        try {
          await imageHandler({ ...req, headers: req.headers, method: req.method, body: { input: im }, [INTERNAL_IMAGE_CALL]: true } as any,
            { setHeader() {}, status(code: number) { status = code; return this }, json(value: any) { output = value; return this } } as any)
        } catch (e) { await recordFlight(o.blobs, flightBase, prior.gen, { status: 'unknown', reason: 'handler_threw' }); throw e }
        finally { budget = await recordSpend(o.blobs, { ws, approval }) }
        // 결과 기록: 생성됐으면 이미지를 저장소에 남겨 응답이 유실돼도 복구한다. 공급자가 호출되지 않았거나(검증 단계 거절), 공급자가 4xx로
        // 거절했으면 생성되지 않았음이 확실(failed_safe). 그 밖은 모두 불명확(unknown)이라 자동 재호출하지 않는다:
        // 응답 없음, 5xx·408, HTTP 200이지만 이미지를 읽지 못함(PROVIDER_RESPONSE_UNREADABLE), 결과 저장 실패.
        if (status === 200 && typeof output?.image?.base64 === 'string') {
          const bytes = Buffer.from(output.image.base64.replace(/^data:[^;]+;base64,/, ''), 'base64'), h = sha256(bytes), mimeType = String(output.image.mimeType || 'image/png')
          const ref = `generative-assets/master-images/${h}`
          const saved = await retryStore(() => o.blobs.putBytes(ref, bytes, mimeType))
          await recordFlight(o.blobs, flightBase, prior.gen, saved ? { status: 'done', ref, sha256: h, mimeType } : { status: 'paid_unsaved', sha256: h })
        } else {
          const code = output?.error?.code, providerStatus = Number(output?.error?.providerStatus)
          const reachedProvider = code === 'PROVIDER_HTTP_ERROR' || code === 'PROVIDER_NO_RESPONSE' || code === 'PROVIDER_RESPONSE_UNREADABLE'
          const rejectedByProvider = code === 'PROVIDER_HTTP_ERROR' && Number.isInteger(providerStatus) && providerStatus >= 400 && providerStatus < 500 && providerStatus !== 408
          const notExecuted = status !== 200 && output?.error && (!reachedProvider || rejectedByProvider)
          await recordFlight(o.blobs, flightBase, prior.gen, notExecuted ? { status: 'failed_safe', http: status } : { status: 'unknown', reason: code ?? `http_${status}` })
        }
        return res.status(status).json({ ...output, budget })
      }
      // 이미지 1장(유료): 8장 덱은 위의 확정 계획 확인 후, 그 외 덱(cardnews_image_direct)은 바로 — 둘 다 1회용 승인 → Gemini → Ledger
      if (task === 'cardnews_image_generate' || task === 'cardnews_image_direct') {
        if (input.imageInput?.aspectRatio !== '4:5' || input.imageInput?.profile !== 'cardnews') throw new CardnewsError('BAD_REQUEST', '카드뉴스는 4:5 이미지여야 합니다.')
        const approval = await requireApproval(o.blobs, { ws, input, quote: { task, usd: 0.067, calls: 1, note: 'Gemini 이미지 1장 예상 비용(확정 단가 아님)' } })
        let status = 500, output: any
        try {
          await imageHandler({ ...req, body: { input: input.imageInput }, [INTERNAL_IMAGE_CALL]: true } as any, { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { output = v; return this } } as any)
        } finally { await recordSpend(o.blobs, { ws, approval }) }
        return res.status(status).json(output)
      }
      // 유료: 서버가 발급한 1회용 승인이 있어야 하고, 공급자 호출 전에 '사용됨'이 원자적으로 기록된다(중복 호출·이중 결제 차단).
      const kind = (task === 'cardnews_compose' || task === 'cardnews_storyboard') ? 'compose' : task === 'cardnews_review' ? 'review' : 'fix', est = task === 'cardnews_image_review' ? { usd: 0.01, calls: 1, note: '이미지 1장 AI 시각 검수 예상 비용(확정 단가 아님)' } : cardnewsEstimate(kind)
      const approval = await requireApproval(o.blobs, { ws, input, quote: { task, usd: est.usd, calls: est.calls, note: est.note } })
      const deps = (o.deps ?? depsFromEnv)()
      let r: any, budget: any
      try { r = task === 'cardnews_image_review' ? await reviewCardImage(input) : task === 'cardnews_storyboard' ? await storyboardForExistingCards(input, deps) : kind === 'compose' ? await composeCards(input, deps) : kind === 'review' ? await reviewCardsWithGpt(input, deps) : await fixFlaggedWithClaude(input, deps) }
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
