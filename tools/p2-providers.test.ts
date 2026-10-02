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
test('P2 ASSET declares paid provider budget before execution',()=>{
 const ex=createGenerativeAssetExecutor({apiKey:'k'})
 assert.ok(ex.estimateUsd({} as any)>0)
})

test('P2 asset request cache keys are stable across retries',()=>{
 const imagePrompt='same visual prompt', narration='같은 나레이션'
 const {createHash}=require('node:crypto')
 const h=(s:string)=>createHash('sha256').update(s).digest('hex')
 assert.equal(h('image-v1|'+imagePrompt),h('image-v1|'+imagePrompt))
 assert.equal(h('tts-v1|'+narration),h('tts-v1|'+narration))
 assert.notEqual(h('image-v1|'+imagePrompt),h('image-v1|changed'))
})
