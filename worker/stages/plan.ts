import { putAddressed, sha256 } from '../../lib/jobs/blobs.js'
import { canonicalize } from '../../lib/tracker-core/renderManifest.js'
import type { SourceAnalysis } from '../../lib/media/analyze.js'
import { aiAnalyzeStory, AI_PLANNER_PROMPT_VERSION } from '../../lib/media/aiPlanner.js'
import { planVariants, presentationComplete, toJobPlan, validateVariant } from '../../lib/media/plan.js'
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

      let semantic: SemanticResult = { status: 'unavailable', reason: 'no semantic model configured', story: null }
      let provider = 'heuristic', model = 'deterministic@2', usage: unknown = null, warnings: string[] = [], aiCalls = 0
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
          provider = 'openai'; model = hit!.model || options.openAi.model
        } else {
          const r = await aiAnalyzeStory(analysis, { ...options.openAi, keyframeJpeg: sheet, signal })
          semantic = { status: r.status, reason: r.reason, story: r.story }
          usage = r.usage; warnings = r.warnings; aiCalls = r.calls ?? 0
          if (r.status === 'ok') {
            provider = 'openai'; model = r.model
            await blobs.putJson(cachePath, { story: r.story, model: r.model }).catch(() => { /* cache is an optimisation only */ })
          }
        }
      }
      if (job.profile === 'source_shorts' && semantic.status !== 'ok') {
        throw new StageError('STORY_NOT_PUBLISHABLE', `semantic story analysis did not produce a publishable edit: ${semantic.status}: ${semantic.reason || 'unknown reason'}`, false)
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
      console.info(`[plan] job=${job.id} semantic=${semantic.status} provider=${provider} reason=${JSON.stringify(semantic.reason)} story=${JSON.stringify(storySummary)}`)

      // A low-confidence semantic read is still useful for lightweight Shorts presentation (headline/context/effects).
      // Do not throw that information away and produce a blank video; QC remains advisory for these presentation cues.
      const semanticForPlan: SemanticResult = semantic.status === 'low_confidence' && semantic.story
        ? { status: 'ok', reason: 'accepted low-confidence story for presentation', story: semantic.story }
        : semantic
      let variants
      try { variants = planVariants(analysis, semanticForPlan) }
      catch (e: any) { throw new StageError('PLAN_EMPTY', String(e?.message || e)) }
      if (job.profile === 'source_shorts') {
        const lead = variants[0]
        if (!lead || !presentationComplete(lead)) throw new StageError('PLAN_PRESENTATION_INCOMPLETE', 'source Shorts requires a grounded headline, timed context/payoff captions, and acceptable presentation rhythm', false)
        if (!lead.voiceoverText) throw new StageError('PLAN_NARRATION_MISSING', 'source Shorts requires grounded narration text derived from the selected story', false)
      }
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
          semantic: { status: semantic.status, reason: semantic.reason, storyRef, storySummary, warnings, aiCalls },
          reference: referencePlan ? { profileVersion: referenceProfile!.profileVersion, applied: referencePlan.applied, unknown: referencePlan.unknown, notes: referencePlan.notes, changes: referencePlan.changes } : null,
          // kept for older readers: why the model was not used
          fallback: semantic.status === 'ok' ? null : { reason: `${semantic.status}: ${semantic.reason ?? ''}`.slice(0, 300) }
        },
        provider, model, usage, costUsd: 0
      }
    }
  }
}
