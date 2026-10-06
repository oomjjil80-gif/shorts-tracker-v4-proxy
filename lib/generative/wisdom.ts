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
export const thinkerFor=(topic:string)=>namedThinkers.find(t=>t.re.test(String(topic||'')))
export function lockNamedThinkerAcrossBeats(s:WisdomScript,topic:string):WisdomScript{
 const t=thinkerFor(topic); if(!t)return s
 const identity=`Identity LOCK: every depiction of ${t.name} must be the SAME person as the first portrait — identical face shape, hairline, sideburns/beard/moustache, apparent age and clothing; do not redesign or reinterpret his face between scenes. Canonical identity: ${t.likeness}.`
 return {...s,beats:s.beats.map((b,i)=>{
  const scene=beatScene(b.imagePrompt), mentions=t.aliases.some(a=>scene.toLowerCase().includes(a))
  if(i!==0&&!mentions)return b
  return {...b,imagePrompt:`${b.imagePrompt} ${identity}`}
 })}
}
// applyVisualBible() wraps every beat as "... Character policy: <bible>. Scene goal: <goal>. Scene: <scene>. Avoid: ...".
// Only the beat's own scene says what is drawn; bible text is shared by all beats and a goal can merely mention a name.
export const beatScene=(imagePrompt:unknown)=>{const p=String(imagePrompt||''),i=p.lastIndexOf('. Scene: '),j=p.lastIndexOf('. Avoid: ');return i>=0&&j>i?p.slice(i+9,j):p}

export function lockWisdomProtagonistAcrossBeats(s:WisdomScript,topic:string):WisdomScript{
 const thinker=thinkerFor(topic)
 const identity='Recurring protagonist LOCK: when an unnamed everyday protagonist appears, depict the SAME Korean adult in every such scene — early 40s, oval face, short neat dark hair, calm dark eyes, charcoal coat over a plain light shirt; identical face, apparent age, hair and clothing across scenes. Do not redesign this recurring protagonist. The protagonist does NOT need to appear in every scene. Vary camera distance, setting, body language, supporting characters, and composition across adjacent scenes; avoid repeated portrait framing.'
 return {...s,beats:s.beats.map(b=>{const scene=beatScene(b.imagePrompt).toLowerCase();const named=thinker?.aliases.some(a=>scene.includes(a))??false;return named?b:{...b,imagePrompt:`${b.imagePrompt} ${identity}`}})}
}

// Mobile-readable Wisdom captions: short phrases (one line at the Wisdom caption size, two at most), each on screen long
// enough to read. NOTE the regex is whitespace (/\s+/); a former /\\s+/ matched a literal backslash, so every narration
// stayed ONE caption and the renderer shrank it to the minimum size.
export const WISDOM_CAPTION={maxChars:14,minSec:1.2}
// n phrases of roughly equal length (word boundaries only): no dangling one-word tail that would flash by.
function balancedChunks(words:string[],n:number):string[]{
 const len=(a:string[])=>a.join(' ').length,out:string[]=[];let rest=words
 for(let k=n;k>1;k--){
  const target=len(rest)/k;let cut=1
  while(cut<rest.length-(k-1)&&Math.abs(len(rest.slice(0,cut+1))-target)<=Math.abs(len(rest.slice(0,cut))-target))cut++
  out.push(rest.slice(0,cut).join(' '));rest=rest.slice(cut)
 }
 out.push(rest.join(' '));return out.filter(Boolean)
}
const wordsOf=(text:string)=>String(text||'').trim().split(/\s+/).filter(Boolean)
export function wisdomCaptionChunks(text:string,maxChars=WISDOM_CAPTION.maxChars):string[]{
 const words=wordsOf(text);if(!words.length)return[]
 for(let n=Math.max(1,Math.ceil(words.join(' ').length/maxChars));n<words.length;n++){const c=balancedChunks(words,n);if(c.every(x=>x.length<=maxChars))return c}
 return words
}
// Timed caption events for one narrated beat [start,end]: fewer, longer phrases until each stays >= minSec on screen; the
// beat span is shared by phrase length (narration speed is roughly constant per character), so captions follow the voice.
export function wisdomCaptionEvents(text:string,start:number,end:number):Array<{start:number;end:number;text:string}>{
 const span=Math.max(0,end-start),words=wordsOf(text);let chunks=wisdomCaptionChunks(text)
 const shortest=(c:string[])=>span*Math.min(...c.map(x=>x.length))/(c.reduce((s,x)=>s+x.length,0)||1)
 while(chunks.length>1&&shortest(chunks)<WISDOM_CAPTION.minSec)chunks=balancedChunks(words,chunks.length-1)
 const total=chunks.reduce((s,c)=>s+c.length,0)||1;let acc=0
 return chunks.map((c,j)=>{const s=start+span*acc/total;acc+=c.length;const e=j===chunks.length-1?end:start+span*acc/total;return {start:Number(s.toFixed(2)),end:Number(e.toFixed(2)),text:c}})
}
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
 const anchored={...s,beats:[{...b,imagePrompt},...s.beats.slice(1)]}
 return {script:lockWisdomProtagonistAcrossBeats(lockNamedThinkerAcrossBeats(anchored,topic),topic),anchoredBeatId:b.id}
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
 const narrationChars=beats.reduce((n:any,b:any)=>n+String(b?.narration||'').length,0)
 const narrationCeiling=Math.round(brief.targetSeconds*5.2)
 if(narrationChars>narrationCeiling)e.push('narration.total_too_long')
 if(total<35||total>75)e.push('totalSeconds')
 if(Math.abs(total-Number(s?.totalSeconds||0))>.1)e.push('totalSeconds.mismatch')
 if(Math.abs(total-brief.targetSeconds)>Math.max(5,brief.targetSeconds*.1))e.push('targetSeconds.mismatch')
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
