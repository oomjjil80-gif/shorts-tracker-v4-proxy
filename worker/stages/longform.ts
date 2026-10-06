// Wisdom Longform stages (profile wisdom_longform): PLAN -> ASSET -> RENDER -> PACKAGE.
// Separate executors; the Shorts executors are reached unchanged for every other profile (see withLongform).
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { runOk, probe } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
import { openAiLongformImage, openAiTts } from '../../lib/generative/providers.js'
import { openAiLongformPlanner, type LongformPlanner, type LongformOutline, type LongformSectionDraft, type LongformMetadataDraft } from '../../lib/generative/longformPlanner.js'
import {
  LONGFORM_PROFILE_ID, LONGFORM, validateLongformScript, cardErrors, sentencesOf, narrationOf, longformImagePrompt, ttsChunks, cardTimeline, sectionPlan, longformFigure,
  longformCardsAss, longformBackgroundArgv, longformVideoArgv, longformPackageMetadata, type LongformBrief, type LongformScript
} from '../../lib/generative/longform.js'
import { thumbnailArgv, thumbnailCopyErrors, THUMB } from '../../lib/generative/wisdomThumbnail.js'
import { uploadMetadataErrors } from '../../lib/generative/uploadPackage.js'
import { longformVoiceProfile, ttsCacheIdentity } from '../../lib/generative/voiceProfile.js'
import { StageError, type StageExecutor } from '../types.js'
import { profileFeatures, needFeatures, type FeatureResolver } from '../modules/features.js'
import { cacheEntryIsCanonical } from '../../lib/generative/cache.js'


const isLongform = (job: any) => job?.profile === LONGFORM_PROFILE_ID
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
export const LONGFORM_PLANNER_VERSION = 'longform-sections/1'
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

