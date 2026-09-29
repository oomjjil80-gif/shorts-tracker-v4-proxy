import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import type { SourceAnalysis } from '../../lib/media/analyze.js'
import { aiPlanVariants, AI_PLANNER_PROMPT_VERSION } from '../../lib/media/aiPlanner.js'
import { callSemanticPlanProxy } from '../../lib/media/semanticPlan.js'
import { planVariants, toJobPlan, validateVariant, type VariantSpec } from '../../lib/media/plan.js'
import { StageError, type StageExecutor } from '../types.js'

export const AI_PLANNER_BUDGET_RESERVE_USD = 0.05

export type PlanExecutorOptions = {
  openAi?: { apiKey: string; model: string; fetchImpl?: typeof fetch } | null
  semanticProxy?: { endpoint: string; authSecret: string; fetchImpl?: typeof fetch; timeoutMs?: number } | null
}

// PLAN: SourceAnalysis -> 1..3 JobPlans. Deterministic planner always runs; a model may refine it when explicitly
// configured. Production's semantic proxy is intentionally opt-in so deploying this code alone can never start paid AI.
// A model failure never blocks the job: it falls back to the deterministic plan and records why.
export function createPlanExecutor(options: PlanExecutorOptions = {}): StageExecutor {
  const aiEnabled = !!(options.openAi || options.semanticProxy)
  const aiIdentity = options.semanticProxy ? 'semantic-proxy' : options.openAi?.model ?? 'heuristic'
  return {
    stage: 'PLAN',
    estimateUsd: () => (aiEnabled ? AI_PLANNER_BUDGET_RESERVE_USD : 0),
    inputHash: (job) => sha256(`plan|${job.id}|${job.sourceAssetId}|${aiIdentity}|${AI_PLANNER_PROMPT_VERSION}`),
    async run({ job, blobs, previous }) {
      const prev = await previous('ANALYZE')
      if (!prev?.outputRef) throw new StageError('ANALYSIS_MISSING', 'PLAN requires a completed ANALYZE stage')
      const analysis = await blobs.getJson<SourceAnalysis>(prev.outputRef)
      if (!analysis || analysis.schema !== 'source-analysis/1') throw new StageError('ANALYSIS_INVALID', 'analysis blob missing or wrong schema')
      if (analysis.sourceAssetId !== job.sourceAssetId) throw new StageError('ANALYSIS_MISMATCH', 'analysis belongs to a different source')

      let variants: VariantSpec[] = planVariants(analysis)
      let provider = 'heuristic', model = 'deterministic@1', fallback: { reason: string } | null = null, usage: unknown = null, costUsd = 0, promptVersion: string | null = null
      const sheetRef = ((prev.result as any)?.contactSheetRef as string | undefined) ?? null
      if (options.semanticProxy) {
        // The proxy runs inside the existing Vercel story function, where the provider credential already exists.
        // Railway sends only a short-lived HMAC proof derived from the already-shared private Blob credential.
        costUsd = AI_PLANNER_BUDGET_RESERVE_USD
        try {
          const ai = await callSemanticPlanProxy(analysis, variants, {
            ...options.semanticProxy, jobId: job.id, sourceAssetId: job.sourceAssetId, analysisRef: prev.outputRef, contactSheetRef: sheetRef
          })
          variants = ai.variants; provider = 'openai'; model = ai.model; usage = ai.usage; promptVersion = ai.promptVersion
        } catch (e: any) { fallback = { reason: `semantic-proxy: ${String(e?.message || e).slice(0, 260)}` } }
      } else if (options.openAi) {
        costUsd = AI_PLANNER_BUDGET_RESERVE_USD
        try {
          const sheet = sheetRef ? await blobs.getBytes(sheetRef) : null
          const ai = await aiPlanVariants(analysis, variants, { ...options.openAi, contactSheetJpeg: sheet })
          variants = ai.variants; provider = 'openai'; model = ai.model; usage = ai.usage; promptVersion = AI_PLANNER_PROMPT_VERSION
        } catch (e: any) { fallback = { reason: `direct-openai: ${String(e?.message || e).slice(0, 260)}` } }
      }
      const bad = variants.flatMap((v) => validateVariant(v, analysis).map((m) => `${v.id}: ${m}`))
      if (bad.length) throw new StageError('PLAN_INVALID', bad.join('; '))
      if (!variants.length) throw new StageError('PLAN_EMPTY', 'planner produced no variants')

      const stored = []
      for (const v of variants) {
        const s = await putAddressed(blobs, 'plans', toJobPlan(job.sourceAssetId, v))
        stored.push({ variantId: v.id, label: v.label, rationale: v.rationale, planRef: s.path, seconds: v.beats.reduce((t, b) => t + (b.trimEnd - b.trimStart), 0) })
      }
      return {
        outputRef: stored[0].planRef, outputHash: sha256(stored.map((s) => s.planRef).join('|')), planRef: stored[0].planRef,
        result: { variants: stored, provider, model, promptVersion, fallback },
        provider, model, usage, costUsd
      }
    }
  }
}
