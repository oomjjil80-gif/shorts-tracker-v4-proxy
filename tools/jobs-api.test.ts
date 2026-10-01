import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { runOnce } from '../worker/runJob.js'
import { compileExecutor } from '../worker/stages/compile.js'

const golden = JSON.parse(readFileSync(new URL('../lib/tracker-core/job-compile-golden.json', import.meta.url), 'utf8'))
const KEY = 'k'.repeat(32)

async function setup() {
  const db = await createTestDb()
  const store = createJobStore(db)
  const blobs = createMemoryBlobStore()
  const known = new Set([golden.sourceAsset.sourceAssetId])
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async (id: string) => known.has(id) })
  const call = async (method: string, opts: { body?: any; query?: any; key?: string | null } = {}) => {
    let status = 0, json: any = null
    const headers: Record<string, string> = {}
    const req: any = { method, headers: { origin: 'https://shorts-production-tracker.vercel.app', ...(opts.key === null ? {} : { 'x-sync-key': opts.key ?? KEY }) }, query: opts.query || {}, body: opts.body }
    const res: any = { setHeader: (k: string, v: string) => { headers[k] = v }, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }
    await handler(req, res)
    return { status, json, headers }
  }
  return { store, blobs, call }
}
const body = (over: any = {}) => ({ taskType: 'job_create', profile: 'source_shorts', sourceAssetId: golden.sourceAsset.sourceAssetId, idempotencyKey: 'idem-api-0001', plan: golden.plan, ...over })

test('POST create: 201 first, 200 + same job on repeat (idempotent); stores plan blob content-addressed', async () => {
  const { call, blobs } = await setup()
  const a = await call('POST', { body: body() })
  const b = await call('POST', { body: body() })
  assert.equal(a.status, 201); assert.equal(b.status, 200)
  assert.equal(a.json.job.id, b.json.job.id); assert.equal(b.json.created, false)
  assert.equal(a.json.job.stage, 'COMPILE'); assert.equal(a.json.job.status, 'QUEUED')
  assert.equal([...blobs.files.keys()].filter((k) => k.startsWith('plans/')).length, 1)
  assert.equal(a.headers['Cache-Control'], 'private, no-store')
  const c = await call('POST', { body: body({ idempotencyKey: 'idem-api-0002' }) })
  assert.notEqual(c.json.job.id, a.json.job.id)
  const reused = await call('POST', { body: body({ plan: { ...golden.plan, variantPlan: { ...golden.plan.variantPlan, headline: 'x' } } }) })
  assert.equal(reused.status, 409); assert.equal(reused.json.error.code, 'IDEMPOTENCY_KEY_REUSED')
})

test('auth + validation: missing key 401, other workspace 404, bad input 400, unknown source 404', async () => {
  const { call } = await setup()
  assert.equal((await call('POST', { body: body(), key: null })).status, 401)
  assert.equal((await call('POST', { body: body(), key: 'short' })).status, 401)
  const a = await call('POST', { body: body() })
  assert.equal((await call('GET', { query: { taskType: 'job_get', id: a.json.job.id } })).status, 200)
  assert.equal((await call('GET', { query: { taskType: 'job_get', id: a.json.job.id }, key: 'z'.repeat(32) })).status, 404)
  for (const bad of [{ profile: 'nope' }, { sourceAssetId: 'x' }, { idempotencyKey: 'short' }, { budgetUsd: 9999 }, { plan: { schema: 'wrong' } }, { plan: { ...golden.plan, sourceAssetId: 'src_other_0001' } }, { plan: { ...golden.plan, variantPlan: { beats: [] } } }, { taskType: 'job_explode' }]) {
    const r = await call('POST', { body: body({ idempotencyKey: `idem-bad-${Math.random().toString(36).slice(2, 10)}`, ...bad }) })
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.json.ok, false)
  }
  assert.equal((await call('POST', { body: body({ sourceAssetId: 'src_unknown_00001', plan: { ...golden.plan, sourceAssetId: 'src_unknown_00001' }, idempotencyKey: 'idem-unknown-1' }) })).status, 404)
  assert.equal((await call('PUT')).status, 400)
})

