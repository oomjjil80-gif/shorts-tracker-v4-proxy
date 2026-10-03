// Wisdom output, measured on the FINAL MP4 (not on code strings): the real ASSET executor (cached image/TTS, no paid
// calls) -> timed plan -> COMPILE -> RENDER -> MP4. Proves (1) narration is shown as short, large captions and (2) every
// still image visibly zooms (start/mid/end frames of one beat differ in scale).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGenerativeAssetExecutor } from '../worker/stages/generative.js'
import { createMemoryBlobStore, putAddressed } from '../lib/jobs/blobs.js'
import { runOk } from '../lib/media/ffmpeg.js'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'
import { renderPayload, extractRenderPlan } from '../lib/media/render.js'
import { assFromPayload } from '../lib/media/ass.js'
import { wisdomCaptionChunks, wisdomCaptionEvents, WISDOM_CAPTION } from '../lib/generative/wisdom.js'

const W = 1080, H = 1920
const h = (x: string | Buffer) => createHash('sha256').update(x).digest('hex')
const NARR = [
  '세네카는 인생이 짧은 것이 아니라 우리가 많은 시간을 낭비하고 있다고 말했습니다',
  '남의 기대에 맞추느라 하루를 다 써버리면 정작 나를 위한 시간은 남지 않습니다',
  '오늘 하루만큼은 꼭 필요한 일 하나에 온전히 집중해 보세요'
]

