// ONE-OFF (operator): the representative 야담 picture of the ONE style contract (yadamStyle.ts), for the user's approval
// before the contract is used in production. Runs only when STYLE_EXAMPLES_RUN=yadam-<id> is set, in the background,
// without touching jobs, with the worker's own GEMINI_API_KEY (never logged). Exactly one paid Gemini call, never retried; the
// run record (style-examples/candidates/<run id>/run.json) is written BEFORE the call, so a restart, a second worker or
// the variable left in place never draws again. Every older id (v2-*, v3-*, v4-*, v5-*: the retired style experiments)
// does nothing. Results: the 16:9 picture and a comparison with the 3 reference frames, as
// presigned links in the worker log (and in run.json); job_style_examples + the publish workflow put them on GitHub.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobBlobStore } from '../lib/jobs/blobs.js'
import { probe, runOk } from '../lib/media/ffmpeg.js'
import { YADAM_IMAGE_ASPECT, YADAM_IMAGE_MODEL, YADAM_REFERENCE_CROP, YADAM_REFERENCE_DIR, YADAM_REFERENCES, YADAM_STYLE_VERSION, geminiYadamImage, yadamImagePrompt, yadamReferences, type YadamDraw } from '../lib/generative/yadamStyle.js'

const LINK_MS = 7 * 24 * 3600_000
// the approval scene (unchanged since V3): two Joseon women passing a bundle, medium shot, both faces readable
export const REPRESENTATIVE_SCENE = 'Joseon hanok courtyard (tiled roofs). A beautiful young woman (about 20, chignon with wooden binyeo, pale blue-grey jeogori, deep indigo chima) and a dignified older woman (about 60, silver-streaked chignon, dark plum jeogori, charcoal chima) pass a small bojagi bundle between their hands. Slightly low camera, medium shot, both faces large and clearly lit: the young woman moved, eyes wet; the older woman resolute. Joseon clothing and buildings only.'
export async function runStyleExamplesOnce(o: { env: Record<string, string | undefined>; blobs: JobBlobStore; log: (line: string) => void; draw?: YadamDraw; workerId?: string }): Promise<'off' | 'already' | 'done' | 'invalid' | 'retired'> {
  const runId = String(o.env.STYLE_EXAMPLES_RUN || '').trim()
  if (!runId) return 'off'
  if (!/^yadam-[a-z0-9-]{1,24}$/.test(runId)) { o.log(`[style-examples] ${/^v\d/.test(runId) ? `run ${runId} belongs to a retired style experiment` : 'STYLE_EXAMPLES_RUN must look like yadam-1'}; nothing done. Remove STYLE_EXAMPLES_RUN from the worker variables.`); return /^v\d/.test(runId) ? 'retired' : 'invalid' }
  const base = `style-examples/candidates/${runId}`, recRef = `${base}/run.json`
  const prior: any = await o.blobs.getJson(recRef).catch(() => null)
  if (prior) { o.log(`[style-examples] run ${runId} already ${prior.status} (no new call). Remove STYLE_EXAMPLES_RUN from the worker variables.`); return 'already' }
  const apiKey = String(o.env.GEMINI_API_KEY || '')
  if (!apiKey) { o.log('[style-examples] GEMINI_API_KEY is not set on the worker; nothing done'); return 'invalid' }
  // claim the run BEFORE the paid call: whatever happens next, this run id never draws again
  await o.blobs.putJson(recRef, { schema: 'style-examples-run/1', status: 'running', startedAt: new Date().toISOString(), worker: o.workerId ?? null }, { overwrite: false })
  const claimed: any = await o.blobs.getJson(recRef).catch(() => null)
  if (claimed?.worker !== (o.workerId ?? null) || claimed?.status !== 'running') { o.log(`[style-examples] run ${runId} was claimed by another worker; nothing done`); return 'already' }
  const work = await mkdtemp(join(tmpdir(), 'yadam-rep-'))
  const files: Record<string, string> = {}, errors: Record<string, string> = {}
  try {
    const refs = await yadamReferences(), scene = REPRESENTATIVE_SCENE
    let wide: { width: number; height: number } | null = null
    try { // one call, no retry; Gemini draws 16:9 itself (no crop)
      const made = await (o.draw ?? geminiYadamImage())(scene, apiKey)
      const p = join(work, 'rep.img'), sheet = join(work, 'compare.jpg'); await writeFile(p, made.bytes)
      const i = await probe(p); wide = { width: Number(i.width), height: Number(i.height) }
      files.representative = `${base}/representative.jpg`; await o.blobs.putBytes(files.representative, made.bytes, made.contentType)
      // comparison: the picture (top) above the 3 reference frames as they were sent
      const srcs = YADAM_REFERENCES.map((r) => join(YADAM_REFERENCE_DIR, r.file))
      await runOk(['-y', '-i', p, ...srcs.flatMap((x) => ['-i', x]), '-filter_complex',
        `[0:v]scale=1920:1080[a];${srcs.map((_, i) => `[${i + 1}:v]${YADAM_REFERENCE_CROP},scale=640:-2,pad=640:268:0:(oh-ih)/2[r${i}]`).join(';')};[r0][r1][r2]hstack=3[b];[a][b]vstack[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '3', sheet])
      files['compare-top-references-below'] = `${base}/compare.jpg`; await o.blobs.putBytes(files['compare-top-references-below'], await readFile(sheet), 'image/jpeg')
    } catch (e: any) { errors.yadam = String(e?.message || e).replace(/sk-[A-Za-z0-9_-]+/g, '[key]'); o.log(`[style-examples] failed (not retried): ${errors.yadam}`) }
    await o.blobs.putJson(recRef, { schema: 'style-examples-run/1', status: 'done', finishedAt: new Date().toISOString(), order: files.representative ? ['representative'] : [], files, errors,
      report: { style: YADAM_STYLE_VERSION, model: YADAM_IMAGE_MODEL, aspectRatio: YADAM_IMAGE_ASPECT, final: wide, references: refs.map((r) => ({ file: r.file, sent: `${r.width}x${r.height}`, sha256: r.sha256 })), prompt: yadamImagePrompt(scene) } }, { overwrite: true })
    for (const [k, ref] of Object.entries(files)) { const s = await o.blobs.presign?.(ref, LINK_MS).catch(() => null); o.log(`[style-examples] ${k}: ${s?.url ?? ref}`) }
    o.log(`[style-examples] run ${runId} done (${files.representative ? 1 : 0}/1 picture). Remove STYLE_EXAMPLES_RUN from the worker variables; this run id never draws again.`)
    return 'done'
  } finally { await rm(work, { recursive: true, force: true }) }
}
