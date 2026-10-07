// 숨은야사 YASA STORY DNA: the PLAN comes first and is checked deterministically; every yasa script call (shorts
// story_draft, longform chapter on GPT and Claude, QC, revise) carries it; other families are untouched.
// fetch is stubbed — no paid AI call.
import test from 'node:test'
import assert from 'node:assert/strict'
import storyHandler from '../api/story.js'
import claudeStoryHandler from '../api/claude-story.js'
import qcHandler from '../api/gpt-script-qc.js'
import { validateYasaStoryDna, checkYasaScript, STORY_BASIS, YASA_STORY_DNA_SCHEMA } from '../lib/story/yasaStoryDna.js'

process.env.OPENAI_API_KEY ||= 'test-openai-key'
process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key'

const DNA = {
  title: '5년 만에 친정 가는 며느리에게 시어머니가 썩은 메주만 지워 보낸 이유',
  openingLine: '"이걸 친정까지 지고 가거라." 시어머니가 내민 것은 썩은 메주 한 덩이였다.',
  setting: { region: '조선 경상도', era: '조선 후기', culturalNotes: '양반가 며느리의 친정 나들이' },
  storyBasis: 'legend_or_folklore',
  hero: { role: '며느리', socialPosition: '몰락 양반가의 맏며느리', emotionalWound: '시집온 뒤 한 번도 친정에 못 간 설움', desire: '아픈 친정어머니를 만나는 것', immediateProblem: '빈손으로 가면 친정에서 무시당한다' },
  mystery: { strangeAction: '시어머니가 썩은 메주만 지워 보낸다', concreteProp: '썩은 메주', apparentMeaning: '며느리를 모욕하려는 심술', trueMeaning: '메주 속에 숨긴 금붙이로 친정의 빚을 갚게 하려던 배려', mainQuestion: '왜 하필 썩은 메주였나?', secondaryQuestion: '메주 속에는 무엇이 들었나?' },
  pressure: { immediateLoss: '친정 식구들 앞에서 체면을 잃는다', humiliationOrMisunderstanding: '이웃들이 시댁의 박대를 비웃는다', antagonistOrPressure: '빚쟁이가 친정집을 압류하러 온다', worseningEvents: ['고갯길에서 메주를 버리라는 조롱', '친정 오빠가 메주를 마당에 던진다', '빚쟁이가 친정어머니를 끌어내려 한다'] },
  reveal: { partialProof: '깨진 메주 틈에서 반짝이는 것이 보인다', majorCrisis: '친정집이 빚으로 넘어가기 직전', majorReveal: '메주 속에 시어머니가 평생 모은 금가락지가 들어 있었다', emotionalReframe: '모질던 시어머니가 사실 가장 큰 편이었다' },
  payoff: { externalRewardOrResolution: '빚을 갚고 친정을 지킨다', emotionalReward: '며느리가 시어머니를 처음으로 어머니라 부른다', finalAfterglow: '그 집안은 해마다 메주를 쑤어 친정에 보냈다' },
  propArc: ['짐', '모욕', '수상한 물건', '친정을 지킨 열쇠'],
}
const clone = (x: any) => JSON.parse(JSON.stringify(x))
const without = (path: string) => { const d = clone(DNA); const keys = path.split('.'); let o: any = d; for (const k of keys.slice(0, -1)) o = o[k]; o[keys.at(-1)!] = ''; return d }

function fakeFetch(responses: any[]) {
  const calls: any[] = []
  const f = async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (String(url).includes('anthropic')) return new Response(JSON.stringify({ model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(r) }] }), { status: 200 })
    return new Response(JSON.stringify({ id: 'resp', model: 'gpt-test', output_text: JSON.stringify(r) }), { status: 200 })
  }
  return { f, calls }
}
async function call(handler: any, body: any, responses: any[]) {
  const { f, calls } = fakeFetch(responses)
  const orig = globalThis.fetch; (globalThis as any).fetch = f
  try {
    let status = 0, json: any = null
    const req: any = { method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': 'k'.repeat(32) }, query: {}, body }
    const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this }, send(b: any) { json = b; return this } }
    await handler(req, res)
    return { status, json, calls }
  } finally { (globalThis as any).fetch = orig }
}
const SHORT_DRAFT = (narration: string) => ({ seriesType: 'freeform', title: DNA.title, subject: 's', hook: 'h', summary: 's', cutCountSuggested: 2, imageStyleNote: '', warnings: [], cuts: [{ purpose: 'hook', situation: 's', narration, directorNote: '', imagePrompt: 'p', dialogueLines: [] }] })
const CHAPTER = (text: string) => ({ title: 't', hook: text, targetMinutes: 3, chapters: [{ chapterNo: 1, title: 'c', purpose: 'p', segments: [{ speaker: '내레이션', text, visualHint: 'v', factStatus: 'interpretation' }] }], ending: { speaker: '내레이션', text: '' }, shortsSpinOff: [], warnings: [] })

