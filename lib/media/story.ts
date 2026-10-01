// Story-level (semantic) understanding of a source clip: what the event is, where it starts making sense, where it
// pays off, and what is NOT part of the story (intro confusion, repeats, dead air, product demo, foreign text, tail).
// It can only come from a vision/semantic model. ffmpeg signals cannot know any of this, so without a validated
// StoryAnalysis every semantic content check is UNKNOWN (never PASS).
import type { SourceAnalysis } from './analyze.js'
import { PRESENTATION_LIMITS } from './presentation.js'

export const STORY_SCHEMA = 'story-analysis/1'
export const STORY_TYPES = ['single_event', 'multi_event', 'compilation', 'unclear'] as const
export const EXCLUDE_REASONS = ['intro_confusion', 'repeat', 'dead_air', 'product_demo', 'foreign_text', 'post_payoff', 'unrelated'] as const
// Reasons that make footage "not the story" (contamination) vs. merely slow/repeated.
export const OFFSTORY_REASONS: ReadonlyArray<ExcludeReason> = ['intro_confusion', 'product_demo', 'foreign_text', 'post_payoff', 'unrelated']
export const PACING_REASONS: ReadonlyArray<ExcludeReason> = ['repeat', 'dead_air']
// Raw-cue caps only bound what a model may return; WHICH cues are shown (budget, priority, spacing) is decided in
// presentation.ts (selectCues), after the edit is known. Nothing here may drop the opening hook.
export const STORY_LIMITS = {
  minConfidence: 0.6,
  previewMinConfidence: 0.75,
  maxPreviewSeconds: 3,
  maxRawCues: 12,
  maxCaptionChars: PRESENTATION_LIMITS.maxCaptionChars,
  maxEffectChars: PRESENTATION_LIMITS.maxEffectChars,
  maxTailAfterPayoff: 1.5
}

export type StoryType = (typeof STORY_TYPES)[number]
export type ExcludeReason = (typeof EXCLUDE_REASONS)[number]
export type Range = { start: number; end: number }
export type StoryCaptionKind = 'hook' | 'context' | 'payoff' | 'effect'
export type StoryCaption = { kind: StoryCaptionKind; start: number; end: number; text: string; basis: string }

export type StoryAnalysis = {
  schema: typeof STORY_SCHEMA
  sourceAssetId: string
  storyType: StoryType
  confidence: number
  causalStart: number
  setupRanges: Range[]
  escalationRanges: Range[]
  payoffRange: Range
  recommendedEnd: number
  excludeRanges: Array<Range & { reason: ExcludeReason }>
  hookStrategy: 'chronological' | 'preview'
  previewRange: Range | null
  hookConfidence: number
  hookReason: string
  // Grounded Korean presentation cues. `hook` becomes the persistent top headline;
  // context/payoff become timed explanation captions; effect becomes a short pop caption.
  minimalCaptions: StoryCaption[]
  publishabilityWarnings: string[]
  model: string
  promptVersion: string
}

// ok = usable for planning AND for PASS-able content checks. Anything else => semantic content checks are UNKNOWN.
export type SemanticStatus = 'ok' | 'unavailable' | 'failed' | 'invalid' | 'low_confidence'
export type SemanticResult = { status: SemanticStatus; reason: string | null; story: StoryAnalysis | null }

const r2 = (n: number) => Math.round(n * 100) / 100
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const overlap = (a: Range, b: Range) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

