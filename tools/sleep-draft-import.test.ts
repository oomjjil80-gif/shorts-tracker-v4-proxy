import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSavedOdysseyScript, SLEEP_RECOVERY_METADATA } from '../lib/jobs/sleepDraftImport.js'
import { SLEEP_CHAPTERS } from '../lib/generative/sleepClassic.js'
import { validateLongformScript, type LongformBrief } from '../lib/generative/longform.js'
const jobId='job_f6ade006-386e-4e1b-9ce3-e2d37b26b25f'
const brief:LongformBrief={schema:'generative-brief/1',sleepClassic:'odyssey-cyclops-v1',profile:'wisdom_longform',kind:'topic',text:'오디세이아 동굴',language:'ko',aspectRatio:'16:9',targetSeconds:2700}
const source=()=>({schema:'odyssey-salvage/1',source_job_id:jobId,chapters:SLEEP_CHAPTERS.map((_,i)=>({index:i+1,original_text:'이미 작성한 원고'.repeat(20),repaired_text:'오디세우스와 동료들은 동굴에서 벗어나기 위해 계획을 세웠습니다. '.repeat(12)}))})
test('zero-provider offline restore validates nine preserved chapters with no duration/text target',()=>{
 const script=makeSavedOdysseyScript(source(),jobId,brief)
 assert.equal(script.sections.length,9)
 assert.equal(script.sections[3].id,'s4')
 assert.match(script.sections[3].sentences[0].say,/오디세우스와 동료들은/)
 assert.equal(script.sleepClassic,'odyssey-cyclops-v1')
 assert.deepEqual(validateLongformScript(script,brief),[])
 assert.ok(script.sections.every(c=>c.sentences.every(x=>[...x.say].length<=1200)))
})
test('never import another job, unordered chapters, empty or damaged corrected chapters',()=>{
 assert.throws(()=>makeSavedOdysseyScript(source(),'job_different',brief),/RECOVERY_JOB_MISMATCH/)
 const shuffled=source();[shuffled.chapters[0],shuffled.chapters[1]]=[shuffled.chapters[1],shuffled.chapters[0]]
 assert.throws(()=>makeSavedOdysseyScript(shuffled,jobId,brief),/RECOVERY_CHAPTER_ORDER/)
 const short=source();short.chapters[4].repaired_text='불완전'
 assert.throws(()=>makeSavedOdysseyScript(short,jobId,brief),/RECOVERY_CHAPTER_INVALID/)
 const missing=source();missing.chapters.pop()
 assert.throws(()=>makeSavedOdysseyScript(missing,jobId,brief),/RECOVERY_CHAPTER_COUNT/)
})
test('restored title, original source metadata and fixed cover still follow publishing gates',()=>{
 const script=makeSavedOdysseyScript(source(),jobId,brief)
 assert.match(script.title,/왜/)
 assert.match(SLEEP_RECOVERY_METADATA.pinnedComment,/폴리페모스/)
 assert.equal(validateLongformScript(script,brief).length,0)
})
