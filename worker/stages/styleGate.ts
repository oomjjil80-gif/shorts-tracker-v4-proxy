// THUMBNAIL FIRST + STYLE LOCK inside the ASSET stage (generic: any profile switched on in STYLE_APPROVAL).
//   before approval : one thumbnail (copy checked / rewritten once, one background picture, exact text composited)
//                     -> the job waits (WAITING_USER/DECISION at ASSET). Nothing else is drawn.
//   "다시 생성"      : one new thumbnail attempt (same job), waits again.
//   after approval  : the approved background is the style reference for every picture (image + measured features);
//                     ONE representative picture is drawn and compared first; a mismatch redraws only that picture and,
//                     if it still does not match, stops the stage (retry redraws only the representative again).
// Everything is stored (style-approval/<job>.json + the pictures), so a retry or a restart never pays twice.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, type JobBlobStore } from '../../lib/jobs/blobs.js'
import { runOk } from '../../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../../lib/media/ass.js'
import { thumbnailArgv, LONGFORM_THUMB, type ThumbLine } from '../../lib/generative/wisdomThumbnail.js'
import { imageStyleFeatures, styleApprovalRef, styleDistance, styleFeatureText, thumbnailCopyIssues, thumbnailImageIssues, STYLE_MATCH, type StyleApprovalRecord, type StyleFeatures } from '../../lib/generative/styleApproval.js'
import type { GeneratedBinary } from '../../lib/generative/providers.js'
import { StageError } from '../types.js'

export type DrawFn = (prompt: string, apiKey: string) => Promise<GeneratedBinary>
export type DrawRefFn = (prompt: string, reference: Buffer, apiKey: string) => Promise<GeneratedBinary>
export type CopyWriter = (script: any, issues: string[], apiKey: string) => Promise<ThumbLine[]>
export type StyleReference = { bytes: Buffer; sha: string; features: StyleFeatures; text: string; thumbnailRef: string }