test('1 + 8: yasa PLAN produces the STORY DNA (strict schema) for shorts and longform', async () => {
  for (const contentFormat of ['shorts', 'longform']) {
    const r = await call(storyHandler, { taskType: 'yasa_story_plan', input: { topic: '시어머니가 썩은 메주를 보낸 이유', contentFamily: 'yasa', contentFormat, targetMinutes: 15 } }, [DNA])
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.ok, true); assert.deepEqual(r.json.dna, DNA); assert.equal(r.json.format, contentFormat)
    assert.match(r.json.scriptBrief, /이 PLAN을 그대로 따른다/); assert.ok(r.json.scriptBrief.includes(DNA.mystery.concreteProp), 'the brief handed to the script writer carries the PLAN')
    const sent = r.calls[0].body
    assert.equal(sent.text.format.name, 'yasa_story_dna'); assert.equal(sent.text.format.strict, true); assert.deepEqual(sent.text.format.schema, YASA_STORY_DNA_SCHEMA)
    assert.match(sent.instructions, /사람 → 사건 → 의문 → 위기 → 반전 → 감정 보상/); assert.match(sent.instructions, /80~92% 대반전/)
    assert.match(sent.instructions, contentFormat === 'longform' ? /worseningEvents를 3단계 이상/ : /mystery 1개, payoff 1개/)
  }
})

test('PLAN failing the structure check is regenerated once with the errors, then refused', async () => {
  const fixed = await call(storyHandler, { taskType: 'yasa_story_plan', input: { topic: 't', contentFamily: 'yasa', contentFormat: 'shorts' } }, [without('mystery.concreteProp'), DNA])
  assert.equal(fixed.status, 200); assert.equal(fixed.calls.length, 2); assert.match(fixed.calls[1].body.input, /mystery\.concreteProp: missing/)
  const bad = await call(storyHandler, { taskType: 'yasa_story_plan', input: { topic: 't', contentFamily: 'yasa', contentFormat: 'shorts' } }, [without('reveal.majorReveal')])
  assert.equal(bad.status, 422); assert.equal(bad.json.error.code, 'YASA_DNA_INVALID'); assert.equal(bad.calls.length, 2)
})

test('2-6: missing strangeAction / concreteProp / trueMeaning / majorReveal, or < 3 worsening events (longform) -> FAIL', () => {
  assert.equal(validateYasaStoryDna(DNA, 'longform').ok, true)
  for (const [path, format] of [['mystery.strangeAction', 'shorts'], ['mystery.concreteProp', 'shorts'], ['mystery.trueMeaning', 'longform'], ['reveal.majorReveal', 'longform'], ['hero.role', 'shorts'], ['mystery.apparentMeaning', 'shorts'], ['mystery.mainQuestion', 'shorts'], ['reveal.partialProof', 'shorts'], ['reveal.majorCrisis', 'longform'], ['reveal.emotionalReframe', 'longform']] as const) {
    const v = validateYasaStoryDna(without(path), format)
    assert.equal(v.ok, false, path); assert.ok(v.errors.some((e) => e.startsWith(path)), `${path}: ${v.errors}`)
  }
  const two = clone(DNA); two.pressure.worseningEvents = ['a', 'b']
  assert.equal(validateYasaStoryDna(two, 'longform').ok, false); assert.equal(validateYasaStoryDna(two, 'shorts').ok, true, 'shorts may compress the worsening')
  const same = clone(DNA); same.mystery.trueMeaning = same.mystery.apparentMeaning
  assert.equal(validateYasaStoryDna(same, 'shorts').ok, false, 'the reveal must change the meaning')
  const lecture = clone(DNA); lecture.openingLine = '옛날 조선시대에는 며느리가 친정에 가기 어려웠습니다.'
  assert.ok(validateYasaStoryDna(lecture, 'shorts').errors.some((e) => e.startsWith('openingLine')))
  const abstract = clone(DNA); abstract.title = '시어머니의 충격적인 진실'
  assert.ok(validateYasaStoryDna(abstract, 'shorts').errors.some((e) => e.startsWith('title')))
})

