// B-1: segment.direction 계약(문자열, ≤600자) — 무료 stand-in fetch만 사용 (유료 AI 호출 없음).
// Run: node --import tsx --test tools/scene-direction.test.ts
import { INTERNAL_AI_CALL } from '../lib/generative/internalCall.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import claudeStoryHandler from '../api/claude-story.js'
import reviseHandler from '../api/claude-longform-revise.js'
import { mergePartial, PARTIAL_SCHEMA } from '../lib/story/titlePromise.js'
import { normalizeDirection, preserveDirections, DIRECTION_MAX } from '../lib/story/sceneDirection.js'

process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key'
const seg = (t: string, extra: any = {}) => ({ speaker: '내레이션', text: t, visualHint: 'v', factStatus: 'interpretation', ...extra })
async function call(handler: any, body: any, respond: (b: any) => any) {
  const calls: any[] = [], orig = globalThis.fetch
  ;(globalThis as any).fetch = async (_u: any, init: any) => { const b = JSON.parse(init.body); calls.push(b); return new Response(JSON.stringify({ model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(respond(b)) }] }), { status: 200 }) }
  try {
    let status = 0, json: any = null
    const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }
    await handler({ method: 'POST', headers: {}, query: {}, body, [INTERNAL_AI_CALL]: true } as any, res)
    return { status, json, calls }
  } finally { (globalThis as any).fetch = orig }
}
const segSchema = (b: any) => b.output_config.format.schema.properties.chapters.items.properties.segments.items
const longDraft = (dir: any) => ({ title: 't', hook: 'h', targetMinutes: 5, chapters: [{ chapterNo: 1, title: 'a', purpose: 'p', segments: [seg('s1', dir)] }], ending: { speaker: '내레이션', text: 'e' }, shortsSpinOff: [], warnings: [] })
const shortInput = () => ({ contentFormat: 'shorts', title: 's', summary: 'x', sceneStoryboard: Array.from({ length: 12 }, (_, i) => ({ sceneIndex: i + 1 })) })
const shortDraft = (dir: any) => ({ title: 's', hook: '', targetMinutes: 1, chapters: [{ chapterNo: 1, title: 's', purpose: 'p', segments: Array.from({ length: 12 }, (_, i) => ({ ...seg(`장면${i + 1}`, dir), sceneIndex: i + 1 })) }], ending: { speaker: '내레이션', text: '' }, shortsSpinOff: [], warnings: [] })

test('schema allows direction (no unsupported length keyword) and prompt asks for it — Shorts', async () => {
  const r = await call(claudeStoryHandler, { input: shortInput() }, () => shortDraft({ direction: '좁은 방, 소녀가 창을 연다' }))
  assert.equal(r.status, 200); assert.equal(r.calls.length, 1)
  assert.ok(segSchema(r.calls[0]).properties.direction); assert.ok(segSchema(r.calls[0]).required.includes('direction'))
  assert.ok(!JSON.stringify(r.calls[0].output_config).includes('maxLength'))
  assert.match(r.calls[0].system, /direction/)
  assert.equal(r.json.draft.chapters[0].segments[0].direction, '좁은 방, 소녀가 창을 연다'); assert.equal(r.json.draft.chapters[0].segments.length, 12)
})
test('Longform single/chapter paths pass direction through and clamp to 600', async () => {
  const long = 'ㄱ'.repeat(900)
  const a = await call(claudeStoryHandler, { input: { title: 't', targetMinutes: 8, chapterCount: 4 } }, () => longDraft({ direction: long }))
  assert.equal(a.status, 200); assert.equal(a.json.draft.chapters[0].segments[0].direction.length, DIRECTION_MAX); assert.match(a.calls[0].messages[0].content, /direction/)
  const b = await call(claudeStoryHandler, { mode: 'chapter', chapterNo: 1, totalChapters: 3, input: { title: 't', targetMinutes: 9, chapterCount: 3 } }, () => longDraft({ direction: '와이드샷, 책상' }))
  assert.equal(b.json.draft.chapters[0].segments[0].direction, '와이드샷, 책상'); assert.match(b.calls[0].messages[0].content, /direction/)
})
test('backward compatible: responses without direction still succeed and no value is invented', async () => {
  const r = await call(claudeStoryHandler, { input: shortInput() }, () => shortDraft({}))
  assert.equal(r.status, 200); assert.equal('direction' in r.json.draft.chapters[0].segments[0], false)
  assert.equal(normalizeDirection(42), undefined); assert.equal(normalizeDirection('  '), undefined)
})
test('partial revision keeps existing direction; PARTIAL_SCHEMA unchanged', () => {
  const draft = longDraft({ direction: '원본 연출' })
  const m = mergePartial(draft, [{ target: 'c1s1', text: '고친 문장', visualHint: 'v2', factStatus: 'verified' }], [{ key: 'c1s1', kind: 'segment', chapterNo: 1, index: 0 } as any])
  assert.equal(m.draft.chapters[0].segments[0].text, '고친 문장'); assert.equal(m.draft.chapters[0].segments[0].direction, '원본 연출')
  assert.equal((PARTIAL_SCHEMA.properties.items.items.properties as any).direction, undefined)
})
test('full revision (Claude path) restores direction the model dropped, and schema allows it', async () => {
  const draft = longDraft({ direction: '원본 연출' })
  const r = await call(reviseHandler, { input: { draft, qc: { status: 'revision_required', issues: [], revisionInstructions: [] }, handoff: {} } }, () => longDraft({ direction: '' }))
  assert.equal(r.status, 200); assert.ok(segSchema(r.calls[0]).properties.direction)
  assert.equal(r.json.draft.chapters[0].segments[0].direction, '원본 연출')
  assert.equal(preserveDirections(draft, { chapters: [{ chapterNo: 1, segments: [seg('a'), seg('b')] }] }).chapters[0].segments[0].direction, undefined) // 구조가 달라지면 건드리지 않음
})
