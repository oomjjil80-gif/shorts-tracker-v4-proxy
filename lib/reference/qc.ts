import { conformanceReport, type ConformanceCheck, type ReferenceProfile } from './contracts.js'

export type ReferenceMeasurement={measured:true;pass:boolean;target:unknown;actual:unknown;tolerance?:unknown;method:string}
function isMeasurement(v:unknown):v is ReferenceMeasurement{
 const x=v as any;return !!x&&x.measured===true&&typeof x.pass==='boolean'&&'target' in x&&'actual' in x&&typeof x.method==='string'&&x.method.length>0
}
export function evaluateReferenceConformance(profile:ReferenceProfile,input:{planReference?:{applied?:string[];unknown?:string[]}|null;measurements?:Record<string,unknown>;renderEvidence?:Record<string,unknown>}){
 const applied=new Set(input.planReference?.applied||[]),unknown=new Set(input.planReference?.unknown||[])
 const measurements={...(input.renderEvidence||{}),...(input.measurements||{})}
 const checks:ConformanceCheck[]=profile.constraints.map(f=>{
  const m=measurements[f.id]
  if(isMeasurement(m)) return {featureId:f.id,axis:f.axis,appliesTo:f.appliesTo,status:m.pass?'PASS':'FAIL',evidence:m}
  const reason=unknown.has(f.id)?'constraint could not be measured/applied':applied.has(f.id)?'constraint was consumed by PLAN but output conformance was not independently measured':'no independent target-vs-output measurement'
  return {featureId:f.id,axis:f.axis,appliesTo:f.appliesTo,status:'UNKNOWN',evidence:{reason}}
 })
 return conformanceReport(profile,checks)
}
