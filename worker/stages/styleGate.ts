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
import { imageStyleFeatures, styleApprovalRef, styleDistance, styleFeatureText, textureDistance, thumbnailCopyIssues, thumbnailImageIssues, STYLE_JUDGE_MIN, STYLE_MATCH, TEXTURE_MATCH, type StyleApprovalRecord, type StyleFeatures, type StyleJudge, type StyleJudgement } from '../../lib/generative/styleApproval.js'
import type { GeneratedBinary } from '../../lib/generative/providers.js'
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
    // the words: the video's final title, exactly (never rewritten, shortened or summarised) — see titleThumbnail.ts
    const title = normTitle(o.script?.title)
    if (!title) throw new StageError('THUMB_TITLE_MISSING', 'the script has no title for the thumbnail', false)
    let lines: ThumbLine[] = [], copyIssues: string[] = []
    // the picture: one background, the copy composited as real text (1280x720); a blank / too dark picture is drawn once more
    let bg: GeneratedBinary | null = null, imageIssues: string[] = [], thumbBytes: Buffer | null = null
    for (let t = 0; t < 2; t++) {
      if (o.signal?.aborted) throw new Error('aborted')
      bg = await o.draw(o.backgroundPrompt, o.apiKey)
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
export async function representativeCheck(o: { jobId: string; blobs: JobBlobStore; record: StyleApprovalRecord; reference: StyleReference; prompt: string; sceneId: string | null; apiKey: string; drawRef: DrawRefFn; judge?: StyleJudge; cached?: GeneratedBinary | null; tries?: number }): Promise<GeneratedBinary | null> {
  // the representative already passed (a retry / restart): reuse it, no check and no call again
  if (o.cached && o.record.representative?.status === 'match') return o.cached
  if (o.record.representative?.status === 'mismatch' && !o.record.redrawRepresentative) return null // still waiting for the user
  const work = await mkdtemp(join(tmpdir(), 'style-rep-'))
  try {
    // 1) free: colour + texture (a clearly different picture stops here); 2) one vision judgement (the only way to PASS)
    const check = async (x: GeneratedBinary) => {
      const p = join(work, `r${sha256(x.bytes).slice(0, 8)}.jpg`); await writeFile(p, x.bytes)
      const f = await imageStyleFeatures(p), distance = styleDistance(o.reference.features, f), tex = textureDistance(o.reference.features.texture, f.texture)
      let judge: StyleJudgement | null = null
      if (distance <= STYLE_MATCH && tex <= TEXTURE_MATCH && o.judge) judge = await o.judge(o.reference.bytes, x.bytes, o.apiKey).catch(() => null)
      return { distance, tex, judge, ok: distance <= STYLE_MATCH && tex <= TEXTURE_MATCH && !!judge?.same && judge.score >= STYLE_JUDGE_MIN }
    }
    const tries = o.tries ?? 2
    let x: GeneratedBinary | null = null, r: Awaited<ReturnType<typeof check>> | null = null
    for (let t = 0; t < tries; t++) {
      x = t === 0 && o.cached ? o.cached : await o.drawRef(`${o.prompt}\n\n${o.reference.text}`, o.reference.bytes, o.apiKey)
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
