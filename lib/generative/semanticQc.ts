import type { WisdomScript } from './wisdom.js'

export type WisdomSemanticQc={schema:'wisdom-semantic-qc/1',topicFaithfulness:boolean,hook:boolean,progression:boolean,turn:boolean,ending:boolean,nonRepetitive:boolean,reasons:string[]}

const tokens=(s:string)=>new Set(String(s||'').replace(/[^가-힣a-zA-Z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>=2))
export function evaluateWisdomSemanticQc(input:string,script:WisdomScript):WisdomSemanticQc{
 const src=tokens(input), body=script.beats.map(b=>b.narration).join(' '), out=tokens(body)
 const overlap=[...src].filter(x=>out.has(x)).length/Math.max(1,Math.min(src.size,8))
 const narr=script.beats.map(b=>b.narration.trim())
 const unique=new Set(narr).size===narr.length
 const hook=script.hook.trim().length>=4 && (narr[0]?.length??0)>=4
 const progression=narr.length>=4 && new Set(narr.map(x=>x.slice(0,12))).size>=Math.ceil(narr.length*.75)
 const turn=narr.slice(1,-1).some(x=>/(하지만|그런데|오히려|대신|그러나|중요한 건|사실은|문제는)/.test(x))
 const ending=script.ending.trim().length>=4 && (narr.at(-1)?.length??0)>=4
 const topicFaithfulness=overlap>=0.25
 const reasons:string[]=[];for(const [k,v] of Object.entries({topicFaithfulness,hook,progression,turn,ending,nonRepetitive:unique}))if(!v)reasons.push(k)
 return {schema:'wisdom-semantic-qc/1',topicFaithfulness,hook,progression,turn,ending,nonRepetitive:unique,reasons}
}
