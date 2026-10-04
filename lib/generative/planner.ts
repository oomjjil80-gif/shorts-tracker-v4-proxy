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
 const instructions=`You are the writer-director for a Korean wisdom Short. Return only the required structured object.

PRIMARY GOAL: make the viewer want to hear the NEXT sentence. Good writing comes before validation.

VOICE / WRITING:
- Write for the ear, not for an essay. Natural Korean spoken by one confident narrator.
- The first line must earn attention within about 2 seconds: tension, contradiction, an uncomfortable truth, or a sharply specific curiosity gap. Never open with a greeting, topic announcement, definition, biography, or "오늘은".
- Do not explain the conclusion early. Reveal only enough information to create the next question.
- Every beat must add a NEW idea, consequence, image, example, or emotional shift. No paraphrase loops.
- Around the middle, renew attention with a re-hook: reversal, "but", unexpected consequence, concrete human example, or a question whose answer matters.
- Prefer concrete everyday language and short rhythmic sentences over abstract lecture language. Vary sentence length so narration has punch and breathing room.
- When a thinker is involved, use the thinker to sharpen the viewer's present-day problem; do not turn the Short into a biography or textbook summary.
- The payoff must resolve the opening tension and change how the viewer interprets the topic. End on the strongest memorable line, not a summary, moral label, CTA, or generic encouragement.
- Avoid canned phrases and AI prose such as "중요한 것은", "결국 우리에게 필요한 것은", "한번 생각해보세요", "삶의 지혜", unless the specific context truly demands them.
- hook must be the exact opening narration or a faithful short form of it; ending must be the exact closing narration or a faithful short form of it.
- Do not imitate any creator's exact wording or catchphrases. The desired quality is lively pacing, conversational punch, curiosity control, and payoff.

STORY RHYTHM:
hook -> escalating development -> re-hook/turn -> payoff/aftertaste.
Before finalizing, silently check: if two adjacent beats say essentially the same thing, rewrite one; if the final beat could be removed without changing the meaning, strengthen the payoff.

Narration must remain concise enough for each assigned beat. Visuals must communicate the idea without readable text. Create one visual bible that makes all images feel like one production.

IMPORTANT VISUAL IDENTITY: when the source/topic names a philosopher, sage, thinker, or historical person, at least one early beat MUST visually depict that named person recognizably in period-appropriate context. Additional beats may reuse the same visual identity only when editorially useful. Do not produce a named-philosopher video with zero images of that person.`
 const input=`Input kind: ${brief.kind}\nTarget: ${brief.targetSeconds}s\nSource/topic: ${brief.text}\nBuild 4-10 beats totaling 35-75 seconds and close to target. Spend words on tension, progression and payoff rather than explaining everything.`
 const res=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,instructions,input,text:{format:{type:'json_schema',name:'wisdom_plan',strict:true,schema}}})})
 if(!res.ok)throw new Error(`OpenAI PLAN HTTP ${res.status}: ${(await res.text()).slice(0,500)}`)
 const j:any=await res.json();const raw=j.output_text??j.output?.flatMap((x:any)=>x.content??[]).find((x:any)=>x.type==='output_text')?.text
 if(!raw)throw new Error('OpenAI PLAN returned no output_text')
 return JSON.parse(raw)
}

export function applyVisualBible(script:WisdomScript,b:WisdomVisualBible):WisdomScript{
 return {...script,beats:script.beats.map(x=>({...x,imagePrompt:`${b.style}. Palette: ${b.palette}. Lighting: ${b.lighting}. Composition: center-safe for a 1080x1200 middle visual window; keep key faces and subjects inside the central area with breathing room. Character policy: ${b.characterPolicy}. Scene goal: ${x.visualGoal}. Scene: ${x.imagePrompt}. Avoid: ${b.negative}. no readable text, no watermark`}))}
}
