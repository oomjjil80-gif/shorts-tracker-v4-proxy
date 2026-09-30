import test from 'node:test'
import assert from 'node:assert/strict'
import { planVariants, toJobPlan, storyBeats, type VariantSpec } from '../lib/media/plan.js'
import { computeHighlights, type SourceAnalysis } from '../lib/media/analyze.js'
import { validateStory, semanticFromStory, type SemanticResult } from '../lib/media/story.js'
import { evaluateContentGate } from '../lib/media/contentGate.js'
import { planPresentation, selectCues, PRESENTATION_LIMITS, type PlacedCue } from '../lib/media/presentation.js'
import { extractRenderPlan } from '../lib/media/render.js'
import { assFromPayload } from '../lib/media/ass.js'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'
import type { SourceFraming } from '../lib/media/framing.js'

function analysis(duration = 30): SourceAnalysis {
  const a: SourceAnalysis = {
    schema: 'source-analysis/1', sourceAssetId: 'src_present_00001', sha256: 'a'.repeat(64),
    media: { duration, width: 576, height: 1024, fps: 30, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', orientation: 'portrait' },
    scenes: [{ start: 0, end: duration }], timeline: Array.from({ length: Math.ceil(duration) }, (_, t) => ({ t, visual: 0.04 + ((t * 7) % 5) / 100, audioDb: -25 })),
    ranges: { black: [], freeze: [], silent: [] }, audio: { silentRatio: 0, intentionallySilent: false },
    highlights: [], usable: [{ start: 0, end: duration }], analyzer: { name: 'ffmpeg-signals', version: 1 }
  }
  a.highlights = computeHighlights(a.timeline)
  return a
}
const FULL: SourceFraming = { mode: 'full', crop: null, confidence: 0, sampleCount: 7, detector: 'luma-bands-v1' }
const cue = (kind: string, start: number, end: number, text: string) => ({ kind, start, end, text, basis: `visible: ${text}` })
// a generous, realistic model answer: MORE cues than the budget allows
const richCues = [
  cue('hook', 2.2, 3.4, '뭐 하는 거지?'),
  cue('context', 2.3, 3.2, '먼저 움직인다'),
  cue('context', 3.8, 5, '조용히 다가온다'), cue('context', 6, 7.5, '멈칫하는 사람'), cue('context', 8.5, 10, '옆을 힐끔 본다'), cue('context', 11, 12.3, '다른 사람도 온다'), cue('context', 13, 14, '모두 모였다'), cue('context', 14.6, 15.5, '다시 움직인다'),
  cue('effect', 7, 7.6, '슥'), cue('effect', 9, 9.6, '휙'), cue('effect', 12, 12.6, '쓱'),
  cue('context', 15.2, 16.0, '끝까지 함께 간다'),
  cue('payoff', 17.2, 18.2, '결국 같이 걷는다')
]
const story = (over: any = {}) => ({
  storyType: 'single_event', confidence: 0.9, causalStart: 2, setupRanges: [{ start: 2, end: 6 }], escalationRanges: [{ start: 6, end: 14 }],
  payoffRange: { start: 16.8, end: 18.3 }, recommendedEnd: 18.5,
  excludeRanges: [{ start: 0, end: 2, reason: 'foreign_text' }] as any[],
  hookStrategy: 'chronological', previewRange: null as any, hookConfidence: 0.2, hookReason: '', minimalCaptions: richCues as any[], publishabilityWarnings: [] as string[], ...over
})
function sem(a: SourceAnalysis, over: any = {}): SemanticResult {
  const v = validateStory(story(over), a, { model: 't', promptVersion: 't' })
  assert.ok(v.story, v.errors.join('; '))
  return semanticFromStory(v.story!)
}
const payloadFor = (a: SourceAnalysis, v: VariantSpec) =>
  compileJobPlan({ jobId: 'job_p', plan: toJobPlan(a.sourceAssetId, v), sourceAsset: { sourceAssetId: a.sourceAssetId, blobPath: 'source-collector/t.mp4', sha256: 'a'.repeat(64), duration: a.media.duration } }).manifest.payload
const status = (g: any, id: string) => g.checks.find((c: any) => c.id === id)?.status
const gate = (a: SourceAnalysis, s: SemanticResult, payload: any) => evaluateContentGate({ payload, analysis: a, semantic: s, framing: FULL })

test('1. hook survives raw-cue trimming and reaches the headline even when the model over-produces cues', () => {
  const a = analysis(); const s = sem(a)
  assert.equal(s.story!.minimalCaptions.filter((c) => c.kind === 'hook').length, 1)
  assert.equal(s.story!.minimalCaptions[0].kind, 'hook')
  const [v1] = planVariants(a, s)
  assert.equal(v1.headline, '뭐 하는 거지?')
  assert.equal(v1.presentation?.hookKept, true)
})

test('2. hook stays the first-priority cue: selectCues never drops it, whatever the budget pressure', () => {
  const mk = (kind: any, outStart: number): PlacedCue => ({ kind, start: outStart, end: outStart + 1, text: `${kind}${outStart}`, basis: 'b', srcStart: outStart, srcEnd: outStart + 1, outStart })
  const crowded = [mk('hook', 0.2), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((t) => mk('context', t)), mk('payoff', 11), mk('effect', 12), mk('effect', 13), mk('effect', 14)]
  const { kept } = selectCues(crowded, 16)
  assert.ok(kept.some((c) => c.kind === 'hook'))
  assert.ok(kept.some((c) => c.kind === 'payoff'), 'payoff outranks context/effect')
  assert.ok(kept.length <= PRESENTATION_LIMITS.totalMessages)
})

test('3. context / payoff / effect counts respect the limits', () => {
  const a = analysis(); const [v1] = planVariants(a, sem(a))
  const kinds = v1.presentation!.kept.map((k) => k.kind)
  assert.equal(kinds.filter((k) => k === 'hook').length, 1)
  assert.ok(kinds.filter((k) => k === 'context').length <= PRESENTATION_LIMITS.contexts)
  assert.ok(kinds.filter((k) => k === 'payoff').length <= PRESENTATION_LIMITS.payoffs)
  assert.ok(kinds.filter((k) => k === 'effect').length <= PRESENTATION_LIMITS.effects)
  assert.ok(kinds.length <= PRESENTATION_LIMITS.totalMessages)
  assert.ok(v1.presentation!.dropped.length > 0, 'over-production is reported, not silent')
})

test('4. every caption stays inside the selected story (cues on excluded footage are never shown)', () => {
  const a = analysis()
  const s = sem(a, { excludeRanges: [{ start: 0, end: 2, reason: 'foreign_text' }, { start: 9, end: 10.5, reason: 'repeat' }, { start: 20, end: 30, reason: 'product_demo' }] })
  const [v1] = planVariants(a, s)
  const beats = v1.beats
  const inside = (t: number) => beats.some((b) => t >= b.trimStart - 1e-6 && t < b.trimEnd)
  for (const e of [...(v1.events || []), ...((v1.effectCaptions || []) as Array<{ start: number; text: string }>)]) assert.ok(inside(e.start), `${e.text} @${e.start} is outside the edit`)
  assert.ok(![...(v1.events || [])].some((e) => e.start >= 9.05 && e.start < 10.45), 'no caption on the removed repeat')
})

test('5. foreign opening is excluded: the edit starts at the clean causalStart', () => {
  const a = analysis(); const s = sem(a)
  const beats = storyBeats(a, s.story!)
  assert.ok(beats[0].trimStart >= 2 - 1e-6)
  const [v1] = planVariants(a, s)
  assert.ok(v1.beats.every((b) => b.trimStart >= 2 - 1e-6))
})

test('6. product-demo tail is excluded and gate-checked', () => {
  const a = analysis(); const s = sem(a)
  const [v1] = planVariants(a, s)
  assert.ok(v1.beats.every((b) => b.trimEnd <= 18.5 + 1e-6))
  const g = gate(a, s, payloadFor(a, v1))
  assert.equal(status(g, 'content.no_offstory_contamination'), 'PASS')
  assert.equal(status(g, 'content.no_post_payoff_tail'), 'PASS')
  const contaminated = { ...v1, beats: [{ label: 'x', trimStart: 2, trimEnd: 26 }] }
  const bad = gate(a, s, payloadFor(a, contaminated))
  assert.notEqual(bad.decision, 'PASS')
})

test('7. an empty presentation can never be publishable', () => {
  const a = analysis(); const s = sem(a)
  const [v1] = planVariants(a, s)
  const bare = { ...v1, headline: undefined, events: undefined, effectCaptions: undefined }
  const g = gate(a, s, payloadFor(a, bare as any))
  assert.notEqual(g.decision, 'PASS')
  assert.equal(status(g, 'content.presentation_grounded'), 'FAIL')
  assert.equal(status(g, 'content.headline_present'), 'FAIL')
})

test('8. a 10s+ edit with only a hook and no explanation is blocked', () => {
  const a = analysis()
  const s = sem(a, { minimalCaptions: [cue('hook', 2.2, 3.4, '뭐 하는 거지?')] })
  const [v1] = planVariants(a, s)
  assert.ok(v1.beats.reduce((t, b) => t + b.trimEnd - b.trimStart, 0) >= PRESENTATION_LIMITS.explanationMinTotalSec)
  assert.equal(v1.presentation!.explanationPresent, false)
  const g = gate(a, s, payloadFor(a, v1))
  assert.notEqual(g.decision, 'PASS')
  assert.equal(status(g, 'content.explanation_present'), 'FAIL')
})

test('9+10 + integration: PLAN → JobPlan → RenderManifest → renderer input keeps hook, context, payoff and effect', () => {
  const a = analysis(); const s = sem(a)
  const [v1] = planVariants(a, s)
  const payload = payloadFor(a, v1)
  // RenderManifest (9)
  assert.equal(payload.editorialPlan.headline, '뭐 하는 거지?')
  const subs = payload.subtitleEvents.map((e: any) => e.text)
  assert.ok(subs.includes('결국 같이 걷는다'), `payoff lost: ${subs}`)
  assert.ok(subs.length >= 2)
  assert.ok(payload.sourceEffectCaptions.length >= 1 && payload.sourceEffectCaptions.length <= PRESENTATION_LIMITS.effects)
  // every timed cue lands inside the output duration and after the clean opening
  const total = extractRenderPlan(payload).total
  for (const e of payload.subtitleEvents) assert.ok(e.start >= 0 && e.end <= total + 0.05 && e.end > e.start)
  // renderer input (10): the ASS script libass receives contains all of it, headline over the entire edit
  const { events, ass } = assFromPayload({ ...payload, totalDuration: total })
  const head = events.find((e) => e.kind === 'headline')!
  assert.equal(head.text, '뭐 하는 거지?'); assert.equal(head.start, 0); assert.ok(head.end >= total - 0.05)
  for (const t of subs) assert.ok(events.some((e) => e.kind === 'subtitle' && e.text === t) && ass.includes(t))
  assert.ok(events.some((e) => e.kind === 'effect'))
  // payoff caption timing matches the payoff scene in output time
  const payoffEv = payload.subtitleEvents.find((e: any) => e.text === '결국 같이 걷는다')
  const p = s.story!.payoffRange
  let clock = 0, outPayoff = -1
  for (const c of extractRenderPlan(payload).cuts) { if (p.start < c.trimStart + c.duration && p.end > c.trimStart) { outPayoff = clock + Math.max(0, p.start - c.trimStart); break } clock += c.duration }
  assert.ok(payoffEv.start >= outPayoff - 0.05 && payoffEv.start <= outPayoff + (p.end - p.start) + 0.05, `payoff caption ${payoffEv.start} vs scene ${outPayoff}`)
  // and the gate agrees this is complete
  const g = gate(a, s, payload)
  assert.equal(g.decision, 'PASS', JSON.stringify(g.reasons))
})

test('preview-first edit: headline pinned to the first frame; payoff caption sits on the story occurrence, not the preview clip', () => {
  const a = analysis()
  const s = sem(a, { hookStrategy: 'preview', previewRange: { start: 15, end: 17 }, hookConfidence: 0.9, hookReason: 'payoff is instantly readable', minimalCaptions: [...richCues, cue('effect', 18.0, 18.3, '쓱')] })
  const pv = planVariants(a, s).find((v) => v.kind === 'preview')
  assert.ok(pv, 'preview variant offered')
  const { report } = planPresentation(pv!.beats, s.story!.minimalCaptions, { pinHook: true })
  assert.equal(report.kept.find((k) => k.kind === 'hook')!.outStart, 0)
  const payoff = report.kept.find((k) => k.kind === 'payoff')
  assert.ok(payoff && payoff.outStart >= 2, 'payoff caption is not stuck on the 2s preview clip')
})

test('a rhythm gap of > 3.2s is reported, not silently accepted', () => {
  const a = analysis()
  const s = sem(a, { minimalCaptions: [cue('hook', 2.2, 3.4, '뭐 하는 거지?'), cue('payoff', 17.2, 18.2, '결국 같이 걷는다')] })
  const [v1] = planVariants(a, s)
  assert.equal(v1.presentation!.rhythm.ok, false)
  assert.equal(status(gate(a, s, payloadFor(a, v1)), 'content.presentation_rhythm'), 'FAIL')
})


test('director density: a 20s+ edit cannot pass with only three dynamic information points', () => {
  const a = analysis(30)
  const sparse = sem(a, { recommendedEnd: 24.5, payoffRange: { start: 21, end: 24 }, escalationRanges: [{ start: 6, end: 21 }], excludeRanges: [{ start: 0, end: 2, reason: 'foreign_text' }], minimalCaptions: [
    cue('hook', 2.2, 3.2, '무슨 일이 생길까?'),
    cue('context', 5, 6.2, '한 사람이 움직인다'),
    cue('context', 12, 13.2, '다른 사람도 본다'),
    cue('payoff', 21, 22.4, '결국 모두 따라간다'),
    cue('context', 23.2, 24.0, '끝까지 함께 간다')
  ] })
  const [v1] = planVariants(a, sparse)
  assert.ok(v1.beats.reduce((t,b)=>t+b.trimEnd-b.trimStart,0) >= 20)
  assert.equal(v1.presentation!.rhythm.ok, false)
  assert.ok(v1.presentation!.rhythm.minDynamic >= 6)
  assert.equal(status(gate(a, sparse, payloadFor(a, v1)), 'content.presentation_rhythm'), 'FAIL')
})

test('director density: a 20s+ edit with grounded cues distributed about every 3s can pass rhythm', () => {
  const a = analysis(30)
  const dense = sem(a, { recommendedEnd: 24.5, payoffRange: { start: 21, end: 24 }, escalationRanges: [{ start: 6, end: 21 }], excludeRanges: [{ start: 0, end: 2, reason: 'foreign_text' }], minimalCaptions: [
    cue('hook', 2.2, 3.2, '무슨 일이 생길까?'),
    cue('context', 3.5, 4.5, '먼저 움직인다'),
    cue('context', 6.5, 7.5, '옆에서도 본다'),
    cue('effect', 9.5, 10.1, '슥'),
    cue('context', 12.5, 13.5, '한 명 더 합류'),
    cue('context', 15.5, 16.5, '줄이 길어진다'),
    cue('effect', 18.5, 19.1, '멈칫'),
    cue('payoff', 21, 22.4, '결국 모두 따라간다')
  ] })
  const [v1] = planVariants(a, dense)
  assert.equal(v1.presentation!.rhythm.ok, true, JSON.stringify(v1.presentation))
  assert.ok(v1.presentation!.rhythm.dynamicCueCount >= 6)
})
