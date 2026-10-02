import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGenerativeBrief, generativeBriefHash, WISDOM_PROFILE } from '../lib/generative/contracts.js'
import { deterministicWisdomDraft, validateWisdomScript } from '../lib/generative/wisdom.js'
import { PIPELINES, firstStage } from '../lib/jobs/pipeline.js'

test('P2 wisdom has an explicit generative pipeline with ASSET before COMPILE',()=>{
 assert.deepEqual(PIPELINES.wisdom,['PLAN','ASSET','ANALYZE','COMPILE','RENDER','AUTO_QC','DECISION','FINAL','PACKAGE'])
 assert.ok(!PIPELINES.source_shorts.includes('ASSET'))
 assert.equal(firstStage('wisdom',true),'PLAN') // stored brief is not a client-supplied render plan
})
test('P2 wisdom topic/text brief is normalized, bounded and stable',()=>{
 const a=normalizeGenerativeBrief({kind:'topic',text:'  오늘을 후회 없이 사는 법  ',targetSeconds:55})
 const b=normalizeGenerativeBrief({kind:'topic',text:'오늘을 후회 없이 사는 법',targetSeconds:55})
 assert.equal(a.profile,'wisdom'); assert.equal(a.aspectRatio,'9:16'); assert.equal(generativeBriefHash(a),generativeBriefHash(b))
 assert.throws(()=>normalizeGenerativeBrief({kind:'article',text:'abcd'}))
 assert.throws(()=>normalizeGenerativeBrief({kind:'text',text:'x',targetSeconds:55}))
})
test('P2 wisdom deterministic draft is structurally valid and provider-neutral',()=>{
 const b=normalizeGenerativeBrief({kind:'text',text:'오늘 할 수 있는 일을 미루지 마세요. 작은 선택이 하루를 바꿉니다. 완벽함보다 꾸준함이 오래 갑니다. 결국 삶은 반복한 선택의 합입니다.',targetSeconds:55})
 const s=deterministicWisdomDraft(b)
 assert.deepEqual(validateWisdomScript(s,b),[])
 assert.ok(s.beats.length>=4)
 assert.ok(s.beats.every(x=>x.imagePrompt.includes('9:16')&&!/watermark/i.test(x.imagePrompt.replace('no watermark',''))))
 assert.equal(WISDOM_PROFILE.visualContinuity,'low')
})
test('P2 boundary: Reference conditioning is not part of wisdom v1 contract',()=>{
 assert.equal((WISDOM_PROFILE as any).referenceProfile,undefined)
})


test('P2 timing contract: measured narration duration owns wisdom compile/QC timeline',async()=>{
 const fs=await import('node:fs/promises')
 const generative=await fs.readFile(new URL('../worker/stages/generative.ts',import.meta.url),'utf8')
 const compile=await fs.readFile(new URL('../worker/stages/compile.ts',import.meta.url),'utf8')
 const qc=await fs.readFile(new URL('../worker/stages/autoQc.ts',import.meta.url),'utf8')
 assert.match(generative,/narrationSec\+0\.35/)
 assert.match(generative,/timedPlanRef/)
 assert.match(generative,/trimEnd:timedTotal/)
 assert.match(compile,/timedPlanRef/)
 assert.match(qc,/measuredTotal/)
})


test('P2 wisdom rejects narration that exceeds the locked profile limit',()=>{
 const b=normalizeGenerativeBrief({kind:'topic',text:'좋은 인간관계를 오래 유지하는 법',targetSeconds:40})
 const s=deterministicWisdomDraft(b)
 s.beats[0].narration='가'.repeat(WISDOM_PROFILE.narration.maxCharsPerBeat+1)
 assert.ok(validateWisdomScript(s,b).includes('beats[0].narration.too_long'))
})

test('P2 wisdom rejects scripts materially away from requested duration',()=>{
 const b=normalizeGenerativeBrief({kind:'topic',text:'좋은 인간관계를 오래 유지하는 법',targetSeconds:40})
 const s=deterministicWisdomDraft(b)
 s.beats.forEach(x=>x.durationSec=12)
 s.totalSeconds=s.beats.reduce((n,x)=>n+x.durationSec,0)
 assert.ok(validateWisdomScript(s,b).includes('targetSeconds.mismatch'))
})