async function frameGray(path: string, t: number): Promise<Buffer> {
  return (await runOk(['-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'])).stdout
}
async function frameRgb(path: string, t: number): Promise<Buffer> {
  return (await runOk(['-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'rawvideo', '-'])).stdout
}
// b ≈ a zoomed by s about the window centre: best s in [1, 1.25] (window rows only, subsampled)
function zoomBetween(a: Buffer, b: Buffer): { scale: number; mad: number } {
  const cx = 540, cy = 360 + 600
  let best = { scale: 1, mad: Infinity }
  for (let s = 1; s <= 1.25 + 1e-9; s += 0.005) {
    let sum = 0, n = 0
    for (let y = 380; y < 1540; y += 6) for (let x = 20; x < 1060; x += 6) {
      const sx = Math.round(cx + (x - cx) / s), sy = Math.round(cy + (y - cy) / s)
      sum += Math.abs(b[y * W + x] - a[sy * W + sx]); n++
    }
    if (sum / n < best.mad) best = { scale: Number(s.toFixed(3)), mad: Number((sum / n).toFixed(2)) }
  }
  return best
}
// white caption ink in the bottom band: number of text lines and the tallest line (px)
function captionInk(rgb: Buffer) {
  const rows: number[] = []
  for (let y = 1560; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) { const o = (y * W + x) * 3; if (rgb[o] > 200 && rgb[o + 1] > 200 && rgb[o + 2] > 200) c++ } rows.push(c) }
  const lines: Array<[number, number]> = []
  rows.forEach((c, k) => { if (c > 2) { const l = lines[lines.length - 1]; if (l && k - l[1] <= 4) l[1] = k; else lines.push([k, k]) } })
  return { lines: lines.length, maxLinePx: Math.max(0, ...lines.map(([a, b]) => b - a + 1)) }
}

test('wisdomCaptionChunks splits on whitespace into short phrases', () => {
  const c = wisdomCaptionChunks(NARR[0])
  assert.ok(c.length >= 3, JSON.stringify(c))
  assert.ok(c.every((x) => x.length <= WISDOM_CAPTION.maxChars || !x.includes(' ')), JSON.stringify(c))
  assert.equal(c.join(' '), NARR[0])
  // never flashes: every chunk stays >= minSec, and the beat is covered end to end
  const ev = wisdomCaptionEvents(NARR[0], 2, 4.4)
  assert.ok(ev.every((e) => e.end - e.start >= WISDOM_CAPTION.minSec - 0.011), JSON.stringify(ev))
  assert.equal(ev[0].start, 2); assert.equal(ev[ev.length - 1].end, 4.4)
  assert.equal(ev.map((e) => e.text).join(' '), NARR[0])
})

test('FINAL MP4: Wisdom narration appears as short large captions and every image visibly zooms', async () => {
  const d = await mkdtemp(join(tmpdir(), 'wisdom-out-'))
  const blobs: any = createMemoryBlobStore()
  const jpg = (await runOk(['-f', 'lavfi', '-i', 'testsrc2=s=1024x1536:d=1', '-frames:v', '1', '-f', 'mjpeg', '-'])).stdout
  const beats = NARR.map((narration, i) => ({ id: 'b' + (i + 1), narration, visualGoal: 'g', imagePrompt: i === 0 ? 'scene 1: Seneca, the Roman Stoic philosopher, writing at a desk' : 'scene ' + (i + 1), durationSec: 6 }))
  const script: any = { schema: 'wisdom-script/1', title: '세네카가 말하는 시간의 비밀', hook: 'h', ending: 'e', totalSeconds: 18, beats }
  // existing paid assets are reused from the generative cache (no image/TTS call is allowed)
  for (const b of beats) {
    const img = Buffer.concat([jpg, Buffer.from(b.id)]), mp3 = (await runOk(['-f', 'lavfi', '-i', `sine=f=${300 + Number(b.id.slice(1)) * 50}:d=6`, '-c:a', 'libmp3lame', '-f', 'mp3', '-'])).stdout
    await blobs.putBytes(`img/${b.id}.jpg`, img, 'image/jpeg'); await blobs.putJson('generative-cache/image/' + h('image-v1|' + b.imagePrompt) + '.json', { ref: `img/${b.id}.jpg`, sha256: h(img), contentType: 'image/jpeg' })
    await blobs.putBytes(`aud/${b.id}.mp3`, mp3, 'audio/mpeg'); await blobs.putJson('generative-cache/tts/' + h('tts-v1|' + b.narration) + '.json', { ref: `aud/${b.id}.mp3`, sha256: h(mp3), contentType: 'audio/mpeg' })
  }
  const stored = await putAddressed(blobs, 'generative-scripts', script)
  const ex = createGenerativeAssetExecutor({ apiKey: 'k', image: async () => { throw new Error('paid image call') }, tts: async () => { throw new Error('paid tts call') } } as any)
  const out: any = await ex.run({ job: { id: 'jw', profile: 'wisdom', planRev: 1, sourceAssetId: 'src_gen_jw' }, blobs, previous: async (s: string) => (s === 'PLAN' ? { result: { scriptRef: stored.path } } : null), signal: new AbortController().signal } as any)

  // ASSET timed plan -> COMPILE manifest -> ASS
  const plan: any = await blobs.getJson(out.result.timedPlanRef)
  const events = plan.variantPlan.events
  const src = out.result.source
  const { manifest } = compileJobPlan({ jobId: 'jw', plan, sourceAsset: src })
  const subs = manifest.payload.subtitleEvents
  assert.deepEqual(subs.map((e: any) => e.text), events.map((e: any) => e.text)) // PLAN/ASSET -> COMPILE unchanged
  const total = extractRenderPlan(manifest.payload).total
  const ass = assFromPayload({ ...manifest.payload, totalDuration: total })
  const dlg = ass.ass.split('\n').filter((l) => l.includes(',WisdomSub,'))
  const fsOf = (l: string) => Number(/\\fs(\d+)/.exec(l)![1])

  // RENDER the real MP4 from the generated source
  const srcPath = join(d, 'src.mp4'); await (await import('node:fs/promises')).writeFile(srcPath, blobs.binaries.get(src.blobPath))
  const r = await renderPayload(manifest.payload, { sourceFile: srcPath, sourceHasAudio: true, workDir: join(d, 'w'), outPath: join(d, 'final.mp4') })

  // captions on the final frames
  const shown: any[] = []
  for (const e of subs) { const ink = captionInk(await frameRgb(r.outPath, (e.start + e.end) / 2)); shown.push({ text: e.text, sec: Number((e.end - e.start).toFixed(2)), ...ink }) }
  // motion: beat 1 of the final MP4 at start / middle / end
  const [f0, fm, f1] = [await frameGray(r.outPath, 0.1), await frameGray(r.outPath, 3), await frameGray(r.outPath, 5.8)]
  const zMid = zoomBetween(f0, fm), zEnd = zoomBetween(f0, f1)
  console.log(JSON.stringify({ narrations: NARR.length, captionEvents: subs.length, fs: dlg.map(fsOf), shown, zoom: { mid: zMid, end: zEnd } }))

  assert.ok(subs.length >= 2 * NARR.length, `narration split into short captions (${subs.length} events)`)
  assert.equal(dlg.length, subs.length)
  assert.ok(subs.every((e: any) => [...e.text].length <= 20), 'short phrases')
  assert.ok(subs.every((e: any) => e.end - e.start >= WISDOM_CAPTION.minSec - 0.011), 'no flashing captions')
  assert.ok(dlg.every((l) => fsOf(l) >= 80), `large captions: ${dlg.map(fsOf)}`)
  assert.ok(shown.every((s) => s.lines >= 1 && s.lines <= 2), 'drawn as 1-2 lines')
  assert.ok(shown.every((s) => s.maxLinePx >= 50), `drawn Hangul is large on the final frame: ${shown.map((s) => s.maxLinePx)}`)
  assert.ok(zMid.scale >= 1.03 && zEnd.scale > zMid.scale + 0.02 && zEnd.mad < 12, `image zooms visibly: mid ${JSON.stringify(zMid)} end ${JSON.stringify(zEnd)}`)
})
