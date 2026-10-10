// Longform stages (profiles wisdom_longform, senior_longform and yasa_longform): PLAN -> ASSET -> RENDER -> PACKAGE. One engine; the
// profile's mode (LONGFORM_MODES) picks one picture (Wisdom) or story scene pictures (Senior).
// Separate executors; the Shorts executors are reached unchanged for every other profile (see withLongform).
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, sha256File, putAddressed, type JobBlobStore } from '../../lib/jobs/blobs.js'
import { runOk, probe } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
import { geminiLongformImage, geminiImageWithReference, openAiTts } from '../../lib/generative/providers.js'
import { openAiLongformPlanner, type LongformPlanner, type LongformOutline, type LongformSectionDraft, type LongformMetadataDraft } from '../../lib/generative/longformPlanner.js'
import { openAiSeniorPlanner } from '../../lib/generative/seniorPlanner.js'
import { openAiYasaPlanner, type YasaPlanner } from '../../lib/generative/yasaPlanner.js'
import { YASA_ACTS, COLD_OPEN, yasaActChars, yasaActErrors, yasaRevealAt, yasaScenePrompt, coldOpenErrors, coldOpenCandidates, coldOpenRejections } from '../../lib/generative/yasaLongform.js'
import { validateYasaStoryDna } from '../../lib/story/yasaStoryDna.js'
import { openAiDeriveShorts, selectDerivedShorts, deriveErrors, DERIVE_MODEL } from '../../lib/generative/derivedShorts.js'
import { mergeSameScenes, seniorOutlineErrors, seniorActErrors, seniorPacingErrors, seniorRepeatErrors, seniorPacing, runPacing, seniorCostEstimate, budgetGuard, ttsUsdOf, SENIOR_COST, seniorScenePlan, seniorScenes, seniorScenePrompt, sceneRuns, planSegments, runFrames, sceneSegmentArgv, segmentConcatArgv, RENDER_SEGMENT, SEGMENT_ENCODER, SENIOR, type SeniorScript } from '../../lib/generative/seniorLongform.js'
import { briefVoice, creativeGolden, creativeStyle, creativeStyleOverride, type CreativeContent } from '../../lib/generative/creativeProfile.js'
import { goldenCacheTag, goldenImage, goldenLockFor, goldenLockTag, type GoldenIdentity } from '../../lib/generative/goldenStyle.js'
import { VISUAL_STYLE_PROFILES } from '../../lib/generative/visualStyle.js'
import { VIDEO_ENCODER_THREADS } from '../../lib/media/render.js'
import { openAiLongformResearcher, researchPath, researchErrors, sectionFragments, RESEARCH_MODEL, type LongformResearcher, type ResearchBundle } from '../../lib/generative/longformResearch.js'
import {
  LONGFORM, isLongformProfile, longformMode, validateLongformScript, cardErrors, sentencesOf, narrationOf, longformImagePrompt, ttsChunks, cardTimeline, sectionPlan, longformFigure,
  longformCardsAss, yasaCaptionsAss, longformBackgroundArgv, longformVideoArgv, longformPackageMetadata, type LongformBrief, type LongformScript
} from '../../lib/generative/longform.js'
import { thumbnailArgv, thumbnailCopyErrors, LONGFORM_THUMB } from '../../lib/generative/wisdomThumbnail.js'
import { styleGate, representativeCheck, thumbnailRework, type StyleReference, type DrawRefFn, type CopyWriter } from './styleGate.js'
import { styleApprovalWanted } from '../../lib/generative/styleApproval.js'
import { openAiThumbnailCopyWriter } from '../../lib/generative/thumbnailCopyWriter.js'
import { openAiStyleJudge } from '../../lib/generative/styleJudge.js'
import { YADAM_STYLE_VERSION, geminiYadamImage, type YadamDraw } from '../../lib/generative/yadamStyle.js'
import { composeTitleThumbnail, thumbnailBackgroundPrompt, titleSceneIndex } from '../../lib/generative/titleThumbnail.js'
import { readThumbnailOverride } from '../../lib/generative/thumbnailOverride.js'
import { runSpentUsd } from '../../lib/generative/usageLedger.js'
import { styleApprovalRef } from '../../lib/generative/styleApproval.js'
import type { StyleJudge } from '../../lib/generative/styleApproval.js'
import { uploadMetadataErrors } from '../../lib/generative/uploadPackage.js'
import { ttsCacheIdentity } from '../../lib/generative/voiceProfile.js'
import { StageError, type StageExecutor } from '../types.js'
import { DEFAULT_MAX_ATTEMPTS } from '../../lib/jobs/store.js'
import { profileFeatures, needFeatures, type FeatureResolver } from '../modules/features.js'
import { cacheEntryIsCanonical } from '../../lib/generative/cache.js'
import { guardedTts, clipToWav, assembleNarration, NARRATION_LOUDNORM, narrationConcatTimeoutMs, type TtsFn } from '../../lib/generative/narration.js'


const isLongform = (job: any) => isLongformProfile(job?.profile)
const featuresOf = (deps: { features?: FeatureResolver }, job: any) => (deps.features ?? profileFeatures)(job)

// Route a stage to the Longform executor for wisdom_longform jobs only; every other job runs the given executor as before.
export function withLongform(executors: StageExecutor[], longform: StageExecutor[]): StageExecutor[] {
  const lf = new Map(longform.map((e) => [e.stage, e]))
  const routed = executors.map((e) => {
    const l = lf.get(e.stage)
    if (!l) return e
    return { ...e, run: (ctx: any) => (isLongform(ctx.job) ? l.run(ctx) : e.run(ctx)), inputHash: (job: any) => (isLongform(job) ? l.inputHash(job) : e.inputHash(job)), estimateUsd: (job: any) => (isLongform(job) ? l.estimateUsd(job) : e.estimateUsd(job)) }
  })
  for (const l of longform) if (!routed.some((e) => e.stage === l.stage)) routed.push(l)
  return routed
}

// Bumped whenever the planning steps change, so old checkpoints are never mixed into a new plan.
export const LONGFORM_PLANNER_VERSION = 'longform-sections/2-research'
const outlineErrors = (o: any, sections: number): string[] => {
  const e: string[] = []
  for (const k of ['title', 'hook']) if (!String(o?.[k] || '').trim()) e.push(k)
  if (!String(o?.figure?.imagePrompt || '').trim()) e.push('figure.imagePrompt')
  e.push(...thumbnailCopyErrors(Array.isArray(o?.thumbnail?.lines) ? o.thumbnail.lines : [], String(o?.title || '')).map((x) => `thumbnail.${x}`))
  const secs = Array.isArray(o?.sections) ? o.sections : []
  if (secs.length !== sections) e.push(`sections.count ${secs.length}/${sections}`)
  if (secs.some((x: any) => !String(x?.heading || '').trim())) e.push('sections.heading')
  return e
}
const sectionErrors = (d: any): string[] => {
  const sents = Array.isArray(d?.sentences) ? d.sentences : []
  if (!sents.length) return ['sentences']
  return sents.flatMap((x: any, j: number) => [
    ...(!String(x?.say || '').trim() ? [`[${j}].say`] : []),
    ...([...String(x?.say || '')].length > LONGFORM.ttsChunkChars ? [`[${j}].say.too_long`] : []),
    ...cardErrors(x).map((c) => `[${j}].${c}`)
  ])
}

// A billing/auth provider error (insufficient_quota, credit_balance_exhausted, 401/403) stops the job at once: no repair
// attempt, no stage retry.
const stopError = (e: any) => new StageError(/quota|credit_balance/.test(String(e?.code)) ? 'PROVIDER_BILLING' : 'PROVIDER_STOP', String(e?.message || e).slice(0, 300), false, { providerCode: e?.code ?? null })

