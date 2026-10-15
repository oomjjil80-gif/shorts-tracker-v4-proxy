// 확정 대본(fixedScript): 역사·야사 릴스처럼 사용자가 확정한 대본은 PLAN이 다시 쓰지 않는다. 모두 무료(가짜 AI, 네트워크 없음).
// Run: node --import tsx --test tools/fixed-script.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGenerativeBrief, generativeBriefHash } from '../lib/generative/contracts.js'
import { createGenerativePlanExecutor } from '../worker/stages/generative.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { validateWisdomScript } from '../lib/generative/wisdom.js'

const N = [
  '요즘 민원은 스마트폰으로 신청합니다. 조선의 신문고는 어땠을까요?',
  '신문고는 태종 때 설치된 북으로, 억울한 일을 임금에게 알리는 길이었습니다.',
  '하지만 북은 한양에 있었습니다. 지방에 사는 백성에게는 먼 길이었습니다.',
  '곧바로 칠 수 있는 것도 아니었습니다. 원칙적으로 먼저 지방 관청에 호소해야 했습니다.',
  '관청마다 거쳐야 할 절차가 있었고, 그래도 풀리지 않을 때에야 북 앞에 설 수 있었습니다.',
  '그래서 신문고는 있어도, 누구에게나 가까운 길은 아니었다고 평가받습니다.',
  '억울함을 알리는 것조차 쉽지 않았던 시대였습니다.'
]
const fixed = (over: any = {}) => ({ title: '신문고까지 가는 길', stylePrefix: '한국 전통 수묵담채화풍 일러스트, 세로 9:16', beats: N.map((narration, i) => ({ narration, imagePrompt: `장면 ${i + 1} 궁궐 문루 앞의 큰 북과 백성` })), ...over })
const run = async (brief: any, plan: any) => {
  const blobs = createMemoryBlobStore(); await blobs.putJson('brief.json', brief)
  const out: any = await createGenerativePlanExecutor({ apiKey: 'test', plan }).run({ job: { id: 'j', profile: 'wisdom', planRef: 'brief.json', sourceAssetId: 'src_gen_x' } as any, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  return { out, blobs }
}
const never = async () => { throw new Error('AI PLAN must not be called for a fixed script') }

test('A. 확정 대본 입력 검증: 장면 수·길이·시간, 텍스트 자동 생성, 해시가 대본에 묶임, 기존 브리프 모양 불변', () => {
  const b: any = normalizeGenerativeBrief({ fixedScript: fixed(), targetSeconds: 40 })
  assert.equal(b.kind, 'text'); assert.equal(b.fixedScript.beats.length, 7); assert.ok(b.text.includes('신문고까지 가는 길') && b.text.includes(N[6]))
  assert.ok(b.fixedScript.beats.every((x: any) => x.durationSec >= 3 && x.durationSec <= 12))
  assert.notEqual(generativeBriefHash(b), generativeBriefHash(normalizeGenerativeBrief({ fixedScript: fixed({ title: '다른 제목' }), targetSeconds: 40 })))
  for (const bad of [fixed({ beats: fixed().beats.slice(0, 3) }), fixed({ beats: fixed().beats.map((x: any, i: number) => (i ? x : { ...x, narration: 'ㄱ'.repeat(91) })) }), fixed({ beats: fixed().beats.map((x: any, i: number) => (i ? x : { ...x, imagePrompt: '짧음' })) }), fixed({ title: '' })]) assert.throws(() => normalizeGenerativeBrief({ fixedScript: bad }), /fixedScript/)
  const plain: any = normalizeGenerativeBrief({ kind: 'topic', text: '관계의 지혜', targetSeconds: 40 }); assert.ok(!('fixedScript' in plain))
})

test('B. PLAN은 확정 대본을 그대로 쓰고 AI PLAN·재작성 호출 0회, 공통 화풍·글자 금지가 모든 장면에 붙음', async () => {
  const brief = normalizeGenerativeBrief({ fixedScript: fixed(), targetSeconds: 40 })
  const { out, blobs } = await run(brief, never)
  assert.equal(out.result.provider, 'fixed'); assert.equal(out.result.fallbackReason, undefined); assert.equal(out.result.visualBibleRef, null)
  const saved: any = await blobs.getJson(out.result.scriptRef)
  assert.deepEqual(saved.beats.map((b: any) => b.narration), N, 'narration is verbatim')
  assert.equal(saved.title, '신문고까지 가는 길'); assert.equal(saved.ending, N[6])
  for (const b of saved.beats) { assert.match(b.imagePrompt, /^한국 전통 수묵담채화풍/); assert.match(b.imagePrompt, /no readable text, no watermark/) }
  assert.deepEqual(validateWisdomScript(saved, brief), [])
  const plan: any = await blobs.getJson(out.planRef); assert.ok(plan.variantPlan.events.length >= 7, 'captions are built from the fixed narration')
  assert.ok(Math.abs(saved.totalSeconds - 40) < 8, `total ${saved.totalSeconds}`)
})

test('C. 확정 대본이 품질 검사에 실패해도 AI로 다시 쓰지 않고, 유료 이미지·음성 전에 명확히 중단', async () => {
  const bad = normalizeGenerativeBrief({ fixedScript: fixed({ beats: Array.from({ length: 6 }, () => ({ narration: '같은 말입니다 같은 말입니다 같은 말입니다 같은 말입니다 같은 말입니다 같은 말입니다 같은 말입니다.', imagePrompt: '같은 장면의 큰 북' })) }), targetSeconds: 40 })
  await assert.rejects(run(bad, never), /SEMANTIC_QC_FAILED|semantic QC failed/)
})

test('D. 기존 Wisdom 경로 불변: fixedScript가 없으면 이전처럼 AI PLAN을 호출', async () => {
  let called = 0
  const brief = normalizeGenerativeBrief({ kind: 'text', text: '관계는 숫자보다 깊이가 중요합니다.', targetSeconds: 40 })
  const beats = Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, narration: ['관계의 숫자보다 마음의 깊이를 보세요.', '많은 관계는 때로 마음을 지치게 합니다.', '하지만 중요한 건 서로를 편안하게 하는 깊이입니다.', '관계의 깊이가 숫자보다 오래 남습니다.'][i], visualGoal: `g${i}`, imagePrompt: `scene ${i}`, durationSec: 10 }))
  const script: any = { schema: 'wisdom-script/1', title: '관계의 깊이', hook: '관계는 숫자가 전부일까요?', beats, ending: '편안한 깊이가 오래 남습니다.', totalSeconds: 40 }
  const bible: any = { schema: 'wisdom-visual-bible/1', style: 'watercolor', palette: 'warm', lighting: 'soft', composition: 'focus', characterPolicy: 'same', negative: 'text' }
  const { out } = await run(brief, async () => { called++; return { script, visualBible: bible } })
  assert.equal(called, 1); assert.equal(out.result.provider, 'openai')
})
