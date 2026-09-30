// Presentation layer rules shared by story validation, PLAN, content QC and rendering — ONE source of truth.
//
// Vocabulary (a "cue" is one grounded on-screen Korean message from the semantic story):
//   hook    -> persistent top headline (exactly one, mandatory, never dropped by any budget)
//   payoff  -> timed caption over the payoff (priority right after the hook)
//   context -> timed short explanation captions at story changes
//   effect  -> short pop word (onomatopoeia/mimetic) tied to a visible motion
// Budget (screen messages incl. the headline): 6. Priority when the budget is tight: hook > payoff > context > effect,
// and among the same kind the cue that most reduces the longest stretch with nothing new on screen wins.
import type { Range } from './story.js'

export type CueKind = 'hook' | 'context' | 'payoff' | 'effect'
export type Cue = { kind: CueKind; start: number; end: number; text: string; basis: string }

export const PRESENTATION_LIMITS = {
  hook: 1,
  contexts: 5,
  payoffs: 1,
  effects: 2,
  totalMessages: 9,          // hook + payoff + contexts + effects
  eventsMax: 6,              // context + payoff (timed explanation captions)
  hookMaxOutputStart: 1.2,   // the headline must be tied to the first ~second of the clean edit
  maxDynamicGapSec: 3.2,     // upload-ready mobile rhythm: longest stretch without a NEW timed information/effect cue
  explanationMinTotalSec: 10, // edits this long need at least one context/payoff explanation, not only a hook/effects
  minCueSec: 0.6,            // a clipped cue shorter than this is not readable
  minEffectSec: 0.4,
  maxHookChars: 20, maxCaptionChars: 20, maxEffectChars: 8, maxHeadlineChars: 24
} as const

export const minDynamicFor = (totalSec: number) => totalSec >= 20 ? 6 : totalSec >= 12 ? 4 : totalSec >= 7 ? 2 : 1

export type RhythmReport = { ok: boolean; dynamicCueCount: number; minDynamic: number; cueStarts: number[]; maxGapSeconds: number; worstGap: { from: number; to: number } | null; allowedMaxGap: number }
const r2 = (n: number) => Math.round(n * 100) / 100

// Output-time rhythm of the TIMED cues (the headline is persistent and does not count). Gaps are measured
// start-to-start, including the edit start (0) and end (total).
export function rhythmReport(starts: number[], total: number): RhythmReport {
  const cue = starts.filter((x) => Number.isFinite(x) && x >= 0 && x <= total).sort((a, b) => a - b)
  const pts = [0, ...cue, total]
  let worst: { from: number; to: number } | null = null, max = 0
  for (let k = 1; k < pts.length; k++) { const g = pts[k] - pts[k - 1]; if (g > max) { max = g; worst = { from: r2(pts[k - 1]), to: r2(pts[k]) } } }
  const minDynamic = minDynamicFor(total)
  return { ok: cue.length >= minDynamic && max <= PRESENTATION_LIMITS.maxDynamicGapSec + 1e-6, dynamicCueCount: cue.length, minDynamic, cueStarts: cue.map(r2), maxGapSeconds: r2(max), worstGap: worst, allowedMaxGap: PRESENTATION_LIMITS.maxDynamicGapSec }
}

export type PlacedCue = Cue & { outStart: number; srcStart: number; srcEnd: number }

const maxGap = (starts: number[], total: number) => rhythmReport(starts, total).maxGapSeconds

// Chooses which placed cues to show. Deterministic. Never drops the hook. Returns kept cues in chronological order
// and the dropped ones with the reason (so nothing is lost silently).
export function selectCues(placed: PlacedCue[], total: number): { kept: PlacedCue[]; dropped: Array<{ cue: PlacedCue; reason: string }> } {
  const L = PRESENTATION_LIMITS
  const dropped: Array<{ cue: PlacedCue; reason: string }> = []
  const kept: PlacedCue[] = []
  const hooks = placed.filter((c) => c.kind === 'hook').sort((a, b) => a.outStart - b.outStart)
  if (hooks[0]) kept.push(hooks[0])
  for (const h of hooks.slice(1)) dropped.push({ cue: h, reason: 'only one hook/headline is allowed' })

  const caps: Record<Exclude<CueKind, 'hook'>, number> = { payoff: L.payoffs, context: L.contexts, effect: L.effects }
  const count = (k: CueKind) => kept.filter((c) => c.kind === k).length
  const timed = () => kept.filter((c) => c.kind !== 'hook').map((c) => c.outStart)
  const budgetLeft = () => L.totalMessages - kept.length

  // two timed messages that start within 0.5s add no new information: keep the higher-priority one
  const tooClose = (c: PlacedCue) => kept.some((k) => k.kind !== 'hook' && Math.abs(k.outStart - c.outStart) < 0.5)
  const take = (pool: PlacedCue[], kind: Exclude<CueKind, 'hook'>, greedy: boolean) => {
    let rest = pool.filter((c) => c.kind === kind)
    while (rest.length && count(kind) < caps[kind] && budgetLeft() > 0) {
      let best = 0
      if (greedy) {
        // the cue that leaves the smallest longest-silent-stretch; ties -> earlier
        let bestGap = Infinity
        rest.forEach((c, i) => { const g = maxGap([...timed(), c.outStart], total); if (g < bestGap - 1e-9) { bestGap = g; best = i } })
      }
      const c = rest[best]
      rest = rest.filter((_, i) => i !== best)
      if (tooClose(c)) { dropped.push({ cue: c, reason: 'starts within 0.5s of another message' }); continue }
      kept.push(c)
    }
    for (const c of rest) dropped.push({ cue: c, reason: count(kind) >= caps[kind] ? `at most ${caps[kind]} ${kind} message(s)` : 'screen-message budget exhausted' })
  }
  take(placed, 'payoff', false)
  take(placed, 'context', true)
  take(placed, 'effect', true)
  kept.sort((a, b) => a.outStart - b.outStart || a.srcStart - b.srcStart)
  return { kept, dropped }
}