test('P2 wisdom Screen DNA v1 locks black bands, central visual window and motion',async()=>{
 const fs=await import('node:fs/promises')
 const generative=await fs.readFile(new URL('../worker/stages/generative.ts',import.meta.url),'utf8')
 const ass=await fs.readFile(new URL('../lib/media/ass.ts',import.meta.url),'utf8')
 assert.match(generative,/scale=1080:1200/)
 assert.match(generative,/pad=1080:1920:0:360:black/)
 assert.match(generative,/zoompan/)
 assert.match(ass,/WisdomHead/)
 assert.match(ass,/WisdomSub/)
 assert.match(ass,/profile === 'wisdom-v1'/)
})

test('P2 wisdom headline is deterministically split into two persistent lines',async()=>{
 const {wisdomHeadline}=await import('../worker/stages/generative.js')
 const h=wisdomHeadline('나이가 들수록 인간관계에서 정말 중요한 것')
 assert.match(h,/\\N/)
 assert.equal(h.replace('\\N',' '),'나이가 들수록 인간관계에서 정말 중요한 것')
})

test('P2 Korean topic faithfulness tolerates particles and inflection without weakening unrelated rejection',async()=>{
 const {evaluateWisdomSemanticQc}=await import('../lib/generative/semanticQc.js')
 const script:any={schema:'wisdom-script/1',title:'나이 들수록 인간관계는 줄여도 됩니다',hook:'쇼펜하우어의 관점에서 관계의 수보다 중요한 것을 봅니다',ending:'결국 중요한 것은 관계의 숫자가 아니라 깊이입니다',totalSeconds:40,beats:[
  {id:'b1',narration:'나이가 들수록 모든 인간관계를 붙잡을 필요는 없습니다',visualGoal:'a',imagePrompt:'a',durationSec:8},
  {id:'b2',narration:'관계가 많아도 마음이 편하지 않다면 피로만 쌓입니다',visualGoal:'b',imagePrompt:'b',durationSec:8},
  {id:'b3',narration:'하지만 혼자가 되라는 뜻은 아닙니다',visualGoal:'c',imagePrompt:'c',durationSec:8},
  {id:'b4',narration:'오히려 적은 사람에게 더 깊은 시간을 쓰는 편이 낫습니다',visualGoal:'d',imagePrompt:'d',durationSec:8},
  {id:'b5',narration:'남길 관계를 고르는 일이 삶을 가볍게 합니다',visualGoal:'e',imagePrompt:'e',durationSec:8}]}
 const good=evaluateWisdomSemanticQc('쇼펜하우어가 말하는, 나이가 들수록 인간관계를 줄여야 하는 이유',script)
 assert.equal(good.topicFaithfulness,true)
 const bad=evaluateWisdomSemanticQc('퇴직 후 연금 투자 전략',script)
 assert.equal(bad.topicFaithfulness,false)
})


test('P2 wisdom blocks a named philosopher topic unless an early visual explicitly depicts that person',async()=>{
 const {namedThinkerVisualErrors}=await import('../lib/generative/wisdom.js')
 const base:any={beats:[
  {visualGoal:'lonely older man',imagePrompt:'quiet modern room'},
  {visualGoal:'crowded relationships',imagePrompt:'people at a table'},
  {visualGoal:'reflection',imagePrompt:'person by a window'},
  {visualGoal:'ending',imagePrompt:'calm room'}]}
 assert.deepEqual(namedThinkerVisualErrors('쇼펜하우어가 말하는, 나이가 들수록 인간관계를 줄여야 하는 이유',base),['namedThinker.earlyVisual'])
 base.beats[1].visualGoal='쇼펜하우어의 실제 초상과 시대적 배경'
 base.beats[1].imagePrompt='recognizable Arthur Schopenhauer portrait in period-appropriate study'
 assert.deepEqual(namedThinkerVisualErrors('쇼펜하우어가 말하는, 나이가 들수록 인간관계를 줄여야 하는 이유',base),[])
 assert.deepEqual(namedThinkerVisualErrors('나이가 들수록 인간관계를 줄여야 하는 이유',base),[])
})


