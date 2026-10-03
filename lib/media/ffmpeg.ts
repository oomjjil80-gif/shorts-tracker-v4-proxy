// Thin, dependency-free ffmpeg helpers (ffmpeg-static only; no ffprobe binary is bundled, so probing parses `ffmpeg -i`).
// Every function is a real measurement of a real file; nothing here returns a default that could read as PASS.
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

export const FFMPEG: string = (process.env.FFMPEG_PATH || (ffmpegPath as unknown as string)) as string

export type RunResult = { code: number; stdout: Buffer; stderr: string }

export function runFfmpeg(args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; collectStdout?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('ffmpeg binary not available'))
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    let done = false
    const timer = opts.timeoutMs ? setTimeout(() => { p.kill('SIGKILL'); finish(new Error(`ffmpeg timed out after ${opts.timeoutMs}ms`)) }, opts.timeoutMs) : null
    const onAbort = () => { p.kill('SIGKILL'); finish(new Error('ffmpeg aborted')) }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    function finish(e?: Error, code?: number) {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (e) reject(e); else resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: err })
    }
    p.stdout.on('data', (d: Buffer) => { if (opts.collectStdout !== false) out.push(d) })
    p.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); if (err.length > 4_000_000) err = err.slice(-2_000_000) })
    p.on('error', (e) => finish(e))
    p.on('close', (code) => finish(undefined, code ?? 1))
  })
}

export async function runOk(args: string[], opts?: Parameters<typeof runFfmpeg>[1]): Promise<RunResult> {
  const r = await runFfmpeg(args, opts)
  if (r.code !== 0) {
    const lines = r.stderr.split('\n').filter(Boolean)
    const bad = lines.filter((l) => /error|invalid|unable|no such|cannot|failed|unrecogni|not found|out of memory|resource temporarily unavailable|pthread_create/i.test(l))
    const tail = lines.slice(-12)
    const evidence = [...bad.slice(-6), ...tail].filter((v, i, a) => a.indexOf(v) === i).slice(-12)
    throw new Error(`ffmpeg exit ${r.code}: ${evidence.join(' | ')}`)
  }
  return r
}

export type MediaInfo = {
  duration: number | null
  hasVideo: boolean; hasAudio: boolean
  videoCodec: string | null; profile: string | null; pixFmt: string | null
  width: number | null; height: number | null; sar: string | null; fps: number | null
  audioCodec: string | null; sampleRate: number | null; channels: number | null
  bitrateKbps: number | null
}

const hms = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s)

export async function probe(file: string): Promise<MediaInfo> {
  const r = await runFfmpeg(['-i', file], { collectStdout: false })
  const e = r.stderr
  const dur = e.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const brate = e.match(/bitrate:\s*(\d+)\s*kb\/s/)
  const vline = e.split('\n').find((l) => /Stream #\d+:\d+.*Video:/.test(l)) || ''
  const aline = e.split('\n').find((l) => /Stream #\d+:\d+.*Audio:/.test(l)) || ''
  const vm = vline.match(/Video:\s*([a-z0-9_]+)(?:\s*\(([^)]*)\))?/i)
  const size = vline.match(/,\s*(\d{2,5})x(\d{2,5})/)
  const fps = vline.match(/(\d+(?:\.\d+)?)\s*fps/)
  const pix = vline.match(/Video:[^,]*(?:\([^)]*\))*[^,]*,\s*([a-z0-9]+)/i)
  const sar = vline.match(/SAR\s+(\d+:\d+)/)
  const am = aline.match(/Audio:\s*([a-z0-9_]+)/i)
  const hz = aline.match(/(\d+)\s*Hz/)
  const ch = /mono/.test(aline) ? 1 : /stereo/.test(aline) ? 2 : (aline.match(/(\d+)\s*channels/) ? Number(aline.match(/(\d+)\s*channels/)![1]) : null)
  return {
    duration: dur ? hms(dur[1], dur[2], dur[3]) : null,
    hasVideo: !!vline, hasAudio: !!aline,
    videoCodec: vm ? vm[1].toLowerCase() : null, profile: vm?.[2] ? vm[2].split(',')[0].trim() : null, pixFmt: pix ? pix[1] : null,
    width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null, sar: sar ? sar[1] : null, fps: fps ? Number(fps[1]) : null,
    audioCodec: am ? am[1].toLowerCase() : null, sampleRate: hz ? Number(hz[1]) : null, channels: ch,
    bitrateKbps: brate ? Number(brate[1]) : null
  }
}

export type Interval = { start: number; end: number }

