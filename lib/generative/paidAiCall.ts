// 직접 호출 유료 AI(Claude 대본·롱폼 수정, GPT 대본·이미지 검수, Gemini 일반 이미지, 구형 OpenAI 스토리 작업)의 서버 승인 경로.
// 새 승인 체계가 아니라 카드뉴스·MASTER 이미지가 쓰는 같은 구조를 재사용한다:
//  - 인증: X-Sync-Key 워크스페이스 키(createCardnewsHttp가 검사)
//  - 서버 견적(요청이 실제로 낼 수 있는 최대 공급자 호출 수 × 단가) + 요청 내용에 묶인 1회용 승인(requireApproval)
//  - 승인된 호출 수는 공급자 호출 직전에 서버가 강제한다(withCallBudget): 분할 작성·자동 재시도도 이 상한 안에서만 나간다
//  - 같은 요청의 기록(flight): 완료면 저장 결과를 무과금 복구, 진행 중이면 대기, 불명확하면 자동 재호출 없음, 실행권은 원자적 claim
//  - 공급자에 아무것도 보내지 않은 실패(호출 수 0)만 failed_safe. 호출이 한 번이라도 나간 뒤의 실패·불완전 응답·저장 실패는 모두 불명확 처리
//  - 일괄 이미지는 MASTER와 같은 일괄 승인(장면 목록·최대 장수·총액, 장면별 원자적 슬롯)
//  - 이미지 제작에는 자동 GPT 검수(QC)가 한 번의 승인 안에 포함된다
import type { Request, Response } from 'express'
import type { JobBlobStore } from '../jobs/blobs.js'
import { sha256 } from '../jobs/blobs.js'
import { readFlight, claimFlight, recordFlight, retryStore } from './paidFlight.js'
import { requireApproval, recordSpend, payloadHash, validateBatchTerms, reserveBatchSlot, ApprovalError } from './paidApproval.js'
import { INTERNAL_AI_CALL } from './internalCall.js'
import { withCallBudget } from './callBudget.js'
import { isYasa, yasaLongformMinutes, yasaChapterCount } from '../story/yasaStoryDna.js'

export class AiCallError extends Error { constructor(public code: string, message: string) { super(message) } }
type Spec = { usd: number; label: string; load: () => Promise<{ default: (req: any, res: any) => unknown }> }
// 예상 비용은 확정 단가가 아니다(상한을 두지 않는 경고용 기준). 견적은 항상 서버가 정한다.
export const AI_CALL_TARGETS: Record<string, Spec> = {
  'claude-story': { usd: 0.3, label: 'Claude 대본 작성', load: () => import('../../api/claude-story.js') },
  'claude-longform-revise': { usd: 0.3, label: 'Claude 롱폼 수정', load: () => import('../../api/claude-longform-revise.js') },
  'gpt-script-qc': { usd: 0.05, label: 'GPT 대본 검수·수정', load: () => import('../../api/gpt-script-qc.js') },
  'gpt-image-qc': { usd: 0.01, label: 'GPT 이미지 검수', load: () => import('../../api/gpt-image-qc.js') },
  'image': { usd: 0.067, label: 'Gemini 이미지', load: () => import('../../api/image.js') },
  'story': { usd: 0.05, label: 'OpenAI 스토리 작업', load: () => import('../../api/story.js') },
}
export const QC_USD = AI_CALL_TARGETS['gpt-image-qc'].usd
export const CUT_IMAGE_UNIT_USD = Math.round((AI_CALL_TARGETS['image'].usd + QC_USD) * 1e6) / 1e6 // 일반 CUT 이미지 1장(+자동 검수)
const MAX_BODY_CHARS = 28_000_000
const LEGACY_STORY_TASKS = ['yasa_story_plan', 'longform_chapter', 'visual_director', 'story_draft', 'rewrite']
// 전용 승인·검사 구조가 있는 이미지 프로필(MASTER·썸네일·카드뉴스)은 일반 이미지 경로로 만들 수 없다.
const RESERVED_IMAGE_PROFILE = /^(cardnews|master-.*|thumbnail-.*)$/i

