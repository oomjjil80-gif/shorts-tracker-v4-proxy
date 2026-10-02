// AUTO_QC for a rendered Shorts MP4. Every check measures the actual output file.
// A check that cannot run is UNKNOWN (=> BLOCK); nothing here ever defaults to PASS.
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluateGate, runCheck, type CheckResult, type GateResult } from '../qc/gate.js'
import { sha256 } from '../jobs/blobs.js'
import { sourceRangeToOutputRanges } from '../tracker-core/renderManifest.js'
import { assFromPayload, CANVAS, FONTS_DIR, SAFE, type OverlayEvent } from './ass.js'
import type { SourceAnalysis } from './analyze.js'
import { contactSheet, detectBlack, detectFreeze, detectSilence, frameSignature, fullDecode, probe, runOk, signatureDistance, volumeStats, type Interval } from './ffmpeg.js'
import { extractRenderPlan, OUTPUT } from './render.js'

export const QC_THRESHOLDS = {
  minBytes: 20_000, durationToleranceSec: 0.25, maxBlackSec: 0.3, unexplainedFreezeSec: 1.5, minFrameLuma: 6,
  frameMatchMaxDist: 45, frameMismatchMargin: 15, deadAudioDb: -60, maxSilentExcess: 0.2, minOverlayDelta: 6
}

const pass = (evidence?: unknown) => ({ status: 'PASS' as const, evidence })
const fail = (evidence?: unknown) => ({ status: 'FAIL' as const, evidence })
const ok = (cond: boolean, evidence?: unknown) => (cond ? pass(evidence) : fail(evidence))
const overlapSec = (a: Interval, b: Interval) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

async function topLevelAtoms(file: string): Promise<Array<{ type: string; offset: number; size: number }>> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const atoms: Array<{ type: string; offset: number; size: number }> = []
    let pos = 0
    const head = Buffer.alloc(16)
    while (pos + 8 <= size && atoms.length < 64) {
      await fh.read(head, 0, 16, pos)
      let sz = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (sz === 1) sz = Number(head.readBigUInt64BE(8))
      if (sz === 0) sz = size - pos
      if (sz < 8) break
      atoms.push({ type, offset: pos, size: sz })
      pos += sz
    }
    return atoms
  } finally { await fh.close() }
}

async function grayFrame(file: string, t: number, w: number, h: number, vf?: string): Promise<Buffer> {
  const r = await runOk(['-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `${vf ? vf + ',' : ''}scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-'])
  if (r.stdout.length !== w * h) throw new Error(`frame at ${t}s could not be decoded`)
  return r.stdout
}

// Renders one overlay event alone on flat gray so its true pixel extent can be measured.
async function overlayMask(ass: string, workDir: string, t: number, tag: string): Promise<Buffer> {
  const assPath = join(workDir, `qc-${tag}.ass`)
  await writeFile(assPath, ass, 'utf8')
  const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  const r = await runOk(['-f', 'lavfi', '-i', `color=c=0x808080:s=${CANVAS.w}x${CANVAS.h}:r=30:d=${(t + 0.5).toFixed(2)}`, '-vf', `ass=filename='${esc(assPath)}':fontsdir='${esc(FONTS_DIR)}',format=gray`, '-ss', String(t), '-frames:v', '1', '-f', 'rawvideo', '-'])
  if (r.stdout.length !== CANVAS.w * CANVAS.h) throw new Error('overlay mask frame missing')
  return r.stdout
}

function bbox(mask: Buffer, w: number, h: number): { x0: number; y0: number; x1: number; y1: number; pixels: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, pixels = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.abs(mask[y * w + x] - 128) > 8) { pixels++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  return pixels ? { x0, y0, x1, y1, pixels } : null
}

// Isolates event k of a built ASS (same header/styles, only its own Dialogue line) and measures it on flat gray.
// Event order == Dialogue order (buildAss adds them together), so the index is the identity, not the text.
const MIN_TEXT_BOX_PX = 36
async function overlayFor(built: { ass: string; events: OverlayEvent[] }, k: number, total: number, workDir: string) {
  const ev = built.events[k]
  const t = Math.min(total - 0.05, (ev.start + ev.end) / 2)
  const lines = built.ass.split('\n')
  const dlg = lines.filter((l) => l.startsWith('Dialogue:'))
  const head = lines.filter((l) => !l.startsWith('Dialogue:'))
  const ass = [...head.slice(0, head.findIndex((l) => l.startsWith('Format: Layer')) + 1), dlg[k] ?? ''].join('\n')
  const mask = await overlayMask(ass, workDir, t, `${k}`)
  return { mask, box: bbox(mask, CANVAS.w, CANVAS.h), t }
}

