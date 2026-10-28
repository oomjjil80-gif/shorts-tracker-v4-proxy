// 카드뉴스 범용 자동화(백엔드): 장면 설계(VISUAL PLAN) 포함 구성, 이미지 전 무료 규칙 검사, 문제 장 계획만 1회 수정, 이미지 서버 저장/복원.
// 가짜 AI·메모리 저장소만 사용(유료 호출 0). Run: node --import tsx --test tools/cardnews-visual.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import { planIssues } from '../lib/cardnews/visualPlan.js'
import { sanitizeImages, sanitizeState } from '../lib/cardnews/cardnews.js'

const KEY = 'k'.repeat(32), OTHER = 'z'.repeat(32)
const cover = { id: 'cv_1a2b3c4d', title: '판테온 돔의 비밀', coverLine: '돔의 비밀', promise: '돔이 무너지지 않는 이유를 설명한다' }
const OK = { costApproved: true, approvedUsd: 1 }
// 서로 다른 소재 3종 (역사 건축 / 과학 / 음식)
const TOPICS = {
  pantheon: { cover, heads: ['돔의 비밀', '구멍의 역할', '콘크리트 배합', '벽 두께', '빛의 움직임', '배수 구조', '천 년의 보수', '마지막 반전'], subj: ['돔 외관 전경', '천장 중앙 구멍', '콘크리트 단면', '두꺼운 벽 내부', '바닥에 비친 빛', '바닥 배수구', '보수 공사 장면', '무너지지 않는 이유 모형'], comp: ['정면 와이드', '아래에서 올려본 시점', '절개 단면도', '평면도 부감', '사선 역광', '바닥 근접 접사', '측면 중거리', '전후 비교 분할'] },
  science: { cover: { ...cover, id: 'cv_2b3c4d5e', title: '얼음이 물에 뜨는 이유', promise: '물이 얼 때 부피가 늘어나는 원리' }, heads: ['얼음은 왜 뜰까', '물 분자 구조', '결합 각도', '빈 공간 생성', '밀도 비교', '호수의 겨울', '생명의 보호막', '일상 속 사례'], subj: ['컵 속 떠 있는 얼음', '물 분자 모형', '분자 결합 각도', '육각형 격자 빈 공간', '밀도 저울 비교', '얼어붙은 호수 단면', '얼음 아래 물고기', '냉동실 속 물병'], comp: ['컵 클로즈업', '확대 모형 정면', '각도 표시 도식', '격자 단면 확대', '저울 양쪽 비교', '호수 절개 시점', '수중 올려보기', '가정 주방 와이드'] },
  food: { cover: { ...cover, id: 'cv_3c4d5e6f', title: '김치가 익는 시간', promise: '발효로 김치 맛이 변하는 과정' }, heads: ['김치의 하루', '소금 절임', '양념 버무리기', '유산균 활동', '맛의 변화', '숙성 온도', '신김치의 쓰임', '한 입의 완성'], subj: ['갓 담근 배추김치', '소금에 절인 배추', '양념을 버무리는 손', '유산균 확대 모형', '시간대별 맛 변화 접시', '냉장고 온도계', '김치찌개 냄비', '완성된 한 상'], comp: ['접시 위 정면', '대야 부감', '손동작 근접', '현미경 도식', '일렬 비교 배치', '온도계 접사', '김 서린 사선', '식탁 와이드'] }
}
const deckFor = (t: (typeof TOPICS)[keyof typeof TOPICS]) => t.heads.map((h, i) => ({ headline: h, body: `${h}에 대한 설명 문장입니다.`, visualPlan: { subject: t.subj[i], composition: t.comp[i], distinction: `${i}장과 다른 정보를 보여준다` } }))

