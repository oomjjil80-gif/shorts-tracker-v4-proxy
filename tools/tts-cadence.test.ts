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

// ── 과금 안전성: 여러 인스턴스·응답 유실·저장 실패 (공유 저장소의 원자적 claim, 무료 stand-in) ──
import { TtsPendingError, TtsUnknownError, TtsBudgetError, ttsCacheLookup } from '../lib/generative/narration.js'
const instance = (blobs: any, tts: any, extra: any = {}) => (text: string, o: any = {}) => cachedTts({ blobs, voice, text, tts, apiKey: 'k', inflight: new Map(), wait: { waitMs: 400, pollMs: 10, staleMs: 60_000 }, ...extra, ...o })
const mp3 = (text: string) => ({ bytes: Buffer.from(`mp3:${text}`), contentType: 'audio/mpeg', provider: 'standin', model: 'm' })

test('독립 인스턴스 둘이 같은 문구를 동시에 요청해도 공급자는 한 번만 호출된다 (공유 저장소 claim)', async () => {
  const blobs: any = createMemoryBlobStore(); let calls = 0
  const tts = async (t: string) => { calls++; await new Promise((r) => setTimeout(r, 40)); return mp3(t) }
  const a = instance(blobs, tts), b = instance(blobs, tts) // 각자 별도 process-local Map = 독립 인스턴스
  const [x, y, z] = await Promise.all([a('독립 인스턴스 문장입니다.'), b('독립 인스턴스 문장입니다.'), instance(blobs, tts)('독립 인스턴스 문장입니다.')])
  assert.equal(calls, 1); assert.deepEqual([x, y, z].map((r) => r.cache).sort(), ['HIT', 'HIT', 'MISS']); assert.equal(new Set([x, y, z].map((r) => r.ref)).size, 1)
  assert.ok([...blobs.files.keys()].some((k: string) => /^tts-flight\/.+\.g0\.result\.json$/.test(k)), '결과가 공유 저장소에 남는다(재시작 뒤에도 확인 가능)')
})

test('응답 유실(연결 끊김·시간 초과)은 자동 재호출하지 않고, 다른 인스턴스·재시작 뒤에도 재과금 가능한 호출을 보류한다', async () => {
  const blobs: any = createMemoryBlobStore(); let calls = 0
  const lost = async () => { calls++; throw new Error('socket hang up') } // 공급자가 처리했는지 알 수 없는 실패
  await assert.rejects(instance(blobs, lost)('유실되는 문장입니다.'), (e: any) => e instanceof TtsUnknownError)
  assert.equal(calls, 1, '같은 요청 안에서도 알 수 없는 실패는 다시 부르지 않는다')
  const ok = async (t: string) => { calls++; return mp3(t) }
  await assert.rejects(instance(blobs, ok)('유실되는 문장입니다.'), (e: any) => e instanceof TtsUnknownError) // 다른 인스턴스/재시작
  await assert.rejects(instance(blobs, ok)('유실되는 문장입니다.'), (e: any) => e instanceof TtsUnknownError)
  assert.equal(calls, 1, '보류: 재과금 가능한 호출 없음')
  const forced = await instance(blobs, ok)('유실되는 문장입니다.', { forceRegenerate: true, flightId: 'approval-1' }) // 승인된 강제 재생성만 새로 호출
  assert.equal(forced.cache, 'MISS'); assert.equal(calls, 2)
  assert.equal((await instance(blobs, ok)('유실되는 문장입니다.')).cache, 'HIT') // 이후 일반 요청은 새 캐시 사용
})