export type RenderQcInput = {
  renderPath: string; expectedRenderHash: string; payload: any; sourceFile: string; analysis: SourceAnalysis
  render: { overlayEvents: OverlayEvent[]; assSha256: string | null }
  workDir: string; contactSheetOut?: string
}
export type RenderQcResult = { gate: GateResult; metrics: Record<string, unknown> }

export async function runRenderQc(i: RenderQcInput): Promise<RenderQcResult> {
  const T = QC_THRESHOLDS
  // overlay checks write scratch .ass files here; the caller's per-variant dir may not exist yet
  await mkdir(i.workDir, { recursive: true })
  const metrics: Record<string, unknown> = {}
  const plan = (() => { try { return extractRenderPlan(i.payload) } catch { return null } })()
  const total = plan?.total ?? Number(i.payload?.totalDuration)
  const to = { timeoutMs: 180_000 }
  let info: Awaited<ReturnType<typeof probe>> | null = null
  const getInfo = async () => (info ??= await probe(i.renderPath))
  const sourceSilent = i.analysis.audio.intentionallySilent

  const checks: Array<() => Promise<CheckResult>> = [
    () => runCheck('file.integrity', true, async () => {
      const bytes = (await stat(i.renderPath)).size
      const hash = sha256(await readFile(i.renderPath))
      metrics.bytes = bytes
      return ok(bytes >= T.minBytes && hash === i.expectedRenderHash, { bytes, minBytes: T.minBytes, hashMatches: hash === i.expectedRenderHash })
    }, to),
    () => runCheck('container.mp4_faststart', true, async () => {
      const atoms = await topLevelAtoms(i.renderPath)
      const ftyp = atoms.find((a) => a.type === 'ftyp'), moov = atoms.find((a) => a.type === 'moov'), mdat = atoms.find((a) => a.type === 'mdat')
      return ok(!!ftyp && ftyp.offset === 0 && !!moov && !!mdat && moov.offset < mdat.offset, { atoms: atoms.map((a) => a.type) })
    }, to),
    () => runCheck('video.format', true, async () => {
      const v = await getInfo()
      metrics.video = { codec: v.videoCodec, profile: v.profile, w: v.width, h: v.height, fps: v.fps, pixFmt: v.pixFmt }
      return ok(v.videoCodec === 'h264' && v.pixFmt === 'yuv420p' && v.width === OUTPUT.width && v.height === OUTPUT.height && v.sar === '1:1' && v.fps !== null && Math.abs(v.fps - OUTPUT.fps) < 0.1 && ['High', 'Main'].includes(v.profile ?? ''), metrics.video)
    }, to),
    () => runCheck('audio.format', true, async () => {
      const v = await getInfo()
      metrics.audio = { codec: v.audioCodec, hz: v.sampleRate, ch: v.channels }
      return ok(v.hasAudio && v.audioCodec === 'aac' && v.sampleRate === 44100 && v.channels === 2, metrics.audio)
    }, to),
    () => runCheck('decode.full', true, async () => {
      const d = await fullDecode(i.renderPath)
      metrics.decodedSeconds = d.decodedSeconds
      return ok(d.ok && d.decodedSeconds !== null && Math.abs(d.decodedSeconds - total) <= T.durationToleranceSec + 0.1, d)
    }, { timeoutMs: 300_000 }),
    () => runCheck('duration.matches_manifest', true, async () => {
      const v = await getInfo()
      metrics.duration = v.duration
      return ok(v.duration !== null && Number.isFinite(total) && Math.abs(v.duration - total) <= T.durationToleranceSec, { rendered: v.duration, manifest: total, tolerance: T.durationToleranceSec })
    }, to),
    () => runCheck('visual.no_black', true, async () => {
      const black = await detectBlack(i.renderPath)
      const sum = black.reduce((s, b) => s + (b.end - b.start), 0)
      return ok(sum <= T.maxBlackSec, { black, totalBlackSec: sum })
    }, to),
    () => runCheck('visual.no_unexplained_freeze', true, async () => {
      if (!plan) throw new Error('manifest not renderable')
      const frozen = await detectFreeze(i.renderPath, { minDuration: T.unexplainedFreezeSec })
      // freezes that already exist in the source (static camera) are not defects of the render
      const explained: Interval[] = i.analysis.ranges.freeze.flatMap((f) => sourceRangeToOutputRanges(plan.cuts.map((c) => ({ start: c.start, duration: c.duration, trimStart: c.trimStart, trimEnd: c.trimEnd })), f.start, f.end))
      const bad = frozen.filter((f) => overlapSec(f, f) > 0 && explained.reduce((s, e) => s + overlapSec(f, e), 0) < 0.9 * (f.end - f.start))
      return ok(bad.length === 0, { frozen, explainedBySource: explained, unexplained: bad })
    }, to),
    () => runCheck('visual.first_last_frame', true, async () => {
      const v = await getInfo()
      const dur = v.duration ?? total
      const luma = async (t: number) => { const g = await grayFrame(i.renderPath, t, 32, 56); return g.reduce((s, x) => s + x, 0) / g.length }
      const [a, b] = [await luma(0.05), await luma(Math.max(0, dur - 0.15))]
      return ok(a > T.minFrameLuma && b > T.minFrameLuma, { firstLuma: a, lastLuma: b, min: T.minFrameLuma })
    }, to),
    () => runCheck('audio.present_and_alive', true, async () => {
      const v = await getInfo()
      if (!v.hasAudio) return fail({ reason: 'no audio stream' })
      if (sourceSilent) return pass({ intentionallySilent: true, note: 'source has no audible audio; silent track by design' })
      const vol = await volumeStats(i.renderPath)
      const silent = await detectSilence(i.renderPath, { minDuration: 0.5 })
      const silentSec = silent.reduce((s, x) => s + (x.end - x.start), 0)
      const expectedSilent = plan ? i.analysis.ranges.silent.flatMap((r) => sourceRangeToOutputRanges(plan.cuts.map((c) => ({ start: c.start, duration: c.duration, trimStart: c.trimStart, trimEnd: c.trimEnd })), r.start, r.end)).reduce((s, x) => s + (x.end - x.start), 0) : 0
      const ratio = silentSec / Math.max(0.1, total), expectedRatio = expectedSilent / Math.max(0.1, total)
      return ok(vol.meanDb !== null && vol.meanDb > T.deadAudioDb && ratio <= expectedRatio + T.maxSilentExcess, { ...vol, silentRatio: ratio, expectedSilentRatio: expectedRatio })
    }, to),
    () => runCheck('audio.no_clipping', false, async () => {
      const vol = await volumeStats(i.renderPath)
      return vol.maxDb === null ? pass({ note: 'silent' }) : ok(vol.maxDb < -0.05, vol)
    }, to),
    () => runCheck('timeline.segment_order_and_trim', true, async () => {
      if (!plan) throw new Error('manifest not renderable')
      const n = plan.cuts.length
      const probeAt = plan.cuts.map((c) => Math.min(0.5, c.duration / 2))
      const outSig: Buffer[] = [], srcSig: Buffer[] = []
      for (let k = 0; k < n; k++) {
        outSig.push(await frameSignature(i.renderPath, plan.cuts[k].start + probeAt[k]))
        srcSig.push(await frameSignature(i.sourceFile, plan.cuts[k].trimStart + probeAt[k], { cover: true }))
      }
      const rows = outSig.map((o, k) => {
        const d = srcSig.map((s) => signatureDistance(o, s))
        const best = Math.min(...d.filter((_, j) => j !== k), Infinity)
        return { cut: k + 1, dist: Number(d[k].toFixed(1)), bestOther: Number.isFinite(best) ? Number(best.toFixed(1)) : null, ok: d[k] <= T.frameMatchMaxDist && !(best + T.frameMismatchMargin < d[k]) }
      })
      return ok(rows.every((r) => r.ok), rows)
    }, { timeoutMs: 240_000 }),
    () => runCheck('overlay.matches_manifest', true, async () => {
      const expected = assFromPayload({ ...i.payload, totalDuration: total })
      const key = (e: OverlayEvent) => `${e.kind}|${e.text}|${e.start.toFixed(2)}|${e.end.toFixed(2)}`
      const a = expected.events.map(key).sort(), b = (i.render.overlayEvents || []).map(key).sort()
      const assHash = expected.events.length ? sha256(expected.ass) : null
      return ok(JSON.stringify(a) === JSON.stringify(b) && assHash === i.render.assSha256, { expectedCount: a.length, renderedCount: b.length })
    }, to),
    () => runCheck('overlay.safe_area_no_clipping', true, async () => {
      const built = assFromPayload({ ...i.payload, totalDuration: total })
      if (!built.events.length) return pass({ overlays: 0 })
      const rows: unknown[] = []
      let allOk = true
      for (const [k, ev] of built.events.slice(0, 12).entries()) {
        const { box } = await overlayFor(built, k, total, i.workDir)
        const wisdom = i.payload?.editorialPlan?.profile === 'wisdom-v1'
        const xSafe = !!box && box.x0 >= CANVAS.w * SAFE.left && box.x1 <= CANVAS.w * (1 - SAFE.right)
        // Wisdom Screen DNA deliberately reserves 360px black bands for persistent headline/subtitles.
        // Validate those overlays against their owned band, not the generic Shorts content safe-area.
        const ySafe = !!box && (wisdom && ev.kind === 'headline'
          ? box.y0 >= 16 && box.y1 <= 352
          : wisdom && ev.kind === 'subtitle'
            ? box.y0 >= 1568 && box.y1 <= 1904
            : box.y0 >= CANVAS.h * SAFE.top && box.y1 <= CANVAS.h * SAFE.bottom)
        const okBox = xSafe && ySafe
        // text that fits the safe area but is tiny is unreadable on a phone: a single line must be at least this tall
        const tall = !!box && box.y1 - box.y0 >= MIN_TEXT_BOX_PX
        if (!okBox || !tall) allOk = false
        rows.push({ kind: ev.kind, text: ev.text.slice(0, 20), box, ok: okBox, tallEnough: tall })
      }
      return ok(allOk, rows)
    }, { timeoutMs: 240_000 }),
    // Two messages on screen at the same moment must not overlap (headline vs effect, effect vs subtitle, ...).
    () => runCheck('overlay.no_collision', true, async () => {
      const built = assFromPayload({ ...i.payload, totalDuration: total })
      const evs = built.events.slice(0, 12)
      const boxes = await Promise.all(evs.map((_, k) => overlayFor(built, k, total, i.workDir).then((r) => r.box)))
      const hits: unknown[] = []
      for (let x = 0; x < evs.length; x++) for (let y = x + 1; y < evs.length; y++) {
        if (Math.min(evs[x].end, evs[y].end) - Math.max(evs[x].start, evs[y].start) <= 0.05) continue
        const p = boxes[x], q = boxes[y]
        if (p && q && p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1) hits.push({ a: `${evs[x].kind}:${evs[x].text.slice(0, 10)}`, b: `${evs[y].kind}:${evs[y].text.slice(0, 10)}` })
      }
      return ok(hits.length === 0, { events: evs.length, collisions: hits })
    }, { timeoutMs: 240_000 }),
    // Every overlay (the headline included) must actually be drawn in the rendered file: the pixels that the isolated
    // overlay paints as bright text fill have to be bright in the output frame too.
    () => runCheck('overlay.visible_in_output', true, async () => {
      if (!plan) throw new Error('manifest not renderable')
      const built = assFromPayload({ ...i.payload, totalDuration: total })
      if (!built.events.length) return pass({ overlays: 0 })
      const rows: unknown[] = []
      for (const [k, ev] of built.events.slice(0, 8).entries()) {
        const { mask, t } = await overlayFor(built, k, total, i.workDir)
        const out = await grayFrame(i.renderPath, t, CANVAS.w, CANVAS.h)
        let fill = 0, lit = 0
        for (let p = 0; p < mask.length; p++) if (mask[p] >= 200) { fill++; if (out[p] >= 150) lit++ }
        if (!fill) throw new Error(`overlay "${ev.text}" has no measurable text fill`)
        rows.push({ kind: ev.kind, text: ev.text.slice(0, 16), t: Number(t.toFixed(2)), fillPixels: fill, litFraction: Number((lit / fill).toFixed(2)) })
      }
      return ok((rows as Array<{ litFraction: number }>).every((r) => r.litFraction >= 0.7), rows)
    }, { timeoutMs: 240_000 })
  ]
  // Full decode is the heaviest integrity check. Run it alone first so it cannot be
  // spuriously killed while competing with the many other ffmpeg QC processes.
  // All remaining independent checks may still run in parallel.
  const decodeIndex = 4
  const decodeResult = await checks[decodeIndex]()
  const gate = evaluateGate(await Promise.all(checks.map((check, index) => index === decodeIndex ? Promise.resolve(decodeResult) : check())))
  if (i.contactSheetOut) { try { await contactSheet(i.renderPath, i.contactSheetOut, { cols: 6, rows: 3, tileWidth: 160, duration: total }) } catch { /* optional artifact */ } }
  return { gate, metrics }
}
