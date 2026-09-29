// Semantic story analysis (one vision-model call). The model does NOT cut the video: it only describes the story
// structure in source time (causal start, payoff, what to exclude and why, whether a preview hook is safe, at most two
// grounded captions). The deterministic planner builds the edit from it, and validateStory() rejects anything that
// does not fit the measured source. Any failure => semantic status != ok => content checks UNKNOWN (never PASS).
import type { SourceAnalysis } from './analyze.js'
import { EXCLUDE_REASONS, STORY_LIMITS, STORY_TYPES, overlap, semanticFromStory, validateStory, type SemanticResult } from './story.js'

export const AI_PLANNER_PROMPT_VERSION = 'source-story-analysis/6'

const range = { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'number' }, end: { type: 'number' } } }
export const STORY_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['storyType', 'confidence', 'causalStart', 'setupRanges', 'escalationRanges', 'payoffRange', 'recommendedEnd', 'excludeRanges', 'hookStrategy', 'previewRange', 'hookConfidence', 'hookReason', 'minimalCaptions', 'publishabilityWarnings'],
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
    minimalCaptions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'start', 'end', 'text', 'basis'], properties: { kind: { type: 'string', enum: ['hook', 'payoff'] }, start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' }, basis: { type: 'string' } } } },
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
    'You are the story editor for vertical YouTube Shorts cut from ONE source video. The image is a keyframe sheet; each tile is labeled with its SOURCE time in seconds.',
    'Describe the story structure. ALL times are SOURCE seconds within the video duration.',
    'PRIMARY STORY RULE: choose the strongest self-contained viewer story, not the uploader\'s full source-file purpose. Human/animal action, reaction, relationship, humor, surprise or emotion normally outranks a later product explanation/demo when that human/animal arc already has its own payoff.',
    'MANDATORY OPENING AUDIT: inspect the 0s tile and the first ~2 seconds before choosing causalStart. A Korean upload-ready Short must NOT begin on PROMINENT burned-in Chinese/English/Japanese/other foreign-language title cards, large captions, product labels, or other viewer-facing source text. Mark the actual span of that prominent opening text as foreign_text and/or intro_confusion, and place causalStart AFTER it disappears. Even a brief large foreign-language title flash at the first frame is not acceptable as the opening.',
    'FOREIGN-TEXT SCOPE: foreign_text means prominent viewer-facing text that competes with the Korean edit. Do NOT classify a tiny persistent CCTV timestamp/date, camera ID, channel watermark, corner logo, or other small technical metadata as foreign_text that removes footage. If such tiny metadata persists, mention it only in publishabilityWarnings. Never create a foreign_text excludeRange covering most or all of the story merely because small CCTV metadata remains on every frame.',
    'If the first clean frame is only visible on the next timestamped tile, prefer starting at that clean timestamp rather than preserving a few tenths of a second of contaminated footage.',
    'MANDATORY TAIL AUDIT: inspect the final ~35% of the keyframe sheet separately. If people/animals finish their action or leave and the source switches to a product/robot/device operating, cleaning, demonstrating features, returning to dock, showing branding/titles, or otherwise explaining the product, that transition starts off-story footage. Mark it product_demo and/or post_payoff through the file end.',
    'Do NOT treat a late product/device activation, cleaning result, feature demonstration, or return-to-dock as the payoff merely because it explains the preceding joke or is visually active. It is the payoff only when the whole causal story is genuinely a product demonstration and there is no earlier self-contained human/animal payoff.',
    'If a human/animal payoff and a product-demo resolution are both plausible, prefer the human/animal payoff for a viral source-first Short. If you cannot decide confidently, use storyType="unclear" or lower confidence instead of guessing a publishable story.',
    '- causalStart: where the event starts making sense for a first-time viewer, AFTER any prominent opening foreign-language/source title text has disappeared (skip confusing intros, title cards, previews of later moments). Tiny persistent CCTV metadata does not by itself move causalStart.',
    '- setupRanges / escalationRanges / payoffRange: the causal story. payoffRange = the moment the chosen viewer story pays off (the funniest/most surprising/resolving action), NOT a later product demo unless the product demo itself is the primary story.',
    `- recommendedEnd: where the Short should end: right after the payoff (at most ${STORY_LIMITS.maxTailAfterPayoff}s after payoffRange.end). NEVER the file end just because the file continues. For a simple single event, prefer a compact edit around 12–22 seconds when the causal story fits; go longer only when required to understand the setup and payoff.`,
    '- excludeRanges: footage that is not the story: intro_confusion, repeat (same action again), dead_air (nothing happens and it is not needed to understand), product_demo (product/robot/device demo, ads), foreign_text (PROMINENT viewer-facing foreign-language title/caption spans only; NOT tiny persistent CCTV metadata), post_payoff, unrelated.',
    '  IMPORTANT REPEAT RULE: repeat means the SAME subject/action adds no new story information. A second person or animal copying, reacting to, following, interrupting, joining, or escalating the first subject is NOT repeat when that new participant changes the relationship, humor, surprise, or meaning. Keep that beat as escalation/payoff.',
    '  Before labeling footage repeat, compare who is acting and whether the reaction creates a new causal beat. If a new participant creates the punchline, the payoff must include that reaction.',
    '  Do NOT exclude calm moments that are needed to understand the action or the relationship between people.',
    '  When an appended product/demo tail exists, exclude the COMPLETE tail from its transition point to the end, including product text and clean-up/result shots.',
    '- hookStrategy: "chronological" by default. "preview" ONLY if showing a <=3s moment from the escalation/payoff first is clearly understandable on its own AND returning to the start will not confuse; give previewRange and hookConfidence (0..1). Otherwise previewRange=null.',
    `- minimalCaptions: REQUIRED for a publishable source-first Korean Short. Return 1 or 2 short KOREAN captions (<=${STORY_LIMITS.maxCaptionChars} chars), each tied to what is VISIBLE (basis). The FIRST caption must be kind="hook", begin at/just after causalStart, appear within the first ~1 second of the clean edit, and briefly explain or question the visible setup so a Korean viewer instantly understands what to watch. A second kind="payoff" caption is optional when it improves the punchline. No narration, no invented facts, no fake dialogue, no names/places/ages you cannot see. Do NOT return an empty array; if no grounded Korean opening caption can be written, lower confidence or use storyType="unclear".`,
    '- publishabilityWarnings: anything that still makes it hard to publish. Put tiny persistent timestamps/watermarks here instead of excluding the whole story.',
    '- storyType + confidence: be honest; use "unclear" and a low confidence if you cannot tell.',
    'Measured signals (per second: [t, visualChange, audioDb]):', JSON.stringify(signals)
  ].join('\n')
}

