// Wisdom SHORTS click thumbnail, made after PACKAGE (the video is already final and untouched). Non-blocking: any failure
// keeps the package exactly as the Shorts PACKAGE stage wrote it (the old phone-side thumbnail button still works).
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { runOk } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
import { openAiLongformImage } from '../../lib/generative/providers.js'
import { openAiWisdomThumbnailCopy, thumbnailArgv, thumbnailCopyErrors, thumbnailFigure, figureRightPrompt } from '../../lib/generative/wisdomThumbnail.js'
import { subjectSide } from './longform.js'
import type { StageExecutor } from '../types.js'

export function withWisdomThumbnail(pkg: StageExecutor, deps: { apiKey?: string; copy?: typeof openAiWisdomThumbnailCopy; image?: typeof openAiLongformImage } = {}): StageExecutor {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? '', copy = deps.copy ?? openAiWisdomThumbnailCopy, image = deps.image ?? openAiLongformImage
  return {
    ...pkg,
    estimateUsd: (job) => pkg.estimateUsd(job) + (job.profile === 'wisdom' ? 0.06 : 0),
    async run(ctx) {
      const res = await pkg.run(ctx)
      if (ctx.job.profile !== 'wisdom' || !apiKey) return res
      const { job, blobs, previous } = ctx
      const work = await mkdtemp(join(tmpdir(), 'wisdom-thumb-'))
      try {
        const plan = await previous('PLAN'), pr: any = plan?.result || {}
        const script: any = pr.scriptRef ? await blobs.getJson(pr.scriptRef) : null
        const bible: any = pr.visualBibleRef ? await blobs.getJson(pr.visualBibleRef) : null
        const brief: any = job.planRef ? await blobs.getJson(job.planRef) : null
        if (!script) throw new Error('script missing')
        const topic = String(brief?.text || script.title || '')
        const narration = (script.beats || []).map((b: any) => b.narration).join(' ')
        let made = await copy({ topic, title: script.title, hook: script.hook, narration }, apiKey)
        let errs = thumbnailCopyErrors(made.lines, script.title)
        if (errs.length) { made = await copy({ topic: `${topic}\n[REPAIR] previous copy rejected: ${errs.join(', ')}`, title: script.title, hook: script.hook, narration }, apiKey); errs = thumbnailCopyErrors(made.lines, script.title) }
        if (errs.length) throw new Error('thumbnail copy: ' + errs.join(','))
        const style = bible ? ` Style matching the video: ${bible.style}; palette ${bible.palette}; lighting ${bible.lighting}.` : ''
        const prompt = figureRightPrompt(thumbnailFigure(topic, made.figure)) + style
        const ik = sha256('wisdom-thumb-image-v1|' + prompt)
        let im: any = null
        try { const m: any = await blobs.getJson(`generative-cache/image/${ik}.json`); const b = m?.ref ? await blobs.getBytes(m.ref) : null; if (b) im = { ...m, bytes: b } } catch {}
        if (!im) { im = await image(prompt, apiKey); const ref = `generative-assets/images/${sha256(im.bytes)}.jpg`; await blobs.putBytes(ref, im.bytes, im.contentType); await blobs.putJson(`generative-cache/image/${ik}.json`, { ref, sha256: sha256(im.bytes), contentType: im.contentType }) }
        const raw = join(work, 'raw.jpg'), img = join(work, 'img.jpg'), assPath = join(work, 't.ass'), out = join(work, 'thumb.jpg')
        await writeFile(raw, im.bytes)
        if ((await subjectSide(raw)).side === 'left') await runOk(['-y', '-i', raw, '-vf', 'hflip', '-q:v', '2', img]); else await writeFile(img, im.bytes)
        const t = thumbnailArgv({ image: img, lines: made.lines, assPath, fontsDir: FONTS_DIR, out })
        await writeFile(assPath, t.ass, 'utf8'); await runOk(t.argv)
        const tb = await readFile(out), stored = await blobs.putBytes(`renders/${sha256(tb)}.jpg`, tb, 'image/jpeg')
        const old: any = await blobs.getJson((res.result as any).packageRef)
        const next = await putAddressed(blobs, 'packages', { ...old, thumbnailRef: stored.path, thumbnailLines: made.lines })
        return { ...res, outputRef: next.path, outputHash: sha256(next.path), result: { ...(res.result as any), packageRef: next.path, thumbnailRef: stored.path } }
      } catch (e: any) {
        return { ...res, result: { ...(res.result as any), thumbnailError: String(e?.message || e).slice(0, 300) } }
      } finally { await rm(work, { recursive: true, force: true }) }
    }
  }
}
