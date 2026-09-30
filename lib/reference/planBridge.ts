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
 const baseId=(c:ReferenceFeature)=>c.id.includes(':')?c.id.slice(c.id.lastIndexOf(':')+1):c.id
 const cadence=plan.filter(c=>baseId(c)==='editing.cadence'),cadenceValues=cadence.map(c=>Number((c.value as any)?.meanSceneSeconds)).filter(x=>x>=0.8).sort((a,b)=>a-b)
 if(cadence.length){
  if(cadenceValues.length){
   const mid=Math.floor(cadenceValues.length/2),target=cadenceValues.length%2?cadenceValues[mid]:(cadenceValues[mid-1]+cadenceValues[mid])/2
   let changed=false
   for(const variant of variants){const before=variant.beats.map(x=>({...x}));const next=splitForCadence(before,target);if(next.length<=12&&JSON.stringify(next)!==JSON.stringify(before)){variant.beats=next;changed=true;changes.push({constraintId:'aggregate:editing.cadence',variantId:variant.id,beforeBeats:before.length,afterBeats:next.length,beforeFirstSeconds:r2(len(before[0])),afterFirstSeconds:r2(len(next[0]))})}}
   if(changed){for(const c of cadence)applied.push(c.id);notes.push(`reference cadence aggregate median=${target.toFixed(2)}s applied once across ${cadenceValues.length} measured reference(s)`)}else for(const c of cadence)unknown.push(c.id)
  }else for(const c of cadence)unknown.push(c.id)
 }
 for(const c of plan.filter(c=>baseId(c)!=='editing.cadence')){
  const id=baseId(c),v=c.value as any
  if(id==='story.opening'){
   const opening=Number(v?.openingSeconds)
   if(opening>=0.8){
    let changed=false
    for(const variant of variants){const before=variant.beats.map(x=>({...x}));const next=splitOpening(before,opening);if(next.length<=12&&JSON.stringify(next)!==JSON.stringify(before)){variant.beats=next;changed=true;changes.push({constraintId:c.id,variantId:variant.id,beforeBeats:before.length,afterBeats:next.length,beforeFirstSeconds:r2(len(before[0])),afterFirstSeconds:r2(len(next[0]))})}}
    if(changed){applied.push(c.id);notes.push(`reference opening window=${opening.toFixed(2)}s applied as a boundary inside the existing first causal beat`)}else unknown.push(c.id)
   }else unknown.push(c.id)
  }else if(id==='retention.peak'){unknown.push(c.id);notes.push('reference retention peak retained for QC only until PLAN performs an independently verifiable selection change')
  }else if(id==='sound.structure'||id==='narration.structure'){unknown.push(c.id);notes.push(`${c.id} retained for downstream measurement; PLAN does not claim application without a real audio/narration edit`)
  }else unknown.push(c.id)
 }
 applied.sort();unknown.sort()
 if(variants[0])variants[0].rationale+=applied.length?`; reference-conditioned: ${applied.join(', ')}`:''
 return {constraints:plan,applied,unknown,notes,changes}
}
