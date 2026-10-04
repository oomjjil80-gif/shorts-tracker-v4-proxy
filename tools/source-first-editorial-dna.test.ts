import test from 'node:test'
import assert from 'node:assert/strict'
import { computeMotionPeaks, type SourceAnalysis } from '../lib/media/analyze.js'
import { storyBeats } from '../lib/media/plan.js'
import { validateStory, type StoryAnalysis } from '../lib/media/story.js'
import { AI_PLANNER_PROMPT_VERSION, storyPrompt } from '../lib/media/aiPlanner.js'

function analysis(): SourceAnalysis {
  return {
    schema: 'source-analysis/1',
    sourceAssetId: 'src_editorial_dna',
    sha256: 'a'.repeat(64),
    media: { duration: 12, width: 720, height: 1280, fps: 30, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', orientation: 'portrait' },
    scenes: [{ start: 0, end: 12 }],
    timeline: Array.from({ length: 12 }, (_, t) => ({ t, visual: 0.04, audioDb: -24 })),
    ranges: { black: [], freeze: [], silent: [] },
    audio: { silentRatio: 0, intentionallySilent: false },
    highlights: [],
    motionPeaks: [{ t: 2.13, score: 0.7 }, { t: 2.71, score: 0.8 }, { t: 3.34, score: 0.75 }],
    usable: [{ start: 0, end: 12 }],
    analyzer: { name: 'ffmpeg-signals', version: 1 }
  }
}

function raw(over: any = {}) {
  return {
    storyType: 'single_event',
    confidence: 0.95,
    causalStart: 0.5,
    setupRanges: [{ start: 0.5, end: 4 }],
    escalationRanges: [{ start: 4, end: 8 }],
    payoffRange: { start: 8, end: 10 },
    recommendedEnd: 10.4,
    excludeRanges: [],
    hookStrategy: 'chronological',
    previewRange: null,
    hookConfidence: 0.9,
    hookReason: 'clean chronological opening',
    minimalCaptions: [
      { kind: 'hook', start: 0.5, end: 1.5, text: '왜 저럴까?', basis: 'subject visibly hesitates' },
      { kind: 'context', start: 4.2, end: 5.2, text: '눈치가 달라졌다', basis: 'subject changes direction' },
      { kind: 'effect', start: 2.0, end: 2.5, text: '퍽!', basis: 'first visible impact' },
      { kind: 'effect', start: 2.6, end: 3.1, text: '퍽!', basis: 'second visible impact' },
      { kind: 'effect', start: 3.2, end: 3.7, text: '퍽!', basis: 'third visible impact' },
      { kind: 'payoff', start: 8.4, end: 9.4, text: '결국 마음이 바뀐다', basis: 'visible resolution' }
    ],
    publishabilityWarnings: [],
    ...over
  }
}

test('analysis keeps distinct precise motion peaks instead of only per-second timing', () => {
  const peaks = computeMotionPeaks([
    { t: 1.03, score: 0.02 }, { t: 1.11, score: 0.7 }, { t: 1.18, score: 0.5 },
    { t: 1.72, score: 0.8 }, { t: 2.31, score: 0.76 }, { t: 3.0, score: 0.01 }
  ], 10, 0.18)
  assert.deepEqual(peaks.map((p) => p.t), [1.11, 1.72, 2.31])
})

test('effect cues snap to distinct measured action peaks: 퍽 퍽 퍽 cannot share one approximate second', () => {
  const a = analysis()
  const v = validateStory(raw(), a, { model: 'fixture', promptVersion: AI_PLANNER_PROMPT_VERSION })
  assert.ok(v.story, v.errors.join('; '))
  const fx = v.story!.minimalCaptions.filter((c) => c.kind === 'effect')
  assert.deepEqual(fx.map((c) => c.start), [2.13, 2.71, 3.34])
  assert.equal(new Set(fx.map((c) => c.start)).size, 3)
  assert.ok(v.warnings.filter((w) => w.includes('measured motion peak')).length >= 3)
})

test('prominent foreign text may not overlap the payoff even briefly', () => {
  const a = analysis()
  const v = validateStory(raw({
    excludeRanges: [{ start: 8.4, end: 8.9, reason: 'foreign_text' }]
  }), a, { model: 'fixture', promptVersion: AI_PLANNER_PROMPT_VERSION })
  assert.equal(v.story, null)
  assert.ok(v.errors.some((e) => /foreign_text.*overlaps payoff/.test(e)), v.errors.join('; '))
})

test('planner defense-in-depth cuts foreign text instead of restoring it to protect payoff', () => {
  const a = analysis()
  const s: StoryAnalysis = {
    schema: 'story-analysis/1', sourceAssetId: a.sourceAssetId, storyType: 'single_event', confidence: 1,
    causalStart: 0.5, setupRanges: [{ start: 0.5, end: 4 }], escalationRanges: [{ start: 4, end: 8 }],
    payoffRange: { start: 8, end: 10 }, recommendedEnd: 10.4,
    excludeRanges: [{ start: 8.4, end: 9.0, reason: 'foreign_text' }],
    hookStrategy: 'chronological', previewRange: null, hookConfidence: 1, hookReason: '',
    minimalCaptions: [], publishabilityWarnings: [], model: 'fixture', promptVersion: 'fixture'
  }
  const beats = storyBeats(a, s)
  assert.ok(beats.length > 0)
  assert.ok(beats.every((b) => b.trimEnd <= 8.4 || b.trimStart >= 9.0), JSON.stringify(beats))
})

test('benchmark prompt explicitly forbids explainer prose, foreign-text flashes, and gives precise hit anchors', () => {
  const p = storyPrompt(analysis())
  assert.equal(AI_PLANNER_PROMPT_VERSION, 'source-story-analysis/16')
  assert.match(p, /BENCHMARK BAR/)
  assert.match(p, /not at the level of an AI explainer/)
  assert.match(p, /ZERO-TOLERANCE FOREIGN TEXT/)
  assert.match(p, /Do NOT shorten its exposure as a workaround/)
  assert.match(p, /motionPeaks/)
  assert.match(p, /use a different peak for each separate hit/)
  assert.doesNotMatch(p, /no effect cues; they are never displayed/)
})
