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
  if (runId.startsWith('v3')) return runV3(o, runId, base, recRef, apiKey, f)
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

// V3 (one picture): premium Korean romance-webtoon key-visual quality in the Joseon era. ONE paid call, never retried:
// gpt-image-1 image edit, high, 1536x1024, with two benchmark pictures as QUALITY references (face / eye / skin / hair /
// light craft only; their amber cast and their people are not copied). The v2-1 results are never used as references.
export const V3_PROMPT = [
  'Premium Korean romance-webtoon / anime key-visual illustration — the highest-quality polished digital painting — set in the Joseon dynasty of Korea.',
  'SCENE (medium shot, both faces and their emotions clearly visible, wide 16:9): in the sunlit courtyard of a tiled-roof hanok (wooden maru veranda, paper-screen doors, a blossoming plum tree, a few onggi crocks softly out of focus), a beautiful young Joseon woman (about 20; delicate oval face, large luminous dark eyes with fine lashes, soft natural blush, glossy black hair in a neat low chignon with a jade binyeo; pale pink silk jeogori with a deep crimson goreum and an indigo silk chima with a subtle woven pattern) receives a small bundle wrapped in a jade-green silk bojagi tied with a gold-thread knot from an elegant, dignified older woman (about 60; kind but serious eyes, gentle refined wrinkles, silver-streaked hair in a low chignon with a silver binyeo; plum-purple jeogori and charcoal-navy chima). Their hands meet over the bundle; the young woman looks up with surprised, moved eyes; the older woman gives a quiet, meaningful smile. Two clearly different faces.',
  'RENDERING: beautiful natural face proportions, finely drawn eyes with highlights, soft luminous skin with natural warm undertones, individually rendered hair strands with sheen, detailed silk texture, folds and embroidery; rich vivid yet harmonious colours (jade, crimson, soft pink, indigo, plum, fresh spring greens, clear blue sky); bright natural daylight with soft rim light and dimensional light and shadow; clean neutral white balance; crisp focus on the faces, gentle depth of field; a polished, finished, detailed background.',
  'The attached images are QUALITY references only — for the level of face drawing, eye detail, skin, hair and lighting craft. Do NOT copy their people, poses, clothing, scenes or their warm amber / sepia colour cast; draw these new characters in this new scene.',
  'NEVER: sepia, yellow or brown tint, beige haze, aged paper, old textbook illustration, folk painting (minhwa) or old storybook look, flat faces, simple outlines, washed-out or muddy colours, dull or grey skin, identical faces; modern clothes or buildings; Chinese or Japanese costume; text, letters, borders, frames, watermark or signature.'
].join('\n\n')
const V3_REFERENCES = ['webtoon_historical', 'korean_drama_illustration'] // the benchmark pictures (not v2-1)
async function runV3(o: { blobs: JobBlobStore; log: (line: string) => void; workerId?: string }, runId: string, base: string, recRef: string, apiKey: string, f: typeof fetch): Promise<'done' | 'already'> {
  await o.blobs.putJson(recRef, { schema: 'style-examples-run/1', status: 'running', startedAt: new Date().toISOString(), worker: o.workerId ?? null }, { overwrite: false })
  const claimed: any = await o.blobs.getJson(recRef).catch(() => null)
  if (claimed?.worker !== (o.workerId ?? null) || claimed?.status !== 'running') { o.log(`[style-examples] run ${runId} was claimed by another worker; nothing done`); return 'already' }
  const work = await mkdtemp(join(tmpdir(), 'style-v3-'))
  const files: Record<string, string> = {}, errors: Record<string, string> = {}
  try {
    // the benchmark cards without their cream border, enlarged (lanczos) so the reference is not a tiny blurred card
    const form = new FormData()
    form.append('model', 'gpt-image-1'); form.append('prompt', V3_PROMPT); form.append('size', '1536x1024'); form.append('quality', 'high'); form.append('output_format', 'jpeg'); form.append('n', '1')
    for (const k of V3_REFERENCES) {
      const out = join(work, `ref-${k}.png`)
      await runOk(['-y', '-i', join(LEGACY_DIR, `${k}.jpg`), '-vf', 'crop=iw*0.88:ih*0.92:iw*0.06:ih*0.04,scale=-2:1024:flags=lanczos', '-frames:v', '1', out])
      form.append('image[]', new Blob([new Uint8Array(await readFile(out))], { type: 'image/png' }), `${k}.png`)
    }
    let made: Buffer | null = null
    try { // one call, no retry
      const r = await f('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const b64 = ((await r.json()) as any)?.data?.[0]?.b64_json
      if (!b64) throw new Error('no image returned')
      made = Buffer.from(b64, 'base64')
    } catch (e: any) { errors.v3 = String(e?.message || e).replace(/sk-[A-Za-z0-9_-]+/g, '[key]'); o.log(`[style-examples] v3 failed (not retried): ${errors.v3}`) }
    if (made) {
      const p = join(work, 'v3.jpg'); await writeFile(p, made)
      files['v3-representative'] = `${base}/v3-representative.jpg`; await o.blobs.putBytes(files['v3-representative'], made, 'image/jpeg')
      // comparison: V3 (left) | v2-1 joseon_clean_watercolor (right); the benchmark pictures underneath
      const v2 = await o.blobs.getBytes('style-examples/candidates/v2-1/joseon_clean_watercolor.jpg').catch(() => null)
      const v2p = join(work, 'v2.jpg'); if (v2) await writeFile(v2p, v2)
      const sheet = join(work, 'compare.jpg')
      await runOk(['-y', '-i', p, ...(v2 ? ['-i', v2p] : ['-f', 'lavfi', '-i', 'color=c=0xdddddd:s=1536x1024']), '-i', join(LEGACY_DIR, `${V3_REFERENCES[0]}.jpg`), '-i', join(LEGACY_DIR, `${V3_REFERENCES[1]}.jpg`), '-filter_complex',
        '[0:v]scale=960:640[a];[1:v]scale=960:640[b];[a][b]hstack[top];[2:v]scale=-2:640,pad=960:640:(ow-iw)/2:0:color=0xdddddd[c];[3:v]scale=-2:640,pad=960:640:(ow-iw)/2:0:color=0xdddddd[d];[c][d]hstack[bot];[top][bot]vstack[v]', '-map', '[v]', '-frames:v', '1', '-q:v', '3', sheet])
      files['compare-v3-left-v2-right-benchmark-below'] = `${base}/compare.jpg`; await o.blobs.putBytes(files['compare-v3-left-v2-right-benchmark-below'], await readFile(sheet), 'image/jpeg')
    }
    await o.blobs.putJson(recRef, { schema: 'style-examples-run/1', status: 'done', finishedAt: new Date().toISOString(), order: made ? ['v3-representative'] : [], files, errors, report: { prompt: V3_PROMPT, references: V3_REFERENCES } }, { overwrite: true })
    for (const [k, ref] of Object.entries(files)) { const s = await o.blobs.presign?.(ref, LINK_MS).catch(() => null); o.log(`[style-examples] ${k}: ${s?.url ?? ref}`) }
    o.log(`[style-examples] run ${runId} done (${made ? 1 : 0}/1 picture). Remove STYLE_EXAMPLES_RUN from the worker variables; this run id never draws again.`)
    return 'done'
  } finally { await rm(work, { recursive: true, force: true }) }
}