export type EditBeat = { trimStart: number; trimEnd: number; label?: string }
// Places a source-time cue on a beat list: the beat containing the cue start; the cue is clipped to that beat.
// Returns null (with reason) when it cannot be shown legibly in this edit.
export function placeCue(beats: EditBeat[], cue: Cue): { placed: PlacedCue | null; reason?: string } {
  let clock = 0
  for (const b of beats) {
    const len = b.trimEnd - b.trimStart
    // A preview clip repeats footage that is shown again in story order; timed cues belong to the story occurrence.
    if (b.label !== 'preview' && cue.start >= b.trimStart - 0.01 && cue.start < b.trimEnd - 0.05) {
      const end = Math.min(cue.end, b.trimEnd)
      const need = cue.kind === 'effect' ? PRESENTATION_LIMITS.minEffectSec : cue.kind === 'hook' ? 0 : Math.min(PRESENTATION_LIMITS.minCueSec, (cue.end - cue.start) * 0.6)
      if (end - cue.start < need) return { placed: null, reason: `only ${r2(end - cue.start)}s of it remains inside the edit` }
      return { placed: { ...cue, start: cue.start, end, srcStart: cue.start, srcEnd: end, outStart: r2(clock + Math.max(0, cue.start - b.trimStart)) } }
    }
    clock += len
  }
  return { placed: null, reason: 'its footage is not in the edit (excluded or cut)' }
}

export type PresentationReport = {
  hookKept: boolean
  hookReason: string | null
  kept: Array<{ kind: CueKind; text: string; outStart: number }>
  dropped: Array<{ kind: CueKind; text: string; reason: string }>
  rhythm: RhythmReport
  explanationPresent: boolean
}

// The complete presentation for one edit: place -> select -> report. Pure.
// pinHook: the edit opens with a preview clip whose cue lives later in source time; the headline is persistent, so it is
// anchored to the first frame of the edit instead of the story beat that follows the preview.
export function planPresentation(beats: EditBeat[], cues: Cue[], opts: { pinHook?: boolean } = {}): { placed: PlacedCue[]; report: PresentationReport } {
  const total = beats.reduce((s, b) => s + (b.trimEnd - b.trimStart), 0)
  const placedAll: PlacedCue[] = []
  const dropped: PresentationReport['dropped'] = []
  for (const c of cues) {
    const r = placeCue(beats, c)
    if (r.placed) placedAll.push(r.placed)
    else dropped.push({ kind: c.kind, text: c.text, reason: r.reason ?? 'not placeable' })
  }
  const hook = placedAll.find((c) => c.kind === 'hook')
  if (hook && opts.pinHook) hook.outStart = 0
  let hookReason: string | null = null
  const cueHook = cues.find((c) => c.kind === 'hook')
  if (!cueHook) hookReason = 'the story has no opening hook'
  else if (!hook) hookReason = dropped.find((d) => d.kind === 'hook')?.reason ?? 'hook could not be placed'
  else if (hook.outStart > PRESENTATION_LIMITS.hookMaxOutputStart) hookReason = `hook would first appear ${hook.outStart}s into the edit (max ${PRESENTATION_LIMITS.hookMaxOutputStart}s)`
  const usable = hookReason ? placedAll.filter((c) => c.kind !== 'hook') : placedAll
  const { kept, dropped: cut } = selectCues(usable, total)
  for (const d of cut) dropped.push({ kind: d.cue.kind, text: d.cue.text, reason: d.reason })
  const rhythm = rhythmReport(kept.filter((c) => c.kind !== 'hook').map((c) => c.outStart), total)
  return {
    placed: kept,
    report: {
      hookKept: !hookReason, hookReason,
      kept: kept.map((c) => ({ kind: c.kind, text: c.text, outStart: c.outStart })), dropped, rhythm,
      explanationPresent: total < PRESENTATION_LIMITS.explanationMinTotalSec || kept.some((c) => c.kind === 'context' || c.kind === 'payoff')
    }
  }
}

export type { Range }
