import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { WISDOM_PROFILE } from '../../lib/generative/contracts.js'
import { deterministicWisdomDraft, validateWisdomScript } from '../../lib/generative/wisdom.js'
import { StageError, type StageExecutor } from '../types.js'
import { openAiWisdomImage, openAiWisdomTts } from '../../lib/generative/providers.js'

export const generativePlanExecutor: StageExecutor = {
 stage:'PLAN', estimateUsd:()=>0,
 inputHash:(job)=>sha256(`gen-plan|${job.profile}|${job.planRef}|wisdom/1`),
 async run({job,blobs}){
  if(job.profile!=='wisdom') throw new StageError('PROFILE_UNSUPPORTED','generative PLAN only handles wisdom')
  if(!job.planRef) throw new StageError('BRIEF_MISSING','wisdom requires a generative brief')
  const brief:any=await blobs.getJson(job.planRef)
  if(!brief||brief.schema!=='generative-brief/1'||brief.profile!=='wisdom')throw new StageError('BRIEF_INVALID','invalid wisdom brief')
  const script=deterministicWisdomDraft(brief)
  const errors=validateWisdomScript(script,brief)
  if(errors.length)throw new StageError('SCRIPT_INVALID',errors.join(','))
  const stored=await putAddressed(blobs,'generative-scripts',script)
  return {outputRef:stored.path,outputHash:stored.sha256,planRef:stored.path,result:{provider:'deterministic',profile:WISDOM_PROFILE,scriptRef:stored.path,beats:script.beats.length,totalSeconds:script.totalSeconds}}
 }
}

export function createGenerativeAssetExecutor(deps:{apiKey?:string; image?:typeof openAiWisdomImage; tts?:typeof openAiWisdomTts}={}):StageExecutor {
 const image=deps.image??openAiWisdomImage, tts=deps.tts??openAiWisdomTts, apiKey=deps.apiKey??process.env.OPENAI_API_KEY??''
 return {
 stage:'ASSET', estimateUsd:()=>0.75,
 inputHash:(job)=>sha256(`gen-asset|${job.id}|${job.planRev}|wisdom/2`),
 async run({job,blobs,previous,signal}){
  if(job.profile!=='wisdom')throw new StageError('PROFILE_UNSUPPORTED','generative ASSET only handles wisdom')
  if(!apiKey)throw new StageError('PROVIDER_DOWN','OPENAI_API_KEY is not configured',true)
  const p=await previous('PLAN'); if(!p?.outputRef)throw new StageError('SCRIPT_MISSING','ASSET requires PLAN')
  const script:any=await blobs.getJson(p.outputRef); if(!script||script.schema!=='wisdom-script/1')throw new StageError('SCRIPT_INVALID','wisdom script missing')
  const items:any[]=[]; let bytes=0
  for(const b of script.beats){
   if(signal.aborted)throw new Error('aborted')
   const [im,au]=await Promise.all([image(b.imagePrompt,apiKey),tts(b.narration,apiKey)])
   const ih=sha256(im.bytes), ah=sha256(au.bytes)
   const ip=`generative-assets/images/${ih}.jpg`, ap=`generative-assets/audio/${ah}.mp3`
   await blobs.putBytes(ip,im.bytes,im.contentType); await blobs.putBytes(ap,au.bytes,au.contentType); bytes+=im.bytes.length+au.bytes.length
   items.push({beatId:b.id,durationSec:b.durationSec,narration:b.narration,image:{status:'ready',ref:ip,sha256:ih,contentType:im.contentType,provider:im.provider,model:im.model},tts:{status:'ready',ref:ap,sha256:ah,contentType:au.contentType,provider:au.provider,model:au.model}})
  }
  const manifest={schema:'generative-assets/1',profile:'wisdom',scriptRef:p.outputRef,items}
  const stored=await putAddressed(blobs,'generative-assets',manifest)
  return {outputRef:stored.path,outputHash:stored.sha256,result:{assetSpecRef:stored.path,items:items.length,ready:true,bytes},provider:'openai',model:'gpt-image-1-mini+gpt-4o-mini-tts'}
 }}
}
export const generativeAssetExecutor=createGenerativeAssetExecutor()
