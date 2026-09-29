import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalize } from '../tracker-core/renderManifest.js'
import type { JobBlobStore } from '../jobs/blobs.js'
import type { SourceAnalysis } from './analyze.js'
import { aiPlanVariants, AI_PLANNER_PROMPT_VERSION } from './aiPlanner.js'
import { validateVariant, type VariantSpec } from './plan.js'

export const SEMANTIC_PLAN_TASK = 'job_plan_semantic' as const
export const SEMANTIC_PLAN_AUTH_VERSION = 'p1-semantic-plan-auth/1'
export const SEMANTIC_PLAN_MAX_FUTURE_MS = 5 * 60_000

export type SemanticPlanUnsignedRequest = {
  taskType: typeof SEMANTIC_PLAN_TASK
  authVersion: typeof SEMANTIC_PLAN_AUTH_VERSION
  jobId: string
  sourceAssetId: string
  analysisRef: string
  contactSheetRef: string | null
  baseline: VariantSpec[]
  expiresAt: number
}
export type SemanticPlanRequest = SemanticPlanUnsignedRequest & { proof: string }

export type SemanticPlanResponse = {
  ok: true
  variants: VariantSpec[]
  provider: 'openai'
  model: string
  usage: unknown
  promptVersion: string
}

export function semanticPlanUnsigned(input: SemanticPlanRequest | SemanticPlanUnsignedRequest): SemanticPlanUnsignedRequest {
  return {
    taskType: SEMANTIC_PLAN_TASK,
    authVersion: SEMANTIC_PLAN_AUTH_VERSION,
    jobId: String(input.jobId),
    sourceAssetId: String(input.sourceAssetId),
    analysisRef: String(input.analysisRef),
    contactSheetRef: input.contactSheetRef ? String(input.contactSheetRef) : null,
    baseline: input.baseline,
    expiresAt: Number(input.expiresAt)
  }
}

export function createSemanticPlanProof(secret: string, input: SemanticPlanUnsignedRequest | SemanticPlanRequest): string {
  if (!secret) throw new Error('semantic planner auth secret is missing')
  return createHmac('sha256', secret).update(canonicalize(semanticPlanUnsigned(input))).digest('hex')
}

export function verifySemanticPlanProof(secret: string, input: SemanticPlanRequest, now = Date.now()): boolean {
  if (!secret || !/^[0-9a-f]{64}$/.test(String(input.proof || ''))) return false
  const exp = Number(input.expiresAt)
  if (!Number.isFinite(exp) || exp < now - 30_000 || exp > now + SEMANTIC_PLAN_MAX_FUTURE_MS) return false
  const expected = Buffer.from(createSemanticPlanProof(secret, input), 'hex')
  const actual = Buffer.from(input.proof, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function validateRequestShape(input: SemanticPlanRequest) {
  if (input.taskType !== SEMANTIC_PLAN_TASK || input.authVersion !== SEMANTIC_PLAN_AUTH_VERSION) throw new Error('invalid semantic planner request version')
  if (!/^job_[0-9a-f-]{20,80}$/i.test(input.jobId)) throw new Error('invalid jobId')
  if (!/^src_[A-Za-z0-9_]{8,120}$/.test(input.sourceAssetId)) throw new Error('invalid sourceAssetId')
  if (!/^analysis\/[0-9a-f]{64}\.json$/.test(input.analysisRef)) throw new Error('invalid analysisRef')
  if (input.contactSheetRef && !/^analysis\/contact\/[0-9a-f]{64}\.jpg$/.test(input.contactSheetRef)) throw new Error('invalid contactSheetRef')
  if (!Array.isArray(input.baseline) || input.baseline.length < 1 || input.baseline.length > 3) throw new Error('baseline must contain 1-3 variants')
}

export async function callSemanticPlanProxy(
  analysis: SourceAnalysis,
  baseline: VariantSpec[],
  options: {
    endpoint: string; authSecret: string; jobId: string; sourceAssetId: string; analysisRef: string; contactSheetRef?: string | null
    fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number
  }
): Promise<{ variants: VariantSpec[]; model: string; usage: unknown; promptVersion: string }> {
  const expiresAt = (options.now ?? Date.now)() + 2 * 60_000
  const unsigned: SemanticPlanUnsignedRequest = {
    taskType: SEMANTIC_PLAN_TASK, authVersion: SEMANTIC_PLAN_AUTH_VERSION, jobId: options.jobId, sourceAssetId: options.sourceAssetId,
    analysisRef: options.analysisRef, contactSheetRef: options.contactSheetRef ?? null, baseline, expiresAt
  }
  const body: SemanticPlanRequest = { ...unsigned, proof: createSemanticPlanProof(options.authSecret, unsigned) }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? 75_000)
  try {
    const res = await (options.fetchImpl ?? fetch)(options.endpoint, {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const data: any = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) throw new Error(`semantic planner proxy ${res.status}: ${data?.error?.message || 'error'}`)
    const variants = Array.isArray(data.variants) ? data.variants as VariantSpec[] : []
    const bad = variants.flatMap((v) => validateVariant(v, analysis).map((m) => `${v?.id || '?'}: ${m}`))
    if (!variants.length || bad.length) throw new Error(`semantic planner proxy returned invalid variants: ${bad.join('; ') || 'empty'}`)
    return { variants, model: String(data.model || 'unknown'), usage: data.usage ?? null, promptVersion: String(data.promptVersion || AI_PLANNER_PROMPT_VERSION) }
  } finally { clearTimeout(timer) }
}

export async function runSemanticPlanService(input: SemanticPlanRequest, deps: {
  authSecret: string
  apiKey: string
  model: string
  blobs: JobBlobStore
  getSourceAsset: (id: string) => Promise<{ sourceAssetId: string; title?: string | null; platform?: string | null }>
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<SemanticPlanResponse> {
  validateRequestShape(input)
  if (!verifySemanticPlanProof(deps.authSecret, input, (deps.now ?? Date.now)())) throw new Error('semantic planner authorization failed')
  if (!deps.apiKey) throw new Error('semantic planner provider is not configured')

  const analysis = await deps.blobs.getJson<SourceAnalysis>(input.analysisRef)
  if (!analysis || analysis.schema !== 'source-analysis/1' || analysis.sourceAssetId !== input.sourceAssetId) throw new Error('analysis/source mismatch')
  const baselineErrors = input.baseline.flatMap((v) => validateVariant(v, analysis).map((m) => `${v?.id || '?'}: ${m}`))
  if (baselineErrors.length) throw new Error(`invalid baseline: ${baselineErrors.join('; ')}`)
  const source = await deps.getSourceAsset(input.sourceAssetId)
  if (!source || source.sourceAssetId !== input.sourceAssetId) throw new Error('source registry mismatch')
  const contactSheet = input.contactSheetRef ? await deps.blobs.getBytes(input.contactSheetRef) : null
  if (input.contactSheetRef && !contactSheet) throw new Error('contact sheet missing')

  const result = await aiPlanVariants(analysis, input.baseline, {
    apiKey: deps.apiKey, model: deps.model, fetchImpl: deps.fetchImpl, contactSheetJpeg: contactSheet,
    sourceTitle: source.title ?? null, sourcePlatform: source.platform ?? null, timeoutMs: 65_000
  })
  return { ok: true, variants: result.variants, provider: 'openai', model: result.model, usage: result.usage, promptVersion: AI_PLANNER_PROMPT_VERSION }
}
