import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { WISDOM_PROFILE } from '../../lib/generative/contracts.js'
import { deterministicWisdomDraft, validateWisdomScript } from '../../lib/generative/wisdom.js'
import { StageError, type StageExecutor } from '../types.js'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOk, probe } from '../../lib/media/ffmpeg.js'
import { openAiWisdomImage, openAiWisdomTts } from '../../lib/generative/providers.js'
import { openAiWisdomPlan, applyVisualBible } from '../../lib/generative/planner.js'

export function createGenerativePlanExecutor(deps:{apiKey?:string;plan?:typeof openAiWisdomPlan}={}):StageExecutor {
 const apiKey=deps.apiKey??process.env.OPENAI_API_KEY??'', aiPlan=deps.plan??openAiWisdomPlan
 return {
 stage:'PLAN', estimateUsd:()=>0.05,
 inputHash:(job)=>sha256(`gen-plan|${job.profile}|${job.planRef}|wisdom/1`),
 async run({job,blobs}){
  if(job.profile!=='wisdom') throw new StageError('PROFILE_UNSUPPORTED','generative PLAN only handles wisdom')
  if(!job.planRef) throw new StageError('BRIEF_MISSING','wisdom requires a generative brief')
  const brief:any=await blobs.getJson(job.planRef)
  if(!brief||brief.schema!=='generative-brief/1'||brief.profile!=='wisdom')throw new StageError('BRIEF_INVALID','invalid wisdom brief')
  let script:any, visualBible:any=null, provider='deterministic', fallbackReason:string|undefined
  if(apiKey){try{const made=await aiPlan(brief,apiKey);script=applyVisualBible(made.script,made.visualBible);visualBible=made.visualBible;provider='openai'}catch(e){fallbackReason=e instanceof Error?e.message:String(e)}}
  if(!script)script=deterministicWisdomDraft(brief)
  const errors=validateWisdomScript(script,brief)
  if(errors.length)throw new StageError('SCRIPT_INVALID',errors.join(','))
  const stored=await putAddressed(blobs,'generative-scripts',script)
  const bibleStored=visualBible?await putAddressed(blobs,'visual-bibles',visualBible):null
  let clock=0
  const captionEvents=script.beats.map((b:any)=>{const start=Number(clock.toFixed(2));clock+=Number(b.durationSec);return {start,end:Number(clock.toFixed(2)),text:b.narration}})
  const plan={schema:'job-plan/1',profile:'source_shorts',sourceAssetId:job.sourceAssetId,variantPlan:{profile:'wisdom-v1',beats:[{label:'generated-wisdom',trimStart:0,trimEnd:script.totalSeconds}],headline:script.title,events:captionEvents,plansTimeDomain:'output',useNarration:false,audioPolicy:{bgm:'off',sfx:'off',reason:'wisdom-v1 keeps generated narration intelligible; music/effects require an explicit later policy'}}}
  const planStored=await putAddressed(blobs,'plans',plan)
  return {outputRef:planStored.path,outputHash:planStored.sha256,planRef:planStored.path,result:{provider,fallbackReason,profile:WISDOM_PROFILE,scriptRef:stored.path,visualBibleRef:bibleStored?.path??null,beats:script.beats.length,totalSeconds:script.totalSeconds}}
 }
}}
export const generativePlanExecutor=createGenerativePlanExecutor()

