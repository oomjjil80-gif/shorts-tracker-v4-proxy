// Semantic story analysis. The model describes story structure in source time; deterministic code cuts the video.
// One bounded repair call is allowed only when the first structured response is invalid. Low confidence is never
// repaired into confidence. Any unresolved failure => semantic status != ok => content checks UNKNOWN/BLOCK.
import type { SourceAnalysis } from './analyze.js'
import { EXCLUDE_REASONS, OFFSTORY_REASONS, PACING_REASONS, STORY_LIMITS, STORY_TYPES, overlap, semanticFromStory, validateStory, type SemanticResult } from './story.js'
import { planPresentation, PRESENTATION_LIMITS } from './presentation.js'
import { storyBeats, totalSeconds } from './plan.js'

export const AI_PLANNER_PROMPT_VERSION = 'source-story-analysis/11'

const range = { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'number' }, end: { type: 'number' } } }
const captionBody = {
  type: 'object', additionalProperties: false, required: ['start', 'end', 'text', 'basis'],
  properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' }, basis: { type: 'string' } }
}
export const STORY_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['storyType', 'confidence', 'causalStart', 'setupRanges', 'escalationRanges', 'payoffRange', 'recommendedEnd', 'excludeRanges', 'hookStrategy', 'previewRange', 'hookConfidence', 'hookReason', 'openingHook', 'minimalCaptions', 'publishabilityWarnings'],
  properties: {
    storyType: { type: 'string', enum: [...STORY_TYPES] },
    confidence: { type: 'number' },
    causalStart: { type: 'number' },
    setupRanges: { type: 'array', items: range },
    escalationRanges: { type: 'array', items: range },
    payoffRange: range,
    recommendedEnd: { type: 'number' },
    excludeRanges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['start', 'end', 'reason'], properties: { start: { type: 'number' }, end: { type: 'number' }, reason: { type: 'string', enum: [...EXCLUDE_REASONS] } } } },
    hookStrategy: { type: 'string', enum: ['chronological', 'preview'] },
    previewRange: { anyOf: [range, { type: 'null' }] },
    hookConfidence: { type: 'number' },
    hookReason: { type: 'string' },
    // Structurally required: the provider cannot satisfy the schema without a Korean opening hook object.
    openingHook: captionBody,
    minimalCaptions: {
      type: 'array', minItems: 1, maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['kind', 'start', 'end', 'text', 'basis'], properties: { kind: { type: 'string', enum: ['context', 'payoff', 'effect'] }, start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' }, basis: { type: 'string' } } }
    },
    publishabilityWarnings: { type: 'array', items: { type: 'string' } }
  }
}

