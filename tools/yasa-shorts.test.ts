// 야담 쇼츠(yasa_shorts): 기존 Wisdom Shorts 파이프라인을 별도 프로필로 재사용. 확정 대본은 그대로, 지혜 쇼츠로 잘못 분류되지 않음. 무료(가짜 AI·DB).
// Run: node --import tsx --test tools/yasa-shorts.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { PROFILES, isWisdomShorts, getProfile } from '../lib/jobs/profiles.js'
import { normalizeGenerativeBrief } from '../lib/generative/contracts.js'
import { createGenerativePlanExecutor } from '../worker/stages/generative.js'
import { wisdomUploadText } from '../lib/generative/wisdomUploadText.js'

const KEY = 'y'.repeat(32)
const N = ['옛날 한 고을에 이상한 소문이 돌았습니다. 밤마다 우물에서 노랫소리가 들린다는 것이었습니다.', '마을 사람들은 무서워 가까이 가지 않았지만 어린 서생만은 그 까닭이 궁금했습니다.', '서생이 밤에 우물가로 갔을 때 노랫소리는 정말로 우물 속에서 흘러나오고 있었습니다.', '하지만 소리의 주인은 귀신이 아니라 오래전 우물에 빠진 낡은 가야금이었습니다.', '서생은 가야금을 건져 주인을 찾아 주었고 그날부터 노랫소리는 멈췄다고 합니다.', '두려움의 정체는 알고 보면 아무도 들여다보지 않은 작은 사연일 때가 많습니다.']
const fixed = () => ({ title: '우물 속 노랫소리', stylePrefix: '한국 전통 수묵담채화풍 일러스트, 세로 9:16', beats: N.map((narration, i) => ({ narration, imagePrompt: `장면 ${i + 1} 우물가와 서생의 모습` })) })

test('A. 프로필 등록: yasa_shorts는 wisdom과 같은 단계·기능·모듈, 9:16 쇼츠 패키지, 지혜 롱폼/야담 롱폼은 그대로', () => {
  const y = PROFILES.yasa_shorts, w = PROFILES.wisdom
  assert.deepEqual([y.stages, y.features, y.modules, y.input, y.packageView], [w.stages, w.features, w.modules, w.input, w.packageView])
  assert.equal(y.id, 'yasa_shorts'); assert.equal(getProfile('yasa_shorts').packageView, 'shorts')
  assert.ok(isWisdomShorts('wisdom') && isWisdomShorts('yasa_shorts') && !isWisdomShorts('yasa_longform') && !isWisdomShorts('wisdom_longform') && !isWisdomShorts('source_shorts'))
  assert.deepEqual(PROFILES.yasa_longform.stages, ['PLAN', 'ASSET', 'RENDER', 'PACKAGE'])
})

test('B. 브리프: 야담 쇼츠는 profile/creative가 yasa_shorts, 기본(지혜) 호출은 이전과 동일', () => {
  const y: any = normalizeGenerativeBrief({ fixedScript: fixed(), targetSeconds: 40 }, 'yasa_shorts'), w: any = normalizeGenerativeBrief({ fixedScript: fixed(), targetSeconds: 40 })
  assert.equal(y.profile, 'yasa_shorts'); assert.equal(y.creative.content, 'yasa_shorts'); assert.equal(y.aspectRatio, '9:16')
  assert.equal(w.profile, 'wisdom'); assert.equal(w.creative.content, 'wisdom')
})

