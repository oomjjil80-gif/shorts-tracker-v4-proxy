import test from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKS, canExecuteBlock, recipeErrors, type ContentRecipe, type BlockProgress } from '../lib/jobs/recipe.js'

const recipe: ContentRecipe = { id: 'new_format_without_new_executor', provides: ['brief'], steps: [
  { block: 'RESEARCH' }, { block: 'PACKAGING' }, { block: 'SCRIPT' }, { block: 'REVIEW' },
  { block: 'SCRIPT_APPROVAL' }, { block: 'STYLE_APPROVAL' }, { block: 'ASSETS' },
  { block: 'RENDER' }, { block: 'FINAL_REVIEW' }
] }
test('a new format can be declared as a recipe without custom stage routing', () => {
  assert.deepEqual(recipeErrors(recipe), [])
  assert.equal(Object.keys(BLOCKS).length, 9)
})
test('paid asset generation is blocked until all prior approvals and results exist', () => {
  const progress: BlockProgress[] = [
    { block: 'RESEARCH', status: 'SUCCEEDED' },
    { block: 'PACKAGING', status: 'APPROVED' },
    { block: 'SCRIPT', status: 'SUCCEEDED' },
    { block: 'REVIEW', status: 'SUCCEEDED' },
    { block: 'SCRIPT_APPROVAL', status: 'APPROVED' },
    { block: 'STYLE_APPROVAL', status: 'PENDING' }
  ]
  assert.equal(canExecuteBlock(recipe, progress, 'ASSETS'), false)
  assert.equal(canExecuteBlock(recipe, [...progress.slice(0, -1), { block: 'STYLE_APPROVAL', status: 'APPROVED' }], 'ASSETS'), true)
})
test('skipping a required producer is rejected unless input is supplied by the recipe', () => {
  assert.match(recipeErrors({ ...recipe, steps: [{ block: 'RESEARCH', skipReason: 'source supplied' }, ...recipe.steps.slice(1)] }).join(' '), /missing research/)
  assert.deepEqual(recipeErrors({ ...recipe, provides: ['brief', 'research'], steps: [{ block: 'RESEARCH', skipReason: 'source supplied' }, ...recipe.steps.slice(1)] }), [])
})
test('unknown blocks and duplicate blocks fail closed', () => {
  assert.match(recipeErrors({ ...recipe, steps: [{ block: 'NOT_A_BLOCK' as any }] }).join(' '), /unknown block/)
  assert.match(recipeErrors({ ...recipe, steps: [recipe.steps[0], recipe.steps[0]] }).join(' '), /duplicate/)
})

import { legacyBlockMapping } from '../lib/jobs/legacyBlockMapping.js'
import { PROFILES } from '../lib/jobs/profiles.js'
test('all six existing profiles map every stage to a common block without changing dispatch', () => {
  for (const profile of Object.values(PROFILES)) {
    const mapped = legacyBlockMapping(profile.id)
    assert.deepEqual(mapped.map(m => m.stage), profile.stages)
    assert.deepEqual(mapped.map(m => m.module), profile.stages.map(stage => profile.modules[stage]))
    assert.ok(mapped.every(m => m.note.includes('compatibility only')))
  }
})

import { nextBlockDecision } from '../lib/jobs/blockScheduler.js'
test('scheduler stops at packaging approval before script paid work', () => {
  const progress: BlockProgress[] = [{ block: 'RESEARCH', status: 'SUCCEEDED' }, { block: 'PACKAGING', status: 'SUCCEEDED' }]
  assert.deepEqual(nextBlockDecision(recipe, progress), { state: 'WAITING_APPROVAL', block: 'PACKAGING' })
  assert.deepEqual(nextBlockDecision(recipe, [...progress.slice(0, -1), { block: 'PACKAGING', status: 'APPROVED' }]), { state: 'READY', block: 'SCRIPT', paid: true })
})
test('scheduler stops before asset creation until style approved', () => {
  const progress: BlockProgress[] = [
    { block: 'RESEARCH', status: 'SUCCEEDED' }, { block: 'PACKAGING', status: 'APPROVED' },
    { block: 'SCRIPT', status: 'SUCCEEDED' }, { block: 'REVIEW', status: 'SUCCEEDED' },
    { block: 'SCRIPT_APPROVAL', status: 'APPROVED' }, { block: 'STYLE_APPROVAL', status: 'SUCCEEDED' }
  ]
  assert.deepEqual(nextBlockDecision(recipe, progress), { state: 'WAITING_APPROVAL', block: 'STYLE_APPROVAL' })
  assert.deepEqual(nextBlockDecision(recipe, [...progress.slice(0, -1), { block: 'STYLE_APPROVAL', status: 'APPROVED' }]), { state: 'READY', block: 'ASSETS', paid: true })
})
test('scheduler fails closed for duplicate and unexpected persisted progress', () => {
  assert.equal(nextBlockDecision(recipe, [{ block: 'RESEARCH', status: 'SUCCEEDED' }, { block: 'RESEARCH', status: 'SUCCEEDED' }]).state, 'INVALID')
  assert.equal(nextBlockDecision(recipe, [{ block: 'RENDER', status: 'SKIPPED' }]).state, 'READY')
})
