export const DEFAULT_MONTHLY_WARNING_USD = 20
export type Provider = 'openai' | 'anthropic' | 'gemini'
export type BudgetQuote = { provider: Provider; estimatedUsd: number; approved: boolean }
export type BudgetState = { spentUsd: number; reservedUsd: number; monthKst: string }
export type BudgetDecision = { allowed: boolean; warning: boolean; reason: 'OK' | 'WARNING_THRESHOLD' | 'APPROVAL_REQUIRED' | 'INVALID_ESTIMATE' | 'INVALID_STATE' | 'MONTH_MISMATCH'; remainingToWarningUsd: number }
export function monthInKst(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('invalid date')
  const parts = new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit' }).formatToParts(date)
  const year = parts.find(p=>p.type==='year')?.value
  const month = parts.find(p=>p.type==='month')?.value
  if (!year || !month) throw new Error('invalid KST month')
  return year+month
}
/** USD 20 is an advisory warning, not a spending cap.
 * The approved flag is only a preflight hint, NOT authorization.
 * Real calls require authenticated server-side single-use approval.
 */
export function evaluateBudget(state:BudgetState,quote:BudgetQuote,now:Date,warningUsd=DEFAULT_MONTHLY_WARNING_USD):BudgetDecision {
  const used=state.spentUsd+state.reservedUsd
  const remainingToWarningUsd=Math.max(0,Number.isFinite(used)&&Number.isFinite(warningUsd)?warningUsd-used:0)
  const deny=(reason:BudgetDecision['reason']):BudgetDecision=>({allowed:false,warning:false,reason,remainingToWarningUsd})
  if (![state.spentUsd,state.reservedUsd,warningUsd].every(v=>Number.isFinite(v)&&v>=0)) return deny('INVALID_STATE')
  if(state.monthKst!==monthInKst(now)) return deny('MONTH_MISMATCH')
  if(!Number.isFinite(quote.estimatedUsd)||quote.estimatedUsd<=0||!['openai','anthropic','gemini'].includes(quote.provider)) return deny('INVALID_ESTIMATE')
  if(!quote.approved) return deny('APPROVAL_REQUIRED')
  const warning=used+quote.estimatedUsd>=warningUsd
  return {allowed:true,warning,reason:warning?'WARNING_THRESHOLD':'OK',remainingToWarningUsd}
}
