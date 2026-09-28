// Server-side frame extraction for registered Source Assets.
//
// Permanent structure, not a per-video hack: any sourceAssetId that resolves
// through the Source Asset Registry can have frames extracted this way. The
// only external dependency is a statically-linked ffmpeg binary bundled into
// the Function (see vercel.json includeFiles) - no third-party image/video
// hosting service ever sees the private Blob or its signed playback URL.
//
// Access is sourceAssetId -> Registry -> blobPath -> private Blob read only.
// These functions never accept a caller-supplied blobPath or URL.

import { spawn } from 'node:child_process'
import { copyFile, chmod, mkdir, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ffmpegBinaryPath from 'ffmpeg-static'
import { get } from '@vercel/blob'
import type { SourceAsset } from './sourceAssetRegistry.js'

const defaults = { get }
type Dependencies = typeof defaults

const RUNTIME_FFMPEG_DIR = '/tmp/ffmpeg-bin'
const RUNTIME_FFMPEG_PATH = RUNTIME_FFMPEG_DIR + '/ffmpeg'

// Generous ceiling for "a normal Shorts source", not tuned to today's 1.3MB clip.
// Matches the Source Collector's own default ingest ceiling (SOURCE_COLLECTOR_MAX_BYTES).
const MAX_SOURCE_DOWNLOAD_BYTES = 200 * 1024 * 1024
const MAX_FRAME_SECOND_COUNT = 30
const MAX_CONTACT_SHEET_TILES = 48
const SINGLE_FRAME_TIMEOUT_MS = 15_000
const CONTACT_SHEET_TIMEOUT_MS = 60_000

// ffmpeg-static's own types/index.d.ts declares `export default: string | null`,
// but under this project's NodeNext + esModuleInterop resolution of a CJS
// package, tsc widens the imported binding to the module namespace instead of
// unwrapping the default export (verified at runtime with tsx: the actual
// value is the plain binary path string, confirmed against a local ffmpeg run).
const ffmpegPath = ffmpegBinaryPath as unknown as string | null

let ffmpegReadyPromise: Promise<string> | null = null

// Lambda's deployed code lives on a read-only filesystem, so the bundled
// binary is copied into /tmp once per (warm) container instead of being
// executed or chmod'ed in place. Mirrors how douyinResolver already handles
// @sparticuz/chromium's bundled binary.
function ensureFfmpegBinary(): Promise<string> {
  if (!ffmpegReadyPromise) {
    ffmpegReadyPromise = (async () => {
      if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary for this platform')
      if (!existsSync(RUNTIME_FFMPEG_PATH)) {
        await mkdir(RUNTIME_FFMPEG_DIR, { recursive: true })
        await copyFile(ffmpegPath, RUNTIME_FFMPEG_PATH)
        await chmod(RUNTIME_FFMPEG_PATH, 0o755)
      }
      return RUNTIME_FFMPEG_PATH
    })().catch((error) => {
      ffmpegReadyPromise = null
      throw error
    })
  }
  return ffmpegReadyPromise
}

function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(Object.assign(new Error('ffmpeg timed out'), { code: 'FFMPEG_TIMEOUT', status: 504 }))
    }, timeoutMs)
    proc.stdout.on('data', (d: Buffer) => out.push(d))
    proc.stderr.on('data', (d: Buffer) => err.push(d))
    proc.on('error', (error) => { clearTimeout(timer); reject(error) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        return reject(Object.assign(
          new Error('ffmpeg exited ' + code + ': ' + Buffer.concat(err).toString('utf8').slice(-1500)),
          { code: 'FFMPEG_FAILED', status: 500 }
        ))
      }
      resolve(Buffer.concat(out))
    })
  })
}

