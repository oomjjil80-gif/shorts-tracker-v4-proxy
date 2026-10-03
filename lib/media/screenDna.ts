// Shorts Screen DNA: the fixed 1080x1920 geometry (black headline band / visual window / black subtitle band) and the QC
// that proves a rendered file obeys it. Geometry is NEVER inferred from how bright the picture is: a dark visual is still
// a 1200px visual. PASS requires the execution contract (the filter that actually built the source, exact to 0px) AND the
// actual pixels (re-executing that filter on the recorded beat images must reproduce the source, and the render's visual
// window must reproduce the source's). Anything that cannot be shown is UNKNOWN (=> BLOCK), never PASS.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CheckResult } from '../qc/gate.js'
import { runOk } from './ffmpeg.js'
import { FONTS_DIR, type OverlayEvent } from './ass.js'

import { COMMON_SHORTS_SCREEN_DNA, SHORTS_SCREEN_DNA, screenDnaSegmentFilter, screenDnaSegmentArgv, screenDnaWindowFilter, screenDnaComposedFilter, bandOf, type Rect, type ScreenDna } from './screenDnaContract.js'
export { COMMON_SHORTS_SCREEN_DNA, SHORTS_SCREEN_DNA, screenDnaSegmentFilter, screenDnaSegmentArgv, screenDnaWindowFilter, screenDnaComposedFilter, bandOf, type Rect, type ScreenDna }

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

// Geometry an ASSET segment filter actually produces, read from the filter text itself (not from any declaration).
export function geometryFromSegmentFilter(vf: string): { canvas: { w: number; h: number }; center: Rect; top: Rect; bottom: Rect; fillsCenter: boolean } | null {
  // Fit form (no side crop): scale into the window, pad to the canvas centred inside the window. The window is fully
  // owned by the source picture (letter/pillarbox bars inside it are part of the source framing, not a band).
  const fit = /^scale=(\d+):(\d+):force_original_aspect_ratio=decrease:flags=lanczos,pad=(\d+):(\d+):\(ow-iw\)\/2:(\d+)\+\((\d+)-ih\)\/2:black$/.exec(vf)
  if (fit && fit[2] === fit[6]) {
    const [w, h, W, H, y] = [fit[1], fit[2], fit[3], fit[4], fit[5]].map(Number), x = Math.floor((W - w) / 2)
    return { canvas: { w: W, h: H }, center: { x, y, w, h }, top: { x: 0, y: 0, w: W, h: y }, bottom: { x: 0, y: y + h, w: W, h: H - (y + h) }, fillsCenter: true }
  }
  const scale = /(?:^|,)scale=(\d+):(\d+):force_original_aspect_ratio=increase(?:,|$|:)/.exec(vf)
  const crop = /(?:^|,)crop=(\d+):(\d+)(?:,|$)/.exec(vf)
  const zoom = /(?:^|,)zoompan=.*?:s=(\d+)x(\d+)/.exec(vf) // the z expression may itself contain commas (min(…,max))
  const pad = /(?:^|,)pad=(\d+):(\d+):(\d+):(\d+):black(?:,|$)/.exec(vf)
  if (!crop || !pad) return null
  const [cw, ch] = [Number(crop[1]), Number(crop[2])]
  const [W, H, x, y] = [Number(pad[1]), Number(pad[2]), Number(pad[3]), Number(pad[4])]
  const zw = zoom ? Number(zoom[1]) : cw, zh = zoom ? Number(zoom[2]) : ch
  // "increase" scale + crop to the same size = the picture covers the whole window (no letterbox inside the visual)
  // (a zoompan after the cover crop always outputs a full s=WxH picture, whatever the oversampled crop size)
  const fillsCenter = !!scale && Number(scale[1]) === cw && Number(scale[2]) === ch && (zoom ? true : zw === cw && zh === ch)
  return { canvas: { w: W, h: H }, center: { x, y, w: zw, h: zh }, top: { x: 0, y: 0, w: W, h: y }, bottom: { x: 0, y: y + zh, w: W, h: H - (y + zh) }, fillsCenter }
}

export function contractDiffs(g: ReturnType<typeof geometryFromSegmentFilter>, dna: ScreenDna = SHORTS_SCREEN_DNA): string[] {
  if (!g) return ['segmentFilter.unparsable']
  const d: string[] = []
  const eq = (name: string, a: any, b: any) => { for (const k of Object.keys(b)) if (a?.[k] !== b[k]) d.push(`${name}.${k}=${a?.[k]} (contract ${b[k]})`) }
  eq('canvas', g.canvas, dna.canvas); eq('top', g.top, dna.top); eq('center', g.center, dna.center); eq('bottom', g.bottom, dna.bottom)
  if (!g.fillsCenter) d.push('center.notFilled (scale/crop/zoompan do not cover the visual window)')
  return d
}

