import type { GenerativeBrief } from './contracts.js'
import type { WisdomScript } from './wisdom.js'

export type WisdomVisualBible={schema:'wisdom-visual-bible/1',style:string,palette:string,lighting:string,composition:string,characterPolicy:string,negative:string}

export async function openAiWisdomPlan(brief:GenerativeBrief,apiKey:string,model=process.env.OPENAI_PLAN_MODEL||'gpt-6-luna'):Promise<{script:WisdomScript;visualBible:WisdomVisualBible}>{
 if(!apiKey)throw new Error('OPENAI_API_KEY missing')
 const schema={type:'object',additionalProperties:false,required:['script','visualBible'],properties:{
  script:{type:'object',additionalProperties:false,required:['schema','title','hook','beats','ending','totalSeconds'],properties:{
   schema:{type:'string',const:'wisdom-script/1'},title:{type:'string'},hook:{type:'string'},ending:{type:'string'},totalSeconds:{type:'number'},
   beats:{type:'array',minItems:5,maxItems:12,items:{type:'object',additionalProperties:false,required:['id','narration','visualGoal','imagePrompt','durationSec'],properties:{id:{type:'string'},narration:{type:'string'},visualGoal:{type:'string'},imagePrompt:{type:'string'},durationSec:{type:'number'}}}}
  }},
  visualBible:{type:'object',additionalProperties:false,required:['schema','style','palette','lighting','composition','characterPolicy','negative'],properties:{schema:{type:'string',const:'wisdom-visual-bible/1'},style:{type:'string'},palette:{type:'string'},lighting:{type:'string'},composition:{type:'string'},characterPolicy:{type:'string'},negative:{type:'string'}}}
 }}
 const instructions='You are the planning engine for a Korean wisdom short video. Return only the required structured object. Make it feel like a compelling short video, not a static quote slideshow. Open with a direct, scroll-stopping first line that makes the viewer recognize a risk, contradiction, or uncomfortable truth. Then move through concrete everyday human situations before the insight: show what people actually do, say, hide, envy, mock, avoid, or reveal. Include roughly two concrete situations when the topic allows it, then a meaningful turn and a memorable closing that pays the opening back. Do not merely split, summarize, or paraphrase the input sentence by sentence. Narration must be natural spoken Korean and concise; prefer short spoken sentences over abstract exposition. Visuals must communicate the situation without readable text. Vary scene type and camera distance across adjacent beats: portrait, relationship scene, over-the-shoulder, wider situational scene, hands/object detail, symbolic scene. Avoid consecutive near-identical portraits or the same two-person composition. A recurring protagonist may stay visually consistent when useful, but does not need to appear in every scene. Create one visual bible that makes all images feel like one production. IMPORTANT: when the source/topic names a philosopher, sage, thinker, or historical person, at least one early beat MUST visually depict that named person recognizably in period-appropriate context, but the thinker should usually be an anchor rather than dominate every beat; 1-2 thinker-focused images are normally enough. Do not produce a named-philosopher video with zero images of that person.'
 const preferredBeats=Math.max(6,Math.min(12,Math.round(brief.targetSeconds/5.5)))
 const input=`Input kind: ${brief.kind}\nPreferred length: about ${brief.targetSeconds}s (editorial guidance only; do not sacrifice story quality to hit it).\nSource/topic: ${brief.text}\nStructure: hook -> concrete situation(s) -> deeper insight/turn -> payoff/aftertaste. Prefer about ${preferredBeats} beats for this length, but let the story breathe when needed. Most beats should feel visually distinct and avoid dead time. Narration should stay dense and natural: remove repetition and filler, but do not cut useful setup, concrete examples, or payoff merely to hit a duration target.`
 const res=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,instructions,input,text:{format:{type:'json_schema',name:'wisdom_plan',strict:true,schema}}})})
 if(!res.ok)throw new Error(`OpenAI PLAN HTTP ${res.status}: ${(await res.text()).slice(0,500)}`)
 const j:any=await res.json();const raw=j.output_text??j.output?.flatMap((x:any)=>x.content??[]).find((x:any)=>x.type==='output_text')?.text
 if(!raw)throw new Error('OpenAI PLAN returned no output_text')
 return JSON.parse(raw)
}

export function applyVisualBible(script:WisdomScript,b:WisdomVisualBible):WisdomScript{
 return {...script,beats:script.beats.map(x=>({...x,imagePrompt:`${b.style}. Palette: ${b.palette}. Lighting: ${b.lighting}. Composition: center-safe for a 1080x1200 middle visual window; keep key faces and subjects inside the central area with breathing room. Character policy: ${b.characterPolicy}. Scene goal: ${x.visualGoal}. Scene: ${x.imagePrompt}. Avoid: ${b.negative}. no readable text, no watermark`}))}
}
