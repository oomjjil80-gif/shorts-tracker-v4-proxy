import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore, putAddressed } from '../lib/jobs/blobs.js'
import { runOk } from '../lib/media/ffmpeg.js'
import { buildFilterGraph } from '../lib/media/render.js'
import { resolveSourceShortsNarration } from '../worker/stages/sourceNarration.js'

async function mp3(seconds=1.2){
  return (await runOk(['-f','lavfi','-i',`sine=f=440:d=${seconds}`,'-c:a','libmp3lame','-f','mp3','-'])).stdout
}

function job(planRef:string){
  return {id:'j',profile:'source_shorts',planRef,planRev:1,sourceAssetId:'src_test_narration_0001'} as any
}

test('General Shorts narration is optional and makes no provider call when voiceover is absent',async()=>{
  const blobs:any=createMemoryBlobStore()
  const stored=await putAddressed(blobs,'plans',{schema:'job-plan/1',profile:'source_shorts',sourceAssetId:'src_test_narration_0001',variantPlan:{beats:[{trimStart:10,trimEnd:14}]}})
  let calls=0
  const r=await resolveSourceShortsNarration({job:job(stored.path),blobs,apiKey:'k',tts:(async()=>{calls++;throw new Error('must not call')}) as any})
  assert.equal(r,null)
  assert.equal(calls,0)
})

test('General Shorts narration generates once, caches bytes, and reuses the same audio on retry',async()=>{
  const blobs:any=createMemoryBlobStore()
  const stored=await putAddressed(blobs,'plans',{schema:'job-plan/1',profile:'source_shorts',sourceAssetId:'src_test_narration_0001',variantPlan:{
    beats:[{trimStart:10,trimEnd:14},{trimStart:20,trimEnd:24}],
    audioMode:'dub',
    voiceover:{mode:'timed',lines:[{start:10,end:14,text:'둘은 헤어진 친남매였습니다.'},{start:20,end:24,text:'다시 만난 순간 서로를 바로 알아봤습니다.'}],sourceVolume:0.2,voiceVolume:1.1}
  }})
  const audio=await mp3(1.4)
  let calls=0
  const tts=(async()=>{calls++;return {bytes:audio,contentType:'audio/mpeg',provider:'test',model:'test-tts'}}) as any
  const a=await resolveSourceShortsNarration({job:job(stored.path),blobs,apiKey:'k',tts})
  const b=await resolveSourceShortsNarration({job:job(stored.path),blobs,apiKey:'k',tts})
  assert.ok(a&&b)
  assert.equal(calls,2)
  assert.equal(a.ref,b.ref)
  assert.equal(a.sha256,b.sha256)
  assert.equal(a.generated,true)
  assert.equal(b.generated,false)
  assert.equal(a.sourceVolume,0.2)
  assert.equal(a.voiceVolume,1.1)
  assert.ok(a.durationSec>1)
})

test('General Shorts narration refuses speech longer than the selected edit before video rendering',async()=>{
  const blobs:any=createMemoryBlobStore()
  const stored=await putAddressed(blobs,'plans',{schema:'job-plan/1',profile:'source_shorts',sourceAssetId:'src_test_narration_0001',variantPlan:{
    beats:[{trimStart:10,trimEnd:11}],
    audioMode:'dub',
    voiceover:{mode:'timed',lines:[{start:10,end:11,text:'짧은 편집보다 긴 더빙'}],sourceVolume:0,voiceVolume:1}
  }})
  const audio=await mp3(2.2)
  await assert.rejects(
    ()=>resolveSourceShortsNarration({job:job(stored.path),blobs,apiKey:'k',tts:async()=>({bytes:audio,contentType:'audio/mpeg',provider:'test',model:'test-tts'}) as any}),
    (e:any)=>e?.code==='NARRATION_TOO_LONG'
  )
})

test('renderer mixes optional narration while preserving source ambience at reduced volume',()=>{
  const graph=buildFilterGraph(
    [{start:0,duration:4,trimStart:10,trimEnd:14,volume:1,mute:false}],
    {sourceHasAudio:true,assPath:'/tmp/x.ass',fontsDir:'/tmp/fonts',hasOverlays:false,voiceoverInputIndex:1,sourceMixVolume:0.24,voiceMixVolume:1}
  )
  assert.match(graph,/\[asrc\]volume=0\.24\[aduck\]/)
  assert.match(graph,/\[1:a\].*volume=1.*\[avo\]/)
  assert.match(graph,/amix=inputs=2:duration=first:dropout_transition=0:normalize=0\[aout\]/)
})
