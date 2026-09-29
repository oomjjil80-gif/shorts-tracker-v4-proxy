// PLAN: turns a SourceAnalysis into 1..3 genuinely different edit plans (job-plan/1 variantPlan bodies).
// Pure + deterministic. No captions are invented here: text only comes from a model (see aiPlanner) or the user.
import type { Highlight, SourceAnalysis } from './analyze.js'
import type { Interval } from './ffmpeg.js'
import { subtractIntervals } from './analyze.js'

export type Beat = { label: string; trimStart: number; trimEnd: number }
export type VariantSpec = {
  id: string; label: string; rationale: string; beats: Beat[]
  headline?: string; events?: Array<{ start: number; end: number; text: string }>
  effectCaptions?: Array<Record<string, unknown>>; callouts?: Array<Record<string, unknown>>
}

export const PLAN_LIMITS = { maxOutputSeconds: 58, minBeatSeconds: 0.8, maxBeats: 12, hookSeconds: 2.5, idleTrimSeconds: 8 }
const r2 = (n: number) => Math.round(n * 100) / 100
const len = (b: { trimStart: number; trimEnd: number }) => b.trimEnd - b.trimStart
export const totalSeconds = (beats: Beat[]) => r2(beats.reduce((s, b) => s + len(b), 0))

// Seconds whose visual+audio energy is well below the clip's typical level are "idle" (dead air).
function idleSeconds(a: SourceAnalysis): Set<number> {
  const vis = a.timeline.map((s) => s.visual).sort((x, y) => x - y)
  const p75 = vis[Math.floor(vis.length * 0.75)] ?? 0
  const threshold = Math.max(0.0015, 0.35 * p75)
  const idle = new Set<number>()
  for (const s of a.timeline) if (s.visual < threshold && (s.audioDb === null || s.audioDb < -45 || a.audio.intentionallySilent)) idle.add(s.t)
  return idle
}

// Chronological beats: usable ranges, split at scene cuts, dead air trimmed, tiny pieces merged.
export function chronologicalBeats(a: SourceAnalysis): Beat[] {
  const idle = idleSeconds(a)
  const idleRuns: Interval[] = []
  let run: number | null = null
  for (let t = 0; t <= a.timeline.length; t++) {
    if (idle.has(t) && run === null) run = t
    if (!idle.has(t) && run !== null) { if (t - run >= 2) idleRuns.push({ start: run + 0.5, end: t - 0.5 }); run = null }
  }
  const idleTotal = idleRuns.reduce((s, r) => s + (r.end - r.start), 0)
  // If most of the clip is uniformly quiet (static camera), keep it: trimming everything would destroy it.
  const holes = idleTotal < 0.6 * a.media.duration ? idleRuns : []
  let ranges = subtractIntervals(a.usable, holes)

  const cutAt = a.scenes.map((s) => s.start).filter((t) => t > 0)
  const beats: Beat[] = []
  for (const r of ranges) {
    const inner = cutAt.filter((t) => t > r.start + 0.05 && t < r.end - 0.05)
    const edges = [r.start, ...inner, r.end]
    for (let i = 0; i < edges.length - 1; i++) beats.push({ label: '', trimStart: r2(edges[i]), trimEnd: r2(edges[i + 1]) })
  }
  // merge beats shorter than the minimum into a neighbour that is contiguous, else drop
  const merged: Beat[] = []
  for (const b of beats) {
    const prev = merged[merged.length - 1]
    if (len(b) < PLAN_LIMITS.minBeatSeconds && prev && Math.abs(prev.trimEnd - b.trimStart) < 0.06) prev.trimEnd = b.trimEnd
    else if (len(b) >= PLAN_LIMITS.minBeatSeconds || merged.length === 0) merged.push({ ...b })
  }
  // adjacent contiguous beats are one continuous shot: fuse them back so cuts only happen where meaning changes
  const fused: Beat[] = []
  for (const b of merged) {
    const prev = fused[fused.length - 1]
    if (prev && Math.abs(prev.trimEnd - b.trimStart) < 0.06 && len(prev) + len(b) <= PLAN_LIMITS.idleTrimSeconds * 2) prev.trimEnd = b.trimEnd
    else fused.push({ ...b })
  }
  return fused.map((b, i) => ({ ...b, label: `beat ${i + 1}` }))
}

function fitToLimit(beats: Beat[], a: SourceAnalysis): Beat[] {
  let out = beats
  const score = (b: Beat) => {
    const secs = a.timeline.filter((s) => s.t + 1 > b.trimStart && s.t < b.trimEnd)
    return secs.reduce((x, s) => x + s.visual, 0) / Math.max(1, secs.length)
  }
  while (totalSeconds(out) > PLAN_LIMITS.maxOutputSeconds && out.length > 1) {
    const worst = out.map((b, i) => ({ i, s: score(b) / Math.max(0.5, len(b)) })).sort((x, y) => x.s - y.s)[0].i
    out = out.filter((_, i) => i !== worst)
  }
  if (totalSeconds(out) > PLAN_LIMITS.maxOutputSeconds) {
    const last = out[out.length - 1]
    last.trimEnd = r2(last.trimEnd - (totalSeconds(out) - PLAN_LIMITS.maxOutputSeconds))
  }
  return out.slice(0, PLAN_LIMITS.maxBeats)
}

const covered = (beats: Beat[]) => { const s = new Set<number>(); for (const b of beats) for (let t = Math.floor(b.trimStart); t < Math.ceil(b.trimEnd); t++) s.add(t); return s }

