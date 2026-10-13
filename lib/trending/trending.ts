// 급상승 탐색: collect real view counts hourly, rank by real view-count growth. No estimates, no AI.
// Source = YouTube Data API v3 `videos.list chart=mostPopular` (statistics.viewCount, per regionCode). The list is the
// OBSERVABLE CANDIDATE POOL (each region's mostPopular chart), not a platform-wide official surge ranking.
import type { Queryable, SqlDb } from '../jobs/db.js'

export type TrendGroup = 'KR' | 'GLOBAL'
export type TrendVideo = { videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; regionCode: string }
export const TREND_TOP = 20
export const COLLECT_EVERY_MS = 60 * 60_000
export const RETRY_AFTER_FAIL_MS = 10 * 60_000
export const BASELINE = { minMs: 30 * 60_000, maxMs: 6 * 60 * 60_000 } // previous observation 30 min .. 6 h before the latest
const KEEP_DAYS = 7
export const trendGroups = (env: Record<string, string | undefined> = process.env): Record<TrendGroup, string[]> => ({
  KR: ['KR'],
  GLOBAL: String(env.TREND_GLOBAL_REGIONS || 'US,JP,GB').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
})

export async function fetchMostPopular(o: { apiKey: string; regionCode: string; fetchImpl?: typeof fetch }): Promise<TrendVideo[]> {
  const f = o.fetchImpl ?? fetch
  const u = new URL('https://www.googleapis.com/youtube/v3/videos')
  u.search = new URLSearchParams({ part: 'snippet,statistics', chart: 'mostPopular', regionCode: o.regionCode, maxResults: '50', key: o.apiKey }).toString()
  const res = await f(u)
  if (!res.ok) throw new Error(`YouTube ${o.regionCode} HTTP ${res.status}`)
  const j: any = await res.json()
  const out: TrendVideo[] = []
  for (const it of Array.isArray(j?.items) ? j.items : []) {
    const views = Number(it?.statistics?.viewCount)
    // hidden / missing view counts are excluded, never guessed
    if (!it?.id || !String(it?.snippet?.title || '').trim() || !Number.isFinite(views) || views < 0 || it?.statistics?.viewCount == null) continue
    const th = it.snippet.thumbnails ?? {}
    out.push({ videoId: String(it.id), title: String(it.snippet.title), channel: String(it.snippet.channelTitle || ''), thumbnailUrl: String((th.medium ?? th.high ?? th.default)?.url || ''), viewCount: views, regionCode: o.regionCode })
  }
  return out
}

// hourly claim shared by every worker/restart: only one caller wins per window; a failed run retries after 10 min
async function claim(db: Queryable, now: Date): Promise<boolean> {
  await db.query(`INSERT INTO trend_state (key, last_run_at) VALUES ('collect', $1) ON CONFLICT (key) DO NOTHING`, [new Date(now.getTime() - COLLECT_EVERY_MS - 1)])
  const r = await db.query(`UPDATE trend_state SET last_run_at=$1 WHERE key='collect' AND last_run_at <= $2 RETURNING key`, [now, new Date(now.getTime() - COLLECT_EVERY_MS)])
  return r.rowCount > 0
}

