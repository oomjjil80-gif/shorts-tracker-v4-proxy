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
 const beats=Array.from({length:4},(_,i)=>({id:`b${i+1}`,narration:[`관계의 숫자보다 마음의 깊이를 보세요.`,`많은 관계는 때로 마음을 지치게 합니다.`,`하지만 중요한 건 서로를 편안하게 하는 깊이입니다.`,`관계는 숫자보다 깊이가 오래 남습니다.`][i],visualGoal:`goal ${i+1}`,imagePrompt:`scene ${i+1}`,durationSec:10}))
 const script:any={schema:'wisdom-script/1',title:'관계의 깊이',hook:'많은 사람이 꼭 필요할까요?',beats,ending:'편안한 몇 사람이면 충분합니다.',totalSeconds:40}
 const bible:any={schema:'wisdom-visual-bible/1',style:'editorial watercolor',palette:'warm muted',lighting:'soft',composition:'single focus',characterPolicy:'consistent recurring person',negative:'text, watermark, clutter'}
 const ex=createGenerativePlanExecutor({apiKey:'test',plan:async()=>({script,visualBible:bible})})
 const out:any=await ex.run({job:{id:'j',profile:'wisdom',planRef:'brief.json',sourceAssetId:'src_gen_x'} as any,blobs,previous:async()=>null,signal:new AbortController().signal} as any)
 assert.equal(out.result.provider,'openai');assert.ok(out.result.visualBibleRef);assert.ok(out.result.scriptRef)
 const saved:any=await blobs.getJson(out.result.scriptRef);assert.match(saved.beats[0].imagePrompt,/editorial watercolor/)
})

test('wisdom PLAN emits contiguous narration captions and explicit BGM/SFX off policy',async()=>{
 const blobs=createMemoryBlobStore();const brief=normalizeGenerativeBrief({kind:'text',text:'관계는 숫자보다 깊이가 중요합니다.',targetSeconds:40});await blobs.putJson('brief-caption.json',brief)
 const beats=Array.from({length:4},(_,i)=>({id:`b${i+1}`,narration:[`관계의 숫자보다 마음의 깊이를 보세요.`,`많은 관계는 때로 마음을 지치게 합니다.`,`하지만 중요한 건 서로를 편안하게 하는 깊이입니다.`,`관계는 숫자보다 깊이가 오래 남습니다.`][i],visualGoal:`goal ${i+1}`,imagePrompt:`scene ${i+1}`,durationSec:10}))
 const script:any={schema:'wisdom-script/1',title:'관계의 깊이',hook:'훅',beats,ending:'여운',totalSeconds:40}
 const bible:any={schema:'wisdom-visual-bible/1',style:'watercolor',palette:'warm',lighting:'soft',composition:'single focus',characterPolicy:'consistent',negative:'text'}
 const ex=createGenerativePlanExecutor({apiKey:'test',plan:async()=>({script,visualBible:bible})})
 const out:any=await ex.run({job:{id:'j2',profile:'wisdom',planRef:'brief-caption.json',sourceAssetId:'src_gen_y'} as any,blobs,previous:async()=>null,signal:new AbortController().signal} as any)
 const plan:any=await blobs.getJson(out.planRef);const ev=plan.variantPlan.events
 assert.deepEqual(ev.map((x:any)=>[x.start,x.end]),[[0,10],[10,20],[20,30],[30,40]])
 assert.deepEqual(ev.map((x:any)=>x.text),beats.map(x=>x.narration))
 assert.equal(plan.variantPlan.audioPolicy.bgm,'off');assert.equal(plan.variantPlan.audioPolicy.sfx,'off')
})


test('wisdom PLAN blocks semantic failure before ASSET can spend money',async()=>{
 const blobs=createMemoryBlobStore();const brief=normalizeGenerativeBrief({kind:'topic',text:'관계의 깊이와 편안함',targetSeconds:40});await blobs.putJson('brief-bad.json',brief)
 const beats=Array.from({length:4},(_,i)=>({id:`b${i+1}`,narration:'오늘도 좋은 하루를 보내세요.',visualGoal:'generic',imagePrompt:'generic',durationSec:10}))
 const script:any={schema:'wisdom-script/1',title:'좋은 하루',hook:'좋은 하루',beats,ending:'좋은 하루',totalSeconds:40}
 const bible:any={schema:'wisdom-visual-bible/1',style:'watercolor',palette:'warm',lighting:'soft',composition:'single',characterPolicy:'none',negative:'text'}
 const ex=createGenerativePlanExecutor({apiKey:'test',plan:async()=>({script,visualBible:bible})})
 await assert.rejects(()=>ex.run({job:{id:'bad',profile:'wisdom',planRef:'brief-bad.json',sourceAssetId:'src_gen_bad'} as any,blobs,previous:async()=>null,signal:new AbortController().signal} as any),(e:any)=>e?.code==='SEMANTIC_QC_FAILED')
})