// Full decode of every stream. ok=false on any decoder error; decodedSeconds is the last reported time.
export async function fullDecode(file: string, opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; errors: string[]; decodedSeconds: number | null }> {
  const r = await runFfmpeg(['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { collectStdout: false, signal: opts?.signal })
  const errors = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const t = await runFfmpeg(['-i', file, '-map', '0:v:0', '-f', 'null', '-'], { collectStdout: false, signal: opts?.signal })
  const times = [...t.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
  const last = times.length ? times[times.length - 1] : null
  return { ok: r.code === 0 && errors.length === 0, errors: errors.slice(0, 8), decodedSeconds: last ? hms(last[1], last[2], last[3]) : null }
}

export async function detectBlack(file: string, o: { minDuration?: number; pixelThreshold?: number; crop?: string } = {}): Promise<Interval[]> {
  const r = await runFfmpeg(['-i', file, '-an', '-vf', `${o.crop ? o.crop + ',' : ''}blackdetect=d=${o.minDuration ?? 0.1}:pix_th=${o.pixelThreshold ?? 0.1}:pic_th=0.98`, '-f', 'null', '-'], { collectStdout: false })
  return [...r.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }))
}

export async function detectFreeze(file: string, o: { minDuration?: number; noise?: string } = {}): Promise<Interval[]> {
  const r = await runFfmpeg(['-i', file, '-an', '-vf', `freezedetect=n=${o.noise ?? '-55dB'}:d=${o.minDuration ?? 1}`, '-map', '0:v:0', '-f', 'null', '-'], { collectStdout: false })
  const starts = [...r.stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const ends = [...r.stderr.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const info = await probe(file)
  return starts.map((s, i) => ({ start: s, end: ends[i] ?? (info.duration ?? s) }))
}

export async function detectSilence(file: string, o: { minDuration?: number; noise?: string } = {}): Promise<Interval[]> {
  const r = await runFfmpeg(['-i', file, '-vn', '-af', `silencedetect=n=${o.noise ?? '-50dB'}:d=${o.minDuration ?? 0.5}`, '-f', 'null', '-'], { collectStdout: false })
  const starts = [...r.stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])))
  const ends = [...r.stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const info = await probe(file)
  return starts.map((s, i) => ({ start: s, end: ends[i] ?? (info.duration ?? s) }))
}

export async function volumeStats(file: string): Promise<{ meanDb: number | null; maxDb: number | null }> {
  const r = await runFfmpeg(['-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { collectStdout: false })
  const mean = r.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/), max = r.stderr.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/)
  const n = (m: RegExpMatchArray | null) => (m && m[1] !== '-inf' ? Number(m[1]) : null)
  return { meanDb: n(mean), maxDb: n(max) }
}

// Per-frame scene score (0..1): a cheap, model-free motion/change signal.
export async function sceneScores(file: string): Promise<Array<{ t: number; score: number }>> {
  const r = await runFfmpeg(['-i', file, '-an', '-vf', `scale=160:-2,select='gte(scene,0)',metadata=print:file=-`, '-f', 'null', '-'])
  const out: Array<{ t: number; score: number }> = []
  let t = 0
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const a = line.match(/pts_time:([\d.]+)/); if (a) t = Number(a[1])
    const b = line.match(/lavfi\.scene_score=([\d.]+)/); if (b) out.push({ t, score: Number(b[1]) })
  }
  return out
}

// RMS level (dB) per second of audio; null when the file has no audio stream.
export async function audioRmsPerSecond(file: string): Promise<Array<{ t: number; db: number | null }> | null> {
  const info = await probe(file)
  if (!info.hasAudio) return null
  const r = await runFfmpeg(['-i', file, '-vn', '-af', 'aresample=16000,asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'])
  const out: Array<{ t: number; db: number | null }> = []
  let t = 0
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const a = line.match(/pts_time:([\d.]+)/); if (a) t = Number(a[1])
    const b = line.match(/RMS_level=(-?[\d.]+|-inf)/); if (b) out.push({ t: Math.round(t), db: b[1] === '-inf' ? null : Number(b[1]) })
  }
  return out
}

// Tiny grayscale fingerprint of one frame (after the same cover-crop the renderer applies), for content matching.
export async function frameSignature(file: string, t: number, o: { w?: number; h?: number; cover?: boolean } = {}): Promise<Buffer> {
  const w = o.w ?? 16, h = o.h ?? 28
  const vf = `${o.cover ? 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,' : ''}scale=${w}:${h}:flags=area,format=gray`
  const r = await runOk(['-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-'])
  if (r.stdout.length !== w * h) throw new Error(`frame at ${t}s could not be decoded`)
  return r.stdout
}

export const signatureDistance = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length || !a.length) return Infinity
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
}

export async function extractJpeg(file: string, t: number, out: string, vf = 'scale=540:-2'): Promise<void> {
  await runOk(['-y', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '3', out])
}

export async function contactSheet(file: string, out: string, o: { cols: number; rows: number; tileWidth: number; duration: number }): Promise<void> {
  const n = o.cols * o.rows
  const fps = Math.max(0.05, n / Math.max(1, o.duration))
  await runOk(['-y', '-i', file, '-an', '-vf', `fps=${fps.toFixed(4)},scale=${o.tileWidth}:-2,tile=${o.cols}x${o.rows}:padding=4:margin=4:color=0x202020`, '-frames:v', '1', '-q:v', '4', out])
}

// Keyframe sheet for semantic review: ~1 frame per second (max 40 tiles), each tile stamped with its SOURCE second.
export async function keyframeSheet(file: string, out: string, o: { duration: number; fontFile: string; maxTiles?: number; tileWidth?: number }): Promise<{ tiles: number; everySec: number }> {
  const maxTiles = o.maxTiles ?? 40
  const everySec = Math.max(1, Math.ceil(o.duration / maxTiles))
  const tiles = Math.max(1, Math.ceil(o.duration / everySec))
  const cols = Math.min(8, tiles), rows = Math.ceil(tiles / cols)
  const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  const label = `drawtext=fontfile='${esc(o.fontFile)}':text='%{eif\\:t\\:d}s':x=6:y=6:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4`
  await runOk(['-y', '-i', file, '-an', '-vf', `fps=1/${everySec},scale=${o.tileWidth ?? 180}:-2,${label},tile=${cols}x${rows}:padding=4:margin=4:color=0x202020`, '-frames:v', '1', '-q:v', '4', out])
  return { tiles, everySec }
}