test('9-10: any country/era passes; the three storyBasis values are accepted, anything else fails', () => {
  const venice = clone(DNA)
  Object.assign(venice, { title: '전 재산을 털어 노예 소녀를 산 상인, 10년 뒤 궁전에서 그녀를 다시 만났다', openingLine: '"이 아이를 사겠소. 값은 내 배 한 척이오." 베네치아 노예 시장이 술렁였다.', setting: { region: '베네치아 공화국', era: '15세기', culturalNotes: '지중해 무역' } })
  venice.mystery = { ...venice.mystery, concreteProp: '은 단추 하나', strangeAction: '상인이 배 한 척 값으로 노예 소녀를 산다' }
  assert.equal(validateYasaStoryDna(venice, 'longform').ok, true)
  for (const b of STORY_BASIS) assert.equal(validateYasaStoryDna({ ...DNA, storyBasis: b }, 'shorts').ok, true, b)
  assert.equal(validateYasaStoryDna({ ...DNA, storyBasis: 'fact' }, 'shorts').ok, false)
  assert.deepEqual(YASA_STORY_DNA_SCHEMA.properties.storyBasis.enum, ['historical_fact', 'legend_or_folklore', 'inspired_fiction'])
})

test('8: yasa shorts story_draft needs the PLAN, carries it to the script AI, and checks the script', async () => {
  const base = { topic: '썩은 메주', seriesType: 'freeform', contentFamily: 'yasa', contentFormat: 'shorts' }
  const none = await call(storyHandler, { taskType: 'story_draft', input: base }, [SHORT_DRAFT('x')])
  assert.equal(none.status, 422); assert.equal(none.json.error.code, 'YASA_DNA_REQUIRED'); assert.equal(none.calls.length, 0, 'no paid call without a PLAN')
  const ok = await call(storyHandler, { taskType: 'story_draft', input: { ...base, yasaStoryDNA: DNA } }, [SHORT_DRAFT('"이걸 친정까지 지고 가거라." 시어머니가 썩은 메주를 내밀었다.')])
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.deepEqual(ok.json.draft.yasaStoryDNA, DNA)
  assert.match(ok.calls[0].body.instructions, /숨은야사 STORY DNA — 이 PLAN을 그대로 따른다/); assert.ok(ok.calls[0].body.instructions.includes(DNA.mystery.trueMeaning))
  const lost = await call(storyHandler, { taskType: 'story_draft', input: { ...base, yasaStoryDNA: DNA } }, [SHORT_DRAFT('옛날 조선시대에는 며느리가 있었다. 그녀는 친정에 갔다.')])
  assert.equal(lost.status, 422); assert.equal(lost.json.error.code, 'YASA_SCRIPT_INVALID'); assert.ok(lost.json.error.errors.some((e: string) => /concreteProp/.test(e)) && lost.json.error.errors.some((e: string) => /opening/.test(e)))
})

test('8: yasa longform chapters (GPT fallback and Claude) need the PLAN and carry it with the chapter position', async () => {
  const input = { title: '썩은 메주', contentFamily: 'yasa', contentFormat: 'longform', targetMinutes: 15, chapterCount: 5 }
  const gptNone = await call(storyHandler, { taskType: 'longform_chapter', chapterNo: 1, totalChapters: 5, input }, [CHAPTER('x')])
  assert.equal(gptNone.status, 422); assert.equal(gptNone.calls.length, 0)
  const gpt = await call(storyHandler, { taskType: 'longform_chapter', chapterNo: 5, totalChapters: 5, input: { ...input, yasaStoryDNA: DNA } }, [CHAPTER('썩은 메주')])
  assert.equal(gpt.status, 200); assert.match(gpt.calls[0].body.input, /이 PLAN을 그대로 따른다/); assert.match(gpt.calls[0].body.input, /80~100% 구간/)
  const claudeNone = await call(claudeStoryHandler, { mode: 'chapter', chapterNo: 1, totalChapters: 5, input }, [CHAPTER('x')])
  assert.equal(claudeNone.status, 422); assert.equal(claudeNone.calls.length, 0)
  const claude = await call(claudeStoryHandler, { mode: 'chapter', chapterNo: 1, totalChapters: 5, input: { ...input, yasaStoryDNA: DNA } }, [CHAPTER('"이걸 친정까지 지고 가거라." 썩은 메주였다.')])
  assert.equal(claude.status, 200, JSON.stringify(claude.json))
  const sent = claude.calls[0].body
  assert.match(sent.system, /숨은야사 우선 규칙/); assert.match(sent.messages[0].content, /이 PLAN을 그대로 따른다/); assert.match(sent.messages[0].content, /0~20% 구간/)
})

