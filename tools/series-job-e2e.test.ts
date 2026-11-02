import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createBlockStore } from '../lib/jobs/blockStore.js'
import { createBlockGate } from '../lib/jobs/blockRuntime.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { sha256, type JobBlobStore } from '../lib/jobs/blobs.js'
import { createLongformPlanExecutor, createLongformAssetExecutor, createLongformRenderExecutor } from '../worker/stages/longform.js'
import { runOnce } from '../worker/runJob.js'
import { meteredFetch } from '../lib/generative/usageLedger.js'
import { executeApprovedScene } from '../lib/sceneWorkerAdapter.js'

// File-backed mock object storage: new adapters see only persisted files.
function diskBlobs(dir: string): JobBlobStore {
 const file = (p: string) => join(dir, sha256(p))
 const get = async (p: string) => { try { return await readFile(file(p)) } catch(e:any) { if(e.code==='ENOENT') return null; throw e } }
 const put = async (p: string, b: Buffer, overwrite=false) => { try { await writeFile(file(p), b, {flag:overwrite?'w':'wx'}); return true } catch(e:any) { if(e.code==='EEXIST') return false; throw e } }
 return {
  async putJson(p,v,o) { const b=Buffer.from(JSON.stringify(v)); await put(p,b,o?.overwrite); return {path:p,sha256:sha256((await get(p))!)} },
  async getJson(p) { const b=await get(p); return b?JSON.parse(b.toString()):null },
  async putBytes(p,b) { await put(p,b); return {path:p,sha256:sha256(b),bytes:b.length} }, getBytes:get,
  async putFile(p,f) { const b=await readFile(f); const uploaded=await put(p,b); return {path:p,bytes:b.length,uploaded} },
  async claim(p,v) { return put(p,Buffer.from(JSON.stringify(v))) }
 }
}
function wav() { const n=24000,b=Buffer.alloc(44+n*2); b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(2000*Math.sin(i*.08)),44+i*2);return b }
const S = (say: string, show: string[], accent: string, color: any) => ({ say, show, accent, color })
// the shape the planner returns (a short sample with the full Longform structure)
const SAMPLE: any = {
  schema: 'wisdom-longform-script/1',
  title: '만만하게 보이지 않는 사람들의 5가지 태도', hook: '사람에게 만만하게 보이는 순간, 관계는 달라집니다.',
  figure: { name: 'Seneca', imagePrompt: 'the Roman Stoic philosopher Seneca, elderly, short white beard, wearing a simple dark toga, calm and stern gaze' },
  thumbnail: { lines: [{ text: '절대', color: 'red' }, { text: '만만하게', color: 'purple' }, { text: '보이지 마라', color: 'green' }] },
  metadata: {
    description: '친절한데도 늘 손해만 보는 사람과, 조용한데도 함부로 대하지 못하는 사람은 무엇이 다를까요? 스토아 철학자 세네카의 말을 바탕으로 부탁에 바로 답하지 않기, 변명을 줄이기, 경계를 지키면서도 다정함을 잃지 않는 법을 일상 장면으로 풀어 봅니다. 관계에서 자꾸 지치는 분이라면 오늘 영상에서 나를 지키는 기준 하나를 가져가 보세요.',
    tags: ['세네카', '스토아 철학', '만만해 보이는 사람', '거절하는 법', '자존감 높이기', '인간관계 경계', '호구 탈출', '부탁 거절', '착한 사람 콤플렉스', '관계 스트레스'],
    hashtags: ['세네카', '스토아철학', '인간관계', '자존감'],
    pinnedComment: '부탁을 받으면 바로 대답하시는 편인가요, 아니면 잠시 멈추시나요? 만만하게 보였다고 느낀 순간이 있다면 댓글로 나눠 주세요.'
  },
  sections: [
    { id: 's1', sentences: [
      S('사람에게 만만하게 보이는 순간, 관계는 조용히 달라지기 시작합니다.', ['사람에게', '만만하게 보이는 순간', '관계는 달라진다'], '만만하게 보이는 순간', 'red'),
      S('처음에는 배려였던 행동이 어느새 당연한 의무가 되어 버리죠.', ['배려가', '당연한 의무가 될 때'], '당연한 의무', 'purple'),
      S('세네카는 말했습니다. 자신을 존중하지 않는 사람은 타인에게도 존중받지 못한다고.', ['자신을 존중하지 않으면', '존중받지 못한다'], '존중받지 못한다', 'yellow')
    ] },
    { id: 's2', sentences: [
      S('첫 번째 태도는 모든 부탁에 즉시 대답하지 않는 것입니다.', ['첫 번째', '즉시 대답하지 않는다'], '즉시 대답하지 않는다', 'green'),
      S('잠시 멈추는 그 몇 초가 당신의 시간을 지켜 줍니다.', ['멈추는 몇 초가', '당신을 지킨다'], '멈추는 몇 초', 'red'),
      S('두 번째 태도는 설명을 길게 늘어놓지 않는 것입니다.', ['두 번째', '변명하지 않는다'], '변명하지 않는다', 'purple')
    ] },
    { id: 's3', sentences: [
      S('하지만 단단한 사람은 차갑지 않습니다. 오히려 누구보다 따뜻합니다.', ['단단한 사람은', '차갑지 않다'], '차갑지 않다', 'green'),
      S('경계를 지킬 줄 아는 사람만이 오래 다정할 수 있기 때문입니다.', ['경계를 지키는 사람만', '오래 다정하다'], '오래 다정하다', 'yellow')
    ] }
  ]
}


