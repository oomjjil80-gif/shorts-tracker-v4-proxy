import test from 'node:test'
import assert from 'node:assert/strict'
import { wisdomCacheEntryIsCanonical } from '../worker/stages/generative.js'

test('Wisdom cache identity accepts canonical existing assets and rejects stale metadata', () => {
  assert.equal(wisdomCacheEntryIsCanonical({ ref: 'generative-assets/images/a.jpg', sha256: 'abc' }, 'generative-assets/images/a.jpg', 'abc'), true)
  assert.equal(wisdomCacheEntryIsCanonical({ ref: 'generative-assets/audio/a.mp3' }, 'generative-assets/audio/a.mp3', 'def'), true)
  assert.equal(wisdomCacheEntryIsCanonical({ ref: 'old/path.jpg', sha256: 'abc' }, 'generative-assets/images/a.jpg', 'abc'), false)
  assert.equal(wisdomCacheEntryIsCanonical({ ref: 'generative-assets/images/a.jpg', sha256: 'bad' }, 'generative-assets/images/a.jpg', 'abc'), false)
  assert.equal(wisdomCacheEntryIsCanonical(null, 'generative-assets/images/a.jpg', 'abc'), false)
})
