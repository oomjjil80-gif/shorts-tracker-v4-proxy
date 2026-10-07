// Manual OOM check (not in `npm test`; a few minutes): renders the HEAVIEST real segments the longform renderer can make,
// with real ffmpeg and detailed stand-in pictures, and records each ffmpeg process's peak memory (VmHWM). Every
// 45 / 90 / 120 minute video is a list of segments no heavier than these (the segment count grows, not the process —
// see tools/longform-chunked-render.test.ts), so their peak is the render's peak. The worker runs in 1 GB.
//   npx tsx tools/longform-render-memory.ts [--single 60]
// --single S also starts the OLD one-graph render (every picture of a 45-minute video in one process) for S seconds.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG, runOk, probe } from '../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../lib/media/ass.js'
import { LONGFORM, longformCardsAss } from '../lib/generative/longform.js'
import { RENDER_SEGMENT, runFrames, sceneSegmentArgv, segmentConcatArgv, seniorVideoArgv } from '../lib/generative/seniorLongform.js'
import { COLD_OPEN } from '../lib/generative/yasaLongform.js'

const singleFor = process.argv.includes('--single') ? Number(process.argv[process.argv.indexOf('--single') + 1] || 60) : 0
const statusKb = (pid: number, key: string) => readFile(`/proc/${pid}/status`, 'utf8').then((s) => Number(s.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] || 0)).catch(() => 0)
// spawn one ffmpeg and poll its peak resident memory until it exits (or until `killAfter` seconds)
async function measured(argv: string[], killAfter = 0) {
  const t0 = Date.now(), p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...argv], { stdio: ['ignore', 'ignore', 'pipe'] })
  let peak = 0, err = '', done = false
  p.stderr.on('data', (x) => (err += x))
  const exited = new Promise<number | null>((r) => p.once('exit', (c) => { done = true; r(c) }))
  while (!done) { peak = Math.max(peak, await statusKb(p.pid!, 'VmHWM')); if (killAfter && Date.now() - t0 > killAfter * 1000) p.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 100)) }
  const code = await exited
  if (!killAfter && code !== 0) throw new Error(`ffmpeg failed: ${err.slice(-400)}`)
  return { peakMB: Math.round(peak / 1024), seconds: Math.round((Date.now() - t0) / 1000) }
}

const d = await mkdtemp(join(tmpdir(), 'lf-mem-')), N = 50
const pics: string[] = []
for (let i = 0; i < N; i++) { // detailed 1536x1024 pictures (noise + gradients + grid): the scaler and encoder get real work
  const f = join(d, `p${i}.jpg`); pics.push(f)
  await runOk(['-y', '-f', 'lavfi', '-i', `nullsrc=s=1536x1024,geq=random(1)*255:128+60*sin(X/40+${i}):128+60*cos(Y/30-${i}),drawgrid=w=96:h=96:t=4:c=white@0.6`, '-frames:v', '1', '-q:v', '3', f])
}
// subtitle cards every 5 s (the density of a real script)
async function assFor(name: string, seconds: number) {
  const n = Math.ceil(seconds / 5)
  const script: any = { title: 't', sections: [{ id: 'a', heading: 'h', sentences: Array.from({ length: n }, (_, k) => ({ say: `며느리는 썩은 메주를 끝까지 지고 갔다 ${k}`, show: ['썩은 메주를', `지고 간 날 ${k}`], accent: '썩은 메주', color: 'red' })) }] }
  const tl = Array.from({ length: n }, (_, k) => ({ start: k * 5, end: Math.min(seconds, (k + 1) * 5), k }))
  const f = join(d, `${name}.ass`); await writeFile(f, longformCardsAss(script, tl, 'bottom').ass); return f
}
async function segment(name: string, runs: Array<{ seconds: number; cold?: boolean }>, from: number) {
  const starts: number[] = []; let t = 0
  for (const r of runs) { starts.push(t); t += r.seconds }
  const frames = runFrames(starts, t), out = join(d, `${name}.mp4`)
  const argv = sceneSegmentArgv({ images: pics, runs: runs.map((r, i) => ({ image: from + i, frames: frames[i], index: from + i, ...(r.cold ? { cold: true } : {}) })), ass: await assFor(name, t), fontsDir: FONTS_DIR, out, threads: 4 })
  const m = await measured(argv), info = await probe(out)
  return { name, pictures: argv.filter((x) => x === '-i').length, videoSeconds: t, ...m, out, format: `${info.width}x${info.height} sar ${info.sar} ${info.fps}fps` }
}

// 1) the cold open: up to 8 fast beats with the strong motion, 60 s
const cold = await segment('cold-open', Array.from({ length: COLD_OPEN.beats.max }, () => ({ seconds: COLD_OPEN.seconds.max / COLD_OPEN.beats.max, cold: true })), 0)
// 2) the heaviest main segment: the most pictures AND the longest span one segment may hold (8 pictures, 6 minutes)
const main = await segment('main-max', Array.from({ length: RENDER_SEGMENT.maxRuns }, () => ({ seconds: RENDER_SEGMENT.maxSeconds / RENDER_SEGMENT.maxRuns })), 8)
// 3) the final step: stream copy of the segments + the narration (no decode / encode)
const seconds = cold.videoSeconds + main.videoSeconds, nar = join(d, 'narration.m4a'), list = join(d, 'list.txt'), out = join(d, 'final.mp4')
await runOk(['-y', '-f', 'lavfi', '-i', `sine=f=220:d=${seconds}`, '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', nar])
await writeFile(list, [cold.out, main.out].map((f) => `file '${f}'`).join('\n') + '\n')
const concat = await measured(segmentConcatArgv({ list, audio: nar, out, seconds }))
const fin = await probe(out)
console.log('SEGMENT_PEAKS ' + JSON.stringify([cold, main].map(({ out: _o, ...x }) => x)))
console.log('FINAL_CONCAT ' + JSON.stringify({ ...concat, duration: fin.duration, frames: Math.round(Number(fin.duration) * LONGFORM.fps), format: `${fin.width}x${fin.height} sar ${fin.sar} ${fin.fps}fps` }))
if (singleFor) {
  // the old render of a 45-minute 숨은야담 (8 cold beats + 42 scene pictures in ONE graph), stopped after singleFor seconds
  const runs = [...Array.from({ length: 8 }, () => ({ seconds: 7.5, cold: true })), ...Array.from({ length: 42 }, () => ({ seconds: 63 }))].map((r, i) => ({ ...r, image: i }))
  const all = 60 + 42 * 63, a = await assFor('all', all), n2 = join(d, 'nar-all.m4a')
  await runOk(['-y', '-f', 'lavfi', '-i', `sine=f=220:d=${all}`, '-c:a', 'aac', '-b:a', '160k', n2])
  const m = await measured(seniorVideoArgv({ images: pics, runs, audio: n2, ass: a, fontsDir: FONTS_DIR, out: join(d, 'single.mp4'), seconds: all, threads: 4 }), singleFor)
  console.log('OLD_SINGLE_GRAPH ' + JSON.stringify({ pictures: runs.length, ranSeconds: singleFor, peakMB: m.peakMB }))
}
const worst = Math.max(cold.peakMB, main.peakMB, concat.peakMB)
console.log(`PEAK ${worst} MB (limit 1024 MB): ${worst < 1024 ? 'PASS' : 'FAIL'}`)
await rm(d, { recursive: true, force: true })
process.exit(worst < 1024 ? 0 : 1)
