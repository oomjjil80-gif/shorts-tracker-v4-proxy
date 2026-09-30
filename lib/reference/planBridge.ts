import type { VariantSpec, Beat } from '../media/plan.js'
import type { ReferenceFeature } from './contracts.js'

export type PlanReferenceApplication={constraints:ReferenceFeature[];applied:string[];unknown:string[];notes:string[];changes:Array<{constraintId:string;variantId:string;beforeBeats:number;afterBeats:number;beforeFirstSeconds:number;afterFirstSeconds:number}>}
const r2=(n:number)=>Math.round(n*100)/100
const len=(b:Beat)=>b.trimEnd-b.trimStart

function splitForCadence(beats:Beat[],target:number):Beat[]{
 if(!(target>=0.8))return beats
 const out:Beat[]=[]
 for(const b of beats){
  const duration=len(b),parts=Math.max(1,Math.ceil(duration/target))
  if(parts===1){out.push({...b});continue}
  const step=duration/parts
  for(let i=0;i<parts;i++){const start=r2(b.trimStart+i*step),end=i===parts-1?b.trimEnd:r2(b.trimStart+(i+1)*step);if(end-start>=0.8)out.push({...b,label:`${b.label}.${i+1}`,trimStart:start,trimEnd:end});else if(out.length)out[out.length-1].trimEnd=b.trimEnd}
 }
 return out
}
function splitOpening(beats:Beat[],opening:number):Beat[]{
 if(!(opening>=0.8)||!beats.length)return beats
 const first=beats[0],duration=len(first)
 if(opening>=duration-0.05||duration-opening<0.8)return beats
 return [{...first,label:`${first.label}.opening`,trimEnd:r2(first.trimStart+opening)},{...first,label:`${first.label}.rest`,trimStart:r2(first.trimStart+opening)},...beats.slice(1)]
}
export function applyReferencePlanConstraints(variants:VariantSpec[], constraints:ReferenceFeature[]):PlanReferenceApplication{
 const plan=constraints.filter(x=>x.appliesTo.includes('PLAN')),applied:string[]=[],unknown:string[]=[],notes:string[]=[],changes:PlanReferenceApplication['changes']=[]
 for(const c of plan){
  const baseId=c.id.includes(':')?c.id.slice(c.id.lastIndexOf(':')+1):c.id,v=c.value as any
  if(baseId==='editing.cadence'){
   const target=Number(v?.meanSceneSeconds)
   if(target>=0.8){
    for(const variant of variants){const before=variant.beats.map(x=>({...x}));const next=splitForCadence(before,target);if(next.length<=12){variant.beats=next;changes.push({constraintId:c.id,variantId:variant.id,beforeBeats:before.length,afterBeats:next.length,beforeFirstSeconds:r2(len(before[0])),afterFirstSeconds:r2(len(next[0]))})}}
    applied.push(c.id);notes.push(`reference cadence target=${target.toFixed(2)}s applied by splitting existing causal/source beats only`)
   }else unknown.push(c.id)
  }else if(baseId==='story.opening'){
   const opening=Number(v?.openingSeconds)
   if(opening>=0.8){
    for(const variant of variants){const before=variant.beats.map(x=>({...x}));const next=splitOpening(before,opening);if(next.length<=12){variant.beats=next;changes.push({constraintId:c.id,variantId:variant.id,beforeBeats:before.length,afterBeats:next.length,beforeFirstSeconds:r2(len(before[0])),afterFirstSeconds:r2(len(next[0]))})}}
    applied.push(c.id);notes.push(`reference opening window=${opening.toFixed(2)}s applied as a boundary inside the existing first causal beat`)
   }else unknown.push(c.id)
  }else if(baseId==='retention.peak'){
   if(v?.firstPeak){applied.push(c.id);notes.push('reference retention peak recorded for variant selection/QC; no unsupported source-time transplant')}else unknown.push(c.id)
  }else if(baseId==='sound.structure'||baseId==='narration.structure'){
   applied.push(c.id);notes.push(`${c.id} recorded as production constraint; PLAN does not fabricate audio/narration edits`)
  }else unknown.push(c.id)
 }
 if(variants[0])variants[0].rationale+=applied.length?`; reference-conditioned: ${applied.join(', ')}`:''
 return {constraints:plan,applied,unknown,notes,changes}
}
