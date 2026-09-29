import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'

const dir = new URL('../lib/tracker-core/', import.meta.url)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const manifest = JSON.parse(readFileSync(new URL('tracker-core.manifest.json', dir), 'utf8'))
const golden = JSON.parse(readFileSync(new URL('job-compile-golden.json', dir), 'utf8'))

test('T17 lib/tracker-core copies are byte-identical to the frontend files they were synced from', () => {
  for (const [file, expected] of Object.entries<string>(manifest.files)) assert.equal(sha(readFileSync(new URL(file, dir))), expected, `${file} drifted from the frontend (run npm run sync-core)`)
  assert.equal(sha(readFileSync(new URL('job-compile-golden.json', dir))), manifest.goldenFixtureSha256)
  const extras = readdirSync(dir).filter((f) => f.endsWith('.js') && !(f in manifest.files))
  assert.deepEqual(extras, [], 'unpinned .js file in tracker-core')
})

test('T12/T17 the Worker-side compiler reproduces the frontend golden manifestHash', () => {
  const { manifest: m, identity } = compileJobPlan({ jobId: golden.jobId, plan: golden.plan, sourceAsset: golden.sourceAsset })
  assert.equal(m.manifestHash, golden.expected.manifestHash)
  assert.deepEqual(identity, golden.expected.identity)
  assert.equal(m.payload.totalDuration, golden.expected.totalDuration)
})

test('T13/T14/T15 plan change, signed URL, and stable identity behave the same on the server', () => {
  const base = golden.expected.manifestHash
  const p = JSON.parse(JSON.stringify(golden.plan)); p.variantPlan.headline = 'changed'
  assert.notEqual(compileJobPlan({ jobId: golden.jobId, plan: p, sourceAsset: golden.sourceAsset }).manifest.manifestHash, base)
  assert.equal(compileJobPlan({ jobId: golden.jobId, plan: golden.plan, sourceAsset: { ...golden.sourceAsset, playbackUrl: 'https://signed.example/?sig=9' } }).manifest.manifestHash, base)
  assert.notEqual(compileJobPlan({ jobId: golden.jobId, plan: golden.plan, sourceAsset: { ...golden.sourceAsset, sha256: 'e'.repeat(64) } }).manifest.manifestHash, base)
})
