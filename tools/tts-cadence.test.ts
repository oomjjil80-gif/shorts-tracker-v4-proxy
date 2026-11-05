import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slowNarrationClipIndices } from '../lib/generative/narration.js'

test('detects only the unusually stretched clip among comparable narration', () => {
  const clips = Array.from({ length: 8 }, () => ({ chars: 60, seconds: 10 }))
  clips[3] = { chars: 60, seconds: 35 }
  assert.deepEqual(slowNarrationClipIndices(clips), [3])
})
test('normal variation does not warn', () => {
  const clips = [10, 12, 9, 11, 13, 10].map((seconds) => ({ chars: 60, seconds }))
  assert.deepEqual(slowNarrationClipIndices(clips), [])
})
test('short clips and small samples are excluded', () => {
  assert.deepEqual(slowNarrationClipIndices([{ chars: 60, seconds: 40 }]), [])
  assert.deepEqual(slowNarrationClipIndices([
    ...Array.from({ length: 6 }, () => ({ chars: 60, seconds: 10 })),
    { chars: 3, seconds: 100 }
  ]), [])
})