async function plan(profile: string, brief: any) {
  const blobs = createMemoryBlobStore(); await blobs.putJson('brief.json', brief)
  let ai = 0
  const out: any = await createGenerativePlanExecutor({ apiKey: 'test', plan: async () => { ai++; throw new Error('AI PLAN must not run') } }).run({ job: { id: 'j', profile, planRef: 'brief.json', sourceAssetId: 'src_gen_x' } as any, blobs, previous: async () => null, signal: new AbortController().signal } as any)
  return { out, blobs, ai: () => ai }
}
test('C. 야담 쇼츠 PLAN: 확정 대본이 한 글자도 바뀌지 않고 AI PLAN 0회, 지혜 프로필과 서로 섞이지 않음', async () => {
  const brief = normalizeGenerativeBrief({ fixedScript: fixed(), targetSeconds: 40 }, 'yasa_shorts')
  const { out, blobs, ai } = await plan('yasa_shorts', brief)
  assert.equal(out.result.provider, 'fixed'); assert.equal(ai(), 0)
  const saved: any = await blobs.getJson(out.result.scriptRef)
  assert.deepEqual(saved.beats.map((b: any) => b.narration), N); assert.equal(saved.title, '우물 속 노랫소리')
  const bh = out.result.briefRef; assert.equal(((await blobs.getJson(bh)) as any).profile, 'yasa_shorts')
  await assert.rejects(plan('wisdom', brief), /BRIEF_INVALID|invalid wisdom brief/)
  await assert.rejects(plan('yasa_shorts', normalizeGenerativeBrief({ fixedScript: fixed(), targetSeconds: 40 })), /BRIEF_INVALID|invalid wisdom brief/)
  await assert.rejects(plan('yasa_longform', brief), /only handles wisdom\/yasa shorts/)
})

test('D. job_create: yasa_shorts 작업이 야담 쇼츠 프로필로 기록되고 fixedScript가 브리프에 저장됨, 지혜 쇼츠는 그대로 wisdom', async () => {
  const db = await createTestDb(), store = createJobStore(db), blobs = createMemoryBlobStore()
  const handler = createJobsHttp({ getStore: async () => store, blobs })
  const call = async (b: any) => { let status = 0, json: any = null; await handler({ method: 'POST', headers: { 'x-sync-key': KEY }, query: {}, body: b } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(x: any) { json = x; return this }, end() { return this } } as any); return { status, json } }
  const y = await call({ taskType: 'job_create', profile: 'yasa_shorts', idempotencyKey: 'idem-yasa-0001', input: { fixedScript: fixed(), targetSeconds: 40 }, budgetUsd: 5 })
  assert.equal(y.status, 201); assert.equal(y.json.job.profile, 'yasa_shorts'); assert.equal(y.json.job.stage, 'PLAN')
  const stored: any = [...blobs.files.entries()].map(([, v]) => JSON.parse(v)).find((x: any) => x.schema === 'generative-brief/1')
  assert.equal(stored.profile, 'yasa_shorts'); assert.equal(stored.fixedScript.beats.length, 6); assert.equal(stored.aspectRatio, '9:16')
  const w = await call({ taskType: 'job_create', profile: 'wisdom', idempotencyKey: 'idem-wis-00001', input: { kind: 'topic', text: '관계의 지혜와 깊이', targetSeconds: 40 }, budgetUsd: 5 })
  assert.equal(w.status, 201); assert.equal(w.json.job.profile, 'wisdom')
  assert.notEqual(y.json.job.id, w.json.job.id)
  const bad = await call({ taskType: 'job_create', profile: 'yasa_shorts', idempotencyKey: 'idem-yasa-0002', input: { fixedScript: { title: 'x', beats: [] } }, budgetUsd: 5 })
  assert.equal(bad.status, 400)
})

test('E. 업로드 정보: 야담 쇼츠는 야담으로 식별해 요청, 지혜 쇼츠 요청은 이전과 동일(family 없음)', async () => {
  const seen: any[] = []
  const kit: any = async (input: any) => { seen.push(input); return { lines: [{ text: '우물의', color: 'white' }, { text: '노랫소리', color: 'red' }], figure: '서생', metadata: { title: '우물 속 노랫소리', description: N.join(' '), tags: ['야담'], pinnedComment: '"낡은 가야금"' } } }
  const script = { title: '우물 속 노랫소리', hook: N[0], beats: N.map((narration) => ({ narration })) }
  await wisdomUploadText({ script, brief: { text: N.join(' '), profile: 'yasa_shorts' }, apiKey: 'k', kit, attempts: 1 }).catch(() => {})
  await wisdomUploadText({ script, brief: { text: N.join(' '), profile: 'wisdom' }, apiKey: 'k', kit, attempts: 1 }).catch(() => {})
  assert.equal(seen[0].family, 'yasa'); assert.ok(!('family' in seen[1]))
})
