import { get, put } from '@vercel/blob'
import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { getReferenceAsset } from './ingest.js'
import { analyzeReferenceDeterministic, type ReferenceSignals } from './analyzer.js'
import { analysisCacheKey, stableHash, validateReferenceAnalysis, type ReferenceAnalysis, type ReferenceAsset } from './contracts.js'
import { analyzeSourceFile } from '../media/analyze.js'

const defaults={get,put}
type Deps=typeof defaults
const MAX=200*1024*1024

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
 if(asset.kind!=='video')throw new Error('server measurement for image/screenshot is not implemented yet')
 const bytes=await readAll(asset,deps),tmp=`/tmp/reference-${randomUUID()}.mp4`;await writeFile(tmp,bytes)
 try{
  const s=await analyzeSourceFile(tmp,{sourceAssetId:asset.referenceAssetId,sha256:asset.sha256})
  const signals:ReferenceSignals={duration:s.media.duration,width:s.media.width,height:s.media.height,hasAudio:s.media.hasAudio,sceneRanges:s.scenes,highlights:s.highlights,silentRanges:s.ranges.silent}
  const analysis=analyzeReferenceDeterministic(asset,signals)
  const errors=validateReferenceAnalysis(analysis,asset);if(errors.length)throw new Error('invalid measured reference analysis: '+errors.join(','))
  await deps.put(analysisCacheKey(asset),JSON.stringify(analysis),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'})
  return {analysis,analysisHash:stableHash(analysis),cached:false}
 }finally{await unlink(tmp).catch(()=>{})}
}
