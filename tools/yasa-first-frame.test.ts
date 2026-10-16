import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { normalizeGenerativeBrief } from '../lib/generative/contracts.js'

test('yasa first frame defaults to miniature, preserving wisdom lock',()=>{
 const yasa=normalizeGenerativeBrief({kind:'topic',text:'조선시대 숨겨진 비밀 이야기',thumbnailFirst:true},'yasa_shorts')
 assert.equal(yasa.thumbnailFirst,true)
 assert.equal(yasa.firstFrameStyle,'miniature')
 const wisdom=normalizeGenerativeBrief({kind:'topic',text:'삶의 지혜와 인내 이야기',thumbnailFirst:true},'wisdom')
 assert.equal(wisdom.thumbnailFirst,undefined)
 assert.equal(wisdom.firstFrameStyle,undefined)
})
test('yasa style input validation',()=>{
 for(const style of ['miniature','animation','watercolor','ink']){
  const b=normalizeGenerativeBrief({kind:'topic',text:'조선시대 숨겨진 비밀 이야기',thumbnailFirst:true,firstFrameStyle:style},'yasa_shorts')
  assert.equal(b.firstFrameStyle,style)
 }
 assert.throws(()=>normalizeGenerativeBrief({kind:'topic',text:'조선시대 숨겨진 비밀 이야기',thumbnailFirst:true,firstFrameStyle:'invalid'},'yasa_shorts'))
})
test('yasa first frame gate is before all narration calls and reference is 9:16',async()=>{
 const asset=await readFile(new URL('../worker/stages/generative.ts',import.meta.url),'utf8')
 const providers=await readFile(new URL('../lib/generative/providers.ts',import.meta.url),'utf8')
 assert.ok(asset.indexOf("if(frameEnabled&&frame?.status!=='approved')")<asset.indexOf('const cached:Array'))
 assert.match(asset,/return \{wait:'DECISION'/)
 assert.match(asset,/frameEnabled&&i===0/)
 assert.match(asset,/geminiShortsImageWithReference/)
 assert.match(providers,/aspectRatio:'9:16',imageSize:'1K',references:/)
})
