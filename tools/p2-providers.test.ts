import test from 'node:test'
import assert from 'node:assert/strict'
import { openAiWisdomImage,openAiWisdomTts } from '../lib/generative/providers.js'
import { createGenerativeAssetExecutor } from '../worker/stages/generative.js'
import { createMemoryBlobStore,putAddressed } from '../lib/jobs/blobs.js'

test('P2 image adapter requests vertical low-cost image and requires real bytes',async()=>{
 let body:any
 const fake:any=async(_u:any,o:any)=>{body=JSON.parse(o.body);return new Response(JSON.stringify({data:[{b64_json:Buffer.from('jpg').toString('base64')}]}),{status:200,headers:{'content-type':'application/json'}})}
 const x=await openAiWisdomImage('scene','k',fake)
 assert.equal(body.model,'gpt-image-1-mini');assert.equal(body.size,'1024x1536');assert.equal(body.quality,'low');assert.equal(x.bytes.toString(),'jpg')
})
test('P2 TTS adapter uses Korean-directed speech and mp3 bytes',async()=>{
 let body:any
 const fake:any=async(_u:any,o:any)=>{body=JSON.parse(o.body);return new Response(Buffer.from('mp3'),{status:200})}
 const x=await openAiWisdomTts('안녕하세요','k',fake)
 assert.equal(body.model,'gpt-4o-mini-tts');assert.equal(body.response_format,'mp3');assert.match(body.instructions,/한국어/);assert.equal(x.bytes.toString(),'mp3')
})
test('P2 ASSET persists one image and one TTS artifact per beat and never reports ready early',async()=>{
 const blobs=createMemoryBlobStore()
 const script={schema:'wisdom-script/1',beats:[{id:'b1',narration:'하나',imagePrompt:'one',durationSec:5},{id:'b2',narration:'둘',imagePrompt:'two',durationSec:5}]}
 const st=await putAddressed(blobs,'generative-scripts',script)
 const bin=(s:string,t:string)=>({bytes:Buffer.from(s),contentType:t,provider:'mock',model:'mock'})
 const ex=createGenerativeAssetExecutor({apiKey:'k',image:async(p)=>bin('i'+p,'image/jpeg'),tts:async(t)=>bin('a'+t,'audio/mpeg')})
 const r:any=await ex.run({job:{id:'j',profile:'wisdom',planRev:1} as any,attempt:1,blobs,previous:async(stage:any)=>stage==='PLAN'?({outputRef:st.path} as any):null,resolveSourceAsset:null as any,resolveSourceFile:null as any,signal:new AbortController().signal})
 assert.equal(r.result.ready,true);assert.equal(r.result.items,2)
 const m:any=await blobs.getJson(r.outputRef);assert.equal(m.items.length,2);assert.ok(m.items.every((x:any)=>x.image.status==='ready'&&x.tts.status==='ready'));assert.equal(blobs.binaries.size,4)
})
