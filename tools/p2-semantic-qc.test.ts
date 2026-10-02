import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateWisdomSemanticQc } from '../lib/generative/semanticQc.js'

test('wisdom semantic QC passes a faithful hook-turn-ending structure',()=>{
 const script:any={schema:'wisdom-script/1',title:'관계',hook:'사람이 많아야 행복할까요?',ending:'편안한 몇 사람이면 충분합니다.',totalSeconds:40,beats:[
 {id:'1',narration:'사람이 많아야 좋은 관계일까요?',visualGoal:'a',imagePrompt:'a',durationSec:10},
 {id:'2',narration:'관계의 숫자를 늘리다 보면 마음은 더 지칠 수 있습니다.',visualGoal:'b',imagePrompt:'b',durationSec:10},
 {id:'3',narration:'하지만 중요한 건 숫자가 아니라 서로를 편안하게 해주는 깊이입니다.',visualGoal:'c',imagePrompt:'c',durationSec:10},
 {id:'4',narration:'말이 적어도 마음이 통하는 몇 사람을 오래 지키면 충분합니다.',visualGoal:'d',imagePrompt:'d',durationSec:10}]}
 const q=evaluateWisdomSemanticQc('관계는 숫자보다 서로를 편안하게 해주는 깊이가 중요합니다.',script)
 assert.deepEqual(q.reasons,[])
})
test('wisdom semantic QC blocks repetitive off-topic filler without a turn',()=>{
 const beat=(id:string)=>({id,narration:'오늘도 좋은 하루를 보내세요.',visualGoal:'x',imagePrompt:'x',durationSec:10})
 const q=evaluateWisdomSemanticQc('관계의 깊이와 편안함', {schema:'wisdom-script/1',title:'x',hook:'좋은 하루',ending:'좋은 하루',totalSeconds:40,beats:['1','2','3','4'].map(beat)} as any)
 assert.equal(q.topicFaithfulness,false);assert.equal(q.turn,false);assert.equal(q.nonRepetitive,false)
})