function rig(composeCards: (input: string) => any, fixPlans?: (input: any) => any) {
  const calls: string[] = []
  const deps = { claude: async (_sys: string, input: string, name = '') => { calls.push(name); return { text: JSON.stringify(name === 'cardnews_compose' ? composeCards(input) : fixPlans!(JSON.parse(input))), model: 'm' } }, gpt: async () => ({ findings: [] }) }
  const blobs = createMemoryBlobStore(), h = createCardnewsHttp({ blobs, deps: () => deps as any })
  const call = async (method: string, body: any, key: string | null = KEY) => {
    if (method !== 'POST' || body?.costApproved !== true || body?.approvalId) return raw(method, body, key)
    const q = await raw(method, { ...body, costApproved: false }, key)
    return q.status === 402 && q.body?.approval?.approvalId ? raw(method, { ...body, approvalId: q.body.approval.approvalId }, key) : q
  }
  const raw = async (method: string, body: any, key: string | null = KEY) => { let status = 0, out: any; await h({ method, headers: key ? { 'x-sync-key': key } : {}, body: method === 'POST' ? body : undefined, query: method === 'GET' ? body : undefined } as any, { setHeader() {}, status(s: number) { status = s; return this }, json(b: any) { out = b; return this } } as any); return { status, body: out } }
  return { calls, call, blobs }
}
const compose = (t: any, extra: any = {}) => ({ taskType: 'cardnews_compose', cover: t.cover, material: `${t.cover.title}에 대한 충분히 긴 소재 설명입니다. ${t.cover.promise}.`, count: 8, ...OK, ...extra })

test('A. 서로 다른 소재 3종: 8장 모두 장면 계획 포함, 이미지 전 규칙 검사 통과, AI 호출은 구성 1회뿐(추가 수정 호출 0)', async () => {
  for (const [name, t] of Object.entries(TOPICS)) {
    const { call, calls } = rig(() => ({ cards: deckFor(t) }))
    const r = await call('POST', compose(t))
    assert.equal(r.status, 200, name); assert.equal(r.body.cards.length, 8)
    assert.ok(r.body.cards.every((c: any) => c.visualPlan?.subject && c.visualPlan.composition && c.visualPlan.distinction), `${name}: every card has a plan`)
    assert.deepEqual(r.body.planIssues, [], name); assert.deepEqual(calls, ['cardnews_compose'], `${name}: no repair call needed`)
    assert.equal(new Set(r.body.cards.map((c: any) => c.visualPlan.subject)).size, 8)
  }
})

test('B. 무료 규칙 5종: 계획 누락 · 같은 피사체 · 같은 구도 · 내용 불일치 · 결말 조기 노출', () => {
  const t = TOPICS.pantheon, base = deckFor(t).map((c, i) => ({ id: `c${i + 1}`, ...c }))
  assert.deepEqual(planIssues(base, t.cover), [])
  const codes = (cards: any[]) => planIssues(cards, t.cover).map((i) => `${i.cardId}:${i.code}`)
  assert.deepEqual(codes(base.map((c, i) => (i === 2 ? { ...c, visualPlan: null } : c))), ['c3:MISSING_PLAN'])
  assert.ok(codes(base.map((c, i) => (i === 4 ? { ...c, visualPlan: { ...c.visualPlan!, subject: base[1].visualPlan!.subject } } : c))).includes('c5:DUPLICATE_SUBJECT'))
  assert.ok(codes(base.map((c, i) => (i === 5 ? { ...c, visualPlan: { ...c.visualPlan!, composition: base[3].visualPlan!.composition } } : c))).includes('c6:DUPLICATE_COMPOSITION'))
  assert.ok(codes(base.map((c, i) => (i === 3 ? { ...c, visualPlan: { ...c.visualPlan!, subject: 'qwerty zxcv' } } : c))).includes('c4:CONTENT_MISMATCH'))
  // 마지막 장 제목에서 처음 공개되는 낱말("반전")을 앞 장의 계획이 미리 보여 주면 안 된다
  assert.ok(codes(base.map((c, i) => (i === 1 ? { ...c, visualPlan: { ...c.visualPlan!, distinction: '마지막 반전을 암시하는 소품을 둔다' } } : c))).includes('c2:EARLY_REVEAL'))
})

