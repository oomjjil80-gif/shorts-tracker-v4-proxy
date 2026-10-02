import type { GenerativeBrief } from './contracts.js'
export type WisdomBeat={id:string,narration:string,visualGoal:string,imagePrompt:string,durationSec:number}
export type WisdomScript={schema:'wisdom-script/1',title:string,hook:string,beats:WisdomBeat[],ending:string,totalSeconds:number}
export function validateWisdomScript(s:any, brief:GenerativeBrief): string[] {
 const e:string[]=[]
 if(s?.schema!=='wisdom-script/1')e.push('schema')
 if(!String(s?.title||'').trim())e.push('title')
 if(!String(s?.hook||'').trim())e.push('hook')
 const beats=Array.isArray(s?.beats)?s.beats:[]
 if(beats.length<4||beats.length>12)e.push('beats.count')
 for(const [i,b] of beats.entries()){
  if(!String(b?.narration||'').trim())e.push(`beats[${i}].narration`)
  if(!String(b?.visualGoal||'').trim())e.push(`beats[${i}].visualGoal`)
  if(!String(b?.imagePrompt||'').trim())e.push(`beats[${i}].imagePrompt`)
  const d=Number(b?.durationSec); if(!Number.isFinite(d)||d<3||d>12)e.push(`beats[${i}].durationSec`)
 }
 const total=beats.reduce((n:any,b:any)=>n+Number(b.durationSec||0),0)
 if(total<35||total>75)e.push('totalSeconds')
 if(Math.abs(total-Number(s?.totalSeconds||0))>.1)e.push('totalSeconds.mismatch')
 if(brief.profile!=='wisdom')e.push('profile')
 return e
}
export function deterministicWisdomDraft(brief:GenerativeBrief): WisdomScript {
 const source=brief.text
 const ideas=source.split(/(?<=[.!?。！？])\s+|\s*[·•]\s*/).map(x=>x.trim()).filter(Boolean)
 const base=ideas.length?ideas:[source]
 const count=Math.max(4,Math.min(8,base.length))
 const duration=Math.max(5,Math.min(10,brief.targetSeconds/count))
 const beats=Array.from({length:count},(_,i)=>{const idea=base[i%base.length];return {id:`b${i+1}`,narration:idea,visualGoal:`시청자가 “${idea.slice(0,60)}”의 의미를 즉시 이해`,imagePrompt:`vertical 9:16 editorial illustration, calm reflective wisdom theme, visually express: ${idea.slice(0,180)}, no readable text, no watermark`,durationSec:Number(duration.toFixed(2))}})
 const total=Number(beats.reduce((n,b)=>n+b.durationSec,0).toFixed(2))
 return {schema:'wisdom-script/1',title:source.slice(0,40),hook:beats[0].narration,beats,ending:beats[beats.length-1].narration,totalSeconds:total}
}
