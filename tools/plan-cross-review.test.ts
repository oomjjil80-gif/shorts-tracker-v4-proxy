// PLAN cross-review (PLAN_CROSS_REVIEW, default OFF): GPT outline -> Claude review -> GPT decide + ONE revision.
// Stand-ins only (no paid call). Run: node --import tsx --test tools/plan-cross-review.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore, putAddressed } from '../lib/jobs/blobs.js'
import { createLongformPlanExecutor } from '../worker/stages/longform.js'
import { normalizeLongformBrief } from '../lib/generative/longform.js'
import { parseFindings, claudeReviewer, type CrossReviewDeps } from '../lib/generative/planCrossReview.js'

const TITLE = '나이 들수록 인간관계를 줄여야 하는 이유'
const REVISED = '나이 들수록 인간관계를 줄이는 진짜 이유'
const SENTS = [
  ['사람이 많을수록 오히려 더 외로워지는 순간이 있습니다.', '모임이 늘어날수록 진짜 내 이야기를 할 사람은 줄어듭니다.', '쇼펜하우어는 혼자 있을 수 있는 사람만이 자유롭다고 말했습니다.', '그는 외로움을 견디지 못하면 평생 남에게 끌려간다고 보았습니다.'],
  ['좋은 사람에게도 거리를 둬야 하는 순간이 있습니다.', '착한 사람일수록 거절하지 못해 자기 시간을 잃습니다.', '선을 긋는 것은 관계를 끊는 것이 아니라 지키는 일입니다.', '거리를 둔 뒤에야 오래 가는 관계가 남습니다.'],
  ['나이가 들면 관계의 수보다 깊이가 중요해집니다.', '열 명의 지인보다 한 명의 친구가 더 큰 힘이 됩니다.', '그래서 줄이는 것은 잃는 것이 아니라 고르는 일입니다.', '오늘 내 시간을 누구에게 주고 있는지 돌아보세요.']
]
const card = (say: string) => ({ say, show: ['관계를', '줄이는 이유'], accent: '관계', color: 'red' })
const META = (title: string) => ({ title, description: '나이가 들수록 관계를 넓히기보다 깊게 가꾸는 것이 왜 중요한지 이야기합니다. 쇼펜하우어가 혼자를 두려워하지 않은 이유와 좋은 사람에게도 거리를 둬야 하는 순간을 함께 살펴봅니다. 관계의 수보다 깊이를 고르는 법을 정리했습니다. 오래 남는 관계와 나를 지키는 혼자의 시간을 어떻게 나눌지, 오늘 바로 돌아볼 수 있는 질문도 함께 남겨 두었습니다.', tags: ['인간관계 정리', '쇼펜하우어', '혼자의 시간', '거리 두기', '노년의 관계', '진짜 친구'], hashtags: ['#인간관계', '#쇼펜하우어', '#관계정리'], pinnedComment: '여러분은 요즘 누구에게 가장 많은 시간을 쓰고 계신가요?' })
const planner = (seq: string[]) => ({
  outline: async (_b: any, n: number, _k: string, repair?: string[]) => { seq.push(repair?.length ? 'gpt:revise' : 'gpt:plan'); return { title: repair?.length ? REVISED : TITLE, hook: SENTS[0][0], figure: { name: '쇼펜하우어', imagePrompt: 'Arthur Schopenhauer' }, thumbnail: { lines: [{ text: '관계 정리', color: 'red' }, { text: '외로움의 비밀', color: 'white' }] }, sections: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, heading: `h${i + 1}`, points: ['a', 'b'] })) } },
  section: async (i: any) => ({ sentences: SENTS[i.index % 3].map(card) }),
  metadata: async (i: any) => META(i.title)
})
const research = async () => ({ bundle: { topic: TITLE, model: 'stand-in', researchedAt: 'now', fragments: ['쇼펜하우어: 고독을 견디는 힘이 자유다', '선을 긋는 것은 관계를 지키는 일', '관계의 수보다 깊이'].map((claim, k) => ({ id: `f${k + 1}`, type: 'interpretation', claim, story: '', sourceTitle: 's', sourceUrl: 'https://example.org', confidence: 'high', usableAsDirectBuddhaQuote: false })), sectionMap: [1, 2, 3].map((section) => ({ section, fragmentIds: [`f${section}`], purpose: 'p' })) }, requests: 1, webSearchCalls: 1 })
async function run(id: string, seq: string[], crossReview?: CrossReviewDeps | null, sharedBlobs?: any) {
  const blobs: any = sharedBlobs ?? createMemoryBlobStore()
  const b = await putAddressed(blobs, 'generative-briefs', normalizeLongformBrief({ kind: 'topic', text: `${TITLE} ${id}`, targetSeconds: 600, deriveShorts: false }, 'wisdom_longform'))
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', planner: planner(seq) as any, research: research as any, log: () => {}, ...(crossReview !== undefined ? { crossReview } : {}) })
    .run({ job: { id, profile: 'wisdom_longform', planRev: 1, planRef: b.path }, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  return { out, script: await blobs.getJson(out.outputRef) }
}

test('OFF (default, env unset): existing PLAN path unchanged, no review calls, no crossReview record', async () => {
  delete process.env.PLAN_CROSS_REVIEW
  const seq: string[] = []
  const { out, script } = await run('off', seq)
  assert.deepEqual(seq, ['gpt:plan'])
  assert.equal(out.result.crossReview, undefined)
  assert.equal(script.title, TITLE)
})

test('ON: GPT plan -> Claude review -> GPT decide -> GPT one revision; reject reasons recorded', async () => {
  const seq: string[] = []
  const deps: CrossReviewDeps = {
    reviewer: async () => { seq.push('claude:review'); return { model: 'claude-mock', findings: [{ area: 'title', problem: '제목이 결론을 다 말함', reason: '클릭 동기 약함', direction: '이유를 궁금하게' }, { area: 'catharsis', problem: '마지막 섹션 약함', reason: 'x', direction: 'y' }] } },
    decider: async () => { seq.push('gpt:decide'); return [{ index: 0, action: 'accept', reason: '타당' }, { index: 1, action: 'reject', reason: '연구 근거와 맞지 않음' }] }
  }
  const { out, script } = await run('on', seq, deps)
  assert.deepEqual(seq, ['gpt:plan', 'claude:review', 'gpt:decide', 'gpt:revise'])
  assert.equal(out.result.crossReview.status, 'revised')
  assert.deepEqual(out.result.crossReview.order, ['gpt:plan', 'claude:review', 'gpt:decide', 'gpt:revise'])
  assert.equal(out.result.crossReview.decisions[1].reason, '연구 근거와 맞지 않음')
  assert.equal(script.title, REVISED)
})

test('ON + Claude usage limit: falls back to the original GPT plan, reason recorded, never a pass; production continues', async () => {
  const seq: string[] = []
  const f: any = async () => new Response('{"type":"error"}', { status: 429 })
  const deps: CrossReviewDeps = { reviewer: claudeReviewer({ apiKey: 'x', fetchImpl: f }), decider: async () => { seq.push('gpt:decide'); return [] } }
  const { out, script } = await run('limit', seq, deps)
  assert.deepEqual(seq, ['gpt:plan'])
  assert.equal(out.result.crossReview.status, 'fallback')
  assert.match(out.result.crossReview.fallbackReason, /429/)
  assert.equal(script.title, TITLE)
  assert.ok(out.outputRef)
})

test('parseFindings: malformed or incomplete findings are errors, never no_findings', () => {
  assert.deepEqual(parseFindings('{"findings":[{"area":"hook30s","problem":"p","reason":"r","direction":"d"}]}').map((x) => x.area), ['hook30s'])
  assert.deepEqual(parseFindings('{"findings":[]}'), [])
  assert.throws(() => parseFindings('{"findings":[{"area":"other","problem":"x"}]}'))
  assert.throws(() => parseFindings('{"findings":[{"area":"title","problem":"x"}]}'))
  assert.throws(() => parseFindings('PASS'))
})

test('switch OFF -> ON for the same brief never reuses stale section checkpoints', async () => {
  const blobs = createMemoryBlobStore()
  const off = await run('shared-plan', [], undefined, blobs)
  assert.equal(off.out.result.crossReview, undefined)
  const seq: string[] = []
  const deps: CrossReviewDeps = {
    reviewer: async () => ({ model: 'claude-mock', findings: [{ area: 'title', problem: 'weak', reason: 'unclear', direction: 'sharpen' }] }),
    decider: async () => [{ index: 0, action: 'accept', reason: 'valid' }]
  }
  const on = await run('shared-plan', seq, deps, blobs)
  assert.equal(on.script.title, REVISED)
  assert.ok(on.out.result.checkpoints.made.includes('section-001'))
  assert.equal(on.out.result.crossReview.status, 'revised')
})

test('missing GPT decisions falls back rather than silently rejecting all findings', async () => {
  const deps: CrossReviewDeps = {
    reviewer: async () => ({ model: 'claude-mock', findings: [{ area: 'catharsis', problem: 'weak', reason: 'no payoff', direction: 'payoff' }] }),
    decider: async () => []
  }
  const { out, script } = await run('invalid-decisions', [], deps)
  assert.equal(out.result.crossReview.status, 'fallback')
  assert.match(out.result.crossReview.fallbackReason, /incomplete/)
  assert.equal(script.title, TITLE)
})