test('C. 문제 장의 계획만 1회 수정: 나머지 장은 그대로, 수정 후에도 남은 문제는 반복 호출 없이 그대로 돌려줌', async () => {
  const t = TOPICS.science, deck = deckFor(t)
  deck[4] = { ...deck[4], visualPlan: { ...deck[1].visualPlan } } // c5 duplicates c2
  const good = { subject: '밀도 저울 위의 두 컵 비교', composition: '저울 양쪽을 나란히 놓은 비교 구도', distinction: '무게 대신 부피 차이를 보여준다' }
  const { call, calls } = rig(() => ({ cards: deck }), (inp) => ({ cards: [...inp.지적.map((i: any) => ({ id: i.cardId, visualPlan: good })), { id: 'c1', visualPlan: { subject: '몰래 바꾼 장면', composition: '몰래 바꾼 구도', distinction: '몰래' } }] }))
  const r = await call('POST', compose(t))
  assert.deepEqual(calls, ['cardnews_compose', 'cardnews_plan_fix']); assert.deepEqual(r.body.order, ['claude:compose', 'claude:plan_fix'])
  r.body.cards.forEach((c: any, i: number) => { if (i === 4) assert.deepEqual(c.visualPlan, good); else assert.deepEqual(c.visualPlan, deckFor(t)[i].visualPlan, `card ${i + 1} untouched (stray c1 edit ignored)`) })
  assert.deepEqual(r.body.planIssues, [])
  // 수정이 또 실패하면: 두 번째 수정 호출 없이 남은 문제만 보고
  const bad = rig(() => ({ cards: deck }), (inp) => ({ cards: inp.지적.map((i: any) => ({ id: i.cardId, visualPlan: deck[1].visualPlan })) }))
  const r2 = await bad.call('POST', compose(t))
  assert.equal(bad.calls.length, 2); assert.ok(r2.body.planIssues.length > 0)
})

test('D. 비용: 승인(동의) 없으면 공급자 호출 0회, 예상 비용에 수정 1회분 포함, 같은 요청을 반복해도 승인된 한 번만 호출', async () => {
  const t = TOPICS.food, { call, calls } = rig(() => ({ cards: deckFor(t) }))
  const no = await call('POST', compose(t, { costApproved: false })); assert.equal(no.status, 402); assert.equal(no.body.estimate.calls, 2); assert.ok(no.body.estimate.usd >= 0.05)
  const low = await call('POST', compose(t, { approvedUsd: 0.01 })); assert.equal(low.status, 402)
  assert.deepEqual(calls, [])
  await call('POST', compose(t)); assert.equal(calls.length, 1)
})

test('E. 이미지 서버 저장: 저장→읽기 왕복, 같은 내용은 같은 주소(이전 버전 보존), 다른 작업 공간 접근 불가, 이미지 아닌 데이터 거절', async () => {
  const { call, blobs } = rig(() => ({ cards: [] }))
  const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`image-${n}`.padEnd(40, 'x'))])
  const a = await call('POST', { taskType: 'cardnews_image_put', dataBase64: png(1).toString('base64') }), b = await call('POST', { taskType: 'cardnews_image_put', dataBase64: png(2).toString('base64') }), a2 = await call('POST', { taskType: 'cardnews_image_put', dataBase64: png(1).toString('base64') })
  assert.equal(a.status, 200); assert.match(a.body.ref, /^cardnews\/[0-9a-f]{64}\/images\/[0-9a-f]{64}\.png$/); assert.equal(a.body.ref, a2.body.ref); assert.notEqual(a.body.ref, b.body.ref)
  const g = await call('GET', { taskType: 'cardnews_image_get', ref: a.body.ref }); assert.equal(g.status, 200); assert.equal(Buffer.from(g.body.dataBase64, 'base64').equals(png(1)), true)
  assert.equal((await call('GET', { taskType: 'cardnews_image_get', ref: b.body.ref })).status, 200, 'the earlier version is still there')
  assert.equal((await call('GET', { taskType: 'cardnews_image_get', ref: a.body.ref }, OTHER)).status, 400, 'another workspace cannot read it')
  assert.equal((await call('POST', { taskType: 'cardnews_image_put', dataBase64: Buffer.from('not an image at all, plain text').toString('base64') })).status, 400)
  assert.equal((await call('POST', { taskType: 'cardnews_image_put', dataBase64: png(3).toString('base64') }, null)).status, 401)
  assert.equal([...(blobs as any).binaries.keys()].every((k: string) => k.startsWith('cardnews/')), true)
})

