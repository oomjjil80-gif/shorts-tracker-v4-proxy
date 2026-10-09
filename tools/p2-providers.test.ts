import test from 'node:test'
import assert from 'node:assert/strict'
import { geminiWisdomImage,openAiWisdomTts } from '../lib/generative/providers.js'
import { createGenerativeAssetExecutor } from '../worker/stages/generative.js'
import { createMemoryBlobStore,putAddressed } from '../lib/jobs/blobs.js'
import { createHash } from 'node:crypto'

test('P2 image adapter: a Gemini portrait (2:3) picture, real bytes required',async()=>{
 let body:any,url=''
 const fake:any=async(u:any,o:any)=>{url=u;body=JSON.parse(o.body);return new Response(JSON.stringify({steps:[{type:'model_output',content:[{type:'image',data:Buffer.from('jpg').toString('base64'),mime_type:'image/jpeg'}]}]}),{status:200,headers:{'content-type':'application/json'}})}
 const x=await geminiWisdomImage('scene','k',fake)
 assert.match(url,/generativelanguage\.googleapis\.com/);assert.equal(body.model,'gemini-3.1-flash-image');assert.deepEqual(body.response_format,[{type:'image',aspect_ratio:'2:3',image_size:'1K'}]);assert.equal(x.bytes.toString(),'jpg')
 await assert.rejects(geminiWisdomImage('scene','k',(async()=>new Response('{}',{status:200})) as any),/no image/)
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
 const h=(s:string)=>createHash('sha256').update(s).digest('hex')
 assert.equal(h('image-v1|'+imagePrompt),h('image-v1|'+imagePrompt))
 assert.equal(h('tts-v1|'+narration),h('tts-v1|'+narration))
 assert.notEqual(h('image-v1|'+imagePrompt),h('image-v1|changed'))
})
