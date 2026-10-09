// The one-off representative picture of the ONE 야담 style contract (no network): only with STYLE_EXAMPLES_RUN=yadam-*,
// exactly one Gemini call through the contract, never again for the same id; every old experiment id does nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probe, runOk } from '../lib/media/ffmpeg.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { REPRESENTATIVE_SCENE, runStyleExamplesOnce } from '../worker/oneoffStyleExamples.js'

test('one-off representative: off without the variable; retired v2..v5 ids do nothing; one Gemini contract call; 16:9 as drawn; never twice', async () => {
  const d = await mkdtemp(join(tmpdir(), 'oneoff-')), pic = join(d, 'p.jpg')
  await runOk(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1376x768', '-frames:v', '1', pic]); const bytes = await readFile(pic)
  const calls: any[] = [], lines: string[] = [], blobs: any = createMemoryBlobStore(), log = (l: string) => lines.push(l)
  const draw: any = async (scene: string, key: string, o: any) => { calls.push({ scene, key, o }); return { bytes, contentType: 'image/jpeg', provider: 'standin', model: 'yadam' } }
  assert.equal(await runStyleExamplesOnce({ env: { GEMINI_API_KEY: 'g-SECRET1' }, blobs, log, draw }), 'off')
  for (const old of ['v2-1', 'v3-1', 'v4-1', 'v5-1']) assert.equal(await runStyleExamplesOnce({ env: { STYLE_EXAMPLES_RUN: old, GEMINI_API_KEY: 'g-SECRET1' }, blobs, log, draw }), 'retired')
  assert.equal(calls.length, 0, 'an old experiment id left in the worker variables never draws')
  assert.equal(await runStyleExamplesOnce({ env: { STYLE_EXAMPLES_RUN: 'yadam-0', OPENAI_API_KEY: 'sk-x' }, blobs, log, draw }), 'invalid', 'the OpenAI key is never used for a picture')
  const env = { STYLE_EXAMPLES_RUN: 'yadam-1', GEMINI_API_KEY: 'g-SECRET1' }
  assert.equal(await runStyleExamplesOnce({ env, blobs, log, draw, workerId: 'w1' }), 'done')
  assert.equal(calls.length, 1); assert.equal(calls[0].scene, REPRESENTATIVE_SCENE); assert.equal(calls[0].key, 'g-SECRET1')
  const rec: any = await blobs.getJson('style-examples/candidates/yadam-1/run.json')
  assert.deepEqual([rec.status, rec.report.style, rec.report.model, rec.report.aspectRatio, rec.report.final], ['done', 'yadam-style/2-gemini', 'gemini-3.1-flash-image', '16:9', { width: 1376, height: 768 }])
  assert.deepEqual(rec.report.references.map((r: any) => [r.file, r.sent]), [['capture-2.jpg', '1920x800'], ['capture-1.jpg', '1920x800'], ['capture-3.jpg', '1920x800']])
  for (const [k, wh] of [['representative', '1376x768'], ['compare-top-references-below', null]] as const) {
    const f = join(d, `${k}.jpg`); await writeFile(f, await blobs.getBytes(rec.files[k])); const i = await probe(f); if (wh) assert.equal(`${i.width}x${i.height}`, wh, k)
  }
  assert.equal(await runStyleExamplesOnce({ env, blobs, log, draw, workerId: 'w2' }), 'already'); assert.equal(calls.length, 1)
  assert.ok(lines.every((l) => !l.includes('g-SECRET1')), 'the key is never logged')
})
