import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalize } from '../tracker-core/renderManifest.js'
import type { JobBlobStore } from '../jobs/blobs.js'
import type { SourceAnalysis } from './analyze.js'
import { aiAnalyzeStory, AI_PLANNER_PROMPT_VERSION } from './aiPlanner.js'
import { validateStory, type SemanticResult, type StoryAnalysis } from './story.js'

export const SEMANTIC_STORY_TASK = 'job_story_semantic' as const
export const SEMANTIC_STORY_AUTH_VERSION = 'p1-semantic-story-auth/1' as const
const MAX_FUTURE_MS = 5 * 60_000

export type SemanticStoryUnsignedRequest = {
  taskType: typeof SEMANTIC_STORY_TASK
  authVersion: typeof SEMANTIC_STORY_AUTH_VERSION
  jobId: string
  sourceAssetId: string
  analysisRef: string
  keyframeSheetRef: string
  expiresAt: number
}
export type SemanticStoryRequest = SemanticStoryUnsignedRequest & { proof: string }
export type SemanticStoryResponse = {
  ok: true
  status: SemanticResult['status']
  reason: string | null
  story: StoryAnalysis | null
  model: string
  usage: unknown
  warnings: string[]
  promptVersion: string
}

function unsigned(input: SemanticStoryRequest | SemanticStoryUnsignedRequest): SemanticStoryUnsignedRequest {
  return {
    taskType: SEMANTIC_STORY_TASK,
    authVersion: SEMANTIC_STORY_AUTH_VERSION,
    jobId: String(input.jobId),
    sourceAssetId: String(input.sourceAssetId),
    analysisRef: String(input.analysisRef),
    keyframeSheetRef: String(input.keyframeSheetRef),
    expiresAt: Number(input.expiresAt)
  }
}

export function createSemanticStoryProof(secret: string, input: SemanticStoryRequest | SemanticStoryUnsignedRequest): string {
  if (!secret) throw new Error('semantic story auth secret is missing')
  return createHmac('sha256', secret).update(canonicalize(unsigned(input))).digest('hex')
}

export function verifySemanticStoryProof(secret: string, input: SemanticStoryRequest, now = Date.now()): boolean {
  if (!secret || !/^[0-9a-f]{64}$/.test(String(input.proof || ''))) return false
  const exp = Number(input.expiresAt)
  if (!Number.isFinite(exp) || exp < now - 30_000 || exp > now + MAX_FUTURE_MS) return false
  const expected = Buffer.from(createSemanticStoryProof(secret, input), 'hex')
  const actual = Buffer.from(input.proof, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function validateRequestShape(input: SemanticStoryRequest) {
  if (input.taskType !== SEMANTIC_STORY_TASK || input.authVersion !== SEMANTIC_STORY_AUTH_VERSION) throw new Error('invalid semantic story request version')
  if (!/^job_[0-9a-f-]{20,80}$/i.test(input.jobId)) throw new Error('invalid jobId')
  if (!/^src_[A-Za-z0-9_]{8,120}$/.test(input.sourceAssetId)) throw new Error('invalid sourceAssetId')
  if (!/^analysis\/[0-9a-f]{64}\.json$/.test(input.analysisRef)) throw new Error('invalid analysisRef')
  if (!/^analysis\/keyframes\/[0-9a-f]{64}\.jpg$/.test(input.keyframeSheetRef)) throw new Error('invalid keyframeSheetRef')
}

export async function callSemanticStoryProxy(
  analysis: SourceAnalysis,
  options: {
    endpoint: string
    authSecret: string
    jobId: string
    sourceAssetId: string
    analysisRef: string
    keyframeSheetRef: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
    now?: () => number
  }
): Promise<SemanticStoryResponse> {
  const expiresAt = (options.now ?? Date.now)() + 2 * 60_000
  const req: SemanticStoryUnsignedRequest = {
    taskType: SEMANTIC_STORY_TASK,
    authVersion: SEMANTIC_STORY_AUTH_VERSION,
    jobId: options.jobId,
    sourceAssetId: options.sourceAssetId,
    analysisRef: options.analysisRef,
    keyframeSheetRef: options.keyframeSheetRef,
    expiresAt
  }
  const body: SemanticStoryRequest = { ...req, proof: createSemanticStoryProof(options.authSecret, req) }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? 60_000)
  try {
    const res = await (options.fetchImpl ?? fetch)(options.endpoint, {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const data: any = await res.json().catch(() => null)
    if (!res.ok || !data?.ok) throw new Error(`semantic story proxy ${res.status}: ${data?.error?.message || 'error'}`)
    const status = String(data.status || '') as SemanticResult['status']
    if (!['ok', 'unavailable', 'failed', 'invalid', 'low_confidence'].includes(status)) throw new Error(`semantic story proxy returned invalid status: ${status || '(empty)'}`)
    let story: StoryAnalysis | null = null
    if (data.story) {
      const checked = validateStory(data.story, analysis, { model: String(data.model || 'unknown'), promptVersion: String(data.promptVersion || AI_PLANNER_PROMPT_VERSION) })
      if (!checked.story) throw new Error(`semantic story proxy returned invalid story: ${checked.errors.join('; ')}`)
      story = checked.story
    }
    if (status === 'ok' && !story) throw new Error('semantic story proxy returned ok without a story')
    return {
      ok: true,
      status,
      reason: data.reason == null ? null : String(data.reason).slice(0, 500),
      story,
      model: String(data.model || 'unknown'),
      usage: data.usage ?? null,
      warnings: Array.isArray(data.warnings) ? data.warnings.map((x: any) => String(x).slice(0, 300)).slice(0, 20) : [],
      promptVersion: String(data.promptVersion || AI_PLANNER_PROMPT_VERSION)
    }
  } finally { clearTimeout(timer) }
}

export async function runSemanticStoryService(input: SemanticStoryRequest, deps: {
  authSecret: string
  apiKey: string
  model: string
  blobs: JobBlobStore
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<SemanticStoryResponse> {
  validateRequestShape(input)
  if (!verifySemanticStoryProof(deps.authSecret, input, (deps.now ?? Date.now)())) throw new Error('semantic story authorization failed')
  if (!deps.apiKey) throw new Error('semantic story provider is not configured')

  const analysis = await deps.blobs.getJson<SourceAnalysis>(input.analysisRef)
  if (!analysis || analysis.schema !== 'source-analysis/1' || analysis.sourceAssetId !== input.sourceAssetId) throw new Error('analysis/source mismatch')
  const sheet = await deps.blobs.getBytes(input.keyframeSheetRef)
  if (!sheet) throw new Error('keyframe sheet missing')

  const result = await aiAnalyzeStory(analysis, {
    apiKey: deps.apiKey,
    model: deps.model,
    fetchImpl: deps.fetchImpl,
    keyframeJpeg: sheet,
    timeoutMs: 50_000
  })
  return {
    ok: true,
    status: result.status,
    reason: result.reason,
    story: result.story,
    model: result.model,
    usage: result.usage,
    warnings: result.warnings,
    promptVersion: AI_PLANNER_PROMPT_VERSION
  }
}