function plan(changed=false) {
 const script=structuredClone(SAMPLE);script.sections[0].sentences.push(structuredClone(script.sections[0].sentences[0]));script.schema='senior-longform-script/1'
 script.characters=[{id:'seneca',name:'세네카',role:'철학자',gender:'male',age:'60',face:'bearded',hair:'grey',build:'slim',outfit:'toga',colors:'blue'}]
 script.sections.forEach((s:any,i:number)=>{const id='scene'+(i+1);s.scenes=[{id,place:'로마 정원',time:'아침',characters:['seneca'],action:'산책 '+i,mood:'calm',visual:changed&&i===1?'a changed fountain':'garden '+i}];s.sentences.forEach((x:any)=>x.scene=id)})
 return {id:'series-episode-01',title:script.title,format:'video' as const,constraints:{maxScenes:3,maxCostUsd:5},steps:[
 {id:'script',kind:'script' as const,dependsOn:[],config:{script}},
 ...[1,2,3].map(i=>({id:'image'+i,kind:'image' as const,sceneId:'scene'+i,dependsOn:['script']})),
 {id:'voice',kind:'voice' as const,dependsOn:['script']},
 {id:'render',kind:'render' as const,dependsOn:['image1','image2','image3','voice']}]}
}

test('productionPlan API → approved Worker → 3 scenes → scene 2 edit → persisted restart: exactly four Gemini calls', async () => {
 const db=await createTestDb(), dir=await mkdtemp(join(tmpdir(),'series-e2e-'))
 const fixtureImage=join(dir,'fixture.jpg')
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=640x360:d=1','-frames:v','1','-y',fixtureImage])
 const validJpeg=await readFile(fixtureImage)
 const changedFixture=join(dir,'changed-fixture.jpg')
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=640x360:d=1','-frames:v','1','-y',changedFixture])
 const changedJpeg=await readFile(changedFixture)
 let blobs=diskBlobs(dir),store=createJobStore(db),blocks=createBlockStore(db)
 const calls:{image:string[],tts:number}={image:[],tts:0}, original=globalThis.fetch
 globalThis.fetch=meteredFetch((async (url:any,init:any)=>{
  const body=JSON.parse(init.body)
  if(String(url).startsWith('https://generativelanguage.googleapis.com/')) { const prompt=body.input[0].text;calls.image.push(prompt);return Response.json({output_image:{data:(prompt.includes('changed fountain')?changedJpeg:validJpeg).toString('base64'),mime_type:'image/jpeg'},usage:{}}) }
  assert.equal(String(url),'https://api.openai.com/v1/audio/speech','unexpected paid endpoint')
  calls.tts++;return new Response(new Uint8Array(wav()),{headers:{'content-type':'audio/mpeg'}})
 }) as any,()=>{})
 const call=async(b:any,method='POST')=>{let status=0,json:any;await createJobsHttp({getStore:async()=>store,getBlocks:async()=>blocks,blobs})({method,headers:{'x-sync-key':'k'.repeat(32)},body:method==='POST'?b:undefined,query:method==='GET'?b:{}} as any,{setHeader(){},status(n:number){status=n;return this},json(v:any){json=v;return this},end(){return this}} as any);return {status,json}}
 const deps=()=>({store,blobs,workerId:'series-test',resolveSourceAsset:async()=>({} as any),blocks:createBlockGate(blocks,async(id,stage)=>store.getLatestSucceeded(id,stage)),executors:[createLongformPlanExecutor({apiKey:'mock'}),createLongformAssetExecutor({apiKey:'mock',imageKey:'mock'}),createLongformRenderExecutor()]})
 const create=async(p:any,key:string,budgetUsd=5)=>call({taskType:'job_create',profile:'senior_longform',idempotencyKey:key,budgetUsd,input:{kind:'text',text:'세네카의 관계와 부탁에 대한 이야기',targetSeconds:60,sample:true,recipe:'longform_script_approval',productionPlan:p}})
 const approve=async(id:string)=>{const v=await call({taskType:'job_blocks',id},'GET');const row=v.json.blocks.find((x:any)=>x.block==='SCRIPT_APPROVAL');const a=await call({taskType:'job_block_approve',jobId:id,block:'SCRIPT_APPROVAL',artifactHash:row.artifactHash});assert.equal(a.status,200,JSON.stringify(a.json))}
 try {
  const bad=plan();(bad.steps[1] as any).sceneId='unknown';assert.equal((await create(bad,'invalid-plan-01')).status,400)
  assert.equal((await create(plan(),'over-plan-budget',6)).status,400)
  const a=await create(plan(),'series-initial-01');assert.equal(a.status,201,JSON.stringify(a.json));const id=a.json.job.id
  const saved:any=await blobs.getJson((await store.getJob(id))!.planRef!);assert.deepEqual(saved.productionPlan,plan())
  const dup=await create(plan(),'series-initial-01');assert.equal(dup.json.job.id,id)
  assert.equal((await runOnce(deps()) as any).outcome,'completed')
  assert.equal((await runOnce(deps()) as any).outcome,'waiting');assert.equal(calls.image.length,0);assert.equal(calls.tts,0)
  await approve(id)
  const parallel=await Promise.all([runOnce(deps()),runOnce({...deps(),workerId:'other'})]);assert.equal(parallel.filter(x=>x.ran).length,1);assert.equal((parallel.find(x=>x.ran) as any).outcome,'completed',JSON.stringify(parallel))
  // The previously missing final output check: real ffmpeg, valid fixture JPEG,
  // persisted MP4 bytes, ffprobe decode; no paid provider or Production access.
  const rendered=await runOnce(deps())
  assert.equal(rendered.ran && rendered.outcome,'completed',JSON.stringify(rendered))
  const renderRun:any=await store.getLatestSucceeded(id,'RENDER')
  assert.ok(renderRun,'RENDER must succeed before calling the series complete')
  const mp4=await blobs.getBytes(renderRun.outputRef)
  assert.ok(mp4 && mp4.length>1000,'rendered MP4 must be persisted')
  const mp4File=join(dir,'rendered.mp4');await writeFile(mp4File,mp4)
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',mp4File],{encoding:'utf8'}))
  assert.ok(Number(probe.format.duration)>0,'MP4 must have duration')
  assert.ok(probe.streams.some((x:any)=>x.codec_type==='video'),'MP4 must have video')
  assert.ok(probe.streams.some((x:any)=>x.codec_type==='audio'),'MP4 must have narration audio')
  const first:any=await store.getLatestSucceeded(id,'ASSET');assert.ok(first,JSON.stringify(await store.listStageRuns(id)))
  const assets1:any=await blobs.getJson(first.outputRef);assert.equal(assets1.images.length,3);assert.equal(calls.image.length,3)
  assert.equal(first.usage.paidCalls,3+calls.tts);const tts=calls.tts
  // Restart the worker and all storage adapters; the database and files are the source of truth.
  blobs=diskBlobs(dir);store=createJobStore(db);blocks=createBlockStore(db)
  const b=await create(plan(true),'series-revised-02');assert.equal(b.status,201);assert.notEqual(b.json.job.id,id)
  assert.equal((await runOnce(deps()) as any).outcome,'completed');assert.equal((await runOnce(deps()) as any).outcome,'waiting');await approve(b.json.job.id)
  assert.equal((await runOnce(deps()) as any).outcome,'completed',JSON.stringify(await store.listStageRuns(b.json.job.id)))
  const second:any=await store.getLatestSucceeded(b.json.job.id,'ASSET');const assets2:any=await blobs.getJson(second.outputRef)
  assert.equal(calls.image.length,4);assert.equal(calls.tts,tts);assert.equal(second.usage.paidCalls,1)
  assert.equal(assets1.images[0].ref,assets2.images[0].ref);assert.notEqual(assets1.images[1].ref,assets2.images[1].ref);assert.equal(assets1.images[2].ref,assets2.images[2].ref)
  const recovered=diskBlobs(dir);assert.deepEqual(await recovered.getJson(second.outputRef),assets2)
  for(const image of assets2.images) assert.equal(sha256((await recovered.getBytes(image.ref))!),image.sha256)
  const status=await call({taskType:'job_get',id:b.json.job.id},'GET');assert.equal(status.status,200)
  // Budget and plan content are enforced before any new provider call.
  const lowPlan=plan(true);lowPlan.id='other-episode';const low=await create(lowPlan,'series-low-budget',0);assert.equal(low.status,201)
  assert.equal((await runOnce(deps()) as any).outcome,'budget_wait');assert.equal(calls.image.length,4)
 } finally {globalThis.fetch=original;await db.close!()}
})

