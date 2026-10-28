// 유료 AI 호출 1회 = 서버가 발급한 승인 1개. 같은 승인으로 두 번 호출되지 않는다(더블 클릭·재전송·동시 요청).
//  1) 승인 없는 요청 → 공급자 호출 없이 예상 비용 + 승인 ID 발급(요청 내용 해시에 묶임, 15분 유효)
//  2) 사용자가 승인 → 같은 요청 + approvalId → 서버가 원자적으로 '사용됨'을 먼저 기록(create-once)한 뒤에만 공급자 호출
//  3) 호출이 실패해도 승인은 다시 쓰지 않는다(이미 과금됐을 수 있음) → 다시 하려면 새 승인
// 월 $20은 경고 기준일 뿐 차단하지 않는다. 비용 기록은 워크스페이스·월(KST)별로 남긴다.
// 저장소는 기존 JobBlobStore(R2 조건부 PUT / Vercel Blob allowOverwrite:false)라 DB 마이그레이션이 필요 없다.
import { createHash, randomUUID } from 'node:crypto'
import type { JobBlobStore } from '../jobs/blobs.js'
import { DEFAULT_MONTHLY_WARNING_USD, monthInKst } from './monthlyBudgetPolicy.js'

export class ApprovalError extends Error { constructor(public code: 'COST_APPROVAL_REQUIRED' | 'APPROVAL_USED' | 'APPROVAL_MISMATCH' | 'APPROVAL_EXPIRED', message: string, public extra: Record<string, unknown> = {}) { super(message) } }
export type Quote = { task: string; usd: number; calls?: number; note?: string }
export type Approval = { approvalId: string; ws: string; task: string; payloadHash: string; usd: number; issuedAt: string; expiresAt: string }
const TTL_MS = 15 * 60 * 1000
const APPROVAL_FIELDS = new Set(['taskType', 'costApproved', 'approvedUsd', 'approvalId'])
const stable = (v: any): any => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v)
// 승인이 묶이는 '요청 내용': 승인 관련 필드를 뺀 나머지 전부. 내용을 바꿔 같은 승인을 다른 호출에 쓰는 것을 막는다.
export const payloadHash = (input: any) => createHash('sha256').update(JSON.stringify(stable(Object.fromEntries(Object.entries(input && typeof input === 'object' ? input : {}).filter(([k]) => !APPROVAL_FIELDS.has(k)))))).digest('hex')
const okId = (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const path = (ws: string, id: string, kind: 'issued' | 'used') => `paid-approvals/${ws}/${id}.${kind}.json`

export async function requireApproval(blobs: JobBlobStore, o: { ws: string; input: any; quote: Quote; now?: Date }): Promise<Approval> {
  const now = o.now ?? new Date(), hash = payloadHash(o.input), id = o.input?.approvalId
  const issue = async (code: ApprovalError['code'] = 'COST_APPROVAL_REQUIRED', message = '예상 비용을 확인하고 승인해야 AI를 호출합니다.') => {
    const a: Approval = { approvalId: randomUUID(), ws: o.ws, task: o.quote.task, payloadHash: hash, usd: o.quote.usd, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MS).toISOString() }
    // A fresh UUID has no legacy object to read. Create atomically on the active store,
    // without turning a legacy access error into a missing-file result.
    if (!blobs.claim) throw new Error('approval store cannot claim atomically')
    if (!(await blobs.claim(path(o.ws, a.approvalId, 'issued'), a))) throw new Error('approval ID already exists')
    throw new ApprovalError(code, message, { estimate: { ...o.quote, confirmed: false }, approval: { approvalId: a.approvalId, usd: a.usd, expiresAt: a.expiresAt } })
  }
  if (!okId(id)) return issue()
  const a = await blobs.getJson<Approval>(path(o.ws, id, 'issued'))
  if (!a || a.ws !== o.ws) return issue()
  if (a.task !== o.quote.task || a.payloadHash !== hash || o.quote.usd > a.usd + 1e-9) return issue('APPROVAL_MISMATCH', '승인한 내용·비용과 요청이 달라 호출하지 않았습니다. 다시 승인해 주세요.')
  if (Date.parse(a.expiresAt) <= now.getTime()) return issue('APPROVAL_EXPIRED', '승인이 만료되어 호출하지 않았습니다. 다시 승인해 주세요.')
  if (!blobs.claim) throw new Error('approval store cannot claim atomically')
  // 원자적 '사용됨' 기록: 동시에 들어온 같은 승인 중 단 하나만 통과한다.
  if (!(await blobs.claim(path(o.ws, id, 'used'), { approvalId: id, usedAt: now.toISOString() }))) throw new ApprovalError('APPROVAL_USED', '이 승인은 이미 사용되었습니다(중복 호출 차단). 같은 요청이 진행 중이거나 완료되었습니다.')
  return a
}

// 비용 기록(경고용): 월별 누적 예상 비용. 경고만 하고 차단하지 않는다. 기록 실패는 호출 결과를 바꾸지 않는다.
export async function recordSpend(blobs: JobBlobStore, o: { ws: string; approval: Approval; now?: Date; warningUsd?: number }) {
  const month = monthInKst(o.now ?? new Date()), p = `ai-spend/${o.ws}/${month}.json`, warningUsd = o.warningUsd ?? DEFAULT_MONTHLY_WARNING_USD
  try {
    const cur = (await blobs.getJson<{ usd: number; calls: number; items: any[] }>(p)) ?? { usd: 0, calls: 0, items: [] }
    if (!cur.items.some((x) => x.approvalId === o.approval.approvalId)) {
      cur.usd = Math.round((cur.usd + o.approval.usd) * 1e6) / 1e6; cur.calls += 1
      cur.items = [...cur.items, { approvalId: o.approval.approvalId, task: o.approval.task, usd: o.approval.usd, at: (o.now ?? new Date()).toISOString() }].slice(-500)
      await blobs.putJson(p, cur, { overwrite: true })
    }
    return { month, monthUsd: cur.usd, warningUsd, warning: cur.usd >= warningUsd }
  } catch { return { month, monthUsd: null, warningUsd, warning: false } }
}
