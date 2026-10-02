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