async function fontsEnv(work: string) {
  const conf = join(work, 'fonts.conf')
  await writeFile(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${FONTS_DIR}</dir><cachedir>${work}/font-cache</cachedir></fontconfig>`, 'utf8')
  return { FONTCONFIG_FILE: conf, FONTCONFIG_PATH: work }
}
export async function readStyleRecord(blobs: JobBlobStore, jobId: string): Promise<StyleApprovalRecord | null> {
  return ((await blobs.getJson(styleApprovalRef(jobId)).catch(() => null)) as StyleApprovalRecord | null) ?? null
}
const save = (blobs: JobBlobStore, jobId: string, rec: StyleApprovalRecord) => blobs.putJson(styleApprovalRef(jobId), rec, { overwrite: true })

// Before approval: make (or keep) the thumbnail attempt and say "wait". After approval: the style reference.
export async function styleGate(o: { jobId: string; blobs: JobBlobStore; script: any; profile: string; apiKey: string; backgroundPrompt: string; draw: DrawFn; copyWriter?: CopyWriter; signal?: AbortSignal }): Promise<{ wait: true; record: StyleApprovalRecord } | { wait: false; record: StyleApprovalRecord; reference: StyleReference }> {
  const rec: StyleApprovalRecord = (await readStyleRecord(o.blobs, o.jobId)) ?? { schema: 'style-approval/1', status: 'pending', attempts: [] }
  if (rec.status === 'approved' && rec.approved) {
    const bytes = await o.blobs.getBytes(rec.approved.backgroundRef)
    if (!bytes) throw new StageError('STYLE_REFERENCE_MISSING', 'the approved thumbnail picture is missing', false)
    return { wait: false, record: rec, reference: { bytes, sha: sha256(bytes), features: rec.approved.features, text: styleFeatureText(rec.approved.features), thumbnailRef: rec.approved.thumbnailRef } }
  }
  if (rec.attempts.length && !rec.regenerate) return { wait: true, record: rec } // still waiting for the user
  if (!o.apiKey) throw new StageError('PROVIDER_DOWN', 'OPENAI_API_KEY is not configured', true)
  const work = await mkdtemp(join(tmpdir(), 'style-gate-'))
  try {
    // the copy: checked; rewritten ONCE when it fails (the story's own click line, never the answer)
    let lines: ThumbLine[] = o.script?.thumbnail?.lines ?? [], copyIssues = thumbnailCopyIssues(o.script, o.profile)
    if (copyIssues.length && o.copyWriter) {
      const again = await o.copyWriter(o.script, copyIssues, o.apiKey).catch(() => null)
      if (Array.isArray(again)) { const left = thumbnailCopyIssues({ ...o.script, thumbnail: { lines: again } }, o.profile); if (left.length < copyIssues.length) { lines = again; copyIssues = left } }
    }
    // the picture: one background, the copy composited as real text (1280x720); a blank / too dark picture is drawn once more
    const env = await fontsEnv(work)
    let bg: GeneratedBinary | null = null, imageIssues: string[] = [], thumbBytes: Buffer | null = null
    for (let t = 0; t < 2; t++) {
      if (o.signal?.aborted) throw new Error('aborted')
      bg = await o.draw(o.backgroundPrompt, o.apiKey)
      const bgPath = join(work, `bg${t}.jpg`), thumb = join(work, `thumb${t}.jpg`), ass = join(work, `thumb${t}.ass`)
      await writeFile(bgPath, bg.bytes)
      const a = thumbnailArgv({ image: bgPath, lines, assPath: ass, fontsDir: FONTS_DIR, out: thumb, canvas: LONGFORM_THUMB })
      await writeFile(ass, a.ass, 'utf8'); await runOk(a.argv, { env })
      thumbBytes = await readFile(thumb); imageIssues = await thumbnailImageIssues(thumb)
      if (!imageIssues.length) break
    }
    const bgRef = `style-approval/images/${sha256(bg!.bytes)}.jpg`, thRef = `style-approval/thumbnails/${sha256(thumbBytes!)}.jpg`
    await o.blobs.putBytes(bgRef, bg!.bytes, 'image/jpeg'); await o.blobs.putBytes(thRef, thumbBytes!, 'image/jpeg')
    rec.attempts.push({ n: rec.attempts.length + 1, backgroundRef: bgRef, thumbnailRef: thRef, lines, copyIssues, imageIssues, at: new Date().toISOString() })
    rec.status = 'pending'; delete rec.regenerate
    await save(o.blobs, o.jobId, rec)
    return { wait: true, record: rec }
  } finally { await rm(work, { recursive: true, force: true }) }
}

// After approval: the ONE representative picture, drawn from the reference and compared with it before anything else.
// A mismatch never fails the job (no paid automatic retries): the job waits for the user, who redraws only the representative
// (or a new thumbnail). Returns null = wait.
export async function representativeCheck(o: { jobId: string; blobs: JobBlobStore; record: StyleApprovalRecord; reference: StyleReference; prompt: string; sceneId: string | null; apiKey: string; drawRef: DrawRefFn; cached?: GeneratedBinary | null; tries?: number }): Promise<GeneratedBinary | null> {
  if (o.record.representative?.status === 'mismatch' && !o.record.redrawRepresentative) return null // still waiting for the user
  const work = await mkdtemp(join(tmpdir(), 'style-rep-'))
  try {
    const measure = async (x: GeneratedBinary) => { const p = join(work, `r${sha256(x.bytes).slice(0, 8)}.jpg`); await writeFile(p, x.bytes); return styleDistance(o.reference.features, await imageStyleFeatures(p)) }
    if (o.cached) { const d = await measure(o.cached); if (d <= STYLE_MATCH) return o.cached }
    let best = Infinity, x: GeneratedBinary | null = null
    const tries = o.tries ?? 2
    for (let t = 0; t < tries; t++) {
      x = await o.drawRef(`${o.prompt}\n\n${o.reference.text}`, o.reference.bytes, o.apiKey)
      best = await measure(x)
      if (best <= STYLE_MATCH) break
    }
    const ok = best <= STYLE_MATCH, ref = `style-approval/representative/${sha256(x!.bytes)}.jpg`
    await o.blobs.putBytes(ref, x!.bytes, 'image/jpeg')
    o.record.representative = { sceneId: o.sceneId, ref, distance: Number(best.toFixed(3)), status: ok ? 'match' : 'mismatch', tries: (o.record.representative?.tries ?? 0) + tries }
    delete o.record.redrawRepresentative
    await save(o.blobs, o.jobId, o.record)
    return ok ? x! : null // mismatch: no other picture is drawn
  } finally { await rm(work, { recursive: true, force: true }) }
}