export function storyPrompt(a: SourceAnalysis): string {
  const signals = {
    durationSec: a.media.duration, hasAudio: a.media.hasAudio,
    scenes: a.scenes, usable: a.usable, black: a.ranges.black, frozen: a.ranges.freeze, silent: a.ranges.silent,
    perSecond: a.timeline.map((s) => [s.t, s.visual, s.audioDb])
  }
  return [
    'You are the story editor and mobile presentation editor for vertical Korean YouTube Shorts cut from ONE source video. The image is a keyframe sheet; each tile is labeled with its SOURCE time in seconds.',
    'Describe the story structure and a small set of GROUNDED on-screen Korean presentation cues. ALL times are SOURCE seconds within the video duration. Every range MUST have end > start by at least 0.5 seconds: a single moment (the payoff, a caption) is a short WINDOW, never start == end.',
    'PRIMARY STORY RULE: choose the strongest self-contained viewer story, not the uploader\'s full source-file purpose. Human/animal action, reaction, relationship, humor, surprise or emotion normally outranks a later product explanation/demo when that human/animal arc already has its own payoff.',
    'MANDATORY OPENING AUDIT: inspect the 0s tile and the first ~2 seconds before choosing causalStart. A Korean upload-ready Short must NOT begin on PROMINENT burned-in Chinese/English/Japanese/other foreign-language title cards, large captions, product labels, or other viewer-facing source text. Mark the actual span of that prominent opening text as foreign_text and/or intro_confusion, and place causalStart AFTER it disappears. Even a brief large foreign-language title flash at the first frame is not acceptable as the opening.',
    'FOREIGN-TEXT SCOPE: foreign_text means prominent viewer-facing text that competes with the Korean edit. Do NOT classify a tiny persistent CCTV timestamp/date, camera ID, channel watermark, corner logo, or other small technical metadata as foreign_text that removes footage. If such tiny metadata persists, mention it only in publishabilityWarnings.',
    'MANDATORY TAIL AUDIT: inspect the final ~35% of the keyframe sheet separately. If people/animals finish their action or leave and the source switches to a product/robot/device operating, cleaning, demonstrating features, returning to dock, showing branding/titles, or otherwise explaining the product, mark that complete tail product_demo and/or post_payoff through the file end.',
    'Do NOT treat a late product/device activation or feature demonstration as the payoff merely because it explains the joke. If a human/animal payoff and product resolution are both plausible, prefer the human/animal payoff. If uncertain, use storyType="unclear" or lower confidence.',
    '- causalStart: first clean moment where the event makes sense, after prominent opening foreign/source title text. Tiny CCTV metadata does not move causalStart.',
    '- setupRanges / escalationRanges / payoffRange: the causal story. payoffRange must have positive duration and be the actual funniest/most surprising/resolving action.',
    `- recommendedEnd: end right after the payoff (at most ${STORY_LIMITS.maxTailAfterPayoff}s after payoffRange.end). For a simple event, a compact ~12–24 second edit is acceptable when the causal story needs it.`,
    '- excludeRanges: intro_confusion, repeat, dead_air, product_demo, foreign_text (PROMINENT viewer-facing spans only), post_payoff, unrelated.',
    '  REPEAT RULE: a second person/animal copying, reacting, following, interrupting or joining is NOT repeat when that new participant changes the humor/meaning; keep it as escalation/payoff.',
    '- hookStrategy: chronological by default. preview ONLY if a <=3s escalation/payoff preview is independently understandable and returning to the start will not confuse.',
    `- openingHook is REQUIRED and structurally separate from the other captions. It must start at/just after causalStart, within the first ~1 second of the clean edit, contain short Korean text (<=${STORY_LIMITS.maxCaptionChars} chars), and be grounded in what is visibly happening. It becomes the persistent top headline. Never leave it blank.`,
    `- minimalCaptions contains 1–5 ADDITIONAL grounded cues only; do NOT put another hook in this array. At most ${PRESENTATION_LIMITS.totalMessages} screen messages are ever shown (hook 1, payoff ${PRESENTATION_LIMITS.payoffs}, context ${PRESENTATION_LIMITS.contexts}, effect ${PRESENTATION_LIMITS.effects}); the hook always has priority. Cues must lie INSIDE the selected story (after causalStart, before recommendedEnd) and NEVER on excluded footage. Any stretch of the final edit longer than ${PRESENTATION_LIMITS.maxDynamicGapSec}s without a new timed cue is rejected.`,
    `  * Add 1–3 kind="context" cues (<=${STORY_LIMITS.maxCaptionChars} chars), spaced across meaningful story changes. They are short explanatory captions, not transcript subtitles.`,
    `  * Add optional kind="payoff" over the actual payoff (<=${STORY_LIMITS.maxCaptionChars} chars) when it sharpens the punchline.`,
    `  * Add 0–2 kind="effect" cues (<=${STORY_LIMITS.maxEffectChars} chars), only when a literal visible motion/reaction supports it. Korean onomatopoeia/mimetic examples: "슥", "휙", "멈칫", "힐끔", "쓱". Never sprinkle effects randomly.`,
    '  * Every cue needs a visual basis explaining what on screen justifies the words. Avoid long sentences.',
    '  * Aim for a new timed context/effect/payoff cue roughly every 3–5 seconds of active story so the mobile screen does not feel unattended, while allowing a purposeful quiet beat.',
    '- publishabilityWarnings: remaining issues such as tiny persistent timestamps/watermarks. Put tiny metadata here instead of excluding the story.',
    '- storyType + confidence: be honest; use unclear and low confidence if you cannot tell.',
    'Measured signals (per second: [t, visualChange, audioDb]):', JSON.stringify(signals)
  ].join('\n')
}

// timeoutMs: budget of the FIRST call. repairTimeoutMs: independent budget of the single repair call (a slow first call
// must never eat into it). signal: stage abort (lease lost / cancel) propagates into whichever call is in flight.
export type StoryModelDeps = { apiKey: string; model: string; fetchImpl?: typeof fetch; keyframeJpeg?: Buffer | null; timeoutMs?: number; repairTimeoutMs?: number; signal?: AbortSignal }
export const STORY_TIMEOUTS = { firstMs: 90_000, repairMs: 60_000 }
export type StoryModelResult = SemanticResult & { model: string; usage: unknown; warnings: string[]; calls?: number }

type Assessed = { story: any | null; errors: string[]; warnings: string[] }