export function createGenerativeAssetExecutor(deps:{apiKey?:string; image?:typeof openAiWisdomImage; tts?:typeof openAiWisdomTts}={}):StageExecutor {
 const image=deps.image??openAiWisdomImage, tts=deps.tts??openAiWisdomTts, apiKey=deps.apiKey??process.env.OPENAI_API_KEY??''
 return {
 stage:'ASSET', estimateUsd:()=>0.75,
 inputHash:(job)=>sha256(`gen-asset|${job.id}|${job.planRev}|wisdom/2`),
 async run({job,blobs,previous,signal}){
  if(job.profile!=='wisdom')throw new StageError('PROFILE_UNSUPPORTED','generative ASSET only handles wisdom')
  if(!apiKey)throw new StageError('PROVIDER_DOWN','OPENAI_API_KEY is not configured',true)
  const p=await previous('PLAN'); const scriptRef=(p?.result as any)?.scriptRef; if(!scriptRef)throw new StageError('SCRIPT_MISSING','ASSET requires PLAN script')
  const script:any=await blobs.getJson(scriptRef); if(!script||script.schema!=='wisdom-script/1')throw new StageError('SCRIPT_INVALID','wisdom script missing')
  const items:any[]=[]; let bytes=0, generated=0, reused=0
  for(const b of script.beats){
   if(signal.aborted)throw new Error('aborted')
   const ik=sha256('image-v1|'+b.imagePrompt), ak=sha256('tts-v1|'+b.narration)
   let im:any=null, au:any=null
   try{const m:any=await blobs.getJson('generative-cache/image/'+ik+'.json');const z=m?.ref?await blobs.getBytes(m.ref):null;if(z)im={...m,bytes:z}}catch{}
   try{const m:any=await blobs.getJson('generative-cache/tts/'+ak+'.json');const z=m?.ref?await blobs.getBytes(m.ref):null;if(z)au={...m,bytes:z}}catch{}
   if(im)reused++;else{im=await image(b.imagePrompt,apiKey);generated++}
   if(au)reused++;else{au=await tts(b.narration,apiKey);generated++}
   const ih=sha256(im.bytes), ah=sha256(au.bytes)
   const ip=`generative-assets/images/${ih}.jpg`, ap=`generative-assets/audio/${ah}.mp3`
   await blobs.putBytes(ip,im.bytes,im.contentType); await blobs.putBytes(ap,au.bytes,au.contentType); bytes+=im.bytes.length+au.bytes.length
   await blobs.putJson('generative-cache/image/'+ik+'.json',{ref:ip,sha256:ih,contentType:im.contentType,provider:im.provider,model:im.model})
   await blobs.putJson('generative-cache/tts/'+ak+'.json',{ref:ap,sha256:ah,contentType:au.contentType,provider:au.provider,model:au.model})
   items.push({beatId:b.id,durationSec:b.durationSec,narration:b.narration,image:{status:'ready',ref:ip,sha256:ih,contentType:im.contentType,provider:im.provider,model:im.model},tts:{status:'ready',ref:ap,sha256:ah,contentType:au.contentType,provider:au.provider,model:au.model}})
  }
  const manifest={schema:'generative-assets/1',profile:'wisdom',scriptRef,items}
  const stored=await putAddressed(blobs,'generative-assets',manifest)
  const work=await mkdtemp(join(tmpdir(),'wisdom-asset-'))
  try{
   const segments:string[]=[]
   for(let i=0;i<items.length;i++){
    const x=items[i], im=await blobs.getBytes(x.image.ref), au=await blobs.getBytes(x.tts.ref)
    if(!im||!au)throw new StageError('ASSET_BYTES_MISSING',`generated bytes missing for ${x.beatId}`)
    const ip=join(work,`i${i}.jpg`),ap=join(work,`a${i}.mp3`),op=join(work,`s${i}.mp4`)
    await writeFile(ip,im);await writeFile(ap,au)
    const audioInfo=await probe(ap)
    const narrationSec=Number(audioInfo.duration||0)
    const d=Number(Math.max(Number(x.durationSec),narrationSec+0.35).toFixed(2))
    x.plannedDurationSec=Number(x.durationSec);x.narrationDurationSec=Number(narrationSec.toFixed(2));x.durationSec=d
    await runOk(['-y','-loop','1','-i',ip,'-i',ap,'-t',String(d),'-vf','scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p','-af','apad','-r','30','-c:v','libx264','-preset','veryfast','-threads','4','-c:a','aac','-ar','44100','-ac','2','-movflags','+faststart',op],{signal,timeoutMs:120000})
    segments.push(op)
   }
   const list=join(work,'concat.txt');await writeFile(list,segments.map(p=>`file '${p.replaceAll("'","'\\''")}'`).join('\n'))
   const out=join(work,'source.mp4');await runOk(['-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',out],{signal,timeoutMs:120000})
   const timedManifest={...manifest,items}
   const timedStored=await putAddressed(blobs,'generative-assets',timedManifest)
   const video=await readFile(out), vh=sha256(video), info=await probe(out), blobPath=`source-collector/generated/${vh}.mp4`
   await blobs.putBytes(blobPath,video,'video/mp4')
   const source={sourceAssetId:job.sourceAssetId,blobPath,sha256:vh,duration:info.duration,width:info.width,height:info.height,videoCodec:info.videoCodec,audioCodec:info.audioCodec,generative:true,assetSpecRef:timedStored.path}
   await blobs.putJson(`generative-sources/${job.sourceAssetId}.json`,source)
   return {outputRef:timedStored.path,outputHash:timedStored.sha256,result:{assetSpecRef:timedStored.path,items:items.length,ready:true,bytes,generated,reused,source},provider:'openai',model:'gpt-image-1-mini+gpt-4o-mini-tts'}
  }finally{await rm(work,{recursive:true,force:true})}
 }}
}
export const generativeAssetExecutor=createGenerativeAssetExecutor()
