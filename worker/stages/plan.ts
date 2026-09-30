import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import type { SourceAnalysis } from '../../lib/media/analyze.js'
import { aiAnalyzeStory, AI_PLANNER_PROMPT_VERSION } from '../../lib/media/aiPlanner.js'
import { planVariants, toJobPlan, validateVariant } from '../../lib/media/plan.js'
import type { SemanticResult } from '../../lib/media/story.js'
import { StageError, type StageExecutor } from '../types.js'
import { applyReferencePlanConstraints } from '../../lib/reference/planBridge.js'
import type { ReferenceProfile } from '../../lib/reference/contracts.js'

export type PlanExecutorOptions = { openAi?: { apiKey: string; model: string; fetchImpl?: typeof fetch } | null; referenceProfile?: ReferenceProfile | null; resolveReferenceProfile?: (job:any, blobs:any)=>Promise<ReferenceProfile|null> }

// PLAN: SourceAnalysis (+ semantic story analysis when a vision model is configured) -> 1..3 JobPlans.
// The semantic result is stored and recorded as-is (ok / unavailable / failed / invalid / low_confidence); the planner
// only uses it when ok. A missing/failed model never blocks the job, but it also never becomes a content PASS later.
export function createPlanExecutor(options: PlanExecutorOptions = {}): StageExecutor {
  return {
    stage: 'PLAN',
    estimateUsd: () => (options.openAi ? 0.05 : 0),
    inputHash: (job) => sha256(`plan|${job.id}|${job.sourceAssetId}|${job.referenceProfileRef ?? 'no-reference'}|${options.openAi?.model ?? 'heuristic'}|${AI_PLANNER_PROMPT_VERSION}`),
    async run({ job, blobs, previous }) {
      const prev = await previous('ANALYZE')
      if (!prev?.outputRef) throw new StageError('ANALYSIS_MISSING', 'PLAN requires a completed ANALYZE stage')
      const analysis = await blobs.getJson<SourceAnalysis>(prev.outputRef)
      if (!analysis || analysis.schema !== 'source-analysis/1') throw new StageError('ANALYSIS_INVALID', 'analysis blob missing or wrong schema')
      if (analysis.sourceAssetId !== job.sourceAssetId) throw new StageError('ANALYSIS_MISMATCH', 'analysis belongs to a different source')

      let semantic: SemanticResult = { status: 'unavailable', reason: 'no semantic model configured', story: null }
      let provider = 'heuristic', model = 'deterministic@2', usage: unknown = null, warnings: string[] = []
      if (options.openAi) {
        const sheetRef = (prev.result as any)?.keyframeSheetRef as string | undefined
        const sheet = sheetRef ? await blobs.getBytes(sheetRef) : null
        const r = await aiAnalyzeStory(analysis, { ...options.openAi, keyframeJpeg: sheet })
        semantic = { status: r.status, reason: r.reason, story: r.story }
        usage = r.usage; warnings = r.warnings
        if (r.status === 'ok') { provider = 'openai'; model = r.model }
      }
      const storyRef = semantic.story ? (await putAddressed(blobs, 'stories', semantic.story)).path : null
      const storySummary = semantic.story ? {
        storyType: semantic.story.storyType,
        confidence: semantic.story.confidence,
        causalStart: semantic.story.causalStart,
        setupRanges: semantic.story.setupRanges,
        escalationRanges: semantic.story.escalationRanges,
        payoffRange: semantic.story.payoffRange,
        recommendedEnd: semantic.story.recommendedEnd,
        excludeRanges: semantic.story.excludeRanges,
        hookStrategy: semantic.story.hookStrategy,
        previewRange: semantic.story.previewRange
      } : null
      console.info(`[plan] job=${job.id} semantic=${semantic.status} provider=${provider} story=${JSON.stringify(storySummary)}`)

      let variants
      try { variants = planVariants(analysis, semantic) }
      catch (e: any) { throw new StageError('PLAN_EMPTY', String(e?.message || e)) }
      const referenceProfile = options.resolveReferenceProfile ? await options.resolveReferenceProfile(job, blobs) : (options.referenceProfile ?? null)
      const referencePlan = referenceProfile ? applyReferencePlanConstraints(variants, referenceProfile.constraints) : null
      const bad = variants.flatMap((v) => validateVariant(v, analysis).map((m) => `${v.id}: ${m}`))
      if (bad.length) throw new StageError('PLAN_INVALID', bad.join('; '))
      if (!variants.length) throw new StageError('PLAN_EMPTY', 'planner produced no variants')

      const stored = []
      for (const v of variants) {
        const s = await putAddressed(blobs, 'plans', toJobPlan(job.sourceAssetId, v))
        stored.push({ variantId: v.id, label: v.label, kind: v.kind ?? null, rationale: v.rationale, planRef: s.path, seconds: v.beats.reduce((t, b) => t + (b.trimEnd - b.trimStart), 0), presentation: v.presentation ?? null })
      }
      return {
        outputRef: stored[0].planRef, outputHash: sha256(stored.map((s) => s.planRef).join('|')), planRef: stored[0].planRef,
        result: {
          variants: stored, provider, model, promptVersion: options.openAi ? AI_PLANNER_PROMPT_VERSION : null,
          semantic: { status: semantic.status, reason: semantic.reason, storyRef, storySummary, warnings },
          reference: referencePlan ? { profileVersion: referenceProfile!.profileVersion, applied: referencePlan.applied, unknown: referencePlan.unknown, notes: referencePlan.notes } : null,
          // kept for older readers: why the model was not used
          fallback: semantic.status === 'ok' ? null : { reason: `${semantic.status}: ${semantic.reason ?? ''}`.slice(0, 300) }
        },
        provider, model, usage, costUsd: 0
      }
    }
  }
}
