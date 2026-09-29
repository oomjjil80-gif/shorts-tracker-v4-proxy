// CONTENT publishable gate: "is this an edit a person can upload as-is?" — separate from the technical AUTO_QC gate.
// It judges the EDIT (the manifest's cuts in source time + its text) against the source measurements and the
// validated semantic story. Semantic questions (opening, payoff, tail, repeats, off-story footage, invented text)
// can only be answered with a validated story; without one they are UNKNOWN, which blocks (never PASS).
import { evaluateGate, type CheckResult, type GateResult } from '../qc/gate.js'
import type { SourceAnalysis } from './analyze.js'
import { foregroundRect, type SourceFraming } from './framing.js'
import { deadAirRuns, PLAN_LIMITS, storyMaxSeconds } from './plan.js'
import { OFFSTORY_REASONS, overlap, PACING_REASONS, STORY_LIMITS, type Range, type SemanticResult } from './story.js'

export const CONTENT_LIMITS = { openingToleranceSec: 1.5, maxExcludedOverlapSec: 0.3, maxTailSec: STORY_LIMITS.maxTailAfterPayoff + 0.5, minPayoffCoverage: 0.8, maxDeadRunSec: 2.5, minForegroundArea: 0.3, maxTextItems: 3 }

export type ContentGateInput = {
  payload: any // RenderManifest payload
  analysis: SourceAnalysis
  semantic: SemanticResult | null
  framing: SourceFraming | null | undefined
}

type Seg = Range & { outStart: number }

function segmentsOf(payload: any): Seg[] {
  const segs: Seg[] = []
  let clock = 0
  for (const c of payload?.cuts || []) {
    const sv = c?.sourceVideo
    if (c?.mediaType !== 'source_video' || !sv) continue
    const s = Number(sv.trimStart), e = Number(sv.trimEnd)
    if (!(e > s)) continue
    segs.push({ start: s, end: e, outStart: clock })
    clock += e - s
  }
  return segs
}

function textItems(payload: any): Array<{ kind: string; text: string }> {
  const out: Array<{ kind: string; text: string }> = []
  if (payload?.editorialPlan?.headline) out.push({ kind: 'headline', text: String(payload.editorialPlan.headline) })
  for (const e of payload?.subtitleEvents || []) if (e?.text) out.push({ kind: 'subtitle', text: String(e.text) })
  for (const e of payload?.sourceEffectCaptions || []) if (e?.text) out.push({ kind: 'effect', text: String(e.text) })
  for (const e of payload?.sourceCallouts || []) if (e?.text) out.push({ kind: 'callout', text: String(e.text) })
  return out
}

const sumOverlap = (segs: Range[], ranges: Range[]) => segs.reduce((s, g) => s + ranges.reduce((t, r) => t + overlap(g, r), 0), 0)
const r2 = (n: number) => Math.round(n * 100) / 100

