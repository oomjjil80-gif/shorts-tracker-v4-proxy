import type { GenerativeBrief } from './contracts.js'
import type { WisdomScript } from './wisdom.js'

export type WisdomVisualBible={schema:'wisdom-visual-bible/1',style:string,palette:string,lighting:string,composition:string,characterPolicy:string,negative:string}

export async function openAiWisdomPlan(brief:GenerativeBrief,apiKey:string,model=process.env.OPENAI_PLAN_MODEL||'gpt-6-luna'):Promise<{script:WisdomScript;visualBible:WisdomVisualBible}>{
 if(!apiKey)throw new Error('OPENAI_API_KEY missing')
 const schema={type:'object',additionalProperties:false,required:['script','visualBible'],properties:{
  script:{type:'object',additionalProperties:false,required:['schema','title','hook','beats','ending','totalSeconds'],properties:{
   schema:{type:'string',const:'wisdom-script/1'},title:{type:'string'},hook:{type:'string'},ending:{type:'string'},totalSeconds:{type:'number'},
   beats:{type:'array',minItems:4,maxItems:10,items:{type:'object',additionalProperties:false,required:['id','narration','visualGoal','imagePrompt','durationSec'],properties:{id:{type:'string'},narration:{type:'string'},visualGoal:{type:'string'},imagePrompt:{type:'string'},durationSec:{type:'number'}}}}
  }},
  visualBible:{type:'object',additionalProperties:false,required:['schema','style','palette','lighting','composition','characterPolicy','negative'],properties:{schema:{type:'string',const:'wisdom-visual-bible/1'},style:{type:'string'},palette:{type:'string'},lighting:{type:'string'},composition:{type:'string'},characterPolicy:{type:'string'},negative:{type:'string'}}}
 }}
 const instructions='You are the planning engine for a Korean wisdom short video. Return only the required structured object. Build a strong first-line hook, coherent progression, a meaningful turn, and a memorable closing. Do not merely split or paraphrase the input sentence by sentence. Narration must be natural spoken Korean, each beat concise. Visuals must communicate the idea without readable text. Create one visual bible that makes all images feel like one production.'
 const input=`Input kind: ${brief.kind}\nTarget: ${brief.targetSeconds}s\nSource/topic: ${brief.text}\nStructure: hook -> development -> turn -> payoff/aftertaste. 4-10 beats. Total beat durations 35-75 seconds and close to target.`
 const res=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,instructions,input,text:{format:{type:'json_schema',name:'wisdom_plan',strict:true,schema}}})})
 if(!res.ok)throw new Error(`OpenAI PLAN HTTP ${res.status}: ${(await res.text()).slice(0,500)}`)
 const j:any=await res.json();const raw=j.output_text??j.output?.flatMap((x:any)=>x.content??[]).find((x:any)=>x.type==='output_text')?.text
 if(!raw)throw new Error('OpenAI PLAN returned no output_text')
 return JSON.parse(raw)
}

export function applyVisualBible(script:WisdomScript,b:WisdomVisualBible):WisdomScript{
 return {...script,beats:script.beats.map(x=>({...x,imagePrompt:`${b.style}. Palette: ${b.palette}. Lighting: ${b.lighting}. Composition: ${b.composition}. Character policy: ${b.characterPolicy}. Scene goal: ${x.visualGoal}. Scene: ${x.imagePrompt}. Avoid: ${b.negative}. vertical 9:16, no readable text, no watermark`}))}
}