test('F. 저장 상태: 장면 계획·그림체·이미지 버전 참조만 서버 상태에 저장, 남의 작업 공간 ref·잘못된 ref는 버림', () => {
  const ws = 'a'.repeat(64), ref = (n: string) => `cardnews/${ws}/images/${n.repeat(64)}.png`
  const images = sanitizeImages({ c1: { selected: 'v2', versions: [{ id: 'v1', ref: ref('b'), style: 'bright-editorial', at: 't1' }, { id: 'v2', ref: ref('c'), style: 'miniature', at: 't2' }, { id: 'v3', ref: `cardnews/${'f'.repeat(64)}/images/${'d'.repeat(64)}.png`, style: 'x', at: 't3' }] }, c2: { versions: [{ id: 'v1', ref: 'https://evil/x.png' }] } }, ws)
  assert.deepEqual(Object.keys(images), ['c1']); assert.deepEqual(images.c1.versions.map((v) => v.id), ['v1', 'v2']); assert.equal(images.c1.selected, 'v2')
  const st = sanitizeState({ material: 'm', count: 8, form: {}, cover, cards: deckFor(TOPICS.food).map((c, i) => ({ id: `c${i + 1}`, role: 'body', ...c })), style: 'miniature', scriptConfirmedAt: '2026-10-26T00:00:00Z', images: { c1: { selected: 'v1', versions: [{ id: 'v1', ref: ref('b'), style: 's', at: 't' }] } } }, ws)
  assert.equal(st.scriptConfirmedAt, '2026-10-26T00:00:00Z', 'confirmed script survives a reconnect'); assert.equal(sanitizeState({ material: 'm', scriptConfirmedAt: 'x' }, ws).scriptConfirmedAt, null, 'no confirmation without an approved cover')
  assert.equal(st.style, 'miniature'); assert.ok(st.cards[0].visualPlan.subject); assert.equal(st.images.c1.versions[0].ref, ref('b'))
  assert.ok(JSON.stringify(st).length < 120_000 && !JSON.stringify(st).includes('base64'))
})


test('스토리보드: Claude 장면 설명 → 정규화 → 서버 저장/복구, 구형 카드 호환 (가짜 AI만 사용)', async () => {
  const t = TOPICS.food
  const storyboard = '조선 시대 장독대 앞에서 장인이 항아리 뚜껑을 여는 장면. 어깨 너머 시점, 아침 햇빛, 표정은 긴장.'
  const continuity = '조선 시대 한옥 마당, 동일한 장인(남색 두루마기), 같은 갈색 장독대.'
  const deck = deckFor(t).map((c) => ({ ...c, visualPlan: { ...c.visualPlan, storyboard, continuity } }))
  const { call, calls } = rig(() => ({ cards: deck }))
  const composed = await call('POST', compose(t))
  assert.equal(composed.status, 200)
  assert.deepEqual(calls, ['cardnews_compose'])
  assert.equal(composed.body.cards[0].visualPlan.storyboard, storyboard)
  assert.equal(composed.body.cards[0].visualPlan.continuity, continuity)
  const state = { material: '충분히 긴 소재 설명을 저장합니다.', count: 8, cover: t.cover, cards: composed.body.cards }
  const saved = await call('POST', { taskType: 'cardnews_save', state, baseRev: 0 })
  assert.equal(saved.status, 200)
  const loaded = await call('GET', { taskType: 'cardnews_get' })
  assert.equal(loaded.status, 200)
  assert.equal(loaded.body.saved.state.cards[0].visualPlan.storyboard, storyboard)
  assert.equal(loaded.body.saved.state.cards[0].visualPlan.continuity, continuity)
  const legacy = sanitizeState({ ...state, cards: deckFor(t) })
  assert.ok(legacy.cards.every((c: any) => c.visualPlan?.subject && !c.visualPlan?.storyboard))
})
