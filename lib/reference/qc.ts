import { conformanceReport, type ConformanceCheck, type ReferenceProfile } from './contracts.js'
export function evaluateReferenceConformance(profile:ReferenceProfile,input:{planReference?:{applied?:string[];unknown?:string[]}|null;renderEvidence?:Record<string,unknown>}){
 const applied=new Set(input.planReference?.applied||[]),unknown=new Set(input.planReference?.unknown||[])
 const checks:ConformanceCheck[]=profile.constraints.map(f=>{
  if(f.appliesTo.includes('PLAN')){
   if(applied.has(f.id))return {featureId:f.id,axis:f.axis,appliesTo:f.appliesTo,status:'PASS',evidence:{stage:'PLAN',consumed:true}}
   if(unknown.has(f.id))return {featureId:f.id,axis:f.axis,appliesTo:f.appliesTo,status:'UNKNOWN',evidence:{stage:'PLAN',reason:'constraint could not be measured/applied'}}
  }
  const e=input.renderEvidence?.[f.id]
  return e!==undefined?{featureId:f.id,axis:f.axis,appliesTo:f.appliesTo,status:'PASS',evidence:{stage:'RENDER',value:e}}:{featureId:f.id,axis:f.axis,appliesTo:f.appliesTo,status:'UNKNOWN',evidence:{reason:'no independent conformance measurement'}}
 })
 return conformanceReport(profile,checks)
}
