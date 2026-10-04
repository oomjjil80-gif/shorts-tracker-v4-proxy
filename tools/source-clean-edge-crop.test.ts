import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCleanEdgeCrop } from '../lib/media/framing.js'
import { validateStory, CLEAN_EDGE_LIMITS } from '../lib/media/story.js'
import { planVariants, toJobPlan } from '../lib/media/plan.js'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'
import { AI_PLANNER_PROMPT_VERSION, storyPrompt } from '../lib/media/aiPlanner.js'

const analysis:any = {
  schema:'source-analysis/1', sourceAssetId:'src_clean_edge', sha256:'a'.repeat(64),
  media:{duration:12,width:576,height:1024,fps:30,hasAudio:true,videoCodec:'h264',audioCodec:'aac',orientation:'portrait'},
  scenes:[{start:0,end:12}], timeline:Array.from({length:12},(_,t)=>({t,visual:0.1,audioDb:-20})),
  ranges:{black:[],freeze:[],silent:[]}, audio:{silentRatio:0,intentionallySilent:false},
  highlights:[], motionPeaks:[], usable:[{start:0,end:12}], analyzer:{name:'ffmpeg-signals',version:1}
}
const raw=(crop:any)=>({
  storyType:'single_event',confidence:.95,causalStart:0,setupRanges:[{start:0,end:4}],escalationRanges:[{start:4,end:8}],
  payoffRange:{start:8,end:10},recommendedEnd:10.5,excludeRanges:[],hookStrategy:'chronological',previewRange:null,
  hookConfidence:.95,hookReason:'clean opening',cleanEdgeCrop:crop,
  minimalCaptions:[
    {kind:'hook',start:0,end:1,text:'엄마는 내려왔다',basis:'one cat jumps down'},
    {kind:'context',start:4,end:5,text:'그런데 한 마리는 그대로',basis:'one cat remains on roof'},
    {kind:'payoff',start:8,end:9,text:'차는 그대로 떠났다',basis:'car leaves with cat'}
  ],
  publishabilityWarnings:[]
})

test('safe persistent edge crop is validated and carried into every source plan',()=>{
  const v=validateStory(raw({topPct:.20,bottomPct:0,confidence:.92,basis:'same foreign title occupies only the top edge across all keyframes'}),analysis,{model:'fixture',promptVersion:AI_PLANNER_PROMPT_VERSION})
  assert.ok(v.story,v.errors.join('; '))
  assert.deepEqual(v.story!.cleanEdgeCrop,{topPct:.2,bottomPct:0,confidence:.92,basis:'same foreign title occupies only the top edge across all keyframes'})
  const variants=planVariants(analysis,{status:'ok',reason:null,story:v.story!})
  assert.ok(variants.length>=1)
  assert.ok(variants.every(x=>x.cleanEdgeCrop?.topPct===.2))
  assert.equal((toJobPlan('src_clean_edge',variants[0]) as any).variantPlan.cleanEdgeCrop.topPct,.2)
})

test('oversized or low-confidence cleanup cannot silently crop story content',()=>{
  const bad=validateStory(raw({topPct:CLEAN_EDGE_LIMITS.topMax+.01,bottomPct:0,confidence:.99,basis:'too large'}),analysis,{model:'fixture',promptVersion:AI_PLANNER_PROMPT_VERSION})
  assert.equal(bad.story,null)
  const low=validateStory(raw({topPct:.2,bottomPct:0,confidence:.5,basis:'uncertain'}),analysis,{model:'fixture',promptVersion:AI_PLANNER_PROMPT_VERSION})
  assert.ok(low.story)
  assert.equal(low.story!.cleanEdgeCrop,null)
  assert.ok(low.warnings.some(x=>x.includes('cleanEdgeCrop ignored')))
})

test('crop geometry removes only requested edge and leaves at least 68% picture height',()=>{
  const base:any={mode:'full',crop:null,confidence:0,sampleCount:7,detector:'luma-bands-v1'}
  const f=applyCleanEdgeCrop(base,{width:576,height:1024},{topPct:.2,bottomPct:0,confidence:.92,basis:'top title'})
  assert.equal(f.mode,'clean_edge')
  assert.equal(f.crop?.x,0); assert.equal(f.crop?.width,576)
  assert.ok((f.crop?.y||0)>=204 && (f.crop?.y||0)<=206,JSON.stringify(f))
  assert.ok((f.crop?.height||0)>=818 && (f.crop?.height||0)<=820,JSON.stringify(f))
})

test('immutable render manifest contains the plan-bound cleanup directive',()=>{
  const v=validateStory(raw({topPct:.2,bottomPct:0,confidence:.92,basis:'top title'}),analysis,{model:'fixture',promptVersion:AI_PLANNER_PROMPT_VERSION})
  const plan=toJobPlan('src_clean_edge',planVariants(analysis,{status:'ok',reason:null,story:v.story!})[0])
  const {manifest}=compileJobPlan({jobId:'job_crop',plan,sourceAsset:{sourceAssetId:'src_clean_edge',blobPath:'source-collector/x.mp4',sha256:'a'.repeat(64),duration:12,width:576,height:1024}})
  assert.deepEqual(manifest.payload.sourceCleanEdgeCrop,(plan as any).variantPlan.cleanEdgeCrop)
})

test('planner explicitly prefers clean edge crop over flashing or trimming persistent edge text',()=>{
  assert.equal(AI_PLANNER_PROMPT_VERSION,'source-story-analysis/16')
  const p=storyPrompt(analysis)
  assert.match(p,/CLEAN EDGE CROP/)
  assert.match(p,/Do NOT shorten its exposure as a workaround/)
  assert.match(p,/smallest crop that clears the text/)
  assert.match(p,/cut a face, hand, animal, vehicle action, payoff/)
})
