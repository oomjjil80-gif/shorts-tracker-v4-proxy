import test from 'node:test'
import assert from 'node:assert/strict'
import handler from '../api/story.js'

// The Hobby plan allows 12 Serverless Functions, so Job API traffic rides on api/story.ts (taskType job_*).
// These tests pin the router: job_* goes to lib/jobs/http, every pre-existing taskType still goes where it did.

const KEY = 'k'.repeat(32)
async function call(method: string, o: { body?: any; query?: any; key?: string | null; origin?: string } = {}) {
  let status = 0, json: any = null
  const headers: Record<string, string> = {}
  const req: any = { method, headers: { ...(o.origin ? { origin: o.origin } : {}), ...(o.key === null ? {} : { 'x-sync-key': o.key ?? KEY }) }, query: o.query || {}, body: o.body }
  const res: any = { setHeader: (k: string, v: string) => { headers[k] = v }, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this }, send(b: any) { json = b; return this }, write() { return true } }
  await handler(req, res)
  return { status, json, headers }
}

test('preflight allows the X-Sync-Key header the job API needs (and still 204s)', async () => {
  const r = await call('OPTIONS', { origin: 'https://shorts-production-tracker.vercel.app' })
  assert.equal(r.status, 204)
  assert.match(r.headers['Access-Control-Allow-Headers'], /X-Sync-Key/)
  assert.match(r.headers['Access-Control-Allow-Headers'], /Content-Type/)
})

test('job_* is routed to the job adapter: auth 401, unknown 400, wrong method 405, no DB => 503 (no crash)', async () => {
  const saved = process.env.DATABASE_URL; delete process.env.DATABASE_URL
  try {
    assert.equal((await call('GET', { query: { taskType: 'job_get', id: 'j' }, key: null })).status, 401)
    const noDb = await call('GET', { query: { taskType: 'job_get', id: 'j' } })
    assert.equal(noDb.status, 503); assert.equal(noDb.json.error.code, 'JOBS_DB_NOT_CONFIGURED')
    const create = await call('POST', { body: { taskType: 'job_create', profile: 'source_shorts' } })
    assert.equal(create.status, 503)
    const unknown = await call('POST', { body: { taskType: 'job_explode' } })
    assert.equal(unknown.status, 400); assert.equal(unknown.json.ok, false)
    assert.equal((await call('POST', { body: { taskType: 'job_get' } })).status, 405)
    assert.equal(noDb.headers['Cache-Control'], 'private, no-store')
  } finally { if (saved !== undefined) process.env.DATABASE_URL = saved }
})

test('regression: existing source taskTypes are still handled by their own code paths (not the job router, not OpenAI)', async () => {
  const savedCobalt = process.env.COBALT_API_URL; delete process.env.COBALT_API_URL
  try {
    const collect = await call('POST', { body: { taskType: 'source_collect', url: 'https://example.com/v' } })
    assert.notEqual(collect.status, 405); assert.equal(collect.json.ok, false)
    assert.ok(collect.json.error?.code, 'source_collect returns its own error contract')
    assert.ok(!String(collect.json.error.code).startsWith('JOB'))
    for (const taskType of ['source_asset', 'source_playback', 'source_download', 'source_frame', 'source_frames', 'source_contact_sheet']) {
      const r = await call('POST', { body: { taskType, sourceAssetId: 'not-a-real-id', second: 1, seconds: '1,2', interval: 1 } })
      assert.ok(r.status >= 400 && r.status < 600, `${taskType} -> ${r.status}`)
      assert.notEqual(r.status, 405, taskType)
      assert.ok(!JSON.stringify(r.json ?? '').includes('OPENAI_API_KEY'), `${taskType} must not fall through to the OpenAI path`)
      assert.ok(!JSON.stringify(r.json ?? '').includes('job'), `${taskType} must not be swallowed by the job router`)
    }
    const latest = await call('GET', { query: { taskType: 'source_latest', limit: '1' } })
    assert.ok(!JSON.stringify(latest.json ?? '').includes('OPENAI_API_KEY'))
  } finally { if (savedCobalt !== undefined) process.env.COBALT_API_URL = savedCobalt }
})

test('regression: non-job task types keep falling through (jobs_x / story are not intercepted)', async () => {
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY
  try {
    for (const taskType of ['jobs_x', 'story', 'longform_chapter', 'visual_director', undefined]) {
      const r = await call('POST', { body: { taskType } })
      assert.equal(r.status, 503, String(taskType)); assert.match(r.json.error.message, /OPENAI_API_KEY/)
    }
    assert.equal((await call('PUT', { body: {} })).status, 405)
  } finally { if (saved !== undefined) process.env.OPENAI_API_KEY = saved }
})