// Streams the registered private Blob to a unique /tmp file. `source.blobPath`
// only ever comes from a Registry record already validated by getSourceAsset().
async function downloadSourceToTmp(source: SourceAsset, deps: Dependencies): Promise<string> {
  const result = await deps.get(source.blobPath, { access: 'private' })
  if (!result) throw Object.assign(new Error('source blob not found'), { code: 'SOURCE_NOT_FOUND', status: 404 })
  const declaredBytes = Number(source.bytes || result.blob.size || 0)
  if (declaredBytes > MAX_SOURCE_DOWNLOAD_BYTES) {
    throw Object.assign(new Error('source media exceeds the frame-extraction size limit'), { code: 'SOURCE_TOO_LARGE', status: 413 })
  }
  const reader = (result.stream as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_SOURCE_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => {})
      throw Object.assign(new Error('source media exceeds the frame-extraction size limit'), { code: 'SOURCE_TOO_LARGE', status: 413 })
    }
    chunks.push(value)
  }
  const tmpPath = `/tmp/src-${randomUUID()}.mp4`
  await writeFile(tmpPath, Buffer.concat(chunks, bytes))
  return tmpPath
}

function clampSecond(second: number, duration: number): number {
  const rawCeiling = Number.isFinite(duration) && duration > 0 ? duration : 3600
  // Seeking to exactly the reported duration (or beyond) lands past the last
  // decodable frame for many containers and ffmpeg returns zero bytes - stay
  // just inside the clip so every clamped request still yields a real frame.
  const ceiling = Math.max(0, rawCeiling - 0.15)
  const value = Number.isFinite(second) ? second : 0
  return Math.max(0, Math.min(ceiling, value))
}

export function parseSecondsList(raw: unknown, duration: number): number[] {
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  const seconds = parts
    .map((part) => Number(String(part).trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => clampSecond(n, duration))
  return [...new Set(seconds)].sort((a, b) => a - b).slice(0, MAX_FRAME_SECOND_COUNT)
}

export async function extractSourceFrame(source: SourceAsset, second: number, deps: Dependencies = defaults): Promise<Buffer> {
  const bin = await ensureFfmpegBinary()
  const tmpPath = await downloadSourceToTmp(source, deps)
  try {
    const at = clampSecond(second, source.duration)
    return await runFfmpeg(bin, [
      '-ss', String(at), '-i', tmpPath,
      '-frames:v', '1', '-q:v', '3',
      '-vf', "scale='min(1024,iw)':-2",
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], SINGLE_FRAME_TIMEOUT_MS)
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}

export async function extractSourceFrames(source: SourceAsset, seconds: number[], deps: Dependencies = defaults): Promise<{ second: number; jpeg: Buffer }[]> {
  const bin = await ensureFfmpegBinary()
  const tmpPath = await downloadSourceToTmp(source, deps)
  try {
    const results: { second: number; jpeg: Buffer }[] = []
    for (const at of seconds) {
      const jpeg = await runFfmpeg(bin, [
        '-ss', String(at), '-i', tmpPath,
        '-frames:v', '1', '-q:v', '4',
        '-vf', "scale='min(480,iw)':-2",
        '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
      ], SINGLE_FRAME_TIMEOUT_MS)
      results.push({ second: at, jpeg })
    }
    return results
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}

export async function extractSourceContactSheet(source: SourceAsset, interval: number, deps: Dependencies = defaults): Promise<{ jpeg: Buffer; tileCount: number; cols: number; rows: number; interval: number }> {
  const bin = await ensureFfmpegBinary()
  const tmpPath = await downloadSourceToTmp(source, deps)
  try {
    const duration = Number(source.duration) > 0 ? Number(source.duration) : 30
    const step = Math.max(0.5, Number.isFinite(interval) && interval > 0 ? interval : 2)
    const tileCount = Math.max(1, Math.min(MAX_CONTACT_SHEET_TILES, Math.ceil(duration / step)))
    const cols = Math.max(1, Math.ceil(Math.sqrt(tileCount)))
    const rows = Math.max(1, Math.ceil(tileCount / cols))
    const jpeg = await runFfmpeg(bin, [
      '-i', tmpPath,
      '-vf', `fps=1/${step},scale=320:-2,tile=${cols}x${rows}`,
      '-q:v', '4', '-frames:v', '1',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], CONTACT_SHEET_TIMEOUT_MS)
    return { jpeg, tileCount, cols, rows, interval: step }
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}
