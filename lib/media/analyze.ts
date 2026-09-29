// ANALYZE: model-free, machine-readable signals about a source video (source-analysis/1).
// Deterministic for a given file: same bytes => same JSON. No natural-language prose is stored.
import { audioRmsPerSecond, contactSheet, detectBlack, detectFreeze, detectSilence, probe, sceneScores, type Interval } from './ffmpeg.js'

export const SOURCE_ANALYSIS_SCHEMA = 'source-analysis/1'

export type SecondSample = { t: number; visual: number; audioDb: number | null }
export type Highlight = { start: number; end: number; score: number }
export type SourceAnalysis = {
  schema: typeof SOURCE_ANALYSIS_SCHEMA
  sourceAssetId: string
  sha256: string | null
  media: { duration: number; width: number; height: number; fps: number | null; hasAudio: boolean; videoCodec: string | null; audioCodec: string | null; orientation: 'portrait' | 'landscape' | 'square' }
  scenes: Interval[]
  timeline: SecondSample[]
  ranges: { black: Interval[]; freeze: Interval[]; silent: Interval[] }
  audio: { silentRatio: number | null; intentionallySilent: boolean }
  highlights: Highlight[]
  usable: Interval[]
  analyzer: { name: 'ffmpeg-signals'; version: 1 }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000
const total = (xs: Interval[]) => xs.reduce((s, x) => s + Math.max(0, x.end - x.start), 0)

export function subtractIntervals(base: Interval[], holes: Interval[]): Interval[] {
  let out = base.map((b) => ({ ...b }))
  for (const h of [...holes].sort((a, b) => a.start - b.start)) {
    const next: Interval[] = []
    for (const b of out) {
      if (h.end <= b.start || h.start >= b.end) { next.push(b); continue }
      if (h.start > b.start) next.push({ start: b.start, end: h.start })
      if (h.end < b.end) next.push({ start: h.end, end: b.end })
    }
    out = next
  }
  return out.filter((x) => x.end - x.start > 0.05).map((x) => ({ start: r3(x.start), end: r3(x.end) }))
}

const percentileRank = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return (v: number) => (sorted.length <= 1 ? 0 : sorted.filter((x) => x < v).length / (sorted.length - 1))
}

export function computeHighlights(timeline: SecondSample[], windowSec = 2.5, max = 3): Highlight[] {
  if (!timeline.length) return []
  const vRank = percentileRank(timeline.map((s) => s.visual))
  const audio = timeline.map((s) => s.audioDb).filter((x): x is number => x !== null)
  const aRank = audio.length ? percentileRank(audio) : null
  const per = timeline.map((s) => (aRank && s.audioDb !== null ? 0.65 * vRank(s.visual) + 0.35 * aRank(s.audioDb) : vRank(s.visual)))
  const duration = timeline.length
  const w = Math.min(windowSec, duration)
  const cands: Highlight[] = []
  for (let start = 0; start + w <= duration + 1e-6; start += 0.5) {
    let sum = 0
    for (let i = Math.floor(start); i < Math.min(duration, Math.ceil(start + w)); i++) sum += per[i]
    cands.push({ start: r3(start), end: r3(start + w), score: r3(sum / Math.ceil(w)) })
  }
  const chosen: Highlight[] = []
  for (const c of cands.sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (chosen.length >= max) break
    if (chosen.every((x) => c.start >= x.end || c.end <= x.start)) chosen.push(c)
  }
  return chosen
}

export async function analyzeSourceFile(file: string, meta: { sourceAssetId: string; sha256?: string | null; contactSheetOut?: string }, opts: { contactSheet?: boolean } = {}): Promise<SourceAnalysis> {
  const info = await probe(file)
  if (!info.hasVideo || !info.duration || !info.width || !info.height) throw new Error('source file has no decodable video stream')
  const duration = info.duration

  const [scores, rms, black, freezeRaw, silent] = await Promise.all([
    sceneScores(file), audioRmsPerSecond(file), detectBlack(file), detectFreeze(file, { minDuration: 1 }), info.hasAudio ? detectSilence(file) : Promise.resolve([] as Interval[])
  ])

  const seconds = Math.max(1, Math.ceil(duration))
  const timeline: SecondSample[] = Array.from({ length: seconds }, (_, t) => {
    const inSec = scores.filter((s) => s.t >= t && s.t < t + 1)
    const visual = inSec.length ? inSec.reduce((a, s) => a + s.score, 0) / inSec.length : 0
    const a = rms?.find((x) => x.t === t)
    return { t, visual: r3(visual), audioDb: a && a.db !== null ? r3(a.db) : null }
  })

  // scene boundaries: strong frame-to-frame change, at least 0.5s apart
  const cuts: number[] = []
  for (const s of scores) if (s.score > 0.3 && s.t > 0.2 && s.t < duration - 0.2 && (!cuts.length || s.t - cuts[cuts.length - 1] >= 0.5)) cuts.push(r3(s.t))
  const bounds = [0, ...cuts, r3(duration)]
  const scenes = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1] })).filter((x) => x.end - x.start > 0.2)

  // A frozen span is only "dead" if the whole clip is not simply a static camera.
  const freezeCoverage = total(freezeRaw) / duration
  const freeze = freezeRaw.map((f) => ({ start: r3(f.start), end: r3(f.end) }))
  const holes = [...black, ...(freezeCoverage < 0.6 ? freeze.filter((f) => f.end - f.start >= 2) : [])]
  const usable = subtractIntervals([{ start: 0, end: r3(duration) }], holes)

  const silentRatio = info.hasAudio ? total(silent) / duration : null
  const analysis: SourceAnalysis = {
    schema: SOURCE_ANALYSIS_SCHEMA,
    sourceAssetId: meta.sourceAssetId, sha256: meta.sha256 ?? null,
    media: {
      duration: r3(duration), width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio, videoCodec: info.videoCodec, audioCodec: info.audioCodec,
      orientation: info.height > info.width ? 'portrait' : info.width > info.height ? 'landscape' : 'square'
    },
    scenes, timeline,
    ranges: { black: black.map((b) => ({ start: r3(b.start), end: r3(b.end) })), freeze, silent: silent.map((b) => ({ start: r3(b.start), end: r3(b.end) })) },
    audio: { silentRatio: silentRatio === null ? null : r3(silentRatio), intentionallySilent: !info.hasAudio || (silentRatio ?? 0) > 0.95 },
    highlights: computeHighlights(timeline), usable,
    analyzer: { name: 'ffmpeg-signals', version: 1 }
  }
  if (opts.contactSheet && meta.contactSheetOut) await contactSheet(file, meta.contactSheetOut, { cols: 6, rows: 4, tileWidth: 180, duration })
  return analysis
}
