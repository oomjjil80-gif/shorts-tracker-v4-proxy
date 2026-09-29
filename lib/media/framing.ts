import { probe, runOk } from './ffmpeg.js'

export type CropRect = { x: number; y: number; width: number; height: number }
export type SourceFraming = {
  mode: 'full' | 'embedded'
  crop: CropRect | null
  confidence: number
  sampleCount: number
  detector: 'luma-bands-v1'
}

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function longestRun(mask: boolean[]): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null
  let start: number | null = null
  for (let i = 0; i <= mask.length; i++) {
    if (i < mask.length && mask[i]) {
      if (start === null) start = i
      continue
    }
    if (start !== null) {
      const run = { start, end: i }
      if (!best || run.end - run.start > best.end - best.start) best = run
      start = null
    }
  }
  return best
}

const evenDown = (n: number) => Math.max(0, Math.floor(n / 2) * 2)
const evenUp = (n: number) => Math.ceil(n / 2) * 2

// Detects a real picture embedded inside a nominally vertical file (e.g. landscape CCTV surrounded by
// black padding and a title band). The largest persistent non-dark horizontal band wins, so a short text
// strip in a black area cannot be mistaken for the actual video. Full-frame sources are left untouched.
export async function detectSourceFraming(file: string, opts: { sampleFrames?: number; scaledWidth?: number; lumaThreshold?: number; activeFraction?: number } = {}): Promise<SourceFraming> {
  const info = await probe(file)
  if (!info.hasVideo || !info.width || !info.height || !info.duration) throw new Error('cannot detect framing without video dimensions/duration')
  const sw = Math.max(96, Math.round(opts.scaledWidth ?? 160))
  const sh = Math.max(2, evenUp(sw * info.height / info.width))
  const wanted = Math.max(3, Math.min(10, Math.round(opts.sampleFrames ?? 7)))
  const fps = Math.max(0.02, wanted / Math.max(info.duration, 0.1))
  const raw = await runOk(['-i', file, '-an', '-vf', `fps=${fps.toFixed(6)},scale=${sw}:${sh}:flags=area,format=gray`, '-frames:v', String(wanted), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  const frameSize = sw * sh
  const n = Math.min(wanted, Math.floor(raw.stdout.length / frameSize))
  if (!n) throw new Error('no frames decoded for framing analysis')

  const luma = Math.max(8, Math.min(80, Math.round(opts.lumaThreshold ?? 28)))
  const activeFraction = Math.max(0.02, Math.min(0.75, opts.activeFraction ?? 0.36))
  const rowScores: number[] = []
  for (let y = 0; y < sh; y++) {
    const perFrame: number[] = []
    for (let f = 0; f < n; f++) {
      const base = f * frameSize + y * sw
      let active = 0
      for (let x = 0; x < sw; x++) if (raw.stdout[base + x] >= luma) active++
      perFrame.push(active / sw)
    }
    rowScores.push(median(perFrame))
  }

  const run = longestRun(rowScores.map((x) => x >= activeFraction))
  if (!run || run.end - run.start < sh * 0.2) return { mode: 'full', crop: null, confidence: 0, sampleCount: n, detector: 'luma-bands-v1' }
  const pad = Math.max(1, Math.round(sh * 0.006))
  const y0s = Math.max(0, run.start - pad)
  const y1s = Math.min(sh, run.end + pad)
  const activeRatio = (y1s - y0s) / sh
  const topBar = y0s / sh, bottomBar = (sh - y1s) / sh

  // Do not “improve” normal full-frame footage. Embedded framing requires a meaningful persistent bar.
  if (activeRatio >= 0.88 || Math.max(topBar, bottomBar) < 0.05 || topBar + bottomBar < 0.1) {
    return { mode: 'full', crop: null, confidence: 0, sampleCount: n, detector: 'luma-bands-v1' }
  }

  const srcY = evenDown(y0s / sh * info.height)
  const srcEnd = Math.min(info.height, evenUp(y1s / sh * info.height))
  const height = Math.max(2, srcEnd - srcY)
  const bandContrast = Math.min(1, Math.max(0, (topBar + bottomBar - 0.1) / 0.45))
  const confidence = Math.round((0.6 + 0.4 * bandContrast) * 1000) / 1000
  return {
    mode: 'embedded',
    crop: { x: 0, y: srcY, width: evenDown(info.width), height },
    confidence,
    sampleCount: n,
    detector: 'luma-bands-v1'
  }
}

export function foregroundRect(crop: CropRect, outWidth = 1080, outHeight = 1920): CropRect {
  const ar = crop.width / crop.height
  const target = outWidth / outHeight
  if (ar >= target) {
    const height = Math.max(2, evenDown(outWidth / ar))
    return { x: 0, y: evenDown((outHeight - height) / 2), width: outWidth, height }
  }
  const width = Math.max(2, evenDown(outHeight * ar))
  return { x: evenDown((outWidth - width) / 2), y: 0, width, height: outHeight }
}

export async function regionSignature(file: string, t: number, crop: CropRect, w = 16, h = 16): Promise<Buffer> {
  const c = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`
  const r = await runOk(['-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `${c},scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-'])
  if (r.stdout.length !== w * h) throw new Error(`region frame at ${t}s could not be decoded`)
  return r.stdout
}
