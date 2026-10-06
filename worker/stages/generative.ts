import { sha256, putAddressed } from '../../lib/jobs/blobs.js'
import { WISDOM_PROFILE } from '../../lib/generative/contracts.js'
import { deterministicWisdomDraft, validateWisdomScript, anchorNamedThinkerVisual, wisdomCaptionEvents, thinkerDisplayName } from '../../lib/generative/wisdom.js'
import { StageError, type StageExecutor } from '../types.js'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOk, probe } from '../../lib/media/ffmpeg.js'
import { openAiWisdomImage, openAiWisdomTts } from '../../lib/generative/providers.js'
import { openAiWisdomPlan, applyVisualBible } from '../../lib/generative/planner.js'
import { evaluateWisdomSemanticQc } from '../../lib/generative/semanticQc.js'
import { SHORTS_SCREEN_DNA, screenDnaSegmentArgv, screenDnaSegmentFilter, type AssetGeometryReceipt } from '../../lib/media/screenDna.js'
import { cacheEntryIsCanonical } from '../../lib/generative/cache.js'
import { profileFeatures, needFeatures, type FeatureResolver } from '../modules/features.js'


export function wisdomHeadline(title:string,topic=''){
 const thinker=thinkerDisplayName(topic)
 let source=String(title||'').trim()
 if(thinker&&!source.includes(thinker)) source=`${thinker}가 말한 ${source}`
 const t=source
 const t=source.replace(/\s+/g,' ')
 if(!t)return ''
 const split=Math.max(1,Math.min(t.length-1,Math.round(t.length/2)))
 let i=split
 while(i<t.length-1&&t[i]!==' ')i++
 if(i>=t.length-1){i=split;while(i>1&&t[i]!==' ')i--}
 if(i<=1)return t
 return t.slice(0,i).trim()+'\\N'+t.slice(i).trim()
}

