// Wisdom Longform stages (profile wisdom_longform): PLAN -> ASSET -> RENDER -> PACKAGE.
// Separate executors; the Shorts executors are reached unchanged for every other profile (see withLongform).
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { runOk, probe } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
import { openAiLongformImage, openAiWisdomTts } from '../../lib/generative/providers.js'
import { openAiLongformPlan } from '../../lib/generative/longformPlanner.js'
import {
  LONGFORM_PROFILE_ID, LONGFORM, validateLongformScript, allowedSeconds, cardErrors, sentencesOf, longformImagePrompt, ttsChunks, cardTimeline,
  longformCardsAss, longformBackgroundArgv, longformVideoArgv, longformPackageMetadata, type LongformBrief, type LongformScript
} from '../../lib/generative/longform.js'
import { thumbnailArgv, thumbnailFigure, THUMB } from '../../lib/generative/wisdomThumbnail.js'
import { StageError, type StageExecutor } from '../types.js'

const isLongform = (job: any) => job?.profile === LONGFORM_PROFILE_ID

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

export function createLongformPlanExecutor(deps: { apiKey?: string; plan?: typeof openAiLongformPlan } = {}): StageExecutor {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? '', plan = deps.plan ?? openAiLongformPlan
  return {
    stage: 'PLAN', estimateUsd: () => 0.3,
    inputHash: (job) => sha256(`longform-plan|${job.planRef}|wisdom_longform/1`),
    async run({ job, blobs }) {
      if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform PLAN only handles wisdom_longform')
      const brief = (job.planRef ? await blobs.getJson(job.planRef) : null) as LongformBrief | null
      if (!brief || brief.schema !== 'generative-brief/1' || brief.profile !== 'wisdom_longform') throw new StageError('BRIEF_INVALID', 'invalid wisdom_longform brief')
      // ONE path and ONE gate: every script (first draft or repair) must pass validateLongformScript; there is no
      // no-model fallback that could ship a shorter or unvalidated script.
      if (!apiKey) throw new StageError('PROVIDER_DOWN', 'the longform script needs the planner (OPENAI_API_KEY)', true)
      let script: LongformScript | null = null, provider = 'openai', errors: string[] = []
      {
        // one free repair: the exact validation errors go back to the planner before any paid asset
        for (let attempt = 0; attempt < 2 && !script; attempt++) {
          const b = attempt ? { ...brief, text: `${brief.text}\n\n[REPAIR] The previous draft was rejected: ${errors.join(', ')}. Fix exactly these points.` } : brief
          try { const s = await plan(b, apiKey); s.figure = { ...s.figure, imagePrompt: thumbnailFigure(brief.text, s.figure?.imagePrompt) }; errors = validateLongformScript(s, brief); if (!errors.length) { script = s; provider = attempt ? 'openai-repair' : 'openai' } }
          catch (e: any) { errors = [String(e?.message || e)] }
        }
      }
      if (!script) throw new StageError('SCRIPT_INVALID', errors.join(','))
      const stored = await putAddressed(blobs, 'generative-scripts', script)
      return { outputRef: stored.path, outputHash: stored.sha256, result: { profile: LONGFORM_PROFILE_ID, provider, scriptRef: stored.path, sentences: script.sections.reduce((n, s) => n + s.sentences.length, 0), validation: errors } }
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

export function createLongformAssetExecutor(deps: { apiKey?: string; image?: typeof openAiLongformImage; tts?: typeof openAiWisdomTts } = {}): StageExecutor {
  const image = deps.image ?? openAiLongformImage, tts = deps.tts ?? openAiWisdomTts, apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? ''
  return {
    stage: 'ASSET', estimateUsd: () => 1.0,
    inputHash: (job) => sha256(`longform-asset|${job.id}|${job.planRev}|wisdom_longform/1`),
    async run({ job, blobs, previous, signal }) {
      if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform ASSET only handles wisdom_longform')
      const p = await previous('PLAN'), scriptRef = (p?.result as any)?.scriptRef
      const script = (scriptRef ? await blobs.getJson(scriptRef) : null) as LongformScript | null
      if (!script || script.schema !== 'wisdom-longform-script/1') throw new StageError('SCRIPT_MISSING', 'ASSET requires the longform PLAN script')
      const cached = async (kind: string, key: string) => { try { const m: any = await blobs.getJson(`generative-cache/${kind}/${key}.json`); const b = m?.ref ? await blobs.getBytes(m.ref) : null; return b ? { ...m, bytes: b } : null } catch { return null } }
      const prompt = longformImagePrompt(script), chunks = ttsChunks(script)
      // paid calls only on a cache miss (an ASSET rerun reuses the image and every narration chunk)
      const ik = sha256('longform-image-v1|' + prompt)
      let im: any = await cached('image', ik), generated = 0, reused = 0
      const needKey = !im || (await Promise.all(chunks.map((c) => cached('tts', sha256('tts-v1|' + c.text))))).some((x) => !x)
      if (needKey && !apiKey) throw new StageError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured', true)
      if (im) reused++; else { im = await image(prompt, apiKey); generated++ }
      const work = await mkdtemp(join(tmpdir(), 'longform-asset-'))
      try {
        const raw = join(work, 'raw.jpg'); await writeFile(raw, im.bytes)
        const side = await subjectSide(raw)
        const final = join(work, 'image.jpg')
        if (side.side === 'left') await runOk(['-y', '-i', raw, '-vf', 'hflip', '-q:v', '2', final]); else await writeFile(final, im.bytes)
        const imgBytes = await readFile(final), imgSha = sha256(imgBytes)
        const rawRef = `generative-assets/images/${sha256(im.bytes)}.jpg`
        await blobs.putBytes(rawRef, im.bytes, im.contentType)
        await blobs.putJson(`generative-cache/image/${ik}.json`, { ref: rawRef, sha256: sha256(im.bytes), contentType: im.contentType, provider: im.provider, model: im.model })
        const imageRef = `generative-assets/images/${imgSha}.jpg`; await blobs.putBytes(imageRef, imgBytes, 'image/jpeg')

        // one TTS call per sentence (4 at a time); results are placed by index, so order is exactly the script's
        const parts: any[] = new Array(chunks.length), wavs: string[] = new Array(chunks.length)
        let next = 0
        const worker = async () => {
          for (let i = next++; i < chunks.length; i = next++) {
            if (signal.aborted) throw new Error('aborted')
            const c = chunks[i], key = sha256('tts-v1|' + c.text)
            let au: any = await cached('tts', key)
            if (au) reused++; else { au = await tts(c.text, apiKey); generated++ }
            const ah = sha256(au.bytes), ref = `generative-assets/audio/${ah}.mp3`
            await blobs.putBytes(ref, au.bytes, au.contentType)
            await blobs.putJson(`generative-cache/tts/${key}.json`, { ref, sha256: ah, contentType: au.contentType, provider: au.provider, model: au.model })
            const mp3 = join(work, `c${i}.mp3`), wav = join(work, `c${i}.wav`)
            await writeFile(mp3, au.bytes); await runOk(['-y', '-i', mp3, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', wav], { signal })
            const seconds = Number(Number((await probe(wav)).duration || 0).toFixed(3))
            if (!(seconds > 0)) throw new StageError('TTS_INVALID', `narration sentence ${i + 1} has no audio`)
            parts[i] = { index: i, sentences: c.sentences, chars: [...c.text].length, textSha256: sha256(c.text), ref, sha256: ah, seconds }; wavs[i] = wav
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker))
        // ONE continuous narration track: the chunks back to back, in order (no gap, no overlap, no music)
        const list = join(work, 'list.txt'); await writeFile(list, wavs.map((w) => `file '${w}'`).join('\n'))
        const narration = join(work, 'narration.m4a')
        await runOk(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'aac', '-b:a', '160k', narration], { signal, timeoutMs: 15 * 60_000 })
        const nb = await readFile(narration), nsha = sha256(nb), narrationRef = `generative-assets/audio/${nsha}.m4a`
        await blobs.putBytes(narrationRef, nb, 'audio/mp4')
        const totalSeconds = Number(parts.reduce((s, x) => s + x.seconds, 0).toFixed(3))
        const manifest = { schema: 'longform-assets/1', profile: LONGFORM_PROFILE_ID, scriptRef, image: { ref: imageRef, sha256: imgSha, prompt, subjectSide: side, mirrored: side.side === 'left' }, narration: { ref: narrationRef, sha256: nsha, seconds: totalSeconds }, chunks: parts }
        const stored = await putAddressed(blobs, 'generative-assets', manifest)
        return { outputRef: stored.path, outputHash: stored.sha256, result: { assetSpecRef: stored.path, images: 1, chunks: parts.length, totalSeconds, generated, reused }, provider: 'openai', model: 'gpt-image-1-mini+gpt-4o-mini-tts' }
      } finally { await rm(work, { recursive: true, force: true }) }
    }
  }
}

export const longformRenderExecutor: StageExecutor = {
  stage: 'RENDER', estimateUsd: () => 0,
  inputHash: (job) => sha256(`longform-render|${job.id}|${job.planRev}|wisdom_longform/1`),
  async run({ job, blobs, previous, signal }) {
    if (!isLongform(job)) throw new StageError('PROFILE_UNSUPPORTED', 'longform RENDER only handles wisdom_longform')
    const a = await previous('ASSET'), assets: any = (a?.result as any)?.assetSpecRef ? await blobs.getJson((a!.result as any).assetSpecRef) : null
    const script = (assets?.scriptRef ? await blobs.getJson(assets.scriptRef) : null) as LongformScript | null
    if (!assets || !script) throw new StageError('ASSET_MISSING', 'RENDER requires the longform ASSET manifest')
    const img = await blobs.getBytes(assets.image.ref), aud = await blobs.getBytes(assets.narration.ref)
    if (!img || !aud) throw new StageError('ASSET_BYTES_MISSING', 'longform image or narration bytes are missing')
    const work = await mkdtemp(join(tmpdir(), 'longform-render-'))
    try {
      const image = join(work, 'image.jpg'), audio = join(work, 'narration.m4a'), assPath = join(work, 'cards.ass'), out = join(work, 'final.mp4'), thumbAss = join(work, 'thumb.ass'), thumb = join(work, 'thumbnail.jpg')
      await writeFile(image, img); await writeFile(audio, aud)
      // contract on what is actually voiced and drawn: one narration chunk per sentence in order (no gap/repeat),
      // every sentence a 2-3 line card with a coloured accent, total narration inside the allowed length
      const brief: any = job.planRef ? await blobs.getJson(job.planRef) : null
      let timeline
      try { timeline = cardTimeline(script, assets.chunks, assets.chunks.map((c: any) => c.seconds)) } catch (e: any) { throw new StageError('LONGFORM_CONTRACT', String(e?.message || e)) }
      const sents = sentencesOf(script)
      const badCards = sents.flatMap((x, k) => cardErrors(x).map((c) => `card ${k + 1}: ${c}`))
      const voiced = assets.chunks.reduce((n: number, c: any) => n + Number(c.seconds), 0), ok = brief ? allowedSeconds(brief) : null
      const lengthBad = ok && (voiced < ok.min * 0.9 || voiced > ok.max * 1.1) ? [`narration ${Math.round(voiced)}s outside ${Math.round(ok.min)}-${Math.round(ok.max)}s`] : []
      if (badCards.length || lengthBad.length) throw new StageError('LONGFORM_CONTRACT', [...lengthBad, ...badCards].slice(0, 20).join('; '))
      const { ass, cards } = longformCardsAss(script, timeline)
      if (cards.length !== sents.length) throw new StageError('LONGFORM_CONTRACT', `${cards.length} cards drawn for ${sents.length} sentences`)
      await writeFile(assPath, ass, 'utf8')
      const seconds = Number((await probe(audio)).duration || assets.narration.seconds)
      const background = join(work, 'background.png')
      await runOk(longformBackgroundArgv({ image, out: background }), { signal })
      await runOk(longformVideoArgv({ background, audio, ass: assPath, fontsDir: FONTS_DIR, out, seconds }), { signal, timeoutMs: 90 * 60_000 })
      // click thumbnail: the same single image (figure RIGHT), the planner's re-written punch lines on the LEFT
      const t = thumbnailArgv({ image, lines: script.thumbnail.lines, assPath: thumbAss, fontsDir: FONTS_DIR, out: thumb })
      await writeFile(thumbAss, t.ass, 'utf8'); await runOk(t.argv, { signal })
      // fatal-only output checks (broken file / wrong canvas / missing narration / wrong length)
      const info = await probe(out), tinfo = await probe(thumb)
      const problems = [
        ...(info.width !== LONGFORM.canvas.w || info.height !== LONGFORM.canvas.h ? [`video ${info.width}x${info.height}`] : []),
        ...(!info.hasAudio ? ['no narration audio'] : []),
        ...(Math.abs(Number(info.duration || 0) - seconds) > 1.5 ? [`duration ${info.duration} vs narration ${seconds}`] : []),
        ...(tinfo.width !== THUMB.w || tinfo.height !== THUMB.h ? [`thumbnail ${tinfo.width}x${tinfo.height}`] : [])
      ]
      if (problems.length) throw new StageError('LONGFORM_OUTPUT_INVALID', problems.join('; '))
      const bytes = await readFile(out), renderHash = sha256(bytes)
      const stored = await blobs.putBytes(`renders/${renderHash}.mp4`, bytes, 'video/mp4')
      const tb = await readFile(thumb), thumbStored = await blobs.putBytes(`renders/${sha256(tb)}.jpg`, tb, 'image/jpeg')
      const v = { variantId: 'v1', label: '롱폼', manifestHash: renderHash, renderRef: stored.path, renderHash, bytes: bytes.length, duration: info.duration, posterRef: thumbStored.path, thumbnailRef: thumbStored.path, gate: { decision: 'PASS', reasons: [], checks: [] }, publishable: true }
      return { outputRef: stored.path, outputHash: renderHash, result: { variants: [v], cards: cards.length, imageRef: assets.image.ref, thumbnailRef: thumbStored.path, canvas: `${info.width}x${info.height}`, durationSec: info.duration }, provider: 'ffmpeg', model: 'libx264+libass' }
    } finally { await rm(work, { recursive: true, force: true }) }
  }
}

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