// RESEARCH: stored under a key of (version, sections, topic) and reused unconditionally; made at most once per topic
// (one request + one retry only on a transient error). Any research failure is not retried by the stage.
export async function longformResearchFor(o: { blobs: JobBlobStore; topic: string; sections: number; apiKey: string; researcher: LongformResearcher; log: (line: string) => void; signal?: AbortSignal }): Promise<{ research: ResearchBundle; ref: string; log: Record<string, unknown> }> {
  const ref = researchPath(o.topic, o.sections)
  let research = await o.blobs.getJson<ResearchBundle>(ref).catch(() => null)
  if (research && researchErrors(research, o.sections).length) research = null
  const rLog: Record<string, unknown> = { cache: research ? 'HIT' : 'MISS', model: research?.model ?? RESEARCH_MODEL, requests: 0, webSearchCalls: null }
  if (!research) {
    if (o.signal?.aborted) throw new Error('aborted')
    try {
      const r = await o.researcher({ topic: o.topic, sections: o.sections }, o.apiKey)
      Object.assign(rLog, { model: r.bundle.model, requests: r.requests, webSearchCalls: r.webSearchCalls })
      const errs = researchErrors(r.bundle, o.sections)
      if (errs.length) { rLog.code = 'RESEARCH_INVALID'; throw new StageError('RESEARCH_INVALID', errs.join(', '), false) }
      await o.blobs.putJson(ref, r.bundle, { overwrite: true })
      research = r.bundle
    } catch (e: any) {
      if (!rLog.code) Object.assign(rLog, { requests: e?.requests ?? (rLog.requests || 1), code: e?.code ?? 'RESEARCH_FAILED' })
      o.log(`[longform-research] ${JSON.stringify({ ...rLog, ref })}`)
      if (e instanceof StageError) throw e
      if (e?.stop) throw stopError(e)
      throw new StageError('RESEARCH_FAILED', String(e?.message || e).slice(0, 300), false, { providerCode: e?.code ?? null })
    }
  }
  rLog.fragments = research.fragments.length
  o.log(`[longform-research] ${JSON.stringify({ ...rLog, ref })}`)
  return { research, ref, log: rLog }
}