test('scene claim: concurrent/uncertain paid work never retries; persisted checkpoint recovers without a new call',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'series-claim-')),blobs=diskBlobs(dir)
 const input={workspaceId:'w',planId:'p',sceneId:'s',sceneInput:{prompt:'x'},approved:true}
 let calls=0,release!:()=>void;const barrier=new Promise<void>(r=>release=r)
 const one=executeApprovedScene(blobs,input,async()=>{calls++;await barrier;return {outputRef:'image/1',outputHash:'h'}})
 // Wait for the provider boundary, not a time-based race.
 while(!calls) await new Promise(r=>setImmediate(r))
 await assert.rejects(executeApprovedScene(diskBlobs(dir),input,async()=>{calls++;throw Error('duplicate')}),/pending or outcome unknown/)
 release();await one;assert.equal(calls,1)
 assert.equal((await executeApprovedScene(diskBlobs(dir),input,async()=>{throw Error('duplicate')})).kind,'REUSE')
 const next={...input,sceneId:'interrupted'}
 await assert.rejects(executeApprovedScene(blobs,next,async()=>{calls++;throw Error('process lost after provider')}))
 await assert.rejects(executeApprovedScene(diskBlobs(dir),next,async()=>{calls++;throw Error('duplicate')}),/pending or outcome unknown/);assert.equal(calls,2)
 const done=await executeApprovedScene(diskBlobs(dir),next,async()=>{throw Error('duplicate')},async()=>({outputRef:'checkpoint',outputHash:'saved'}))
 assert.equal(done.kind,'GENERATED');assert.equal(calls,2)
})
