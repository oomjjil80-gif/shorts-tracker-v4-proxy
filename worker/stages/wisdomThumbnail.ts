// Wisdom SHORTS publishing kit, made after PACKAGE (the video is already final and untouched): the click thumbnail and
// the YouTube upload text, both from the actual script. Non-blocking: each part that fails or does not pass its rules is
// left out (recorded in the result), and the package stays exactly as the Shorts PACKAGE stage wrote it otherwise.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { runOk } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
import { openAiLongformImage } from '../../lib/generative/providers.js'
import { openAiWisdomPublishKit, thumbnailArgv, thumbnailCopyErrors, thumbnailFigure, figureRightPrompt } from '../../lib/generative/wisdomThumbnail.js'
import { uploadMetadataErrors, uploadPackageText } from '../../lib/generative/uploadPackage.js'
import { subjectSide } from './longform.js'
import type { StageExecutor } from '../types.js'

export function withWisdomThumbnail(pkg: StageExecutor, deps: { apiKey?: string; kit?: typeof openAiWisdomPublishKit; image?: typeof openAiLongformImage } = {}): StageExecutor {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? '', kit = deps.kit ?? openAiWisdomPublishKit, image = deps.image ?? openAiLongformImage
  return {
    ...pkg,
    estimateUsd: (job) => pkg.estimateUsd(job) + (job.profile === 'wisdom' ? 0.07 : 0),
    async run(ctx) {
      const res = await pkg.run(ctx)
      if (ctx.job.profile !== 'wisdom' || !apiKey) return res
      const { job, blobs, previous } = ctx
      const work = await mkdtemp(join(tmpdir(), 'wisdom-kit-'))
      const extra: Record<string, unknown> = {}, notes: Record<string, string> = {}
      try {
        const plan = await previous('PLAN'), pr: any = plan?.result || {}
        const script: any = pr.scriptRef ? await blobs.getJson(pr.scriptRef) : null
        if (!script) throw new Error('script missing')
        const bible: any = pr.visualBibleRef ? await blobs.getJson(pr.visualBibleRef) : null
        const brief: any = job.planRef ? await blobs.getJson(job.planRef) : null
        const topic = String(brief?.text || script.title || ''), narration = (script.beats || []).map((b: any) => b.narration).join(' ')
        const check = (k: any) => ({ copy: thumbnailCopyErrors(k.lines, script.title), upload: uploadMetadataErrors(k.metadata || ({} as any), { narration, format: 'shorts' }) })
        let made = await kit({ topic, title: script.title, hook: script.hook, narration }, apiKey), errs = check(made)
        if (errs.copy.length || errs.upload.length) {
          made = await kit({ topic, title: script.title, hook: script.hook, narration, repair: [...errs.copy.map((x) => 'thumbnail ' + x), ...errs.upload] }, apiKey); errs = check(made)
        }
        if (!errs.upload.length) { const t = uploadPackageText(made.metadata); extra.metadata = { title: t.title, description: t.descriptionWithHashtags, tags: t.tags, hashtags: t.hashtags, pinnedComment: t.pinnedComment } }
        else notes.uploadError = 'upload text: ' + errs.upload.join(',')
        if (!errs.copy.length) {
          try {
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
            extra.thumbnailRef = stored.path; extra.thumbnailLines = made.lines
          } catch (e: any) { notes.thumbnailError = String(e?.message || e).slice(0, 300) }
        } else notes.thumbnailError = 'thumbnail copy: ' + errs.copy.join(',')
      } catch (e: any) { notes.kitError = String(e?.message || e).slice(0, 300) }
      finally { await rm(work, { recursive: true, force: true }) }
      if (!Object.keys(extra).length) return { ...res, result: { ...(res.result as any), ...notes } }
      const old: any = await blobs.getJson((res.result as any).packageRef)
      const next = await putAddressed(blobs, 'packages', { ...old, ...extra })
      return { ...res, outputRef: next.path, outputHash: sha256(next.path), result: { ...(res.result as any), packageRef: next.path, thumbnailRef: extra.thumbnailRef ?? null, uploadReady: !!extra.metadata, ...notes } }
    }
  }
}
