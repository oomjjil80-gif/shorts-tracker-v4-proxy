import test from 'node:test'
import assert from 'node:assert/strict'
import { PROFILES } from '../lib/jobs/profiles.js'
import { featureListErrors } from '../worker/modules/features.js'

test('all existing production profiles keep valid feature order', () => {
  for (const profile of Object.values(PROFILES)) assert.deepEqual(featureListErrors(profile), [], profile.id)
})

test('package without QC is rejected before any paid module runs', () => {
  const original = PROFILES.wisdom
  const broken = { id: original.id, features: original.features.filter(feature => feature !== 'QC') }
  assert.match(featureListErrors(broken).join('; '), /PACKAGE needs QC before it/)
})
