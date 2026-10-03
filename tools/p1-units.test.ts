import test from 'node:test'
import assert from 'node:assert/strict'
import { assTime, assColor, buildAss, fitFontSize, sanitizeText, SAFE } from '../lib/media/ass.js'
import { chronologicalBeats, planVariants, validateVariant, variantDistance, toJobPlan, PLAN_LIMITS } from '../lib/media/plan.js'
import { computeHighlights, subtractIntervals, type SourceAnalysis } from '../lib/media/analyze.js'
import { aiAnalyzeStory, AI_PLANNER_PROMPT_VERSION } from '../lib/media/aiPlanner.js'
import { createPlanExecutor } from '../worker/stages/plan.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'

function analysis(over: Partial<SourceAnalysis> & { duration?: number; visual?: (t: number) => number } = {}): SourceAnalysis {
  const duration = over.duration ?? 30
  const vis = over.visual ?? (() => 0.05)
  return {
    schema: 'source-analysis/1', sourceAssetId: 'src_unit_00001', sha256: 'a'.repeat(64),
    media: { duration, width: 576, height: 1024, fps: 30, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', orientation: 'portrait' },
    scenes: [{ start: 0, end: duration }], timeline: Array.from({ length: duration }, (_, t) => ({ t, visual: vis(t), audioDb: -25 })),
    ranges: { black: [], freeze: [], silent: [] }, audio: { silentRatio: 0, intentionallySilent: false },
    highlights: [], usable: [{ start: 0, end: duration }], analyzer: { name: 'ffmpeg-signals', version: 1 }, ...over
  } as SourceAnalysis
}

test('ass: time format, color order, emoji removal, text escaping', () => {
  assert.equal(assTime(3725.456), '1:02:05.46'); assert.equal(assTime(-1), '0:00:00.00')
  assert.equal(assColor('#FFD928'), '&H0028D9FF'); assert.equal(assColor('nonsense'), '&H00FFFFFF')
  assert.equal(sanitizeText('퍽! 😱 {x}\nok'), '퍽! (x)\\Nok')
  assert.ok(fitFontSize('가'.repeat(60), 900, 84, 2, 40) < 84)
  assert.equal(fitFontSize('짧다', 900, 60, 3), 60)
})

test('ass: overlays are clamped to the output timeline; callouts suppress subtitles beneath them', () => {
  const { events, ass } = buildAss({ totalDuration: 10, headline: '제목', subtitles: [{ start: 1, end: 6, text: '자막' }], callouts: [{ start: 2, end: 3, text: '!', suppressSubtitle: true }], effects: [{ text: '쾅', start: 9, end: 14 }] })
  assert.ok(events.every((e) => e.start >= 0 && e.end <= 10))
  assert.deepEqual(events.filter((e) => e.kind === 'subtitle').map((e) => [e.start, e.end]), [[1, 2], [3, 6]])
  assert.equal(events.find((e) => e.kind === 'effect')!.end, 10)
  assert.match(ass, /PlayResX: 1080/); assert.match(ass, /PlayResY: 1920/)
  assert.deepEqual(buildAss({ totalDuration: 5 }).events, [], 'no text => no overlays (nothing forced onto a video)')
  assert.ok(SAFE.bottom < 0.9 && SAFE.left > 0)
})

test('plan: quiet uniform footage is kept whole; dead air in an otherwise active clip is trimmed; total is capped', () => {
  const uniform = analysis({ visual: () => 0.002 })
  const b0 = chronologicalBeats(uniform)
  assert.ok(b0.reduce((s, b) => s + b.trimEnd - b.trimStart, 0) >= 28, 'static camera footage is not gutted')
  const gap = analysis({ visual: (t) => (t >= 10 && t < 18 ? 0 : 0.2), timeline: undefined as any })
  gap.timeline = gap.timeline ?? Array.from({ length: 30 }, (_, t) => ({ t, visual: t >= 10 && t < 18 ? 0 : 0.2, audioDb: t >= 10 && t < 18 ? -70 : -25 }))
  const beats = chronologicalBeats(gap)
  const total = beats.reduce((s, b) => s + b.trimEnd - b.trimStart, 0)
  assert.ok(total < 26, `dead air trimmed (${total}s)`)
  const long = analysis({ duration: 120, visual: (t) => 0.1 + (t % 7) / 100 })
  const v = planVariants(long)
  assert.ok(v.every((x) => x.beats.reduce((s, b) => s + b.trimEnd - b.trimStart, 0) <= PLAN_LIMITS.maxOutputSeconds + 0.01))
})

test('plan: without a validated story there is exactly one chronological cut — never a hook-first edit from visual activity', () => {
  const peakLate = analysis({ duration: 30, visual: (t) => (t >= 22 && t < 25 ? 0.9 : 0.05) })
  peakLate.highlights = computeHighlights(peakLate.timeline)
  const vs = planVariants(peakLate)
  assert.equal(vs.length, 1)
  assert.equal(vs[0].kind, 'chronological')
  assert.ok(vs[0].beats[0].trimStart < 1, 'opens at the start, not at the activity peak')
  for (let i = 1; i < vs[0].beats.length; i++) assert.ok(vs[0].beats[i].trimStart >= vs[0].beats[i - 1].trimEnd, 'source order')
  assert.deepEqual(vs[0].events ?? [], [], 'no text without a grounded story')
  const same = [{ label: 'a', trimStart: 0, trimEnd: 10 }]
  assert.equal(variantDistance(same, same), 0)
})

test('plan validation rejects out-of-range, too-short, black-covering, over-long and invalid presentation plans', () => {
  const a = analysis({ ranges: { black: [{ start: 5, end: 8 }], freeze: [], silent: [] } })
  const ok = { id: 'v1', label: 'x', rationale: '', beats: [{ label: 'a', trimStart: 0, trimEnd: 4 }] }
  assert.deepEqual(validateVariant(ok, a), [])
  assert.ok(validateVariant({ ...ok, beats: [{ label: 'a', trimStart: 28, trimEnd: 40 }] }, a).some((e) => /outside source/.test(e)))
  assert.ok(validateVariant({ ...ok, beats: [{ label: 'a', trimStart: 1, trimEnd: 1.2 }] }, a).some((e) => /shorter/.test(e)))
  assert.ok(validateVariant({ ...ok, beats: [{ label: 'a', trimStart: 4, trimEnd: 9 }] }, a).some((e) => /black/.test(e)))
  assert.ok(validateVariant({ ...ok, headline: 'x'.repeat(41) }, a).some((e) => /headline/.test(e)))
  assert.ok(validateVariant({ ...ok, events: [{ start: 2, end: 1, text: 'a' }] }, a).length > 0)
  assert.ok(validateVariant({ ...ok, effectCaptions: [{ start: 1, end: 2, text: '가'.repeat(9) }] }, a).some((e) => /effect/.test(e)))
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 4 }]), [{ start: 0, end: 2 }, { start: 4, end: 10 }])
  const jp = toJobPlan('src_unit_00001', { ...ok, headline: 'H', events: [{ start: 1, end: 2, text: 't' }] })
  assert.deepEqual([jp.schema, jp.profile, jp.variantPlan.plansTimeDomain, jp.variantPlan.headline], ['job-plan/1', 'source_shorts', 'source', 'H'])
})

