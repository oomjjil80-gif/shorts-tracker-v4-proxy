import test from 'node:test'
import assert from 'node:assert/strict'
import { compiledVariantsFromRun } from '../worker/stages/render.js'

const gate = { decision: 'PASS', reasons: [], counts: { pass: 4, fail: 0, unknown: 0, requiredPass: 4, requiredTotal: 4 }, checks: [] }

test('RENDER accepts the pre-P1 single-manifest COMPILE result shape', () => {
  const legacy = {
    outputRef: 'manifests/legacy.json',
    outputHash: 'a'.repeat(64),
    result: { manifestHash: 'a'.repeat(64), identity: [{ sourceAssetId: 'src_1', blobPath: 'source-collector/x.mp4', sha256: 'b'.repeat(64) }], gate, totalDuration: 11.5 }
  }
  assert.deepEqual(compiledVariantsFromRun(legacy), [{
    variantId: 'v1', label: '추천', manifestHash: 'a'.repeat(64), manifestRef: 'manifests/legacy.json', gate, identity: legacy.result.identity
  }])
})

test('RENDER keeps the P1 multi-variant COMPILE result unchanged', () => {
  const variants = [{ variantId: 'v2', label: '원본 순서', manifestHash: 'c'.repeat(64), manifestRef: 'manifests/new.json', gate, identity: [] }]
  assert.strictEqual(compiledVariantsFromRun({ result: { variants } })[0], variants[0])
})

test('RENDER does not fabricate a compile result when durable fields are incomplete', () => {
  assert.deepEqual(compiledVariantsFromRun(null), [])
  assert.deepEqual(compiledVariantsFromRun({ outputRef: 'x', result: { gate } }), [])
  assert.deepEqual(compiledVariantsFromRun({ outputHash: 'x', result: { gate } }), [])
})
