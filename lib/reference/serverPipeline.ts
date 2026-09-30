import { get, put } from '@vercel/blob'
import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { getReferenceAsset } from './ingest.js'
import { analyzeReferenceDeterministic, type ReferenceSignals } from './analyzer.js'
import { analysisCacheKey, stableHash, validateReferenceAnalysis, type ReferenceAnalysis, type ReferenceAsset } from './contracts.js'
import { analyzeSourceFile } from '../media/analyze.js'
import { probe } from '../media/ffmpeg.js'

const defaults={get,put}
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
   signals={duration:s.media.duration,width:s.media.width,height:s.media.height,hasAudio:s.media.hasAudio,sceneRanges:s.scenes,highlights:s.highlights,silentRanges:s.ranges.silent,narrationRanges:s.media.hasAudio?invertRanges(s.ranges.silent,s.media.duration):[]}
  }else{
   const m=await probe(tmp)
   if(!m.hasVideo||!m.width||!m.height)throw new Error('still reference could not be decoded')
   if(m.width!==asset.width||m.height!==asset.height)throw new Error('reference registry dimensions do not match bytes')
   signals={width:m.width,height:m.height,hasAudio:false}
  }
  const analysis=analyzeReferenceDeterministic(asset,signals)
  const errors=validateReferenceAnalysis(analysis,asset);if(errors.length)throw new Error('invalid measured reference analysis: '+errors.join(','))
  await deps.put(analysisCacheKey(asset),JSON.stringify(analysis),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'})
  return {analysis,analysisHash:stableHash(analysis),cached:false}
 }finally{await unlink(tmp).catch(()=>{})}
}
