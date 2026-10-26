import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { evaluateBudget, monthInKst } from '../lib/generative/monthlyBudgetPolicy.js'

const now = new Date('2026-10-31T15:30:00.000Z')
const state = { spentUsd: 18, reservedUsd: 1, monthKst: '202611' }
test('KST month boundary is explicit', () => {
  assert.equal(monthInKst(now), '202611')
  assert.equal(monthInKst(new Date('2026-10-31T14:59:59Z')), '202610')
})
test('approval is required for every quote', () => {
  assert.equal(evaluateBudget(state, {provider:'gemini', estimatedUsd:0.5, approved:false}, now).reason,'APPROVAL_REQUIRED')
})
test('budget includes existing reservations', () => {
  assert.equal(evaluateBudget(state, {provider:'openai', estimatedUsd:1.01, approved:true}, now).reason,'BUDGET_EXCEEDED')
  assert.equal(evaluateBudget(state, {provider:'anthropic', estimatedUsd:1, approved:true}, now).allowed,true)
})
test('invalid numbers and stale month fail closed', () => {
  assert.equal(evaluateBudget({...state,spentUsd:NaN}, {provider:'gemini', estimatedUsd:0.5, approved:true}, now).reason,'INVALID_STATE')
  assert.equal(evaluateBudget(state, {provider:'gemini', estimatedUsd:NaN, approved:true}, now).reason,'INVALID_ESTIMATE')
  assert.equal(evaluateBudget({...state,monthKst:'202610'}, {provider:'gemini', estimatedUsd:0.5, approved:true}, now).reason,'MONTH_MISMATCH')
})
