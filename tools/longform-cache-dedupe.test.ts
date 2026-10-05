import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { cacheEntryIsCanonical } from '../lib/generative/cache.js'

test('Longform cache identity accepts canonical assets and rejects stale metadata', () => {
  assert.equal(cacheEntryIsCanonical({ ref: 'generative-assets/images/a.jpg', sha256: 'abc' }, 'generative-assets/images/a.jpg', 'abc'), true)
  assert.equal(cacheEntryIsCanonical({ ref: 'generative-assets/audio/a.mp3' }, 'generative-assets/audio/a.mp3', 'def'), true)
  assert.equal(cacheEntryIsCanonical({ ref: 'old/path.jpg', sha256: 'abc' }, 'generative-assets/images/a.jpg', 'abc'), false)
  assert.equal(cacheEntryIsCanonical({ ref: 'generative-assets/images/a.jpg', sha256: 'bad' }, 'generative-assets/images/a.jpg', 'abc'), false)
})

test('Longform ASSET reuses one TTS cache read and avoids duplicate identical image writes', async () => {
  const src = await readFile(new URL('../worker/stages/longform.ts', import.meta.url), 'utf8')
  assert.match(src, /const ttsCached = await Promise\.all/)
  assert.match(src, /let au: any = ttsCached\[i\]/)
  assert.match(src, /if \(imageRef !== rawRef\) await blobs\.putBytes\(imageRef/)
})
