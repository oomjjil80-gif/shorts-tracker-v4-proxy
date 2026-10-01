import { createHash } from 'node:crypto'

export const REFERENCE_SCHEMA_VERSION = 1 as const
export const REFERENCE_ANALYZER_VERSION = 'reference-analyzer/2' as const

export type ReferenceKind = 'video' | 'image' | 'screenshot'
export type ReferenceUse = 'PLAN' | 'RENDER' | 'QC'
export type ReferenceEvidence =
  | { kind: 'time'; start: number; end: number; note?: string }
  | { kind: 'region'; x: number; y: number; width: number; height: number; frameTime?: number; note?: string }

export type ReferenceAsset = {
  schema: 'reference-asset/1'; referenceAssetId: string; kind: ReferenceKind
  sha256: string; bytes: number; contentType: string; blobPath: string
  width?: number; height?: number; duration?: number; originalUrl?: string | null
  createdAt: string
}

export const REFERENCE_AXES = ['story','retention','editing','visualStyle','composition','caption','sound','narration'] as const
export type ReferenceAxis = typeof REFERENCE_AXES[number]
export type ReferenceFeature = {
  id: string; axis: ReferenceAxis; value: unknown; evidence: ReferenceEvidence[]
  appliesTo: ReferenceUse[]
}
export type ReferenceAnalysis = {
  schema: 'reference-analysis/1'; analyzerVersion: typeof REFERENCE_ANALYZER_VERSION
  referenceAssetId: string; referenceSha256: string; features: ReferenceFeature[]
}
export type ReferenceProfile = {
  schema: 'reference-profile/1'; profileVersion: 1; referenceAssetIds: string[]
  sourceAnalysisHashes: string[]; constraints: ReferenceFeature[]
}
export type ProductionBrief = {
  schema: 'production-brief/1'; profile: string; sourceAssetId: string
  referenceProfile?: ReferenceProfile | null
}
export type ConformanceCheck = {
  featureId: string; axis: ReferenceAxis; appliesTo: ReferenceUse[]
  status: 'PASS'|'FAIL'|'UNKNOWN'; evidence: unknown
}
export type ConformanceReport = {
  schema: 'reference-conformance/1'; profileHash: string; checks: ConformanceCheck[]
  decision: 'PASS'|'BLOCK'
}