// The RENDER per-input video filter for the Screen DNA path keeps a 1080x1920 source pixel-for-pixel (no-op scale + pad).
export const RENDER_DNA_FILTER = /\[(\d+):v\]setpts=PTS-STARTPTS,scale=(\d+):(\d+):force_original_aspect_ratio=decrease:flags=lanczos,pad=(\d+):(\d+):\(ow-iw\)\/2:\(oh-ih\)\/2:black,setsar=1,fps=\d+,format=yuv420p\[v\d+\]/
export function renderPreservesGeometry(filterGraph: string, source: { width: number | null; height: number | null }, dna: ScreenDna = SHORTS_SCREEN_DNA): string[] {
  const lines = filterGraph.split(';').map((l) => l.trim()).filter((l) => /^\[\d+:v\]/.test(l))
  const d: string[] = []
  if (!lines.length) d.push('render.videoFilter.missing')
  for (const l of lines) {
    const m = RENDER_DNA_FILTER.exec(l)
    if (!m) { d.push(`render.videoFilter.notGeometryPreserving: ${l.slice(0, 120)}`); continue }
    if (+m[2] !== dna.canvas.w || +m[3] !== dna.canvas.h || +m[4] !== dna.canvas.w || +m[5] !== dna.canvas.h) d.push(`render.videoFilter.canvas ${m[2]}x${m[3]}/${m[4]}x${m[5]}`)
  }
  if (source.width !== dna.canvas.w || source.height !== dna.canvas.h) d.push(`render.source ${source.width}x${source.height} is not the ${dna.canvas.w}x${dna.canvas.h} canvas (scale would move the geometry)`)
  return d
}

// A RENDER per-input line for a raw source must be exactly: [optional embedded-picture crop] + the window filter.
const WINDOW_LINE = /^\[(\d+):v\]setpts=PTS-STARTPTS,(crop=\d+:\d+:\d+:\d+,)?(scale=\d+:\d+:force_original_aspect_ratio=(?:increase|decrease):flags=lanczos,(?:crop=\d+:\d+,)?pad=[^,]+:black),setsar=1,fps=(\d+),format=yuv420p\[v\d+\]$/
export function windowLineDiffs(line: string, dna: ScreenDna = SHORTS_SCREEN_DNA): string[] {
  const m = WINDOW_LINE.exec(line.trim())
  if (!m) return [`render.videoFilter.notCanonicalWindow: ${line.slice(0, 140)}`]
  // The contract filter (fit inside the visual window, no side crop) is canonical by definition.
  if (m[3] === screenDnaWindowFilter(dna)) return []
  const d = contractDiffs(geometryFromSegmentFilter(m[3]), dna)
  if (!d.length) d.push('render.videoFilter.window differs from the contract filter')
  return d
}
// The geometry part of a recorded line, re-executable on the source by itself (no labels / timestamps).
export const windowLineFilter = (line: string) => { const m = WINDOW_LINE.exec(line.trim()); return m ? `${m[2] ?? ''}${m[3]},setsar=1,format=yuv420p` : null }

// ---- execution receipts (recorded by ASSET / RENDER; verified by QC) ----
export type AssetGeometryReceipt = { schema: 'screen-dna-receipt/1'; stage: 'ASSET'; jobId: string; attempt: number; contract: ScreenDna; segmentFilter: string; segmentArgv: string[]; segments: Array<{ beatId: string; imageSha256: string; durationSec: number }>; outputSha256: string; outputRef: string }
export type RenderGeometryReceipt = { schema: 'screen-dna-receipt/1'; stage: 'RENDER'; jobId: string; attempt: number; contract: ScreenDna; composer?: 'asset' | 'render'; manifestHash: string; sourceSha256: string; sourceWidth: number | null; sourceHeight: number | null; filterGraphSha256: string; videoFilters: string[]; renderHash: string }
export const renderVideoFilters = (graph: string) => graph.split(';').map((l) => l.trim()).filter((l) => /^\[\d+:v\]/.test(l))
export const filterGraphSha256 = (graph: string) => sha(graph)

