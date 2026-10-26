import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { evaluateBudget,monthInKst } from '../lib/generative/monthlyBudgetPolicy.js'
const now=new Date('2026-10-31T15:30:00Z')
const state={spentUsd:18,reservedUsd:1,monthKst:'202611'}
test('KST month boundary',()=>{
 assert.equal(monthInKst(now),'202611')
 assert.equal(monthInKst(new Date('2026-10-31T14:59:59Z')),'202610')
})
test('approval required; threshold never blocks approved call',()=>{
 assert.equal(evaluateBudget(state,{provider:'gemini',estimatedUsd:5,approved:false},now).reason,'APPROVAL_REQUIRED')
 const result=evaluateBudget(state,{provider:'gemini',estimatedUsd:5,approved:true},now)
 assert.equal(result.allowed,true)
 assert.equal(result.warning,true)
 assert.equal(result.reason,'WARNING_THRESHOLD')
})
test('invalid quote rejected',()=>{
 assert.equal(evaluateBudget(state,{provider:'gemini',estimatedUsd:NaN,approved:true},now).allowed,false)
})