// 이 요청이 실제로 낼 수 있는 최대 공급자 호출 수(핸들러 내부 분할 작성·재생성 포함).
export function maxProviderCalls(target: string, body: any): number {
  if (target === 'claude-story') {
    const input = body?.input || {}
    if (body?.test) return 1
    const shorts = input.contentFormat === 'shorts'
    if (shorts || String(body?.mode || '') === 'chapter') return 1
    const targetMinutes = isYasa(input) ? yasaLongformMinutes(input?.targetMinutes) : Math.max(5, Math.min(30, Number(input?.targetMinutes || 15)))
    const chapterCount = isYasa(input) ? yasaChapterCount(targetMinutes, input?.chapterCount) : Math.max(3, Math.min(10, Number(input?.chapterCount || 6)))
    return targetMinutes >= 18 || chapterCount >= 7 ? Math.max(1, chapterCount) : 1 // 분할 작성: 챕터마다 1회
  }
  if (target === 'story') return body?.taskType === 'yasa_story_plan' ? 2 : 1 // PLAN은 구조 검사 실패 시 한 번 더 만든다
  return 1
}
export function planAiCall(target: string, body: any, withQc: boolean) {
  const spec = AI_CALL_TARGETS[target], calls = maxProviderCalls(target, body)
  const usd = Math.round((spec.usd * calls + (withQc ? QC_USD : 0)) * 1e6) / 1e6
  const total = calls + (withQc ? 1 : 0)
  return { calls: total, usd, note: `${spec.label} 최대 ${calls}회${withQc ? ' + 자동 이미지 검수 1회' : ''} 예상 비용(확정 단가 아님)` }
}

// 200이어도 필요한 결과가 없으면 성공이 아니다.
export function isComplete(target: string, output: any): boolean {
  if (!output || typeof output !== 'object') return false
  // 부분 수정이 대상 구간을 정할 수 없을 때의 정상 응답(공급자 호출 없음): 호출자가 수동 수정 안내를 보여 준다. 불완전한 응답이 아니다.
  if ((target === 'gpt-script-qc' || target === 'claude-longform-revise') && output.ok === true && output.scope === 'manual_required') return true
  switch (target) {
    case 'image': return typeof output.image?.base64 === 'string' && output.image.base64.length > 0
    case 'gpt-image-qc': return typeof output.decision === 'string' && output.decision.length > 0
    case 'claude-story': return output.ok === true && (output.draft && typeof output.draft === 'object' || (typeof output.text === 'string' && output.text.length > 0))
    case 'claude-longform-revise': return output.ok === true && !!output.draft && typeof output.draft === 'object'
    case 'gpt-script-qc': return output.ok === true && (!!output.draft || !!output.qc || (typeof output.text === 'string' && output.text.length > 0))
    case 'story': return output.ok === true || !!output.draft || !!output.dna
    default: return false
  }
}

// ── 대본 작업 일괄 승인: 한 번의 시작 승인이 프로젝트·허용 작업 유형·누적 견적 상한에 묶인다(서버가 create-once 클레임만으로 강제) ──
export const SCRIPT_TARGETS = ['claude-story', 'claude-longform-revise', 'gpt-script-qc', 'story']
const batchError = (m: string) => new ApprovalError('BATCH_LIMIT_EXCEEDED', m)
export function validateScriptBatch(batch: any, target: string, projectId: unknown) {
  if (!batch || typeof batch !== 'object' || batch.kind !== 'script' || typeof batch.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(batch.id) ||
      typeof batch.projectId !== 'string' || batch.projectId.length < 1 || batch.projectId.length > 80 || typeof batch.limitUsd !== 'number' || !Number.isFinite(batch.limitUsd) || batch.limitUsd <= 0 || batch.limitUsd > 50)
    throw batchError('대본 일괄 승인 정보(scriptBatch: id·kind·projectId·limitUsd)가 올바르지 않아 호출하지 않았습니다.')
  if (!SCRIPT_TARGETS.includes(target)) throw batchError('이 일괄 승인은 대본 작업에만 쓸 수 있어 호출하지 않았습니다.')
  if (projectId !== batch.projectId) throw batchError('일괄 승인한 프로젝트와 요청의 프로젝트가 달라 호출하지 않았습니다.')
}
async function reserveScriptSpend(blobs: JobBlobStore, o: { ws: string; batch: any; hash: string; usd: number }) {
  if (!blobs.claim) throw new Error('approval store cannot claim atomically')
  const base = `paid-batches/${o.ws}/${o.batch.id}`, terms = { kind: 'script', projectId: o.batch.projectId, limitUsd: o.batch.limitUsd }
  if (!(await blobs.claim(`${base}/meta.json`, terms))) {
    const meta: any = await blobs.getJson(`${base}/meta.json`)
    if (!meta || meta.kind !== 'script' || meta.projectId !== terms.projectId || Math.abs(meta.limitUsd - terms.limitUsd) > 1e-9) throw batchError('이미 다른 프로젝트·상한으로 열린 일괄 승인이라 호출하지 않았습니다.')
  }
  // 호출마다 순서 번호 하나를 create-once로 차지한다. 같은 요청의 재시도는 같은 번호를 다시 쓴다. 누적 상한은 번호 순서대로 결정된다(경쟁 없음).
  let mine = -1
  for (let i = 0; i < 300 && mine < 0; i++) {
    const path = `${base}/seq-${i}.json`
    let e: any = await blobs.getJson(path)
    if (!e) { if (await blobs.claim(path, { hash: o.hash, usd: o.usd })) { mine = i; break } e = await blobs.getJson(path) }
    if (e?.hash === o.hash) mine = i
  }
  if (mine < 0) throw batchError('일괄 승인 호출 기록이 가득 차 호출하지 않았습니다.')
  let running = 0
  for (let j = 0; j <= mine; j++) {
    const e: any = await blobs.getJson(`${base}/seq-${j}.json`)
    if (!e) throw batchError('일괄 승인 기록을 확인하지 못해 호출하지 않았습니다.')
    const fits = running + Number(e.usd) <= o.batch.limitUsd + 1e-9
    if (j === mine) { if (!fits) throw batchError(`일괄 승인 상한(${o.batch.limitUsd}달러)을 넘어 호출하지 않았습니다.`); return { reservedUsd: running + Number(e.usd), limitUsd: o.batch.limitUsd } }
    if (fits) running += Number(e.usd)
  }
}

