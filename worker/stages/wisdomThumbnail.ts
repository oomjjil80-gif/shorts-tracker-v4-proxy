// Wisdom SHORTS publishing kit, made after PACKAGE (the video is already final and untouched): the click thumbnail and
// the YouTube upload text, both from the actual script. Non-blocking: each part that fails or does not pass its rules is
// left out (recorded in the result), and the package stays exactly as the Shorts PACKAGE stage wrote it otherwise.
import { creativeGolden } from '../../lib/generative/creativeProfile.js'
import { goldenCacheTag, goldenImage } from '../../lib/generative/goldenStyle.js'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { runOk } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
import { geminiPortraitImage } from '../../lib/generative/providers.js'
import { openAiWisdomPublishKit, thumbnailArgv, thumbnailCopyErrors, thumbnailFigure, figureBelowPrompt, SHORTS_THUMB } from '../../lib/generative/wisdomThumbnail.js'
import { uploadMetadataErrors, uploadPackageText } from '../../lib/generative/uploadPackage.js'
import { thinkerDisplayName } from '../../lib/generative/wisdom.js'
import type { StageExecutor } from '../types.js'

// the parent Longform in a derived Short's description and pinned comment (the short itself stays complete)
export function derivedUploadText(m: any, parent: { parentLongformTitle: string; parentLongformUrl?: string | null }) {
  const title = String(parent.parentLongformTitle || '').trim(), url = String(parent.parentLongformUrl || '').trim()
  const line = `이 이야기는 롱폼 「${title}」의 한 대목입니다. 더 깊은 이야기는 롱폼에서 이어집니다.${url ? ` ${url}` : ''}`
  const pin = `${String(m.pinnedComment || '').trim()} 전체 이야기는 롱폼 「${title}」에서 더 깊게 다룹니다.`
  return { ...m, description: `${String(m.description || '').trim()}\n\n${line}`, pinnedComment: [...pin].length <= 250 ? pin : m.pinnedComment }
}
import { profileFeatures, type FeatureResolver } from '../modules/features.js'

