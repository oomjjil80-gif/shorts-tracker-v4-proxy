// ONE-OFF (operator): draw the 5 candidate 숨은야담 그림체 example pictures with the worker's own OPENAI_API_KEY (the key
// never leaves the worker and is never logged). Runs only when STYLE_EXAMPLES_RUN=<run id> is set, in the background,
// without touching jobs. Exactly one paid call per style (gpt-image-1, high, 1536x1024), never retried. The run record
// (style-examples/candidates/<run id>/run.json) is written BEFORE the first call, so a restart, a second worker or the
// variable left in place never draws again: after it ran, the feature is inert. Results: the 5 pictures, a new-vs-old
// comparison sheet and advisory numbers, as presigned links in the worker log (and in run.json).
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JobBlobStore } from '../lib/jobs/blobs.js'
import { runOk } from '../lib/media/ffmpeg.js'
import { yasaScenePrompt } from '../lib/generative/yasaLongform.js'
import { imageStyleFeatures } from '../lib/generative/styleApproval.js'
import { EXAMPLE_SCENE, EXAMPLE_SCRIPT, YADAM_STYLE_CANDIDATES } from '../lib/generative/yadamStyleCandidates.js'
import { V4_CROP, V4_PROMPT, V4_REFERENCES, V4_REFERENCE_DIR, buildV4Request, toSixteenNine } from '../lib/generative/yadamReferenceStyle.js'