// 0 = same edit, 1 = nothing in common. Order and length count, not just coverage.
export function variantDistance(x: Beat[], y: Beat[]): number {
  const A = covered(x), B = covered(y)
  const inter = [...A].filter((t) => B.has(t)).length, union = new Set([...A, ...B]).size || 1
  const coverage = 1 - inter / union
  const first = Math.abs(x[0].trimStart - y[0].trimStart) > 3 ? 0.35 : 0
  const sx = totalSeconds(x), sy = totalSeconds(y)
  const lengthDiff = Math.abs(sx - sy) / Math.max(sx, sy, 1)
  return Math.min(1, coverage * 0.6 + first + lengthDiff * 0.6)
}

function hookWindow(a: SourceAnalysis, beats: Beat[]): Highlight | null {
  const h = a.highlights.find((x) => beats.some((b) => x.start >= b.trimStart - 0.01 && x.end <= b.trimEnd + 0.01))
  return h ?? null
}

export function planVariants(a: SourceAnalysis): VariantSpec[] {
  const base = fitToLimit(chronologicalBeats(a), a)
  if (!base.length) throw new Error('no usable source ranges to plan from')
  const variants: VariantSpec[] = []
  const hook = hookWindow(a, base)
  const hookAlreadyOpens = !hook || hook.start < base[0].trimStart + 4

  if (!hookAlreadyOpens && hook) {
    const hookBeat: Beat = { label: 'hook', trimStart: r2(hook.start), trimEnd: r2(Math.min(hook.end, hook.start + PLAN_LIMITS.hookSeconds)) }
    const withHook = fitToLimit([hookBeat, ...base.map((b) => ({ ...b }))], a)
    variants.push({ id: 'v1', label: '추천 · 하이라이트 먼저', rationale: 'strongest moment first, then the story in original order', beats: withHook })
    variants.push({ id: 'v2', label: '원본 순서', rationale: 'original chronology, dead time removed', beats: base })
  } else {
    variants.push({ id: 'v1', label: '추천 · 원본 순서', rationale: 'opens on the action; dead time removed', beats: base })
  }

  // highlights-only cut: only when it is a meaningfully different, shorter edit
  const top = [...a.highlights].sort((x, y) => x.start - y.start)
  if (a.media.duration > 15 && top.length >= 2) {
    const beats: Beat[] = top.map((h, i) => ({ label: `highlight ${i + 1}`, trimStart: r2(h.start), trimEnd: r2(h.end) }))
    if (beats.every((b) => len(b) >= PLAN_LIMITS.minBeatSeconds)) variants.push({ id: `v${variants.length + 1}`, label: '핵심만 압축', rationale: 'only the top-scoring moments, compressed', beats })
  }

  // keep only variants that differ enough from every already accepted one
  const accepted: VariantSpec[] = []
  for (const v of variants) if (accepted.every((x) => variantDistance(x.beats, v.beats) >= 0.15)) accepted.push(v)
  return accepted.slice(0, 3).map((v, i) => ({ ...v, id: `v${i + 1}` }))
}

// Strict validation of any plan (heuristic or model-made) against the analyzed source.
export function validateVariant(v: VariantSpec, a: SourceAnalysis): string[] {
  const errors: string[] = []
  if (!Array.isArray(v.beats) || !v.beats.length) return ['no beats']
  if (v.beats.length > PLAN_LIMITS.maxBeats) errors.push(`too many beats (${v.beats.length})`)
  v.beats.forEach((b, i) => {
    if (!Number.isFinite(b.trimStart) || !Number.isFinite(b.trimEnd)) errors.push(`beat ${i + 1}: non-numeric trim`)
    else {
      if (b.trimStart < 0 || b.trimEnd > a.media.duration + 0.05) errors.push(`beat ${i + 1}: outside source (0..${a.media.duration})`)
      if (b.trimEnd - b.trimStart < PLAN_LIMITS.minBeatSeconds - 1e-6) errors.push(`beat ${i + 1}: shorter than ${PLAN_LIMITS.minBeatSeconds}s`)
      for (const bl of a.ranges.black) if (b.trimStart < bl.end && b.trimEnd > bl.start && Math.min(b.trimEnd, bl.end) - Math.max(b.trimStart, bl.start) > 0.3) errors.push(`beat ${i + 1}: covers a black span`)
    }
  })
  if (totalSeconds(v.beats) > PLAN_LIMITS.maxOutputSeconds + 0.01) errors.push(`output ${totalSeconds(v.beats)}s exceeds ${PLAN_LIMITS.maxOutputSeconds}s`)
  for (const e of v.events || []) if (!e?.text || String(e.text).length > 40 || !(e.end > e.start)) errors.push('invalid event')
  if (v.headline && String(v.headline).length > 40) errors.push('headline too long')
  return errors
}

// job-plan/1 body for a variant (source-time text events are declared as such; the compiler converts them).
export function toJobPlan(sourceAssetId: string, v: VariantSpec) {
  return {
    schema: 'job-plan/1' as const, profile: 'source_shorts' as const, sourceAssetId,
    variantPlan: {
      profile: v.id,
      beats: v.beats.map((b) => ({ label: b.label, trimStart: b.trimStart, trimEnd: b.trimEnd })),
      ...(v.headline ? { headline: v.headline } : {}),
      ...(v.events?.length ? { events: v.events, plansTimeDomain: 'source' as const } : {}),
      ...(v.effectCaptions?.length ? { effectCaptions: v.effectCaptions, timeDomain: 'source' as const } : {}),
      ...(v.callouts?.length ? { callouts: v.callouts, plansTimeDomain: 'source' as const } : {})
    }
  }
}