// PLAN: outline -> each section -> upload text. Every step is stored as a checkpoint (keyed by the brief + planner
// version) the moment it passes its checks; a retry reuses every stored step and only writes what is missing, so a long
// script is never regenerated from the start. targetSeconds only sizes the script (number and length of sections).
export function createLongformPlanExecutor(deps: { apiKey?: string; planner?: LongformPlanner } = {}): StageExecutor {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? '', planner = deps.planner ?? openAiLongformPlanner()
  return {
    stage: 'PLAN', estimateUsd: () => 0.3,
    inputHash: (job) => sha256(`longform-plan|${job.planRef}|wisdom_longform/1`),
    async run({ job, blobs, signal }) {
      if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform PLAN only handles wisdom_longform')
      const brief = (job.planRef ? await blobs.getJson(job.planRef) : null) as LongformBrief | null
      if (!brief || brief.schema !== 'generative-brief/1' || brief.profile !== 'wisdom_longform') throw new StageError('BRIEF_INVALID', 'invalid wisdom_longform brief')
      if (!apiKey) throw new StageError('PROVIDER_DOWN', 'the longform script needs the planner (OPENAI_API_KEY)', true)
      const size = sectionPlan(brief.targetSeconds)
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
          catch (e: any) { errs = [String(e?.message || e)] }
        }
        // retryable: the stage retry resumes from the stored steps
        throw new StageError(code, `${name}: ${errs.slice(0, 20).join(', ')}`, true)
      }
      const outline = await step<LongformOutline>('outline', 'OUTLINE_INVALID', (r) => planner.outline(brief, size.sections, apiKey, r), (o) => outlineErrors(o, size.sections))
      const sections: LongformScript['sections'] = []
      let tail: string[] = []
      for (let i = 0; i < outline.sections.length; i++) {
        const d = await step<LongformSectionDraft>(`section-${String(i + 1).padStart(3, '0')}`, 'SECTION_INVALID', (r) => planner.section({ brief, outline, index: i, previousTail: tail, targetChars: size.charsPerSection, repair: r }, apiKey), sectionErrors)
        sections.push({ id: String(outline.sections[i].id || `s${i + 1}`), sentences: d.sentences })
        tail = d.sentences.slice(-2).map((x) => x.say)
      }
      // a figure the topic names (the Buddha, a named thinker) stays that person
      const figure = { name: outline.figure.name, imagePrompt: longformFigure(brief.text, outline.figure.imagePrompt) }
      const body = { schema: 'wisdom-longform-script/1' as const, title: outline.title, hook: outline.hook, figure, thumbnail: outline.thumbnail, sections }
      const narration = narrationOf({ ...body, metadata: { description: '', tags: [], hashtags: [], pinnedComment: '' } })
      const meta = await step<LongformMetadataDraft>('metadata', 'METADATA_INVALID', (r) => planner.metadata({ brief, title: outline.title, headings: outline.sections.map((x) => x.heading), narration, repair: r }, apiKey),
        (m) => [...uploadMetadataErrors(m, { narration, format: 'longform' }), ...thumbnailCopyErrors(outline.thumbnail.lines as any, String(m?.title || '')).map((x) => `thumbnail.${x}`)])
      const script: LongformScript = { ...body, title: meta.title, metadata: { description: meta.description, tags: meta.tags, hashtags: meta.hashtags, pinnedComment: meta.pinnedComment } }
      const errors = validateLongformScript(script, brief)
      if (errors.length) throw new StageError('SCRIPT_INVALID', errors.join(','))
      const stored = await putAddressed(blobs, 'generative-scripts', script)
      return { outputRef: stored.path, outputHash: stored.sha256, result: { profile: LONGFORM_PROFILE_ID, provider: 'openai', scriptRef: stored.path, sections: sections.length, sentences: sentencesOf(script).length, targetSeconds: brief.targetSeconds, checkpoints: { ref: ck, made, reused }, validation: errors } }
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
export const longformConcatTimeoutMs = (seconds: number) => Math.max(15 * 60_000, Math.round(seconds * 250) + 10 * 60_000)
export function createLongformAssetExecutor(deps: { apiKey?: string; image?: typeof openAiLongformImage; tts?: typeof openAiTts; features?: FeatureResolver } = {}): StageExecutor {
  const image = deps.image ?? openAiLongformImage, tts = deps.tts ?? openAiTts, apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? ''
  return {
    stage: 'ASSET', estimateUsd: () => 1.0,
    inputHash: (job) => sha256(`longform-asset|${job.id}|${job.planRev}|wisdom_longform/1`),
    async run({ job, blobs, previous, signal }) {
      if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform ASSET only handles wisdom_longform')
      needFeatures(featuresOf(deps, job), ['IMAGE', 'TTS'], 'Longform ASSET')
      const p = await previous('PLAN'), scriptRef = (p?.result as any)?.scriptRef
      const script = (scriptRef ? await blobs.getJson(scriptRef) : null) as LongformScript | null
      if (!script || script.schema !== 'wisdom-longform-script/1') throw new StageError('SCRIPT_MISSING', 'ASSET requires the longform PLAN script')
      const brief = (job.planRef ? await blobs.getJson(job.planRef) : null) as LongformBrief | null
      const voice = longformVoiceProfile(brief)
      const meta = async (kind: string, key: string) => { try { const m: any = await blobs.getJson(`generative-cache/${kind}/${key}.json`); return m?.ref ? m : null } catch { return null } }
      const withBytes = async (m: any) => { try { const b = m?.ref ? await blobs.getBytes(m.ref) : null; return b ? { ...m, bytes: b } : null } catch { return null } }
      const prompt = longformImagePrompt(script), chunks = ttsChunks(script)
      // paid calls only on a cache miss (an ASSET rerun reuses the image and every narration chunk)
      const ik = sha256('longform-image-v1|' + prompt)
      let im: any = await withBytes(await meta('image', ik)), generated = 0, reused = 0
      const ttsKeys = chunks.map((c) => sha256(ttsCacheIdentity(voice, c.text)))
      const ttsMeta = await Promise.all(ttsKeys.map((k) => meta('tts', k)))
      const needKey = !im || ttsMeta.some((x) => !x)
      if (needKey && !apiKey) throw new StageError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured', true)
      if (im) reused++; else { im = await image(prompt, apiKey); generated++ }
      const work = await mkdtemp(join(tmpdir(), 'longform-asset-'))
      try {
        const raw = join(work, 'raw.jpg'); await writeFile(raw, im.bytes)
        const side = await subjectSide(raw)
        const final = join(work, 'image.jpg')
        if (side.side === 'left') await runOk(['-y', '-i', raw, '-vf', 'hflip', '-q:v', '2', final]); else await writeFile(final, im.bytes)
        const imgBytes = await readFile(final), imgSha = sha256(imgBytes)
        const rawSha = sha256(im.bytes), rawRef = `generative-assets/images/${rawSha}.jpg`
        const imageCacheValid = cacheEntryIsCanonical(im, rawRef, rawSha)
        if (!imageCacheValid) {
          await blobs.putBytes(rawRef, im.bytes, im.contentType)
          await blobs.putJson(`generative-cache/image/${ik}.json`, { ref: rawRef, sha256: rawSha, contentType: im.contentType, provider: im.provider, model: im.model })
        }
        const imageRef = `generative-assets/images/${imgSha}.jpg`
        // If no mirror was needed, final bytes are already the cached raw image; do not write the same blob twice.
        if (imageRef !== rawRef) await blobs.putBytes(imageRef, imgBytes, 'image/jpeg')

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
        await runOk(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', narration], { signal, timeoutMs: longformConcatTimeoutMs(totalSeconds) })
        const nb = await readFile(narration), nsha = sha256(nb), narrationRef = `generative-assets/audio/${nsha}.m4a`
        await blobs.putBytes(narrationRef, nb, 'audio/mp4')
        const manifest = { schema: 'longform-assets/1', profile: LONGFORM_PROFILE_ID, scriptRef, voiceProfileId: voice.id, image: { ref: imageRef, sha256: imgSha, prompt, subjectSide: side, mirrored: side.side === 'left' }, narration: { ref: narrationRef, sha256: nsha, seconds: totalSeconds }, chunks: parts }
        const stored = await putAddressed(blobs, 'generative-assets', manifest)
        return { outputRef: stored.path, outputHash: stored.sha256, result: { assetSpecRef: stored.path, images: 1, chunks: parts.length, totalSeconds, voiceProfileId: voice.id, generated, reused }, provider: 'openai', model: 'gpt-image-1-mini+gpt-4o-mini-tts' }
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
    if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform RENDER only handles wisdom_longform')
    const features = featuresOf(deps, job); needFeatures(features, ['LONGFORM_RENDER', 'CAPTION'], 'Longform RENDER')
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
      const { ass, cards } = longformCardsAss(script, timeline)
      if (cards.length !== sents.length) throw new StageError('LONGFORM_CONTRACT', `${cards.length} cards drawn for ${sents.length} sentences`)
      await writeFile(assPath, ass, 'utf8')
      // the video runs exactly as long as the FINAL narration file (measured); an unreadable/empty narration is a defect
      const seconds = Number((await probe(audio)).duration ?? 0)
      if (!(seconds > 0)) throw new StageError('LONGFORM_OUTPUT_INVALID', 'narration audio has no duration')
      const background = join(work, 'background.png')
      await runOk(longformBackgroundArgv({ image, out: background }), { signal })
      await runOk(longformVideoArgv({ background, audio, ass: assPath, fontsDir: FONTS_DIR, out, seconds }), { signal, timeoutMs: longformRenderTimeoutMs(seconds), env: ffmpegEnv })
      // click thumbnail: the same single image (figure RIGHT), the planner's re-written punch lines on the LEFT
      if (withThumbnail) {
        const t = thumbnailArgv({ image, lines: script.thumbnail.lines, assPath: thumbAss, fontsDir: FONTS_DIR, out: thumb })
        await writeFile(thumbAss, t.ass, 'utf8'); await runOk(t.argv, { signal, env: ffmpegEnv })
      }
      // fatal-only output checks (broken file / wrong canvas / missing narration / wrong length)
      const info = await probe(out), tinfo = withThumbnail ? await probe(thumb) : null
      const problems = !withQc ? [] : [
        ...(info.width !== LONGFORM.canvas.w || info.height !== LONGFORM.canvas.h ? [`video ${info.width}x${info.height}`] : []),
        ...(!info.hasAudio ? ['no narration audio'] : []),
        ...(Math.abs(Number(info.duration || 0) - seconds) > 1.5 ? [`duration ${info.duration} vs narration ${seconds}`] : []),
        ...(tinfo && (tinfo.width !== THUMB.w || tinfo.height !== THUMB.h) ? [`thumbnail ${tinfo.width}x${tinfo.height}`] : [])
      ]
      if (problems.length) throw new StageError('LONGFORM_OUTPUT_INVALID', problems.join('; '))
      const bytes = await readFile(out), renderHash = sha256(bytes)
      const stored = await blobs.putBytes(`renders/${renderHash}.mp4`, bytes, 'video/mp4')
      const tb = withThumbnail ? await readFile(thumb) : null, thumbStored = tb ? await blobs.putBytes(`renders/${sha256(tb)}.jpg`, tb, 'image/jpeg') : null
      const thumbRef = thumbStored ? thumbStored.path : null
      const v = { variantId: 'v1', label: '롱폼', manifestHash: renderHash, renderRef: stored.path, renderHash, bytes: bytes.length, duration: info.duration, posterRef: thumbRef, thumbnailRef: thumbRef, gate: { decision: 'PASS', reasons: [], checks: [] }, publishable: true }
      return { outputRef: stored.path, outputHash: renderHash, result: { variants: [v], cards: cards.length, imageRef: assets.image.ref, thumbnailRef: thumbRef, canvas: `${info.width}x${info.height}`, durationSec: info.duration }, provider: 'ffmpeg', model: 'libx264+libass' }
    } finally { await rm(work, { recursive: true, force: true }) }
  }
})
export const longformRenderExecutor: StageExecutor = createLongformRenderExecutor()

export const longformPackageExecutor: StageExecutor = {
  stage: 'PACKAGE', estimateUsd: () => 0,
  inputHash: (job) => sha256(`longform-package|${job.id}|${job.planRev}`),
  async run({ job, blobs, previous }) {
    if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform PACKAGE only handles wisdom_longform')
    const r = await previous('RENDER'), v = (r?.result as any)?.variants?.[0]
    const p = await previous('PLAN'), script = ((p?.result as any)?.scriptRef ? await blobs.getJson((p!.result as any).scriptRef) : null) as LongformScript | null
    if (!v || !script) throw new StageError('RENDER_MISSING', 'PACKAGE requires the longform RENDER and PLAN')
    // a Longform job never completes without its upload text and thumbnail
    if (!longformPackageMetadata(script)) throw new StageError('UPLOAD_PACKAGE_INVALID', 'upload text does not pass the upload rules')
    if (!v.thumbnailRef || !(await blobs.getBytes(v.thumbnailRef))) throw new StageError('THUMBNAIL_MISSING', 'longform thumbnail is missing')
    const pkg = { schema: 'longform-package/1', profile: LONGFORM_PROFILE_ID, finalRenderRef: v.renderRef, renderHash: v.renderHash, thumbnailRef: v.thumbnailRef, durationSec: v.duration, aspectRatio: '16:9', publishable: true, ...(() => { const m = longformPackageMetadata(script); return { metadata: m, uploadReady: !!m } })(), thumbnailLines: script.thumbnail.lines }
    const stored = await putAddressed(blobs, 'packages', pkg)
    return { outputRef: stored.path, outputHash: sha256(stored.path), result: { packageRef: stored.path, finalRenderRef: v.renderRef, renderHash: v.renderHash, thumbnailRef: v.thumbnailRef, durationSec: v.duration, publishable: true } }
  }
}
