// PLAN: turns a SourceAnalysis (+ an optional validated StoryAnalysis) into 1..3 genuinely different edit plans
// (job-plan/1 variantPlan bodies). Pure + deterministic.
//
// Story rules:
//  - Chronological causal order is the default and the recommendation. A "preview first" hook is only ever offered
//    as an ALTERNATIVE, and only when the semantic story says it is safe (never because visual activity is high).
//  - With a story: the edit starts at causalStart, ends at recommendedEnd (just after the payoff), and drops every
//    excluded range (intro confusion, repeats, dead air, product demo, foreign text, post-payoff, unrelated).
//  - Without a story: one chronological cut of the usable footage (dead air trimmed, static cameras kept). The planner
//    does not pretend to know where the payoff is; the content gate will say UNKNOWN.
//  - Presentation text is never invented here: headline, context/payoff captions and effect words come only from
//    validated, visually-grounded semantic cues.
import type { SourceAnalysis } from './analyze.js'
import type { Interval } from './ffmpeg.js'
import { subtractIntervals } from './analyze.js'
import { CLEAN_EDGE_LIMITS, overlap, type CleanEdgeCrop, type Range, type SemanticResult, type StoryAnalysis } from './story.js'
import { planPresentation, PRESENTATION_LIMITS, type PresentationReport } from './presentation.js'

export type Beat = { label: string; trimStart: number; trimEnd: number }
export type VariantSpec = {
  id: string; label: string; rationale: string; beats: Beat[]
  kind?: 'chronological' | 'preview' | 'tight'
  // What the presentation layer kept/dropped for THIS edit (recorded in the PLAN result; never part of job-plan/1)
  presentation?: PresentationReport
  audioMode?: 'source' | 'dub'
  voiceoverLines?: Array<{ start: number; end: number; text: string }>
  headline?: string; events?: Array<{ start: number; end: number; text: string }>
  effectCaptions?: Array<Record<string, unknown>>; callouts?: Array<Record<string, unknown>>
  cleanEdgeCrop?: CleanEdgeCrop
}

export const PLAN_LIMITS = {
  maxOutputSeconds: 45,
  singleEventMaxSeconds: 30,
  minOutputSeconds: 6,
  minBeatSeconds: 0.8,
  maxBeats: 12,
  idleTrimSeconds: 8,
  maxEvents: PRESENTATION_LIMITS.eventsMax,
  maxEffects: PRESENTATION_LIMITS.effects
}
const r2 = (n: number) => Math.round(n * 100) / 100
const len = (b: { trimStart: number; trimEnd: number }) => b.trimEnd - b.trimStart
export const totalSeconds = (beats: Beat[]) => r2(beats.reduce((s, b) => s + len(b), 0))
const asRange = (b: Beat): Range => ({ start: b.trimStart, end: b.trimEnd })

// Seconds whose visual+audio energy is well below the clip's typical level are "idle" (dead air).
function idleSeconds(a: SourceAnalysis): Set<number> {
  const vis = a.timeline.map((s) => s.visual).sort((x, y) => x - y)
  const p75 = vis[Math.floor(vis.length * 0.75)] ?? 0
  const threshold = Math.max(0.0015, 0.35 * p75)
  const idle = new Set<number>()
  for (const s of a.timeline) if (s.visual < threshold && (s.audioDb === null || s.audioDb < -45 || a.audio.intentionallySilent)) idle.add(s.t)
  return idle
}

// Idle runs >= 2s, unless most of the clip is uniformly quiet (static camera): then nothing is dead air by itself.
export function deadAirRuns(a: SourceAnalysis): Interval[] {
  const idle = idleSeconds(a)
  const runs: Interval[] = []
  let run: number | null = null
  for (let t = 0; t <= a.timeline.length; t++) {
    if (idle.has(t) && run === null) run = t
    if (!idle.has(t) && run !== null) { if (t - run >= 2) runs.push({ start: run + 0.5, end: t - 0.5 }); run = null }
  }
  const total = runs.reduce((s, r) => s + (r.end - r.start), 0)
  return total < 0.6 * a.media.duration ? runs : []
}

function rangesToBeats(ranges: Interval[], labelPrefix = 'beat'): Beat[] {
  const merged: Interval[] = []
  for (const r of [...ranges].sort((x, y) => x.start - y.start)) {
    const prev = merged[merged.length - 1]
    if (prev && r.start - prev.end < 0.25) prev.end = Math.max(prev.end, r.end)
    else merged.push({ ...r })
  }
  return merged.filter((r) => r.end - r.start >= PLAN_LIMITS.minBeatSeconds).map((r, i) => ({ label: `${labelPrefix} ${i + 1}`, trimStart: r2(r.start), trimEnd: r2(r.end) }))
}