export type StoryModelDeps = { apiKey: string; model: string; fetchImpl?: typeof fetch; keyframeJpeg?: Buffer | null; timeoutMs?: number }
export type StoryModelResult = SemanticResult & { model: string; usage: unknown; warnings: string[] }

// Never throws: returns a SemanticResult whose status says why it could not be trusted.
export async function aiAnalyzeStory(a: SourceAnalysis, deps: StoryModelDeps): Promise<StoryModelResult> {
  const f = deps.fetchImpl ?? fetch
  let model = deps.model, usage: unknown = null
  const out = (status: SemanticResult['status'], reason: string, warnings: string[] = []): StoryModelResult => ({ status, reason, story: null, model, usage, warnings })
  if (!deps.keyframeJpeg) return out('failed', 'no keyframe sheet: a story cannot be judged from numbers alone')
  const content: any[] = [{ type: 'input_text', text: storyPrompt(a) }, { type: 'input_image', image_url: `data:image/jpeg;base64,${deps.keyframeJpeg.toString('base64')}` }]
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 90_000)
  try {
    let res: Response
    try {
      res = await f('https://api.openai.com/v1/responses', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.apiKey}` },
        body: JSON.stringify({ model: deps.model, input: [{ role: 'user', content }], text: { format: { type: 'json_schema', name: 'story_analysis', strict: true, schema: STORY_JSON_SCHEMA } } })
      })
    } catch (e: any) { return out('failed', `provider unreachable: ${String(e?.message || e).slice(0, 200)}`) }
    const data: any = await res.json().catch(() => null)
    if (!res.ok) return out('failed', `provider ${res.status}: ${String(data?.error?.message || 'error').slice(0, 200)}`)
    model = data?.model || deps.model; usage = data?.usage ?? null
    const text = data?.output_text ?? data?.output?.flatMap((o: any) => o?.content || []).find((c: any) => typeof c?.text === 'string')?.text
    if (typeof text !== 'string') return out('failed', 'provider returned no text')
    let parsed: any
    try { parsed = JSON.parse(text) } catch { return out('failed', 'provider returned invalid JSON') }
    const v = validateStory(parsed, a, { model, promptVersion: AI_PLANNER_PROMPT_VERSION })
    if (!v.story) return out('invalid', v.errors.join('; ').slice(0, 500), v.warnings)

    // P1 publishability contract: a clean opening + a rendered Korean opening hook are mandatory.
    // This is generic (no source ids/timestamps): if the model sees prominent foreign opening text, it must move causalStart past it.
    const openingProbe = { start: v.story.causalStart, end: Math.min(a.media.duration, v.story.causalStart + 0.5) }
    const openingForeign = v.story.excludeRanges.filter((x) => (x.reason === 'foreign_text' || x.reason === 'intro_confusion') && overlap(x, openingProbe) > 0.03)
    if (openingForeign.length) return out('invalid', `causalStart still overlaps opening contamination: ${openingForeign.map((x) => `${x.reason}:${x.start}-${x.end}`).join(', ')}`.slice(0, 500), v.warnings)

    const hook = v.story.minimalCaptions.find((c) => c.kind === 'hook')
    if (!hook) return out('invalid', 'publishable source-first Short requires one grounded Korean opening hook/context caption', v.warnings)
    if (!/[가-힣]/.test(hook.text)) return out('invalid', 'opening hook/context caption must contain Korean text', v.warnings)
    if (hook.start < v.story.causalStart - 0.05 || hook.start > v.story.causalStart + 1.0) return out('invalid', `opening hook must begin within 1s of causalStart (${v.story.causalStart}), got ${hook.start}`, v.warnings)

    return { ...semanticFromStory(v.story), model, usage, warnings: v.warnings }
  } finally { clearTimeout(timer) }
}
