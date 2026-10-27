// 카드뉴스 스토리보드 참조 이미지: /api/image가 Gemini에 실제 이미지 블록으로 넘기는지(가짜 fetch, 유료 호출 0), 역할·순서·저장 복원.
// Run: node --import tsx --test tools/cardnews-refs.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import imageHandler from '../api/image.js'
import { sanitizeState } from '../lib/cardnews/cardnews.js'
import { orderRoleReferences, roleReferenceInstruction } from '../lib/cardnews/references.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ab0000000049454e44ae426082', 'hex')
const b64 = (s: string) => Buffer.from(s).toString('base64')
async function callImage(input: any) {
  const prevKey = process.env.GEMINI_API_KEY, prevFetch = globalThis.fetch, sent: any[] = []
  process.env.GEMINI_API_KEY = 'test-key'
  globalThis.fetch = (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'r1', output_image: { data: PNG.toString('base64'), mime_type: 'image/png' } }), { status: 200 }) }) as any
  let status = 0, json: any
  try { await imageHandler({ method: 'POST', query: {}, headers: {}, body: { contractVersion: '1.5', taskType: 'cut_image', input } } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } } as any) }
  finally { globalThis.fetch = prevFetch; if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey }
  return { status, json, sent: sent[0] }
}
const PROMPT = '3장: 거인이 작업장에서 파인 치즈를 발견한다. 이 장에서는 거인의 외눈을 보이지 않는다: 뒷모습·눈이 가려진 측면·부분 얼굴만.'

test('스토리보드·캐릭터·그림체 기준이 실제 이미지 블록으로 전달되고, 순서와 역할 설명이 서버에서 고정된다', async () => {
  const r = await callImage({ prompt: PROMPT, aspectRatio: '4:5', imageSize: '1K', profile: 'cardnews', references: [
    { role: 'style', data: b64('STYLE'), mimeType: 'image/jpeg' },
    { role: 'character', data: 'data:image/png;base64,' + b64('GIANT'), mimeType: 'image/png' },
    { role: 'storyboard', data: b64('PANEL3'), mimeType: 'image/png' },
  ] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.sent.input.map((x: any) => x.type), ['text', 'image', 'image', 'image'], 'one text block + three real image blocks')
  assert.deepEqual(r.sent.input.slice(1).map((x: any) => Buffer.from(x.data, 'base64').toString()), ['PANEL3', 'GIANT', 'STYLE'], 'storyboard first, then character, then style')
  assert.deepEqual(r.sent.input.slice(1).map((x: any) => x.mime_type), ['image/png', 'image/png', 'image/jpeg'])
  const text = r.sent.input[0].text
  assert.match(text, /이미지 1: \[스토리보드\]/); assert.match(text, /이미지 2: \[캐릭터 기준\]/); assert.match(text, /이미지 3: \[그림체 기준\]/)
  assert.ok(text.includes('거인의 외눈을 보이지 않는다'), 'reveal restriction kept in the prompt')
  assert.ok(!/https?:\/\/|cardnews\/[0-9a-f]{8}/.test(text), 'no image URL or storage path written into the prompt')
  assert.equal(r.sent.response_format[0].aspect_ratio, '4:5')
})

test('스토리보드는 장당 1장, 전체 최대 4장 · 역할 없는 예전 요청은 기존 경로 그대로', async () => {
  const many = orderRoleReferences<any>([{ role: 'storyboard', data: 'a' }, { role: 'storyboard', data: 'b' }, { role: 'character', data: 'c' }, { role: 'character', data: 'd' }, { role: 'character', data: 'e' }, { role: 'style', data: 'f' }])!
  assert.deepEqual(many.map((x) => x.data), ['a', 'c', 'd', 'e'])
  assert.equal(orderRoleReferences<any>([{ data: 'x' }]), null)
  const legacy = await callImage({ prompt: 'CUT 01', aspectRatio: '9:16', references: [{ data: b64('OLD') }] })
  assert.deepEqual(legacy.sent.input.map((x: any) => x.type), ['text', 'image']); assert.ok(!/\[스토리보드\]/.test(legacy.sent.input[0].text))
  const noRefs = await callImage({ prompt: 'CUT', aspectRatio: '4:5', profile: 'cardnews', references: [] })
  assert.deepEqual(noRefs.sent.input.map((x: any) => x.type), ['text'])
  assert.match(roleReferenceInstruction(['storyboard']), /스케치 선, 칸 테두리, 번호/)
})

test('참조 정보는 서버 저장본에 남고(재접속 복원), 다른 작업 공간의 이미지·임의 주소는 버린다', () => {
  const ws = 'a'.repeat(64), ref = (c: string) => `cardnews/${ws}/images/${c.repeat(64)}.png`
  const cover = { id: 'cv_1a2b3c4d', title: '외눈박이 치즈 장인', coverLine: '치즈 장인', promise: '치즈를 갉아 먹은 범인을 찾는다' }
  const st = sanitizeState({ material: 'm', cover, cards: [], refs: {
    panels: [{ ref: ref('7'), label: '1번 칸' }, { ref: 'cardnews/x.png' }],
    storyboard: { c1: { ref: ref('1'), label: '1칸' }, c2: { ref: 'https://evil.example/x.png' }, c3: { ref: `cardnews/${'b'.repeat(64)}/images/${'2'.repeat(64)}.png` } },
    character: [{ ref: ref('3'), label: '거인(승인본)' }, { ref: ref('4') }, { ref: ref('5') }], style: [{ ref: ref('6') }],
    fixedTraits: '이마 중앙의 큰 외눈, 갈색 가죽 앞치마', forbid: '이미지 속 글자 금지', revealCardId: 'c8', hideRule: 'c8 전에는 외눈을 보이지 않는다' } }, ws)
  assert.deepEqual(Object.keys(st.refs.storyboard), ['c1']); assert.deepEqual(st.refs.panels.map((p: any) => p.label), ['1번 칸']); assert.equal(st.refs.storyboard.c1.label, '1칸')
  assert.equal(st.refs.character.length, 2); assert.equal(st.refs.style[0].ref, ref('6'))
  assert.equal(st.refs.revealCardId, 'c8'); assert.ok(st.refs.hideRule.includes('외눈')); assert.ok(st.refs.fixedTraits.includes('외눈'))
  const roundTrip = sanitizeState(JSON.parse(JSON.stringify(st)), ws); assert.deepEqual(roundTrip.refs, st.refs)
})