export type CollectResult = { ran: boolean; reason?: string; inserted: Record<TrendGroup, number>; errors: string[] }
export async function collectTrending(db: SqlDb, o: { apiKey: string; fetchImpl?: typeof fetch; now?: Date; groups?: Record<TrendGroup, string[]> }): Promise<CollectResult> {
  const now = o.now ?? new Date(), groups = o.groups ?? trendGroups()
  const result: CollectResult = { ran: false, inserted: { KR: 0, GLOBAL: 0 }, errors: [] }
  if (!o.apiKey) return { ...result, reason: 'YOUTUBE_API_KEY is not configured' }
  if (!(await claim(db, now))) return { ...result, reason: 'already collected within the last hour' }
  result.ran = true
  const batches: Array<[TrendGroup, TrendVideo[]]> = []
  for (const g of ['KR', 'GLOBAL'] as TrendGroup[]) {
    const byId = new Map<string, TrendVideo>()
    let okRegions = 0
    for (const region of groups[g]) {
      try { for (const v of await fetchMostPopular({ apiKey: o.apiKey, regionCode: region, fetchImpl: o.fetchImpl })) { const p = byId.get(v.videoId); if (!p || v.viewCount > p.viewCount) byId.set(v.videoId, v) } okRegions++ }
      catch (e: any) { result.errors.push(String(e?.message || e).replace(/key=[^&\s]+/g, 'key=[hidden]')) }
    }
    if (okRegions) batches.push([g, [...byId.values()]]) // a group with no successful region writes nothing: the last good data stays
  }
  await db.transaction(async (tx) => {
    for (const [g, vids] of batches) for (const v of vids) {
      await tx.query(`INSERT INTO trend_observations (list_group, video_id, region_code, title, channel, thumbnail_url, view_count, observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [g, v.videoId, v.regionCode, v.title, v.channel, v.thumbnailUrl, v.viewCount, now])
      result.inserted[g]++
    }
    await tx.query(`DELETE FROM trend_observations WHERE observed_at < $1`, [new Date(now.getTime() - KEEP_DAYS * 86_400_000)])
  })
  const failed = batches.length < 2 || result.errors.length > 0
  await db.query(`UPDATE trend_state SET last_status=$1, last_error=$2, last_run_at=$3 WHERE key='collect'`,
    [failed ? (batches.length ? 'partial' : 'failed') : 'ok', result.errors.join('; ').slice(0, 500), batches.length ? now : new Date(now.getTime() - COLLECT_EVERY_MS + RETRY_AFTER_FAIL_MS)])
  return result
}

export type TrendItem = { rank: number; videoId: string; title: string; channel: string; thumbnailUrl: string; url: string; viewCount: number; deltaPerHour: number; intervalMinutes: number; collectedAt: string; previousCollectedAt: string }
export type TrendList = { group: TrendGroup; regions: string[]; collectedAt: string | null; candidates: number; ranked: number; items: TrendItem[] }

// growth = current views − previous views, normalised to per hour when the observation gap is not exactly 1 h.
// First-seen videos (no baseline in the window), videos with non-positive growth and missing counts are not ranked.
export async function rankTrending(db: Queryable, group: TrendGroup, regions: string[] = trendGroups()[group]): Promise<TrendList> {
  const empty: TrendList = { group, regions, collectedAt: null, candidates: 0, ranked: 0, items: [] }
  const latest = (await db.query<{ t: Date }>(`SELECT max(observed_at) AS t FROM trend_observations WHERE list_group=$1`, [group])).rows[0]?.t
  if (!latest) return empty
  const T = new Date(latest)
  const cur = (await db.query<any>(`SELECT video_id, title, channel, thumbnail_url, view_count FROM trend_observations WHERE list_group=$1 AND observed_at=$2`, [group, T])).rows
  if (!cur.length) return empty
  const prev = (await db.query<any>(
    `SELECT DISTINCT ON (video_id) video_id, view_count, observed_at FROM trend_observations WHERE list_group=$1 AND observed_at BETWEEN $2 AND $3 AND video_id = ANY($4::text[]) ORDER BY video_id, observed_at DESC`,
    [group, new Date(T.getTime() - BASELINE.maxMs), new Date(T.getTime() - BASELINE.minMs), cur.map((r: any) => r.video_id)])).rows
  const pm = new Map(prev.map((r: any) => [r.video_id, r]))
  const items: TrendItem[] = []
  for (const r of cur) {
    const p: any = pm.get(r.video_id); if (!p) continue
    const hours = (T.getTime() - new Date(p.observed_at).getTime()) / 3_600_000
    const delta = Number(r.view_count) - Number(p.view_count)
    if (delta <= 0) continue
    items.push({ rank: 0, videoId: r.video_id, title: r.title, channel: r.channel, thumbnailUrl: r.thumbnail_url, url: `https://www.youtube.com/watch?v=${r.video_id}`, viewCount: Number(r.view_count), deltaPerHour: Math.round(delta / hours), intervalMinutes: Math.round(hours * 60), collectedAt: T.toISOString(), previousCollectedAt: new Date(p.observed_at).toISOString() })
  }
  items.sort((a, b) => b.deltaPerHour - a.deltaPerHour || b.viewCount - a.viewCount)
  const top = items.slice(0, TREND_TOP).map((x, i) => ({ ...x, rank: i + 1 }))
  return { group, regions, collectedAt: T.toISOString(), candidates: cur.length, ranked: items.length, items: top }
}

export async function trendingSnapshot(db: Queryable) {
  const st = (await db.query<any>(`SELECT last_run_at, last_status, last_error FROM trend_state WHERE key='collect'`)).rows[0]
  return {
    KR: await rankTrending(db, 'KR'), GLOBAL: await rankTrending(db, 'GLOBAL'),
    collector: st ? { lastRunAt: new Date(st.last_run_at).toISOString(), status: st.last_status, error: st.last_error } : null,
    note: '관측 가능한 후보 영상(각 지역 YouTube 인기 차트) 안의 순위이며 플랫폼 전체의 공식 급상승 순위가 아닙니다.'
  }
}