// ---- pixels ----
const W = SHORTS_SCREEN_DNA.canvas.w, H = SHORTS_SCREEN_DNA.canvas.h, FRAME = W * H, FPS = 30
function splitFrames(buf: Buffer): Buffer[] { const out: Buffer[] = []; for (let o = 0; o + FRAME <= buf.length; o += FRAME) out.push(buf.subarray(o, o + FRAME)); return out }
async function decodeGray(file: string, startSec: number, count: number, signal?: AbortSignal): Promise<Buffer[]> {
  const r = await runOk(['-ss', Math.max(0, startSec).toFixed(3), '-i', file, '-frames:v', String(count), '-vf', `scale=${W}:${H}:flags=neighbor,format=gray`, '-f', 'rawvideo', '-'], { signal, timeoutMs: 120_000 })
  return splitFrames(r.stdout)
}
// Re-execute the recorded segment filter on the recorded beat image (first `count` frames of that segment).
async function reconstructGray(imagePath: string, segmentFilter: string, count: number, signal?: AbortSignal): Promise<Buffer[]> {
  const r = await runOk(['-loop', '1', '-i', imagePath, '-vf', `${segmentFilter},format=gray`, '-frames:v', String(count), '-f', 'rawvideo', '-'], { signal, timeoutMs: 120_000 })
  return splitFrames(r.stdout)
}
// Mean absolute difference of a vs b shifted by (dx,dy) over rows [y0,y1) — the overlap only.
// mask (optional): pixels of `a` to ignore (text drawn over the picture is not picture).
function mad(a: Buffer, b: Buffer, y0: number, y1: number, dx = 0, dy = 0, stride = 1, mask?: Uint8Array): number {
  let s = 0, n = 0
  for (let y = Math.max(y0, y0 - dy, 0); y < Math.min(y1, y1 - dy, H); y++) {
    const ra = y * W, rb = (y + dy) * W
    for (let x = Math.max(0, -dx); x < Math.min(W, W - dx); x += stride) { if (mask?.[ra + x]) continue; s += Math.abs(a[ra + x] - b[rb + x + dx]); n++ }
  }
  return n ? s / n : mask ? 0 : Infinity
}
export const PIXEL = { maxMad: 4, maxBandMad: 3, maxEdgeRowMad: 20, searchPx: 2, ambiguity: 0.02 }
// Rows right at the band/visual boundaries carry the geometry: a 1-2px taller/shorter/shifted window changes exactly these
// rows from black to picture (or back), which a whole-frame average would dilute.
function edgeRowMad(a: Buffer, b: Buffer, dna: ScreenDna): { row: number; mad: number } {
  const rows = [dna.center.y - 2, dna.center.y - 1, dna.center.y, dna.center.y + 1, dna.center.y + dna.center.h - 2, dna.center.y + dna.center.h - 1, dna.center.y + dna.center.h, dna.center.y + dna.center.h + 1]
  let worst = { row: -1, mad: 0 }
  for (const r of rows) { const m = mad(a, b, r, r + 1); if (m > worst.mad) worst = { row: r, mad: Number(m.toFixed(3)) } }
  return worst
}
// Aligned (0,0) must be the best spatial match. A flat picture (all offsets equal) carries no geometry signal either way
// and is accepted only within PIXEL.ambiguity — a real 1px shift of any textured picture is far outside that.
function alignment(a: Buffer, b: Buffer, y0: number, y1: number, mask?: Uint8Array) {
  const at = (dx: number, dy: number) => mad(a, b, y0, y1, dx, dy, 2, mask)
  const zero = at(0, 0)
  let best = { dx: 0, dy: 0, mad: zero }
  for (let dy = -PIXEL.searchPx; dy <= PIXEL.searchPx; dy++) for (let dx = -PIXEL.searchPx; dx <= PIXEL.searchPx; dx++) {
    if (!dx && !dy) continue
    const m = at(dx, dy); if (m < best.mad) best = { dx, dy, mad: m }
  }
  const aligned = best.dx === 0 && best.dy === 0 || zero - best.mad <= PIXEL.ambiguity * Math.max(1, best.mad)
  return { aligned, mad: Number(zero.toFixed(3)), best: { dx: best.dx, dy: best.dy, mad: Number(best.mad.toFixed(3)) } }
}
function bestTemporal(src: Buffer[], ref: Buffer[]): { si: number; ri: number; mad: number } {
  let best = { si: -1, ri: -1, mad: Infinity }
  for (let si = 0; si < src.length; si++) for (let ri = 0; ri < ref.length; ri++) { const m = mad(src[si], ref[ri], 0, H, 0, 0, 4); if (m < best.mad) best = { si, ri, mad: m } }
  return best
}

export type ScreenDnaInput = {
  job: { id: string }
  // who executed the geometry: 'asset' = ASSET pre-composed the source (Wisdom); 'render' = RENDER placed a raw source
  // into the window (General / source-first). It only selects WHICH execution evidence is required; both need pixels.
  composer?: 'asset' | 'render'
  dna?: ScreenDna
  sourceFile: string; sourceSha256: string | null
  renderPath: string; renderBytesSha256: string; output: { width: number | null; height: number | null }
  variant: { manifestHash: string; renderHash: string; geometryReceipt?: RenderGeometryReceipt | null }
  manifest: { manifestHash?: string; identity?: Array<{ sha256?: string | null }>; payload: any } | null
  renderRun: { attempt: number } | null
  assetRun: { attempt: number; result: any } | null
  assetManifest: { items?: Array<{ beatId: string; durationSec: number; image?: { ref?: string; sha256?: string } }> } | null
  getBytes: (ref: string) => Promise<Buffer | null> // read-only: QC never writes or regenerates media
  overlays: { ass: string; events: OverlayEvent[] } | null
  signal?: AbortSignal
}
const st = (id: string, status: CheckResult['status'], evidence: unknown): CheckResult => ({ id, required: true, status, evidence })
const guard = async (id: string, f: () => Promise<CheckResult>): Promise<CheckResult> => { try { return await f() } catch (e: any) { return st(id, 'UNKNOWN', { error: String(e?.message || e) }) } }

