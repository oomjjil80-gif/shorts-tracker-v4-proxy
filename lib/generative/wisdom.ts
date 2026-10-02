import { WISDOM_PROFILE, type GenerativeBrief } from './contracts.js'
export type WisdomBeat={id:string,narration:string,visualGoal:string,imagePrompt:string,durationSec:number}
export type WisdomScript={schema:'wisdom-script/1',title:string,hook:string,beats:WisdomBeat[],ending:string,totalSeconds:number}
// Named historical thinkers: aliases detect the topic; `likeness` is the public-domain visual identity an image model
// needs to draw THAT person recognizably instead of a generic elderly man.
const namedThinkers:{re:RegExp,aliases:string[],name:string,likeness:string}[]=[
 {re:/쇼펜하우어|schopenhauer/i,aliases:['쇼펜하우어','schopenhauer','arthur schopenhauer'],name:'Arthur Schopenhauer',likeness:'German philosopher (1788-1860) as in his famous 1850s photographic portraits: elderly, bald crown with tufts of white hair swept out at the sides, large bushy white mutton-chop sideburns, clean-shaven chin and upper lip, thin tightly pressed lips, intense sharp eyes, dark 19th-century frock coat with high white collar and black cravat'},
 {re:/니체|nietzsche/i,aliases:['니체','nietzsche','friedrich nietzsche'],name:'Friedrich Nietzsche',likeness:'German philosopher (1844-1900) as in his 1880s portraits: very large thick drooping walrus moustache, deep-set intense eyes, swept-back dark hair, dark 19th-century suit with high collar'},
 {re:/소크라테스|socrates/i,aliases:['소크라테스','socrates'],name:'Socrates',likeness:'ancient Athenian philosopher as in classical marble busts: bald head, broad snub nose, full curly beard, simple Greek himation robe, ancient Athens setting'},
 {re:/세네카|seneca/i,aliases:['세네카','seneca'],name:'Seneca',likeness:'Roman Stoic philosopher as in classical busts: lean aged face, short unkempt beard, receding tousled hair, Roman toga, ancient Rome setting'},
 {re:/마르쿠스\s*아우렐리우스|marcus\s*aurelius/i,aliases:['마르쿠스 아우렐리우스','marcus aurelius'],name:'Marcus Aurelius',likeness:'Roman emperor and Stoic philosopher as in his classical busts and equestrian statue: thick curly hair, full curly beard, Roman imperial cloak, ancient Rome setting'},
]
const thinkerFor=(topic:string)=>namedThinkers.find(t=>t.re.test(String(topic||'')))
// applyVisualBible() wraps every beat as "... Character policy: <bible>. Scene goal: <goal>. Scene: <scene>. Avoid: ...".
// Only the beat's own scene says what is drawn; bible text is shared by all beats and a goal can merely mention a name.
export const beatScene=(imagePrompt:unknown)=>{const p=String(imagePrompt||''),i=p.lastIndexOf('. Scene: '),j=p.lastIndexOf('. Avoid: ');return i>=0&&j>i?p.slice(i+9,j):p}
const NAMED_THINKER_EARLY_BEATS=2
const depictsThinker=(b:any,t:{aliases:string[]})=>t.aliases.some(a=>beatScene(b?.imagePrompt).toLowerCase().includes(a))
export function namedThinkerVisualErrors(topic:string,s:any):string[]{
 const t=thinkerFor(topic)
 if(!t)return []
 const early=(Array.isArray(s?.beats)?s.beats:[]).slice(0,NAMED_THINKER_EARLY_BEATS)
 return early.some((b:any)=>depictsThinker(b,t))?[]:['namedThinker.earlyVisual']
}
// Deterministic guarantee used right before paid image generation: if the topic names a thinker and neither of the first
// two beats' scenes depicts them, re-aim the FIRST beat's image (only its image prompt; narration/duration untouched) at a
// recognizable likeness of that person, keeping the shared style/palette/lighting but not the generic character policy.
export function anchorNamedThinkerVisual(s:WisdomScript,topic:string):{script:WisdomScript;anchoredBeatId:string|null}{
 const t=thinkerFor(topic)
 if(!t||!s.beats.length||!namedThinkerVisualErrors(topic,s).length)return {script:s,anchoredBeatId:null}
 const b=s.beats[0], p=String(b.imagePrompt||''), cp=p.indexOf(' Character policy: '), av=p.lastIndexOf('. Avoid: ')
 const style=cp>=0?p.slice(0,cp):'', avoid=av>=0?p.slice(av+2):'no readable text, no watermark'
 const imagePrompt=`${style?style+' ':''}Main subject: a clearly recognizable portrait of ${t.name}, ${t.likeness}. He is the only person and the focal point, face fully visible in the central area. Setting mood from the scene: ${beatScene(p)}. ${avoid}`
 return {script:{...s,beats:[{...b,imagePrompt},...s.beats.slice(1)]},anchoredBeatId:b.id}
}
export function validateWisdomScript(s:any, brief:GenerativeBrief): string[] {
 const e:string[]=[]
 if(s?.schema!=='wisdom-script/1')e.push('schema')
 if(!String(s?.title||'').trim())e.push('title')
 if(!String(s?.hook||'').trim())e.push('hook')
 const beats=Array.isArray(s?.beats)?s.beats:[]
 if(beats.length<4||beats.length>12)e.push('beats.count')
 for(const [i,b] of beats.entries()){
  const narration=String(b?.narration||'').trim()
  if(!narration)e.push(`beats[${i}].narration`)
  if(narration.length>WISDOM_PROFILE.narration.maxCharsPerBeat)e.push(`beats[${i}].narration.too_long`)
  if(!String(b?.visualGoal||'').trim())e.push(`beats[${i}].visualGoal`)
  if(!String(b?.imagePrompt||'').trim())e.push(`beats[${i}].imagePrompt`)
  const d=Number(b?.durationSec); if(!Number.isFinite(d)||d<3||d>12)e.push(`beats[${i}].durationSec`)
 }
 const total=beats.reduce((n:any,b:any)=>n+Number(b.durationSec||0),0)
 if(total<35||total>75)e.push('totalSeconds')
 if(Math.abs(total-Number(s?.totalSeconds||0))>.1)e.push('totalSeconds.mismatch')
 if(Math.abs(total-brief.targetSeconds)>Math.max(5,brief.targetSeconds*.15))e.push('targetSeconds.mismatch')
 if(brief.profile!=='wisdom')e.push('profile')
 e.push(...namedThinkerVisualErrors(String(brief.text||''),s))
 return e
}
export function deterministicWisdomDraft(brief:GenerativeBrief): WisdomScript {
 const source=brief.text
 const ideas=source.split(/(?<=[.!?。！？])\s+|\s*[·•]\s*/).map(x=>x.trim()).filter(Boolean)
 const base=ideas.length?ideas:[source]
 const minBeats=Math.max(4,Math.ceil(brief.targetSeconds/12))
 const count=Math.min(8,Math.max(minBeats,Math.min(8,base.length)))
 const duration=Math.max(3,Math.min(12,brief.targetSeconds/count))
 const beats=Array.from({length:count},(_,i)=>{const idea=base[i%base.length];return {id:`b${i+1}`,narration:idea,visualGoal:`시청자가 “${idea.slice(0,60)}”의 의미를 즉시 이해`,imagePrompt:`vertical 9:16 editorial illustration, calm reflective wisdom theme, visually express: ${idea.slice(0,180)}, no readable text, no watermark`,durationSec:Number(duration.toFixed(2))}})
 const total=Number(beats.reduce((n,b)=>n+b.durationSec,0).toFixed(2))
 return {schema:'wisdom-script/1',title:source.slice(0,40),hook:beats[0].narration,beats,ending:beats[beats.length-1].narration,totalSeconds:total}
}
