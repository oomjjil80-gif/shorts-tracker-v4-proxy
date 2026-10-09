// ONE-OFF TEST (branch yv5-run only) — PR #180 final paid test: 3 calls in order on this branch's preview
// (/api/image?oneoff=golden-lock-test). Stops at the first error, never retried. Usage: tsx tools/golden-lock-test-run.ts <previewUrl> <outDir>
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probe, runOk } from '../lib/media/ffmpeg.js'
import { LOCK_TEST_SCENES, LOCK_TEST_STYLE } from '../lib/oneoff/goldenLockTest.js'
import { GOLDEN_IDENTITY_INSTRUCTION, GOLDEN_REFERENCE_DIR, GOLDEN_STYLES, GOLDEN_STYLE_INSTRUCTION } from '../lib/generative/goldenStyle.js'

const [base, out] = process.argv.slice(2)
const token = process.env.GITHUB_TOKEN || ''
if (!base || !out || !token) { console.error('usage: tsx tools/golden-lock-test-run.ts <previewUrl> <outDir> (GITHUB_TOKEN set)'); process.exit(2) }
await mkdir(out, { recursive: true })
const work = await mkdtemp(join(tmpdir(), 'glt-'))
const calls: any[] = []
let first: Buffer | null = null
for (const step of [1, 2, 3]) {
  const c: any = { step, sent: new Date().toISOString() }; calls.push(c)
  try {
    const identity = step > 1 && first ? { data: first.toString('base64'), sha256: createHash('sha256').update(first).digest('hex') } : undefined
    const r = await fetch(`${base}/api/image?oneoff=golden-lock-test`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ step, ...(identity ? { identity } : {}) }), signal: AbortSignal.timeout(200_000) })
    const j: any = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status} (no JSON)`, paidCalls: null }))
    Object.assign(c, { status: r.status, ok: j.ok, paidCalls: j.paidCalls, ms: j.ms, model: j.model, inputs: j.inputs, lockSha256: j.lockSha256, code: j.code, cause: j.cause, error: j.error })
    if (!j.ok) { console.log(`step ${step}: failed (not retried): ${j.error}`); console.log('error: stopping, no further call'); break }
    const bytes = Buffer.from(j.b64, 'base64'); if (step === 1) first = bytes
    const raw = join(work, `r${step}.${/png/.test(j.contentType) ? 'png' : 'jpg'}`); await writeFile(raw, bytes)
    const res = join(out, `image-${step}.jpg`); await runOk(['-y', '-i', raw, '-q:v', '2', res]); const i = await probe(res); c.size = `${i.width}x${i.height}`
    console.log(`step ${step}: done in ${j.ms} ms (${c.size}, inputs ${j.inputs})`)
  } catch (e: any) { c.error = String(e?.message || e).slice(0, 300); console.log(`step ${step}: failed (not retried): ${c.error}`); console.log('error: stopping, no further call'); break }
}
const ref = join(GOLDEN_REFERENCE_DIR, GOLDEN_STYLES[LOCK_TEST_STYLE].file)
await writeFile(join(out, `golden-reference-${LOCK_TEST_STYLE}.jpg`), await readFile(ref))
const imgs = [1, 2, 3].map((s) => join(out, `image-${s}.jpg`))
const done = calls.filter((c) => c.ok).length
if (done) {
  // top: the Golden reference | the first picture (the lock); bottom: the two later pictures (same people expected)
  const have = imgs.slice(0, done)
  const inputs = [ref, ...have].flatMap((x) => ['-i', x])
  const n = have.length + 1
  const scaled = Array.from({ length: n }, (_, k) => `[${k}:v]scale=-2:432:flags=lanczos,pad=iw+8:ih+8:4:4:white[s${k}]`).join(';')
  await runOk(['-y', ...inputs, '-filter_complex', `${scaled};${Array.from({ length: n }, (_, k) => `[s${k}]`).join('')}hstack=${n}[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '2', join(out, 'compare-reference-first-later.jpg')])
}
await writeFile(join(out, 'run.json'), JSON.stringify({ test: 'PR #180 final paid Gemini test: Golden Style + first-image character lock', style: LOCK_TEST_STYLE, model: 'gemini-3.1-flash-image', aspect_ratio: '16:9', image_size: '1K',
  requests: { first: { images: ['Golden reference'], text: `${GOLDEN_STYLE_INSTRUCTION} + 장면 + 16:9 line` }, later: { images: ['Golden reference (style)', 'image-1 (people)'], text: `${GOLDEN_IDENTITY_INSTRUCTION} + 장면 + 16:9 line` } },
  scenes: LOCK_TEST_SCENES, calls, successful: done, estUsd: Number((done * 0.067).toFixed(3)) }, null, 2))
await rm(work, { recursive: true, force: true })
console.log(JSON.stringify({ calls: calls.map(({ step, status, ok, paidCalls, ms, size, inputs, code, error }) => ({ step, status, ok, paidCalls, ms, size, inputs, code, error })) }))
