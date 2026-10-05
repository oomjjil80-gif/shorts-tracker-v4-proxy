import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('QC gates stay in stage results without duplicate qc/* blob copies', async () => {
  const compile = await readFile(new URL('../worker/stages/compile.ts', import.meta.url), 'utf8')
  const autoQc = await readFile(new URL('../worker/stages/autoQc.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(compile, /qc\/compile\//)
  assert.doesNotMatch(autoQc, /qc\/render\//)
  assert.doesNotMatch(autoQc, /qc\/content\//)

  assert.match(compile, /result: \{ manifestHash: lead\.manifestHash, identity: lead\.identity, gate: lead\.gate/)
  assert.match(autoQc, /results\.push\(\{[^\n]*gate, contentGate, referenceGate, publishable \}\)/)
})
