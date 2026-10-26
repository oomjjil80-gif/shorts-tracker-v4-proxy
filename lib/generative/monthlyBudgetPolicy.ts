export const DEFAULT_MONTHLY_BUDGET_USD = 20
export type Provider = 'openai' | 'anthropic' | 'gemini'
export type BudgetQuote = { provider: Provider; estimatedUsd: number; approved: boolean }
export type BudgetState = { spentUsd: number; reservedUsd: number; monthKst: string }
export type BudgetDecision = { allowed: boolean; reason: 'OK' | 'APPROVAL_REQUIRED' | 'INVALID_ESTIMATE' | 'BUDGET_EXCEEDED' | 'INVALID_STATE' | 'MONTH_MISMATCH'; remainingUsd: number }
export function monthInKst(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('invalid date')
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(date).replace(/\D/g, '').slice(0, 6)
}
/**
 * Pure preflight policy. NOT a billing lock or authorization system.
 * Production MUST atomically reserve budget in shared durable storage and verify
 * a server-side, single-use approval bound to quote/job/provider before any API call.
 * No paid call may rely solely on this function or a client-supplied approved flag.
 */
export function evaluateBudget(state: BudgetState, quote: BudgetQuote, now: Date, limitUsd = DEFAULT_MONTHLY_BUDGET_USD): BudgetDecision {
  const used = state.spentUsd + state.reservedUsd
  const remainingUsd = Math.max(0, Number.isFinite(used) && Number.isFinite(limitUsd) ? limitUsd - used : 0)
  if (![state.spentUsd, state.reservedUsd, limitUsd].every(v => Number.isFinite(v) && v >= 0)) return { allowed: false, reason: 'INVALID_STATE', remainingUsd: 0 }
  if (state.monthKst !== monthInKst(now)) return { allowed: false, reason: 'MONTH_MISMATCH', remainingUsd: 0 }
  if (!Number.isFinite(quote.estimatedUsd) || quote.estimatedUsd <= 0 || !['openai','anthropic','gemini'].includes(quote.provider)) return { allowed: false, reason: 'INVALID_ESTIMATE', remainingUsd }
  if (!quote.approved) return { allowed: false, reason: 'APPROVAL_REQUIRED', remainingUsd }
  if (quote.estimatedUsd > remainingUsd) return { allowed: false, reason: 'BUDGET_EXCEEDED', remainingUsd }
  return { allowed: true, reason: 'OK', remainingUsd }
}
