import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBlobStore, sha256 } from '../lib/jobs/blobs.js'
import { recoverSleepDraft } from '../lib/jobs/sleepDraftRecovery.js'
import { SLEEP_CHAPTERS } from '../lib/generative/sleepClassic.js'

test('recover all paid Odyssey sections and corrected drafts without writing or AI', async () => {
  const blobs = createMemoryBlobStore()
  const planRef = 'generative-briefs/existing-user-brief.json'
  const ck = 'longform-plan-checkpoints/' + sha256(planRef + '|longform-sections/2-research|sleep-classic/4')
  for (let i = 0; i < 9; i++) {
    await blobs.putJson(ck + '/section-' + String(i + 1).padStart(3, '0') + '.json', { sentences: [{ say: '기존 유료 원고 ' + (i+1) + '장' }] })
  }
  await blobs.putJson(ck + '/sleep-repair-v1-chapter-4.json', { sentences: [{ say: '4장 수정본' }] })
  await blobs.putJson(ck + '/sleep-quality.json', { approved:false, issues:['4장에서 원전 오류'] })
  const size = blobs.files.size
  const result = await recoverSleepDraft(blobs,planRef)
  assert.equal(result.total,9)
  assert.equal(result.found,9)
  assert.deepEqual(result.missing,[])
  assert.equal(result.chapters[0].originalText,'기존 유료 원고 1장')
  assert.equal(result.chapters[3].repairs[0].text,'4장 수정본')
  assert.deepEqual(result.reviewIssues,['4장에서 원전 오류'])
  assert.equal(result.readOnly,true)
  assert.equal(result.paidCalls,0)
  assert.equal(blobs.files.size,size)
})
test('fallback to saved chapter parts and explicitly report missing sections',async () => {
  const blobs=createMemoryBlobStore()
  const planRef='generative-briefs/saved-partial.json'
  const ck='longform-plan-checkpoints/'+sha256(planRef+'|longform-sections/2-research|sleep-classic/4')
  const count=Math.max(1,Math.ceil(SLEEP_CHAPTERS[0].beats.length/2))
  for(let i=0;i<count;i++) await blobs.putJson(ck+'/sleep-chapter-1-part-'+(i+1)+'.json',['기존 분할 원고 '+(i+1)])
  const r=await recoverSleepDraft(blobs,planRef)
  assert.equal(r.found,1)
  assert.deepEqual(r.missing,[2,3,4,5,6,7,8,9])
  assert.equal(r.chapters[0].source,'saved parts')
  assert.match(r.chapters[0].originalText,/기존 분할 원고 1/)
  assert.match(r.chapters[0].originalText,/오디세우스/)
})
test('unknown storage errors are NOT misrepresented as no chapters',async ()=>{
  const bad:any={getJson:async()=>{throw new Error('R2 network timeout')}}
  await assert.rejects(recoverSleepDraft(bad,'a'),/R2 network timeout/)
})