// PLAN: research (once per topic, cached) -> outline -> each section -> upload text. Every step is stored as a checkpoint (keyed by the brief + planner
// version) the moment it passes its checks; a retry reuses every stored step and only writes what is missing, so a long
// script is never regenerated from the start. targetSeconds only sizes the script (number and length of sections).
export function createLongformPlanExecutor(deps: { apiKey?: string; planner?: LongformPlanner; research?: LongformResearcher; derive?: typeof openAiDeriveShorts; log?: (line: string) => void } = {}): StageExecutor {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? '', researcher = deps.research ?? openAiLongformResearcher(), derive = deps.derive ?? openAiDeriveShorts
  const log = deps.log ?? ((line: string) => console.log(line))
  return {
    stage: 'PLAN', estimateUsd: () => 0.3,
    inputHash: (job) => sha256(`longform-plan|${job.planRef}|wisdom_longform/1`),
    async run({ job, blobs, signal, costSoFar }) {
      if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform PLAN only handles longform profiles')
      const brief = (job.planRef ? await blobs.getJson(job.planRef) : null) as LongformBrief | null
      if (!brief || brief.schema !== 'generative-brief/1' || brief.profile !== job.profile) throw new StageError('BRIEF_INVALID', `invalid ${job.profile} brief`)
      const mode = longformMode(job.profile), scenes = mode.images === 'scenes', yasa = job.profile === 'yasa_longform', senior = job.profile === 'senior_longform'
      const planner = deps.planner ?? (yasa ? openAiYasaPlanner() : scenes ? openAiSeniorPlanner() : openAiLongformPlanner())
      // Senior: six acts; 숨은야담: the DNA's eight acts (one section per act); Wisdom: sections sized by the running time
      const size = yasa ? { sections: YASA_ACTS.length, charsPerSection: 0 } : scenes ? (() => { const p = seniorScenePlan(brief.targetSeconds); return { sections: p.acts, charsPerSection: p.charsPerAct } })() : sectionPlan(brief.targetSeconds)
      // 숨은야담: each act sized by its share of the story (the reveal act starts at ~80% of the narration)
      const actChars = yasa ? yasaActChars(Math.round(brief.targetSeconds * LONGFORM.charsPerSecond)) : null
      const targetOf = (i: number) => actChars?.[i] ?? size.charsPerSection
      const ck = `longform-plan-checkpoints/${sha256(`${job.planRef}|${LONGFORM_PLANNER_VERSION}`)}`
      const made: string[] = [], reused: string[] = []
      // one checkpointed step: reuse the stored result, else make it (one free repair with the exact errors) and store it
      // memory: every rejected attempt (its errors + what it wrote) is kept next to the checkpoint, ACROSS stage retries,
      // and handed to the next attempt, so a refused answer word / sentence / scene is never produced again.
      async function step<T>(name: string, code: string, make: (repair?: string[], history?: Array<{ errors: string[]; value: any }>) => Promise<T>, errorsOf: (v: T, history?: Array<{ errors: string[]; value: any }>) => string[], o: { tries?: number; memory?: boolean } = {}): Promise<T> {
        const memRef = `${ck}/${name}.rejected.json`
        const history: Array<{ errors: string[]; value: any }> = o.memory ? (((await blobs.getJson(memRef).catch(() => null)) as any)?.attempts ?? []) : []
        const hit = (await blobs.getJson(`${ck}/${name}.json`).catch(() => null)) as T | null
        if (hit && !errorsOf(hit, history).length) { reused.push(name); return hit }
        let errs: string[] = []
        // answered (billed) tries of this step for THIS job, across every stage run: never more than the three normal stage
        // attempts allow (act 6, cold open 9 — the same chances as before, so quality checks and completion are unchanged);
        // a re-queue past that (recheck, lease loss, restart) stops instead of paying for the same failing step again.
        // Provider errors / aborted calls returned nothing and do not count.
        const triesRef = `${ck}/${name}.tries.${job.id}.json`, cap = (o.tries ?? 2) * DEFAULT_MAX_ATTEMPTS
        let spent = Number(((await blobs.getJson(triesRef).catch(() => null)) as any)?.paid ?? 0)
        for (let attempt = 0; attempt < (o.tries ?? 2); attempt++) {
          if (signal?.aborted) throw new Error('aborted')
          if (spent >= cap) throw new StageError(code, `${name}: retry limit reached (${spent} paid tries for this job): ${(errs.length ? errs : history.at(-1)?.errors ?? []).slice(0, 12).join(', ')}`, false)
          let v: T | undefined
          try { v = await make(attempt || history.length ? (errs.length ? errs : history.at(-1)?.errors) : undefined, history); spent++; await blobs.putJson(triesRef, { paid: spent }, { overwrite: true }); errs = errorsOf(v, history); if (!errs.length) { await blobs.putJson(`${ck}/${name}.json`, v, { overwrite: true }); made.push(name); return v } }
          catch (e: any) { if (e?.stop) throw stopError(e); errs = [String(e?.message || e)] }
          if (o.memory) { history.push({ errors: errs.slice(0, 30), value: v ?? null }); await blobs.putJson(memRef, { attempts: history.slice(-8) }, { overwrite: true }) }
        }
        // retryable: the stage retry resumes from the stored steps
        throw new StageError(code, `${name}: ${errs.slice(0, 20).join(', ')}`, true)
      }
      // 숨은야담 COLD OPEN (new script or a remaster refresh): only middle scenes before the reveal; up to 3 tries per stage
      // attempt; every refused attempt is remembered (answer words, sentences, scenes) and kept out of the next one —
      // after the same answer word leaks twice the scene that carried it is replaced, not just reworded. The checks
      // themselves (coldOpenErrors) are the same for every attempt.
      const coldOpenStep = (pb: any, outline: any, sections: any[], dna: any) => {
        const speed = Number(brief.creative?.resolved?.voiceSpeed) || 1, sceneIds = new Set<string>(sections.flatMap((x: any) => x.scenes.map((y: any) => String(y.id))))
        const mainSentences = sections.flatMap((x: any) => x.sentences.map((y: any) => String(y.say || '')))
        const candidates = coldOpenCandidates(sections), targetChars = Math.round(COLD_OPEN.seconds.target * LONGFORM.charsPerSecond * speed)
        const rejectionsOf = (h?: Array<{ errors: string[]; value: any }>) => coldOpenRejections((h ?? []).map((a) => ({ errors: a.errors, sentences: Array.isArray(a.value?.sentences) ? a.value.sentences : [] })), { allowed: candidates.allowed })
        return step<any>('cold-open', 'COLD_OPEN_INVALID', (r, h) => { const rj = rejectionsOf(h); return (planner as YasaPlanner).coldOpen({ brief: pb, outline, sections, candidates: candidates.list, targetChars, repair: r, rejected: { terms: rj.terms, sentences: rj.sentences, scenes: rj.scenes, avoidScenes: [...rj.avoidScenes] } }, apiKey) },
          (d, h) => [...sectionErrors(d), ...coldOpenErrors(d?.sentences, { dna, sceneIds, mainSentences, speed, charsPerSecond: LONGFORM.charsPerSecond, candidates, avoidScenes: rejectionsOf(h).avoidScenes })], { tries: 3, memory: true })
      }
      // Generic Longform REMASTER: every profile enters through the same child-job contract. The source script is
      // immutable and reused by default. Creative changes alter only cache identities downstream:
      //   style -> new pictures, same TTS; voice/tone/speed -> new TTS, same pictures; no creative change -> both reused.
      // A profile-specific repair may opt in without creating a new remaster endpoint (today: 숨은야담 cold-open refresh).
      const remaster: any = (brief as any).remaster ?? null
      if (remaster) {
        const src: any = remaster.sourceScriptRef ? await blobs.getJson(remaster.sourceScriptRef) : null
        if (!src || src.schema !== mode.script || !Array.isArray(src.sections) || !src.sections.length) throw new StageError('REMASTER_SOURCE_INVALID', `source job ${remaster.sourceJobId} has no usable ${job.profile} script`, false)
        const changes = remaster.changes && typeof remaster.changes === 'object' ? remaster.changes : {}
        const refreshColdOpen = yasa && changes.refreshColdOpen === true
        let script: any = src
        if (refreshColdOpen) {
          if (!apiKey) throw new StageError('PROVIDER_DOWN', 'the cold-open refresh needs the planner (OPENAI_API_KEY)', true)
          if (src.sections.length !== YASA_ACTS.length || !src.yasaStoryDNA) throw new StageError('REMASTER_SOURCE_INVALID', `source job ${remaster.sourceJobId} has no usable 숨은야담 story`, false)
          const pb: any = { ...brief, yasaStoryDNA: src.yasaStoryDNA }, sections = src.sections
          const outline = { title: src.title, hook: src.hook, figure: src.figure, thumbnail: src.thumbnail, characters: src.characters, sections: sections.map((x: any) => ({ id: x.id, heading: x.heading, points: [], scenes: x.scenes })) }
          const d = await coldOpenStep(pb, outline, sections, src.yasaStoryDNA)
          script = { ...src, coldOpen: { sentences: d.sentences } }
        }
        const errors = validateLongformScript(script, brief)
        if (errors.length) throw new StageError('SCRIPT_INVALID', errors.join(','))
        const stored = await putAddressed(blobs, 'generative-scripts', script)
        const sections = script.sections
        return {
          outputRef: stored.path, outputHash: stored.sha256,
          result: {
            profile: job.profile, provider: refreshColdOpen ? 'openai' : 'reuse', scriptRef: stored.path,
            sections: sections.length, sentences: sentencesOf(script).length, ...(scenes ? { scenes: seniorScenes(script).length } : {}),
            remaster: {
              schema: 'longform-remaster/1', sourceJobId: remaster.sourceJobId, parentJobId: remaster.parentJobId,
              sourceScriptRef: remaster.sourceScriptRef, changes,
              reused: ['story-script', 'narration-text', 'metadata'], made: refreshColdOpen ? made : []
            },
            ...(yasa ? { yasa: { dna: 'source', acts: sections.map((x: any) => x.act), revealAt: Number(yasaRevealAt(sections).toFixed(3)), coldOpen: script.coldOpen?.sentences?.length ?? 0 } } : {}),
            creative: brief.creative ?? null, targetSeconds: brief.targetSeconds, validation: errors
          }
        }
      }
      if (!apiKey) throw new StageError('PROVIDER_DOWN', 'the longform script needs the planner (OPENAI_API_KEY)', true)
      // research gathers wisdom sources (Wisdom Longform only; a Senior story is not researched)
      const { research, ref: rRef, log: rLog } = mode.research ? await longformResearchFor({ blobs, topic: brief.text, sections: size.sections, apiKey, researcher, log, signal }) : { research: null, ref: null, log: { cache: 'OFF' } as Record<string, unknown> }
      // 숨은야담: the STORY DNA first (sent in with the brief, else made once and checkpointed); every later step sees it
      let dnaSource: 'brief' | 'plan' | null = null, pbrief: any = brief
      if (yasa) {
        const dna = brief.yasaStoryDNA ?? await step<any>('dna', 'DNA_INVALID', (r) => (planner as YasaPlanner).dna(brief, apiKey, r), (d) => validateYasaStoryDna(d, 'longform', { layers: true }).errors)
        dnaSource = brief.yasaStoryDNA ? 'brief' : 'plan'; pbrief = { ...brief, yasaStoryDNA: dna }
      }
      const outline = await step<LongformOutline>('outline', 'OUTLINE_INVALID', (r) => planner.outline(pbrief, size.sections, apiKey, r, research), (o) => [...outlineErrors(o, size.sections), ...(scenes ? seniorOutlineErrors(o) : []), ...(senior ? seniorRepeatErrors(o) : [])])
      const castIds = new Set<string>(((outline as any).characters ?? []).map((c: any) => String(c?.id)))
      const sections: any[] = []
      let tail: string[] = []
      for (let i = 0; i < outline.sections.length; i++) {
        const actScenes = (outline.sections[i] as any).scenes
        const d = await step<LongformSectionDraft>(`section-${String(i + 1).padStart(3, '0')}`, 'SECTION_INVALID', (r) => planner.section({ brief: pbrief, outline, index: i, previousTail: tail, targetChars: targetOf(i), repair: r, fragments: sectionFragments(research, i) }, apiKey),
          (d) => [...sectionErrors(d), ...(scenes ? seniorActErrors({ scenes: actScenes, sentences: (d as any)?.sentences }, castIds) : []), ...(senior ? seniorPacingErrors({ scenes: actScenes, sentences: (d as any)?.sentences ?? [] }, Number(brief.creative?.resolved?.voiceSpeed) || 1) : []), ...(yasa ? yasaActErrors(i, (d as any)?.sentences, pbrief.yasaStoryDNA, targetOf(i)) : [])])
        // Senior: two scenes in a row with the same place/time/people/action are one picture
        sections.push(scenes ? { id: String(outline.sections[i].id || `a${i + 1}`), heading: outline.sections[i].heading, ...(yasa ? { act: YASA_ACTS[i]?.key } : {}), ...mergeSameScenes({ scenes: actScenes, sentences: d.sentences as any }) } : { id: String(outline.sections[i].id || `s${i + 1}`), sentences: d.sentences })
        tail = d.sentences.slice(-2).map((x) => x.say)
      }
      // 숨은야담: the COLD OPEN, written last over the main story's own pictures (45~60 s at the voice's speed, 5~8 beats)
      let coldOpen: any = null
      if (yasa) {
        // only scenes past the first 10% and before the reveal (the middle 15~65% first): never the opening told twice
        const d = await coldOpenStep(pbrief, outline, sections, pbrief.yasaStoryDNA)
        coldOpen = { sentences: d.sentences }
      }
      // a figure the topic names (the Buddha, a named thinker) stays that person (Wisdom); Senior: the main character
      const figure = scenes ? outline.figure : { name: outline.figure.name, imagePrompt: longformFigure(brief.text, outline.figure.imagePrompt) }
      const body: any = { schema: mode.script, title: outline.title, hook: outline.hook, figure, thumbnail: outline.thumbnail, ...(scenes ? { characters: (outline as any).characters } : {}), ...(yasa ? { yasaStoryDNA: pbrief.yasaStoryDNA, coldOpen } : {}), sections }
      const narration = narrationOf({ ...body, metadata: { description: '', tags: [], hashtags: [], pinnedComment: '' } })
      const meta = await step<LongformMetadataDraft>('metadata', 'METADATA_INVALID', (r) => planner.metadata({ brief: pbrief, title: outline.title, headings: outline.sections.map((x) => x.heading), narration, repair: r }, apiKey),
        (m) => [...uploadMetadataErrors(m, { narration, format: 'longform' }), ...thumbnailCopyErrors(outline.thumbnail.lines as any, String(m?.title || '')).map((x) => `thumbnail.${x}`)])
      const script: any = { ...body, title: meta.title, metadata: { description: meta.description, tags: meta.tags, hashtags: meta.hashtags, pinnedComment: meta.pinnedComment } }
      const errors = validateLongformScript(script, brief)
      if (errors.length) throw new StageError('SCRIPT_INVALID', errors.join(','))
      const stored = await putAddressed(blobs, 'generative-scripts', script)
      // Wisdom Longform -> derived Shorts: ONE checkpointed text call over the finished script and the research already
      // made (no new research), before any image / voice is paid. Never stops the Longform: a failure is only recorded.
      let derived: Record<string, unknown> | undefined
      if (job.profile === 'wisdom_longform') {
        if ((brief as any).deriveShorts === false) derived = { status: 'off' }
        else {
          try {
            const raw = await step<any>('derive-shorts', 'DERIVE_INVALID', (r) => derive({ script, research, repair: r }, apiKey), deriveErrors)
            const pick = selectDerivedShorts(raw, script)
            const doc = await putAddressed(blobs, 'derived-shorts', { schema: 'derived-shorts/1', parentLongformJobId: job.id, parentLongformTitle: script.title, model: DERIVE_MODEL(), candidates: pick.candidates, excluded: pick.excluded })
            derived = { status: pick.candidates.length ? 'ready' : 'none', ref: doc.path, count: pick.candidates.length, considered: Array.isArray(raw?.ideas) ? raw.ideas.length : 0 }
          } catch (e: any) { derived = { status: 'failed', error: String(e?.message || e).slice(0, 200) } }
        }
      }
      // Senior: the pictures and the narration this script will cost (ASSET checks it against the budget before paying)
      const estimate = senior ? seniorCostEstimate({ pictures: seniorScenes(script).length, extraPictures: styleApprovalWanted(job.profile, brief) ? 1 : 0, narrationChars: [...sentencesOf(script).map((x) => x.say).join('')].length, spentUsd: ((await costSoFar?.()) ?? 0) + runSpentUsd(), budgetUsd: job.budgetUsd }) : null
      return { outputRef: stored.path, outputHash: stored.sha256, result: { profile: job.profile, provider: 'openai', scriptRef: stored.path, ...(estimate ? { estimate } : {}), ...(derived ? { derived } : {}), sections: sections.length, sentences: sentencesOf(script).length, ...(scenes ? { scenes: seniorScenes(script).length } : {}), ...(senior ? { pacing: seniorPacing(script as unknown as SeniorScript, Number(brief.creative?.resolved?.voiceSpeed) || 1) } : {}), ...(yasa ? { yasa: { dna: dnaSource, acts: sections.map((x: any) => x.act), revealAt: Number(yasaRevealAt(sections).toFixed(3)), actTargets: actChars, coldOpen: { beats: coldOpen.sentences.length, estimatedSeconds: Number(([...coldOpen.sentences.map((x: any) => x.say).join(' ')].length / (LONGFORM.charsPerSecond * (Number(brief.creative?.resolved?.voiceSpeed) || 1))).toFixed(1)) } } } : {}), creative: brief.creative ?? null, targetSeconds: brief.targetSeconds, checkpoints: { ref: ck, made, reused }, research: { ref: rRef, ...rLog }, validation: errors } }
    }
  }
}