// 1) execution contract: what the ASSET filter and the RENDER graph actually do, exact to 0px, bound to this job/attempt/hashes
export async function geometryContractCheck(i: ScreenDnaInput): Promise<CheckResult> {
  const id = 'screen_dna.geometry_contract', dna = i.dna ?? SHORTS_SCREEN_DNA
  return guard(id, async () => {
    if (i.composer === 'render') {
      const rr = i.variant.geometryReceipt ?? null
      if (!rr) return st(id, 'UNKNOWN', { reason: 'RENDER recorded no Screen DNA receipt: the window geometry has no execution evidence' })
      const bind: string[] = []
      if (rr.schema !== 'screen-dna-receipt/1' || rr.stage !== 'RENDER') bind.push('render.receipt.schema')
      if (rr.jobId !== i.job.id) bind.push(`render.receipt.jobId=${rr.jobId}`)
      if (!i.renderRun || rr.attempt !== i.renderRun.attempt) bind.push(`render.receipt.attempt=${rr.attempt} (run ${i.renderRun?.attempt})`)
      if (rr.renderHash !== i.variant.renderHash || rr.renderHash !== i.renderBytesSha256) bind.push('render.receipt.renderHash != rendered bytes')
      if (rr.manifestHash !== i.variant.manifestHash) bind.push('render.receipt.manifestHash != variant manifest')
      if (!i.sourceSha256 || rr.sourceSha256 !== i.sourceSha256) bind.push('render.receipt.sourceSha256 != resolved source')
      const lines = rr.videoFilters || []
      const diffs = lines.length ? lines.flatMap((l) => windowLineDiffs(l, dna)) : ['render.videoFilters.missing']
      return st(id, diffs.length || bind.length ? 'FAIL' : 'PASS', { contract: dna, composer: 'render', videoFilters: lines, diffs, binding: bind })
    }
    if (!i.assetRun) return st(id, 'UNKNOWN', { reason: 'no successful ASSET run: the source geometry has no execution evidence' })
    const ar: AssetGeometryReceipt | null = i.assetRun.result?.geometryReceipt ?? null
    const segmentFilter = ar ? ar.segmentFilter : screenDnaSegmentFilter(dna)
    const diffs = contractDiffs(geometryFromSegmentFilter(segmentFilter), dna)
    const bind: string[] = []
    if (ar) {
      if (ar.schema !== 'screen-dna-receipt/1' || ar.stage !== 'ASSET') bind.push('asset.receipt.schema')
      if (ar.jobId !== i.job.id) bind.push(`asset.receipt.jobId=${ar.jobId}`)
      if (ar.attempt !== i.assetRun.attempt) bind.push(`asset.receipt.attempt=${ar.attempt} (run ${i.assetRun.attempt})`)
      if (!i.sourceSha256 || ar.outputSha256 !== i.sourceSha256) bind.push('asset.receipt.outputSha256 != resolved source')
      if (!ar.segmentArgv?.includes(ar.segmentFilter)) bind.push('asset.receipt.argv does not carry the segment filter')
    }
    const rr = i.variant.geometryReceipt ?? null
    let renderDiffs: string[] = []
    if (rr) {
      if (rr.schema !== 'screen-dna-receipt/1' || rr.stage !== 'RENDER') bind.push('render.receipt.schema')
      if (rr.jobId !== i.job.id) bind.push(`render.receipt.jobId=${rr.jobId}`)
      if (!i.renderRun || rr.attempt !== i.renderRun.attempt) bind.push(`render.receipt.attempt=${rr.attempt} (run ${i.renderRun?.attempt})`)
      if (rr.renderHash !== i.variant.renderHash || rr.renderHash !== i.renderBytesSha256) bind.push('render.receipt.renderHash != rendered bytes')
      if (rr.manifestHash !== i.variant.manifestHash) bind.push('render.receipt.manifestHash != variant manifest')
      if (!i.sourceSha256 || rr.sourceSha256 !== i.sourceSha256) bind.push('render.receipt.sourceSha256 != resolved source')
      renderDiffs = renderPreservesGeometry(rr.videoFilters.join(';'), { width: rr.sourceWidth, height: rr.sourceHeight }, dna)
    }
    const evidence = { contract: dna, segmentFilter, segmentFilterSource: ar ? 'asset-receipt' : 'asset-code-path (legacy run without receipt; proven by screen_dna.source_geometry re-execution)', renderReceipt: !!rr, diffs, renderDiffs, binding: bind }
    return st(id, diffs.length || renderDiffs.length || bind.length ? 'FAIL' : 'PASS', evidence)
  })
}

