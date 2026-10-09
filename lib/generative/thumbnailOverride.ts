// THUMBNAIL ONLY: replace the delivered thumbnail of a Longform after its style approval, never touching the approved
// picture (the style reference + first-image character lock), the representative scene or any drawn scene.
//   text only : the current thumbnail picture + the user's words, composited again (no AI call at all)
//   redraw    : the worker draws ONE new picture (the lock as the character reference), checks it against the kept
//               representative scene (art style + the same people) and continues the job only when it passes
// Every version is stored under a new address and listed in the history; no picture is ever deleted.
import { sha256, type JobBlobStore } from '../jobs/blobs.js'
import { composeTitleThumbnail, normTitle } from './titleThumbnail.js'
import { thumbnailOverrideRef, type StyleApprovalRecord, type ThumbnailOverride, type ThumbnailVersion } from './styleApproval.js'

export async function readThumbnailOverride(blobs: JobBlobStore, jobId: string): Promise<ThumbnailOverride | null> {
  const o: any = await blobs.getJson(thumbnailOverrideRef(jobId)).catch(() => null)
  return o?.schema === 'thumbnail-override/1' && o.current?.thumbnailRef ? (o as ThumbnailOverride) : null
}
// the version the user approved (before any replacement): its picture and the words that were on it
export function approvedThumbnailVersion(rec: StyleApprovalRecord): ThumbnailVersion | null {
  const a = rec.approved
  if (!a) return null
  const attempt = rec.attempts.find((x) => x.n === a.n)
  const lines = (attempt?.lines ?? []).map((l) => String(l?.text || ''))
  return { n: 0, backgroundRef: a.backgroundRef, thumbnailRef: a.thumbnailRef, text: normTitle(lines.join(' ')), lines, imageIssues: attempt?.imageIssues ?? [], source: 'approved', check: null, at: a.at }
}
export const currentThumbnail = async (blobs: JobBlobStore, jobId: string, rec: StyleApprovalRecord) => (await readThumbnailOverride(blobs, jobId))?.current ?? approvedThumbnailVersion(rec)

// composite the words on a picture (exact text, wrapped, inside the safe area) and store both under new addresses
export async function composeThumbnailVersion(blobs: JobBlobStore, o: { background: Buffer; text: string; n: number; source: ThumbnailVersion['source']; imageIssues: string[]; check: ThumbnailVersion['check'] }): Promise<ThumbnailVersion> {
  const t = await composeTitleThumbnail({ background: o.background, title: o.text })
  const backgroundRef = `style-approval/images/${sha256(o.background)}.jpg`, thumbnailRef = `style-approval/thumbnails/${sha256(t.bytes)}.jpg`
  await blobs.putBytes(backgroundRef, o.background, 'image/jpeg') // create-once: the approved picture is never rewritten
  await blobs.putBytes(thumbnailRef, t.bytes, 'image/jpeg')
  return { n: o.n, backgroundRef, thumbnailRef, text: t.title, lines: t.lines, imageIssues: o.imageIssues, source: o.source, check: o.check, at: new Date().toISOString() }
}
// the new current version; the approved one opens the history, so the list always shows where it started
export async function saveThumbnailVersion(blobs: JobBlobStore, jobId: string, rec: StyleApprovalRecord, v: ThumbnailVersion): Promise<ThumbnailOverride> {
  const prev = await readThumbnailOverride(blobs, jobId)
  const first = approvedThumbnailVersion(rec)
  const history = prev ? [...prev.history, v] : [...(first ? [first] : []), v]
  const out: ThumbnailOverride = { schema: 'thumbnail-override/1', current: v, history }
  await blobs.putJson(thumbnailOverrideRef(jobId), out, { overwrite: true })
  return out
}