// Model JSON has a required dedicated openingHook. The internal StoryAnalysis keeps a single normalized cue array so
// the rest of PLAN / RenderManifest / QC remains provider-neutral and unchanged.
//
// Deterministic normalization (no model call, no story-meaning change). The strict JSON schema cannot express
// `end > start`, and the model often answers point-in-time cues as start == end. Only these cases are repaired here:
//  - caption/hook display windows of ~zero length: the ANCHOR (start) is the model's; only our display window is sized.
//  - zero-length setup/escalation/exclude ranges: they contain no footage, so dropping them changes nothing.
//  - an unusable previewRange: the preview is optional; chronological is the documented default.
//  - a point payoffRange: only when the model's OWN recommendedEnd ("end right after the payoff") bounds it.
// Everything else (inverted ranges, out-of-source times, missing/ambiguous payoff) is NOT guessed: it goes to the
// bounded repair call, or fails closed.
export const NORMALIZE_LIMITS = { degenerate: 0.2, captionWindow: { hook: 1.2, context: 1.5, payoff: 1.5, effect: 0.6 } as Record<string, number>, maxDerivedPayoffSec: 4, minDerivedPayoffSec: 0.3 }
const r2n = (n: number) => Math.round(n * 100) / 100
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const degenerate = (r: any) => !!r && fin(r.start) && fin(r.end) && r.end >= r.start && r.end - r.start <= NORMALIZE_LIMITS.degenerate

export function normalizeProviderStory(raw: any, durationSec?: number): { story: any; notes: string[] } {
  const notes: string[] = []
  if (!raw || typeof raw !== 'object') return { story: raw, notes }
  const D = fin(durationSec) ? durationSec : Infinity
  const x: any = { ...raw }

  // payoffRange first: caption normalization below depends on it.
  const p = x.payoffRange
  if (degenerate(p) && p.start >= 0 && p.start < D && fin(x.recommendedEnd)) {
    const span = x.recommendedEnd - p.start
    if (span >= NORMALIZE_LIMITS.minDerivedPayoffSec && span <= NORMALIZE_LIMITS.maxDerivedPayoffSec && x.recommendedEnd <= D + 0.05) {
      x.payoffRange = { start: p.start, end: r2n(Math.min(D, x.recommendedEnd)) }
      notes.push(`payoffRange ${p.start}..${p.end} was a point; end taken from the model's own recommendedEnd ${x.recommendedEnd}`)
    }
  }

  const dropEmpty = (key: string) => {
    if (!Array.isArray(x[key])) return
    const kept = x[key].filter((r: any) => !degenerate(r))
    if (kept.length !== x[key].length) notes.push(`${key}: dropped ${x[key].length - kept.length} zero-length range(s)`)
    x[key] = kept
  }
  dropEmpty('setupRanges'); dropEmpty('escalationRanges'); dropEmpty('excludeRanges')

  if (x.previewRange != null && (typeof x.previewRange !== 'object' || degenerate(x.previewRange))) {
    notes.push('previewRange unusable; preview hook dropped, chronological edit kept')
    x.previewRange = null
    x.hookStrategy = 'chronological'
  }

  const widen = (c: any, kind: string): any => {
    if (!c || !degenerate(c) || !(c.start >= 0) || !(c.start < D - 0.25)) return c
    const end = r2n(Math.min(D, c.start + (NORMALIZE_LIMITS.captionWindow[kind] ?? 1)))
    if (end - c.start <= NORMALIZE_LIMITS.degenerate) return c
    notes.push(`${kind} cue "${String(c.text ?? '').slice(0, 12)}" window ${c.start}..${c.end} widened to ${c.start}..${end}`)
    return { ...c, end }
  }
  if (x.openingHook) x.openingHook = widen(x.openingHook, 'hook')
  if (Array.isArray(x.minimalCaptions)) x.minimalCaptions = x.minimalCaptions.map((c: any) => widen(c, String(c?.kind)))

  const h = x.openingHook
  const rest = Array.isArray(x.minimalCaptions) ? x.minimalCaptions : []
  return {
    story: { ...x, minimalCaptions: [...(h ? [{ kind: 'hook', start: h.start, end: h.end, text: h.text, basis: h.basis }] : []), ...rest] },
    notes
  }
}

