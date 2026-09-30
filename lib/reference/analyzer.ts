import { REFERENCE_ANALYZER_VERSION, REFERENCE_AXES, stableHash, validateReferenceAnalysis, type ReferenceAnalysis, type ReferenceAsset, type ReferenceEvidence, type ReferenceFeature } from './contracts.js'

export type ReferenceSignals={duration?:number;sceneRanges?:Array<{start:number;end:number}>;highlights?:Array<{start:number;end:number;score?:number}>;silentRanges?:Array<{start:number;end:number}>;hasAudio?:boolean;width?:number;height?:number;captionRegions?:Array<{x:number;y:number;width:number;height:number;frameTime?:number}>;narrationRanges?:Array<{start:number;end:number}>}
const whole=(a:ReferenceAsset):ReferenceEvidence[]=>a.kind==='video'?[{kind:'time',start:0,end:Math.max(.25,Number(a.duration)||.25)}]:[{kind:'region',x:0,y:0,width:1,height:1}]
const t=(r?:{start:number;end:number}):ReferenceEvidence[]=>r&&r.end>r.start?[{kind:'time',start:r.start,end:r.end}]:[]
const f=(id:string,axis:any,value:unknown,evidence:ReferenceEvidence[],appliesTo:any[]):ReferenceFeature=>({id,axis,value,evidence,appliesTo})
export function analyzeReferenceDeterministic(asset:ReferenceAsset,s:ReferenceSignals={}):ReferenceAnalysis{
 const D=Number(s.duration??asset.duration??0), scenes=s.sceneRanges||[], hi=s.highlights||[], first=hi[0]||scenes[0]||(D?{start:0,end:Math.min(D,1.5)}:undefined)
 const dims={width:s.width??asset.width??null,height:s.height??asset.height??null,orientation:(s.height??asset.height??0)>(s.width??asset.width??0)?'portrait':'landscape'}
 const captions=s.captionRegions||[]
 const features:ReferenceFeature[]=[
  f('story.opening','story',{openingSeconds:D?Math.min(3,D):null},asset.kind==='video'?t({start:0,end:Math.min(D,3)}):whole(asset),['PLAN']),
  f('retention.peak','retention',{highlightCount:hi.length,firstPeak:first||null},asset.kind==='video'?t(first):whole(asset),['PLAN','QC']),
  f('editing.cadence','editing',{sceneCount:scenes.length,meanSceneSeconds:scenes.length?Number((scenes.reduce((n,x)=>n+x.end-x.start,0)/scenes.length).toFixed(3)):null},asset.kind==='video'?(scenes.slice(0,4).flatMap(t)):whole(asset),['PLAN','RENDER','QC']),
  f('composition.frame','composition',dims,whole(asset),['RENDER','QC']),
  f('caption.layout','caption',{regions:captions.length,hasMeasuredRegion:captions.length>0},captions.length?captions.map(x=>({kind:'region' as const,...x})):whole(asset),['RENDER','QC']),
  f('sound.structure','sound',{hasAudio:!!s.hasAudio,silentRanges:s.silentRanges||[]},asset.kind==='video'?((s.silentRanges||[]).slice(0,4).flatMap(t).length?(s.silentRanges||[]).slice(0,4).flatMap(t):whole(asset)):whole(asset),['PLAN','RENDER','QC']),
  f('narration.structure','narration',{measuredRanges:s.narrationRanges||[],status:(s.narrationRanges||[]).length?'measured':'unknown'},asset.kind==='video'?((s.narrationRanges||[]).slice(0,4).flatMap(t).length?(s.narrationRanges||[]).slice(0,4).flatMap(t):whole(asset)):whole(asset),['PLAN','RENDER','QC'])
 ]
 const out:ReferenceAnalysis={schema:'reference-analysis/1',analyzerVersion:REFERENCE_ANALYZER_VERSION,referenceAssetId:asset.referenceAssetId,referenceSha256:asset.sha256,features}
 const errors=validateReferenceAnalysis(out,asset);if(errors.length)throw new Error('invalid reference analysis: '+errors.join(','))
 if(new Set(features.map(x=>x.axis)).size!==REFERENCE_AXES.length)throw new Error('reference analyzer axis coverage incomplete')
 return out
}
export function referenceAnalysisHash(a:ReferenceAnalysis){return stableHash(a)}