// CAPTION feature: the plan's caption events are made only when the profile selects CAPTION (otherwise events=[]).
export function createGenerativePlanExecutor(deps:{apiKey?:string;plan?:typeof openAiWisdomPlan;features?:FeatureResolver;captions?:typeof wisdomCaptionEvents}={}):StageExecutor {
 const apiKey=deps.apiKey??process.env.OPENAI_API_KEY??'', aiPlan=deps.plan??openAiWisdomPlan, captions=deps.captions??wisdomCaptionEvents
 return {
 stage:'PLAN', estimateUsd:()=>0.05,
 inputHash:(job)=>sha256(`gen-plan|${job.profile}|${job.planRef}|wisdom/1`),
 async run({job,blobs,previous}){
  if(job.profile!=='wisdom') throw new StageError('PROFILE_UNSUPPORTED','generative PLAN only handles wisdom')
  if(!job.planRef) throw new StageError('BRIEF_MISSING','wisdom requires a generative brief')
  let briefRef=job.planRef
  let brief:any=await blobs.getJson(briefRef)
  if(!brief||brief.schema!=='generative-brief/1'||brief.profile!=='wisdom'){
   const priorPlan=await previous('PLAN')
   const preserved=String((priorPlan?.result as any)?.briefRef||'')
   if(preserved){
    const recovered:any=await blobs.getJson(preserved)
    if(recovered?.schema==='generative-brief/1'&&recovered?.profile==='wisdom'){briefRef=preserved;brief=recovered}
   }
  }
  if(!brief||brief.schema!=='generative-brief/1'||brief.profile!=='wisdom')throw new StageError('BRIEF_INVALID','invalid wisdom brief')
  let script:any, visualBible:any=null, provider='deterministic', fallbackReason:string|undefined
  if(apiKey){try{
   const made=await aiPlan(brief,apiKey)
   const candidate=anchorNamedThinkerVisual(applyVisualBible(made.script,made.visualBible),String(brief.text||'')).script
   const candidateErrors=validateWisdomScript(candidate,brief)
   if(candidateErrors.length)throw new Error('AI script validation: '+candidateErrors.join(','))
   script=candidate;visualBible=made.visualBible;provider='openai'
  }catch(e){fallbackReason=e instanceof Error?e.message:String(e)}}
  if(!script)script=deterministicWisdomDraft(brief)
  const errors=validateWisdomScript(script,brief)
  if(errors.length)throw new StageError('SCRIPT_INVALID',errors.join(','))
  let semanticQc=evaluateWisdomSemanticQc(String(brief.text||''),script)
  // One free PLAN repair is allowed before any paid image/TTS assets. Never lower semantic QC.
  // Feed the exact failed dimensions back into the planner so the second draft must repair them explicitly.
  if(semanticQc.reasons.length && apiKey){
   try{
    const repairBrief={...brief,text:`${brief.text}\n\n[MANDATORY REPAIR] Previous draft failed semantic QC: ${semanticQc.reasons.join(', ')}. Rewrite the whole script once. Preserve the topic, but make every failed dimension explicit. If "turn" failed, include a clear mid-script reversal such as "하지만 핵심은 단순히 사람 수를 줄이는 것이 아니다" followed by the deeper insight and payoff. Do not mention this repair instruction in narration.`}
    const repaired=await aiPlan(repairBrief,apiKey)
    const repairedCandidate=anchorNamedThinkerVisual(applyVisualBible(repaired.script,repaired.visualBible),String(brief.text||'')).script
    const repairedErrors=validateWisdomScript(repairedCandidate,brief)
    if(!repairedErrors.length){
     const repairedQc=evaluateWisdomSemanticQc(String(brief.text||''),repairedCandidate)
     if(!repairedQc.reasons.length){
      script=repairedCandidate;visualBible=repaired.visualBible;provider='openai-repair';semanticQc=repairedQc
     } else fallbackReason=`semantic repair failed: ${repairedQc.reasons.join(',')}`
    } else fallbackReason='semantic repair script validation: '+repairedErrors.join(',')
   }catch(e){fallbackReason='semantic repair error: '+(e instanceof Error?e.message:String(e))}
  }
  const semanticQcStored=await putAddressed(blobs,'generative-semantic-qc',semanticQc)
  if(semanticQc.reasons.length)throw new StageError('SEMANTIC_QC_FAILED',`wisdom semantic QC failed before paid assets: ${semanticQc.reasons.join(',')}`)
  const stored=await putAddressed(blobs,'generative-scripts',script)
  const bibleStored=visualBible?await putAddressed(blobs,'visual-bibles',visualBible):null
  let clock=0
  const captionEvents:any[]=[], withCaption=(deps.features??profileFeatures)(job).has('CAPTION')
  for(const b of script.beats){
   const start=Number(clock.toFixed(2));clock+=Number(b.durationSec);const end=Number(clock.toFixed(2))
   if(withCaption)captionEvents.push(...captions(b.narration,start,end))
  }
  const headline=wisdomHeadline(script.title,String(brief.text||''))
  const plan={schema:'job-plan/1',profile:'source_shorts',sourceAssetId:job.sourceAssetId,variantPlan:{profile:'wisdom-v1',beats:[{label:'generated-wisdom',trimStart:0,trimEnd:script.totalSeconds}],headline,events:captionEvents,plansTimeDomain:'output',useNarration:false,audioPolicy:{bgm:'off',sfx:'off',reason:'wisdom-v1 keeps generated narration intelligible; music/effects require an explicit later policy'}}}
  const planStored=await putAddressed(blobs,'plans',plan)
  return {outputRef:planStored.path,outputHash:planStored.sha256,planRef:planStored.path,result:{provider,fallbackReason,profile:WISDOM_PROFILE,briefRef,scriptRef:stored.path,visualBibleRef:bibleStored?.path??null,audioPolicy:{bgm:'off',sfx:'off'},semanticQcRef:semanticQcStored.path,semanticQc,beats:script.beats.length,totalSeconds:script.totalSeconds,targetSeconds:brief.targetSeconds}}
 }
}}
export const generativePlanExecutor=createGenerativePlanExecutor()