// Which side of the picture holds the subject: mean + spread of luma per side (the figure is brighter / more detailed
// than the dark negative space). A figure on the LEFT is mirrored so the text column is always the empty side.
export async function subjectSide(imagePath: string): Promise<{ left: number; right: number; side: 'left' | 'right' }> {
  const W = 192, H = 108
  const px = (await runOk(['-i', imagePath, '-vf', `scale=${W}:${H},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'])).stdout
  const score = (x0: number, x1: number) => { let s = 0, s2 = 0, n = 0; for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { const v = px[y * W + x]; s += v; s2 += v * v; n++ } const m = s / n; return m + Math.sqrt(Math.max(0, s2 / n - m * m)) }
  const left = score(0, Math.round(W * 0.45)), right = score(Math.round(W * 0.55), W)
  return { left: Number(left.toFixed(1)), right: Number(right.toFixed(1)), side: left > right * 1.1 ? 'left' : 'right' }
}

// Feature modules: IMAGE (deps.image, ONE image) and TTS (deps.tts, one call per sentence); both are required.
// The narration voice is the brief's Voice Profile (lib/generative/voiceProfile.ts) and is part of every TTS cache key.
// Long runs: only cache METADATA is read up front (audio bytes are loaded per sentence), each sentence becomes a small
// mono WAV (exact measured length; ~1/4 of the old stereo temp size), and the concat timeout scales with the length.
export const LONGFORM_LOUDNORM = NARRATION_LOUDNORM // the one narration engine's loudness pass
export const longformConcatTimeoutMs = narrationConcatTimeoutMs
// every Longform's delivered thumbnail: the approved background (style lock) or the video's own picture + the FINAL title
export async function longformTitleThumbnail(o: { jobId: string; blobs: any; assets: any; title: string; picture: () => Promise<Buffer> }): Promise<Buffer> {
  // 썸네일만 다시 생성 / 문구 수정: the replacement the user made after approval IS the thumbnail (already composed)
  if (o.assets?.approvedThumbnail) {
    const ov = await readThumbnailOverride(o.blobs, o.jobId), b = ov ? await o.blobs.getBytes(ov.current.thumbnailRef) : null
    if (ov && !b) throw new StageError('THUMB_BACKGROUND_MISSING', `the replaced thumbnail ${ov.current.thumbnailRef} is missing`, false)
    if (b) return b
  }
  let bgRef: string | null = o.assets?.approvedThumbnail?.backgroundRef ?? null
  if (o.assets?.approvedThumbnail?.ref && !bgRef) bgRef = (((await o.blobs.getJson(styleApprovalRef(o.jobId)).catch(() => null)) as any)?.approved?.backgroundRef) ?? null
  const bg = bgRef ? await o.blobs.getBytes(bgRef) : await o.picture()
  if (!bg) throw new StageError('THUMB_BACKGROUND_MISSING', `the approved thumbnail background ${bgRef} is missing`, false)
  try { return (await composeTitleThumbnail({ background: bg, title: o.title })).bytes }
  catch (e: any) { throw new StageError(e?.code || 'THUMB_TITLE_OVERFLOW', `${e?.code || 'THUMB_TITLE_OVERFLOW'}: ${String(e?.message || e)}`, false) }
}
export function createLongformAssetExecutor(deps: { apiKey?: string; imageKey?: string; imageFetch?: typeof fetch; image?: typeof geminiLongformImage; tts?: typeof openAiTts; features?: FeatureResolver; imageRef?: DrawRefFn; copyWriter?: CopyWriter; styleJudge?: StyleJudge; yadam?: YadamDraw } = {}): StageExecutor {
  const image = deps.image ?? geminiLongformImage, tts = deps.tts ?? openAiTts, apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? ''
  // every picture is drawn by Gemini (geminiImage.ts) with its own key; OpenAI keeps narration and the text steps
  const imageKey = deps.imageKey ?? process.env.GEMINI_API_KEY ?? ''
  const imageRef = deps.imageRef ?? geminiImageWithReference, yadamDraw = deps.yadam ?? geminiYadamImage()
  return {
    stage: 'ASSET', estimateUsd: () => 1.0,
    inputHash: (job) => sha256(`longform-asset|${job.id}|${job.planRev}|wisdom_longform/1`),
    async run({ job, blobs, previous, signal, costSoFar }) {
      if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform ASSET only handles longform profiles')
      needFeatures(featuresOf(deps, job), ['IMAGE', 'TTS'], 'Longform ASSET')
      const mode = longformMode(job.profile), scenes = mode.images === 'scenes'
      const p = await previous('PLAN'), scriptRef = (p?.result as any)?.scriptRef
      const script = (scriptRef ? await blobs.getJson(scriptRef) : null) as LongformScript | null
      if (!script || script.schema !== mode.script) throw new StageError('SCRIPT_MISSING', 'ASSET requires the longform PLAN script')
      const brief = (job.planRef ? await blobs.getJson(job.planRef) : null) as LongformBrief | null
      // the voice and picture style resolved at job_create (never re-guessed here); older briefs keep their voice
      const voice = briefVoice(brief, job.profile as CreativeContent)
      const meta = async (kind: string, key: string) => { try { const m: any = await blobs.getJson(`generative-cache/${kind}/${key}.json`); return m?.ref ? m : null } catch { return null } }
      const withBytes = async (m: any) => { try { const b = m?.ref ? await blobs.getBytes(m.ref) : null; return b ? { ...m, bytes: b } : null } catch { return null } }
      // Senior: one picture per story scene, all in the resolved style (watercolor by default) with the Character Bible.
      // Wisdom: the one picture; a style the user picked replaces only its style line (AUTO = the prompt as before).
      const sceneList = scenes ? seniorScenes(script as unknown as SeniorScript) : []
      const yasa = job.profile === 'yasa_longform', senior = job.profile === 'senior_longform'
      // Golden Style 1~5 (stored at job_create with its locked reference hash + prompt version), 16:9. FIRST-IMAGE CHARACTER
      // LOCK: the job's first picture (the approved thumbnail picture, or the first scene) is drawn with the Golden
      // reference alone; every later picture gets the Golden reference (style) + that first picture (the people)
      const golden = creativeGolden(brief?.creative), gTag = golden ? goldenCacheTag(golden) : ''
      let goldenIdentity: GoldenIdentity | null = null
      const goldenDraw = golden ? (p: string, k: string) => goldenImage(golden, p, '16:9', k, deps.imageFetch ?? fetch, goldenIdentity) : null
      // 야담: every picture is drawn by the ONE style contract (yadamStyle.ts: the reference frames + its text); the scene
      // prompt says only what the picture shows. Senior keeps its resolved style (watercolor by default).
      const sceneStyle = scenes && !yasa ? ((brief?.creative && creativeStyle(brief.creative)) || VISUAL_STYLE_PROFILES['senior-warm-watercolor']) : null
      const scenePrompts = sceneList.map((sc) => (yasa ? yasaScenePrompt(script as unknown as SeniorScript, sc) : seniorScenePrompt(script as unknown as SeniorScript, sc, sceneStyle!)))
      const prompt = scenes ? scenePrompts[0] : longformImagePrompt(script, creativeStyleOverride(brief?.creative)), chunks = ttsChunks(script)
      // THUMBNAIL FIRST + STYLE LOCK (profiles switched on in STYLE_APPROVAL, briefs that ask for it): before approval only
      // the thumbnail is made and the job waits; after approval every picture is drawn FROM the approved picture
      const repIndex = scenes ? Math.min(sceneList.length - 1, Math.floor(sceneList.length * 0.4)) : -1
      let styleLock: StyleReference | null = null, approval: any = null, thumbPrompt = ''
      if (styleApprovalWanted(job.profile, brief)) {
        thumbPrompt = thumbnailBackgroundPrompt(script.title, scenes ? scenePrompts[titleSceneIndex(script.title, sceneList.map((sc: any) => ({ id: sc.id, text: [sc.visual, sc.action, ...((script as any).sections ?? []).flatMap((x: any) => (x.sentences ?? []).filter((y: any) => y.scene === sc.id).map((y: any) => y.say))].join(' ') })), repIndex)] : prompt, { styleNeutral: yasa || !!golden })
        const gate = await styleGate({ jobId: job.id, blobs, script, profile: job.profile, apiKey, imageKey, backgroundPrompt: thumbPrompt, draw: goldenDraw ? goldenDraw : yasa ? (p: string, k: string) => yadamDraw(p, k) : image, copyWriter: deps.copyWriter ?? openAiThumbnailCopyWriter(), signal })
        if (gate.wait) return { result: { styleApproval: { status: 'pending', attempt: gate.record.attempts.length, thumbnailRef: gate.record.attempts.at(-1)?.thumbnailRef ?? null } }, wait: 'DECISION' }
        // 야담: the approved picture keeps the people and place consistent; the drawing stays the contract's (no measured colour text)
        styleLock = yasa || golden ? { ...gate.reference, text: '' } : gate.reference; approval = gate.record
      }
      // the character lock of a Golden job: stored before any later picture is drawn, the same bytes on every resume / retry
      const lockTag = styleLock ? `|ref:${styleLock.sha}` : ''
      const scenePrefix = yasa ? `${YADAM_STYLE_VERSION}|scene|` : styleLock ? 'longform-scene-image-ref-v1|' : 'longform-scene-image-v1|'
      const firstIsScene = !!golden && !styleLock && scenes, firstKey = firstIsScene ? sha256(scenePrefix + scenePrompts[0] + lockTag + gTag) : ''
      let lockDrawn = 0
      if (golden && styleLock) goldenIdentity = (await goldenLockFor(blobs, job.id, golden, async () => ({ bytes: styleLock!.bytes }), 'approved-thumbnail')).identity
      else if (firstIsScene) {
        goldenIdentity = (await goldenLockFor(blobs, job.id, golden!, async () => {
          const cached = await withBytes(await meta('image', firstKey)); if (cached) return cached
          if (!imageKey) throw new StageError('PROVIDER_DOWN', 'GEMINI_API_KEY is not configured (every picture is drawn by Gemini)', true)
          const x = await goldenImage(golden!, scenePrompts[0], '16:9', imageKey, deps.imageFetch ?? fetch, null); lockDrawn++
          const h = sha256(x.bytes), ref = `generative-assets/images/${h}.jpg`
          await blobs.putBytes(ref, x.bytes, x.contentType); await blobs.putJson(`generative-cache/image/${firstKey}.json`, { ref, sha256: h, contentType: x.contentType, provider: x.provider, model: x.model })
          return x
        }, 'first-scene')).identity
      }
      const idTag = goldenLockTag(goldenIdentity)
      const draw = (p: string) => (goldenDraw ? goldenDraw(p, imageKey) : yasa ? yadamDraw(p, imageKey, { approved: styleLock?.bytes ?? null }) : styleLock ? imageRef(`${p}\n\n${styleLock.text}`, styleLock.bytes, imageKey) : image(p, imageKey))
      const drawRepresentative: DrawRefFn = goldenDraw ? (p, _ref, k) => goldenDraw(p.trim(), k) : yasa ? (p, ref, k) => yadamDraw(p.trim(), k, { approved: ref }) : imageRef
      // paid calls only on a cache miss (an ASSET rerun reuses every picture and every narration chunk); the prompt (and so
      // the style, and the approved reference picture) is part of every image key
      const ik = sha256((styleLock ? 'longform-image-ref-v1|' : 'longform-image-v1|') + prompt + lockTag + gTag + idTag)
      // the first scene of a Golden job IS the character lock (no identity image); every other picture carries the lock's hash
      const sceneKeys = scenePrompts.map((x, i) => (firstIsScene && i === 0 ? firstKey : sha256(scenePrefix + x + lockTag + gTag + idTag)))
      const sceneMeta = await Promise.all(sceneKeys.map((k) => meta('image', k)))
      let im: any = scenes ? null : await withBytes(await meta('image', ik)), generated = lockDrawn, reused = 0
      const ttsKeys = chunks.map((c) => sha256(ttsCacheIdentity(voice, c.text)))
      const ttsMeta = await Promise.all(ttsKeys.map((k) => meta('tts', k)))
      const needImage = (!scenes && !im) || sceneMeta.some((x) => !x) || !!styleLock, needTts = ttsMeta.some((x) => !x)
      if (needImage && !imageKey) throw new StageError('PROVIDER_DOWN', 'GEMINI_API_KEY is not configured (every picture is drawn by Gemini)', true)
      if (needTts && !apiKey) throw new StageError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured', true)
      const sceneImages: any[] = [], madeNow = new Map<string, any>()
      // BUDGET (Senior): what is still UNPAID (pictures / narration not in the cache) against the job's budget, before the
      // next paid call; during the run every paid call reserves its price first. Over budget -> the job waits (BUDGET) with
      // everything made so far stored; job_resume with a bigger budget goes on and pays only for what is missing.
      const guard = senior && Number.isFinite(job.budgetUsd) ? budgetGuard({ budgetUsd: job.budgetUsd, spentBefore: (await costSoFar?.()) ?? 0 }) : null
      const ttsMissing = new Set(chunks.map((_, i) => i).filter((i) => !ttsMeta[i]))
      const left = (fromScene: number) => ({ images: new Set(sceneKeys.filter((k, i) => i >= fromScene && !sceneMeta[i] && !madeNow.has(k))).size, chars: [...ttsMissing].reduce((a, i) => a + [...chunks[i].text].length, 0) })
      const budgetWait = (l: { images: number; chars: number }) => ({ result: { budget: { ...seniorCostEstimate({ pictures: l.images, narrationChars: l.chars, spentUsd: guard!.spent(), budgetUsd: job.budgetUsd }), stopped: 'before the next paid call', made: { pictures: new Set(sceneKeys).size - l.images, narration: chunks.length - ttsMissing.size } } }, wait: 'BUDGET' as const })
      if (guard && !seniorCostEstimate({ pictures: left(0).images, narrationChars: left(0).chars, spentUsd: guard.spent(), budgetUsd: job.budgetUsd }).fits) return budgetWait(left(0))
      // 썸네일만 다시 생성 (asked from the phone while the job waited): ONE new thumbnail picture with the character lock,
      // checked against the kept representative; the approved picture stays the lock (every key above is unchanged)
      if (styleLock && approval?.thumbnailRequest) {
        if (!imageKey) throw new StageError('PROVIDER_DOWN', 'GEMINI_API_KEY is not configured (every picture is drawn by Gemini)', true)
        const thumbDraw = (p: string) => (goldenDraw ? goldenDraw(p, imageKey) : yasa ? yadamDraw(p, imageKey, { approved: styleLock!.bytes }) : imageRef(`${p}\n\n${styleLock!.text}`, styleLock!.bytes, imageKey))
        const go = await thumbnailRework({ jobId: job.id, blobs, record: approval, prompt: thumbPrompt, draw: thumbDraw, judge: deps.styleJudge ?? openAiStyleJudge(), apiKey, signal })
        generated++
        if (!go) return { result: { styleApproval: { status: 'approved', representative: approval.representative ?? null, thumbnail: 'mismatch' } }, wait: 'DECISION' as const }
      }
      // the representative picture first: drawn from the reference and compared with it; only a match unlocks the rest
      if (styleLock) {
        const key = scenes ? sceneKeys[repIndex] : ik, cached = await withBytes(await meta('image', key))
        const repCost = !cached && approval?.representative?.status !== 'match' ? 2 * SENIOR_COST.imageUsd : 0 // up to 2 tries
        if (guard && repCost && !guard.take(repCost)) return budgetWait(left(0))
        let x: any
        try { x = await representativeCheck({ jobId: job.id, blobs, record: approval, reference: styleLock, prompt: scenes ? scenePrompts[repIndex] : prompt, sceneId: scenes ? sceneList[repIndex].id : null, apiKey, imageKey, drawRef: drawRepresentative, judge: deps.styleJudge ?? openAiStyleJudge(), cached, freeChecks: !golden }) } finally { if (guard && repCost) guard.done(repCost) }
        if (!x) return { result: { styleApproval: { status: 'approved', representative: approval.representative ?? null } }, wait: 'DECISION' as const }
        if (x !== cached && !(x as any).kept) generated++
        else if ((x as any).kept) reused++
        if (scenes) madeNow.set(key, x); else im = x
      }
      for (const [i, sc] of sceneList.entries()) {
        if (signal.aborted) throw new Error('aborted')
        // the same picture twice in one video (same prompt) is generated once
        let x: any = madeNow.get(sceneKeys[i]) ?? (sceneMeta[i] ? await withBytes(sceneMeta[i]) : null)
        if (x) reused++; else {
          if (guard && !guard.take(SENIOR_COST.imageUsd)) return budgetWait(left(i))
          try { x = await draw(scenePrompts[i]) } finally { guard?.done(SENIOR_COST.imageUsd) }
          generated++
        }
        madeNow.set(sceneKeys[i], x)
        const h = sha256(x.bytes), ref = `generative-assets/images/${h}.jpg`
        if (!cacheEntryIsCanonical(x, ref, h)) {
          await blobs.putBytes(ref, x.bytes, x.contentType)
          await blobs.putJson(`generative-cache/image/${sceneKeys[i]}.json`, { ref, sha256: h, contentType: x.contentType, provider: x.provider, model: x.model })
        }
        sceneImages.push({ sceneId: sc.id, ref, sha256: h, prompt: scenePrompts[i], bytes: x.bytes })
      }
      if (scenes) im = { ...sceneImages[0], bytes: sceneImages[0].bytes }
      else if (im) reused++; else { im = await draw(prompt); generated++ }
      const work = await mkdtemp(join(tmpdir(), 'longform-asset-'))
      try {
        // the single picture: the figure is kept on the RIGHT (mirrored when the model drew it on the left); scene pictures
        // are full-frame story images and are used as they are
        let side: Awaited<ReturnType<typeof subjectSide>> | null = null, imageRef = '', imgSha = ''
        if (scenes) { imageRef = sceneImages[0].ref; imgSha = sceneImages[0].sha256 } else {
          const raw = join(work, 'raw.jpg'); await writeFile(raw, im.bytes)
          side = await subjectSide(raw)
          const final = join(work, 'image.jpg')
          if (side.side === 'left') await runOk(['-y', '-i', raw, '-vf', 'hflip', '-q:v', '2', final]); else await writeFile(final, im.bytes)
          const imgBytes = await readFile(final); imgSha = sha256(imgBytes)
          const rawSha = sha256(im.bytes), rawRef = `generative-assets/images/${rawSha}.jpg`
          const imageCacheValid = cacheEntryIsCanonical(im, rawRef, rawSha)
          if (!imageCacheValid) {
            await blobs.putBytes(rawRef, im.bytes, im.contentType)
            await blobs.putJson(`generative-cache/image/${ik}.json`, { ref: rawRef, sha256: rawSha, contentType: im.contentType, provider: im.provider, model: im.model })
          }
          imageRef = `generative-assets/images/${imgSha}.jpg`
          // If no mirror was needed, final bytes are already the cached raw image; do not write the same blob twice.
          if (imageRef !== rawRef) await blobs.putBytes(imageRef, imgBytes, 'image/jpeg')
        }

        // one TTS call per sentence (4 at a time); results are placed by index, so order is exactly the script's
        const parts: any[] = new Array(chunks.length), wavs: string[] = new Array(chunks.length)
        let next = 0, budgetHit = false
        const worker = async () => {
          for (let i = next++; i < chunks.length && !budgetHit; i = next++) {
            if (signal.aborted) throw new Error('aborted')
            const c = chunks[i], key = ttsKeys[i]
            let au: any = ttsMeta[i] ? await withBytes(ttsMeta[i]) : null
            if (au) reused++; else {
              const cost = ttsUsdOf([...c.text].length)
              if (guard && !guard.take(cost)) { budgetHit = true; return }
              try { au = await guardedTts(tts as TtsFn, c.text, apiKey, voice) } finally { guard?.done(cost) }
              generated++; ttsMissing.delete(i)
            }
            const ah = sha256(au.bytes), ref = `generative-assets/audio/${ah}.mp3`
            const ttsCacheValid = cacheEntryIsCanonical(au, ref, ah)
            if (!ttsCacheValid) {
              await blobs.putBytes(ref, au.bytes, au.contentType)
              await blobs.putJson(`generative-cache/tts/${key}.json`, { ref, sha256: ah, contentType: au.contentType, provider: au.provider, model: au.model })
            }
            const { wav, seconds } = await clipToWav(au.bytes, work, `c${i}`, signal)
            if (!(seconds > 0)) throw new StageError('TTS_INVALID', `narration sentence ${i + 1} has no audio`)
            parts[i] = { index: i, sentences: c.sentences, chars: [...c.text].length, textSha256: sha256(c.text), ref, sha256: ah, seconds }; wavs[i] = wav
          }
        }
        // a billing/auth stop from the narration engine ends the job at once (no stage retry pays again)
        try { await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker)) }
        catch (e: any) { if (e?.stop) throw new StageError(/quota|credit_balance/.test(String(e?.code)) ? 'PROVIDER_BILLING' : 'PROVIDER_STOP', String(e?.message || e).slice(0, 300), false); throw e }
        // Senior: a narration chunk would have taken the job over its budget -> wait; every chunk made is stored (cache)
        if (budgetHit) return budgetWait({ images: 0, chars: left(sceneKeys.length).chars })
        // ONE continuous narration track: the chunks back to back, in order (no gap, no overlap, no music)
        // ONE continuous narration track through the shared narration engine (one loudness pass, probed again)
        const narration = join(work, 'narration.m4a')
        const totalSeconds = Number(parts.reduce((s, x) => s + x.seconds, 0).toFixed(3))
        let narrationSeconds: number
        try { narrationSeconds = await assembleNarration({ wavs, dir: work, out: narration, totalSeconds, signal }) }
        catch (e: any) { if (/NARRATION_TIMING/.test(String(e?.message))) throw new StageError('NARRATION_TIMING', String(e.message)); throw e }
        // a 2-hour narration is ~150 MB: hashed and uploaded as a stream, never read whole into memory
        const nsha = await sha256File(narration), narrationRef = `generative-assets/audio/${nsha}.m4a`
        await blobs.putFile(narrationRef, narration, 'audio/mp4')
        const manifest = { schema: 'longform-assets/1', profile: job.profile, scriptRef, voiceProfileId: voice.id, ...(styleLock ? { approvedThumbnail: { ref: styleLock.thumbnailRef, backgroundRef: approval?.approved?.backgroundRef ?? null }, styleReference: { sha256: styleLock.sha, features: styleLock.features } } : {}), image: { ref: imageRef, sha256: imgSha, prompt, subjectSide: side, mirrored: side?.side === 'left' }, ...(scenes ? { images: sceneImages.map(({ bytes, ...x }) => x) } : {}), narration: { ref: narrationRef, sha256: nsha, seconds: narrationSeconds, loudness: LONGFORM_LOUDNORM }, chunks: parts }
        const stored = await putAddressed(blobs, 'generative-assets', manifest)
        return { outputRef: stored.path, outputHash: stored.sha256, result: { assetSpecRef: stored.path, images: scenes ? sceneImages.length : 1, chunks: parts.length, totalSeconds, voiceProfileId: voice.id, generated, reused }, provider: 'gemini+openai', model: 'gemini-3.1-flash-image+gpt-4o-mini-tts' }
      } finally { await rm(work, { recursive: true, force: true }) }
    }
  }
}

// The still-image encode runs well above real time; allow up to 1x real time + 30 min (never less than 90 min), so a
// 2-hour or longer narration is not killed half way.
export const longformRenderTimeoutMs = (seconds: number) => Math.max(90 * 60_000, Math.round(seconds * 1000) + 30 * 60_000)
// Feature modules inside this stage: CAPTION (sentence cards, required: LOCK) -> LONGFORM_RENDER -> THUMBNAIL -> QC
// (fatal output checks). THUMBNAIL/QC are skipped only when the profile does not select them.
// segmentRunner / segment: test seams (the ffmpeg call of one segment, the segment limits)
export const createLongformRenderExecutor = (deps: { features?: FeatureResolver; segment?: { maxRuns: number; maxSeconds: number }; segmentRunner?: (argv: string[], opts: any, index: number) => Promise<unknown> } = {}): StageExecutor => ({
  stage: 'RENDER', estimateUsd: () => 0,
  inputHash: (job) => sha256(`longform-render|${job.id}|${job.planRev}|wisdom_longform/1`),
  async run({ job, blobs, previous, signal }) {
    if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform RENDER only handles longform profiles')
    const features = featuresOf(deps, job); needFeatures(features, ['LONGFORM_RENDER', 'CAPTION'], 'Longform RENDER')
    const mode = longformMode(job.profile), scenes = mode.images === 'scenes'
    const withThumbnail = features.has('THUMBNAIL'), withQc = features.has('QC')
    const a = await previous('ASSET'), assets: any = (a?.result as any)?.assetSpecRef ? await blobs.getJson((a!.result as any).assetSpecRef) : null
    const script = (assets?.scriptRef ? await blobs.getJson(assets.scriptRef) : null) as LongformScript | null
    if (!assets || !script) throw new StageError('ASSET_MISSING', 'RENDER requires the longform ASSET manifest')
    const img = await blobs.getBytes(assets.image.ref), aud = await blobs.getBytes(assets.narration.ref)
    if (!img || !aud) throw new StageError('ASSET_BYTES_MISSING', 'longform image or narration bytes are missing')
    const work = await mkdtemp(join(tmpdir(), 'longform-render-'))
    try {
      // libass uses Fontconfig even when fontsdir is supplied. Railway has no system Fontconfig config, so give this
      // render a tiny self-contained config that scans only our bundled Korean font and writes cache only under /tmp.
      let segmentLog: Record<string, unknown> | null = null, segmentsMade = 0, segmentsReused = 0
      // Senior: the REAL time each picture was on screen (measured narration), next to the PLAN's estimate
      let pacing: ReturnType<typeof runPacing> | null = null
      const fontConfig = join(work, 'fonts.conf')
      await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${FONTS_DIR}</dir><cachedir>${work}/font-cache</cachedir></fontconfig>`, 'utf8')
      const ffmpegEnv = { FONTCONFIG_FILE: fontConfig, FONTCONFIG_PATH: work }
      const image = join(work, 'image.jpg'), audio = join(work, 'narration.m4a'), assPath = join(work, 'cards.ass'), out = join(work, 'final.mp4'), thumbAss = join(work, 'thumb.ass'), thumb = join(work, 'thumbnail.jpg')
      await writeFile(image, img); await writeFile(audio, aud)
      // contract on what is actually voiced and drawn: one narration chunk per sentence in order (no gap/repeat) and
      // every sentence a 2-3 line card with a coloured accent. The running time is NOT a condition (any length passes).
      let timeline
      try { timeline = cardTimeline(script, assets.chunks, assets.chunks.map((c: any) => c.seconds)) } catch (e: any) { throw new StageError('LONGFORM_CONTRACT', String(e?.message || e)) }
      const sents = sentencesOf(script)
      const badCards = sents.flatMap((x, k) => cardErrors(x).map((c) => `card ${k + 1}: ${c}`))
      if (badCards.length) throw new StageError('LONGFORM_CONTRACT', badCards.slice(0, 20).join('; '))
      // 숨은야담: the caption is the narration itself (every letter, chunked); Senior / Wisdom: the sentence cards
      const yasa = job.profile === 'yasa_longform'
      const subtitles = (tl: Array<{ start: number; end: number; k: number }>) => { if (yasa) { const y = yasaCaptionsAss(script, tl); return { ass: y.ass, cards: y.cards, sentences: y.sentences } } const c = longformCardsAss(script, tl, mode.cards); return { ass: c.ass, cards: c.cards, sentences: c.cards.length } }
      const { ass, cards, sentences: drawn } = subtitles(timeline)
      if (drawn !== sents.length) throw new StageError('LONGFORM_CONTRACT', `${drawn} sentences captioned of ${sents.length}`)
      await writeFile(assPath, ass, 'utf8')
      // the video runs exactly as long as the FINAL narration file (measured); an unreadable/empty narration is a defect
      const seconds = Number((await probe(audio)).duration ?? 0)
      if (!(seconds > 0)) throw new StageError('LONGFORM_OUTPUT_INVALID', 'narration audio has no duration')
      if (scenes) {
        // Senior / 숨은야담: each scene picture held for exactly the narration told over it (gentle motion, hard cuts),
        // rendered in SEGMENTS cut at scene boundaries (bounded memory whatever the length), then stream-copied together
        const pics = (assets.images ?? []) as Array<{ sceneId: string; ref: string; sha256?: string }>
        const files: string[] = []
        for (const [i, x] of pics.entries()) { const b = await blobs.getBytes(x.ref); if (!b) throw new StageError('ASSET_BYTES_MISSING', `scene picture ${x.sceneId} is missing`); const f = join(work, `scene${i}.jpg`); await writeFile(f, b); files.push(f) }
        const spans = sceneRuns(script as unknown as SeniorScript, timeline)
        const runs = spans.map((r, i) => ({ image: pics.findIndex((x) => x.sceneId === r.sceneId), start: r.start, seconds: (i === spans.length - 1 ? seconds : spans[i + 1].start) - r.start, cold: !!r.cold }))
        if (runs.some((r) => r.image < 0)) throw new StageError('LONGFORM_CONTRACT', 'a scene has no picture')
        const frames = runFrames(runs.map((r) => r.start), seconds)
        const before = (i: number) => frames.slice(0, i).reduce((a, b) => a + b, 0)
        const specs = planSegments(runs, deps.segment ?? RENDER_SEGMENT).map((g, k) => {
          const from = runs[g.from].start, to = g.to < runs.length ? runs[g.to].start : Infinity, shift = before(g.from) / LONGFORM.fps
          // the segment's own subtitle cards (a card never crosses a segment: segments start where a sentence starts)
          const tl = timeline.filter((t) => t.start >= from - 1e-6 && t.start < to - 1e-6).map((t) => ({ ...t, start: Number(Math.max(0, t.start - shift).toFixed(3)), end: Number((t.end - shift).toFixed(3)) }))
          const segAss = subtitles(tl).ass
          const segRuns = runs.slice(g.from, g.to).map((r, j) => ({ image: r.image, frames: frames[g.from + j], index: g.from + j, ...(r.cold ? { cold: true } : {}) }))
          const key = sha256(JSON.stringify({ v: SEGMENT_ENCODER, canvas: SENIOR.canvas, fps: LONGFORM.fps, runs: segRuns.map((r) => ({ picture: pics[r.image].sha256 ?? pics[r.image].ref, frames: r.frames, index: r.index, cold: !!r.cold })), ass: sha256(segAss) }))
          return { k, segAss, segRuns, key, cards: tl.length }
        })
        // checkpoint: render-segments/<job>/<plan>/segment-NNN.mp4 — a retry re-renders only the segments not stored yet
        const plan = sha256(specs.map((x) => x.key).join('|')), run = deps.segmentRunner ?? ((argv: string[], opts: any) => runOk(argv, opts))
        if (specs.reduce((a, x) => a + x.cards, 0) !== sents.length) throw new StageError('LONGFORM_CONTRACT', 'subtitle cards do not split cleanly into segments')
        const list: string[] = []
        for (const sp of specs) {
          if (signal.aborted) throw new Error('aborted')
          const name = `segment-${String(sp.k + 1).padStart(3, '0')}.mp4`, ref = `render-segments/${job.id}/${plan}/${name}`, f = join(work, name)
          // a segment made by an earlier attempt is reused (streamed to disk, never held whole in memory)
          const stored = await (blobs.getFile ? blobs.getFile(ref, f) : blobs.getBytes(ref).then(async (b) => (b ? (await writeFile(f, b), true) : false))).catch(() => false)
          if (stored) segmentsReused++
          else {
            const sa = join(work, `segment-${sp.k + 1}.ass`); await writeFile(sa, sp.segAss, 'utf8')
            const segSeconds = sp.segRuns.reduce((a, r) => a + r.frames, 0) / LONGFORM.fps
            // only THIS segment's pictures go into this ffmpeg process
            await run(sceneSegmentArgv({ images: files, runs: sp.segRuns, ass: sa, fontsDir: FONTS_DIR, out: f, threads: VIDEO_ENCODER_THREADS }), { signal, timeoutMs: longformRenderTimeoutMs(segSeconds) * 2, env: ffmpegEnv }, sp.k)
            await blobs.putFile(ref, f, 'video/mp4'); segmentsMade++
          }
          list.push(`file '${f.replace(/'/g, "'\\''")}'`)
        }
        const listPath = join(work, 'segments.txt'); await writeFile(listPath, list.join('\n') + '\n', 'utf8')
        await runOk(segmentConcatArgv({ list: listPath, audio, out, seconds }), { signal, timeoutMs: longformRenderTimeoutMs(seconds), env: ffmpegEnv })
        if (job.profile === 'senior_longform') pacing = runPacing(runs)
        segmentLog = { plan, segments: specs.length, made: segmentsMade, reused: segmentsReused, maxPicturesPerProcess: Math.max(...specs.map((x) => x.segRuns.length)) }
      } else {
        const background = join(work, 'background.png')
        await runOk(longformBackgroundArgv({ image, out: background }), { signal })
        await runOk(longformVideoArgv({ background, audio, ass: assPath, fontsDir: FONTS_DIR, out, seconds }), { signal, timeoutMs: longformRenderTimeoutMs(seconds), env: ffmpegEnv })
      }
      // click thumbnail: the same single image (figure RIGHT), the planner's re-written punch lines on the LEFT
      if (withThumbnail) {
        // the thumbnail the user approved (style lock) is THE thumbnail; otherwise it is composed here as before
        // every Longform: the background (the approved one, else the video's own picture) + the video's FINAL title, exactly
        await writeFile(thumb, await longformTitleThumbnail({ jobId: job.id, blobs, assets, title: script.title, picture: () => readFile(image) }))
        void thumbAss
      }
      // fatal-only output checks (broken file / wrong canvas / missing narration / wrong length)
      const info = await probe(out), tinfo = withThumbnail ? await probe(thumb) : null
      const problems = !withQc ? [] : [
        ...(info.width !== LONGFORM.canvas.w || info.height !== LONGFORM.canvas.h ? [`video ${info.width}x${info.height}`] : []),
        ...(!info.hasAudio ? ['no narration audio'] : []),
        ...(Math.abs(Number(info.duration || 0) - seconds) > 1.5 ? [`duration ${info.duration} vs narration ${seconds}`] : []),
        ...(tinfo && (tinfo.width !== LONGFORM_THUMB.w || tinfo.height !== LONGFORM_THUMB.h) ? [`thumbnail ${tinfo.width}x${tinfo.height}`] : [])
      ]
      if (problems.length) throw new StageError('LONGFORM_OUTPUT_INVALID', problems.join('; '))
      // the final MP4 of a 60-120+ minute video is never loaded into memory: streamed sha256, streamed upload to the
      // same content-addressed renders/<sha256>.mp4; a retry whose render already exists is not uploaded again
      const renderHash = await sha256File(out)
      const stored = await blobs.putFile(`renders/${renderHash}.mp4`, out, 'video/mp4')
      const tb = withThumbnail ? await readFile(thumb) : null, thumbStored = tb ? await blobs.putBytes(`renders/${sha256(tb)}.jpg`, tb, 'image/jpeg') : null
      const thumbRef = thumbStored ? thumbStored.path : null
      const v = { variantId: 'v1', label: '롱폼', manifestHash: renderHash, renderRef: stored.path, renderHash, bytes: stored.bytes, duration: info.duration, posterRef: thumbRef, thumbnailRef: thumbRef, gate: { decision: 'PASS', reasons: [], checks: [] }, publishable: true }
      return { outputRef: stored.path, outputHash: renderHash, result: { variants: [v], cards: cards.length, imageRef: assets.image.ref, ...(scenes ? { scenePictures: (assets.images ?? []).length, segments: segmentLog } : {}), ...(pacing ? { pacing } : {}), thumbnailRef: thumbRef, canvas: `${info.width}x${info.height}`, durationSec: info.duration }, provider: 'ffmpeg', model: 'libx264+libass' }
    } finally { await rm(work, { recursive: true, force: true }) }
  }
})
export const longformRenderExecutor: StageExecutor = createLongformRenderExecutor()

