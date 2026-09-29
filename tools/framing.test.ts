import test from 'node:test'
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

test('smart-framed render removes embedded bars and fills the final 9:16 canvas', async () => {
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
    await renderPayload(payload, { sourceFile: source, sourceHasAudio: false, workDir: work, outPath: out, sourceFraming: framing })
    // Output QC uses the dedicated canvas-fill measurement (not the source picture detector): blur-fill is valid.
    const fill = await measureOuterCanvasFill(out)
    assert.equal(fill.filled, true, JSON.stringify(fill))
    const graph = buildFilterGraph([{ start: 0, duration: 2, trimStart: 0, trimEnd: 2, volume: 1, mute: false }], { sourceHasAudio: false, assPath: '', fontsDir: '', hasOverlays: false, sourceFraming: framing })
    assert.match(graph, /gblur=/); assert.match(graph, /overlay=/); assert.match(graph, /crop=576:/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('output canvas-fill QC: true black letterbox FAILS, blur-fill PASSES (also for dark footage)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fill-'))
  try {
    const letter = join(dir, 'letterbox.mp4'), blurred = join(dir, 'blur.mp4'), darkBlur = join(dir, 'dark-blur.mp4')
    // black bars: 576x420 picture centred on a pure black 1080x1920 canvas
    await runOk(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'testsrc2=s=1080x608:r=30:d=2', '-filter_complex', '[0:v][1:v]overlay=0:656[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-threads:v', '2', '-pix_fmt', 'yuv420p', '-t', '2', letter], { timeoutMs: 120_000 })
    const bl = await measureOuterCanvasFill(letter)
    assert.equal(bl.filled, false, JSON.stringify(bl))
    // blur-fill of a normal picture, and of a dark (but textured) picture, through the real filter graph
    for (const [file, src] of [[blurred, 'testsrc2=s=576x420:r=30:d=2'], [darkBlur, 'testsrc2=s=576x420:r=30:d=2,eq=brightness=-0.45']] as const) {
      const embedded = join(dir, `emb-${file.split('/').pop()}`)
      await runOk(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=576x1024:r=30:d=2', '-f', 'lavfi', '-i', src, '-filter_complex', '[0:v][1:v]overlay=0:302[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-threads:v', '2', '-pix_fmt', 'yuv420p', '-t', '2', embedded], { timeoutMs: 120_000 })
      const framing = await detectSourceFraming(embedded, { lumaThreshold: 12, activeFraction: 0.05 })
      assert.equal(framing.mode, 'embedded', `${file}: ${JSON.stringify(framing)}`)
      const payload: any = { renderSettings: { width: 1080, height: 1920, fps: 30 }, bgm: null, audioMode: 'none', totalDuration: 2, cuts: [{ start: 0, duration: 2, mediaType: 'source_video', sourceVideo: { trimStart: 0, trimEnd: 2, volume: 1, mute: false } }], editorialPlan: { headline: '', events: [] }, subtitleEvents: [], sourceCallouts: [], sourceEffectCaptions: [] }
      await renderPayload(payload, { sourceFile: embedded, sourceHasAudio: false, workDir: join(dir, `w-${file.split('/').pop()}`), outPath: file, sourceFraming: framing })
      const fill = await measureOuterCanvasFill(file)
      assert.equal(fill.filled, true, `${file}: ${JSON.stringify(fill)}`)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
