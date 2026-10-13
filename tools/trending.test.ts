// 급상승 탐색: collect + rank with a stand-in YouTube API (no network, no paid call).
// Run: node --import tsx --test tools/trending.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTestDb } from './testDb.js'
import { collectTrending, rankTrending, trendingSnapshot, latestCollected, COLLECTED_MAX } from '../lib/trending/trending.js'
import { createTrendingHttp } from '../lib/trending/http.js'

const GROUPS = { KR: ['KR'], GLOBAL: ['US', 'JP'] }
const vid = (id: string, views: number | undefined) => ({ id, snippet: { title: `t-${id}`, channelTitle: 'c', thumbnails: { medium: { url: `https://i.ytimg.com/${id}.jpg` } } }, statistics: views === undefined ? {} : { viewCount: String(views) } })
// views[region] = list of [id, views]
function api(views: Record<string, Array<[string, number | undefined]>>, fail: string[] = []) {
  const calls: string[] = []
  const f: any = async (u: URL) => { const r = u.searchParams.get('regionCode')!; calls.push(r); return fail.includes(r) ? new Response('quota', { status: 403 }) : new Response(JSON.stringify({ items: (views[r] ?? []).map(([i, v]) => vid(i, v)) }), { status: 200 }) }
  return { f, calls }
}
async function db() { const d = await createTestDb(); await d.raw.exec(readFileSync(new URL('../db/003_trending.sql', import.meta.url), 'utf8')); return d }
const H = 3_600_000, T0 = new Date('2026-10-13T00:00:00Z')

test('growth ranking: real delta, KR/GLOBAL separate, first-seen + hidden counts excluded, dedupe, normalised per hour', async () => {
  const d = await db()
  const a = api({ KR: [['k1', 1000], ['k2', 5000], ['k3', 100]], US: [['g1', 10_000], ['g2', 2000]], JP: [['g1', 10_500], ['g3', 50]] })
  await collectTrending(d, { apiKey: 'k', fetchImpl: a.f, now: T0, groups: GROUPS })
  // first collection: nothing has a baseline yet -> nothing is ranked
  assert.deepEqual((await rankTrending(d, 'KR', ['KR'])).items, [])
  const b = api({ KR: [['k1', 1900], ['k2', 5300], ['kNew', 9999], ['k3', undefined]], US: [['g1', 11_000], ['g2', 4000]], JP: [['g1', 12_000], ['g3', 60]] })
  const r = await collectTrending(d, { apiKey: 'k', fetchImpl: b.f, now: new Date(T0.getTime() + 2 * H), groups: GROUPS }) // 2 h gap
  assert.equal(r.ran, true)
  const kr = await rankTrending(d, 'KR', ['KR'])
  assert.deepEqual(kr.items.map((x) => [x.videoId, x.deltaPerHour]), [['k1', 450], ['k2', 150]], 'per-hour: 900/2h, 300/2h; kNew (first seen) and k3 (hidden count) excluded')
  assert.equal(kr.items[0].intervalMinutes, 120)
  const gl = await rankTrending(d, 'GLOBAL', ['US', 'JP'])
  // g1 appears in US and JP: ONE entry (highest observed views), g2 +2000/2h=1000/h, g1 (12000-10500)/2h=750/h
  assert.deepEqual(gl.items.map((x) => [x.videoId, x.deltaPerHour]), [['g2', 1000], ['g1', 750], ['g3', 5]])
  assert.ok(!kr.items.some((x) => x.videoId.startsWith('g')), 'lists are separate')
  assert.equal(gl.items[0].url, 'https://www.youtube.com/watch?v=g2')
  assert.equal(gl.items[0].collectedAt, new Date(T0.getTime() + 2 * H).toISOString())
})

test('fewer than 20 stays fewer; more than 20 is cut to 20', async () => {
  const d = await db()
  const ids = Array.from({ length: 30 }, (_, i) => `v${i}`)
  await collectTrending(d, { apiKey: 'k', fetchImpl: api({ KR: ids.map((i) => [i, 1000] as [string, number]) }).f, now: T0, groups: GROUPS })
  await collectTrending(d, { apiKey: 'k', fetchImpl: api({ KR: ids.map((i, n) => [i, 1000 + (n + 1) * 10] as [string, number]) }).f, now: new Date(T0.getTime() + H), groups: GROUPS })
  const kr = await rankTrending(d, 'KR', ['KR'])
  assert.equal(kr.items.length, 20); assert.equal(kr.ranked, 30); assert.equal(kr.items[0].videoId, 'v29')
  assert.equal((await rankTrending(d, 'GLOBAL', ['US'])).items.length, 0, 'nothing is invented for an empty group')
})

test('duplicate runs: a second call inside the hour does nothing and calls no API', async () => {
  const d = await db(), a = api({ KR: [['k1', 1]] })
  await collectTrending(d, { apiKey: 'k', fetchImpl: a.f, now: T0, groups: GROUPS })
  const n = a.calls.length
  const again = await collectTrending(d, { apiKey: 'k', fetchImpl: a.f, now: new Date(T0.getTime() + 20 * 60_000), groups: GROUPS })
  assert.equal(again.ran, false); assert.equal(a.calls.length, n)
  assert.equal((await collectTrending(d, { apiKey: 'k', fetchImpl: a.f, now: new Date(T0.getTime() + H), groups: GROUPS })).ran, true)
})