const LEGACY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'style-examples', 'yadam')
const LINK_MS = 7 * 24 * 3600_000
export async function runStyleExamplesOnce(o: { env: Record<string, string | undefined>; blobs: JobBlobStore; log: (line: string) => void; fetchImpl?: typeof fetch; workerId?: string }): Promise<'off' | 'already' | 'done' | 'invalid'> {
  const runId = String(o.env.STYLE_EXAMPLES_RUN || '').trim()
  if (!runId) return 'off'
  if (!/^[a-z0-9-]{1,32}$/.test(runId)) { o.log(`[style-examples] STYLE_EXAMPLES_RUN must be a short id like v2-1; nothing done`); return 'invalid' }
  const base = `style-examples/candidates/${runId}`, recRef = `${base}/run.json`
  const prior: any = await o.blobs.getJson(recRef).catch(() => null)
  if (prior) {
    o.log(`[style-examples] run ${runId} already ${prior.status} (no new call). Remove STYLE_EXAMPLES_RUN from the worker variables.`)
    if (prior.status === 'done') for (const [k, ref] of Object.entries<string>(prior.files ?? {})) { const s = await o.blobs.presign?.(ref, LINK_MS).catch(() => null); if (s) o.log(`[style-examples] ${k}: ${s.url}`) }
    return 'already'
  }
  const apiKey = String(o.env.OPENAI_API_KEY || '')
  if (!apiKey) { o.log('[style-examples] OPENAI_API_KEY is not set on the worker; nothing done'); return 'invalid' }
  const f = o.fetchImpl ?? fetch
  if (runId.startsWith('v3')) { o.log(`[style-examples] v3 runs are retired (its prompt treated the reference as quality-only); nothing done`); return 'invalid' }
  if (runId.startsWith('v4')) return runV4(o, runId, base, recRef, apiKey, f)
  // claim the run BEFORE any paid call: whatever happens next, this run id never draws again
  await o.blobs.putJson(recRef, { schema: 'style-examples-run/1', status: 'running', startedAt: new Date().toISOString(), worker: o.workerId ?? null }, { overwrite: false })
  const claimed: any = await o.blobs.getJson(recRef).catch(() => null)
  if (claimed?.worker !== (o.workerId ?? null) || claimed?.status !== 'running') { o.log(`[style-examples] run ${runId} was claimed by another worker; nothing done`); return 'already' }
  const work = await mkdtemp(join(tmpdir(), 'style-examples-'))
  const files: Record<string, string> = {}, report: Record<string, unknown> = {}, errors: Record<string, string> = {}
  try {
    for (const c of YADAM_STYLE_CANDIDATES) {
      try { // one call, no retry
        const r = await f('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1', prompt: yasaScenePrompt(EXAMPLE_SCRIPT, EXAMPLE_SCENE, c.profile), size: '1536x1024', quality: 'high', output_format: 'jpeg', n: 1 }) })
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
        const b64 = ((await r.json()) as any)?.data?.[0]?.b64_json
        if (!b64) throw new Error('no image returned')
        const bytes = Buffer.from(b64, 'base64'), p = join(work, `${c.key}.jpg`)
        await writeFile(p, bytes); files[c.key] = `${base}/${c.key}.jpg`; await o.blobs.putBytes(files[c.key], bytes, 'image/jpeg')
        const ft = await imageStyleFeatures(p)
        report[c.key] = { label: c.profile.label, brightness: ft.brightness, saturation: ft.saturation, contrast: ft.contrast, palette: ft.palette } // advisory only
        o.log(`[style-examples] made ${c.key}`)
      } catch (e: any) { errors[c.key] = String(e?.message || e).replace(/sk-[A-Za-z0-9_-]+/g, '[key]'); o.log(`[style-examples] ${c.key} failed (not retried): ${errors[c.key]}`) }
    }
    // comparison sheet: new (top) vs the current example (bottom) per style
    const made = YADAM_STYLE_CANDIDATES.filter((c) => files[c.key])
    if (made.length) {
      const inputs: string[] = [], chains: string[] = []
      for (const [i, c] of made.entries()) { inputs.push('-i', join(work, `${c.key}.jpg`)); chains.push(`[${i}:v]scale=768:512[n${i}]`) }
      for (const [i, c] of made.entries()) {
        const old = join(LEGACY_DIR, `${c.compareWith}.jpg`), has = await stat(old).then(() => true, () => false)
        inputs.push(...(has ? ['-i', old] : ['-f', 'lavfi', '-i', 'color=c=0xdddddd:s=768x512']))
        chains.push(`[${made.length + i}:v]scale=768:512:force_original_aspect_ratio=decrease,pad=768:512:(ow-iw)/2:(oh-ih)/2:color=0xdddddd[o${i}]`)
      }
      const row = (p: string) => made.map((_, i) => `[${p}${i}]`).join('') + (made.length > 1 ? `hstack=inputs=${made.length}` : 'null')
      const sheet = join(work, 'compare.jpg')
      await runOk(['-y', ...inputs, '-filter_complex', `${chains.join(';')};${row('n')}[top];${row('o')}[bottom];[top][bottom]vstack[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '3', sheet])
      files['compare-new-top-current-bottom'] = `${base}/compare.jpg`; await o.blobs.putBytes(files['compare-new-top-current-bottom'], await readFile(sheet), 'image/jpeg')
    }
    await o.blobs.putJson(recRef, { schema: 'style-examples-run/1', status: 'done', finishedAt: new Date().toISOString(), order: made.map((c) => c.key), files, report, errors }, { overwrite: true })
    for (const [k, ref] of Object.entries(files)) { const s = await o.blobs.presign?.(ref, LINK_MS).catch(() => null); o.log(`[style-examples] ${k}: ${s?.url ?? ref}`) }
    o.log(`[style-examples] run ${runId} done (${made.length}/5 pictures). Remove STYLE_EXAMPLES_RUN from the worker variables; this run id never draws again.`)
    return 'done'
  } finally { await rm(work, { recursive: true, force: true }) }
}

// V4 (one picture): the user's 3 reference captures as the PRIMARY style reference (real images, image edit), the
// contract in yadamReferenceStyle.ts. ONE paid call, never retried. V3's "quality reference only, do not copy" prompt
// is gone. The request's exact inputs (sizes, hashes, order) are written to the run record.
async function runV4(o: { blobs: JobBlobStore; log: (line: string) => void; workerId?: string }, runId: string, base: string, recRef: string, apiKey: string, f: typeof fetch): Promise<'done' | 'already'> {
  await o.blobs.putJson(recRef, { schema: 'style-examples-run/1', status: 'running', startedAt: new Date().toISOString(), worker: o.workerId ?? null }, { overwrite: false })
  const claimed: any = await o.blobs.getJson(recRef).catch(() => null)
  if (claimed?.worker !== (o.workerId ?? null) || claimed?.status !== 'running') { o.log(`[style-examples] run ${runId} was claimed by another worker; nothing done`); return 'already' }
  const work = await mkdtemp(join(tmpdir(), 'style-v4-run-'))
  const files: Record<string, string> = {}, errors: Record<string, string> = {}
  try {
    const req = await buildV4Request()
    let made: Buffer | null = null, wide: Awaited<ReturnType<typeof toSixteenNine>> | null = null
    try { // one call, no retry
      const r = await f(req.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: req.form })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const b64 = ((await r.json()) as any)?.data?.[0]?.b64_json
      if (!b64) throw new Error('no image returned')
      made = Buffer.from(b64, 'base64')
    } catch (e: any) { errors.v4 = String(e?.message || e).replace(/sk-[A-Za-z0-9_-]+/g, '[key]'); o.log(`[style-examples] v4 failed (not retried): ${errors.v4}`) }
    if (made) {
      // the model's 3:2 picture is kept; the representative is its exact central 16:9 band
      files['v4-raw-3x2'] = `${base}/v4-raw-3x2.jpg`; await o.blobs.putBytes(files['v4-raw-3x2'], made, 'image/jpeg')
      wide = await toSixteenNine(made)
      const p = join(work, 'v4.jpg'); await writeFile(p, wide.bytes)
      files['v4-representative'] = `${base}/v4-representative.jpg`; await o.blobs.putBytes(files['v4-representative'], wide.bytes, 'image/jpeg')
      // comparison: V4 (top, large) above the 3 reference frames as they were sent
      const refs = V4_REFERENCES.map((r) => join(V4_REFERENCE_DIR, r.file)), sheet = join(work, 'compare.jpg')
      await runOk(['-y', '-i', p, ...refs.flatMap((x) => ['-i', x]), '-filter_complex',
        `[0:v]scale=1920:1080[a];${refs.map((_, i) => `[${i + 1}:v]${V4_CROP},scale=640:-2,pad=640:268:0:(oh-ih)/2[r${i}]`).join(';')};[r0][r1][r2]hstack=3[b];[a][b]vstack[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '3', sheet])
      files['compare-v4-top-references-below'] = `${base}/compare.jpg`; await o.blobs.putBytes(files['compare-v4-top-references-below'], await readFile(sheet), 'image/jpeg')
    }
    await o.blobs.putJson(recRef, { schema: 'style-examples-run/1', status: 'done', finishedAt: new Date().toISOString(), order: made ? ['v4-representative'] : [], files, errors, report: { model: req.model, size: req.size, final: wide ? { width: wide.width, height: wide.height, cutTop: wide.cutTop, cutBottom: wide.cutBottom } : null, quality: req.quality, endpoint: req.endpoint, inputs: req.inputs, prompt: V4_PROMPT } }, { overwrite: true })
    for (const [k, ref] of Object.entries(files)) { const s = await o.blobs.presign?.(ref, LINK_MS).catch(() => null); o.log(`[style-examples] ${k}: ${s?.url ?? ref}`) }
    o.log(`[style-examples] run ${runId} done (${made ? 1 : 0}/1 picture). Remove STYLE_EXAMPLES_RUN from the worker variables; this run id never draws again.`)
    return 'done'
  } finally { await rm(work, { recursive: true, force: true }) }
}