// Strict validation of raw model output against the measured source. Returns a normalized story or the reasons it
// cannot be trusted. Nothing is "repaired" into existence: out-of-range times are errors, not clamps.
export function validateStory(raw: any, a: SourceAnalysis, meta: { model: string; promptVersion: string }): { story: StoryAnalysis | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = []
  const D = a.media.duration
  const eps = 0.05
  const range = (v: any, label: string): Range | null => {
    if (!v || !isNum(v.start) || !isNum(v.end)) { errors.push(`${label}: not a {start,end} range`); return null }
    if (v.start < -eps || v.end > D + eps) { errors.push(`${label}: ${v.start}..${v.end} outside source 0..${D}`); return null }
    if (!(v.end - v.start > 0.2)) { errors.push(`${label}: empty or inverted range (${v.start}..${v.end}; need end - start > 0.2)`); return null }
    return { start: r2(Math.max(0, v.start)), end: r2(Math.min(D, v.end)) }
  }
  if (!raw || typeof raw !== 'object') return { story: null, errors: ['model output is not an object'], warnings }
  if (!STORY_TYPES.includes(raw.storyType)) errors.push(`storyType ${raw.storyType} invalid`)
  if (!isNum(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) errors.push('confidence must be 0..1')
  if (!isNum(raw.causalStart) || raw.causalStart < 0 || raw.causalStart > D) errors.push('causalStart outside source')
  if (!isNum(raw.recommendedEnd) || raw.recommendedEnd <= 0 || raw.recommendedEnd > D + eps) errors.push('recommendedEnd outside source')
  const payoff = range(raw.payoffRange, 'payoffRange')
  const setup = (Array.isArray(raw.setupRanges) ? raw.setupRanges : []).map((x: any, i: number) => range(x, `setupRanges[${i}]`)).filter(Boolean) as Range[]
  const escalation = (Array.isArray(raw.escalationRanges) ? raw.escalationRanges : []).map((x: any, i: number) => range(x, `escalationRanges[${i}]`)).filter(Boolean) as Range[]
  const excludes: Array<Range & { reason: ExcludeReason }> = []
  for (const [i, x] of (Array.isArray(raw.excludeRanges) ? raw.excludeRanges : []).entries()) {
    const r = range(x, `excludeRanges[${i}]`)
    if (!r) continue
    if (!EXCLUDE_REASONS.includes(x.reason)) { errors.push(`excludeRanges[${i}]: reason ${x.reason} invalid`); continue }
    excludes.push({ ...r, reason: x.reason })
  }
  if (payoff && isNum(raw.causalStart) && isNum(raw.recommendedEnd)) {
    if (!(raw.causalStart < payoff.start + eps)) errors.push('causalStart must precede the payoff')
    if (raw.recommendedEnd < payoff.end - 0.3) errors.push('recommendedEnd cuts the payoff off')
    if (raw.recommendedEnd > payoff.end + STORY_LIMITS.maxTailAfterPayoff + eps) errors.push(`recommendedEnd leaves more than ${STORY_LIMITS.maxTailAfterPayoff}s after the payoff`)
    for (const x of excludes) if (overlap(x, payoff) > 0.3 * (payoff.end - payoff.start)) errors.push(`exclude ${x.reason} ${x.start}..${x.end} removes most of the payoff`)
  }
  for (const r of [...setup, ...escalation]) if (payoff && r.start > payoff.end + eps) errors.push(`story range ${r.start}..${r.end} lies after the payoff`)

  let hookStrategy: 'chronological' | 'preview' = raw.hookStrategy === 'preview' ? 'preview' : 'chronological'
  if (raw.hookStrategy !== 'preview' && raw.hookStrategy !== 'chronological') errors.push(`hookStrategy ${raw.hookStrategy} invalid`)
  const hookConfidence = isNum(raw.hookConfidence) ? raw.hookConfidence : 0
  let previewRange: Range | null = null
  if (hookStrategy === 'preview') {
    const p = raw.previewRange ? range(raw.previewRange, 'previewRange') : null
    const reasons: string[] = []
    if (!p) reasons.push('no valid previewRange')
    else {
      if (p.end - p.start > STORY_LIMITS.maxPreviewSeconds + eps) reasons.push('preview longer than 3s')
      if (payoff && overlap(p, payoff) + escalation.reduce((s, e) => s + overlap(p, e), 0) < 0.8 * (p.end - p.start)) reasons.push('preview is not taken from the escalation/payoff')
      if (excludes.some((x) => OFFSTORY_REASONS.includes(x.reason) && overlap(x, p) > 0.2)) reasons.push('preview overlaps off-story footage')
    }
    if (hookConfidence < STORY_LIMITS.previewMinConfidence) reasons.push(`hookConfidence ${hookConfidence} < ${STORY_LIMITS.previewMinConfidence}`)
    if (reasons.length) { warnings.push(`preview hook downgraded to chronological: ${reasons.join('; ')}`); hookStrategy = 'chronological' }
    else previewRange = p
  }

  const captions: StoryCaption[] = []
  const allowedKinds: StoryCaptionKind[] = ['hook', 'context', 'payoff', 'effect']
  for (const [i, c] of (Array.isArray(raw.minimalCaptions) ? raw.minimalCaptions : []).entries()) {
    const text = String(c?.text ?? '').trim(), basis = String(c?.basis ?? '').trim()
    const r = range(c, `minimalCaptions[${i}]`)
    if (!r) continue
    if (!allowedKinds.includes(c.kind)) { errors.push(`minimalCaptions[${i}]: kind must be hook|context|payoff|effect`); continue }
    const maxChars = c.kind === 'effect' ? STORY_LIMITS.maxEffectChars : STORY_LIMITS.maxCaptionChars
    if (!text || [...text].length > maxChars) { errors.push(`minimalCaptions[${i}]: text must be 1..${maxChars} chars`); continue }
    if (!basis) { errors.push(`minimalCaptions[${i}]: missing visual basis (caption would be invented)`); continue }
    if (/[\n{}]/.test(text)) { errors.push(`minimalCaptions[${i}]: invalid characters`); continue }
    if (c.kind === 'payoff' && payoff && overlap(r, payoff) < 0.5 * (r.end - r.start)) { warnings.push(`minimalCaptions[${i}]: payoff caption outside payoff, dropped`); continue }
    captions.push({ kind: c.kind, start: r.start, end: r.end, text, basis })
  }

  // Exactly one hook is kept (the earliest); the rest of the cues are bounded by a generous raw cap in chronological
  // priority order. The real budget is applied per edit in presentation.ts, never here.
  const hooks = captions.filter((c) => c.kind === 'hook')
  if (hooks.length > 1) warnings.push(`only the first of ${hooks.length} hook cues kept`)
  const rest = captions.filter((c) => c.kind !== 'hook')
  const ordered = [...(hooks[0] ? [hooks[0]] : []), ...rest.sort((x, y) => x.start - y.start)]
  if (ordered.length > STORY_LIMITS.maxRawCues) { warnings.push(`only ${STORY_LIMITS.maxRawCues} cues kept`); ordered.length = STORY_LIMITS.maxRawCues }
  captions.length = 0
  captions.push(...ordered)

  if (errors.length || !payoff) return { story: null, errors: errors.length ? errors : ['payoffRange missing'], warnings }
  return {
    story: {
      schema: STORY_SCHEMA, sourceAssetId: a.sourceAssetId, storyType: raw.storyType, confidence: r2(raw.confidence),
      causalStart: r2(raw.causalStart), setupRanges: setup, escalationRanges: escalation, payoffRange: payoff,
      recommendedEnd: r2(Math.min(D, raw.recommendedEnd)), excludeRanges: excludes, hookStrategy, previewRange, hookConfidence: r2(hookConfidence),
      hookReason: String(raw.hookReason ?? '').slice(0, 300), minimalCaptions: captions,
      publishabilityWarnings: (Array.isArray(raw.publishabilityWarnings) ? raw.publishabilityWarnings : []).map((w: any) => String(w).slice(0, 200)).slice(0, 10),
      model: meta.model, promptVersion: meta.promptVersion
    },
    errors: [], warnings
  }
}

// Turns a validated story into the semantic result the planner/gate consume (low confidence is not trustworthy).
export function semanticFromStory(story: StoryAnalysis): SemanticResult {
  if (story.storyType === 'unclear' || story.confidence < STORY_LIMITS.minConfidence) return { status: 'low_confidence', reason: `storyType=${story.storyType} confidence=${story.confidence}`, story }
  return { status: 'ok', reason: null, story }
}