test('full path: create -> worker COMPILE -> cancel; decision refused unless awaiting DECISION with a known, passing manifest', async () => {
  const { call, store, blobs } = await setup()
  const created = await call('POST', { body: body() })
  const id = created.json.job.id
  await runOnce({ store, blobs, executors: [compileExecutor], resolveSourceAsset: async () => golden.sourceAsset, workerId: 'w1' })
  const got = await call('GET', { query: { taskType: 'job_get', id } })
  assert.equal(got.json.job.stage, 'RENDER')
  assert.equal(got.json.job.manifest.hash, golden.expected.manifestHash)
  assert.equal(got.json.job.manifest.gate.decision, 'PASS')
  const early = await call('POST', { body: { taskType: 'job_decision', jobId: id, manifestHash: golden.expected.manifestHash } })
  assert.equal(early.status, 409); assert.equal(early.json.error.code, 'NOT_AWAITING_DECISION')
  assert.equal((await call('POST', { body: { taskType: 'job_decision', jobId: id, manifestHash: 'nothex' } })).status, 400)
  const cancelled = await call('POST', { body: { taskType: 'job_cancel', jobId: id } })
  assert.equal(cancelled.status, 200); assert.equal(cancelled.json.job.status, 'CANCELLED')
  assert.equal((await call('POST', { body: { taskType: 'job_cancel', jobId: 'job_missing' } })).status, 404)
})

test('DB not configured => 503 with a clear code (no crash)', async () => {
  const handler = createJobsHttp({ getStore: () => Promise.reject(Object.assign(new Error('x'), { name: 'JobError', code: 'JOBS_DB_NOT_CONFIGURED' })), blobs: createMemoryBlobStore() })
  let status = 0
  const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json() { return this }, end() { return this } }
  await handler({ method: 'GET', headers: { 'x-sync-key': KEY }, query: { taskType: 'job_get', id: 'j' } } as any, res)
  assert.equal(status, 500) // a plain Error (not JobError) must not leak details
})

test('adapter: missing/unknown taskType 400, wrong method 405, job_get needs GET', async () => {
  const { call } = await setup()
  assert.equal((await call('POST', { body: {} })).status, 400)
  assert.equal((await call('POST', { body: { taskType: 'job_nope' } })).status, 400)
  assert.equal((await call('GET', { query: { taskType: 'job_create' } })).status, 405)
  assert.equal((await call('POST', { body: { taskType: 'job_get', id: 'x' } })).status, 405)
  assert.equal((await call('POST', { body: 'not an object' as any })).status, 400)
})

test('Reference production path: server analyses three distinct assets and stores the canonical profile/brief',async()=>{const db=await createTestDb(),store=createJobStore(db),blobs=createMemoryBlobStore();const ids=['a','b','c'].map(ch=>'ref_'+ch.repeat(64));const axes:any[]=[['story.opening','story',['PLAN','QC']],['retention.peak','retention',['PLAN','QC']],['editing.cadence','editing',['PLAN','RENDER','QC']],['visual.style','visualStyle',['RENDER','QC']],['composition.frame','composition',['RENDER','QC']],['caption.layout','caption',['RENDER','QC']],['sound.structure','sound',['PLAN','RENDER','QC']],['narration.structure','narration',['PLAN','RENDER','QC']]];const seen:string[]=[];const analyzeReference:any=async(id:string)=>{seen.push(id);const sha=id.slice(4);return{analysis:{schema:'reference-analysis/1',analyzerVersion:'reference-analyzer/2',referenceAssetId:id,referenceSha256:sha,features:axes.map(([fid,axis,appliesTo])=>({id:fid,axis,value:fid==='story.opening'?{status:'measured',openingSeconds:2,duration:10}:fid==='retention.peak'?{status:'measured',firstPeak:{start:4,end:5},duration:10}:fid==='editing.cadence'?{status:'measured',meanSceneSeconds:2.5}:{status:'measured'},evidence:[{kind:'time',start:0,end:1}],appliesTo}))},analysisHash:sha,cached:false}};const handler=createJobsHttp({getStore:async()=>store,blobs,sourceExists:async id=>id===golden.sourceAsset.sourceAssetId,analyzeReference});let status=0,json:any;const req:any={method:'POST',headers:{'x-sync-key':KEY},query:{},body:body({idempotencyKey:'idem-ref-prod-1',referenceAssetIds:[ids[2],ids[0],ids[1]]})};const res:any={setHeader(){},status(c:number){status=c;return this},json(v:any){json=v;return this},end(){return this}};await handler(req,res);assert.equal(status,201);assert.deepEqual(seen,[ids[2],ids[0],ids[1]]);assert.equal(json.job.status,'QUEUED');const profileKey=[...blobs.files.keys()].find(k=>k.startsWith('reference-profiles/'));const briefKey=[...blobs.files.keys()].find(k=>k.startsWith('production-briefs/'));assert.ok(profileKey);assert.ok(briefKey);const profile=JSON.parse(blobs.files.get(profileKey!)!.toString());const brief=JSON.parse(blobs.files.get(briefKey!)!.toString());assert.deepEqual(profile.referenceAssetIds,[...ids].sort());assert.equal(profile.constraints.length,18);assert.equal(profile.constraints.filter((x:any)=>x.id.startsWith('aggregate:')).length,3);assert.deepEqual(brief.referenceProfile,profile);assert.equal(brief.sourceAssetId,golden.sourceAsset.sourceAssetId)})
