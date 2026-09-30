import { REFERENCE_ANALYZER_VERSION, REFERENCE_AXES, stableHash, validateReferenceAnalysis, type ReferenceAnalysis, type ReferenceAsset, type ReferenceEvidence, type ReferenceFeature } from './contracts.js'

export type ReferenceSignals={duration?:number;sceneRanges?:Array<{start:number;end:number}>;highlights?:Array<{start:number;end:number;score?:number}>;silentRanges?:Array<{start:number;end:number}>;hasAudio?:boolean;width?:number;height?:number;captionRegions?:Array<{x:number;y:number;width:number;height:number;frameTime?:number}>;narrationRanges?:Array<{start:number;end:number}>}
const whole=(a:ReferenceAsset):ReferenceEvidence[]=>a.kind==='video'?[{kind:'time',start:0,end:Math.max(.25,Number(a.duration)||.25)}]:[{kind:'region',x:0,y:0,width:1,height:1}]
const t=(r?:{start:number;end:number}):ReferenceEvidence[]=>r&&r.end>r.start?[{kind:'time',start:r.start,end:r.end}]:[]
const f=(id:string,axis:any,value:unknown,evidence:ReferenceEvidence[],appliesTo:any[]):ReferenceFeature=>({id,axis,value,evidence,appliesTo})
export function analyzeReferenceDeterministic(asset:ReferenceAsset,s:ReferenceSignals={}):ReferenceAnalysis{
 const isVideo=asset.kind==='video'
 const D=Number(s.duration??asset.duration??0), scenes=s.sceneRanges||[], hi=s.highlights||[], first=isVideo?hi[0]:undefined, opening=isVideo&&scenes[0]?.end>scenes[0]?.start?scenes[0]:undefined
 const dims={width:s.width??asset.width??null,height:s.height??asset.height??null,orientation:(s.height??asset.height??0)>(s.width??asset.width??0)?'portrait':'landscape'}
 const captions=s.captionRegions||[]
 const features:ReferenceFeature[]=[
  f('story.opening','story',isVideo&&opening?{openingSeconds:Number(opening.end.toFixed(3)),duration:D,status:'measured'}:{openingSeconds:null,duration:D||null,status:'unknown',reason:isVideo?'reference has no measured opening scene boundary':'still reference has no temporal story evidence'},isVideo&&opening?t({start:0,end:opening.end}):whole(asset),['PLAN']),
  f('retention.peak','retention',isVideo&&first?{highlightCount:hi.length,firstPeak:first,duration:D,status:'measured'}:{highlightCount:isVideo?hi.length:null,firstPeak:null,duration:D||null,status:'unknown',reason:isVideo?'reference has no measured retention highlight':'still reference has no retention timeline'},isVideo&&first?t(first):whole(asset),['PLAN','QC']),
  f('editing.cadence','editing',isVideo?{sceneCount:scenes.length,meanSceneSeconds:scenes.length?Number((scenes.reduce((n,x)=>n+x.end-x.start,0)/scenes.length).toFixed(3)):null}:{sceneCount:null,meanSceneSeconds:null,status:'unknown',reason:'still reference has no editing timeline'},isVideo?(scenes.slice(0,4).flatMap(t)):whole(asset),['PLAN','RENDER','QC']),
  f('visual.style','visualStyle',{aspectRatio:dims.width&&dims.height?Number((Number(dims.width)/Number(dims.height)).toFixed(4)):null,orientation:dims.orientation,status:'measured',scope:'geometric-style'},whole(asset),['RENDER','QC']),
  f('composition.frame','composition',dims,whole(asset),['RENDER','QC']),
  f('caption.layout','caption',{regions:captions.length,hasMeasuredRegion:captions.length>0,status:captions.length?'measured':'unknown',coverage:captions.length?{x:Number((captions.reduce((n,x)=>n+x.x,0)/captions.length).toFixed(4)),y:Number((captions.reduce((n,x)=>n+x.y,0)/captions.length).toFixed(4)),width:Number((captions.reduce((n,x)=>n+x.width,0)/captions.length).toFixed(4)),height:Number((captions.reduce((n,x)=>n+x.height,0)/captions.length).toFixed(4))}:null},captions.length?captions.map(x=>({kind:'region' as const,...x})):whole(asset),['RENDER','QC']),
  f('sound.structure','sound',isVideo?{hasAudio:typeof s.hasAudio==='boolean'?s.hasAudio:null,silentRanges:s.silentRanges||[],status:typeof s.hasAudio==='boolean'?'measured':'unknown'}:{hasAudio:null,silentRanges:null,status:'unknown',reason:'audio is not measurable from a still reference'},isVideo?((s.silentRanges||[]).slice(0,4).flatMap(t).length?(s.silentRanges||[]).slice(0,4).flatMap(t):whole(asset)):whole(asset),['PLAN','RENDER','QC']),
  f('narration.structure','narration',isVideo?{measuredRanges:s.narrationRanges||[],duration:D,status:(s.narrationRanges||[]).length?'measured':'unknown',scope:'non-silent-audio-activity'}:{measuredRanges:null,status:'unknown',reason:'narration is not measurable from a still reference'},isVideo?((s.narrationRanges||[]).slice(0,4).flatMap(t).length?(s.narrationRanges||[]).slice(0,4).flatMap(t):whole(asset)):whole(asset),['PLAN','RENDER','QC'])
 ]
 const out:ReferenceAnalysis={schema:'reference-analysis/1',analyzerVersion:REFERENCE_ANALYZER_VERSION,referenceAssetId:asset.referenceAssetId,referenceSha256:asset.sha256,features}
 const errors=validateReferenceAnalysis(out,asset);if(errors.length)throw new Error('invalid reference analysis: '+errors.join(','))
 if(new Set(features.map(x=>x.axis)).size!==REFERENCE_AXES.length)throw new Error('reference analyzer axis coverage incomplete')
 return out
}
export function referenceAnalysisHash(a:ReferenceAnalysis){return stableHash(a)}
