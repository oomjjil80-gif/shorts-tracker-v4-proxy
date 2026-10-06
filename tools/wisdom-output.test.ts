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
import { wisdomCaptionChunks, wisdomCaptionEvents, WISDOM_CAPTION, anchorNamedThinkerVisual } from '../lib/generative/wisdom.js'

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
// Caption pixels = what the final frame adds on top of the caption-free ASSET source frame (headline band excluded):
// bright added pixels = glyph, dark added pixels = outline. Lines / height come from the rows the caption touches.
async function sourceFrameNear(path: string, t: number, out: Buffer): Promise<Buffer> {
  const r = (await runOk(['-ss', Math.max(0, t - 2 / 30).toFixed(3), '-i', path, '-frames:v', '5', '-vf', 'format=rgb24', '-f', 'rawvideo', '-'])).stdout
  const F = W * H * 3, frames = Array.from({ length: Math.floor(r.length / F) }, (_, k) => r.subarray(k * F, (k + 1) * F))
  const madPic = (f: Buffer) => { let sum = 0, n = 0; for (let y = 380; y < 1300; y += 5) for (let x = 0; x < W; x += 5) { const o = (y * W + x) * 3; sum += Math.abs(f[o] - out[o]); n++ } return sum / n }
  return frames.reduce((a, b) => (madPic(b) < madPic(a) ? b : a))
}
function captionBox(out: Buffer, src: Buffer) {
  let x0 = W, x1 = -1, y0 = H, y1 = -1, glyph = 0, outline = 0, bandInk = 0
  const rows = new Array(H).fill(0)
  for (let y = 360; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3
    const d = Math.max(Math.abs(out[o] - src[o]), Math.abs(out[o + 1] - src[o + 1]), Math.abs(out[o + 2] - src[o + 2]))
    if (d <= 40) continue
    if (y >= 1560) { bandInk++; continue }
    const lum = (out[o] + out[o + 1] + out[o + 2]) / 3
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    rows[y]++; if (lum > 200) glyph++; else if (lum < 70) outline++
  }
  const lines: Array<[number, number]> = []
  rows.forEach((c, k) => { if (c > 20) { const l = lines[lines.length - 1]; if (l && k - l[1] <= 6) l[1] = k; else lines.push([k, k]) } })
  // dense box: caption rows only (ignores isolated encoder-noise pixels elsewhere in the picture)
  const ry0 = lines.length ? lines[0][0] : -1, ry1 = lines.length ? lines[lines.length - 1][1] : -1
  const cols = new Array(W).fill(0)
  for (let y = Math.max(ry0, 360); y >= 0 && y <= ry1; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 3; if (Math.max(Math.abs(out[o] - src[o]), Math.abs(out[o + 1] - src[o + 1]), Math.abs(out[o + 2] - src[o + 2])) > 40) cols[x]++ }
  const cx = cols.map((c, x) => (c > 3 ? x : -1)).filter((x) => x >= 0)
  void x0; void x1; void y0; void y1
  return { box: { x0: cx[0] ?? -1, x1: cx[cx.length - 1] ?? -1, y0: ry0, y1: ry1 }, lines: lines.length, linePx: Math.max(0, ...lines.map(([a, b]) => b - a + 1)), glyph, outline, bandInk }
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
  // beat 3 is a near-white picture: the caption must stay readable on a bright image too
  const bright = (await runOk(['-f', 'lavfi', '-i', 'color=c=0xF2F0EA:s=1024x1536:d=1', '-frames:v', '1', '-f', 'mjpeg', '-'])).stdout
  const rawBeats = NARR.map((narration, i) => ({ id: 'b' + (i + 1), narration, visualGoal: 'g', imagePrompt: i === 0 ? 'scene 1: Seneca, the Roman Stoic philosopher, writing at a desk' : 'scene ' + (i + 1), durationSec: 6 }))
  const rawScript: any = { schema: 'wisdom-script/1', title: '세네카가 말하는 시간의 비밀', hook: 'h', ending: 'e', totalSeconds: 18, beats: rawBeats }
  const script: any = anchorNamedThinkerVisual(rawScript,rawScript.title).script
  const beats = script.beats
  // existing paid assets are reused from the generative cache (no image/TTS call is allowed)
  for (const b of beats) {
    const img = Buffer.concat([b.id === 'b3' ? bright : jpg, Buffer.from(b.id)]), mp3 = (await runOk(['-f', 'lavfi', '-i', `sine=f=${300 + Number(b.id.slice(1)) * 50}:d=6`, '-c:a', 'libmp3lame', '-f', 'mp3', '-'])).stdout
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
  const dlg = ass.ass.split('\n').filter((l) => l.includes(',WisdomWindowSub,'))
  const fsOf = (l: string) => Number(/\\fs(\d+)/.exec(l)![1])

  // RENDER the real MP4 from the generated source
  const srcPath = join(d, 'src.mp4'); await (await import('node:fs/promises')).writeFile(srcPath, blobs.binaries.get(src.blobPath))
  const r = await renderPayload(manifest.payload, { sourceFile: srcPath, sourceHasAudio: true, workDir: join(d, 'w'), outPath: join(d, 'final.mp4') })

  // captions on the final frames
  const shown: any[] = []
  for (const e of subs) { const t = (e.start + e.end) / 2; const o = await frameRgb(r.outPath, t); shown.push({ text: e.text, start: e.start, end: e.end, ...captionBox(o, await sourceFrameNear(srcPath, t, o)) }) }
  // motion: beat 1 of the final MP4 at start / middle / end
  const [f0, fm, f1] = [await frameGray(r.outPath, 0.1), await frameGray(r.outPath, 3), await frameGray(r.outPath, 5.8)]
  const zMid = zoomBetween(f0, fm), zEnd = zoomBetween(f0, f1)
  console.log(JSON.stringify({ narrations: NARR.length, captionEvents: subs.length, fs: dlg.map(fsOf), events: subs.map((e: any) => [e.start, e.end, e.text]), shown: shown.map(({ text, box, lines, linePx, glyph, outline, bandInk }) => ({ text, box, lines, linePx, glyph, outline, bandInk })), zoom: { mid: zMid, end: zEnd } }))

  assert.ok(subs.length >= 2 * NARR.length, `narration split into short captions (${subs.length} events)`)
  assert.equal(dlg.length, subs.length)
  assert.ok(subs.every((e: any) => [...e.text].length <= 20), 'short phrases')
  assert.ok(subs.every((e: any) => e.end - e.start >= WISDOM_CAPTION.minSec - 0.011), 'no flashing captions')
  assert.ok(dlg.every((l) => fsOf(l) >= 80), `large captions: ${dlg.map(fsOf)}`)
  // caption text/timing are the ASSET timed plan (#121 chunking) unchanged by the layout
  assert.deepEqual(subs.map((e: any) => [e.start, e.end, e.text]), events.map((e: any) => [e.start, e.end, e.text]))
  for (const s of shown) {
    // inside the visual window, in its lower part, never in the bottom black band
    assert.ok(s.bandInk <= 20, `${s.text}: caption pixels in the bottom band (${s.bandInk})`)
    assert.ok(s.box.y0 >= 360 && s.box.y1 <= 1559, `${s.text}: bbox ${JSON.stringify(s.box)} outside the visual window`)
    assert.ok(s.box.y1 >= 360 + 1200 * 0.85 && s.box.y0 >= 360 + 1200 * 0.6, `${s.text}: bbox ${JSON.stringify(s.box)} not in the lower window`)
    assert.ok(s.box.x0 >= 80 && s.box.x1 <= 1000, `${s.text}: too wide ${JSON.stringify(s.box)}`)
    // large, 1-2 lines, white glyphs with a real dark outline (readable on dark and bright pictures)
    assert.ok(s.lines >= 1 && s.lines <= 2, `${s.text}: ${s.lines} lines`)
    assert.ok(s.linePx >= 64, `${s.text}: text line ${s.linePx}px tall (glyph + outline)`)
    assert.ok(s.outline >= 5000, `${s.text}: dark outline ${s.outline}px`)
  }
  assert.ok(zMid.scale >= 1.03 && zEnd.scale > zMid.scale + 0.02 && zEnd.mad < 12, `image zooms visibly: mid ${JSON.stringify(zMid)} end ${JSON.stringify(zEnd)}`)
})