// Feature modules inside this stage: IMAGE (deps.image) and TTS (deps.tts), both needed to compose the beats, and
// CAPTION (the timed caption events). A feature the profile does not select is never called.
export function createGenerativeAssetExecutor(deps:{apiKey?:string; image?:typeof openAiWisdomImage; tts?:typeof openAiWisdomTts; features?:FeatureResolver}={}):StageExecutor {
 const image=deps.image??openAiWisdomImage, tts=deps.tts??openAiWisdomTts, apiKey=deps.apiKey??process.env.OPENAI_API_KEY??''
 return {
 stage:'ASSET', estimateUsd:()=>0.75,
 inputHash:(job)=>sha256(`gen-asset|${job.id}|${job.planRev}|wisdom/2`),
 async run({job,attempt,blobs,previous,signal}){
  if(job.profile!=='wisdom')throw new StageError('PROFILE_UNSUPPORTED','generative ASSET only handles wisdom')
  const features=(deps.features??profileFeatures)(job); needFeatures(features,['IMAGE','TTS'],'Wisdom ASSET')
  if(!apiKey)throw new StageError('PROVIDER_DOWN','OPENAI_API_KEY is not configured',true)
  const p=await previous('PLAN'); const scriptRef=(p?.result as any)?.scriptRef; if(!scriptRef)throw new StageError('SCRIPT_MISSING','ASSET requires PLAN script')
  const planned:any=await blobs.getJson(scriptRef); if(!planned||planned.schema!=='wisdom-script/1')throw new StageError('SCRIPT_INVALID','wisdom script missing')
  // A thinker named in the opening (title/hook/first two narrations) must be drawn in the first cuts. Only that beat's image
  // prompt can change, so its image is the only cache miss; every other image and all narration/TTS (and timing) are reused.
  const opening=[planned.title,planned.hook,...(planned.beats||[]).slice(0,2).map((b:any)=>b?.narration)].join(' ')
  const {script,anchoredBeatId}=anchorNamedThinkerVisual(planned,opening)
  const items:any[]=[]; let bytes=0, generated=0, reused=0
  const cached:Array<{im:any,au:any}>=[]
  for(const b of script.beats){
   const ik=sha256('image-v1|'+b.imagePrompt), ak=sha256('tts-v1|'+b.narration)
   let im:any=null, au:any=null
   try{const m:any=await blobs.getJson('generative-cache/image/'+ik+'.json');const z=m?.ref?await blobs.getBytes(m.ref):null;if(z)im={...m,bytes:z}}catch{}
   try{const m:any=await blobs.getJson('generative-cache/tts/'+ak+'.json');const z=m?.ref?await blobs.getBytes(m.ref):null;if(z)au={...m,bytes:z}}catch{}
   cached.push({im,au})
  }
  // Rerun of an already-paid ASSET (ASSET_RECHECK_JOB_ID): the only paid call allowed is the named-thinker anchor image.
  // Any other cache miss would silently re-buy images/TTS and could change timing, so refuse before spending anything.
  const prior=await previous('ASSET')
  const priorAssetSpecRef=(prior?.result as any)?.assetSpecRef
  let samePlannedScript=false
  if(priorAssetSpecRef){
   const priorSpec:any=await blobs.getJson(priorAssetSpecRef).catch(()=>null)
   samePlannedScript=String(priorSpec?.scriptRef||'')===String(scriptRef||'')
  }
  if(priorAssetSpecRef&&samePlannedScript){
   const misses=script.beats.flatMap((b:any,i:number)=>[...(!cached[i].im&&b.id!==anchoredBeatId?[`${b.id}.image`]:[]),...(!cached[i].au?[`${b.id}.tts`]:[])])
   if(misses.length)throw new StageError('ASSET_RECHECK_WOULD_REGENERATE',`same-plan ASSET rerun refuses paid regeneration beyond the named-thinker anchor: ${misses.join(',')}`)
  }
  for(const [i,b] of script.beats.entries()){
   if(signal.aborted)throw new Error('aborted')
   let {im,au}=cached[i]; const ik=sha256('image-v1|'+b.imagePrompt), ak=sha256('tts-v1|'+b.narration)
   const imageCacheHit=!!im, ttsCacheHit=!!au
   if(im)reused++;else{im=await image(b.imagePrompt,apiKey);generated++}
   if(au)reused++;else{au=await tts(b.narration,apiKey);generated++}
   const ih=sha256(im.bytes), ah=sha256(au.bytes)
   const ip=`generative-assets/images/${ih}.jpg`, ap=`generative-assets/audio/${ah}.mp3`
   // Cache hits already point at durable Blob bytes. Do not issue another PUT/HEAD cycle for the same asset or cache JSON.
   // If old metadata is inconsistent with the bytes we just read, repair it once into the canonical content-addressed path.
   const imageCacheValid=imageCacheHit&&cacheEntryIsCanonical(im,ip,ih)
   const ttsCacheValid=ttsCacheHit&&cacheEntryIsCanonical(au,ap,ah)
   if(!imageCacheValid){
    await blobs.putBytes(ip,im.bytes,im.contentType)
    await blobs.putJson('generative-cache/image/'+ik+'.json',{ref:ip,sha256:ih,contentType:im.contentType,provider:im.provider,model:im.model})
   }
   if(!ttsCacheValid){
    await blobs.putBytes(ap,au.bytes,au.contentType)
    await blobs.putJson('generative-cache/tts/'+ak+'.json',{ref:ap,sha256:ah,contentType:au.contentType,provider:au.provider,model:au.model})
   }
   bytes+=im.bytes.length+au.bytes.length
   items.push({beatId:b.id,durationSec:b.durationSec,narration:b.narration,image:{status:'ready',ref:ip,sha256:ih,contentType:im.contentType,provider:im.provider,model:im.model},tts:{status:'ready',ref:ap,sha256:ah,contentType:au.contentType,provider:au.provider,model:au.model}})
  }
  const manifest={schema:'generative-assets/1',profile:'wisdom',scriptRef,items,...(anchoredBeatId?{namedThinkerAnchor:{beatId:anchoredBeatId,imagePrompt:script.beats[0].imagePrompt}}:{})}
  const stored=await putAddressed(blobs,'generative-assets',manifest)
  const work=await mkdtemp(join(tmpdir(),'wisdom-asset-'))
  try{
   const segments:string[]=[]; let segmentArgv:string[]=[]
   for(let i=0;i<items.length;i++){
    const x=items[i], im=await blobs.getBytes(x.image.ref), au=await blobs.getBytes(x.tts.ref)
    if(!im||!au)throw new StageError('ASSET_BYTES_MISSING',`generated bytes missing for ${x.beatId}`)
    const ip=join(work,`i${i}.jpg`),ap=join(work,`a${i}.mp3`),op=join(work,`s${i}.mp4`)
    await writeFile(ip,im);await writeFile(ap,au)
    const audioInfo=await probe(ap)
    const narrationSec=Number(audioInfo.duration||0)
    const d=Number(Math.max(Number(x.durationSec),narrationSec+0.35).toFixed(2))
    x.plannedDurationSec=Number(x.durationSec);x.narrationDurationSec=Number(narrationSec.toFixed(2));x.durationSec=d
    const argv=screenDnaSegmentArgv(ip,ap,d,op); if(i===0)segmentArgv=argv
    await runOk(argv,{signal,timeoutMs:120000})
    segments.push(op)
   }
   const list=join(work,'concat.txt');await writeFile(list,segments.map(p=>`file '${p.replaceAll("'","'\\''")}'`).join('\n'))
   const out=join(work,'source.mp4');await runOk(['-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',out],{signal,timeoutMs:120000})
   const video=await readFile(out), vh=sha256(video), info=await probe(out), blobPath=`source-collector/generated/${vh}.mp4`
   const actualTotal=Number(Number(info.duration||0).toFixed(2))
   if(!(actualTotal>0)) throw new StageError('GENERATED_DURATION_INVALID','generated concat duration is invalid')
   const plannedTotal=items.reduce((sum:number,x:any)=>sum+Number(x.durationSec||0),0)
   let timedClock=0
   const timedEvents:any[]=[]
   for(const [i,x] of items.entries()){
    const start=Number(timedClock.toFixed(2))
    const rawEnd=i===items.length-1?actualTotal:(plannedTotal>0?actualTotal*((timedClock+Number(x.durationSec||0))/plannedTotal):actualTotal)
    const end=Number(Math.min(actualTotal,Math.max(start,rawEnd)).toFixed(2));timedClock=end
    if(features.has('CAPTION'))timedEvents.push(...wisdomCaptionEvents(x.narration,start,end))
   }
   const timedTotal=actualTotal
   const timedManifest={...manifest,items,actualDurationSec:actualTotal}
   const timedStored=await putAddressed(blobs,'generative-assets',timedManifest)
   const timedPlan={schema:'job-plan/1',profile:'source_shorts',sourceAssetId:job.sourceAssetId,variantPlan:{profile:'wisdom-v1',beats:[{label:'generated-wisdom',trimStart:0,trimEnd:timedTotal}],headline:wisdomHeadline(script.title,String((await blobs.getJson(String((await previous('PLAN'))?.result?.briefRef||'')) as any)?.text||'')),events:timedEvents,plansTimeDomain:'output',useNarration:false,audioPolicy:{bgm:'off',sfx:'off',reason:'wisdom-v1 keeps generated narration intelligible; music/effects require an explicit later policy'}}}
   const timedPlanStored=await putAddressed(blobs,'plans',timedPlan)
   await blobs.putBytes(blobPath,video,'video/mp4')
   // Execution receipt: the exact geometry command this attempt ran and the bytes it produced (verified by AUTO_QC).
   const geometryReceipt:AssetGeometryReceipt={schema:'screen-dna-receipt/1',stage:'ASSET',jobId:job.id,attempt,contract:SHORTS_SCREEN_DNA,segmentFilter:screenDnaSegmentFilter(),segmentArgv,segments:items.map((x:any)=>({beatId:x.beatId,imageSha256:x.image.sha256,durationSec:x.durationSec})),outputSha256:vh,outputRef:blobPath}
   const source={sourceAssetId:job.sourceAssetId,blobPath,sha256:vh,duration:info.duration,width:info.width,height:info.height,videoCodec:info.videoCodec,audioCodec:info.audioCodec,generative:true,assetSpecRef:timedStored.path}
   // generative-sources/<id>.json is the job's mutable source POINTER (ANALYZE/COMPILE/RENDER resolve the source through it).
   // It must be overwritten on an ASSET rerun, and read back: a stale pointer silently re-renders the previous video.
   const pointer=`generative-sources/${job.sourceAssetId}.json`
   await blobs.putJson(pointer,source,{overwrite:true})
   const current:any=await blobs.getJson(pointer)
   if(current?.sha256!==vh||current?.blobPath!==blobPath)throw new StageError('SOURCE_POINTER_STALE',`${pointer} still points at ${String(current?.sha256||'nothing').slice(0,12)}, not the new source ${vh.slice(0,12)}`,true)
   return {outputRef:timedStored.path,outputHash:timedStored.sha256,result:{assetSpecRef:timedStored.path,timedPlanRef:timedPlanStored.path,namedThinkerAnchorBeatId:anchoredBeatId,geometryReceipt,timedTotalSeconds:timedTotal,items:items.length,ready:true,bytes,generated,reused,source},provider:'openai',model:'gpt-image-1-mini+gpt-4o-mini-tts'}
  }finally{await rm(work,{recursive:true,force:true})}
 }}
}
export const generativeAssetExecutor=createGenerativeAssetExecutor()
