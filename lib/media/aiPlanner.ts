// Semantic story analysis. The model describes story structure in source time; deterministic code cuts the video.
// One bounded repair call is allowed only when the first structured response is invalid. Low confidence is never
// repaired into confidence. Any unresolved failure => semantic status != ok => content checks UNKNOWN/BLOCK.
import type { SourceAnalysis } from './analyze.js'
import { EXCLUDE_REASONS, STORY_LIMITS, STORY_TYPES, overlap, semanticFromStory, validateStory, type SemanticResult } from './story.js'

export const AI_PLANNER_PROMPT_VERSION = 'source-story-analysis/8'

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
    minimalCaptions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'start', 'end', 'text', 'basis'], properties: { kind: { type: 'string', enum: ['hook', 'context', 'payoff', 'effect'] }, start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' }, basis: { type: 'string' } } } },
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
    'Describe the story structure and a small set of GROUNDED on-screen Korean presentation cues. ALL times are SOURCE seconds within the video duration. Every range MUST have end > start.',
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
    `- minimalCaptions is the presentation layer. Return 3–6 short, visually GROUNDED Korean cues when the edit is >=10s; shorter edits may use 2–4. Never invent facts or fake dialogue.`,
    `  * Exactly one kind="hook" near causalStart (<=${STORY_LIMITS.maxCaptionChars} chars). It becomes the top headline and must explain/question the visible setup immediately.`,
    `  * Add 1–3 kind="context" cues (<=${STORY_LIMITS.maxCaptionChars} chars), spaced across meaningful story changes. They are short explanatory captions, not transcript subtitles.`,
    `  * Add optional kind="payoff" over the actual payoff (<=${STORY_LIMITS.maxCaptionChars} chars) when it sharpens the punchline.`,
    `  * Add 0–2 kind="effect" cues (<=${STORY_LIMITS.maxEffectChars} chars), only when a literal visible motion/reaction supports it. Use Korean onomatopoeia/mimetic words such as "슥", "휙", "멈칫", "힐끔", "쓱" only when they accurately match the visible action. Never sprinkle effects randomly.`,
    '  * Every cue needs a visual basis explaining what on screen justifies the words. Avoid long sentences. Do not repeat the hook as context.',
    '  * Aim for a new timed context/effect/payoff cue roughly every 3–5 seconds of active story so the mobile screen does not feel unattended, while allowing a purposeful quiet beat.',
    '- publishabilityWarnings: remaining issues such as tiny persistent timestamps/watermarks. Put tiny metadata here instead of excluding the story.',
    '- storyType + confidence: be honest; use unclear and low confidence if you cannot tell.',
    'Measured signals (per second: [t, visualChange, audioDb]):', JSON.stringify(signals)
  ].join('\n')
}

export type StoryModelDeps = { apiKey: string; model: string; fetchImpl?: typeof fetch; keyframeJpeg?: Buffer | null; timeoutMs?: number }
export type StoryModelResult = SemanticResult & { model: string; usage: unknown; warnings: string[] }

type Assessed = { story: any | null; errors: string[]; warnings: string[] }

function assessStory(parsed: any, a: SourceAnalysis, model: string): Assessed {
  const v = validateStory(parsed, a, { model, promptVersion: AI_PLANNER_PROMPT_VERSION })
  if (!v.story) return { story: null, errors: v.errors, warnings: v.warnings }
  // A valid but uncertain story must remain low-confidence; do not spend a repair call trying to coerce it into PASS.
  if (v.story.storyType === 'unclear' || v.story.confidence < STORY_LIMITS.minConfidence) return { story: v.story, errors: [], warnings: v.warnings }

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
  }
  return { story: errors.length ? null : v.story, errors, warnings: v.warnings }
}

// Never throws. The first invalid structured answer may be repaired once using the same visual evidence + exact errors.
export async function aiAnalyzeStory(a: SourceAnalysis, deps: StoryModelDeps): Promise<StoryModelResult> {
  const f = deps.fetchImpl ?? fetch
  let model = deps.model, usage: unknown = null
  const usages: unknown[] = []
  const out = (status: SemanticResult['status'], reason: string, warnings: string[] = []): StoryModelResult => ({ status, reason, story: null, model, usage, warnings })
  if (!deps.keyframeJpeg) return out('failed', 'no keyframe sheet: a story cannot be judged from numbers alone')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 90_000)

  const call = async (promptText: string): Promise<{ text?: string; error?: string }> => {
    const content: any[] = [{ type: 'input_text', text: promptText }, { type: 'input_image', image_url: `data:image/jpeg;base64,${deps.keyframeJpeg!.toString('base64')}` }]
    let res: Response
    try {
      res = await f('https://api.openai.com/v1/responses', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.apiKey}` },
        body: JSON.stringify({ model: deps.model, input: [{ role: 'user', content }], text: { format: { type: 'json_schema', name: 'story_analysis', strict: true, schema: STORY_JSON_SCHEMA } } })
      })
    } catch (e: any) { return { error: `provider unreachable: ${String(e?.message || e).slice(0, 200)}` } }
    const data: any = await res.json().catch(() => null)
    if (!res.ok) return { error: `provider ${res.status}: ${String(data?.error?.message || 'error').slice(0, 200)}` }
    model = data?.model || deps.model
    usages.push(data?.usage ?? null)
    usage = usages.length === 1 ? usages[0] : { attempts: usages }
    const text = data?.output_text ?? data?.output?.flatMap((o: any) => o?.content || []).find((c: any) => typeof c?.text === 'string')?.text
    return typeof text === 'string' ? { text } : { error: 'provider returned no text' }
  }

  const parse = (text: string): { parsed?: any; error?: string } => {
    try { return { parsed: JSON.parse(text) } } catch { return { error: 'provider returned invalid JSON' } }
  }

  try {
    const basePrompt = storyPrompt(a)
    const first = await call(basePrompt)
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
        'Return the COMPLETE corrected JSON object. Re-check image timestamps. Every range/cue needs end > start. Keep prominent opening foreign title footage out, tiny CCTV metadata only as a warning, exactly one grounded Korean hook near causalStart, short context cues across meaningful beats, and only grounded effect words.'
      ].join('\n')
      const second = await call(repairPrompt)
      if (second.error || !second.text) return out('invalid', `${assessed.errors.join('; ')}; repair failed: ${second.error || 'no text'}`.slice(0, 500), assessed.warnings)
      const secondParsed = parse(second.text)
      if (secondParsed.error) return out('invalid', secondParsed.error, assessed.warnings)
      assessed = assessStory(secondParsed.parsed, a, model)
      if (!assessed.story) return out('invalid', assessed.errors.join('; ').slice(0, 500), assessed.warnings)
    }

    return { ...semanticFromStory(assessed.story), model, usage, warnings: assessed.warnings }
  } finally { clearTimeout(timer) }
}
