import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import { canonicalize } from '../../lib/tracker-core/renderManifest.js'
import type { SourceAnalysis } from '../../lib/media/analyze.js'
import { aiAnalyzeStory, AI_PLANNER_PROMPT_VERSION, type SemanticOutcome } from '../../lib/media/aiPlanner.js'
import { planPresentationContract, planVariants, toJobPlan, validateVariant } from '../../lib/media/plan.js'
import { semanticFromStory, type SemanticResult, type StoryAnalysis } from '../../lib/media/story.js'
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
    async run({ job, blobs, previous, signal }) {
      const prev = await previous('ANALYZE')
      if (!prev?.outputRef) throw new StageError('ANALYSIS_MISSING', 'PLAN requires a completed ANALYZE stage')
      const analysis = await blobs.getJson<SourceAnalysis>(prev.outputRef)
      if (!analysis || analysis.schema !== 'source-analysis/1') throw new StageError('ANALYSIS_INVALID', 'analysis blob missing or wrong schema')
      if (analysis.sourceAssetId !== job.sourceAssetId) throw new StageError('ANALYSIS_MISMATCH', 'analysis belongs to a different source')

      // A PLAN that already succeeded once for this job means this run is a RECOVERY re-plan (PLAN_RECHECK): its only
      // purpose is a semantic, presentation-complete plan, so it fails closed instead of shipping a heuristic plan.
      const recovery = !!(await previous('PLAN'))
      let semantic: SemanticResult = { status: 'unavailable', reason: 'no semantic model configured', story: null }
      let provider = 'heuristic', model = 'deterministic@2', usage: unknown = null, warnings: string[] = [], aiCalls = 0
      let outcome: SemanticOutcome | 'AI_NOT_CONFIGURED' = 'AI_NOT_CONFIGURED', cached = false, calledModel: string | null = null
      if (options.openAi) {
        const sheetRef = (prev.result as any)?.keyframeSheetRef as string | undefined
        const sheet = sheetRef ? await blobs.getBytes(sheetRef) : null
        // A validated (status ok) story is reused for the same source analysis + keyframe sheet + prompt + model: a retried
        // stage, another Job on the same source (e.g. several Reference jobs on one Golden Source) or a re-run never pays
        // for, or re-rolls, the same semantic answer. Failed / invalid / low-confidence answers are never cached.
        const cacheKey = sha256(`semantic|${AI_PLANNER_PROMPT_VERSION}|${options.openAi.model}|${sha256(canonicalize(analysis))}|${sheet ? sha256(sheet) : 'no-sheet'}`)
        const cachePath = `semantic-cache/${cacheKey}.json`
        const hit = sheet ? await blobs.getJson<{ story: StoryAnalysis; model: string }>(cachePath).catch(() => null) : null
        const hitStory = hit?.story
        const hitOk = !!hitStory && hitStory.schema === 'story-analysis/1' && hitStory.sourceAssetId === job.sourceAssetId && hitStory.promptVersion === AI_PLANNER_PROMPT_VERSION && semanticFromStory(hitStory).status === 'ok'
        if (hitOk) {
          semantic = semanticFromStory(hitStory!)
          warnings = ['semantic answer reused from cache (0 model calls)']; aiCalls = 0
          provider = 'openai'; model = hit!.model || options.openAi.model; outcome = 'AI_OK'; cached = true; calledModel = model
        } else {
          const r = await aiAnalyzeStory(analysis, { ...options.openAi, keyframeJpeg: sheet, signal })
          semantic = { status: r.status, reason: r.reason, story: r.story }
          usage = r.usage; warnings = r.warnings; aiCalls = r.calls ?? 0; outcome = r.outcome; calledModel = r.model || options.openAi.model
          if (r.status === 'ok') {
            provider = 'openai'; model = r.model
            await blobs.putJson(cachePath, { story: r.story, model: r.model }).catch(() => { /* cache is an optimisation only */ })
          }
        }
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
      // One line answers "why heuristic?": the outcome class, whether the AI was actually called, and its reason.
      // (no key, no prompt — only the classification, model, call count, reason and story summary)
      const fallback = semantic.status === 'ok' ? 'none' : 'heuristic'
      console.info(`[plan] job=${job.id} semantic_status=${outcome} semantic=${semantic.status} provider_called=${options.openAi ? 'openai' : 'none'} model=${calledModel ?? 'none'} calls=${aiCalls}${cached ? ' cached=true' : ''} fallback=${fallback} confidence=${semantic.story?.confidence ?? 'n/a'} storyType=${semantic.story?.storyType ?? 'n/a'} recovery=${recovery} reason=${JSON.stringify(String(semantic.reason ?? '').slice(0, 300))} story=${JSON.stringify(storySummary)}`)

      let variants
      try { variants = planVariants(analysis, semantic) }
      catch (e: any) { throw new StageError('PLAN_EMPTY', String(e?.message || e)) }
      const referenceProfile = options.resolveReferenceProfile ? await options.resolveReferenceProfile(job, blobs) : (options.referenceProfile ?? null)
      const referencePlan = referenceProfile ? applyReferencePlanConstraints(variants, referenceProfile.constraints) : null
      const bad = variants.flatMap((v) => validateVariant(v, analysis).map((m) => `${v.id}: ${m}`))
      if (bad.length) throw new StageError('PLAN_INVALID', bad.join('; '))
      if (!variants.length) throw new StageError('PLAN_EMPTY', 'planner produced no variants')

      // PLAN quality gate: the recommended plan's Common Shorts presentation contract, decided HERE (not in AUTO_QC).
      const planContract = planPresentationContract(variants[0], semantic)
      if (recovery && !planContract.ok) {
        const diagnostic = { semanticStatus: outcome, semantic: semantic.status, providerCalled: options.openAi ? 'openai' : 'none', model: calledModel, calls: aiCalls, confidence: semantic.story?.confidence ?? null, storyType: semantic.story?.storyType ?? null, reason: semantic.reason ?? null, contract: planContract.reasons }
        console.info(`[plan] job=${job.id} RECOVERY_BLOCKED semantic_status=${outcome} contract=${JSON.stringify(planContract.reasons)}`)
        // a transient provider failure may be retried by the stage policy; an explicit low-confidence / invalid answer is final
        throw new StageError('SEMANTIC_RECOVERY_BLOCKED', `re-plan requires a validated semantic, presentation-complete plan; got ${outcome}: ${planContract.reasons.join('; ')}`.slice(0, 900), outcome === 'AI_REQUEST_FAILED', diagnostic)
      }

      const stored = []
      for (const v of variants) {
        const s = await putAddressed(blobs, 'plans', toJobPlan(job.sourceAssetId, v))
        stored.push({ variantId: v.id, label: v.label, kind: v.kind ?? null, rationale: v.rationale, planRef: s.path, seconds: v.beats.reduce((t, b) => t + (b.trimEnd - b.trimStart), 0), presentation: v.presentation ?? null })
      }
      return {
        outputRef: stored[0].planRef, outputHash: sha256(stored.map((s) => s.planRef).join('|')), planRef: stored[0].planRef,
        result: {
          variants: stored, provider, model, promptVersion: options.openAi ? AI_PLANNER_PROMPT_VERSION : null,
          semantic: { status: semantic.status, outcome, calledModel, reason: semantic.reason, storyRef, storySummary, warnings, aiCalls, cached },
          recovery, planContract,
          reference: referencePlan ? { profileVersion: referenceProfile!.profileVersion, applied: referencePlan.applied, unknown: referencePlan.unknown, notes: referencePlan.notes, changes: referencePlan.changes } : null,
          // kept for older readers: why the model was not used
          fallback: semantic.status === 'ok' ? null : { reason: `${semantic.status}: ${semantic.reason ?? ''}`.slice(0, 300) }
        },
        provider, model, usage, costUsd: 0
      }
    }
  }
}