test('failure keeps the last good data: all regions failing writes nothing and retries in 10 min; a failed group never wipes the other', async () => {
  const d = await db()
  await collectTrending(d, { apiKey: 'k', fetchImpl: api({ KR: [['k1', 1000]], US: [['g1', 1000]] }).f, now: T0, groups: GROUPS })
  const bad = api({}, ['KR', 'US', 'JP'])
  const t1 = new Date(T0.getTime() + H)
  const r = await collectTrending(d, { apiKey: 'k', fetchImpl: bad.f, now: t1, groups: GROUPS })
  assert.equal(r.ran, true); assert.deepEqual(r.inserted, { KR: 0, GLOBAL: 0 }); assert.match(r.errors[0], /403/)
  assert.equal((await d.query(`SELECT count(*)::int AS n FROM trend_observations`)).rows[0].n, 2, 'nothing deleted or overwritten')
  assert.equal((await trendingSnapshot(d)).collector?.status, 'failed')
  const ok = api({ KR: [['k1', 1600]] }, ['US', 'JP'])
  assert.equal((await collectTrending(d, { apiKey: 'k', fetchImpl: ok.f, now: new Date(t1.getTime() + 5 * 60_000), groups: GROUPS })).ran, false, 'retry not before 10 min')
  const r2 = await collectTrending(d, { apiKey: 'k', fetchImpl: ok.f, now: new Date(t1.getTime() + 11 * 60_000), groups: GROUPS })
  assert.deepEqual(r2.inserted, { KR: 1, GLOBAL: 0 }) // KR collected, GLOBAL failed -> its old data remains
  assert.equal((await collectTrending(d, { apiKey: '', now: T0, groups: GROUPS })).reason, 'YOUTUBE_API_KEY is not configured')
})

test('API: needs X-Sync-Key, GET only, returns the snapshot with the candidate-pool note', async () => {
  const d = await db()
  await collectTrending(d, { apiKey: 'k', fetchImpl: api({ KR: [['k1', 1000]] }).f, now: T0, groups: GROUPS })
  await collectTrending(d, { apiKey: 'k', fetchImpl: api({ KR: [['k1', 1500]] }).f, now: new Date(T0.getTime() + H), groups: GROUPS })
  const h = createTrendingHttp(async () => d)
  const call = async (method: string, key?: string) => { let status = 0, json: any; await h({ method, headers: key ? { 'x-sync-key': key } : {} } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this } } as any); return { status, json } }
  assert.equal((await call('GET')).status, 401); assert.equal((await call('POST', 'k'.repeat(30))).status, 405)
  const r = await call('GET', 'k'.repeat(30))
  assert.equal(r.status, 200); assert.equal(r.json.KR.items[0].deltaPerHour, 500); assert.deepEqual(r.json.GLOBAL.items, [])
  assert.match(r.json.note, /공식 급상승 순위가 아닙니다/)
})

test('수집 영상: shown from the FIRST collection (no baseline), view-count order, KR/GLOBAL separate, ranking unchanged', async () => {
  const d = await db()
  await collectTrending(d, { apiKey: 'k', fetchImpl: api({ KR: [['k1', 1000], ['k2', 5000], ['k3', 100]], US: [['g1', 10_000], ['g2', 2000]], JP: [['g1', 10_500]] }).f, now: T0, groups: GROUPS })
  assert.deepEqual((await rankTrending(d, 'KR', ['KR'])).items, [], 'no growth baseline yet -> no TOP 20')
  const kr = await latestCollected(d, 'KR'), gl = await latestCollected(d, 'GLOBAL')
  assert.deepEqual(kr.items.map((x) => [x.videoId, x.viewCount]), [['k2', 5000], ['k1', 1000], ['k3', 100]])
  assert.deepEqual(gl.items.map((x) => [x.videoId, x.viewCount]), [['g1', 10_500], ['g2', 2000]], 'cross-region duplicate kept once')
  assert.equal(kr.total, 3); assert.equal(kr.collectedAt, T0.toISOString())
  assert.deepEqual([kr.items[0].title, kr.items[0].channel, kr.items[0].thumbnailUrl, kr.items[0].url], ['t-k2', 'c', 'https://i.ytimg.com/k2.jpg', 'https://www.youtube.com/watch?v=k2'])
  const snap: any = await trendingSnapshot(d)
  assert.equal(snap.collected.KR.items.length, 3); assert.deepEqual(snap.KR.items, []); assert.equal(snap.GLOBAL.ranked, 0)
  // only the LATEST batch is listed; a video that dropped out of the chart is not shown as current
  await collectTrending(d, { apiKey: 'k', fetchImpl: api({ KR: [['k1', 1900], ['k2', 5300]] }).f, now: new Date(T0.getTime() + H), groups: GROUPS })
  assert.deepEqual((await latestCollected(d, 'KR')).items.map((x) => x.videoId), ['k2', 'k1'])
  assert.deepEqual((await rankTrending(d, 'KR', ['KR'])).items.map((x) => [x.videoId, x.deltaPerHour]), [['k1', 900], ['k2', 300]], 'TOP 20 rule unchanged')
  assert.equal((await latestCollected(await db(), 'KR')).collectedAt, null, 'empty DB -> empty list, nothing invented')
})

test('수집 영상 is capped for the response but reports the real total', async () => {
  const d = await db(), ids = Array.from({ length: COLLECTED_MAX + 5 }, (_, i) => `v${String(i).padStart(3, '0')}`)
  const mk = (rows: Array<[string, number]>) => ({ f: (async (u: URL) => new Response(JSON.stringify({ items: u.searchParams.get('regionCode') === 'KR' ? rows.map(([i, v]) => vid(i, v)) : [] }), { status: 200 })) as any })
  await collectTrending(d, { apiKey: 'k', fetchImpl: mk(ids.map((i, n) => [i, n + 1] as [string, number])).f, now: T0, groups: GROUPS })
  const kr = await latestCollected(d, 'KR')
  assert.equal(kr.items.length, COLLECTED_MAX); assert.equal(kr.total, COLLECTED_MAX + 5); assert.equal(kr.items[0].viewCount, COLLECTED_MAX + 5)
})
