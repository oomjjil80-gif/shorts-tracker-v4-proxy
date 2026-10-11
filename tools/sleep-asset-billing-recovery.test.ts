import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'

const KEY='z'.repeat(32), ws=createHash('sha256').update(KEY).digest('hex')
async function fixture(options:{offline?:boolean;billing?:boolean;profile?:string}={}) {
  const db=await createTestDb(),store=createJobStore(db)
  const profile=options.profile??'wisdom_longform'
  const {job}=await store.createJob({workspaceId:ws,profile,sourceAssetId:'',idempotencyKey:'restore-asset-billing-1',planRef:'generative-briefs/real-odyssey.json',budgetUsd:5})
  if(options.offline!==false) await store.appendStageRun({
    jobId:job.id,stage:'PLAN',kind:'repair',attempt:1,status:'SUCCEEDED',
    result:{provider:'offline-recovery',scriptRef:'generative-scripts/saved.json',sections:9}
  })
  await store.appendStageRun({
    jobId:job.id,stage:'ASSET',kind:'run',attempt:1,status:'FAILED',
    error:{code:options.billing===false?'TTS_INVALID':'PROVIDER_BILLING',message:'OpenAI credits depleted'},
    usage:{schema:'usage/1',paidCalls:1,estUsd:0.067,byModel:{}}
  })
  await db.query("UPDATE production_jobs SET status='FAILED',stage='ASSET',wait_reason=NULL WHERE id=$1",[job.id])
  const handler=createJobsHttp({getStore:async()=>store,blobs:createMemoryBlobStore()})
  const call=async (key=KEY)=>{
    let code=0,result:any
    const req:any={method:'POST',headers:{'x-sync-key':key},query:{},body:{taskType:'job_recover_asset_billing',jobId:job.id}}
    const res:any={setHeader(){},status(n:number){code=n;return this},json(o:any){result=o;return this},end(){return this}}
    await handler(req,res);return {code,result}
  }
  return {db,store,job,call}
}
test('real recovered Odyssey PLAN + OpenAI 429 returns SAME FAILED ASSET Job to waiting, no worker or provider',async()=>{
  const {store,job,call}=await fixture()
  const before=await store.listStageRuns(job.id)
  const first=await call()
  assert.equal(first.code,200)
  assert.equal(first.result.job.id,job.id)
  assert.equal(first.result.job.stage,'ASSET')
  assert.equal(first.result.job.status,'WAITING_USER')
  assert.equal(first.result.job.waitReason,'PROVIDER_DOWN')
  assert.equal(first.result.zeroPaidCalls,true)
  assert.equal(first.result.resumeRequiresOpenAiCredits,true)
  assert.deepEqual(await store.listStageRuns(job.id),before,'original manuscript and Gemini attempt preserved')
  const again=await call()
  assert.equal(again.code,200,'idempotent, no re-billing')
  assert.deepEqual(await store.listStageRuns(job.id),before)
  assert.equal((await store.getLatestSucceeded(job.id,'PLAN'))?.result?.provider,'offline-recovery')
  assert.equal(await store.claimJob({workerId:'should-not-run',stages:['ASSET']}),null,'explicit paid resume required')
})
test('cannot park other users, unrelated profiles, unproven failures or non-recovered manuscripts',async()=>{
  const wrong=await fixture()
  assert.equal((await wrong.call('x'.repeat(32))).code,404)
  const notRecovered=await fixture({offline:false})
  assert.equal((await notRecovered.call()).code,409)
  const notBilling=await fixture({billing:false})
  assert.equal((await notBilling.call()).code,409)
  const other=await fixture({profile:'senior_longform'})
  assert.equal((await other.call()).code,409)
})
