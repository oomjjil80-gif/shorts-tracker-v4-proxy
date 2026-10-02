import test from 'node:test'
import assert from 'node:assert/strict'
import { applyVisualBible } from '../lib/generative/planner.js'
import { createGenerativePlanExecutor } from '../worker/stages/generative.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { validateWisdomScript } from '../lib/generative/wisdom.js'
import { normalizeGenerativeBrief } from '../lib/generative/contracts.js'

test('visual bible is applied consistently to every wisdom image prompt',()=>{
 const brief=normalizeGenerativeBrief({kind:'topic',text:'관계의 지혜',targetSeconds:40})
 const beats=Array.from({length:4},(_,i)=>({id:`b${i+1}`,narration:`말 ${i+1}`,visualGoal:`goal ${i+1}`,imagePrompt:`scene ${i+1}`,durationSec:10}))
 const script:any={schema:'wisdom-script/1',title:'관계',hook:'훅',beats,ending:'여운',totalSeconds:40}
 const bible:any={schema:'wisdom-visual-bible/1',style:'soft editorial watercolor',palette:'warm muted earth',lighting:'gentle morning',composition:'one clear focal subject',characterPolicy:'same mature Korean protagonist when recurring',negative:'text, clutter, watermark'}
 const out=applyVisualBible(script,bible)
 assert.deepEqual(validateWisdomScript(out,brief),[])
 for(const b of out.beats){assert.match(b.imagePrompt,/soft editorial watercolor/);assert.match(b.imagePrompt,/warm muted earth/);assert.match(b.imagePrompt,/no readable text/)}
})

test('AI PLAN output is validated, persisted, and exposes Visual Bible evidence',async()=>{
 const blobs=createMemoryBlobStore();const brief=normalizeGenerativeBrief({kind:'text',text:'관계는 숫자보다 깊이가 중요합니다.',targetSeconds:40});await blobs.putJson('brief.json',brief)
 const beats=Array.from({length:4},(_,i)=>({id:`b${i+1}`,narration:`자연스러운 문장 ${i+1}`,visualGoal:`goal ${i+1}`,imagePrompt:`scene ${i+1}`,durationSec:10}))
 const script:any={schema:'wisdom-script/1',title:'관계의 깊이',hook:'많은 사람이 꼭 필요할까요?',beats,ending:'편안한 몇 사람이면 충분합니다.',totalSeconds:40}
 const bible:any={schema:'wisdom-visual-bible/1',style:'editorial watercolor',palette:'warm muted',lighting:'soft',composition:'single focus',characterPolicy:'consistent recurring person',negative:'text, watermark, clutter'}
 const ex=createGenerativePlanExecutor({apiKey:'test',plan:async()=>({script,visualBible:bible})})
 const out:any=await ex.run({job:{id:'j',profile:'wisdom',planRef:'brief.json',sourceAssetId:'src_gen_x'} as any,blobs,previous:async()=>null,signal:new AbortController().signal} as any)
 assert.equal(out.result.provider,'openai');assert.ok(out.result.visualBibleRef);assert.ok(out.result.scriptRef)
 const saved:any=await blobs.getJson(out.result.scriptRef);assert.match(saved.beats[0].imagePrompt,/editorial watercolor/)
})
