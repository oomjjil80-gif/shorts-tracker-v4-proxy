import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { evaluateBudget, monthInKst } from '../lib/generative/monthlyBudgetPolicy.js'
const now = new Date('2026-10-31T15:30:00.000Z')
const state = { spentUsd: 18, reservedUsd: 1, monthKst: '202611' }
test('KST month boundary is explicit', () => {
  assert.equal(monthInKst(now), '202611')
  assert.equal(monthInKst(new Date('2026-10-31T14:59:59Z')), '202610')
})
test('approval remains required', () => {
  assert.equal(evaluateBudget(state, {provider:'gemini',estimatedUsd:0.5,approved:false}, now).reason,'APPROVAL_REQUIRED')
})
test('USD 20 is a warning, not a block', () => {
  const over=evaluateBudget(state,{provider:'openai',estimatedUsd:5,approved:true},now)
  assert.equal(over.allowed,true)
  assert.equal(over.warning,true)
  assert.equal(over.reason,'WARNING_THRESHOLD')
  assert.equal(evaluateBudget(state,{provider:'anthropic',estimatedUsd:0.5,approved:true},now).warning,false)
})
test('invalid inputs and stale month fail closed', () => {
  assert.equal(evaluateBudget({...state,spentUsd:NaN},{provider:'gemini',estimatedUsd:1,approved:true},now).reason,'INVALID_STATE')
  assert.equal(evaluateBudget(state,{provider:'gemini',estimatedUsd:NaN,approved:true},now).reason,'INVALID_ESTIMATE')
  assert.equal(evaluateBudget({...state,monthKst:'202610'},{provider:'gemini',estimatedUsd:1,approved:true},now).reason,'MONTH_MISMATCH')
})