// Chronological beats of the usable footage with dead air trimmed (no story knowledge).
export function chronologicalBeats(a: SourceAnalysis): Beat[] {
  const ranges = subtractIntervals(a.usable, deadAirRuns(a))
  const beats: Beat[] = []
  for (const r of ranges) {
    const cutAt = a.scenes.map((s) => s.start).filter((t) => t > r.start + PLAN_LIMITS.idleTrimSeconds && t < r.end - 1)
    const edges = [r.start, ...cutAt, r.end]
    for (let i = 0; i < edges.length - 1; i++) beats.push({ label: '', trimStart: r2(edges[i]), trimEnd: r2(edges[i + 1]) })
  }
  return beats.filter((b) => len(b) >= PLAN_LIMITS.minBeatSeconds).map((b, i) => ({ ...b, label: `beat ${i + 1}` }))
}

function capLength(beats: Beat[], a: SourceAnalysis, max: number, protectedRanges: Range[] = []): Beat[] {
  let out = beats.map((b) => ({ ...b }))
  const score = (b: Beat) => {
    const secs = a.timeline.filter((s) => s.t + 1 > b.trimStart && s.t < b.trimEnd)
    return secs.reduce((x, s) => x + s.visual, 0) / Math.max(1, secs.length)
  }
  const isProtected = (b: Beat) => protectedRanges.some((p) => overlap(asRange(b), p) > 0.2)
  while (totalSeconds(out) > max && out.length > 1) {
    const cand = out.map((b, i) => ({ i, b })).filter((x) => !isProtected(x.b))
    if (!cand.length) break
    const worst = cand.sort((x, y) => score(x.b) / Math.max(0.5, len(x.b)) - score(y.b) / Math.max(0.5, len(y.b)))[0].i
    out = out.filter((_, i) => i !== worst)
  }
  while (totalSeconds(out) > max + 0.01 && out.length) {
    const excess = totalSeconds(out) - max
    const first = out[0]
    if (len(first) - excess >= PLAN_LIMITS.minBeatSeconds) { first.trimStart = r2(first.trimStart + excess); break }
    out.shift()
  }
  return out.slice(-PLAN_LIMITS.maxBeats)
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

// Source time -> output time for a beat list (first matching beat).
export function sourceToOutput(beats: Beat[], t: number): number | null {
  let clock = 0
  for (const b of beats) {
    if (t >= b.trimStart - 1e-6 && t <= b.trimEnd + 1e-6) return clock + (t - b.trimStart)
    clock += len(b)
  }
  return null
}

// Effect placement is decided at render time (it needs the real framing); PLAN only says WHERE in time.
// Consecutive impacts alternate left/right inside the visual window so repeated hits read as separate beats.
const EFFECT_SLOTS = [{ xPct: 40, yPct: 42 }, { xPct: 60, yPct: 36 }, { xPct: 50, yPct: 48 }]
const POINT_SLOTS = [{ xPct: 50, yPct: 56 }, { xPct: 50, yPct: 48 }]

// Turns grounded semantic cues into the presentation layer of ONE edit:
// hook => persistent top headline; context/payoff => timed explanation captions; effect => short pop text.
// Cues are placed on the edit (clipped to the beat that contains them), then selected by priority under the screen
// budget (hook first, never dropped), so nothing is lost by list order or by an arbitrary trim.
export function presentationFor(beats: Beat[], story: StoryAnalysis): Pick<VariantSpec, 'headline' | 'events' | 'effectCaptions' | 'presentation'> {
  const { placed, report } = planPresentation(beats, story.minimalCaptions, { pinHook: (beats as any)[0]?.label === 'preview' })
  const hook = placed.find((c) => c.kind === 'hook')
  const events = placed.filter((c) => c.kind === 'context' || c.kind === 'payoff').map((c) => ({ start: c.srcStart, end: c.srcEnd, text: c.text }))
  const fx = placed.filter((c) => c.kind === 'effect').sort((a, b) => a.srcStart - b.srcStart)
  const points = placed.filter((c) => c.kind === 'point').sort((a, b) => a.srcStart - b.srcStart)
  // One pop per real impact. Bright yellow, large, and short.
  const impactCaptions = fx.map((c, idx) => ({
    start: c.srcStart, end: idx + 1 < fx.length && fx[idx + 1].srcStart > c.srcStart ? Math.min(c.srcEnd, fx[idx + 1].srcStart) : c.srcEnd,
    text: c.text, ...EFFECT_SLOTS[idx % EFFECT_SLOTS.length], role: 'effect', color: '#FFD928', strokeColor: '#111111', fontSizePct: 14, animation: 'pop'
  }))
  // Short dialogue/reaction punches are visually distinct from explanatory captions:
  // center-weighted, yellow, large, and fast. Never duplicate them as lower subtitles.
  const pointCaptions = points.map((c, idx) => ({
    start: c.srcStart, end: Math.min(c.srcEnd, c.srcStart + 1.35),
    text: c.text, ...POINT_SLOTS[idx % POINT_SLOTS.length], role: 'point', color: '#FFD928', strokeColor: '#111111', fontSizePct: 11.8, animation: 'pop'
  }))
  const effectCaptions = [...impactCaptions, ...pointCaptions].sort((a, b) => a.start - b.start)
  return {
    ...(hook ? { headline: hook.text } : {}),
    ...(events.length ? { events } : {}),
    ...(effectCaptions.length ? { effectCaptions } : {}),
    presentation: report
  }
}

// A variant is only worth offering if its presentation is complete: headline present, explanation for 10s+, rhythm ok.
export const presentationComplete = (v: Pick<VariantSpec, 'presentation'>) => !!v.presentation && v.presentation.hookKept && v.presentation.explanationPresent && v.presentation.rhythm.ok

export function storyMaxSeconds(story: StoryAnalysis | null): number {
  return story?.storyType === 'single_event' ? PLAN_LIMITS.singleEventMaxSeconds : PLAN_LIMITS.maxOutputSeconds
}

// The causal story, in source order: [causalStart, recommendedEnd] ∩ usable − excludes − dead air.
export function storyBeats(a: SourceAnalysis, story: StoryAnalysis): Beat[] {
  const window = subtractIntervals(a.usable, [{ start: 0, end: story.causalStart }, { start: story.recommendedEnd, end: a.media.duration + 1 }])
  const payoff = story.payoffRange
  // A payoff is never allowed to "protect" prominent foreign text. If text overlaps the indispensable payoff,
  // validateStory blocks the semantic answer; this branch is defense-in-depth for manually supplied/cached stories.
  const excl = story.excludeRanges.flatMap((x) => x.reason === 'foreign_text' ? [x] : subtractIntervals([x], [payoff]))
  const storyRanges = [...story.setupRanges, ...story.escalationRanges, payoff]
  const dead = deadAirRuns(a).flatMap((d) => subtractIntervals([d], storyRanges))
  const kept = subtractIntervals(window, [...excl, ...dead])
  return capLength(rangesToBeats(kept), a, storyMaxSeconds(story), [payoff])
}

export function planVariants(a: SourceAnalysis, semantic: SemanticResult | null = null): VariantSpec[] {
  const story = semantic?.status === 'ok' ? semantic.story : null
  if (!story) {
    const base = capLength(chronologicalBeats(a), a, PLAN_LIMITS.maxOutputSeconds)
    if (!base.length) throw new Error('no usable source ranges to plan from')
    return [{ id: 'v1', label: '원본 순서', kind: 'chronological', rationale: 'no validated story analysis: original chronology, dead time removed, no preview hook', beats: base }]
  }

  const base = storyBeats(a, story)
  if (!base.length) throw new Error('story analysis left no usable footage')
  const variants: VariantSpec[] = []
  const clean = story.cleanEdgeCrop ? { cleanEdgeCrop: story.cleanEdgeCrop } : {}
  // Two-mode audio policy:
  // - meaningful/non-silent source audio => keep source at full level, captions only.
  // - no/mostly-silent source audio => mute source and use timed dub lines.
  // Ambiguous cases deliberately default to SOURCE to avoid destroying useful natural sound.
  const audioMode: 'source' | 'dub' = a.media.hasAudio && !a.audio.intentionallySilent ? 'source' : 'dub'
  const withAudio = (v: VariantSpec): VariantSpec => {
    if (audioMode === 'source') return { ...v, audioMode }
    const lines = (v.events || []).map((e) => ({ start: e.start, end: e.end, text: e.text.trim() })).filter((x) => x.text)
    return { ...v, audioMode, ...(lines.length ? { voiceoverLines: lines } : {}) }
  }
  variants.push(withAudio({ id: 'v1', label: '추천 · 원인→결말', kind: 'chronological', rationale: 'causal story + grounded Korean presentation layer; off-story footage removed', beats: base, ...clean, ...presentationFor(base, story) }))

  if (story.hookStrategy === 'preview' && story.previewRange) {
    const p = story.previewRange
    const beats = capLength([{ label: 'preview', trimStart: p.start, trimEnd: p.end }, ...base.map((b) => ({ ...b }))], a, storyMaxSeconds(story), [story.payoffRange, p])
    if (beats[0]?.label === 'preview') variants.push(withAudio({ id: 'v2', label: '결말 살짝 먼저', kind: 'preview', rationale: `preview hook: ${story.hookReason}`.slice(0, 200), beats, ...clean, ...presentationFor(beats, story) }))
  }

  const core = subtractIntervals(base.map(asRange).flatMap((r) => [...story.setupRanges, ...story.escalationRanges, story.payoffRange].map((s) => ({ start: Math.max(r.start, s.start), end: Math.min(r.end, s.end) })).filter((x) => x.end > x.start)), [])
  const tight = rangesToBeats(core, 'core')
  if (tight.length && totalSeconds(tight) >= PLAN_LIMITS.minOutputSeconds) variants.push(withAudio({ id: 'v3', label: '핵심만 짧게', kind: 'tight', rationale: 'setup, escalation and payoff only with grounded presentation cues', beats: tight, ...clean, ...presentationFor(tight, story) }))

  // The recommended edit is always kept (its report says what is missing). Alternatives are only offered when their own
  // presentation is complete: a preview-first or tight cut that loses the headline or leaves the screen unattended
  // is not a real alternative.
  const accepted: VariantSpec[] = []
  for (const [i, v] of variants.entries()) {
    if (i > 0 && !presentationComplete(v)) continue
    if (accepted.every((x) => variantDistance(x.beats, v.beats) >= 0.15)) accepted.push(v)
  }
  return accepted.slice(0, 3).map((v, i) => ({ ...v, id: `v${i + 1}` }))
}

// Strict validation of any plan against the analyzed source.
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
  if ((v.events || []).length > PLAN_LIMITS.maxEvents) errors.push(`more than ${PLAN_LIMITS.maxEvents} explanation captions`)
  if ((v.effectCaptions || []).length > PLAN_LIMITS.maxEffects) errors.push(`more than ${PLAN_LIMITS.maxEffects} effect captions`)
  for (const e of v.events || []) if (!e?.text || [...String(e.text)].length > 20 || !(e.end > e.start)) errors.push('invalid event')
  for (const e of v.effectCaptions || []) {
    const maxChars = e?.role === 'point' ? 18 : 8
    if (!e?.text || [...String(e.text)].length > maxChars || !(Number(e.end) > Number(e.start))) errors.push(e?.role === 'point' ? 'invalid point caption' : 'invalid effect caption')
  }
  if (v.headline && [...String(v.headline)].length > 24) errors.push('headline too long')
  if (v.cleanEdgeCrop) {
    const { topPct, bottomPct, confidence, basis } = v.cleanEdgeCrop
    if (![topPct, bottomPct, confidence].every(Number.isFinite) || topPct < 0 || bottomPct < 0 || topPct > CLEAN_EDGE_LIMITS.topMax || bottomPct > CLEAN_EDGE_LIMITS.bottomMax || topPct + bottomPct > CLEAN_EDGE_LIMITS.totalMax || confidence < CLEAN_EDGE_LIMITS.minConfidence || !String(basis || '').trim()) errors.push('invalid clean edge crop')
  }
  return errors
}

