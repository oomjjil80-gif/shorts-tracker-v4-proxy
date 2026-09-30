import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planVariants, storyBeats, toJobPlan, totalSeconds, validateVariant, chronologicalBeats, type VariantSpec } from '../lib/media/plan.js'
import { computeHighlights, type SourceAnalysis } from '../lib/media/analyze.js'
import { validateStory, semanticFromStory, type SemanticResult } from '../lib/media/story.js'
import { evaluateContentGate } from '../lib/media/contentGate.js'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'
import type { SourceFraming } from '../lib/media/framing.js'

function analysis(o: { duration?: number; visual?: (t: number) => number; audioDb?: (t: number) => number | null; sourceAssetId?: string } = {}): SourceAnalysis {
  const duration = o.duration ?? 30
  const vis = o.visual ?? ((t: number) => 0.04 + ((t * 7) % 5) / 100)
  const a: SourceAnalysis = {
    schema: 'source-analysis/1', sourceAssetId: o.sourceAssetId ?? 'src_content_000001', sha256: 'a'.repeat(64),
    media: { duration, width: 576, height: 1024, fps: 30, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', orientation: 'portrait' },
    scenes: [{ start: 0, end: duration }], timeline: Array.from({ length: Math.ceil(duration) }, (_, t) => ({ t, visual: vis(t), audioDb: o.audioDb ? o.audioDb(t) : -25 })),
    ranges: { black: [], freeze: [], silent: [] }, audio: { silentRatio: 0, intentionallySilent: false },
    highlights: [], usable: [{ start: 0, end: duration }], analyzer: { name: 'ffmpeg-signals', version: 1 }
  }
  a.highlights = computeHighlights(a.timeline)
  return a
}

const presentation = [
  { kind: 'hook', start: 2.2, end: 3.4, text: '왜 저러는 걸까?', basis: 'adult visibly starts an unusual action' },
  { kind: 'context', start: 3.5, end: 4.5, text: '먼저 몸을 낮춘다', basis: 'adult visibly lowers toward the floor' },
  { kind: 'context', start: 5.0, end: 6.5, text: '갑자기 움직이기 시작', basis: 'adult visibly moves across the floor' },
  { kind: 'context', start: 7.5, end: 8.5, text: '옆에서도 지켜본다', basis: 'another person visibly watches' },
  { kind: 'effect', start: 9.0, end: 9.8, text: '슥', basis: 'adult shifts forward' },
  { kind: 'context', start: 10.0, end: 11.5, text: '아이도 보고 있다', basis: 'child visibly watches the adult' },
  { kind: 'context', start: 12.5, end: 13.5, text: '점점 가까워진다', basis: 'people visibly converge' },
  { kind: 'payoff', start: 15.0, end: 16.8, text: '결국 따라간다', basis: 'child visibly follows the adult' },
  { kind: 'effect', start: 17.3, end: 18.0, text: '쓱', basis: 'child visibly keeps moving forward' }
]

const baseStory = {
  storyType: 'single_event', confidence: 0.9, causalStart: 2, setupRanges: [{ start: 2, end: 6 }], escalationRanges: [{ start: 6, end: 14 }],
  payoffRange: { start: 14, end: 18 }, recommendedEnd: 18.5, excludeRanges: [] as any[], hookStrategy: 'chronological', previewRange: null as any, hookConfidence: 0.2,
  hookReason: '', minimalCaptions: presentation as any[], publishabilityWarnings: [] as string[]
}
function semantic(a: SourceAnalysis, over: any = {}): SemanticResult {
  const v = validateStory({ ...baseStory, ...over }, a, { model: 'test', promptVersion: 't' })
  assert.ok(v.story, v.errors.join('; '))
  return semanticFromStory(v.story!)
}
const FULL: SourceFraming = { mode: 'full', crop: null, confidence: 0, sampleCount: 7, detector: 'luma-bands-v1' }
const EMBED: SourceFraming = { mode: 'embedded', crop: { x: 0, y: 302, width: 576, height: 420 }, confidence: 1, sampleCount: 7, detector: 'luma-bands-v1' }
function payloadFor(a: SourceAnalysis, v: VariantSpec) {
  return compileJobPlan({ jobId: 'job_t', plan: toJobPlan(a.sourceAssetId, v), sourceAsset: { sourceAssetId: a.sourceAssetId, blobPath: 'source-collector/t.mp4', sha256: 'a'.repeat(64), duration: a.media.duration } }).manifest.payload
}
const edit = (beats: Array<[number, number]>, extra: Partial<VariantSpec> = {}): VariantSpec => ({ id: 'v1', label: 'x', rationale: '', beats: beats.map(([s, e], i) => ({ label: `b${i}`, trimStart: s, trimEnd: e })), ...extra })
const status = (g: any, id: string) => g.checks.find((c: any) => c.id === id)?.status
const monotonic = (v: VariantSpec) => v.beats.every((b, i) => i === 0 || b.trimStart >= v.beats[i - 1].trimEnd - 1e-6)

test('1. chronological causal clip: story + grounded presentation => content gate PASS', () => {
  const a = analysis(); const s = semantic(a)
  const [v1] = planVariants(a, s)
  assert.equal(v1.kind, 'chronological'); assert.ok(monotonic(v1))
  assert.ok(Math.abs(v1.beats[0].trimStart - 2) < 0.01 && v1.beats[v1.beats.length - 1].trimEnd <= 18.5 + 1e-6)
  assert.equal(v1.headline, '왜 저러는 걸까?')
  assert.ok(v1.events?.some((e) => e.text === '갑자기 움직이기 시작')); assert.ok(v1.events?.some((e) => e.text === '결국 따라간다'))
  assert.deepEqual(v1.effectCaptions?.map((e: any) => e.text), ['슥', '쓱'])
  assert.deepEqual(validateVariant(v1, a), [])
  const g = evaluateContentGate({ payload: payloadFor(a, v1), analysis: a, semantic: s, framing: FULL })
  assert.equal(g.decision, 'PASS', JSON.stringify(g.reasons))
  assert.equal(status(g, 'content.presentation_grounded'), 'PASS')
  assert.equal(status(g, 'content.presentation_rhythm'), 'PASS')
})

test('2. activity peak late / unsafe preview: recommendation remains chronological; preview needs semantic validation', () => {
  const a = analysis({ visual: (t) => (t >= 15 && t < 18 ? 0.9 : 0.03) })
  assert.deepEqual(planVariants(a).map((v) => v.kind), ['chronological'], 'no semantic => no hook-first')
  const unsafe = validateStory({ ...baseStory, hookStrategy: 'preview', previewRange: { start: 15, end: 17 }, hookConfidence: 0.5 }, a, { model: 't', promptVersion: 't' })
  assert.equal(unsafe.story!.hookStrategy, 'chronological'); assert.ok(unsafe.warnings.some((w) => /downgraded/.test(w)))
  assert.ok(planVariants(a, semanticFromStory(unsafe.story!)).every((v) => v.kind !== 'preview'))
  const safe = semantic(a, { hookStrategy: 'preview', previewRange: { start: 15, end: 17 }, hookConfidence: 0.9, hookReason: 'the crawl is instantly readable', minimalCaptions: [...presentation, { kind: 'context', start: 4.0, end: 4.8, text: '처음 움직인다', basis: 'adult visibly begins moving' }] })
  const vs = planVariants(a, safe)
  assert.equal(vs[0].kind, 'chronological')
  assert.ok(vs.find((v) => v.kind === 'preview'))
})

test('3. long tail after payoff is rejected and tail edit BLOCKs', () => {
  const a = analysis()
  const bad = validateStory({ ...baseStory, recommendedEnd: 30 }, a, { model: 't', promptVersion: 't' })
  assert.equal(bad.story, null); assert.ok(bad.errors.some((e) => /after the payoff/.test(e)))
  const s = semantic(a)
  assert.ok(planVariants(a, s)[0].beats.every((b) => b.trimEnd <= 18.5 + 1e-6))
  const g = evaluateContentGate({ payload: payloadFor(a, edit([[2, 30]])), analysis: a, semantic: s, framing: FULL })
  assert.equal(status(g, 'content.no_post_payoff_tail'), 'FAIL'); assert.equal(g.decision, 'BLOCK')
})

test('4. trailing product demo is excluded; keeping it FAILs contamination', () => {
  const a = analysis()
  const s = semantic(a, { excludeRanges: [{ start: 18.5, end: 30, reason: 'product_demo' }, { start: 19, end: 26, reason: 'foreign_text' }] })
  const [v1] = planVariants(a, s)
  assert.ok(v1.beats.every((b) => b.trimEnd <= 18.5 + 1e-6))
  const g = evaluateContentGate({ payload: payloadFor(a, edit([[2, 18.5], [20, 26]])), analysis: a, semantic: s, framing: FULL })
  assert.equal(status(g, 'content.no_offstory_contamination'), 'FAIL')
})

test('5. repeated action is compressed; keeping repeat FAILs pacing', () => {
  const a = analysis()
  const s = semantic(a, { excludeRanges: [{ start: 8, end: 11, reason: 'repeat' }] })
  const [v1] = planVariants(a, s)
  assert.ok(v1.beats.every((b) => b.trimEnd <= 8 + 1e-6 || b.trimStart >= 11 - 1e-6), JSON.stringify(v1.beats))
  assert.ok(Math.abs(totalSeconds(v1.beats) - (18.5 - 2 - 3)) < 0.05)
  const g = evaluateContentGate({ payload: payloadFor(a, edit([[2, 18.5]])), analysis: a, semantic: s, framing: FULL })
  assert.equal(status(g, 'content.no_repeat_or_dead'), 'FAIL')
})

test('6. static CCTV is not gutted; real dead gap outside story is trimmed', () => {
  const quiet = analysis({ visual: () => 0.002 })
  assert.ok(totalSeconds(chronologicalBeats(quiet)) >= 28)
  const s = semantic(quiet)
  assert.ok(Math.abs(totalSeconds(storyBeats(quiet, s.story!)) - 16.5) < 0.05)
  assert.equal(evaluateContentGate({ payload: payloadFor(quiet, planVariants(quiet, s)[0]), analysis: quiet, semantic: s, framing: FULL }).decision, 'PASS')
  const gappy = analysis({ visual: (t) => (t >= 20 && t < 26 ? 0 : 0.2), audioDb: (t) => (t >= 20 && t < 26 ? -70 : -25) })
  const s2 = semantic(gappy, { payoffRange: { start: 26, end: 29 }, recommendedEnd: 29.5, escalationRanges: [{ start: 6, end: 14 }], minimalCaptions: [
    { kind: 'hook', start: 2.2, end: 3.4, text: '무슨 일이 생길까?', basis: 'visible setup' },
    { kind: 'context', start: 7, end: 8.2, text: '움직임이 이어진다', basis: 'visible action' },
    { kind: 'context', start: 13, end: 14.2, text: '아직 끝이 아니다', basis: 'visible action continues' },
    { kind: 'payoff', start: 27, end: 28.2, text: '결국 여기서 끝', basis: 'visible payoff' }
  ] })
  const [v] = planVariants(gappy, s2)
  assert.ok(v.beats.every((b) => b.trimEnd <= 20.6 || b.trimStart >= 25.4), JSON.stringify(v.beats))
})

test('7. semantic UNKNOWN/BAD never becomes publishable; missing framing is UNKNOWN', () => {
  const a = analysis(); const v = planVariants(a)[0]
  for (const sem of [null, { status: 'unavailable', reason: 'no key', story: null }, { status: 'failed', reason: 'provider 500', story: null }, { status: 'invalid', reason: 'bad', story: null }, semanticFromStory(validateStory({ ...baseStory, confidence: 0.3 }, a, { model: 't', promptVersion: 't' }).story!)] as any[]) {
    const g = evaluateContentGate({ payload: payloadFor(a, v), analysis: a, semantic: sem, framing: FULL })
    assert.equal(g.decision, 'BLOCK', JSON.stringify(sem?.status))
    for (const id of ['content.opening_understandable', 'content.payoff_present', 'content.no_post_payoff_tail', 'content.no_offstory_contamination']) assert.equal(status(g, id), 'UNKNOWN', id)
  }
  assert.equal(status(evaluateContentGate({ payload: payloadFor(a, planVariants(a, semantic(a))[0]), analysis: a, semantic: semantic(a), framing: null }), 'content.mobile_foreground'), 'UNKNOWN')
})

test('8. semantic story violations BLOCK: confusing intro, cutoff payoff, tiny foreground', () => {
  const a = analysis()
  const s = semantic(a, { excludeRanges: [{ start: 0, end: 2, reason: 'intro_confusion' }] })
  const intro = evaluateContentGate({ payload: payloadFor(a, edit([[0, 18.5]])), analysis: a, semantic: s, framing: FULL })
  assert.equal(status(intro, 'content.opening_understandable'), 'FAIL')
  const short = evaluateContentGate({ payload: payloadFor(a, edit([[2, 12]])), analysis: a, semantic: s, framing: FULL })
  assert.equal(status(short, 'content.payoff_present'), 'FAIL')
  const tiny: SourceFraming = { ...EMBED, crop: { x: 0, y: 450, width: 576, height: 160 } }
  assert.equal(status(evaluateContentGate({ payload: payloadFor(a, planVariants(a, s)[0]), analysis: a, semantic: s, framing: tiny }), 'content.mobile_foreground'), 'FAIL')
})

test('9. presentation cues are grounded, limited, and paced; invented/sparse presentation FAILs', () => {
  const a = analysis()
  const noBasis = validateStory({ ...baseStory, minimalCaptions: [{ kind: 'hook', start: 2.2, end: 3.5, text: '뭐지?', basis: '' }] }, a, { model: 't', promptVersion: 't' })
  assert.equal(noBasis.story, null)
  const long = validateStory({ ...baseStory, minimalCaptions: [{ kind: 'hook', start: 2.2, end: 3.5, text: '가'.repeat(21), basis: 'x' }] }, a, { model: 't', promptVersion: 't' })
  assert.equal(long.story, null)
  const s = semantic(a)
  const [v] = planVariants(a, s)
  assert.ok(v.headline); assert.ok((v.events || []).length >= 2); assert.equal((v.effectCaptions || [])[0]?.text, '슥')
  const invented = { ...v, headline: '없는 사실입니다' }
  assert.equal(status(evaluateContentGate({ payload: payloadFor(a, invented), analysis: a, semantic: s, framing: FULL }), 'content.presentation_grounded'), 'FAIL')
  const sparse = { ...v, events: [{ start: 15, end: 16.8, text: '결국 따라간다' }], effectCaptions: [] }
  assert.equal(status(evaluateContentGate({ payload: payloadFor(a, sparse), analysis: a, semantic: s, framing: FULL }), 'content.presentation_rhythm'), 'FAIL')
})

test('10. GOLDEN regression: causal story, product tail removed, trend presentation present', () => {
  const g = JSON.parse(readFileSync(new URL('./fixtures/golden-cctv-story.json', import.meta.url), 'utf8'))
  const a = analysis({ duration: g.duration, sourceAssetId: g.sourceAssetId, visual: (t) => 0.03 + ((t * 11) % 7) / 200 })
  a.media.width = g.width; a.media.height = g.height
  const v = validateStory(g.story, a, { model: 'fixture', promptVersion: 't' })
  assert.ok(v.story, v.errors.join('; '))
  const s = semanticFromStory(v.story!); assert.equal(s.status, 'ok')
  const vs = planVariants(a, s); const rec = vs[0]
  assert.equal(rec.kind, 'chronological')
  assert.ok(rec.beats[0].trimStart < 1.0)
  assert.ok(vs.every((x) => x.kind !== 'preview'))
  for (const x of vs) assert.ok(x.beats.every((b) => b.trimEnd <= g.astra.productTailStartsAtSource + 0.5), `${x.id} includes product tail`)
  const secs = totalSeconds(rec.beats); assert.ok(secs >= 15 && secs <= 22, `length ${secs}s`)
  assert.ok(rec.headline && (rec.events || []).length >= 2 && (rec.effectCaptions || []).length >= 1)
  assert.equal(rec.beats.length, g.astra.keepSource.length)
  rec.beats.forEach((b, i) => { assert.ok(Math.abs(b.trimStart - g.astra.keepSource[i][0]) <= 0.3 && Math.abs(b.trimEnd - g.astra.keepSource[i][1]) <= 0.3, JSON.stringify(b)) })
  const content = evaluateContentGate({ payload: payloadFor(a, rec), analysis: a, semantic: s, framing: EMBED })
  assert.equal(content.decision, 'PASS', JSON.stringify(content.reasons))
  const old = edit([[17, 19.5], [0, 31]])
  const oldGate = evaluateContentGate({ payload: payloadFor(a, old), analysis: a, semantic: s, framing: EMBED })
  assert.equal(oldGate.decision, 'BLOCK')
  for (const id of ['content.opening_understandable', 'content.chronology_coherent', 'content.no_post_payoff_tail', 'content.no_offstory_contamination', 'content.no_repeat_or_dead', 'content.length_fit']) assert.equal(status(oldGate, id), 'FAIL', id)
})
