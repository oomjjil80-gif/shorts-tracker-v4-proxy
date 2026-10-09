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
import { imageStyleFeatures, styleApprovalRef, styleDistance, styleFeatureText, textureDistance, thumbnailCopyIssues, thumbnailImageIssues, STYLE_JUDGE_MIN, STYLE_MATCH, TEXTURE_MATCH, THUMBNAIL_BRIGHT_LINE, type StyleApprovalRecord, type StyleFeatures, type StyleJudge, type StyleJudgement } from '../../lib/generative/styleApproval.js'
import { composeThumbnailVersion, currentThumbnail, readThumbnailOverride, saveThumbnailVersion } from '../../lib/generative/thumbnailOverride.js'
import type { GeneratedBinary } from '../../lib/generative/providers.js'
import { GEMINI_IMAGE_MODEL } from '../../lib/generative/geminiImage.js'
import { StageError } from '../types.js'
import { composeTitleThumbnail, normTitle } from '../../lib/generative/titleThumbnail.js'

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
export async function styleGate(o: { jobId: string; blobs: JobBlobStore; script: any; profile: string; apiKey: string; imageKey: string; backgroundPrompt: string; draw: DrawFn; copyWriter?: CopyWriter; signal?: AbortSignal }): Promise<{ wait: true; record: StyleApprovalRecord } | { wait: false; record: StyleApprovalRecord; reference: StyleReference }> {
  const rec: StyleApprovalRecord = (await readStyleRecord(o.blobs, o.jobId)) ?? { schema: 'style-approval/1', status: 'pending', attempts: [] }
  if (rec.status === 'approved' && rec.approved) {
    const bytes = await o.blobs.getBytes(rec.approved.backgroundRef)
    if (!bytes) throw new StageError('STYLE_REFERENCE_MISSING', 'the approved thumbnail picture is missing', false)
    return { wait: false, record: rec, reference: { bytes, sha: sha256(bytes), features: rec.approved.features, text: styleFeatureText(rec.approved.features), thumbnailRef: rec.approved.thumbnailRef } }
  }
  if (rec.attempts.length && !rec.regenerate) return { wait: true, record: rec } // still waiting for the user
  if (!o.imageKey) throw new StageError('PROVIDER_DOWN', 'GEMINI_API_KEY is not configured (every picture is drawn by Gemini)', true)
  const work = await mkdtemp(join(tmpdir(), 'style-gate-'))
  try {
    // the words: the video's final title, exactly (never rewritten, shortened or summarised) — see titleThumbnail.ts
    const title = normTitle(o.script?.title)
    if (!title) throw new StageError('THUMB_TITLE_MISSING', 'the script has no title for the thumbnail', false)
    let lines: ThumbLine[] = [], copyIssues: string[] = []
    // the picture: one background, the copy composited as real text (1280x720); a blank / too dark picture is drawn once more
    let bg: GeneratedBinary | null = null, imageIssues: string[] = [], thumbBytes: Buffer | null = null
    for (let t = 0; t < 2; t++) {
      if (o.signal?.aborted) throw new Error('aborted')
      bg = await o.draw(o.backgroundPrompt, o.imageKey)
      const bgPath = join(work, `bg${t}.jpg`); await writeFile(bgPath, bg.bytes)
      // a muddy / too dark / blank background is drawn once more (measured on the picture itself, no AI)
      imageIssues = await thumbnailImageIssues(bgPath)
      let tt: Awaited<ReturnType<typeof composeTitleThumbnail>>
      try { tt = await composeTitleThumbnail({ background: bg.bytes, title }) } catch (e: any) { throw new StageError(e?.code || 'THUMB_TITLE_OVERFLOW', `${e?.code || 'THUMB_TITLE_OVERFLOW'}: ${String(e?.message || e)}`, false) }
      thumbBytes = tt.bytes; lines = tt.lines.map((text, i) => ({ text, color: i === tt.lines.length - 1 && tt.lines.length > 1 ? 'yellow' : 'white' }))
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
export async function representativeCheck(o: { jobId: string; blobs: JobBlobStore; record: StyleApprovalRecord; reference: StyleReference; prompt: string; sceneId: string | null; apiKey: string; imageKey: string; drawRef: DrawRefFn; judge?: StyleJudge; cached?: GeneratedBinary | null; tries?: number; freeChecks?: boolean }): Promise<GeneratedBinary | null> {
  // the representative already passed (a retry / restart): reuse it, no check and no call again
  if (o.cached && o.record.representative?.status === 'match') return o.cached
  // passed by the THUMBNAIL ONLY check (the kept picture itself, never drawn again)
  if (o.record.representative?.status === 'match') {
    const kept = await o.blobs.getBytes(o.record.representative.ref)
    if (kept) return { bytes: kept, contentType: 'image/jpeg', provider: 'gemini', model: GEMINI_IMAGE_MODEL, kept: true } as GeneratedBinary
  }
  if (o.record.representative?.status === 'mismatch' && !o.record.redrawRepresentative) return null // still waiting for the user
  const work = await mkdtemp(join(tmpdir(), 'style-rep-'))
  try {
    // 1) free: colour + texture (a clearly different picture stops here); 2) one vision judgement (the only way to PASS)
    const check = async (x: GeneratedBinary) => {
      const p = join(work, `r${sha256(x.bytes).slice(0, 8)}.jpg`); await writeFile(p, x.bytes)
      const f = await imageStyleFeatures(p), distance = styleDistance(o.reference.features, f), tex = textureDistance(o.reference.features.texture, f.texture)
      let judge: StyleJudgement | null = null
      // freeChecks false (Golden Style: the locked reference image fixes the drawing): colour / light / texture of a night
      // thumbnail say nothing about a daytime scene, so only the vision judgement decides
      const free = o.freeChecks === false || (distance <= STYLE_MATCH && tex <= TEXTURE_MATCH)
      if (free && o.judge) judge = await o.judge(o.reference.bytes, x.bytes, o.apiKey).catch(() => null)
      return { distance, tex, judge, ok: free && !!judge?.same && judge.score >= STYLE_JUDGE_MIN }
    }
    const tries = o.tries ?? 2
    let x: GeneratedBinary | null = null, r: Awaited<ReturnType<typeof check>> | null = null
    for (let t = 0; t < tries; t++) {
      x = t === 0 && o.cached ? o.cached : await o.drawRef(`${o.prompt}\n\n${o.reference.text}`, o.reference.bytes, o.imageKey)
      r = await check(x)
      if (r.ok) break
    }
    const ref = `style-approval/representative/${sha256(x!.bytes).slice(0, 64)}.jpg`
    await o.blobs.putBytes(ref, x!.bytes, 'image/jpeg')
    o.record.representative = { sceneId: o.sceneId, ref, distance: r!.distance, textureDistance: r!.tex, judge: r!.judge, status: r!.ok ? 'match' : 'mismatch', tries: (o.record.representative?.tries ?? 0) + tries }
    delete o.record.redrawRepresentative
    await save(o.blobs, o.jobId, o.record)
    return r!.ok ? x! : null // mismatch: no other picture is drawn
  } finally { await rm(work, { recursive: true, force: true }) }
}

// 썸네일만 다시 생성 (after approval, the job waiting): ONE new thumbnail picture drawn with the character lock, the user's
// words composited on it, then ONE check against the KEPT representative scene (the same art style AND the same people).
// Pass -> the representative counts as matched and the job goes on from where it stopped. Fail -> it waits again (the
// new picture is kept and shown; nothing is drawn automatically). The approved picture, the lock, the representative and
// every scene are never touched or deleted. Returns true = go on.
export async function thumbnailRework(o: { jobId: string; blobs: JobBlobStore; record: StyleApprovalRecord; prompt: string; draw: (prompt: string) => Promise<GeneratedBinary>; judge?: StyleJudge; apiKey: string; signal?: AbortSignal }): Promise<boolean> {
  if (!o.record.thumbnailRequest) return true
  if (o.signal?.aborted) throw new Error('aborted')
  const rep = o.record.representative, repBytes = rep?.ref ? await o.blobs.getBytes(rep.ref) : null
  const cur = await currentThumbnail(o.blobs, o.jobId, o.record)
  if (!cur) throw new StageError('STYLE_REFERENCE_MISSING', 'no approved thumbnail to replace', false)
  const bg = await o.draw(`${o.prompt}\n\n${THUMBNAIL_BRIGHT_LINE}`)
  const work = await mkdtemp(join(tmpdir(), 'thumb-rework-'))
  try {
    const p = join(work, 'bg.jpg'); await writeFile(p, bg.bytes)
    const imageIssues = await thumbnailImageIssues(p)
    // no representative yet: nothing to compare with (the representative check after it compares with the lock as before)
    const judge = repBytes && o.judge ? await o.judge(bg.bytes, repBytes, o.apiKey, { people: true }).catch(() => null) : null
    const ok = !repBytes || (!!judge?.same && judge.score >= STYLE_JUDGE_MIN)
    const prev = await readThumbnailOverride(o.blobs, o.jobId)
    let v
    try { v = await composeThumbnailVersion(o.blobs, { background: bg.bytes, text: cur.text, n: (prev?.current.n ?? 0) + 1, source: 'redraw', imageIssues, check: { ok, judge, at: new Date().toISOString() } }) }
    catch (e: any) { throw new StageError(e?.code || 'THUMB_TITLE_OVERFLOW', `${e?.code || 'THUMB_TITLE_OVERFLOW'}: ${String(e?.message || e)}`, false) }
    await saveThumbnailVersion(o.blobs, o.jobId, o.record, v)
    delete o.record.thumbnailRequest
    if (ok && rep) { rep.status = 'match'; rep.judge = judge; delete o.record.redrawRepresentative }
    await save(o.blobs, o.jobId, o.record)
    return ok
  } finally { await rm(work, { recursive: true, force: true }) }
}
