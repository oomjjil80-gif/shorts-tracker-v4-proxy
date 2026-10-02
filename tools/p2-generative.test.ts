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
})