test('Wisdom ASS emits a persistent headline event instead of dropping it',async()=>{
 const {buildAss}=await import('../lib/media/ass.js')
 const r=buildAss({totalDuration:40,wisdomLayout:true,headline:'쇼펜하우어가 말하는\\N인간관계를 줄여야 하는 이유',subtitles:[]})
 const h=r.events.find((e:any)=>e.kind==='headline')
 assert.ok(h)
 assert.equal(h?.start,0)
 assert.equal(h?.end,40)
 assert.match(r.ass,/WisdomHead/)
 assert.match(r.ass,/쇼펜하우어가 말하는/)
 assert.equal((r.ass.match(/쇼펜하우어가 말하는/g)||[]).length,1)
 assert.equal((r.ass.match(/인간관계를 줄여야 하는 이유/g)||[]).length,1)
})


test('Wisdom headline style stays above the 360px Screen DNA boundary',async()=>{
 const {buildAss}=await import('../lib/media/ass.js')
 const r=buildAss({totalDuration:40,wisdomLayout:true,headline:'나이 들수록 관계를 줄여야 하는 이유',subtitles:[]})
 assert.match(r.ass,/Style: WisdomHead/)
 assert.match(r.ass,/WisdomHead/)
 // 5.5% top margin = 106px; regression guard against the prior 125px margin whose measured box reached y=365.
 assert.ok(r.ass.includes('Style: WisdomHead,Noto Sans KR,78,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,8,86,86,106,1'))
})


// Measures the real libass output, not the \fs number: \fs is the font's ascent+descent box (1.448em), so a fixed
// \fs100 drew ~62px Hangul. The headline must be exactly two ink lines (white, then yellow) that fill the 360px band.
test('Wisdom headline renders as two large white/yellow lines filling the 360px top band',async()=>{
 const {buildAss,FONTS_DIR,CANVAS}=await import('../lib/media/ass.js')
 const {runOk}=await import('../lib/media/ffmpeg.js')
 const {mkdtempSync,writeFileSync}=await import('node:fs')
 const {tmpdir}=await import('node:os')
 const {join}=await import('node:path')
 const dir=mkdtempSync(join(tmpdir(),'wisdom-head-'))
 for(const [headline,minInkHeight] of [['나이 들수록 관계를 줄여야 하는 이유',250],['나이 들수록 인간관계는 줄여도 됩니다',200],['쇼펜하우어가 말하는, 나이가 들수록 인간관계를 줄여야 하는 이유',130]] as const){
  const r=buildAss({totalDuration:2,wisdomLayout:true,headline,subtitles:[]})
  const dlg=r.ass.split('\n').filter((l:string)=>l.startsWith('Dialogue:'))
  assert.equal(dlg.length,1)
  assert.match(dlg[0],/\\q2/)
  const p=join(dir,'h.ass'); writeFileSync(p,r.ass)
  const out=await runOk(['-f','lavfi','-i',`color=c=black:s=${CANVAS.w}x${CANVAS.h}:d=1`,'-vf',`ass=filename=${p}:fontsdir=${FONTS_DIR},format=rgb24`,'-frames:v','1','-f','rawvideo','-'])
  const px=out.stdout, W=CANVAS.w
  let x0=W,x1=-1,y0=CANVAS.h,y1=-1; const rows:number[]=[]; let white=0,yellow=0
  for(let y=0;y<CANVAS.h;y++){let c=0;for(let x=0;x<W;x++){const i=(y*W+x)*3,R=px[i],G=px[i+1],B=px[i+2];if(R+G+B<300)continue;c++;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);if(R>220&&G>220&&B>220)white++;else if(R>220&&G>180&&B<80)yellow++}rows.push(c)}
  const bands:number[][]=[];let s=-1;rows.forEach((c,y)=>{if(c&&s<0)s=y;if(!c&&s>=0){bands.push([s,y-1]);s=-1}})
  assert.equal(bands.length,2,`${headline}: expected 2 ink lines, got ${JSON.stringify(bands)}`)
  assert.ok(y0>=16&&y1<=352,`${headline}: ink ${y0}-${y1} leaves the 360px band`)
  assert.ok(x0>=43&&x1<=1037,`${headline}: ink ${x0}-${x1} outside safe x`)
  assert.ok(x1-x0>=900,`${headline}: widest line only ${x1-x0}px wide`)
  assert.ok(y1-y0>=minInkHeight,`${headline}: ink block only ${y1-y0}px tall`)
  assert.ok(white>1000&&yellow>1000,`${headline}: white=${white} yellow=${yellow}`)
  const lineColor=(b:number[])=>{let w=0,yl=0;for(let y=b[0];y<=b[1];y++)for(let x=0;x<W;x++){const i=(y*W+x)*3;if(px[i]>220&&px[i+1]>220&&px[i+2]>220)w++;else if(px[i]>220&&px[i+1]>180&&px[i+2]<80)yl++}return w>yl?'white':'yellow'}
  assert.deepEqual(bands.map(lineColor),['white','yellow'])
 }
})