// ---- composer=render: re-execute the recorded window line on the source and compare with the real output ----
async function glyphMaskAt(ass: string, t: number, signal?: AbortSignal): Promise<Uint8Array> {
  const work = await mkdtemp(join(tmpdir(), 'dna-mask-'))
  const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  try {
    const p = join(work, 'm.ass'); await writeFile(p, ass, 'utf8')
    const r = await runOk(['-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:r=${FPS}:d=${(t + 1).toFixed(3)}`, '-vf', `ass=filename='${esc(p)}':fontsdir='${esc(FONTS_DIR)}',format=gray`, '-ss', t.toFixed(4), '-frames:v', '1', '-f', 'rawvideo', '-'], { signal, timeoutMs: 120_000 })
    const f = splitFrames(r.stdout)[0]
    const m = new Uint8Array(FRAME)
    if (!f) return m
    // glyph pixels dilated by 6px: encoder ringing around white text is not picture leaking into the band
    const R = 6
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.abs(f[y * W + x] - 128) > 8) {
      for (let yy = Math.max(0, y - R); yy <= Math.min(H - 1, y + R); yy++) m.fill(1, yy * W + Math.max(0, x - R), yy * W + Math.min(W, x + R + 1))
    }
    return m
  } finally { await rm(work, { recursive: true, force: true }) }
}
function maskedMad(a: Buffer, b: Buffer, mask: Uint8Array, y0: number, y1: number): number {
  let s = 0, n = 0
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) { const k = y * W + x; if (mask[k]) continue; s += Math.abs(a[k] - b[k]); n++ }
  return n ? s / n : 0
}
type WindowRow = { t: number; sourceT: number; cut: number; aligned: boolean; mad: number; best: any; centerEdgeRow: { row: number; mad: number }; bandMad: number; bandEdgeRowMad: number }
const windowCache = new WeakMap<object, Promise<{ rows: WindowRow[] } | { unknown: string }>>()
function windowEvidence(i: ScreenDnaInput, cuts: Array<{ start: number; duration: number; trimStart: number }>) {
  if (!windowCache.has(i)) windowCache.set(i, (async () => {
    const dna = i.dna ?? SHORTS_SCREEN_DNA
    const lines = i.variant.geometryReceipt?.videoFilters || []
    if (!lines.length) return { unknown: 'RENDER receipt with the executed window filters is missing' }
    if (!cuts.length) return { unknown: 'render plan has no cuts' }
    const rows: WindowRow[] = []
    for (const [k, c] of cuts.entries()) {
      const vf = windowLineFilter(lines[k] ?? '')
      if (!vf) return { unknown: `cut ${k + 1}: recorded video filter is not re-executable` }
      const t = c.start + Math.min(0.5, c.duration / 2), srcT = c.trimStart + (t - c.start)
      const [out] = await decodeGray(i.renderPath, t, 1, i.signal)
      const r = await runOk(['-ss', Math.max(0, srcT - 2 / FPS).toFixed(3), '-i', i.sourceFile, '-frames:v', '5', '-vf', `${vf},format=gray`, '-f', 'rawvideo', '-'], { signal: i.signal, timeoutMs: 120_000 })
      const exp = splitFrames(r.stdout)
      if (!out || !exp.length) return { unknown: `frames at ${t.toFixed(2)}s could not be decoded` }
      // captions / effects drawn over the visual window are masked out of the picture comparison too
      const mask = i.overlays ? await glyphMaskAt(i.overlays.ass, t, i.signal) : new Uint8Array(FRAME)
      let best = { k: 0, m: Infinity }
      exp.forEach((f, n) => { const m = mad(out, f, dna.center.y, dna.center.y + dna.center.h, 0, 0, 4, mask); if (m < best.m) best = { k: n, m } })
      const e = exp[best.k]
      const a = alignment(out, e, dna.center.y, dna.center.y + dna.center.h, mask)
      let ce = { row: -1, mad: 0 }
      for (const row of [dna.center.y, dna.center.y + 1, dna.center.y + dna.center.h - 2, dna.center.y + dna.center.h - 1]) { const m = mad(out, e, row, row + 1, 0, 0, 1, mask); if (m > ce.mad) ce = { row, mad: Number(m.toFixed(3)) } }
      const bandMad = Math.max(maskedMad(out, e, mask, dna.top.y, dna.top.y + dna.top.h), maskedMad(out, e, mask, dna.bottom.y, dna.bottom.y + dna.bottom.h))
      const bandEdge = Math.max(...[dna.center.y - 2, dna.center.y - 1, dna.center.y + dna.center.h, dna.center.y + dna.center.h + 1].map((row) => maskedMad(out, e, mask, row, row + 1)))
      rows.push({ t: Number(t.toFixed(3)), sourceT: Number(srcT.toFixed(3)), cut: k + 1, ...a, centerEdgeRow: ce, bandMad: Number(bandMad.toFixed(3)), bandEdgeRowMad: Number(bandEdge.toFixed(3)) })
    }
    return { rows }
  })())
  return windowCache.get(i)!
}
async function windowGeometryCheck(i: ScreenDnaInput, cuts: Array<{ start: number; duration: number; trimStart: number }>): Promise<CheckResult> {
  const id = 'screen_dna.source_geometry'
  return guard(id, async () => {
    const ev = await windowEvidence(i, cuts)
    if ('unknown' in ev) return st(id, 'UNKNOWN', { reason: ev.unknown })
    const rows = ev.rows.map((r) => ({ cut: r.cut, t: r.t, centerEdgeRow: r.centerEdgeRow, bandMad: r.bandMad, bandEdgeRowMad: r.bandEdgeRowMad, ok: r.centerEdgeRow.mad <= PIXEL.maxEdgeRowMad && r.bandMad <= PIXEL.maxBandMad && r.bandEdgeRowMad <= PIXEL.maxEdgeRowMad }))
    return st(id, rows.every((r) => r.ok) ? 'PASS' : 'FAIL', { method: 're-executed RENDER window filter on the source vs output bands/boundary rows (text glyphs masked)', thresholds: PIXEL, rows })
  })
}
async function windowPreservesCheck(i: ScreenDnaInput, cuts: Array<{ start: number; duration: number; trimStart: number }>): Promise<CheckResult> {
  const id = 'screen_dna.render_preserves_source'
  return guard(id, async () => {
    const ev = await windowEvidence(i, cuts)
    if ('unknown' in ev) return st(id, 'UNKNOWN', { reason: ev.unknown })
    const rows = ev.rows.map((r) => ({ cut: r.cut, t: r.t, sourceT: r.sourceT, aligned: r.aligned, mad: r.mad, best: r.best, ok: r.aligned && r.mad <= PIXEL.maxMad }))
    return st(id, rows.every((r) => r.ok) ? 'PASS' : 'FAIL', { method: 'output visual window vs re-executed RENDER window on the source (0px spatial alignment)', window: (i.dna ?? SHORTS_SCREEN_DNA).center, thresholds: PIXEL, rows })
  })
}

