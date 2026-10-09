// The one-off representative picture of the ONE 야담 style contract (no network): only with STYLE_EXAMPLES_RUN=yadam-*,
// exactly one call through the contract, never again for the same id; every old experiment id does nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probe, runOk } from '../lib/media/ffmpeg.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { FRAMING_169, REPRESENTATIVE_SCENE, runStyleExamplesOnce, toSixteenNine } from '../worker/oneoffStyleExamples.js'

test('one-off representative: off without the variable; retired v2..v5 ids do nothing; one contract call (high quality); 16:9 final; never twice', async () => {
  const d = await mkdtemp(join(tmpdir(), 'oneoff-')), pic = join(d, 'p.jpg')
  await runOk(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1536x1024', '-frames:v', '1', pic]); const bytes = await readFile(pic)
  const calls: any[] = [], lines: string[] = [], blobs: any = createMemoryBlobStore(), log = (l: string) => lines.push(l)
  const draw: any = async (scene: string, key: string, o: any) => { calls.push({ scene, key, o }); return { bytes, contentType: 'image/jpeg', provider: 'standin', model: 'yadam' } }
  assert.equal(await runStyleExamplesOnce({ env: { OPENAI_API_KEY: 'sk-SECRET1' }, blobs, log, draw }), 'off')
  for (const old of ['v2-1', 'v3-1', 'v4-1', 'v5-1']) assert.equal(await runStyleExamplesOnce({ env: { STYLE_EXAMPLES_RUN: old, OPENAI_API_KEY: 'sk-SECRET1' }, blobs, log, draw }), 'retired')
  assert.equal(calls.length, 0, 'an old experiment id left in the worker variables never draws')
  const env = { STYLE_EXAMPLES_RUN: 'yadam-1', OPENAI_API_KEY: 'sk-SECRET1' }
  assert.equal(await runStyleExamplesOnce({ env, blobs, log, draw, workerId: 'w1' }), 'done')
  assert.equal(calls.length, 1); assert.equal(calls[0].scene, `${REPRESENTATIVE_SCENE} ${FRAMING_169}`); assert.deepEqual(calls[0].o, { quality: 'high' })
  const rec: any = await blobs.getJson('style-examples/candidates/yadam-1/run.json')
  assert.deepEqual([rec.status, rec.report.style, rec.report.inputFidelity, rec.report.final], ['done', 'yadam-style/1', 'high', { width: 1536, height: 864, cutTop: 80, cutBottom: 80 }])
  assert.deepEqual(rec.report.references.map((r: any) => [r.file, r.sent]), [['capture-2.jpg', '1920x800'], ['capture-1.jpg', '1920x800'], ['capture-3.jpg', '1920x800']])
  for (const [k, wh] of [['representative', '1536x864'], ['raw-3x2', '1536x1024'], ['compare-top-references-below', null]] as const) {
    const f = join(d, `${k}.jpg`); await writeFile(f, await blobs.getBytes(rec.files[k])); const i = await probe(f); if (wh) assert.equal(`${i.width}x${i.height}`, wh, k)
  }
  assert.equal(await runStyleExamplesOnce({ env, blobs, log, draw, workerId: 'w2' }), 'already'); assert.equal(calls.length, 1)
  assert.ok(lines.every((l) => !l.includes('sk-SECRET1')), 'the key is never logged')
  // 16:9 = the exact central band; heads in the safe band are kept unscaled; the wrong size is refused
  const t = join(d, 'src.png')
  await runOk(['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=1536x1024', '-vf', 'drawbox=x=0:y=0:w=1536:h=80:color=red:t=fill,drawbox=x=300:y=82:w=120:h=120:color=lime:t=fill', '-frames:v', '1', t])
  const jpg = join(d, 'src.jpg'); await runOk(['-y', '-i', t, '-q:v', '1', jpg])
  const w = await toSixteenNine(await readFile(jpg)), out = join(d, 'w.jpg'); await writeFile(out, w.bytes)
  const px = async (x: number, y: number) => [...((await runOk(['-i', out, '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'])).stdout as Buffer)]
  assert.deepEqual([w.width, w.height], [1536, 864]); const [r] = await px(10, 1), [, g] = await px(360, 62); assert.ok(r < 180 && g > 180)
  await assert.rejects(() => toSixteenNine(Buffer.from('nope')), /expected 1536x1024|Invalid|error/i)
})