export const longformPackageExecutor: StageExecutor = {
  stage: 'PACKAGE', estimateUsd: () => 0,
  inputHash: (job) => sha256(`longform-package|${job.id}|${job.planRev}`),
  async run({ job, blobs, previous }) {
    if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform PACKAGE only handles longform profiles')
    const r = await previous('RENDER'), v = (r?.result as any)?.variants?.[0]
    const p = await previous('PLAN'), script = ((p?.result as any)?.scriptRef ? await blobs.getJson((p!.result as any).scriptRef) : null) as LongformScript | null
    if (!v || !script) throw new StageError('RENDER_MISSING', 'PACKAGE requires the longform RENDER and PLAN')
    // a Longform job never completes without its upload text and thumbnail
    if (!longformPackageMetadata(script)) throw new StageError('UPLOAD_PACKAGE_INVALID', 'upload text does not pass the upload rules')
    if (!v.thumbnailRef || !(await blobs.getBytes(v.thumbnailRef))) throw new StageError('THUMBNAIL_MISSING', 'longform thumbnail is missing')
    const pkg = { schema: 'longform-package/1', profile: job.profile, finalRenderRef: v.renderRef, renderHash: v.renderHash, thumbnailRef: v.thumbnailRef, durationSec: v.duration, aspectRatio: '16:9', publishable: true, ...(() => { const m = longformPackageMetadata(script); return { metadata: m, uploadReady: !!m } })(), thumbnailLines: script.thumbnail.lines }
    const stored = await putAddressed(blobs, 'packages', pkg)
    return { outputRef: stored.path, outputHash: sha256(stored.path), result: { packageRef: stored.path, finalRenderRef: v.renderRef, renderHash: v.renderHash, thumbnailRef: v.thumbnailRef, durationSec: v.duration, publishable: true } }
  }
}
