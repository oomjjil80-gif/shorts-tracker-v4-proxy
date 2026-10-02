import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { WISDOM_PROFILE } from '../../lib/generative/contracts.js'
import { deterministicWisdomDraft, validateWisdomScript } from '../../lib/generative/wisdom.js'
import { StageError, type StageExecutor } from '../types.js'

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

export const generativeAssetExecutor: StageExecutor = {
 stage:'ASSET', estimateUsd:()=>0,
 inputHash:(job)=>sha256(`gen-asset|${job.id}|${job.planRev}|wisdom/1`),
 async run({job,blobs,previous}){
  if(job.profile!=='wisdom')throw new StageError('PROFILE_UNSUPPORTED','generative ASSET only handles wisdom')
  const p=await previous('PLAN'); if(!p?.outputRef)throw new StageError('SCRIPT_MISSING','ASSET requires PLAN')
  const script:any=await blobs.getJson(p.outputRef); if(!script||script.schema!=='wisdom-script/1')throw new StageError('SCRIPT_INVALID','wisdom script missing')
  // P2 contract: assets are addressable per beat. Provider calls are deliberately not faked; this stage records
  // the exact prompts and required media so provider adapters can fill them without changing PLAN/Manifest contracts.
  const spec={schema:'generative-assets/1',profile:'wisdom',scriptRef:p.outputRef,items:script.beats.map((b:any)=>({beatId:b.id,image:{status:'required',prompt:b.imagePrompt,aspectRatio:'9:16'},tts:{status:'required',text:b.narration,language:'ko'}}))}
  const stored=await putAddressed(blobs,'generative-assets',spec)
  return {outputRef:stored.path,outputHash:stored.sha256,result:{assetSpecRef:stored.path,items:spec.items.length,ready:false,missing:spec.items.flatMap((x:any)=>[`${x.beatId}:image`,`${x.beatId}:tts`])},wait:'PROVIDER_DOWN'}
 }
}