const okStory = {
  storyType: 'single_event', confidence: 0.9, causalStart: 1, setupRanges: [{ start: 1, end: 6 }], escalationRanges: [{ start: 6, end: 14 }],
  payoffRange: { start: 14, end: 19 }, recommendedEnd: 19.5, excludeRanges: [{ start: 22, end: 30, reason: 'product_demo' }],
  hookStrategy: 'chronological', previewRange: null, hookConfidence: 0.2, hookReason: 'short causal event',
  openingHook: { start: 1, end: 2.8, text: '왜 저러는 걸까?', basis: 'person visibly follows the device' },
  minimalCaptions: [
    { kind: 'context', start: 6.5, end: 8, text: '갑자기 기어가기 시작', basis: 'person visibly crawls' },
    { kind: 'effect', start: 9, end: 9.8, text: '슥', basis: 'person shifts forward' },
    { kind: 'context', start: 10.5, end: 12, text: '아이도 보고 있다', basis: 'child visibly watches' },
    { kind: 'payoff', start: 15, end: 17, text: '결국 따라간다', basis: 'child crawls after the person' }
  ], publishabilityWarnings: []
}
const fakeFetch = (body: any, status = 200) => (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch
const JPEG = Buffer.from('fake-jpeg')

test('semantic story model: required provider hook normalizes to StoryAnalysis; failures never fake PASS', async () => {
  const a = analysis()
  const good = await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: JPEG, fetchImpl: fakeFetch({ model: 'gpt-x', output_text: JSON.stringify(okStory), usage: { total_tokens: 5 } }) })
  assert.equal(good.status, 'ok'); assert.equal(good.model, 'gpt-x'); assert.equal(good.story!.payoffRange.end, 19)
  assert.equal(good.story!.minimalCaptions.filter((c) => c.kind === 'hook').length, 1)
  assert.equal(good.story!.minimalCaptions[0].text, '왜 저러는 걸까?')
  assert.equal((await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: JPEG, fetchImpl: fakeFetch({ output_text: 'not json' }) })).status, 'invalid')
  const down = await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: JPEG, fetchImpl: fakeFetch({ error: { message: 'quota' } }, 429) })
  assert.equal(down.status, 'failed'); assert.match(down.reason!, /provider 429/)
  const outside = await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: JPEG, fetchImpl: fakeFetch({ output_text: JSON.stringify({ ...okStory, payoffRange: { start: 25, end: 99 } }) }) })
  assert.equal(outside.status, 'invalid'); assert.match(outside.reason!, /outside source/)
  const low = await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: JPEG, fetchImpl: fakeFetch({ output_text: JSON.stringify({ ...okStory, storyType: 'unclear', confidence: 0.3 }) }) })
  assert.equal(low.status, 'low_confidence')
  assert.equal((await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: null, fetchImpl: fakeFetch({}) })).status, 'failed')
})