test('Named-thinker check ignores bible text and name-only goals; only an early beat scene counts',async()=>{
 const {namedThinkerVisualErrors}=await import('../lib/generative/wisdom.js')
 const {applyVisualBible}=await import('../lib/generative/planner.js')
 const topic='쇼펜하우어가 말하는, 나이가 들수록 인간관계를 줄여야 하는 이유'
 const generic:any={beats:[1,2,3,4].map(i=>({id:'b'+i,narration:'n',visualGoal:'혼자 창가에 앉은 노년 남성',imagePrompt:'an elderly man sitting alone by a window',durationSec:8}))}
 const bible:any={schema:'wisdom-visual-bible/1',style:'painterly',palette:'muted',lighting:'soft',composition:'center',characterPolicy:"One recurring elderly man embodies Schopenhauer's ideas",negative:'modern logos'}
 // previously passed because the shared character policy (pasted into every prompt) mentioned the name
 assert.deepEqual(namedThinkerVisualErrors(topic,applyVisualBible(generic,bible)),['namedThinker.earlyVisual'])
 const mention:any={beats:[{...generic.beats[0],visualGoal:'쇼펜하우어의 말을 곱씹는 노인'},...generic.beats.slice(1)]}
 assert.deepEqual(namedThinkerVisualErrors(topic,mention),['namedThinker.earlyVisual'])
 const third:any={beats:[...generic.beats.slice(0,2),{...generic.beats[2],imagePrompt:'portrait of Arthur Schopenhauer'},generic.beats[3]]}
 assert.deepEqual(namedThinkerVisualErrors(topic,third),['namedThinker.earlyVisual'])
 const second:any={beats:[generic.beats[0],{...generic.beats[1],imagePrompt:'portrait of Arthur Schopenhauer in his study'},...generic.beats.slice(2)]}
 assert.deepEqual(namedThinkerVisualErrors(topic,applyVisualBible(second,bible)),[])
})

