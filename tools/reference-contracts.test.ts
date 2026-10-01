import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisCacheKey, conformanceReport, referenceAssetId, stableHash, toReferenceProfile, validateReferenceAnalysis, validateReferenceAsset, validateReferenceProfile, type ReferenceAnalysis, type ReferenceAsset } from '../lib/reference/contracts.js'

const asset=(kind:'video'|'image'|'screenshot'):ReferenceAsset=>{const sha=({video:'a',image:'b',screenshot:'c'} as const)[kind].repeat(64);return {schema:'reference-asset/1',referenceAssetId:referenceAssetId(sha),kind,sha256:sha,bytes:123,contentType:kind==='video'?'video/mp4':'image/jpeg',blobPath:'references/'+sha,createdAt:'2026-09-30T00:00:00Z',...(kind==='video'?{duration:10,width:1080,height:1920}:{width:1080,height:1920})}}
const analysis=(a:ReferenceAsset):ReferenceAnalysis=>({schema:'reference-analysis/1',analyzerVersion:'reference-analyzer/3',referenceAssetId:a.referenceAssetId,referenceSha256:a.sha256,features:[
 {id:'story.hook',axis:'story',value:{strategy:'cold_open'},evidence:a.kind==='video'?[{kind:'time',start:0,end:1}]:[{kind:'region',x:0,y:0,width:1,height:.3}],appliesTo:['PLAN']},
 {id:'retention.peak',axis:'retention',value:{at:.5},evidence:a.kind==='video'?[{kind:'time',start:4,end:6}]:[{kind:'region',x:0,y:0,width:1,height:1}],appliesTo:['PLAN','QC']},
 {id:'editing.cadence',axis:'editing',value:{mean:2},evidence:a.kind==='video'?[{kind:'time',start:0,end:2}]:[{kind:'region',x:0,y:0,width:1,height:1}],appliesTo:['PLAN','RENDER','QC']},
 {id:'visual.style',axis:'visualStyle',value:{orientation:'portrait'},evidence:a.kind==='video'?[{kind:'time',start:0,end:10}]:[{kind:'region',x:0,y:0,width:1,height:1}],appliesTo:['RENDER','QC']},
 {id:'composition.subject',axis:'composition',value:{scale:'large'},evidence:a.kind==='video'?[{kind:'time',start:1,end:2}]:[{kind:'region',x:.1,y:.1,width:.8,height:.8}],appliesTo:['RENDER','QC']},
 {id:'caption.layout',axis:'caption',value:{region:'lower'},evidence:a.kind==='video'?[{kind:'time',start:0,end:10}]:[{kind:'region',x:0,y:.7,width:1,height:.3}],appliesTo:['RENDER','QC']},
 {id:'sound.structure',axis:'sound',value:{hasAudio:a.kind==='video'},evidence:a.kind==='video'?[{kind:'time',start:0,end:10}]:[{kind:'region',x:0,y:0,width:1,height:1}],appliesTo:['RENDER','QC']},
 {id:'narration.structure',axis:'narration',value:{status:'unknown'},evidence:a.kind==='video'?[{kind:'time',start:0,end:10}]:[{kind:'region',x:0,y:0,width:1,height:1}],appliesTo:['PLAN','RENDER','QC']}
]})

test('video/image/screenshot share stable identity and cache contract',()=>{
 for(const kind of ['video','image','screenshot'] as const){const a=asset(kind);assert.deepEqual(validateReferenceAsset(a),[]);assert.match(analysisCacheKey(a),/[a-c]{64}\.json$/);assert.deepEqual(validateReferenceAnalysis(analysis(a),a),[])}
})
test('analysis requires evidence and a real Plan/Render/QC consumer',()=>{
 const a=asset('video'), x=analysis(a); x.features[0]={...x.features[0],evidence:[],appliesTo:[]}
 const e=validateReferenceAnalysis(x,a); assert.ok(e.some(x=>x.startsWith('evidence:')));assert.ok(e.some(x=>x.startsWith('appliesTo:')))
})
test('image evidence cannot pretend to be a timestamp',()=>{
 const a=asset('image'), x=analysis(a); x.features[0]={...x.features[0],evidence:[{kind:'time',start:0,end:1}]}
 assert.ok(validateReferenceAnalysis(x,a).some(x=>x.startsWith('evidence:')))
})
test('profile is versioned and conformance UNKNOWN blocks independently',()=>{
 const p=toReferenceProfile([analysis(asset('video')),analysis(asset('image')),analysis(asset('screenshot'))]);assert.deepEqual(validateReferenceProfile(p),[])
 const r=conformanceReport(p,[{featureId:'story.hook',axis:'story',appliesTo:['PLAN'],status:'PASS',evidence:{}}]);assert.equal(r.decision,'BLOCK');assert.ok(r.checks.some(x=>x.status==='UNKNOWN'))
})
test('canonical hash ignores object key insertion order',()=>assert.equal(stableHash({a:1,b:2}),stableHash({b:2,a:1})))
