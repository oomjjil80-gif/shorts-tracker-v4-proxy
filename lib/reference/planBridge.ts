import type { VariantSpec } from '../media/plan.js'
import type { ReferenceFeature } from './contracts.js'

export type PlanReferenceApplication={constraints:ReferenceFeature[];applied:string[];unknown:string[];notes:string[]}

export function applyReferencePlanConstraints(variants:VariantSpec[], constraints:ReferenceFeature[]):PlanReferenceApplication{
 const plan=constraints.filter(x=>x.appliesTo.includes('PLAN')),applied:string[]=[],unknown:string[]=[],notes:string[]=[]
 for(const c of plan){
  if(c.id==='editing.cadence'){
   const v=c.value as any
   if(Number(v?.meanSceneSeconds)>0){applied.push(c.id);notes.push(`reference cadence target=${Number(v.meanSceneSeconds).toFixed(2)}s; existing causal/source beat boundaries preserved`)}
   else unknown.push(c.id)
  }else if(c.id==='story.opening'){
   const v=c.value as any
   if(Number(v?.openingSeconds)>0){applied.push(c.id);notes.push(`reference opening window=${Number(v.openingSeconds).toFixed(2)}s; semantic causalStart remains authoritative`)}
   else unknown.push(c.id)
  }else if(c.id==='retention.peak'){
   const v=c.value as any
   if(v?.firstPeak){applied.push(c.id);notes.push('reference retention peak recorded for variant selection/QC; no unsupported source-time transplant')}
   else unknown.push(c.id)
  }else if(c.id==='sound.structure'||c.id==='narration.structure'){
   applied.push(c.id);notes.push(`${c.id} recorded as production constraint; PLAN does not fabricate audio/narration edits`)
  }else unknown.push(c.id)
 }
 // v1 causal recommendation stays first; reference conditioning must not override validated source story.
 if(variants[0]) variants[0].rationale += applied.length?`; reference-conditioned: ${applied.join(', ')}`:''
 return {constraints:plan,applied,unknown,notes}
}
