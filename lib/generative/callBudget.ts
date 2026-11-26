// 승인된 공급자 호출 횟수 상한을 "공급자 호출 직전"에 서버에서 강제한다(핸들러 내부의 분할 작성·재시도·재생성까지 포함).
// 승인 범위 안에서만 fetch가 나가고, 상한을 넘기려는 호출은 네트워크에 닿기 전에 막힌다. 호출 횟수(used)는 호출 시도 직전에 올라가므로
// used === 0 이면 공급자에 아무것도 보내지 않았음이 확실하다(실패 분류의 근거).
import { AsyncLocalStorage } from 'node:async_hooks'

type Budget = { max: number; used: number }
const store = new AsyncLocalStorage<Budget>()
const GUARD = Symbol.for('tracker.callBudgetGuard')
export class CallLimitError extends Error { constructor(public max: number) { super(`승인된 AI 호출 횟수(${max}회)를 넘는 호출은 실행하지 않았습니다.`); this.name = 'CallLimitError' } }

function install() {
  const current: any = globalThis.fetch
  if (current?.[GUARD]) return
  const inner = current
  const guarded: any = (...args: Parameters<typeof fetch>) => {
    const b = store.getStore()
    if (b) { if (b.used >= b.max) return Promise.reject(new CallLimitError(b.max)); b.used += 1 }
    return inner(...args)
  }
  guarded[GUARD] = true
  globalThis.fetch = guarded
}

export async function withCallBudget<T>(max: number, fn: () => Promise<T>): Promise<{ value: T; used: number }> {
  install()
  const budget: Budget = { max: Math.max(0, Math.floor(max)), used: 0 }
  const value = await store.run(budget, fn).catch((e) => { (e as any).providerCalls = budget.used; throw e })
  return { value, used: budget.used }
}
