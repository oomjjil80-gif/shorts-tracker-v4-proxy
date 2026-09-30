import { get, put } from '@vercel/blob'
import { createHash } from 'node:crypto'
import { referenceAssetId, validateReferenceAsset, type ReferenceAsset, type ReferenceKind } from './contracts.js'

const defaults={get,put}
type Deps=typeof defaults
const MAX=200*1024*1024
function pathFor(sha:string){return `references/v1/assets/${sha.slice(0,2)}/${sha}`}
function recordFor(id:string){return `references/v1/registry/${id}.json`}

export async function ingestReferenceBytes(input:{bytes:Buffer;contentType:string;kind:ReferenceKind;width?:number;height?:number;duration?:number;originalUrl?:string|null},deps:Deps=defaults):Promise<ReferenceAsset>{
 if(!input.bytes.length||input.bytes.length>MAX) throw new Error('invalid reference size')
 const sha256=createHash('sha256').update(input.bytes).digest('hex')
 const id=referenceAssetId(sha256)
 const blobPath=pathFor(sha256)
 await deps.put(blobPath,input.bytes,{access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:input.contentType})
 const asset:ReferenceAsset={schema:'reference-asset/1',referenceAssetId:id,kind:input.kind,sha256,bytes:input.bytes.length,contentType:input.contentType,blobPath,width:input.width,height:input.height,duration:input.duration,originalUrl:input.originalUrl??null,createdAt:new Date().toISOString()}
 const errors=validateReferenceAsset(asset); if(errors.length) throw new Error('invalid reference asset: '+errors.join(','))
 await deps.put(recordFor(id),JSON.stringify(asset),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'})
 return asset
}
export async function getReferenceAsset(id:string,deps:Deps=defaults):Promise<ReferenceAsset>{
 const r=await deps.get(recordFor(id),{access:'private',useCache:false}); if(!r||r.statusCode!==200) throw new Error('reference asset not found')
 const asset=await new Response(r.stream).json() as ReferenceAsset; const errors=validateReferenceAsset(asset); if(errors.length||asset.referenceAssetId!==id) throw new Error('invalid reference asset record')
 return asset
}