// 2) the source really is that filter applied to the recorded beat images (re-executed here; compared pixel-aligned)
export async function sourceGeometryCheck(i: ScreenDnaInput): Promise<CheckResult> {
  const id = 'screen_dna.source_geometry', dna = i.dna ?? SHORTS_SCREEN_DNA
  return guard(id, async () => {
    const items = i.assetManifest?.items || []
    if (!items.length) return st(id, 'UNKNOWN', { reason: 'ASSET manifest with beat images is missing' })
    const segmentFilter: string = i.assetRun?.result?.geometryReceipt?.segmentFilter ?? screenDnaSegmentFilter(dna)
    const work = await mkdtemp(join(tmpdir(), 'dna-src-'))
    try {
      // drift: measured segment start minus the nominal one (encoder frame rounding accumulates across beats)
      const rows: any[] = []; let clock = 0, drift = 0
      for (const it of items) {
        const ref = it.image?.ref
        const img = ref ? await i.getBytes(ref) : null
        if (!img) return st(id, 'UNKNOWN', { reason: `beat ${it.beatId} image is not available`, ref: ref ?? null })
        if (it.image?.sha256 && sha(img) !== it.image.sha256) return st(id, 'FAIL', { reason: `beat ${it.beatId} image bytes differ from the ASSET record` })
        const p = join(work, `${it.beatId}.img`); await writeFile(p, img)
        // segment k starts at the sum of the previous segment durations; encoder rounding is absorbed by a ±8-frame window
        const ref0 = await reconstructGray(p, segmentFilter, 3, i.signal)
        const ws = Math.max(0, clock + drift - 8 / 30)
        const src = await decodeGray(i.sourceFile, ws, 17, i.signal)
        const t = bestTemporal(src, ref0)
        if (t.si < 0) return st(id, 'UNKNOWN', { reason: `source frames near ${clock.toFixed(2)}s could not be decoded` })
        drift = ws + (t.si - t.ri) / 30 - clock
        const a = alignment(src[t.si], ref0[t.ri], 0, H)
        const band = Math.max(mad(src[t.si], ref0[t.ri], dna.top.y, dna.top.y + dna.top.h), mad(src[t.si], ref0[t.ri], dna.bottom.y, dna.bottom.y + dna.bottom.h))
        const edge = edgeRowMad(src[t.si], ref0[t.ri], dna)
        const ok = a.aligned && a.mad <= PIXEL.maxMad && band <= PIXEL.maxBandMad && edge.mad <= PIXEL.maxEdgeRowMad
        rows.push({ beatId: it.beatId, at: Number(clock.toFixed(3)), ...a, bandMad: Number(band.toFixed(3)), edgeRow: edge, ok })
        clock += Number(it.durationSec)
      }
      return st(id, rows.every((r) => r.ok) ? 'PASS' : 'FAIL', { method: 're-executed ASSET segment filter vs source frames (0px spatial alignment)', thresholds: PIXEL, rows })
    } finally { await rm(work, { recursive: true, force: true }) }
  })
}

// 3) the render keeps the source's visual window untouched (no crop/scale/source substitution)
export async function renderPreservesSourceCheck(i: ScreenDnaInput, cuts: Array<{ start: number; duration: number; trimStart: number }>): Promise<CheckResult> {
  const id = 'screen_dna.render_preserves_source', dna = i.dna ?? SHORTS_SCREEN_DNA
  return guard(id, async () => {
    const items = i.assetManifest?.items || []
    let clock = 0
    const samples = items.length ? items.map((it) => { const t = clock + Math.min(0.5, Number(it.durationSec) / 2); clock += Number(it.durationSec); return t }) : cuts.map((c) => c.start + Math.min(0.5, c.duration / 2))
    if (!samples.length) return st(id, 'UNKNOWN', { reason: 'no timeline to sample' })
    const y0 = dna.center.y, y1 = dna.center.y + dna.center.h
    const rows: any[] = []
    for (const t of samples) {
      const cut = cuts.find((c) => t >= c.start && t < c.start + c.duration) ?? cuts[cuts.length - 1]
      if (!cut) return st(id, 'UNKNOWN', { reason: 'render plan has no cuts' })
      const srcT = cut.trimStart + (t - cut.start)
      const [out] = await decodeGray(i.renderPath, t, 1, i.signal)
      const src = await decodeGray(i.sourceFile, srcT - 2 / 30, 5, i.signal)
      if (!out || !src.length) return st(id, 'UNKNOWN', { reason: `frames at ${t.toFixed(2)}s could not be decoded` })
      // captions drawn over the visual window are not picture: mask their glyphs out of the comparison
      const mask = i.overlays ? await glyphMaskAt(i.overlays.ass, t, i.signal) : undefined
      let best = { k: -1, m: Infinity }
      src.forEach((f, k) => { const m = mad(out, f, y0, y1, 0, 0, 4, mask); if (m < best.m) best = { k, m } })
      const a = alignment(out, src[best.k], y0, y1, mask)
      rows.push({ t: Number(t.toFixed(3)), sourceT: Number(srcT.toFixed(3)), ...a, ok: a.aligned && a.mad <= PIXEL.maxMad })
    }
    return st(id, rows.every((r) => r.ok) ? 'PASS' : 'FAIL', { method: 'output visual window vs source visual window (0px spatial alignment)', window: dna.center, thresholds: PIXEL, rows })
  })
}

