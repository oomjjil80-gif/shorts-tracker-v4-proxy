import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGenerativeBrief, generativeBriefHash, WISDOM_PROFILE } from '../lib/generative/contracts.js'
import { deterministicWisdomDraft, validateWisdomScript } from '../lib/generative/wisdom.js'
import { PIPELINES } from '../lib/jobs/pipeline.js'

test('P2 wisdom has an explicit generative pipeline with ASSET before COMPILE',()=>{
 assert.deepEqual(PIPELINES.wisdom,['PLAN','ASSET','COMPILE','RENDER','AUTO_QC','DECISION','FINAL','PACKAGE'])
 assert.ok(!PIPELINES.source_shorts.includes('ASSET'))
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
