// Longform stages (profiles wisdom_longform and senior_longform): PLAN -> ASSET -> RENDER -> PACKAGE. One engine; the
// profile's mode (LONGFORM_MODES) picks one picture (Wisdom) or story scene pictures (Senior).
// Separate executors; the Shorts executors are reached unchanged for every other profile (see withLongform).
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, sha256File, putAddressed, type JobBlobStore } from '../../lib/jobs/blobs.js'
import { runOk, probe } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
import { openAiLongformImage, openAiTts } from '../../lib/generative/providers.js'
import { openAiLongformPlanner, type LongformPlanner, type LongformOutline, type LongformSectionDraft, type LongformMetadataDraft } from '../../lib/generative/longformPlanner.js'
import { openAiSeniorPlanner } from '../../lib/generative/seniorPlanner.js'
import { mergeSameScenes, seniorOutlineErrors, seniorActErrors, seniorScenePlan, seniorScenes, seniorScenePrompt, sceneRuns, seniorVideoArgv, type SeniorScript } from '../../lib/generative/seniorLongform.js'
import { briefVoice, creativeStyle, creativeStyleOverride, type CreativeContent } from '../../lib/generative/creativeProfile.js'
import { VISUAL_STYLE_PROFILES } from '../../lib/generative/visualStyle.js'
import { VIDEO_ENCODER_THREADS } from '../../lib/media/render.js'
import { openAiLongformResearcher, researchPath, researchErrors, sectionFragments, RESEARCH_MODEL, type LongformResearcher, type ResearchBundle } from '../../lib/generative/longformResearch.js'
import {
  LONGFORM, isLongformProfile, longformMode, validateLongformScript, cardErrors, sentencesOf, narrationOf, longformImagePrompt, ttsChunks, cardTimeline, sectionPlan, longformFigure,
  longformCardsAss, longformBackgroundArgv, longformVideoArgv, longformPackageMetadata, type LongformBrief, type LongformScript
} from '../../lib/generative/longform.js'
import { thumbnailArgv, thumbnailCopyErrors, LONGFORM_THUMB } from '../../lib/generative/wisdomThumbnail.js'
import { uploadMetadataErrors } from '../../lib/generative/uploadPackage.js'
import { ttsCacheIdentity } from '../../lib/generative/voiceProfile.js'
import { StageError, type StageExecutor } from '../types.js'
import { profileFeatures, needFeatures, type FeatureResolver } from '../modules/features.js'
import { cacheEntryIsCanonical } from '../../lib/generative/cache.js'


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
export function createLongformPlanExecutor(deps: { apiKey?: string; planner?: LongformPlanner; research?: LongformResearcher; log?: (line: string) => void } = {}): StageExecutor {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? '', researcher = deps.research ?? openAiLongformResearcher()
  const log = deps.log ?? ((line: string) => console.log(line))
  return {
    stage: 'PLAN', estimateUsd: () => 0.3,
    inputHash: (job) => sha256(`longform-plan|${job.planRef}|wisdom_longform/1`),
    async run({ job, blobs, signal }) {
      if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform PLAN only handles longform profiles')
      const brief = (job.planRef ? await blobs.getJson(job.planRef) : null) as LongformBrief | null
      if (!brief || brief.schema !== 'generative-brief/1' || brief.profile !== job.profile) throw new StageError('BRIEF_INVALID', `invalid ${job.profile} brief`)
      if (!apiKey) throw new StageError('PROVIDER_DOWN', 'the longform script needs the planner (OPENAI_API_KEY)', true)
      const mode = longformMode(job.profile), scenes = mode.images === 'scenes'
      const planner = deps.planner ?? (scenes ? openAiSeniorPlanner() : openAiLongformPlanner())
      // Senior: six acts (one section per act); Wisdom: sections sized by the running time
      const size = scenes ? (() => { const p = seniorScenePlan(brief.targetSeconds); return { sections: p.acts, charsPerSection: p.charsPerAct } })() : sectionPlan(brief.targetSeconds)
      const ck = `longform-plan-checkpoints/${sha256(`${job.planRef}|${LONGFORM_PLANNER_VERSION}`)}`
      const made: string[] = [], reused: string[] = []
      // one checkpointed step: reuse the stored result, else make it (one free repair with the exact errors) and store it
      async function step<T>(name: string, code: string, make: (repair?: string[]) => Promise<T>, errorsOf: (v: T) => string[]): Promise<T> {
        const hit = (await blobs.getJson(`${ck}/${name}.json`).catch(() => null)) as T | null
        if (hit && !errorsOf(hit).length) { reused.push(name); return hit }
        let errs: string[] = []
        for (let attempt = 0; attempt < 2; attempt++) {
          if (signal?.aborted) throw new Error('aborted')
          try { const v = await make(attempt ? errs : undefined); errs = errorsOf(v); if (!errs.length) { await blobs.putJson(`${ck}/${name}.json`, v, { overwrite: true }); made.push(name); return v } }
          catch (e: any) { if (e?.stop) throw stopError(e); errs = [String(e?.message || e)] }
        }
        // retryable: the stage retry resumes from the stored steps
        throw new StageError(code, `${name}: ${errs.slice(0, 20).join(', ')}`, true)
      }
      // research gathers wisdom sources (Wisdom Longform only; a Senior story is not researched)
      const { research, ref: rRef, log: rLog } = mode.research ? await longformResearchFor({ blobs, topic: brief.text, sections: size.sections, apiKey, researcher, log, signal }) : { research: null, ref: null, log: { cache: 'OFF' } as Record<string, unknown> }
      const outline = await step<LongformOutline>('outline', 'OUTLINE_INVALID', (r) => planner.outline(brief, size.sections, apiKey, r, research), (o) => [...outlineErrors(o, size.sections), ...(scenes ? seniorOutlineErrors(o) : [])])
      const castIds = new Set<string>(((outline as any).characters ?? []).map((c: any) => String(c?.id)))
      const sections: any[] = []
      let tail: string[] = []
      for (let i = 0; i < outline.sections.length; i++) {
        const actScenes = (outline.sections[i] as any).scenes
        const d = await step<LongformSectionDraft>(`section-${String(i + 1).padStart(3, '0')}`, 'SECTION_INVALID', (r) => planner.section({ brief, outline, index: i, previousTail: tail, targetChars: size.charsPerSection, repair: r, fragments: sectionFragments(research, i) }, apiKey),
          (d) => [...sectionErrors(d), ...(scenes ? seniorActErrors({ scenes: actScenes, sentences: (d as any)?.sentences }, castIds) : [])])
        // Senior: two scenes in a row with the same place/time/people/action are one picture
        sections.push(scenes ? { id: String(outline.sections[i].id || `a${i + 1}`), heading: outline.sections[i].heading, ...mergeSameScenes({ scenes: actScenes, sentences: d.sentences as any }) } : { id: String(outline.sections[i].id || `s${i + 1}`), sentences: d.sentences })
        tail = d.sentences.slice(-2).map((x) => x.say)
      }
      // a figure the topic names (the Buddha, a named thinker) stays that person (Wisdom); Senior: the main character
      const figure = scenes ? outline.figure : { name: outline.figure.name, imagePrompt: longformFigure(brief.text, outline.figure.imagePrompt) }
      const body: any = { schema: mode.script, title: outline.title, hook: outline.hook, figure, thumbnail: outline.thumbnail, ...(scenes ? { characters: (outline as any).characters } : {}), sections }
      const narration = narrationOf({ ...body, metadata: { description: '', tags: [], hashtags: [], pinnedComment: '' } })
      const meta = await step<LongformMetadataDraft>('metadata', 'METADATA_INVALID', (r) => planner.metadata({ brief, title: outline.title, headings: outline.sections.map((x) => x.heading), narration, repair: r }, apiKey),
        (m) => [...uploadMetadataErrors(m, { narration, format: 'longform' }), ...thumbnailCopyErrors(outline.thumbnail.lines as any, String(m?.title || '')).map((x) => `thumbnail.${x}`)])
      const script: any = { ...body, title: meta.title, metadata: { description: meta.description, tags: meta.tags, hashtags: meta.hashtags, pinnedComment: meta.pinnedComment } }
      const errors = validateLongformScript(script, brief)
      if (errors.length) throw new StageError('SCRIPT_INVALID', errors.join(','))
      const stored = await putAddressed(blobs, 'generative-scripts', script)
      return { outputRef: stored.path, outputHash: stored.sha256, result: { profile: job.profile, provider: 'openai', scriptRef: stored.path, sections: sections.length, sentences: sentencesOf(script).length, ...(scenes ? { scenes: seniorScenes(script).length } : {}), creative: brief.creative ?? null, targetSeconds: brief.targetSeconds, checkpoints: { ref: ck, made, reused }, research: { ref: rRef, ...rLog }, validation: errors } }
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
export const LONGFORM_LOUDNORM = 'loudnorm=I=-17:TP=-1.5:LRA=11'
export const longformConcatTimeoutMs = (seconds: number) => Math.max(15 * 60_000, Math.round(seconds * 250) + 10 * 60_000)
export function createLongformAssetExecutor(deps: { apiKey?: string; image?: typeof openAiLongformImage; tts?: typeof openAiTts; features?: FeatureResolver } = {}): StageExecutor {
  const image = deps.image ?? openAiLongformImage, tts = deps.tts ?? openAiTts, apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? ''
  return {
    stage: 'ASSET', estimateUsd: () => 1.0,
    inputHash: (job) => sha256(`longform-asset|${job.id}|${job.planRev}|wisdom_longform/1`),
    async run({ job, blobs, previous, signal }) {
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
      const sceneStyle = scenes ? ((brief?.creative && creativeStyle(brief.creative)) || VISUAL_STYLE_PROFILES['senior-warm-watercolor']) : null
      const scenePrompts = sceneList.map((sc) => seniorScenePrompt(script as unknown as SeniorScript, sc, sceneStyle!))
      const prompt = scenes ? scenePrompts[0] : longformImagePrompt(script, creativeStyleOverride(brief?.creative)), chunks = ttsChunks(script)
      // paid calls only on a cache miss (an ASSET rerun reuses every picture and every narration chunk); the prompt (and so
      // the style) is part of every image key
      const ik = sha256('longform-image-v1|' + prompt)
      const sceneKeys = scenePrompts.map((x) => sha256('longform-scene-image-v1|' + x))
      const sceneMeta = await Promise.all(sceneKeys.map((k) => meta('image', k)))
      let im: any = scenes ? null : await withBytes(await meta('image', ik)), generated = 0, reused = 0
      const ttsKeys = chunks.map((c) => sha256(ttsCacheIdentity(voice, c.text)))
      const ttsMeta = await Promise.all(ttsKeys.map((k) => meta('tts', k)))
      const needKey = (!scenes && !im) || sceneMeta.some((x) => !x) || ttsMeta.some((x) => !x)
      if (needKey && !apiKey) throw new StageError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured', true)
      const sceneImages: any[] = []
      for (const [i, sc] of sceneList.entries()) {
        if (signal.aborted) throw new Error('aborted')
        let x: any = sceneMeta[i] ? await withBytes(sceneMeta[i]) : null
        if (x) reused++; else { x = await image(scenePrompts[i], apiKey); generated++ }
        const h = sha256(x.bytes), ref = `generative-assets/images/${h}.jpg`
        if (!cacheEntryIsCanonical(x, ref, h)) {
          await blobs.putBytes(ref, x.bytes, x.contentType)
          await blobs.putJson(`generative-cache/image/${sceneKeys[i]}.json`, { ref, sha256: h, contentType: x.contentType, provider: x.provider, model: x.model })
        }
        sceneImages.push({ sceneId: sc.id, ref, sha256: h, prompt: scenePrompts[i], bytes: x.bytes })
      }
      if (scenes) im = { ...sceneImages[0], bytes: sceneImages[0].bytes }
      else if (im) reused++; else { im = await image(prompt, apiKey); generated++ }
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
        let next = 0
        const worker = async () => {
          for (let i = next++; i < chunks.length; i = next++) {
            if (signal.aborted) throw new Error('aborted')
            const c = chunks[i], key = ttsKeys[i]
            let au: any = ttsMeta[i] ? await withBytes(ttsMeta[i]) : null
            if (au) reused++; else { au = await tts(c.text, apiKey, voice); generated++ }
            const ah = sha256(au.bytes), ref = `generative-assets/audio/${ah}.mp3`
            const ttsCacheValid = cacheEntryIsCanonical(au, ref, ah)
            if (!ttsCacheValid) {
              await blobs.putBytes(ref, au.bytes, au.contentType)
              await blobs.putJson(`generative-cache/tts/${key}.json`, { ref, sha256: ah, contentType: au.contentType, provider: au.provider, model: au.model })
            }
            const mp3 = join(work, `c${i}.mp3`), wav = join(work, `c${i}.wav`)
            await writeFile(mp3, au.bytes); await runOk(['-y', '-i', mp3, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { signal }); await rm(mp3, { force: true })
            const seconds = Number(Number((await probe(wav)).duration || 0).toFixed(3))
            if (!(seconds > 0)) throw new StageError('TTS_INVALID', `narration sentence ${i + 1} has no audio`)
            parts[i] = { index: i, sentences: c.sentences, chars: [...c.text].length, textSha256: sha256(c.text), ref, sha256: ah, seconds }; wavs[i] = wav
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker))
        // ONE continuous narration track: the chunks back to back, in order (no gap, no overlap, no music)
        const list = join(work, 'list.txt'); await writeFile(list, wavs.map((w) => `file '${w}'`).join('\n'))
        const narration = join(work, 'narration.m4a')
        const totalSeconds = Number(parts.reduce((s, x) => s + x.seconds, 0).toFixed(3))
        // loudness is levelled ONCE on the whole track (never per sentence): about -17 LUFS, true peak <= -1.5 dBTP, so the
        // talk is easy to hear on a phone without clipping. loudnorm keeps every sample in place, so the measured chunk
        // timing (the cards) is unchanged; it only rounds the end up to its 100 ms frame (<= 0.1 s of trailing silence). The
        // encoded track is probed again: that duration is the narration's length, and it must match the sentences.
        await runOk(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-af', LONGFORM_LOUDNORM, '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', narration], { signal, timeoutMs: longformConcatTimeoutMs(totalSeconds) })
        const narrationSeconds = Number(Number((await probe(narration)).duration || 0).toFixed(3))
        if (!(narrationSeconds >= totalSeconds - 0.05 && narrationSeconds <= totalSeconds + 0.15)) throw new StageError('NARRATION_TIMING', `narration ${narrationSeconds}s != sentences ${totalSeconds}s`)
        // a 2-hour narration is ~150 MB: hashed and uploaded as a stream, never read whole into memory
        const nsha = await sha256File(narration), narrationRef = `generative-assets/audio/${nsha}.m4a`
        await blobs.putFile(narrationRef, narration, 'audio/mp4')
        const manifest = { schema: 'longform-assets/1', profile: job.profile, scriptRef, voiceProfileId: voice.id, image: { ref: imageRef, sha256: imgSha, prompt, subjectSide: side, mirrored: side?.side === 'left' }, ...(scenes ? { images: sceneImages.map(({ bytes, ...x }) => x) } : {}), narration: { ref: narrationRef, sha256: nsha, seconds: narrationSeconds, loudness: LONGFORM_LOUDNORM }, chunks: parts }
        const stored = await putAddressed(blobs, 'generative-assets', manifest)
        return { outputRef: stored.path, outputHash: stored.sha256, result: { assetSpecRef: stored.path, images: scenes ? sceneImages.length : 1, chunks: parts.length, totalSeconds, voiceProfileId: voice.id, generated, reused }, provider: 'openai', model: 'gpt-image-1-mini+gpt-4o-mini-tts' }
      } finally { await rm(work, { recursive: true, force: true }) }
    }
  }
}

// The still-image encode runs well above real time; allow up to 1x real time + 30 min (never less than 90 min), so a
// 2-hour or longer narration is not killed half way.
export const longformRenderTimeoutMs = (seconds: number) => Math.max(90 * 60_000, Math.round(seconds * 1000) + 30 * 60_000)
// Feature modules inside this stage: CAPTION (sentence cards, required: LOCK) -> LONGFORM_RENDER -> THUMBNAIL -> QC
// (fatal output checks). THUMBNAIL/QC are skipped only when the profile does not select them.
export const createLongformRenderExecutor = (deps: { features?: FeatureResolver } = {}): StageExecutor => ({
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
      const { ass, cards } = longformCardsAss(script, timeline, mode.cards)
      if (cards.length !== sents.length) throw new StageError('LONGFORM_CONTRACT', `${cards.length} cards drawn for ${sents.length} sentences`)
      await writeFile(assPath, ass, 'utf8')
      // the video runs exactly as long as the FINAL narration file (measured); an unreadable/empty narration is a defect
      const seconds = Number((await probe(audio)).duration ?? 0)
      if (!(seconds > 0)) throw new StageError('LONGFORM_OUTPUT_INVALID', 'narration audio has no duration')
      if (scenes) {
        // Senior: each scene picture held for exactly the narration told over it (gentle motion, hard cuts), one encode
        const pics = (assets.images ?? []) as Array<{ sceneId: string; ref: string }>
        const files: string[] = []
        for (const [i, x] of pics.entries()) { const b = await blobs.getBytes(x.ref); if (!b) throw new StageError('ASSET_BYTES_MISSING', `scene picture ${x.sceneId} is missing`); const f = join(work, `scene${i}.jpg`); await writeFile(f, b); files.push(f) }
        const runs = sceneRuns(script as unknown as SeniorScript, timeline).map((r, i, all) => ({ image: pics.findIndex((x) => x.sceneId === r.sceneId), seconds: (i === all.length - 1 ? seconds : all[i + 1].start) - r.start }))
        if (runs.some((r) => r.image < 0)) throw new StageError('LONGFORM_CONTRACT', 'a scene has no picture')
        await runOk(seniorVideoArgv({ images: files, runs, audio, ass: assPath, fontsDir: FONTS_DIR, out, seconds, threads: VIDEO_ENCODER_THREADS }), { signal, timeoutMs: longformRenderTimeoutMs(seconds) * 2, env: ffmpegEnv })
      } else {
        const background = join(work, 'background.png')
        await runOk(longformBackgroundArgv({ image, out: background }), { signal })
        await runOk(longformVideoArgv({ background, audio, ass: assPath, fontsDir: FONTS_DIR, out, seconds }), { signal, timeoutMs: longformRenderTimeoutMs(seconds), env: ffmpegEnv })
      }
      // click thumbnail: the same single image (figure RIGHT), the planner's re-written punch lines on the LEFT
      if (withThumbnail) {
        const t = thumbnailArgv({ image, lines: script.thumbnail.lines, assPath: thumbAss, fontsDir: FONTS_DIR, out: thumb, canvas: LONGFORM_THUMB })
        await writeFile(thumbAss, t.ass, 'utf8'); await runOk(t.argv, { signal, env: ffmpegEnv })
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
      return { outputRef: stored.path, outputHash: renderHash, result: { variants: [v], cards: cards.length, imageRef: assets.image.ref, ...(scenes ? { scenePictures: (assets.images ?? []).length } : {}), thumbnailRef: thumbRef, canvas: `${info.width}x${info.height}`, durationSec: info.duration }, provider: 'ffmpeg', model: 'libx264+libass' }
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
