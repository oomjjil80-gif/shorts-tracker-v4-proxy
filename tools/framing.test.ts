import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOk } from '../lib/media/ffmpeg.js'
import { detectSourceFraming, measureOuterCanvasFill } from '../lib/media/framing.js'
import { buildFilterGraph, renderPayload } from '../lib/media/render.js'

async function makeEmbedded(file: string) {
  await runOk([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=576x1024:r=30:d=2',
    '-f', 'lavfi', '-i', 'testsrc2=s=576x420:r=30:d=2',
    '-filter_complex', '[0:v][1:v]overlay=0:302,drawbox=x=130:y=100:w=300:h=46:color=yellow:t=fill[v]',
    '-map', '[v]', '-an', '-c:v', 'libx264', '-threads:v', '2', '-pix_fmt', 'yuv420p', '-t', '2', file
  ], { timeoutMs: 120_000 })
}

async function makeFull(file: string) {
  await runOk(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=576x1024:r=30:d=2', '-an', '-c:v', 'libx264', '-threads:v', '2', '-pix_fmt', 'yuv420p', '-t', '2', file], { timeoutMs: 120_000 })
}

test('framing detector picks the largest real picture, not a short bright title strip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'framing-'))
  try {
    const embedded = join(dir, 'embedded.mp4'), full = join(dir, 'full.mp4')
    await makeEmbedded(embedded); await makeFull(full)
    const f = await detectSourceFraming(embedded)
    assert.equal(f.mode, 'embedded')
    assert.ok(f.crop)
    assert.equal(f.crop!.x, 0); assert.equal(f.crop!.width, 576)
    assert.ok(f.crop!.y >= 270 && f.crop!.y <= 330, JSON.stringify(f))
    assert.ok(f.crop!.height >= 380 && f.crop!.height <= 470, JSON.stringify(f))
    assert.ok(f.confidence >= 0.6)
    assert.equal((await detectSourceFraming(full)).mode, 'full')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('smart-framed render removes embedded bars and places the picture in the Common Screen DNA window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'framing-render-'))
  try {
    const source = join(dir, 'source.mp4'), out = join(dir, 'out.mp4'), work = join(dir, 'work')
    await makeEmbedded(source)
    const framing = await detectSourceFraming(source)
    assert.equal(framing.mode, 'embedded')
    const payload: any = {
      renderSettings: { width: 1080, height: 1920, fps: 30 }, bgm: null, audioMode: 'none', totalDuration: 2,
      cuts: [{ start: 0, duration: 2, mediaType: 'source_video', sourceVideo: { trimStart: 0, trimEnd: 2, volume: 1, mute: false } }],
      editorialPlan: { headline: '', events: [] }, subtitleEvents: [], sourceCallouts: [], sourceEffectCaptions: []
    }
    const r = await renderPayload(payload, { sourceFile: source, sourceHasAudio: false, workDir: work, outPath: out, sourceFraming: framing })
    // the baked-in bars are cropped off first, then the picture is cover-scaled into the contract window (no blur-fill)
    const { renderVideoFilters, windowLineDiffs, screenDnaWindowFilter } = await import('../lib/media/screenDna.js')
    const lines = renderVideoFilters(r.filterGraph)
    assert.equal(lines.length, 1); assert.deepEqual(windowLineDiffs(lines[0]), [])
    assert.match(lines[0], /crop=576:/); assert.ok(lines[0].includes(screenDnaWindowFilter())); assert.doesNotMatch(r.filterGraph, /gblur=|overlay=/)
    // bands are the contract's black padding; the window carries the picture
    const g = (await runOk(['-ss', '1', '-i', out, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'])).stdout
    const rowMean = (y0: number, y1: number) => { let s = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 1080; x++) s += g[y * 1080 + x]; return s / ((y1 - y0) * 1080) }
    assert.ok(rowMean(0, 360) < 20 && rowMean(1560, 1920) < 20, `bands ${rowMean(0, 360)} ${rowMean(1560, 1920)}`)
    assert.ok(rowMean(360, 1560) > 40, `window ${rowMean(360, 1560)}`)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('canvas-fill measure still flags a true letterbox, but the Shorts gate uses the Screen DNA contract instead', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fill-'))
  try {
    const letter = join(dir, 'letterbox.mp4')
    await runOk(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'testsrc2=s=1080x608:r=30:d=2', '-filter_complex', '[0:v][1:v]overlay=0:656[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-threads:v', '2', '-pix_fmt', 'yuv420p', '-t', '2', letter], { timeoutMs: 120_000 })
    const bl = await measureOuterCanvasFill(letter)
    assert.equal(bl.filled, false, JSON.stringify(bl))
    const autoQc = await readFile(new URL('../worker/stages/autoQc.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(autoQc, /measureOuterCanvasFill|visual\.frame_utilization|detectSourceFraming/)
    assert.match(autoQc, /runScreenDnaQc\(/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
