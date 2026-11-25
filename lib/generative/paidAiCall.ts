// 직접 호출 유료 AI(Claude 대본·롱폼 수정, GPT 대본·이미지 검수, Gemini 일반 이미지, 구형 OpenAI 스토리 작업)의 서버 승인 경로.
// 새 승인 체계가 아니라 카드뉴스·MASTER 이미지가 쓰는 같은 구조를 재사용한다:
//  - 인증: X-Sync-Key 워크스페이스 키(createCardnewsHttp가 검사)
//  - 서버 견적 + 요청 내용에 묶인 1회용 승인(requireApproval) → 승인 없으면 공급자 호출 0회
//  - 같은 요청의 기록(flight): 완료면 저장된 결과를 무과금으로 복구, 진행 중이면 대기, 불명확하면 자동 재호출 없음, 실행권은 원자적 claim
//  - 이미지 제작에는 자동 GPT 검수(QC)가 한 번의 승인 안에 포함된다(별도 승인·별도 호출 없음)
// 원래 엔드포인트의 핸들러는 그대로 두고, 서버 내부 표시가 붙은 호출만 통과시킨다(직접 호출은 403).
import type { Request, Response } from 'express'
import type { JobBlobStore } from '../jobs/blobs.js'
import { sha256 } from '../jobs/blobs.js'
import { readFlight, claimFlight, recordFlight, retryStore } from './paidFlight.js'
import { requireApproval, recordSpend, payloadHash } from './paidApproval.js'
import { INTERNAL_AI_CALL } from './internalCall.js'

export class AiCallError extends Error { constructor(public code: string, message: string) { super(message) } }
type Spec = { usd: number; note: string; load: () => Promise<{ default: (req: any, res: any) => unknown }> }
// 예상 비용은 확정 단가가 아니다(상한을 두지 않는 경고용 기준). 견적은 항상 서버가 정한다.
export const AI_CALL_TARGETS: Record<string, Spec> = {
  'claude-story': { usd: 0.3, note: 'Claude 대본 작성 1회 예상 비용(확정 단가 아님)', load: () => import('../../api/claude-story.js') },
  'claude-longform-revise': { usd: 0.3, note: 'Claude 롱폼 수정 1회 예상 비용(확정 단가 아님)', load: () => import('../../api/claude-longform-revise.js') },
  'gpt-script-qc': { usd: 0.05, note: 'GPT 대본 검수·수정 1회 예상 비용(확정 단가 아님)', load: () => import('../../api/gpt-script-qc.js') },
  'gpt-image-qc': { usd: 0.01, note: 'GPT 이미지 검수 1회 예상 비용(확정 단가 아님)', load: () => import('../../api/gpt-image-qc.js') },
  'image': { usd: 0.067, note: 'Gemini 이미지 1장 예상 비용(확정 단가 아님)', load: () => import('../../api/image.js') },
  'story': { usd: 0.05, note: 'OpenAI 스토리 작업 1회 예상 비용(확정 단가 아님)', load: () => import('../../api/story.js') },
}
const QC_USD = AI_CALL_TARGETS['gpt-image-qc'].usd
const MAX_BODY_CHARS = 28_000_000
// 호출 전에 거절된 것이 확실한 상태(우리 쪽 검증): 같은 요청을 새 승인으로 다시 해도 된다. 그 밖의 실패는 과금 여부가 불명확하다.
const NOT_EXECUTED = new Set([400, 401, 403, 404, 405, 409, 413, 422])

async function callHandler(spec: Spec, body: unknown, headers: any) {
  const handler = (await spec.load()).default
  let status = 200, output: any
  const res: any = { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { output = v; return this }, send(v: any) { output = v; return this }, end() { return this } }
  await handler({ method: 'POST', headers: headers ?? {}, query: {}, body, [INTERNAL_AI_CALL]: true } as any, res)
  return { status, output }
}