// 4) every text event, every frame where it can change: glyph pixels stay inside their own band
const TIME_VARYING = /\\(t\(|move\(|fad\(|fade\(|k\d|K\d|kf\d|ko\d)/
export async function textBandsCheck(i: ScreenDnaInput): Promise<CheckResult> {
  const id = 'screen_dna.text_bands', dna = i.dna ?? SHORTS_SCREEN_DNA
  return guard(id, async () => {
    if (!i.overlays) return st(id, 'UNKNOWN', { reason: 'overlay script unavailable' })
    const { ass, events } = i.overlays
    const lines = ass.split('\n'), dlg = lines.filter((l) => l.startsWith('Dialogue:')), head = lines.filter((l) => !l.startsWith('Dialogue:'))
    const header = head.slice(0, head.findIndex((l) => l.startsWith('Format: Layer')) + 1)
    if (dlg.length !== events.length) return st(id, 'UNKNOWN', { reason: `overlay events (${events.length}) and dialogue lines (${dlg.length}) differ` })
    const work = await mkdtemp(join(tmpdir(), 'dna-txt-'))
    const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
    try {
      const rows: any[] = []
      for (const [k, ev] of events.entries()) {
        // an event laid out in its own zone (caption / effect inside the visual window) is checked against that zone
        const band = ev.zone ? [ev.zone] : ev.kind === 'headline' ? [dna.top] : ev.kind === 'subtitle' ? [dna.bottom] : [dna.top, dna.bottom]
        const varying = TIME_VARYING.test(dlg[k])
        const p = join(work, `e${k}.ass`); await writeFile(p, [...header, dlg[k]].join('\n'), 'utf8')
        // the output is a 30fps grid: the event is on screen in frames i with start <= i/30 < end (ASS centisecond times)
        const s0 = Math.round(ev.start * 100) / 100, e0 = Math.round(ev.end * 100) / 100
        const first = Math.ceil(s0 * FPS - 1e-6), last = Math.ceil(e0 * FPS - 1e-6) - 1
        const pick = last < first ? [] : varying ? Array.from({ length: last - first + 1 }, (_, n) => first + n) : [Math.floor((first + last) / 2)]
        let frames: Buffer[] = []
        if (pick.length) {
          const r = await runOk(['-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:r=${FPS}:d=${((last + 2) / FPS).toFixed(3)}`, '-vf', `ass=filename='${esc(p)}':fontsdir='${esc(FONTS_DIR)}',format=gray`, '-ss', ((pick[0] - 0.25) / FPS).toFixed(4), '-frames:v', String(pick.length), '-f', 'rawvideo', '-'], { signal: i.signal, timeoutMs: 120_000 })
          frames = splitFrames(r.stdout)
        }
        const from = pick.length ? pick[0] / FPS : ev.start
        let y0 = H, y1 = -1, x0 = W, x1 = -1, drawn = 0, bad: number[] = []
        frames.forEach((f, n) => {
          let fy0 = H, fy1 = -1
          for (let y = 0; y < H; y++) { const row = y * W; for (let x = 0; x < W; x++) if (Math.abs(f[row + x] - 128) > 8) { if (y < fy0) fy0 = y; if (y > fy1) fy1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x } }
          if (fy1 < 0) return
          drawn++; y0 = Math.min(y0, fy0); y1 = Math.max(y1, fy1)
          if (!band.some((b) => fy0 >= b.y && fy1 <= b.y + b.h - 1)) bad.push(n)
        })
        const status = !frames.length || !drawn ? 'UNKNOWN' : bad.length ? 'FAIL' : 'PASS'
        rows.push({ k, kind: ev.kind, text: ev.text.slice(0, 20), start: ev.start, end: ev.end, framesChecked: frames.length, timeVarying: varying, glyph: drawn ? { x0, x1, y0, y1 } : null, band: band.map((b) => [b.y, b.y + b.h - 1]), badFrames: bad.slice(0, 10).map((n) => Number((from + n / FPS).toFixed(3))), status })
      }
      const status = rows.some((r) => r.status === 'FAIL') ? 'FAIL' : rows.some((r) => r.status === 'UNKNOWN') ? 'UNKNOWN' : 'PASS'
      return st(id, status, { method: 'isolated glyph mask per event (all events; every frame when the event animates)', events: rows.length, failed: rows.filter((r) => r.status !== 'PASS'), rows: rows.map(({ k, kind, glyph, status }) => ({ k, kind, glyph, status })) })
    } finally { await rm(work, { recursive: true, force: true }) }
  })
}

// 4b) the format of the drawn text: headline = exactly 2 lines (line 1 white, line 2 yellow), each caption <= 2 lines.
// Measured on each event's own rendered glyphs (colour), not on the manifest text.
export async function textLinesCheck(i: ScreenDnaInput): Promise<CheckResult> {
  const id = 'screen_dna.text_lines'
  return guard(id, async () => {
    if (!i.overlays) return st(id, 'UNKNOWN', { reason: 'overlay script unavailable' })
    const { ass, events } = i.overlays
    const lines = ass.split('\n'), dlg = lines.filter((l) => l.startsWith('Dialogue:')), head = lines.filter((l) => !l.startsWith('Dialogue:'))
    const header = head.slice(0, head.findIndex((l) => l.startsWith('Format: Layer')) + 1)
    if (dlg.length !== events.length) return st(id, 'UNKNOWN', { reason: `overlay events (${events.length}) and dialogue lines (${dlg.length}) differ` })
    // judges the FORMAT of what is drawn; whether a headline exists at all is content.headline_present (content gate)
    const work = await mkdtemp(join(tmpdir(), 'dna-lines-'))
    const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
    try {
      const rows: any[] = []
      for (const [k, ev] of events.entries()) {
        if (ev.kind !== 'headline' && ev.kind !== 'subtitle') continue
        const p = join(work, `l${k}.ass`); await writeFile(p, [...header, dlg[k]].join('\n'), 'utf8')
        const first = Math.ceil(Math.round(ev.start * 100) / 100 * FPS - 1e-6), last = Math.ceil(Math.round(ev.end * 100) / 100 * FPS - 1e-6) - 1
        if (last < first) { rows.push({ k, kind: ev.kind, status: 'UNKNOWN', reason: 'never on a frame' }); continue }
        const n = Math.floor((first + last) / 2)
        const r = await runOk(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}:d=${((n + 2) / FPS).toFixed(3)}`, '-vf', `ass=filename='${esc(p)}':fontsdir='${esc(FONTS_DIR)}',format=rgb24`, '-ss', ((n - 0.25) / FPS).toFixed(4), '-frames:v', '1', '-f', 'rawvideo', '-'], { signal: i.signal, timeoutMs: 120_000 })
        const px = r.stdout
        if (px.length < FRAME * 3) { rows.push({ k, kind: ev.kind, status: 'UNKNOWN', reason: 'frame not rendered' }); continue }
        // ink rows (any glyph pixel), split into lines at blank-row gaps; colour per line from its bright pixels
        const ink: number[] = [], white: number[] = [], yellow: number[] = []
        for (let y = 0; y < H; y++) { let c = 0, wv = 0, yv = 0; for (let x = 0; x < W; x++) { const o = (y * W + x) * 3, R = px[o], G = px[o + 1], B = px[o + 2]; if (R + G + B > 150) { c++; if (R > 200 && G > 200 && B > 200) wv++; else if (R > 200 && G > 150 && B < 90) yv++ } } ink.push(c); white.push(wv); yellow.push(yv) }
        const bands: Array<{ y0: number; y1: number; white: number; yellow: number }> = []
        for (let y = 0; y < H; y++) if (ink[y]) { const b = bands[bands.length - 1]; if (b && y - b.y1 <= 3) { b.y1 = y; b.white += white[y]; b.yellow += yellow[y] } else bands.push({ y0: y, y1: y, white: white[y], yellow: yellow[y] }) }
        const colour = (b: { white: number; yellow: number }) => (b.white > 2 * b.yellow ? 'white' : b.yellow > 2 * b.white ? 'yellow' : 'mixed')
        const ok = ev.kind === 'headline' ? bands.length === 2 && colour(bands[0]) === 'white' && colour(bands[1]) === 'yellow' : bands.length >= 1 && bands.length <= 2
        rows.push({ k, kind: ev.kind, text: ev.text.slice(0, 24), lines: bands.length, colours: bands.map(colour), status: ok ? 'PASS' : 'FAIL' })
      }
      const status = rows.some((r) => r.status === 'FAIL') ? 'FAIL' : rows.some((r) => r.status === 'UNKNOWN') ? 'UNKNOWN' : 'PASS'
      return st(id, status, { rule: 'headline exactly 2 lines (white, yellow); captions <= 2 lines', headlineDrawn: events.some((e) => e.kind === 'headline'), rows })
    } finally { await rm(work, { recursive: true, force: true }) }
  })
}

// 5) the file QC looked at is the one the receipts and manifest name, at the contract canvas
export async function outputIdentityCheck(i: ScreenDnaInput): Promise<CheckResult> {
  const id = 'screen_dna.output_identity', dna = i.dna ?? SHORTS_SCREEN_DNA
  return guard(id, async () => {
    if (!i.manifest || !i.sourceSha256) return st(id, 'UNKNOWN', { reason: 'manifest or resolved source identity missing' })
    const p: string[] = []
    if (i.output.width !== dna.canvas.w || i.output.height !== dna.canvas.h) p.push(`output ${i.output.width}x${i.output.height} != ${dna.canvas.w}x${dna.canvas.h}`)
    if (i.renderBytesSha256 !== i.variant.renderHash) p.push('render bytes != variant renderHash')
    if (i.manifest.manifestHash !== i.variant.manifestHash) p.push('manifest != variant manifestHash')
    const ids = (i.manifest.identity || []).map((x) => x?.sha256)
    if (!ids.length || ids.some((s) => s !== i.sourceSha256)) p.push('manifest source identity != resolved source')
    const assetSource = i.assetRun?.result?.source?.sha256
    if (i.assetRun && assetSource !== i.sourceSha256) p.push('latest ASSET source != resolved source pointer')
    return st(id, p.length ? 'FAIL' : 'PASS', { canvas: i.output, renderHash: i.variant.renderHash, manifestHash: i.variant.manifestHash, sourceSha256: i.sourceSha256, problems: p })
  })
}

export async function runScreenDnaQc(i: ScreenDnaInput, cuts: Array<{ start: number; duration: number; trimStart: number }>): Promise<CheckResult[]> {
  const render = i.composer === 'render'
  const checks = [
    await outputIdentityCheck(i),
    await geometryContractCheck(i),
    render ? await windowGeometryCheck(i, cuts) : await sourceGeometryCheck(i),
    render ? await windowPreservesCheck(i, cuts) : await renderPreservesSourceCheck(i, cuts),
    await textBandsCheck(i),
    await textLinesCheck(i)
  ]
  const status = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.every((c) => c.status === 'PASS') ? 'PASS' : 'UNKNOWN'
  // Aggregate kept under the historical id; it is derived ONLY from the checks above (no pixel-brightness framing).
  return [...checks, st('wisdom.screen_dna_layout', status, { method: 'screen-dna-contract/1', parts: checks.map((c) => ({ id: c.id, status: c.status })) })]
}
