// CONTENT publishable gate: "is this an edit a person can upload as-is?" — separate from the technical AUTO_QC gate.
// It judges story coherence AND the mobile presentation layer. Semantic questions can only PASS with a validated
// story; without one they are UNKNOWN/BLOCK. Presentation cues must be grounded in that story, not invented by QC.
import { evaluateGate, type CheckResult, type GateResult } from '../qc/gate.js'
import type { SourceAnalysis } from './analyze.js'
import type { SourceFraming } from './framing.js'
import { COMMON_SHORTS_SCREEN_DNA as DNA } from './screenDnaContract.js'
import { assFromPayload } from './ass.js'
import { deadAirRuns, PLAN_LIMITS, storyMaxSeconds } from './plan.js'
import { PRESENTATION_LIMITS, rhythmReport } from './presentation.js'
import { OFFSTORY_REASONS, overlap, PACING_REASONS, STORY_LIMITS, type Range, type SemanticResult } from './story.js'

export const CONTENT_LIMITS = {
  openingToleranceSec: 1.5,
  maxExcludedOverlapSec: 0.3,
  maxTailSec: STORY_LIMITS.maxTailAfterPayoff + 0.5,
  minPayoffCoverage: 0.8,
  maxDeadRunSec: 2.5,
  minForegroundArea: 0.3,
  maxWindowUpscale: 4, // a picture cover-scaled more than 4x into the visual window is too small to read on a phone
  maxTextItems: PRESENTATION_LIMITS.totalMessages,
  maxDynamicGapSec: PRESENTATION_LIMITS.maxDynamicGapSec
}

export type ContentGateInput = {
  payload: any
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
  // Common Shorts Screen DNA draws only the headline (top band) and captions (bottom band); effect captions and callouts
  // have no zone and are not on screen, so they are not presentation text.
  return out
}

