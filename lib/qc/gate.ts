// Common QC Gate. A required check passes ONLY with status PASS.
// FAIL and UNKNOWN both block. Exceptions, timeouts, unparsable model output and a check that could not run
// are UNKNOWN, never PASS. A gate with no required check cannot pass ("nothing was checked" is not "checked").

export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN'
export type CheckResult = { id: string; required: boolean; status: CheckStatus; evidence: unknown }
export type GateDecision = 'PASS' | 'BLOCK'
export type GateResult = {
  decision: GateDecision
  reasons: string[]
  counts: { pass: number; fail: number; unknown: number; requiredPass: number; requiredTotal: number }
  checks: CheckResult[]
}

export function normalizeStatus(raw: unknown): CheckStatus {
  return raw === 'PASS' || raw === 'FAIL' ? raw : 'UNKNOWN'
}

export function evaluateGate(input: ReadonlyArray<Partial<CheckResult> & { id?: string }>): GateResult {
  const checks: CheckResult[] = (Array.isArray(input) ? input : []).map((c, i) => ({
    id: String(c?.id || `check_${i + 1}`),
    required: c?.required !== false, // a check is required unless it explicitly says otherwise
    status: normalizeStatus(c?.status),
    evidence: c?.evidence ?? null
  }))
  const reasons: string[] = []
  const required = checks.filter((c) => c.required)
  if (required.length === 0) reasons.push('NO_REQUIRED_CHECKS: nothing was verified')
  const seen = new Set<string>()
  for (const c of checks) {
    if (seen.has(c.id)) reasons.push(`DUPLICATE_CHECK_ID: ${c.id}`)
    seen.add(c.id)
  }
  for (const c of required) if (c.status !== 'PASS') reasons.push(`${c.status}: ${c.id}`)
  return {
    decision: reasons.length === 0 ? 'PASS' : 'BLOCK',
    reasons,
    counts: {
      pass: checks.filter((c) => c.status === 'PASS').length,
      fail: checks.filter((c) => c.status === 'FAIL').length,
      unknown: checks.filter((c) => c.status === 'UNKNOWN').length,
      requiredPass: required.filter((c) => c.status === 'PASS').length,
      requiredTotal: required.length
    },
    checks
  }
}

// Runs one check. Anything other than an explicit PASS/FAIL verdict becomes UNKNOWN.
export async function runCheck(
  id: string,
  required: boolean,
  fn: () => Promise<{ status: CheckStatus; evidence?: unknown }> | { status: CheckStatus; evidence?: unknown },
  opts: { timeoutMs?: number } = {}
): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = Promise.resolve().then(fn)
    const out = await (opts.timeoutMs
      ? Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`check timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs) })])
      : work)
    const status = normalizeStatus(out?.status)
    return { id, required, status, evidence: status === 'UNKNOWN' ? { reason: 'check returned no PASS/FAIL verdict', returned: out?.status ?? null, ...(out?.evidence ? { evidence: out.evidence } : {}) } : out?.evidence ?? null }
  } catch (e: any) {
    return { id, required, status: 'UNKNOWN', evidence: { error: String(e?.message || e) } }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runGate(checks: Array<() => Promise<CheckResult>>): Promise<GateResult> {
  return evaluateGate(await Promise.all(checks.map((c) => c())))
}