test('Named-thinker anchor re-aims only the first beat image prompt; narration and durations untouched',async()=>{
 const {anchorNamedThinkerVisual,namedThinkerVisualErrors}=await import('../lib/generative/wisdom.js')
 const {applyVisualBible}=await import('../lib/generative/planner.js')
 const bible:any={schema:'wisdom-visual-bible/1',style:'painterly oil',palette:'muted ochre',lighting:'soft lamp',composition:'center',characterPolicy:'one recurring elderly man',negative:'modern logos'}
 const s:any=applyVisualBible({schema:'wisdom-script/1',title:'쇼펜하우어가 말하는 관계의 이유',hook:'h',ending:'e',totalSeconds:32,beats:[1,2,3,4].map(i=>({id:'b'+i,narration:'나레이션 '+i,visualGoal:'g',imagePrompt:'an elderly man by a window',durationSec:8}))},bible)
 const {script,anchoredBeatId}=anchorNamedThinkerVisual(s,s.title)
 assert.equal(anchoredBeatId,'b1')
 assert.match(script.beats[0].imagePrompt,/recognizable portrait of Arthur Schopenhauer/)
 assert.match(script.beats[0].imagePrompt,/mutton-chop sideburns/)
 assert.match(script.beats[0].imagePrompt,/painterly oil/)
 assert.doesNotMatch(script.beats[0].imagePrompt,/one recurring elderly man/)
 assert.deepEqual(namedThinkerVisualErrors(s.title,script),[])
 assert.deepEqual(script.beats.map((b:any)=>[b.id,b.narration,b.durationSec]),s.beats.map((b:any)=>[b.id,b.narration,b.durationSec]))
 assert.deepEqual(script.beats.slice(1),s.beats.slice(1))
 assert.equal(anchorNamedThinkerVisual(script,s.title).anchoredBeatId,null) // idempotent
 assert.equal(anchorNamedThinkerVisual(s,'나이가 들수록 인간관계를 줄여야 하는 이유').anchoredBeatId,null) // no named person
 assert.match(anchorNamedThinkerVisual({...s,title:'니체가 말한 고독'},'니체가 말한 고독').script.beats[0].imagePrompt,/Friedrich Nietzsche.*walrus moustache/)
})

test('Wisdom ASSET rerun reuses every cached image/TTS except the anchored thinker image (timing unchanged)',async()=>{
 const {createGenerativeAssetExecutor}=await import('../worker/stages/generative.js')
 const {createMemoryBlobStore,putAddressed}=await import('../lib/jobs/blobs.js')
 const {applyVisualBible}=await import('../lib/generative/planner.js')
 const {runOk}=await import('../lib/media/ffmpeg.js')
 const {createHash}=await import('node:crypto')
 const h=(x:string)=>createHash('sha256').update(x).digest('hex')
 const jpg=(await runOk(['-f','lavfi','-i','color=c=gray:s=64x96:d=1','-frames:v','1','-f','mjpeg','-'])).stdout
 const mp3=(await runOk(['-f','lavfi','-i','sine=f=440:d=3.2','-c:a','libmp3lame','-f','mp3','-'])).stdout
 const blobs:any=createMemoryBlobStore()
 const bible:any={schema:'wisdom-visual-bible/1',style:'painterly',palette:'muted',lighting:'soft',composition:'center',characterPolicy:'one recurring elderly man',negative:'logos'}
 const script:any=applyVisualBible({schema:'wisdom-script/1',title:'쇼펜하우어가 말하는 관계의 이유',hook:'h',ending:'e',totalSeconds:16,beats:[1,2,3,4].map(i=>({id:'b'+i,narration:'나레이션 '+i,visualGoal:'g'+i,imagePrompt:'scene '+i,durationSec:4}))},bible)
 // the existing paid assets: every original image and narration is already in the generative cache
 const imgSha:Record<string,string>={}, mp3Sha=createHash('sha256').update(mp3).digest('hex')
 for(const b of script.beats){
  const img=Buffer.concat([jpg,Buffer.from(b.id)]); imgSha[b.id]=createHash('sha256').update(img).digest('hex')
  await blobs.putBytes(`generative-assets/images/${imgSha[b.id]}.jpg`,img,'image/jpeg'); await blobs.putJson('generative-cache/image/'+h('image-v1|'+b.imagePrompt)+'.json',{ref:`generative-assets/images/${imgSha[b.id]}.jpg`,sha256:imgSha[b.id],contentType:'image/jpeg',provider:'openai',model:'m'})
  await blobs.putBytes(`generative-assets/audio/${h('a'+b.id)}.mp3`,mp3,'audio/mpeg'); await blobs.putJson('generative-cache/tts/'+h('tts-v1|'+b.narration)+'.json',{ref:`generative-assets/audio/${h('a'+b.id)}.mp3`,sha256:h('a'+b.id),contentType:'audio/mpeg',provider:'openai',model:'m'})
 }
 const stored=await putAddressed(blobs,'generative-scripts',script)
 const prompts:string[]=[]; let tts=0
 const ex=createGenerativeAssetExecutor({apiKey:'k',image:async(p:string)=>{prompts.push(p);return {bytes:jpg,contentType:'image/jpeg',provider:'openai',model:'m'}},tts:async()=>{tts++;return {bytes:mp3,contentType:'audio/mpeg',provider:'openai',model:'m'}}})
 const out:any=await ex.run({job:{id:'j',profile:'wisdom',planRev:1,sourceAssetId:'src_gen_j'} as any,blobs,previous:async(stage:string)=>(stage==='PLAN'?{result:{scriptRef:stored.path}}:stage==='ASSET'?{result:{assetSpecRef:'generative-assets/prior.json'}}:null) as any,signal:new AbortController().signal} as any)
 assert.equal(prompts.length,1); assert.match(prompts[0],/Arthur Schopenhauer/); assert.equal(tts,0)
 assert.equal(out.result.generated,1); assert.equal(out.result.reused,7)
 const m:any=await blobs.getJson(out.result.assetSpecRef)
 assert.equal(m.namedThinkerAnchor.beatId,'b1')
 assert.deepEqual(m.items.slice(1).map((x:any)=>x.image.sha256),script.beats.slice(1).map((b:any)=>imgSha[b.id]))
 assert.notEqual(m.items[0].image.sha256,imgSha.b1)
 assert.deepEqual(m.items.map((x:any)=>[x.narration,x.tts.sha256,x.durationSec]),script.beats.map((b:any)=>[b.narration,mp3Sha,m.items[0].durationSec]))
})