function assessStory(providerRaw: any, a: SourceAnalysis, model: string): Assessed {
  const { story: parsed, notes } = normalizeProviderStory(providerRaw, a.media.duration)
  const v = validateStory(parsed, a, { model, promptVersion: AI_PLANNER_PROMPT_VERSION })
  v.warnings.unshift(...notes.map((n) => `normalized: ${n}`))
  if (!v.story) return { story: null, errors: v.errors, warnings: v.warnings }
  if (v.story.storyType === 'unclear') return { story: v.story, errors: [], warnings: v.warnings }

  const errors: string[] = []
  const openingProbe = { start: v.story.causalStart, end: Math.min(a.media.duration, v.story.causalStart + 0.5) }
  const openingForeign = v.story.excludeRanges.filter((x) => (x.reason === 'foreign_text' || x.reason === 'intro_confusion') && overlap(x, openingProbe) > 0.03)
  if (openingForeign.length) errors.push(`causalStart still overlaps opening contamination: ${openingForeign.map((x) => `${x.reason}:${x.start}-${x.end}`).join(', ')}`)

  const hook = v.story.minimalCaptions.find((c) => c.kind === 'hook')
  if (!hook) errors.push('publishable source-first Short requires one grounded Korean opening hook/headline')
  else {
    if (!/[가-힣]/.test(hook.text)) errors.push('opening hook/headline must contain Korean text')
    if (hook.start < v.story.causalStart - 0.05 || hook.start > v.story.causalStart + 1.0) errors.push(`opening hook must begin within 1s of causalStart (${v.story.causalStart}), got ${hook.start}`)
  }
  if (v.story.minimalCaptions.filter((c) => c.kind === 'hook').length !== 1) errors.push('exactly one hook/headline caption is required')

  const storySpan = v.story.recommendedEnd - v.story.causalStart
  const narrative = v.story.minimalCaptions.filter((c) => c.kind === 'hook' || c.kind === 'context' || c.kind === 'payoff')
  if (storySpan >= 10 && narrative.length < 2) errors.push('10s+ source-first Short requires hook plus at least one grounded context/payoff cue')

  for (const c of v.story.minimalCaptions) {
    if (c.start < v.story.causalStart - 0.05 || c.end > v.story.recommendedEnd + 0.3) errors.push(`${c.kind} cue ${c.start}-${c.end} lies outside the selected story edit`)
    if (c.kind !== 'effect' && !/[가-힣]/.test(c.text)) errors.push(`${c.kind} cue must contain Korean text`)
    // a cue placed on footage that the same answer excludes can never be shown
    const dead = v.story.excludeRanges.find((x) => (OFFSTORY_REASONS.includes(x.reason) || PACING_REASONS.includes(x.reason)) && overlap(x, c) > 0.5 * (c.end - c.start))
    if (dead && !(c.start >= v.story.payoffRange.start && dead.reason === 'post_payoff')) errors.push(`${c.kind} cue ${c.start}-${c.end} "${c.text}" sits on excluded footage (${dead.reason} ${dead.start}-${dead.end})`)
  }

  // Presentation viability of the edit the planner WILL build from this story. If the headline would not survive, the
  // screen would be unattended for too long, or a 10s+ edit has no explanation, the model must fix it now (repair call)
  // instead of the job ending in a QC block.
  if (!errors.length) {
    const beats = storyBeats(a, v.story)
    const total = totalSeconds(beats)
    const { report } = planPresentation(beats, v.story.minimalCaptions)
    if (!report.hookKept) errors.push(`the opening hook would not appear in the final edit: ${report.hookReason}`)
    if (!report.explanationPresent) errors.push(`the ${total}s edit needs at least one context/payoff caption, not only the hook/effects`)
    if (!report.rhythm.ok) {
      const g = report.rhythm.worstGap
      errors.push(`the ${total}s edit leaves ${report.rhythm.maxGapSeconds}s${g ? ` (edit time ${g.from}-${g.to}s)` : ''} with no new timed caption/effect (allowed ${PRESENTATION_LIMITS.maxDynamicGapSec}s, min ${report.rhythm.minDynamic} timed cue(s)); add grounded context/effect cues at story changes inside the selected story, not on excluded footage`)
    }
  }
  return { story: errors.length ? null : v.story, errors, warnings: v.warnings }
}

