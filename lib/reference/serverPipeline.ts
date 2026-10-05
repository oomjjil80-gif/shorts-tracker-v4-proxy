import { get, put } from '../objectStorage.js'
import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { getReferenceAsset } from './ingest.js'
import { analyzeReferenceDeterministic, type ReferenceSignals } from './analyzer.js'
import { analysisCacheKey, stableHash, validateReferenceAnalysis, type ReferenceAnalysis, type ReferenceAsset } from './contracts.js'
import { analyzeSourceFile } from '../media/analyze.js'
import { probe, extractJpeg } from '../media/ffmpeg.js'
import { existsSync } from 'node:fs'

const defaults={get,put}
export const REFERENCE_CAPTION_VISION_VERSION='reference-caption-vision/2' as const
const clamp=(n:number)=>Math.max(0,Math.min(1,n))
export async function detectCaptionRegions(file:string,asset:ReferenceAsset,opts:{fetchImpl?:typeof fetch;apiKey?:string;model?:string;timeoutMs?:number}={}):Promise<ReferenceSignals['captionRegions']>{
 const apiKey=opts.apiKey??process.env.OPENAI_API_KEY,model=opts.model??process.env.OPENAI_PLAN_MODEL??'gpt-5-mini';if(!apiKey)return []
 const fetchImpl=opts.fetchImpl??fetch,duration=Number(asset.duration||0)
 let sampled=0,attempted=0,succeeded=0
 const times=asset.kind==='video'&&duration>0?[duration*.2,duration*.5,duration*.8]:[0],regions:NonNullable<ReferenceSignals['captionRegions']>=[]
 for(let i=0;i<times.length;i++){
  const jpg=`/tmp/reference-caption-${randomUUID()}.jpg`
  try{
   await extractJpeg(file,times[i],jpg,'scale=720:-2');if(!existsSync(jpg))continue;sampled++
   const b=await import('node:fs/promises').then(x=>x.readFile(jpg)),schema={type:'object',additionalProperties:false,required:['regions'],properties:{regions:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['x','y','width','height'],properties:{x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'}}}}}}
   attempted++
   const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),opts.timeoutMs??15000)
   let res:Response
   try{res=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',signal:ac.signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body:JSON.stringify({model,input:[{role:'user',content:[{type:'input_text',text:`Caption detector ${REFERENCE_CAPTION_VISION_VERSION}. Detect only viewer-facing caption/subtitle/title text regions in this single video frame or still image. Ignore timestamps, watermarks, logos and tiny technical metadata. Return normalized 0..1 boxes relative to THIS FRAME only. Do not invent regions.`},{type:'input_image',image_url:`data:image/jpeg;base64,${b.toString('base64')}`}]}],text:{format:{type:'json_schema',name:'caption_regions',strict:true,schema}}})})}finally{clearTimeout(timer)}
   if(!res.ok)continue
   succeeded++
   const d:any=await res.json(),raw=d?.output_text??d?.output?.flatMap((o:any)=>o?.content||[]).find((z:any)=>typeof z?.text==='string')?.text,p=JSON.parse(raw||'{}')
   for(const r of Array.isArray(p.regions)?p.regions:[]){const z={x:clamp(Number(r.x)),y:clamp(Number(r.y)),width:clamp(Number(r.width)),height:clamp(Number(r.height))};if(z.width>.01&&z.height>.01&&z.x+z.width<=1.01&&z.y+z.height<=1.01)regions.push(z)}
  }catch{/* provider/frame failure is no measurement, never PASS */}finally{await unlink(jpg).catch(()=>{})}
 }
 if(sampled===0)throw new Error('caption frame extraction unavailable for all sampled frames')
 if(attempted===0||succeeded===0)throw new Error('caption vision unavailable for all sampled frames')
 return regions
}
type Deps=typeof defaults
const MAX=200*1024*1024
const invertRanges=(silent:Array<{start:number;end:number}>,duration:number)=>{const out:Array<{start:number;end:number}>=[];let t=0;for(const z of [...silent].sort((a,b)=>a.start-b.start)){if(z.start>t+0.1)out.push({start:Number(t.toFixed(3)),end:Number(z.start.toFixed(3))});t=Math.max(t,z.end)}if(duration>t+0.1)out.push({start:Number(t.toFixed(3)),end:Number(duration.toFixed(3))});return out}

async function readAll(asset:ReferenceAsset,deps:Deps){
 const r=await deps.get(asset.blobPath,{access:'private',useCache:false});if(!r||r.statusCode!==200||!r.stream)throw new Error('reference blob not found')
 const reader=(r.stream as ReadableStream<Uint8Array>).getReader(),chunks:Uint8Array[]=[];let n=0
 for(;;){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>MAX)throw new Error('reference blob too large');chunks.push(value)}
 return Buffer.concat(chunks,n)
}
async function cached(asset:ReferenceAsset,deps:Deps):Promise<ReferenceAnalysis|null>{
 const r=await deps.get(analysisCacheKey(asset),{access:'private',useCache:false});if(!r||r.statusCode!==200||!r.stream)return null
 const a=await new Response(r.stream).json() as ReferenceAnalysis
 if(validateReferenceAnalysis(a,asset).length)throw new Error('invalid cached reference analysis')
 return a
}
export async function analyzeRegisteredReference(referenceAssetId:string,deps:Deps=defaults):Promise<{analysis:ReferenceAnalysis;analysisHash:string;cached:boolean}>{
 const asset=await getReferenceAsset(referenceAssetId,deps)
 const prior=await cached(asset,deps);if(prior)return {analysis:prior,analysisHash:stableHash(prior),cached:true}
 const bytes=await readAll(asset,deps),tmp=`/tmp/reference-${randomUUID()}`;await writeFile(tmp,bytes)
 try{
  let signals:ReferenceSignals
  if(asset.kind==='video'){
   const s=await analyzeSourceFile(tmp,{sourceAssetId:asset.referenceAssetId,sha256:asset.sha256})
   signals={duration:s.media.duration,width:s.media.width,height:s.media.height,hasAudio:s.media.hasAudio,sceneRanges:s.scenes,highlights:s.highlights,silentRanges:s.ranges.silent,narrationRanges:s.media.hasAudio?invertRanges(s.ranges.silent,s.media.duration):[],captionRegions:await detectCaptionRegions(tmp,asset)}
  }else{
   const m=await probe(tmp)
   if(!m.hasVideo||!m.width||!m.height)throw new Error('still reference could not be decoded')
   if(m.width!==asset.width||m.height!==asset.height)throw new Error('reference registry dimensions do not match bytes')
   signals={width:m.width,height:m.height,hasAudio:false,captionRegions:await detectCaptionRegions(tmp,asset)}
  }
  const analysis=analyzeReferenceDeterministic(asset,signals)
  const errors=validateReferenceAnalysis(analysis,asset);if(errors.length)throw new Error('invalid measured reference analysis: '+errors.join(','))
  try{await deps.put(analysisCacheKey(asset),JSON.stringify(analysis),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'})}
  catch(e){const raced=await cached(asset,deps);if(raced)return {analysis:raced,analysisHash:stableHash(raced),cached:true};throw e}
  return {analysis,analysisHash:stableHash(analysis),cached:false}
 }finally{await unlink(tmp).catch(()=>{})}
}
