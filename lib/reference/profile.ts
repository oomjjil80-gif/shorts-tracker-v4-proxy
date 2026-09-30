import { stableHash, toReferenceProfile, validateReferenceProfile, type ProductionBrief, type ReferenceAnalysis, type ReferenceProfile } from './contracts.js'
export type ProfileBundle={profile:ReferenceProfile;profileHash:string;brief:ProductionBrief}
export function buildReferenceProductionBrief(input:{profile:string;sourceAssetId:string;analyses:ReferenceAnalysis[]}):ProfileBundle{
 const profile=toReferenceProfile(input.analyses);const errors=validateReferenceProfile(profile);if(errors.length)throw new Error('invalid reference profile: '+errors.join(','))
 return {profile,profileHash:stableHash(profile),brief:{schema:'production-brief/1',profile:input.profile,sourceAssetId:input.sourceAssetId,referenceProfile:profile}}
}
export function planReferenceConstraints(brief:ProductionBrief){return (brief.referenceProfile?.constraints||[]).filter(x=>x.appliesTo.includes('PLAN'))}
export function renderReferenceConstraints(brief:ProductionBrief){return (brief.referenceProfile?.constraints||[]).filter(x=>x.appliesTo.includes('RENDER'))}
export function qcReferenceConstraints(brief:ProductionBrief){return (brief.referenceProfile?.constraints||[]).filter(x=>x.appliesTo.includes('QC'))}