export function evaluateContentGate(i: ContentGateInput): GateResult {
  const segs = segmentsOf(i.payload)
  const total = segs.reduce((s, g) => s + (g.end - g.start), 0)
  const semantic = i.semantic?.status === 'ok' && i.semantic.story ? i.semantic.story : null
  const why = { semanticStatus: i.semantic?.status ?? 'unavailable', semanticReason: i.semantic?.reason ?? 'no semantic story analysis was run' }
  const unknown = (id: string, extra: Record<string, unknown> = {}): CheckResult => ({ id, required: true, status: 'UNKNOWN', evidence: { ...why, ...extra } })
  const verdict = (id: string, ok: boolean, evidence: unknown): CheckResult => ({ id, required: true, status: ok ? 'PASS' : 'FAIL', evidence })
  const checks: CheckResult[] = []

  if (!segs.length) {
    return evaluateGate([{ id: 'content.edit_readable', required: true, status: 'UNKNOWN', evidence: { reason: 'manifest has no source segments' } }])
  }

  // 1. opening understandable: starts at the causal start, or is a validated preview hook
  if (!semantic) checks.push(unknown('content.opening_understandable'))
  else {
    const first = segs[0]
    const p = semantic.previewRange
    const isPreview = !!p && semantic.hookStrategy === 'preview' && first.start >= p.start - 0.05 && first.end <= p.end + 0.05 && segs.length > 1
    const startsAtCause = Math.abs(first.start - semantic.causalStart) <= CONTENT_LIMITS.openingToleranceSec
    const firstOffstory = semantic.excludeRanges.filter((x) => OFFSTORY_REASONS.includes(x.reason) && overlap(first, x) > CONTENT_LIMITS.maxExcludedOverlapSec)
    checks.push(verdict('content.opening_understandable', (isPreview || startsAtCause) && !firstOffstory.length, { firstSegment: first, causalStart: semantic.causalStart, validatedPreview: isPreview, firstOffstory }))
  }

  // 2. chronology: source order, except one validated preview beat at the very start
  {
    const body = semantic?.previewRange && semantic.hookStrategy === 'preview' && segs.length > 1 && segs[0].start >= semantic.previewRange.start - 0.05 && segs[0].end <= semantic.previewRange.end + 0.05 ? segs.slice(1) : segs
    const backwards = body.slice(1).map((g, k) => ({ at: k + 2, from: body[k].end, to: g.start })).filter((x) => x.to < x.from - 0.05)
    // a non-monotonic edit without a validated preview is not coherent; a monotonic one is coherent by construction
    checks.push(verdict('content.chronology_coherent', backwards.length === 0, { backwardsJumps: backwards, previewAccepted: body !== segs }))
  }

  // 3. repeats / dead moments: semantic repeats + measured dead air
  {
    const dead = deadAirRuns(i.analysis).filter((d) => d.end - d.start >= 0.5)
    const storyRanges = semantic ? [...semantic.setupRanges, ...semantic.escalationRanges, semantic.payoffRange] : []
    const deadInside = dead.map((d) => ({ ...d, inOutput: r2(segs.reduce((s, g) => s + overlap(g, d), 0)) })).filter((d) => d.inOutput > CONTENT_LIMITS.maxDeadRunSec && !storyRanges.some((s) => overlap(s, d) > 0.5 * (d.end - d.start)))
    if (deadInside.length) checks.push(verdict('content.no_repeat_or_dead', false, { deadAirInOutput: deadInside }))
    else if (!semantic) checks.push(unknown('content.no_repeat_or_dead', { note: 'dead air measured OK; repeated actions need semantic analysis' }))
    else {
      const pacing = semantic.excludeRanges.filter((x) => PACING_REASONS.includes(x.reason))
      const hit = r2(sumOverlap(segs, pacing))
      checks.push(verdict('content.no_repeat_or_dead', hit <= CONTENT_LIMITS.maxExcludedOverlapSec, { repeatOrDeadSecondsInOutput: hit }))
    }
  }

  // 4. payoff present (and the edit does not end before it)
  if (!semantic) checks.push(unknown('content.payoff_present'))
  else {
    const p = semantic.payoffRange
    const cov = sumOverlap(segs.filter((g, k) => !(k === 0 && semantic.previewRange && g.end <= semantic.previewRange.end + 0.05 && g.start >= semantic.previewRange.start - 0.05 && segs.length > 1)), [p]) / (p.end - p.start)
    const lastEnd = Math.max(...segs.map((g) => g.end))
    checks.push(verdict('content.payoff_present', cov >= CONTENT_LIMITS.minPayoffCoverage && lastEnd >= p.end - 0.3, { payoff: p, coverage: r2(cov), lastSourceSecond: lastEnd }))
  }

  // 5. nothing trailing after the payoff
  if (!semantic) checks.push(unknown('content.no_post_payoff_tail'))
  else {
    const tail = r2(segs.reduce((s, g) => s + Math.max(0, g.end - Math.max(g.start, semantic.payoffRange.end)), 0))
    checks.push(verdict('content.no_post_payoff_tail', tail <= CONTENT_LIMITS.maxTailSec, { secondsAfterPayoff: tail, max: CONTENT_LIMITS.maxTailSec }))
  }

  // 6. off-story contamination: product demo, foreign text, unrelated, intro confusion, post-payoff
  if (!semantic) checks.push(unknown('content.no_offstory_contamination'))
  else {
    const offstory = semantic.excludeRanges.filter((x) => OFFSTORY_REASONS.includes(x.reason))
    const rows = offstory.map((x) => ({ ...x, secondsInOutput: r2(segs.reduce((s, g) => s + overlap(g, x), 0)) })).filter((x) => x.secondsInOutput > 0)
    checks.push(verdict('content.no_offstory_contamination', rows.every((x) => x.secondsInOutput <= CONTENT_LIMITS.maxExcludedOverlapSec), { contamination: rows }))
  }

  // 7. mobile readability of the real picture (deterministic from the render framing)
  if (!i.framing) checks.push({ id: 'content.mobile_foreground', required: true, status: 'UNKNOWN', evidence: { reason: 'render framing not recorded' } })
  else {
    const area = i.framing.mode === 'embedded' && i.framing.crop ? (() => { const r = foregroundRect(i.framing!.crop!); return (r.width * r.height) / (1080 * 1920) })() : 1
    checks.push(verdict('content.mobile_foreground', area >= CONTENT_LIMITS.minForegroundArea, { foregroundAreaFraction: r2(area), min: CONTENT_LIMITS.minForegroundArea, framing: i.framing.mode }))
  }

  // 8. captions: minimal and grounded (every text must be a validated, visually grounded story caption)
  {
    const texts = textItems(i.payload)
    const tooMany = texts.length > CONTENT_LIMITS.maxTextItems || texts.filter((t) => t.kind !== 'headline').length > PLAN_LIMITS.maxEvents
    const tooLong = texts.filter((t) => [...t.text].length > (t.kind === 'headline' ? 24 : STORY_LIMITS.maxCaptionChars))
    if (!texts.length) checks.push(verdict('content.captions_minimal_grounded', true, { texts: 0 }))
    else if (tooMany || tooLong.length) checks.push(verdict('content.captions_minimal_grounded', false, { count: texts.length, tooLong }))
    else if (!semantic) checks.push(unknown('content.captions_minimal_grounded', { note: 'captions present but their grounding cannot be verified' }))
    else {
      const grounded = new Set(semantic.minimalCaptions.map((c) => c.text))
      const invented = texts.filter((t) => !grounded.has(t.text))
      checks.push(verdict('content.captions_minimal_grounded', invented.length === 0, { texts: texts.length, ungrounded: invented }))
    }
  }

  // 9. length suits a Short of this story type
  {
    const max = storyMaxSeconds(semantic)
    checks.push(verdict('content.length_fit', total >= PLAN_LIMITS.minOutputSeconds && total <= max + 0.01, { seconds: r2(total), min: PLAN_LIMITS.minOutputSeconds, max }))
  }

  return evaluateGate(checks)
}