test('Wisdom ASSET rerun refuses before any paid call if a non-anchor image or any TTS is not cached',async()=>{
 const {createGenerativeAssetExecutor}=await import('../worker/stages/generative.js')
 const {createMemoryBlobStore,putAddressed}=await import('../lib/jobs/blobs.js')
 const {createHash}=await import('node:crypto')
 const h=(x:string)=>createHash('sha256').update(x).digest('hex')
 const blobs:any=createMemoryBlobStore()
 const script:any={schema:'wisdom-script/1',title:'쇼펜하우어가 말하는 관계',hook:'h',ending:'e',totalSeconds:16,beats:[1,2,3,4].map(i=>({id:'b'+i,narration:'나레이션 '+i,visualGoal:'g',imagePrompt:'scene '+i,durationSec:4}))}
 for(const b of script.beats){ // b3 image missing from the cache (e.g. blob deleted)
  if(b.id!=='b3'){await blobs.putBytes('img/'+b.id,Buffer.from(b.id),'image/jpeg');await blobs.putJson('generative-cache/image/'+h('image-v1|'+b.imagePrompt)+'.json',{ref:'img/'+b.id})}
  await blobs.putBytes('aud/'+b.id,Buffer.from(b.id),'audio/mpeg');await blobs.putJson('generative-cache/tts/'+h('tts-v1|'+b.narration)+'.json',{ref:'aud/'+b.id})
 }
 const stored=await putAddressed(blobs,'generative-scripts',script)
 let paid=0
 const ex=createGenerativeAssetExecutor({apiKey:'k',image:async()=>{paid++;throw new Error('must not be called')},tts:async()=>{paid++;throw new Error('must not be called')}})
 await assert.rejects(()=>ex.run({job:{id:'j',profile:'wisdom',planRev:1,sourceAssetId:'src_gen_j'} as any,blobs,previous:async(stage:string)=>(stage==='PLAN'?{result:{scriptRef:stored.path}}:{result:{assetSpecRef:'prior'}}) as any,signal:new AbortController().signal} as any),(e:any)=>e.code==='ASSET_RECHECK_WOULD_REGENERATE'&&/b3\.image/.test(e.message)&&!/b1/.test(e.message))
 assert.equal(paid,0)
})