// THUMBNAIL is a feature module: when the profile does not select it, no thumbnail image/render is made and the
// thumbnail copy is not checked or repaired. The upload text is PACKAGE's and is made either way (same kit call).
export function withWisdomThumbnail(pkg: StageExecutor, deps: { apiKey?: string; imageKey?: string; imageFetch?: typeof fetch; kit?: typeof openAiWisdomPublishKit; image?: typeof geminiPortraitImage; features?: FeatureResolver } = {}): StageExecutor {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? '', kit = deps.kit ?? openAiWisdomPublishKit, image = deps.image ?? geminiPortraitImage
  const imageKey = deps.imageKey ?? process.env.GEMINI_API_KEY ?? '' // the picture: Gemini
  return {
    ...pkg,
    estimateUsd: (job) => pkg.estimateUsd(job) + (job.profile === 'wisdom' ? 0.07 : 0),
    async run(ctx) {
      const res = await pkg.run(ctx)
      if (ctx.job.profile !== 'wisdom' || !apiKey) return res
      const { job, blobs, previous } = ctx
      const thumbnail = (deps.features ?? profileFeatures)(job).has('THUMBNAIL')
      const work = await mkdtemp(join(tmpdir(), 'wisdom-kit-'))
      const extra: Record<string, unknown> = {}, notes: Record<string, string> = {}
      try {
        const plan = await previous('PLAN'), pr: any = plan?.result || {}
        const script: any = pr.scriptRef ? await blobs.getJson(pr.scriptRef) : null
        if (!script) throw new Error('script missing')
        const bible: any = pr.visualBibleRef ? await blobs.getJson(pr.visualBibleRef) : null
        // PLAN replaces job.planRef with the generated plan, so use the preserved original briefRef for publishing copy.
        // This keeps high-value named thinkers (e.g. 쇼펜하우어) available even when the generated on-video title is generic.
        const brief: any = pr.briefRef ? await blobs.getJson(String(pr.briefRef)) : null
        const topic = String(brief?.text || script.title || ''), narration = (script.beats || []).map((b: any) => b.narration).join(' ')
        const thinker = thinkerDisplayName(topic)
        const check = (k: any) => {
          const upload = uploadMetadataErrors(k.metadata || ({} as any), { narration, format: 'shorts' })
          if (thinker && !String(k?.metadata?.title || '').includes(thinker)) upload.push('title.missing_named_thinker')
          return { copy: thumbnail ? thumbnailCopyErrors(k.lines, script.title) : [], upload }
        }
        let made = await kit({ topic, title: script.title, hook: script.hook, narration }, apiKey), errs = check(made)
        if (errs.copy.length || errs.upload.length) {
          made = await kit({ topic, title: script.title, hook: script.hook, narration, repair: [...errs.copy.map((x) => 'thumbnail ' + x), ...errs.upload] }, apiKey); errs = check(made)
        }
        // a Short derived from a Wisdom Longform points to it naturally (its URL only once one exists; never a placeholder)
        const parent = brief?.derivedFrom
        if (parent?.parentLongformJobId) extra.derivedFrom = { parentLongformJobId: parent.parentLongformJobId, parentLongformTitle: parent.parentLongformTitle, parentLongformUrl: parent.parentLongformUrl ?? null }
        if (!errs.upload.length) {
          const m = parent?.parentLongformTitle ? derivedUploadText(made.metadata, parent) : made.metadata
          const t = uploadPackageText(m); extra.metadata = { title: t.title, description: t.descriptionWithHashtags, tags: t.tags, hashtags: t.hashtags, pinnedComment: t.pinnedComment }
        }
        else notes.uploadError = 'upload text: ' + errs.upload.join(',')
        if (thumbnail && !errs.copy.length) {
          try {
            // Golden Style (from job_create): the locked reference is the style, so no style words; otherwise as before
            const golden = creativeGolden(brief?.creative)
            const style = bible && !golden ? ` Style matching the video: ${bible.style}; palette ${bible.palette}; lighting ${bible.lighting}.` : ''
            // 9:16 portrait thumbnail (the Shorts video itself is not touched): portrait picture, person below the text band
            const prompt = figureBelowPrompt(thumbnailFigure(topic, made.figure)) + style
            const ik = sha256('wisdom-thumb-image-v2-portrait|' + prompt + (golden ? goldenCacheTag(golden) : ''))
            let im: any = null
            try { const m: any = await blobs.getJson(`generative-cache/image/${ik}.json`); const b = m?.ref ? await blobs.getBytes(m.ref) : null; if (b) im = { ...m, bytes: b } } catch {}
            if (!im) { im = golden ? await goldenImage(golden, prompt, '9:16', imageKey, deps.imageFetch ?? fetch) : await image(prompt, imageKey); const ref = `generative-assets/images/${sha256(im.bytes)}.jpg`; await blobs.putBytes(ref, im.bytes, im.contentType); await blobs.putJson(`generative-cache/image/${ik}.json`, { ref, sha256: sha256(im.bytes), contentType: im.contentType }) }
            const img = join(work, 'img.jpg'), assPath = join(work, 't.ass'), out = join(work, 'thumb.jpg')
            await writeFile(img, im.bytes)
            const t = thumbnailArgv({ image: img, lines: made.lines, assPath, fontsDir: FONTS_DIR, out, canvas: SHORTS_THUMB })
            await writeFile(assPath, t.ass, 'utf8'); await runOk(t.argv)
            const tb = await readFile(out), stored = await blobs.putBytes(`renders/${sha256(tb)}.jpg`, tb, 'image/jpeg')
            extra.thumbnailRef = stored.path; extra.thumbnailLines = made.lines
          } catch (e: any) { notes.thumbnailError = String(e?.message || e).slice(0, 300) }
        } else if (thumbnail) notes.thumbnailError = 'thumbnail copy: ' + errs.copy.join(',')
      } catch (e: any) { notes.kitError = String(e?.message || e).slice(0, 300) }
      finally { await rm(work, { recursive: true, force: true }) }
      if (!Object.keys(extra).length) return { ...res, result: { ...(res.result as any), ...notes } }
      const old: any = await blobs.getJson((res.result as any).packageRef)
      const next = await putAddressed(blobs, 'packages', { ...old, ...extra })
      return { ...res, outputRef: next.path, outputHash: sha256(next.path), result: { ...(res.result as any), packageRef: next.path, thumbnailRef: extra.thumbnailRef ?? null, uploadReady: !!extra.metadata, ...notes } }
    }
  }
}