// job-plan/1 body for a variant (source-time presentation cues are converted by the compiler).
export function toJobPlan(sourceAssetId: string, v: VariantSpec) {
  return {
    schema: 'job-plan/1' as const, profile: 'source_shorts' as const, sourceAssetId,
    variantPlan: {
      profile: v.id,
      beats: v.beats.map((b) => ({ label: b.label, trimStart: b.trimStart, trimEnd: b.trimEnd })),
      ...(v.headline ? { headline: v.headline } : {}),
      audioStrategy: v.audioMode === 'dub' ? 'DUB_REPLACE' : 'SOURCE_SOUND',
      ...(v.audioMode === 'dub' && v.voiceoverLines?.length ? { voiceover: { mode: 'timed', lines: v.voiceoverLines, sourceVolume: 0, voiceVolume: 1 } } : {}),
      ...(v.events?.length ? { events: v.events, plansTimeDomain: 'source' as const } : {}),
      ...(v.effectCaptions?.length ? { effectCaptions: v.effectCaptions, timeDomain: 'source' as const } : {}),
      ...(v.callouts?.length ? { callouts: v.callouts, plansTimeDomain: 'source' as const } : {}),
      ...(v.cleanEdgeCrop ? { cleanEdgeCrop: v.cleanEdgeCrop } : {})
    }
  }
}