async function callHandler(spec: Spec, body: unknown, headers: any, maxCalls: number) {
  const handler = (await spec.load()).default
  let status = 200, output: any
  const res: any = { setHeader() {}, status(s: number) { status = s; return this }, json(v: any) { output = v; return this }, send(v: any) { output = v; return this }, end() { return this } }
  const { used } = await withCallBudget(maxCalls, async () => { await handler({ method: 'POST', headers: headers ?? {}, query: {}, body, [INTERNAL_AI_CALL]: true } as any, res) })
  return { status, output, used }
}

export async function handleAiCall(o: { blobs: JobBlobStore; ws: string; input: any; req: Request; res: Response }) {
  const { blobs, ws, input, res } = o
  const target = String(input.target || ''), spec = AI_CALL_TARGETS[target]
  if (!spec) throw new AiCallError('BAD_REQUEST', `지원하지 않는 AI 호출 대상입니다: ${target || '(없음)'}`)
  const body = input.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AiCallError('BAD_REQUEST', '요청 본문(body)이 필요합니다.')
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw new AiCallError('BAD_REQUEST', '요청이 너무 큽니다.')
  // 구형 스토리 작업만 허용(그 밖의 taskType은 이 경로로 다른 라우터에 닿지 않게 한다)
  if (target === 'story' && body.taskType !== undefined && !LEGACY_STORY_TASKS.includes(String(body.taskType))) throw new AiCallError('BAD_REQUEST', '이 경로로 호출할 수 없는 작업입니다.')
  // MASTER·썸네일·카드뉴스는 전용 승인 경로(장면 규격·일괄 승인·카드 계획 검사)로만 만든다.
  if (target === 'image' && RESERVED_IMAGE_PROFILE.test(String(body?.input?.profile ?? '').trim())) throw new AiCallError('BAD_REQUEST', '이 이미지 프로필은 전용 승인 경로로만 만들 수 있습니다.')
  const qc = input.qc
  if (qc !== undefined && (target !== 'image' || !qc || typeof qc !== 'object' || typeof qc.prompt !== 'string')) throw new AiCallError('BAD_REQUEST', '이미지 검수(qc)는 이미지 호출에만 포함할 수 있습니다.')
  // 옛 앱의 썸네일(cutIndex -1: 숫자·문자열)은 일반 이미지 경로로 만들 수 없다(썸네일은 전용 승인 경로).
  if (target === 'image' && Number(body?.input?.cutIndex) === -1) throw new AiCallError('BAD_REQUEST', '썸네일은 전용 승인 경로로만 만들 수 있습니다.')
  const batch = input.batch, sceneId = input.sceneId, scriptBatch = input.scriptBatch
  if ((batch !== undefined || sceneId !== undefined) && target !== 'image') throw new AiCallError('BAD_REQUEST', '일괄 승인은 이미지 호출에만 쓸 수 있습니다.')
  if (scriptBatch !== undefined && (batch !== undefined || target === 'image')) throw new AiCallError('BAD_REQUEST', '대본 일괄 승인은 이미지 호출에 쓸 수 없습니다.')
  if (scriptBatch !== undefined) validateScriptBatch(scriptBatch, target, input.projectId)
  const plan = planAiCall(target, body, !!qc)
  const unitUsd = qc ? CUT_IMAGE_UNIT_USD : spec.usd
  // 일괄이면 승인 대상(프로젝트·장면 목록·총액)과 이 장면이 맞는지 승인 소비 전에 검증한다
  if (batch !== undefined) {
    validateBatchTerms(batch, String(sceneId), unitUsd)
    // 승인된 장면과 실제 요청의 CUT이 같아야 한다: sceneId scene-NN ↔ cutIndex NN-1
    const cut = body?.input?.cutIndex
    if (!Number.isInteger(cut) || cut < 0 || Number(String(sceneId).slice(6)) !== cut + 1) throw batchError('승인한 장면 번호와 요청의 CUT 번호가 달라 호출하지 않았습니다.')
  }
  // 같은 요청(대상·본문·검수·장면·재실행 식별자; 일괄 id는 제외)의 이전 호출 기록: 결과가 있으면 승인·과금 없이 복구, 불명확하면 자동 재호출 없음.
  const hash = payloadHash({ target, body, qc: qc ?? null, sceneId: sceneId ?? null, projectId: input.projectId ?? null, regenerate: input.regenerate ?? null })
  const flightBase = `ai-flight/${ws}/${hash}`
  // 복구 우선: 저장된 결과 파일이 있으면(복구 기록 저장이 중간에 실패했어도) 그것을 무과금으로 돌려준다.
  const resultRef = `ai-results/${ws}/${hash}.json`
  const stored = await blobs.getBytes(resultRef)
  if (stored) {
    let parsed: any = null
    try { parsed = JSON.parse(stored.toString('utf8')) } catch { /* 읽을 수 없는 저장 결과는 성공으로 취급하지 않는다 */ }
    if (parsed && isComplete(target, parsed)) return res.status(200).json({ ...parsed, recovered: true, budget: null })
    throw new AiCallError('AI_STATE_UNKNOWN', '이전에 받은 결과 파일을 읽지 못했습니다. 과금이 중복되지 않도록 자동으로 다시 호출하지 않았습니다.')
  }
  const prior = await readFlight(blobs, flightBase)
  if (prior.state === 'done') {
    const bytes = await blobs.getBytes(prior.result.ref)
    if (bytes && sha256(bytes) === prior.result.sha256) { try { const parsed = JSON.parse(bytes.toString('utf8')); if (isComplete(target, parsed)) return res.status(200).json({ ...parsed, recovered: true, budget: null }) } catch { /* 아래에서 명시적으로 중단한다 */ } }
    throw new AiCallError('AI_STATE_UNKNOWN', '이전에 받은 결과 파일을 읽지 못했습니다. 과금이 중복되지 않도록 자동으로 다시 호출하지 않았습니다.')
  }
  if (prior.state === 'in_progress') throw new AiCallError('AI_IN_PROGRESS', '같은 AI 요청을 다른 요청이 처리하고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
  if (prior.state === 'unknown') throw new AiCallError('AI_STATE_UNKNOWN', '같은 AI 요청의 처리 여부를 확인할 수 없습니다(이미 호출·과금되었을 수 있음). 자동으로 다시 호출하지 않았습니다.')
  const approval = await requireApproval(blobs, { ws, input, quote: { task: 'cardnews_ai_call', usd: plan.usd, calls: plan.calls, note: plan.note } })
  if (!(await claimFlight(blobs, flightBase, prior.gen))) throw new AiCallError('AI_IN_PROGRESS', '같은 AI 요청을 다른 요청이 처리하고 있습니다. 잠시 뒤 다시 확인해 주세요(중복 호출하지 않았습니다).')
  // 대본 일괄이면 프로젝트·작업 유형·누적 견적 상한을 서버가 강제한다. 넘으면 공급자 호출 없음.
  try { if (scriptBatch !== undefined) await reserveScriptSpend(blobs, { ws, batch: scriptBatch, hash, usd: plan.usd }) }
  catch (e) { await recordFlight(blobs, flightBase, prior.gen, { status: 'failed_safe', reason: 'script_batch_limit' }); throw e }
  // 일괄 제작이면 승인된 총액·장수를 서버가 원자적으로 예약한다(다른 탭·재시도가 한도를 넘길 수 없다). 슬롯이 없으면 공급자 호출 없음.
  try { if (batch !== undefined) await reserveBatchSlot(blobs, { ws, batch, sceneId: String(sceneId), unitUsd }) }
  catch (e) { await recordFlight(blobs, flightBase, prior.gen, { status: 'failed_safe', reason: 'batch_limit' }); throw e }
  let status = 500, output: any, providerCalls = 0, thrown: any = null
  try {
    // 승인된 호출 수(견적의 호출 수에서 검수 몫을 뺀 것)만큼만 공급자에 보낸다.
    const r = await callHandler(spec, body, o.req.headers, plan.calls - (qc ? 1 : 0))
    ;({ status, output } = r); providerCalls = r.used
    // 이미지: 자동 검수는 같은 승인 안에서 한 번만 실행한다. 검수 실패는 이미지 결과를 바꾸지 않는다(검수 없음으로 처리).
    if (qc && status === 200 && isComplete('image', output)) {
      try {
        const q = await callHandler(AI_CALL_TARGETS['gpt-image-qc'], { input: { prompt: qc.prompt, imageBase64: output.image.base64, mimeType: output.image.mimeType || 'image/png', context: qc.context ?? {} } }, o.req.headers, 1)
        providerCalls += q.used
        output = { ...output, qc: q.status === 200 && isComplete('gpt-image-qc', q.output) ? q.output : null }
      } catch (e: any) { providerCalls += Number(e?.providerCalls) || 0; output = { ...output, qc: null } }
    }
  } catch (e: any) { thrown = e; providerCalls = Number(e?.providerCalls) || 0 }
  // 공급자에 아무것도 보내지 않았다면 과금되지 않았으므로 비용 기록도 남기지 않는다. 한 번이라도 보냈다면 실패해도 기록한다.
  const budget = providerCalls > 0 ? await recordSpend(blobs, { ws, approval }) : null
  if (thrown) { await recordFlight(blobs, flightBase, prior.gen, providerCalls === 0 ? { status: 'failed_safe', reason: 'handler_threw_before_provider' } : { status: 'unknown', reason: 'handler_threw' }); throw thrown }
  if (status === 200 && isComplete(target, output)) {
    const bytes = Buffer.from(JSON.stringify(output), 'utf8'), ref = resultRef
    const saved = await retryStore(() => blobs.putBytes(ref, bytes, 'application/json'))
    // 결과 파일과 복구 기록이 모두 저장된 뒤에만 정상 성공을 돌려준다. 하나라도 실패하면 성공이 아니고 자동으로 다시 호출하지 않는다
    // (결과 파일만 저장됐다면 같은 요청이 그 파일부터 복구한다).
    const recorded = saved ? await recordFlight(blobs, flightBase, prior.gen, { status: 'done', ref, sha256: sha256(bytes) }) : false
    if (!saved || !recorded) {
      if (!saved) await recordFlight(blobs, flightBase, prior.gen, { status: 'paid_unsaved', sha256: sha256(bytes) })
      return res.status(502).json({ ok: false, error: { code: 'AI_RESULT_NOT_SAVED', message: 'AI 결과를 서버에 저장하지 못했습니다. 이미 과금되었을 수 있어 자동으로 다시 호출하지 않았습니다.' }, budget })
    }
    return res.status(200).json({ ...output, budget })
  }
  if (status === 200) { // 호출은 나갔는데 필요한 결과가 비어 있다: 성공이 아니고, 자동으로 다시 호출하지 않는다.
    await recordFlight(blobs, flightBase, prior.gen, providerCalls === 0 ? { status: 'failed_safe', reason: 'empty_before_provider' } : { status: 'unknown', reason: 'incomplete_200' })
    return res.status(502).json({ ok: false, error: { code: 'AI_RESULT_INVALID', message: 'AI 응답이 불완전합니다. 이미 과금되었을 수 있어 자동으로 다시 호출하지 않았습니다.' }, budget })
  }
  await recordFlight(blobs, flightBase, prior.gen, providerCalls === 0 ? { status: 'failed_safe', http: status } : { status: 'unknown', reason: `http_${status}` })
  return res.status(status).json(output && typeof output === 'object' && !Array.isArray(output) ? { ...output, budget } : output)
}
