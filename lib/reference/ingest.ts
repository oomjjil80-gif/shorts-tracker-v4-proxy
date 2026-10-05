import { get, put } from '../objectStorage.js'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { probe } from '../media/ffmpeg.js'
import { referenceAssetId, validateReferenceAsset, type ReferenceAsset, type ReferenceKind } from './contracts.js'

const defaults={get,put}
type Deps=typeof defaults
const MAX=200*1024*1024
function pathFor(sha:string){return `references/v1/assets/${sha.slice(0,2)}/${sha}`}
function recordFor(id:string){return `references/v1/registry/${id}.json`}

export async function ingestReferenceBytes(input:{bytes:Buffer;contentType:string;kind:ReferenceKind;width?:number;height?:number;duration?:number;originalUrl?:string|null},deps:Deps=defaults):Promise<ReferenceAsset>{
 if(!input.bytes.length||input.bytes.length>MAX) throw new Error('invalid reference size')
 const tmp=`/tmp/reference-ingest-${randomUUID()}`
 await writeFile(tmp,input.bytes)
 let measured:any
 try{measured=await probe(tmp)}finally{await unlink(tmp).catch(()=>{})}
 if(!measured.hasVideo||!measured.width||!measured.height) throw new Error('reference bytes are not a decodable visual asset')
 if(input.kind==='video'&&!(Number(measured.duration)>0)) throw new Error('reference video duration could not be measured')
 const measuredKind:ReferenceKind=Number(measured.duration)>0?'video':(input.kind==='screenshot'?'screenshot':'image')
 if(input.kind==='video'&&measuredKind!=='video') throw new Error('declared video kind does not match decoded bytes')
 if(input.kind!=='video'&&measuredKind==='video') throw new Error('declared still kind does not match decoded bytes')
 const sha256=createHash('sha256').update(input.bytes).digest('hex')
 const id=referenceAssetId(sha256)
 const blobPath=pathFor(sha256)
 const existing=await deps.get(recordFor(id),{access:'private',useCache:false})
 if(existing&&existing.statusCode===200&&existing.stream){const prior=await new Response(existing.stream).json() as ReferenceAsset;const e=validateReferenceAsset(prior);if(e.length||prior.referenceAssetId!==id||prior.sha256!==sha256)throw new Error('reference registry identity conflict');return prior}
 await deps.put(blobPath,input.bytes,{access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:input.contentType})
 const asset:ReferenceAsset={schema:'reference-asset/1',referenceAssetId:id,kind:input.kind,sha256,bytes:input.bytes.length,contentType:input.contentType,blobPath,width:measured.width,height:measured.height,duration:input.kind==='video'?measured.duration:undefined,originalUrl:input.originalUrl??null,createdAt:new Date().toISOString()}
 const errors=validateReferenceAsset(asset); if(errors.length) throw new Error('invalid reference asset: '+errors.join(','))
 await deps.put(recordFor(id),JSON.stringify(asset),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'})
 return asset
}
export async function getReferenceAsset(id:string,deps:Deps=defaults):Promise<ReferenceAsset>{
 const r=await deps.get(recordFor(id),{access:'private',useCache:false}); if(!r||r.statusCode!==200) throw new Error('reference asset not found')
 const asset=await new Response(r.stream).json() as ReferenceAsset; const errors=validateReferenceAsset(asset); if(errors.length||asset.referenceAssetId!==id) throw new Error('invalid reference asset record')
 return asset
}