test('PLAN stage: model failure keeps deterministic plan; success stores story + presentation plan', async () => {
  const blobs = createMemoryBlobStore()
  const a = analysis({ visual: (t) => (t >= 22 && t < 25 ? 0.9 : 0.05) }); a.highlights = computeHighlights(a.timeline)
  const ref = (await blobs.putJson('analysis/x.json', a)).path
  const sheet = (await blobs.putBytes('analysis/keyframes/x.jpg', JPEG, 'image/jpeg')).path
  const job: any = { id: 'job_1', sourceAssetId: a.sourceAssetId, planRev: 0 }
  const previous = async () => ({ outputRef: ref, result: { keyframeSheetRef: sheet } }) as any
  const failing = createPlanExecutor({ openAi: { apiKey: 'k', model: 'm', fetchImpl: fakeFetch({ error: { message: 'down' } }, 500) } })
  const r1: any = await failing.run({ job, blobs, previous, signal: new AbortController().signal } as any)
  assert.equal(r1.result.provider, 'heuristic'); assert.equal(r1.result.semantic.status, 'failed'); assert.match(r1.result.fallback.reason, /provider 500/)
  assert.equal(r1.result.variants.length, 1); assert.equal(r1.planRef, r1.result.variants[0].planRef)
  const none: any = await createPlanExecutor().run({ job, blobs, previous, signal: new AbortController().signal } as any)
  assert.equal(none.result.semantic.status, 'unavailable'); assert.equal(none.result.semantic.storyRef, null)
  const working = createPlanExecutor({ openAi: { apiKey: 'k', model: 'm', fetchImpl: fakeFetch({ model: 'gpt-x', output_text: JSON.stringify(okStory) }) } })
  const r2: any = await working.run({ job, blobs, previous, signal: new AbortController().signal } as any)
  assert.deepEqual([r2.result.provider, r2.result.model, r2.result.fallback, r2.result.promptVersion, r2.result.semantic.status], ['openai', 'gpt-x', null, AI_PLANNER_PROMPT_VERSION, 'ok'])
  const story: any = await blobs.getJson(r2.result.semantic.storyRef)
  assert.equal(story.schema, 'story-analysis/1')
  const stored: any = await blobs.getJson(r2.planRef)
  assert.ok(stored.variantPlan.beats.every((b: any) => b.trimEnd <= 19.5 + 1e-6))
  assert.equal(stored.variantPlan.headline, '왜 저러는 걸까?')
  assert.deepEqual(stored.variantPlan.events.map((e: any) => e.text), ['갑자기 기어가기 시작', '아이도 보고 있다', '결국 따라간다'])
  assert.equal(stored.variantPlan.effectCaptions, undefined) // Common Shorts: effect cues are not drawn, so not planned
  assert.equal(stored.variantPlan.plansTimeDomain, 'source'); assert.equal(stored.variantPlan.timeDomain, undefined) // timeDomain only accompanies effect captions
  await assert.rejects(() => createPlanExecutor().run({ job, blobs, previous: async () => null, signal: new AbortController().signal } as any), /ANALYZE/)
})