// Never throws. The first invalid structured answer may be repaired once using the same visual evidence + exact errors.
// Paid calls: 1 when the first answer is usable (after deterministic normalization), 2 at most. A provider error
// (HTTP error, 429, timeout) on the first call is final: no repair is attempted into a failing provider.
export async function aiAnalyzeStory(a: SourceAnalysis, deps: StoryModelDeps): Promise<StoryModelResult> {
  const f = deps.fetchImpl ?? fetch
  let model = deps.model, usage: unknown = null, calls = 0
  const usages: unknown[] = []
  const out = (status: SemanticResult['status'], reason: string, warnings: string[] = []): StoryModelResult => ({ status, reason, story: null, model, usage, warnings, calls })
  if (!deps.keyframeJpeg) return out('failed', 'no keyframe sheet: a story cannot be judged from numbers alone')

  // One controller + timer PER call, cleaned up in finally. They are never shared.
  const call = async (phase: 'first' | 'repair', promptText: string, timeoutMs: number): Promise<{ text?: string; error?: string }> => {
    const ctl = new AbortController()
    const started = Date.now()
    const onStageAbort = () => ctl.abort()
    if (deps.signal?.aborted) return { error: `provider call not started (${phase}): stage aborted` }
    deps.signal?.addEventListener('abort', onStageAbort, { once: true })
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    calls++
    try {
      const content: any[] = [{ type: 'input_text', text: promptText }, { type: 'input_image', image_url: `data:image/jpeg;base64,${deps.keyframeJpeg!.toString('base64')}` }]
      let res: Response
      try {
        res = await f('https://api.openai.com/v1/responses', {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.apiKey}` },
          body: JSON.stringify({ model: deps.model, input: [{ role: 'user', content }], text: { format: { type: 'json_schema', name: 'story_analysis', strict: true, schema: STORY_JSON_SCHEMA } } })
        })
      } catch (e: any) { return { error: `provider unreachable (${phase} call, ${Date.now() - started}ms of ${timeoutMs}ms): ${String(e?.message || e).slice(0, 200)}` } }
      let data: any = null
      try { data = await res.json() } catch (e: any) { if (ctl.signal.aborted) return { error: `provider unreachable (${phase} call, ${Date.now() - started}ms of ${timeoutMs}ms): response body aborted` } }
      if (!res.ok) return { error: `provider ${res.status} (${phase} call): ${String(data?.error?.message || 'error').slice(0, 200)}` }
      model = data?.model || deps.model
      usages.push(data?.usage ?? null)
      usage = usages.length === 1 ? usages[0] : { attempts: usages }
      const text = data?.output_text ?? data?.output?.flatMap((o: any) => o?.content || []).find((c: any) => typeof c?.text === 'string')?.text
      return typeof text === 'string' ? { text } : { error: `provider returned no text (${phase} call)` }
    } finally { clearTimeout(timer); deps.signal?.removeEventListener('abort', onStageAbort) }
  }

  const parse = (text: string): { parsed?: any; error?: string } => {
    try { return { parsed: JSON.parse(text) } } catch { return { error: 'provider returned invalid JSON' } }
  }

  const basePrompt = storyPrompt(a)
  const first = await call('first', basePrompt, deps.timeoutMs ?? STORY_TIMEOUTS.firstMs)
  if (first.error || !first.text) return out('failed', first.error || 'provider returned no text')
  const firstParsed = parse(first.text)
  let assessed: Assessed
  let previousForRepair: any = null
  if (firstParsed.error) assessed = { story: null, errors: [firstParsed.error], warnings: [] }
  else { previousForRepair = firstParsed.parsed; assessed = assessStory(firstParsed.parsed, a, model) }

  if (!assessed.story) {
    const repairPrompt = [
      basePrompt,
      '',
      'CORRECTION REQUIRED: your previous structured answer was not publishable/valid.',
      `Validation errors: ${assessed.errors.join('; ').slice(0, 1200)}`,
      previousForRepair ? `Previous JSON: ${JSON.stringify(previousForRepair).slice(0, 7000)}` : 'Previous response was not valid JSON.',
      'Return the COMPLETE corrected JSON object. Keep every field of the previous answer that was not named in an error unchanged. Re-check image timestamps. openingHook is mandatory and must be valid Korean text within 1 second of causalStart. Every range/cue needs end > start with at least 0.5 seconds of duration (a moment is a window, never start == end). Keep prominent opening foreign title footage out, tiny CCTV metadata only as a warning, and keep additional context/payoff/effect cues grounded in visible actions.'
    ].join('\n')
    const second = await call('repair', repairPrompt, deps.repairTimeoutMs ?? STORY_TIMEOUTS.repairMs)
    if (second.error || !second.text) return out('invalid', `${assessed.errors.join('; ')}; repair failed: ${second.error || 'no text'}`.slice(0, 700), assessed.warnings)
    const secondParsed = parse(second.text)
    if (secondParsed.error) return out('invalid', `${assessed.errors.join('; ')}; repair: ${secondParsed.error}`.slice(0, 700), assessed.warnings)
    assessed = assessStory(secondParsed.parsed, a, model)
    if (!assessed.story) return out('invalid', assessed.errors.join('; ').slice(0, 700), assessed.warnings)
  }

  return { ...semanticFromStory(assessed.story), model, usage, warnings: assessed.warnings, calls }
}
