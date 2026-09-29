import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import type { SourceAnalysis } from '../../lib/media/analyze.js'
import { aiAnalyzeStory, AI_PLANNER_PROMPT_VERSION } from '../../lib/media/aiPlanner.js'
import { callSemanticStoryProxy } from '../../lib/media/semanticStoryProxy.js'
import { planVariants, toJobPlan, validateVariant } from '../../lib/media/plan.js'
import type { SemanticResult } from '../../lib/media/story.js'
import { StageError, type StageExecutor } from '../types.js'

export type PlanExecutorOptions = {
  openAi?: { apiKey: string; model: string; fetchImpl?: typeof fetch } | null
  semanticProxy?: { endpoint: string; proofKey: string; fetchImpl?: typeof fetch } | null
}

export function createPlanExecutor(options: PlanExecutorOptions = {}): StageExecutor {
  return {
    stage: 'PLAN',
    estimateUsd: () => (options.semanticProxy || options.openAi ? 0.05 : 0),
    inputHash: (job) => sha256(`plan|${job.id}|${job.sourceAssetId}|${options.semanticProxy ? 'semantic-proxy' : options.openAi?.model ?? 'heuristic'}|${AI_PLANNER_PROMPT_VERSION}`),
    async run({ job, blobs, previous }) {
      const prev = await previous('ANALYZE')
      if (!prev?.outputRef) throw new StageError('ANALYSIS_MISSING', 'PLAN requires a completed ANALYZE stage')
      const analysis = await blobs.getJson<SourceAnalysis>(prev.outputRef)
      if (!analysis || analysis.schema !== 'source-analysis/1') throw new StageError('ANALYSIS_INVALID', 'analysis blob missing or wrong schema')
      if (analysis.sourceAssetId !== job.sourceAssetId) throw new StageError('ANALYSIS_MISMATCH', 'analysis belongs to a different source')

      let semantic: SemanticResult = { status: 'unavailable', reason: 'no semantic model configured', story: null }
      let provider = 'heuristic', model = 'deterministic@2', usage: unknown = null, warnings: string[] = []
      const keyframeSheetRef = (prev.result as any)?.keyframeSheetRef as string | undefined

      if (options.semanticProxy && keyframeSheetRef) {
        try {
          const r = await callSemanticStoryProxy(analysis, {
            endpoint: options.semanticProxy.endpoint,
            authSecret: options.semanticProxy.proofKey,
            fetchImpl: options.semanticProxy.fetchImpl,
            jobId: job.id,
            sourceAssetId: job.sourceAssetId,
            analysisRef: prev.outputRef,
            keyframeSheetRef
          })
          semantic = { status: r.status, reason: r.reason, story: r.story }
          usage = r.usage; warnings = r.warnings
          if (r.status === 'ok') { provider = 'openai-proxy'; model = r.model }
        } catch (e: any) {
          semantic = { status: 'failed', reason: `semantic proxy: ${String(e?.message || e).slice(0, 300)}`, story: null }
        }
      } else if (options.openAi) {
        const sheet = keyframeSheetRef ? await blobs.getBytes(keyframeSheetRef) : null
        const r = await aiAnalyzeStory(analysis, { ...options.openAi, keyframeJpeg: sheet })
        semantic = { status: r.status, reason: r.reason, story: r.story }
        usage = r.usage; warnings = r.warnings
        if (r.status === 'ok') { provider = 'openai'; model = r.model }
      } else if (options.semanticProxy && !keyframeSheetRef) {
        semantic = { status: 'failed', reason: 'semantic proxy requires keyframe sheet', story: null }
      }

      const storyRef = semantic.story ? (await putAddressed(blobs, 'stories', semantic.story)).path : null
      let variants
      try { variants = planVariants(analysis, semantic) }
      catch (e: any) { throw new StageError('PLAN_EMPTY', String(e?.message || e)) }
      const bad = variants.flatMap((v) => validateVariant(v, analysis).map((m) => `${v.id}: ${m}`))
      if (bad.length) throw new StageError('PLAN_INVALID', bad.join('; '))
      if (!variants.length) throw new StageError('PLAN_EMPTY', 'planner produced no variants')

      const stored = []
      for (const v of variants) {
        const s = await putAddressed(blobs, 'plans', toJobPlan(job.sourceAssetId, v))
        stored.push({ variantId: v.id, label: v.label, kind: v.kind ?? null, rationale: v.rationale, planRef: s.path, seconds: v.beats.reduce((t, b) => t + (b.trimEnd - b.trimStart), 0) })
      }
      return {
        outputRef: stored[0].planRef, outputHash: sha256(stored.map((s) => s.planRef).join('|')), planRef: stored[0].planRef,
        result: {
          variants: stored, provider, model, promptVersion: options.semanticProxy || options.openAi ? AI_PLANNER_PROMPT_VERSION : null,
          semantic: { status: semantic.status, reason: semantic.reason, storyRef, warnings },
          fallback: semantic.status === 'ok' ? null : { reason: `${semantic.status}: ${semantic.reason ?? ''}`.slice(0, 300) }
        },
        provider, model, usage, costUsd: 0
      }
    }
  }
}
