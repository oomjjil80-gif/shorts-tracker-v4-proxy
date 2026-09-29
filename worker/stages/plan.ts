import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import type { SourceAnalysis } from '../../lib/media/analyze.js'
import { aiPlanVariants, AI_PLANNER_PROMPT_VERSION } from '../../lib/media/aiPlanner.js'
import { planVariants, toJobPlan, validateVariant, type VariantSpec } from '../../lib/media/plan.js'
import { StageError, type StageExecutor } from '../types.js'

export type PlanExecutorOptions = { openAi?: { apiKey: string; model: string; fetchImpl?: typeof fetch } | null }

// PLAN: SourceAnalysis -> 1..3 JobPlans. Deterministic planner always runs; a model may refine it when configured.
// A model failure never blocks the job: it falls back to the deterministic plan and the reason is recorded.
export function createPlanExecutor(options: PlanExecutorOptions = {}): StageExecutor {
  return {
    stage: 'PLAN',
    estimateUsd: () => (options.openAi ? 0.05 : 0),
    inputHash: (job) => sha256(`plan|${job.id}|${job.sourceAssetId}|${options.openAi?.model ?? 'heuristic'}`),
    async run({ job, blobs, previous }) {
      const prev = await previous('ANALYZE')
      if (!prev?.outputRef) throw new StageError('ANALYSIS_MISSING', 'PLAN requires a completed ANALYZE stage')
      const analysis = await blobs.getJson<SourceAnalysis>(prev.outputRef)
      if (!analysis || analysis.schema !== 'source-analysis/1') throw new StageError('ANALYSIS_INVALID', 'analysis blob missing or wrong schema')
      if (analysis.sourceAssetId !== job.sourceAssetId) throw new StageError('ANALYSIS_MISMATCH', 'analysis belongs to a different source')

      let variants: VariantSpec[] = planVariants(analysis)
      let provider = 'heuristic', model = 'deterministic@1', fallback: { reason: string } | null = null, usage: unknown = null, costUsd = 0
      if (options.openAi) {
        try {
          const sheetRef = (prev.result as any)?.contactSheetRef as string | undefined
          const sheet = sheetRef ? await blobs.getBytes(sheetRef) : null
          const ai = await aiPlanVariants(analysis, variants, { ...options.openAi, contactSheetJpeg: sheet })
          variants = ai.variants; provider = 'openai'; model = ai.model; usage = ai.usage
        } catch (e: any) { fallback = { reason: String(e?.message || e).slice(0, 300) } }
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
        result: { variants: stored, provider, model, promptVersion: options.openAi ? AI_PLANNER_PROMPT_VERSION : null, fallback },
        provider, model, usage, costUsd
      }
    }
  }
}
