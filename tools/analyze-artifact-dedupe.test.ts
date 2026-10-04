import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('ANALYZE no longer persists the unused contact sheet', async () => {
  const src = await readFile(new URL('../worker/stages/analyze.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /contactSheetOut/)
  assert.doesNotMatch(src, /analysis\/contact\//)
  assert.match(src, /contactSheetRef: null/)
  assert.match(src, /keyframeSheetRef/)
})