const SHA = /^[a-f0-9]{64}$/
const REF_ID = /^ref_[a-f0-9]{64}$/
export function referenceAssetId(sha256: string) {
  if (!SHA.test(sha256)) throw new Error('invalid reference sha256')
  return `ref_${sha256}`
}
export function stableHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const o = value as Record<string, unknown>
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k)+':'+canonicalJson(o[k])).join(',') + '}'
}
export function analysisCacheKey(asset: Pick<ReferenceAsset,'sha256'>, analyzerVersion = REFERENCE_ANALYZER_VERSION) {
  if (!SHA.test(asset.sha256)) throw new Error('invalid reference sha256')
  return `reference-analysis/v1/${analyzerVersion.replaceAll('/','_')}/${asset.sha256}.json`
}
function evidenceOk(e: ReferenceEvidence, kind: ReferenceKind) {
  if (e.kind === 'time') return kind === 'video' && Number.isFinite(e.start) && Number.isFinite(e.end) && e.start >= 0 && e.end > e.start
  return [e.x,e.y,e.width,e.height].every(Number.isFinite) && e.x >= 0 && e.y >= 0 && e.width > 0 && e.height > 0
}
export function validateReferenceAsset(a: ReferenceAsset) {
  const errors:string[]=[]
  if (a.schema !== 'reference-asset/1') errors.push('schema')
  if (!REF_ID.test(a.referenceAssetId)) errors.push('referenceAssetId')
  if (!SHA.test(a.sha256)) errors.push('sha256')
  if (!['video','image','screenshot'].includes(a.kind)) errors.push('kind')
  if (!(a.bytes > 0)) errors.push('bytes')
  if (!a.contentType || !a.blobPath) errors.push('storage')
  if (a.kind === 'video' && !(Number(a.duration) > 0)) errors.push('duration')
  if (a.kind !== 'video' && (!(Number(a.width)>0) || !(Number(a.height)>0))) errors.push('dimensions')
  return errors
}
export function validateReferenceAnalysis(a: ReferenceAnalysis, asset?: ReferenceAsset) {
  const errors:string[]=[]
  if (a.schema !== 'reference-analysis/1' || a.analyzerVersion !== REFERENCE_ANALYZER_VERSION) errors.push('version')
  if (!SHA.test(a.referenceSha256)) errors.push('referenceSha256')
  if (asset && (a.referenceAssetId !== asset.referenceAssetId || a.referenceSha256 !== asset.sha256)) errors.push('assetMismatch')
  const ids=new Set<string>()
  for(const f of a.features||[]) {
    if (!f.id || ids.has(f.id)) errors.push('featureId'); ids.add(f.id)
    if (!REFERENCE_AXES.includes(f.axis)) errors.push(`axis:${f.id}`)
    if (!f.appliesTo?.length || f.appliesTo.some(x=>!['PLAN','RENDER','QC'].includes(x))) errors.push(`appliesTo:${f.id}`)
    if (!f.evidence?.length || (asset && f.evidence.some(e=>!evidenceOk(e,asset.kind)))) errors.push(`evidence:${f.id}`)
  }
  return errors
}
export function toReferenceProfile(analyses: ReferenceAnalysis[]): ReferenceProfile {
  if (!analyses.length) throw new Error('at least one reference analysis required')
  const ids=analyses.map(x=>x.referenceAssetId)
  if(new Set(ids).size!==ids.length) throw new Error('duplicate reference analysis')
  const ordered=[...analyses].sort((a,b)=>a.referenceAssetId.localeCompare(b.referenceAssetId))
  const applicable=(f:ReferenceFeature)=>String((f.value as any)?.status||'measured')!=='not_applicable'
  const raw=ordered.flatMap(x=>x.features.filter(applicable).map(f=>({...f,id:`${x.referenceAssetId}:${f.id}`})))
  const median=(v:number[])=>{const a=[...v].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
  const rawFeatureId=(id:string)=>{const m=/^ref_[a-f0-9]{64}:(.+)$/.exec(id);return m?m[1]:id}
  const aggregateIds=new Set(['story.opening','retention.peak','editing.cadence'])
  const canonicalPresent=new Set(raw.map(x=>rawFeatureId(x.id)).filter(id=>['story.opening','retention.peak','editing.cadence'].includes(id)))
  const constraints:ReferenceFeature[]=[]
  for(const f of raw.filter(x=>!aggregateIds.has(rawFeatureId(x.id))&&!['p','ret','edit'].includes(rawFeatureId(x.id))))constraints.push(f)
  for(const rawId of aggregateIds){
    const featureId=rawId
    const aliases=featureId==='story.opening'?['story.opening','p']:featureId==='retention.peak'?['retention.peak','ret']:featureId==='editing.cadence'?['editing.cadence','edit']:[featureId];const xs=raw.filter(x=>aliases.includes(rawFeatureId(x.id))||aliases.includes(x.id));if(!xs.length)continue
    const failed=xs.filter(x=>String((x.value as any)?.status||'measured')!=='measured')
    if(failed.length){constraints.push({id:`aggregate:${featureId}`,axis:xs[0].axis,value:{status:'unknown',reason:'one or more applicable reference measurements are unknown',failed:failed.map(x=>x.id)},evidence:xs.flatMap(x=>x.evidence),appliesTo:[...new Set(xs.flatMap(x=>x.appliesTo))] as ReferenceUse[]});continue}
    let value:any=null
    if(featureId==='editing.cadence'){const v=xs.map(x=>Number((x.value as any)?.meanSceneSeconds)).filter(Number.isFinite);if(v.length)value={meanSceneSeconds:Number(median(v).toFixed(3)),status:'measured',aggregation:'median'}}
    if(featureId==='story.opening'){const v=xs.map(x=>Number((x.value as any)?.openingSeconds)).filter(x=>Number.isFinite(x)&&x>0);if(v.length)value={openingSeconds:Number(median(v).toFixed(3)),status:'measured',aggregation:'median'}}
    if(featureId==='retention.peak'){const v=xs.map(x=>{const z:any=x.value,p=z?.firstPeak,d=Number(z?.duration);return p&&d>0?((Number(p.start)+Number(p.end))/2)/d:NaN}).filter(Number.isFinite);if(v.length)value={firstPeakNormalized:Number(median(v).toFixed(4)),status:'measured',aggregation:'median'}}
    if(value)constraints.push({id:`aggregate:${featureId}`,axis:xs[0].axis,value,evidence:xs.flatMap(x=>x.evidence),appliesTo:[...new Set(xs.flatMap(x=>x.appliesTo))] as ReferenceUse[]})
  }
  return {schema:'reference-profile/1',profileVersion:1,referenceAssetIds:ordered.map(x=>x.referenceAssetId),sourceAnalysisHashes:ordered.map(stableHash),constraints}
}
export function validateReferenceProfile(p: ReferenceProfile | null | undefined) {
  const errors:string[]=[]
  if (!p || typeof p !== 'object') return ['profile']
  if (p.schema!=='reference-profile/1'||p.profileVersion!==1) errors.push('version')
  if (!p.referenceAssetIds?.length || p.referenceAssetIds.length!==p.sourceAnalysisHashes?.length) errors.push('sources')
  if (p.referenceAssetIds?.length && new Set(p.referenceAssetIds).size!==p.referenceAssetIds.length) errors.push('duplicateSources')
  if (!Array.isArray(p.constraints) || !p.constraints.length) errors.push('constraints')
  const axes=new Set<ReferenceAxis>()
  const ids=new Set<string>()
  for(const f of p.constraints||[]) {
    if(!f?.id || ids.has(f.id)) errors.push('constraintId'); else ids.add(f.id)
    if(!REFERENCE_AXES.includes(f?.axis as ReferenceAxis)) errors.push(`axis:${f?.id||'?'}`); else axes.add(f.axis)
    if(!f?.appliesTo?.length || f.appliesTo.some(x=>!['PLAN','RENDER','QC'].includes(x))) errors.push(`appliesTo:${f?.id||'?'}`)
    if(!f?.evidence?.length) errors.push(`evidence:${f?.id||'?'}`)
  }
  // A profile may mix video and still references. Axes that no supplied reference can measure are absent by design;
  // Intrinsically not-applicable features are omitted; UNKNOWN applicable measurements remain constraints and therefore BLOCK conformance.
  return errors
}
export function conformanceReport(profile: ReferenceProfile, checks: ConformanceCheck[]): ConformanceReport {
  const expected = new Set(profile.constraints.map(x=>x.id))
  const seen = new Set(checks.map(x=>x.featureId))
  const missing=[...expected].filter(x=>!seen.has(x))
  const normalized=[...checks,...missing.map(featureId=>({featureId,axis:profile.constraints.find(x=>x.id===featureId)!.axis,appliesTo:profile.constraints.find(x=>x.id===featureId)!.appliesTo,status:'UNKNOWN' as const,evidence:{reason:'not evaluated'}}))]
  return {schema:'reference-conformance/1',profileHash:stableHash(profile),checks:normalized,decision:normalized.length>0&&normalized.every(x=>x.status==='PASS')?'PASS':'BLOCK'}
}
