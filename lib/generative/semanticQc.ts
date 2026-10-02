import type { WisdomScript } from './wisdom.js'

export type WisdomSemanticQc={schema:'wisdom-semantic-qc/1',topicFaithfulness:boolean,hook:boolean,progression:boolean,turn:boolean,ending:boolean,nonRepetitive:boolean,reasons:string[]}

const particles=/(은|는|이|가|을|를|의|에|에서|에게|으로|로|와|과|도|만|부터|까지|보다|처럼|마다|하고|하며|하면|하는|해야|이다|입니다|한다|말하는|말한|말하다|정말|이유)$/
const stem=(x:string)=>x.replace(particles,'').replace(/(들수록|수록)$/,'').trim()
const tokens=(s:string)=>new Set(String(s||'').replace(/[^가-힣a-zA-Z0-9 ]/g,' ').split(/\s+/).map(stem).filter(x=>x.length>=2))
export function evaluateWisdomSemanticQc(input:string,script:WisdomScript):WisdomSemanticQc{
 const src=tokens(input), body=script.beats.map(b=>b.narration).join(' '), out=tokens(body)
 const overlap=[...src].filter(x=>out.has(x)).length/Math.max(1,Math.min(src.size,8))
 const narr=script.beats.map(b=>b.narration.trim())
 const unique=new Set(narr).size===narr.length
 const hook=script.hook.trim().length>=4 && (narr[0]?.length??0)>=4
 const progression=narr.length>=4 && new Set(narr.map(x=>x.slice(0,12))).size>=Math.ceil(narr.length*.75)
 const turn=narr.slice(1,-1).some(x=>/(하지만|그런데|오히려|대신|그러나|중요한 건|사실은|문제는)/.test(x))
 const ending=script.ending.trim().length>=4 && (narr.at(-1)?.length??0)>=4
 const titleOut=tokens(script.title+' '+script.hook+' '+script.ending)
 const titleOverlap=[...src].filter(x=>titleOut.has(x)).length/Math.max(1,Math.min(src.size,8))
 const topicFaithfulness=Math.max(overlap,titleOverlap)>=0.25
 const reasons:string[]=[];for(const [k,v] of Object.entries({topicFaithfulness,hook,progression,turn,ending,nonRepetitive:unique}))if(!v)reasons.push(k)
 return {schema:'wisdom-semantic-qc/1',topicFaithfulness,hook,progression,turn,ending,nonRepetitive:unique,reasons}
}
