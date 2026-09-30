import test from 'node:test'
import assert from 'node:assert/strict'
import { aiAnalyzeStory } from '../lib/media/aiPlanner.js'
import type { SourceAnalysis } from '../lib/media/analyze.js'

const a: SourceAnalysis = {
  schema: 'source-analysis/1', sourceAssetId: 'src_repair_00001', sha256: 'a'.repeat(64),
  media: { duration: 30, width: 576, height: 1024, fps: 30, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', orientation: 'portrait' },
  scenes: [{ start: 0, end: 30 }], timeline: Array.from({ length: 30 }, (_, t) => ({ t, visual: 0.1, audioDb: -25 })),
  ranges: { black: [], freeze: [], silent: [] }, audio: { silentRatio: 0, intentionallySilent: false }, highlights: [], usable: [{ start: 0, end: 30 }], analyzer: { name: 'ffmpeg-signals', version: 1 }
}

const base = {
  storyType: 'single_event', confidence: 0.9, causalStart: 1,
  setupRanges: [{ start: 1, end: 6 }], escalationRanges: [{ start: 6, end: 15 }],
  payoffRange: { start: 15, end: 19 }, recommendedEnd: 19.5,
  excludeRanges: [{ start: 0, end: 1, reason: 'foreign_text' }, { start: 20, end: 30, reason: 'product_demo' }],
  hookStrategy: 'chronological', previewRange: null, hookConfidence: 0.1, hookReason: '',
  openingHook: { start: 1, end: 2.5, text: '왜 따라가는 걸까?', basis: 'person is visibly following' },
  minimalCaptions: [
    { kind: 'context', start: 3.0, end: 4.7, text: '먼저 움직이기 시작', basis: 'person visibly starts moving' },
    { kind: 'context', start: 6.5, end: 8, text: '계속 뒤를 따라간다', basis: 'person visibly continues following' },
    { kind: 'context', start: 10.5, end: 12, text: '둘이 같이 걷는다', basis: 'second subject visibly walks alongside' },
    { kind: 'context', start: 13.0, end: 14.5, text: '거리가 더 가까워진다', basis: 'subjects visibly converge' },
    { kind: 'payoff', start: 16, end: 17.5, text: '결국 같이 움직인다', basis: 'second subject visibly joins' },
    { kind: 'effect', start: 18.2, end: 18.9, text: '쓱', basis: 'subjects visibly keep moving' }
  ], publishabilityWarnings: []
}

test('one invalid semantic answer is repaired once using the same evidence', async () => {
  let calls = 0
  const invalid = { ...base, payoffRange: { start: 15, end: 15 }, openingHook: { start: 1, end: 1, text: '왜 따라가는 걸까?', basis: 'person is visibly following' } }
  const fetchImpl = (async (_url: any, init: any) => {
    calls++
    const body = JSON.parse(String(init.body))
    if (calls === 2) assert.match(body.input[0].content[0].text, /CORRECTION REQUIRED/)
    return { ok: true, status: 200, json: async () => ({ model: 'gpt-test', output_text: JSON.stringify(calls === 1 ? invalid : base), usage: { total_tokens: 10 } }) }
  }) as unknown as typeof fetch
  const r = await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: Buffer.from('jpg'), fetchImpl })
  assert.equal(calls, 2)
  assert.equal(r.status, 'ok')
  assert.equal(r.story!.causalStart, 1)
  assert.equal(r.story!.minimalCaptions[0].kind, 'hook')
  assert.equal((r.usage as any).attempts.length, 2)
})

test('low confidence is not retried into a false PASS', async () => {
  let calls = 0
  const fetchImpl = (async () => { calls++; return { ok: true, status: 200, json: async () => ({ model: 'gpt-test', output_text: JSON.stringify({ ...base, confidence: 0.3 }) }) } }) as unknown as typeof fetch
  const r = await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: Buffer.from('jpg'), fetchImpl })
  assert.equal(calls, 1)
  assert.equal(r.status, 'low_confidence')
})