function dynamicCueStarts(payload: any, total: number): number[] {
  const rows = [...(payload?.subtitleEvents || [])] // only drawn, timed text (captions) can change the screen
  return rows.map((e: any) => Number(e?.start)).filter((x: number) => Number.isFinite(x) && x >= 0 && x <= total).sort((a: number, b: number) => a - b)
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

  if (!segs.length) return evaluateGate([{ id: 'content.edit_readable', required: true, status: 'UNKNOWN', evidence: { reason: 'manifest has no source segments' } }])

  // 1. opening understandable: starts at the causal start, or is a validated preview hook.
  if (!semantic) checks.push(unknown('content.opening_understandable'))
  else {
    const first = segs[0]
    const p = semantic.previewRange
    const isPreview = !!p && semantic.hookStrategy === 'preview' && first.start >= p.start - 0.05 && first.end <= p.end + 0.05 && segs.length > 1
    const startsAtCause = Math.abs(first.start - semantic.causalStart) <= CONTENT_LIMITS.openingToleranceSec
    const firstOffstory = semantic.excludeRanges.filter((x) => OFFSTORY_REASONS.includes(x.reason) && overlap(first, x) > CONTENT_LIMITS.maxExcludedOverlapSec)
    checks.push(verdict('content.opening_understandable', (isPreview || startsAtCause) && !firstOffstory.length, { firstSegment: first, causalStart: semantic.causalStart, validatedPreview: isPreview, firstOffstory }))
  }

  // 2. chronology.
  {
    const body = semantic?.previewRange && semantic.hookStrategy === 'preview' && segs.length > 1 && segs[0].start >= semantic.previewRange.start - 0.05 && segs[0].end <= semantic.previewRange.end + 0.05 ? segs.slice(1) : segs
    const backwards = body.slice(1).map((g, k) => ({ at: k + 2, from: body[k].end, to: g.start })).filter((x) => x.to < x.from - 0.05)
    checks.push(verdict('content.chronology_coherent', backwards.length === 0, { backwardsJumps: backwards, previewAccepted: body !== segs }))
  }

  // 3. repeats / dead moments.
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

  // 4. payoff present.
  if (!semantic) checks.push(unknown('content.payoff_present'))
  else {
    const p = semantic.payoffRange
    const cov = sumOverlap(segs.filter((g, k) => !(k === 0 && semantic.previewRange && g.end <= semantic.previewRange.end + 0.05 && g.start >= semantic.previewRange.start - 0.05 && segs.length > 1)), [p]) / (p.end - p.start)
    const lastEnd = Math.max(...segs.map((g) => g.end))
    checks.push(verdict('content.payoff_present', cov >= CONTENT_LIMITS.minPayoffCoverage && lastEnd >= p.end - 0.3, { payoff: p, coverage: r2(cov), lastSourceSecond: lastEnd }))
  }

  // 5. no tail after payoff.
  if (!semantic) checks.push(unknown('content.no_post_payoff_tail'))
  else {
    const tail = r2(segs.reduce((s, g) => s + Math.max(0, g.end - Math.max(g.start, semantic.payoffRange.end)), 0))
    checks.push(verdict('content.no_post_payoff_tail', tail <= CONTENT_LIMITS.maxTailSec, { secondsAfterPayoff: tail, max: CONTENT_LIMITS.maxTailSec }))
  }

  // 6. no off-story contamination.
  if (!semantic) checks.push(unknown('content.no_offstory_contamination'))
  else {
    const offstory = semantic.excludeRanges.filter((x) => OFFSTORY_REASONS.includes(x.reason))
    const rows = offstory.map((x) => ({ ...x, secondsInOutput: r2(segs.reduce((s, g) => s + overlap(g, x), 0)) })).filter((x) => x.secondsInOutput > 0)
    checks.push(verdict('content.no_offstory_contamination', rows.every((x) => x.secondsInOutput <= CONTENT_LIMITS.maxExcludedOverlapSec), { contamination: rows }))
  }

  // 7. mobile readability of the real picture.
  // The picture always fills the Common Screen DNA visual window (cover-scaled, after any embedded-picture crop), so the
  // on-screen area is fixed; what can still make it unreadable is a tiny real picture blown up to fill the window.
  if (!i.framing) checks.push({ id: 'content.mobile_foreground', required: true, status: 'UNKNOWN', evidence: { reason: 'render framing not recorded' } })
  else {
    const area = (DNA.center.w * DNA.center.h) / (DNA.canvas.w * DNA.canvas.h)
    const pic = i.framing.mode === 'embedded' && i.framing.crop ? { w: i.framing.crop.width, h: i.framing.crop.height } : { w: Number(i.analysis?.media?.width), h: Number(i.analysis?.media?.height) }
    const upscale = pic.w > 0 && pic.h > 0 ? Math.max(DNA.center.w / pic.w, DNA.center.h / pic.h) : null
    if (upscale === null) checks.push({ id: 'content.mobile_foreground', required: true, status: 'UNKNOWN', evidence: { reason: 'source picture size unknown', framing: i.framing.mode } })
    else checks.push(verdict('content.mobile_foreground', area >= CONTENT_LIMITS.minForegroundArea && upscale <= CONTENT_LIMITS.maxWindowUpscale, { foregroundAreaFraction: r2(area), window: DNA.center, picture: pic, windowUpscale: r2(upscale), maxWindowUpscale: CONTENT_LIMITS.maxWindowUpscale, framing: i.framing.mode }))
  }

  // 8. all text is minimal and semantically grounded. A Korean top headline is mandatory for P1 source shorts.
  {
    const texts = textItems(i.payload)
    const headline = String(i.payload?.editorialPlan?.headline || '').trim()
    // only drawn text counts (effect captions / callouts have no Screen DNA zone and are never on screen)
    const tooMany = texts.length > CONTENT_LIMITS.maxTextItems || (i.payload?.subtitleEvents || []).length > PLAN_LIMITS.maxEvents
    const tooLong = texts.filter((t) => [...t.text].length > (t.kind === 'headline' ? 24 : t.kind === 'effect' ? STORY_LIMITS.maxEffectChars : STORY_LIMITS.maxCaptionChars))
    if (!headline || !/[가-힣]/.test(headline)) checks.push(verdict('content.presentation_grounded', false, { reason: 'missing Korean top headline', headline }))
    else if (tooMany || tooLong.length) checks.push(verdict('content.presentation_grounded', false, { count: texts.length, tooLong }))
    else if (!semantic) checks.push(unknown('content.presentation_grounded', { note: 'presentation text exists but grounding cannot be verified' }))
    else {
      const grounded = new Set(semantic.minimalCaptions.map((c) => c.text))
      const invented = texts.filter((t) => !grounded.has(t.text))
      checks.push(verdict('content.presentation_grounded', invented.length === 0, { texts: texts.length, ungrounded: invented }))
    }
  }

  // 9. presentation rhythm: headline is persistent, but timed explanation/effect changes must keep the mobile screen alive.
  {
    const r = rhythmReport(dynamicCueStarts(i.payload, total), total)
    checks.push(verdict('content.presentation_rhythm', r.ok, { dynamicCueCount: r.dynamicCueCount, minDynamic: r.minDynamic, cueStarts: r.cueStarts, maxGapSeconds: r.maxGapSeconds, allowedMaxGap: r.allowedMaxGap, worstGap: r.worstGap }))
  }

  // 9b. a hook alone is not an explanation: an edit of 10s+ needs at least one timed context/payoff caption, and a
  // headline that is present in the manifest must span the edit from its first frame (it is what the viewer reads first).
  {
    const subs = (i.payload?.subtitleEvents || []).filter((e: any) => String(e?.text || '').trim())
    const need = total >= PRESENTATION_LIMITS.explanationMinTotalSec
    checks.push(verdict('content.explanation_present', !need || subs.length >= 1, { totalSeconds: r2(total), timedExplanationCaptions: subs.length, requiredFrom: PRESENTATION_LIMITS.explanationMinTotalSec }))
    // judged on what is actually drawn: the overlay builder must emit the headline over the whole edit (top band)
    const hl = String(i.payload?.editorialPlan?.headline || '').trim()
    const drawn = assFromPayload({ ...i.payload, totalDuration: total }).events.find((e) => e.kind === 'headline') ?? null
    const spans = !!drawn && drawn.start <= 0.05 && drawn.end >= total - 0.05
    checks.push(verdict('content.headline_present', !!hl && /[가-힣]/.test(hl) && !!drawn && /[가-힣]/.test(drawn.text) && spans, { headline: hl, drawn: drawn ? { text: drawn.text, start: drawn.start, end: drawn.end } : null, total: r2(total) }))
  }

  // 10. length suits the story type.
  {
    const max = storyMaxSeconds(semantic)
    checks.push(verdict('content.length_fit', total >= PLAN_LIMITS.minOutputSeconds && total <= max + 0.01, { seconds: r2(total), min: PLAN_LIMITS.minOutputSeconds, max }))
  }

  return evaluateGate(checks)
}