export async function handleAiCall(o: { blobs: JobBlobStore; ws: string; input: any; req: Request; res: Response }) {
  const { blobs, ws, input, res } = o
  const target = String(input.target || ''), spec = AI_CALL_TARGETS[target]
  if (!spec) throw new AiCallError('BAD_REQUEST', `지원하지 않는 AI 호출 대상입니다: ${target || '(없음)'}`)
  const body = input.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AiCallError('BAD_REQUEST', '요청 본문(body)이 필요합니다.')
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw new AiCallError('BAD_REQUEST', '요청이 너무 큽니다.')
  // 구형 스토리 작업만 허용(그 밖의 taskType은 이 경로로 다른 라우터에 닿지 않게 한다)
  if (target === 'story' && body.taskType !== undefined && !['yasa_story_plan', 'longform_chapter', 'visual_director', 'story_draft', 'rewrite'].includes(String(body.taskType))) throw new AiCallError('BAD_REQUEST', '이 경로로 호출할 수 없는 작업입니다.')
  const qc = input.qc
  if (qc !== undefined && (target !== 'image' || !qc || typeof qc !== 'object' || typeof qc.prompt !== 'string')) throw new AiCallError('BAD_REQUEST', '이미지 검수(qc)는 이미지 호출에만 포함할 수 있습니다.')
  const usd = Math.round((spec.usd + (qc ? QC_USD : 0)) * 1e6) / 1e6
  const note = qc ? `${spec.note} + 자동 이미지 검수 포함` : spec.note
  // 같은 요청(대상·본문·검수·재실행 식별자)의 이전 호출 기록: 결과가 있으면 승인·과금 없이 복구, 불명확하면 자동으로 다시 호출하지 않는다.
  const hash = payloadHash({ target, body, qc: qc ?? null, regenerate: input.regenerate ?? null })
  const flightBase = `ai-flight/${ws}/${hash}`
  const prior = await readFlight(blobs, flightBase)
  if (prior.state === 'done') {
    const bytes = await blobs.getBytes(prior.result.ref)
    if (bytes && sha256(bytes) === prior.result.sha256) return res.status(200).json({ ...JSON.parse(bytes.toString('utf8')), recovered: true, budget: null })
    throw new AiCallError('AI_STATE_UNKNOWN', '이전에 받은 결과 파일을 읽지 못했습니다. 과금이 중복되지 않도록 자동으로 다시 호출하지 않았습니다.')
  }
  if (prior.state === 'in_progress') throw new AiCallError('AI_IN_PROGRESS', '같은 AI 요청을 다른 요청이 처리하고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
  if (prior.state === 'unknown') throw new AiCallError('AI_STATE_UNKNOWN', '같은 AI 요청의 처리 여부를 확인할 수 없습니다(이미 호출·과금되었을 수 있음). 자동으로 다시 호출하지 않았습니다.')
  const approval = await requireApproval(blobs, { ws, input, quote: { task: 'cardnews_ai_call', usd, calls: qc ? 2 : 1, note } })
  if (!(await claimFlight(blobs, flightBase, prior.gen))) throw new AiCallError('AI_IN_PROGRESS', '같은 AI 요청을 다른 요청이 처리하고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
  let status = 500, output: any, budget: any
  try {
    ;({ status, output } = await callHandler(spec, body, o.req.headers))
    // 이미지: 자동 검수는 같은 승인 안에서 한 번만 실행한다. 검수 실패는 이미지 결과를 바꾸지 않는다(기존과 동일: 검수 없음으로 처리).
    if (qc && status === 200 && typeof output?.image?.base64 === 'string') {
      try {
        const q = await callHandler(AI_CALL_TARGETS['gpt-image-qc'], { input: { prompt: qc.prompt, imageBase64: output.image.base64, mimeType: output.image.mimeType || 'image/png', context: qc.context ?? {} } }, o.req.headers)
        output = { ...output, qc: q.status === 200 ? q.output : null }
      } catch { output = { ...output, qc: null } }
    }
  } catch (e) { await recordFlight(blobs, flightBase, prior.gen, { status: 'unknown', reason: 'handler_threw' }); throw e }
  finally { budget = await recordSpend(blobs, { ws, approval }) } // 실패해도 과금됐을 수 있어 기록은 남긴다
  if (status === 200 && output && typeof output === 'object') {
    const bytes = Buffer.from(JSON.stringify(output), 'utf8'), ref = `ai-results/${ws}/${hash}.json`
    const saved = await retryStore(() => blobs.putBytes(ref, bytes, 'application/json'))
    await recordFlight(blobs, flightBase, prior.gen, saved ? { status: 'done', ref, sha256: sha256(bytes) } : { status: 'paid_unsaved', sha256: sha256(bytes) })
  } else await recordFlight(blobs, flightBase, prior.gen, NOT_EXECUTED.has(status) ? { status: 'failed_safe', http: status } : { status: 'unknown', reason: `http_${status}` })
  return res.status(status).json(output && typeof output === 'object' && !Array.isArray(output) ? { ...output, budget } : output)
}