test('QC: a yasa draft that lost its PLAN is sent back to revision (deterministic), a faithful one is not touched', async () => {
  const qcPass = { status: 'pass', summary: 's', scores: Object.fromEntries(['factualGrounding', 'channelFit', 'structure', 'ttsNaturalness', 'contentDensity', 'causalClarity', 'visualReadiness', 'retentionStrength', 'curiosityContinuity', 'pacing', 'payoffStrength'].map((k) => [k, 90])), issues: [], verifiedFactCoverage: [], revisionInstructions: [], finalDecision: 'pass' }
  const lost = await call(qcHandler, { input: { contentFamily: 'yasa', yasaStoryDNA: DNA, draft: CHAPTER('오늘 이야기의 주인공은 한 며느리입니다.') } }, [qcPass])
  assert.equal(lost.status, 200, JSON.stringify(lost.json)); assert.equal(lost.json.qc.status, 'revision_required'); assert.equal(lost.json.qc.yasaStoryDna.scriptOk, false)
  assert.ok(lost.json.qc.issues.some((i: any) => i.location === 'yasa_story_dna' && i.severity === 'required'))
  const kept = await call(qcHandler, { input: { contentFamily: 'yasa', yasaStoryDNA: DNA, draft: CHAPTER('"이걸 친정까지 지고 가거라." 썩은 메주 한 덩이였다.') } }, [qcPass])
  assert.equal(kept.json.qc.yasaStoryDna.scriptOk, true); assert.ok(!kept.json.qc.issues.some((i: any) => i.location === 'yasa_story_dna'))
  assert.equal(checkYasaScript('', DNA).ok, false)
})

test('7: other families: same input -> same prompts and results as before (no PLAN needed, no DNA text, no extra check)', async () => {
  for (const contentFamily of [undefined, 'general', 'economy', 'senior', 'wisdom']) {
    const r = await call(storyHandler, { taskType: 'story_draft', input: { topic: '금리', seriesType: 'freeform', ...(contentFamily ? { contentFamily } : {}) } }, [SHORT_DRAFT('옛날 조선시대에는')])
    assert.equal(r.status, 200, String(contentFamily)); assert.doesNotMatch(r.calls[0].body.instructions, /숨은야사/); assert.equal(r.json.draft.yasaStoryDNA, undefined)
    const c = await call(claudeStoryHandler, { mode: 'chapter', chapterNo: 1, totalChapters: 3, input: { title: 't', chapterCount: 3, ...(contentFamily ? { contentFamily } : {}) } }, [CHAPTER('x')])
    assert.equal(c.status, 200); assert.doesNotMatch(c.calls[0].body.system + c.calls[0].body.messages[0].content, /숨은야사/)
  }
  const base = await call(storyHandler, { taskType: 'story_draft', input: { topic: '금리', seriesType: 'freeform' } }, [SHORT_DRAFT('a')])
  const general = await call(storyHandler, { taskType: 'story_draft', input: { topic: '금리', seriesType: 'freeform', contentFamily: 'general' } }, [SHORT_DRAFT('a')])
  assert.equal(general.calls[0].body.instructions, base.calls[0].body.instructions)
})

test('yasa longform keeps the chosen length (25 / 60 min, ~3 min per chapter); other families keep 5..30 / 3..10', async () => {
  for (const [minutes, chapters] of [[25, 8], [60, 20]] as const) {
    const input = { title: 't', contentFamily: 'yasa', contentFormat: 'longform', targetMinutes: minutes, chapterCount: chapters, yasaStoryDNA: DNA }
    const r = await call(claudeStoryHandler, { mode: 'chapter', chapterNo: chapters, totalChapters: chapters, input }, [CHAPTER('썩은 메주')])
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.chapterNo ?? chapters, chapters)
    const sent = r.calls[0].body.messages[0].content
    assert.match(sent, new RegExp(`전체 ${chapters}개 챕터 중 \\*\\*${chapters}번 챕터`), `${minutes} min -> chapter ${chapters} of ${chapters}`)
    assert.match(sent, /80~100% 구간|95~100% 구간|94~100% 구간|88~100% 구간/)
  }
  const other = await call(claudeStoryHandler, { mode: 'chapter', chapterNo: 20, totalChapters: 20, input: { title: 't', targetMinutes: 60, chapterCount: 20 } }, [CHAPTER('x')])
  assert.match(other.calls[0].body.messages[0].content, /전체 20개 챕터 중 \*\*10번 챕터/, 'non-yasa still clamps to 10 chapters')
})