test('공급자가 오류로 답한 실패(failed_safe)만 새 시도를 허용하고, 생성 성공 뒤 캐시 저장 실패는 기록으로 복구한다', async () => {
  const blobs: any = createMemoryBlobStore(); let calls = 0
  const rejected = async () => { calls++; throw new Error('speech generation failed 400: {"error":{"code":"bad_request"}}') }
  await assert.rejects(instance(blobs, rejected)('거절되는 문장입니다.'))
  assert.equal(calls, 1) // 4xx 응답: 생성되지 않았음이 확실
  const ok = async (t: string) => { calls++; return mp3(t) }
  assert.equal((await instance(blobs, ok)('거절되는 문장입니다.')).cache, 'MISS'); assert.equal(calls, 2) // 새 시도 허용
  // 생성은 성공했지만 캐시(json) 저장만 계속 실패: 호출은 한 번뿐이고 다른 인스턴스가 기록에서 복구
  const flaky: any = { ...blobs, files: blobs.files, binaries: blobs.binaries }
  const store = createMemoryBlobStore() as any
  const failingCache = { ...store, getJson: store.getJson, claim: store.claim, getBytes: store.getBytes, putBytes: store.putBytes, putJson: async (p: string, v: any, o: any) => { if (p.startsWith('generative-cache/tts/')) throw new Error('cache write down'); return store.putJson(p, v, o) } }
  calls = 0
  const first = await instance(failingCache, ok)('저장이 실패하는 문장입니다.')
  assert.equal(first.cache, 'MISS'); assert.equal(calls, 1)
  assert.equal(await ttsCacheLookup(failingCache as any, voice, '저장이 실패하는 문장입니다.'), null, '캐시 json은 없다')
  const second = await instance(failingCache, ok)('저장이 실패하는 문장입니다.') // 독립 인스턴스: 기록(done)에서 복구, 재호출 없음
  assert.equal(second.cache, 'HIT'); assert.equal(second.ref, first.ref); assert.equal(calls, 1)
  // 오디오 파일 자체를 저장하지 못하면(과금됐을 수 있음) 자동으로 다시 부르지 않는다
  const noBytes = { ...store, getJson: store.getJson, claim: store.claim, getBytes: store.getBytes, putJson: store.putJson, putBytes: async () => { throw new Error('storage down') } }
  calls = 0
  await assert.rejects(instance(noBytes, ok)('파일 저장이 실패하는 문장입니다.'), (e: any) => e instanceof TtsUnknownError)
  await assert.rejects(instance(noBytes, ok)('파일 저장이 실패하는 문장입니다.'), (e: any) => e instanceof TtsUnknownError)
  assert.equal(calls, 1)
})

test('진행 중인 다른 요청은 기다리고(호출 없음), 끝났는지 알 수 없는 오래된 요청은 보류하며, 승인된 호출 횟수를 넘지 않는다', async () => {
  const blobs: any = createMemoryBlobStore(); let calls = 0
  const never = async (t: string) => { calls++; await new Promise(() => {}); return mp3(t) } // 응답이 오지 않는 소유자
  void instance(blobs, never)('오래 걸리는 문장입니다.')
  await new Promise((r) => setTimeout(r, 30))
  const ok = async (t: string) => { calls++; return mp3(t) }
  await assert.rejects(instance(blobs, ok, { wait: { waitMs: 60, pollMs: 10, staleMs: 60_000 } })('오래 걸리는 문장입니다.'), (e: any) => e instanceof TtsPendingError)
  assert.equal(calls, 1, '진행 중인 호출에 합류만 한다')
  await assert.rejects(instance(blobs, ok, { wait: { waitMs: 60, pollMs: 10, staleMs: 20 } })('오래 걸리는 문장입니다.'), (e: any) => e instanceof TtsUnknownError) // 소유자가 사라진 것으로 간주: 자동 재호출 없음
  assert.equal(calls, 1)
  // 승인된 호출 횟수(budget): 2개만 승인하면 세 번째 새 문구는 공급자 호출 전에 거절, 캐시·합류는 횟수를 쓰지 않는다
  calls = 0
  const budget = { remaining: 2 }, shared: any = createMemoryBlobStore(), inflight = new Map() // 한 요청 = 한 인스턴스의 하나의 Map
  const r = (t: string) => cachedTts({ blobs: shared, voice, text: t, tts: ok as any, apiKey: 'k', budget, inflight })
  await Promise.all([r('가 문장입니다.'), r('가 문장입니다.'), r('나 문장입니다.')])
  assert.equal(calls, 2); assert.equal(budget.remaining, 0)
  await assert.rejects(r('다 문장입니다.'), (e: any) => e instanceof TtsBudgetError); assert.equal(calls, 2)
  assert.equal((await r('가 문장입니다.')).cache, 'HIT')
})
