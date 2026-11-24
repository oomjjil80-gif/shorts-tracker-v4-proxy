import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slowNarrationClipIndices, narrationCorrectionFactor, cachedTts } from '../lib/generative/narration.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { trackerVoice } from '../lib/generative/trackerTts.js'

test('detects only the unusually stretched clip among comparable narration', () => {
  const clips = Array.from({ length: 8 }, () => ({ chars: 60, seconds: 10 }))
  clips[3] = { chars: 60, seconds: 35 }
  assert.deepEqual(slowNarrationClipIndices(clips), [3])
})
test('normal variation does not warn', () => {
  const clips = [10, 12, 9, 11, 13, 10].map((seconds) => ({ chars: 60, seconds }))
  assert.deepEqual(slowNarrationClipIndices(clips), [])
})
test('short clips and small samples are excluded', () => {
  assert.deepEqual(slowNarrationClipIndices([{ chars: 60, seconds: 40 }]), [])
  assert.deepEqual(slowNarrationClipIndices([
    ...Array.from({ length: 6 }, () => ({ chars: 60, seconds: 10 })),
    { chars: 3, seconds: 100 }
  ]), [])
})

test('bounded offline correction applies only to the anomalous clip', () => {
  const clips = Array.from({ length: 8 }, () => ({ chars: 60, seconds: 10 }))
  clips[3] = { chars: 60, seconds: 23 }
  assert.deepEqual(slowNarrationClipIndices(clips), [3])
  assert.ok(Math.abs(narrationCorrectionFactor(clips, 3)! - 2.3) < 0.001)
  assert.equal(narrationCorrectionFactor(clips, 2), null)
})
test('unsafe slowdown is rejected instead of altering the cached original', () => {
  const clips = Array.from({ length: 8 }, () => ({ chars: 60, seconds: 10 }))
  clips[3] = { chars: 60, seconds: 35 }
  assert.equal(narrationCorrectionFactor(clips, 3), null)
})

// ── B-3 과금 안전성: 같은 문구가 생성 중이면 유료 TTS를 한 번만 부른다 (무료 stand-in, 실제 호출 없음) ──
const AUTO = { voiceProfile: 'auto', voiceTone: 'calm', voiceSpeed: 1, visualStyleProfile: 'auto' }
const voice = trackerVoice({ family: 'economy', format: 'shorts', creative: { requested: AUTO } }).voice
function paidStandIn(opts: { failFirst?: number } = {}) {
  let calls = 0
  const tts = async (text: string) => {
    const n = ++calls
    await new Promise((r) => setTimeout(r, 25)) // 아직 캐시에 쓰기 전인 구간
    if (n <= (opts.failFirst ?? 0)) throw new Error('speech generation failed 500: boom')
    return { bytes: Buffer.from(`mp3:${text}`), contentType: 'audio/mpeg', provider: 'standin', model: 'gpt-4o-mini-tts' }
  }
  return { tts, count: () => calls }
}
test('B-3: the same line requested concurrently (repeated line, double click, retry while running) pays once', async () => {
  const blobs: any = createMemoryBlobStore(), s = paidStandIn()
  const run = (text: string, force = false) => cachedTts({ blobs, voice, text, tts: s.tts as any, apiKey: 'k', forceRegenerate: force })
  const same = await Promise.all([run('네, 맞습니다.'), run('네, 맞습니다.'), run('네, 맞습니다.')]) // 한 요청 안의 같은 대사 / 두 번 클릭
  assert.equal(s.count(), 1)
  assert.deepEqual(same.map((r) => r.cache).sort(), ['HIT', 'HIT', 'MISS'])
  assert.equal(new Set(same.map((r) => r.ref)).size, 1)
  const other = await Promise.all([run('다른 문장입니다.'), run('또 다른 문장입니다.')]) // 서로 다른 문구는 각각 호출
  assert.equal(s.count(), 3); assert.notEqual(other[0].ref, other[1].ref)
  assert.equal((await run('네, 맞습니다.')).cache, 'HIT'); assert.equal(s.count(), 3) // 이후는 기존 캐시
})
test('B-3: a failed call is not remembered, and a deliberate regeneration is not blocked by the cache', async () => {
  const blobs: any = createMemoryBlobStore(), s = paidStandIn({ failFirst: 2 }) // 첫 호출은 기존 정책(일시 오류 1회 재시도)까지 모두 실패
  const run = (text: string, force = false) => cachedTts({ blobs, voice, text, tts: s.tts as any, apiKey: 'k', forceRegenerate: force })
  await assert.rejects(Promise.all([run('실패하는 문장입니다.'), run('실패하는 문장입니다.')])) // 함께 기다린 요청도 같은 실패를 받는다
  assert.equal(s.count(), 2) // 한 번의 공유 호출(시도 2회)뿐: 합류한 요청이 호출을 늘리지 않는다
  assert.equal((await run('실패하는 문장입니다.')).cache, 'MISS'); assert.equal(s.count(), 3) // 실패는 재사용되지 않고 다시 시도
  const forced = await run('실패하는 문장입니다.', true) // 승인된 재생성은 캐시가 있어도 새로 만든다
  assert.equal(forced.cache, 'MISS'); assert.equal(s.count(), 4)
})
