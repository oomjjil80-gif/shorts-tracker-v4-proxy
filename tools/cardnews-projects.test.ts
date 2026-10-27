// 카드뉴스 작업 분리: 예전 단일 저장본(판테온) 보존 + 작업별 저장·목록·복원(가짜 저장소, 무료). Run: node --import tsx --test tools/cardnews-projects.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createCardnewsHttp } from '../lib/cardnews/http.js'
import { sanitizeImages } from '../lib/cardnews/cardnews.js'

const KEY = 'k'.repeat(32)
function rig() {
  const blobs = createMemoryBlobStore(), h = createCardnewsHttp({ blobs, deps: () => ({}) as any })
  const call = async (method: string, body: any) => { let status = 0, out: any; await h({ method, headers: { 'x-sync-key': KEY }, body: method === 'POST' ? body : undefined, query: method === 'GET' ? body : undefined } as any, { setHeader() {}, status(s: number) { status = s; return this }, json(b: any) { out = b; return this } } as any); return { status, body: out } }
  return { blobs, call }
}
const pantheon = { material: '판테온 돔은 왜 무너지지 않았을까', cover: { id: 'cv_1a2b3c4d', title: '판테온의 비밀', coverLine: '판테온', promise: '돔이 무너지지 않는 이유' }, cards: [], theme: 'night' }

test('예전 단일 저장본(판테온)은 그대로 · 새 작업은 별도 경로 · 서로 섞이지 않음 · 목록에 둘 다', async () => {
  const { call } = rig()
  assert.equal((await call('POST', { taskType: 'cardnews_save', state: pantheon, baseRev: 0 })).body.saved.rev, 1)
  const pid = 'p_abc123xyz'
  const s = await call('POST', { taskType: 'cardnews_save', projectId: pid, state: { material: '외눈박이 치즈 장인', form: { title: '외눈박이 치즈 장인' } }, baseRev: 0 })
  assert.equal(s.status, 200); assert.equal(s.body.saved.rev, 1)
  const legacy = await call('GET', { taskType: 'cardnews_get' }), mine = await call('GET', { taskType: 'cardnews_get', projectId: pid })
  assert.equal(legacy.body.saved.state.cover.title, '판테온의 비밀'); assert.equal(legacy.body.saved.rev, 1, 'legacy untouched')
  assert.equal(mine.body.saved.state.material, '외눈박이 치즈 장인'); assert.equal(mine.body.saved.state.cover, null, 'no Pantheon data in the new project')
  const list = (await call('GET', { taskType: 'cardnews_list' })).body.projects
  assert.deepEqual(list.map((x: any) => [x.id, x.title, !!x.legacy]).sort(), [['', '판테온의 비밀', true], [pid, '외눈박이 치즈 장인', false]].sort())
  assert.ok(list.every((x: any) => x.savedAt))
})

test('같은 새 작업 ID를 두 번 처음 저장(연속 클릭)해도 작업은 1개 · 두 번째는 충돌로 거절', async () => {
  const { call } = rig(), pid = 'p_dup000001'
  const [a, b] = await Promise.all([call('POST', { taskType: 'cardnews_save', projectId: pid, state: { material: 'x' }, baseRev: 0 }), call('POST', { taskType: 'cardnews_save', projectId: pid, state: { material: 'x' }, baseRev: 0 })])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  assert.equal((await call('GET', { taskType: 'cardnews_list' })).body.projects.filter((x: any) => x.id === pid).length, 1)
})

test('작업 ID 형식이 아니면 작업 경로로 쓰지 않음(경로 조작 차단) · 표지 이미지 버전도 저장(표지 + 본문 10장)', async () => {
  const { call } = rig()
  await call('POST', { taskType: 'cardnews_save', state: pantheon, baseRev: 0 })
  assert.equal((await call('GET', { taskType: 'cardnews_get', projectId: '../evil' })).status, 400)
  assert.equal((await call('POST', { taskType: 'cardnews_save', projectId: 'evil', state: { material: 'overwrite?' }, baseRev: 1 })).status, 400)
  assert.equal((await call('GET', { taskType: 'cardnews_get' })).body.saved.state.cover.title, '판테온의 비밀', 'a malformed id never writes the legacy Pantheon state')
  const ws = 'a'.repeat(64), ref = `cardnews/${ws}/images/${'1'.repeat(64)}.png`
  const imgs: any = { cover: { selected: 'v1', versions: [{ id: 'v1', ref, style: 's', at: 't' }] } }
  for (let i = 1; i <= 10; i++) imgs[`c${i}`] = { selected: 'v1', versions: [{ id: 'v1', ref, style: 's', at: 't' }] }
  const out = sanitizeImages(imgs, ws); assert.ok(out.cover); assert.equal(Object.keys(out).length, 11, 'cover + 10 cards')
})
