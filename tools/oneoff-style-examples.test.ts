// One-off 그림체 example maker (no network): only with STYLE_EXAMPLES_RUN, exactly 5 calls, never again for the same
// run id, no retry, the key never logged; production styles (AUTO) unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOk } from '../lib/media/ffmpeg.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { runStyleExamplesOnce } from '../worker/oneoffStyleExamples.js'
import { YADAM_AUTO_STYLE } from '../lib/generative/creativeProfile.js'
import { YADAM_STYLE_KEYS } from '../lib/generative/visualStyle.js'
import { YADAM_STYLE_CANDIDATES } from '../lib/generative/yadamStyleCandidates.js'

test('one-off examples: off without the variable; 5 single calls; a second start draws nothing; no retry; key never logged; production styles untouched', async () => {
  const d = await mkdtemp(join(tmpdir(), 'oneoff-')), pic = join(d, 'p.jpg')
  await runOk(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1536x1024', '-frames:v', '1', pic]); const b64 = (await readFile(pic)).toString('base64')
  const KEY = 'sk-test-SECRET123', calls: any[] = [], lines: string[] = []
  const fetchImpl: any = async (url: string, init: any) => { const body = JSON.parse(init.body); calls.push({ url, body, auth: init.headers.Authorization }); return body.prompt.includes('webtoon') ? new Response('{"error":{"message":"boom"}}', { status: 500 }) : new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { headers: { 'content-type': 'application/json' } }) }
  const blobs: any = createMemoryBlobStore(), log = (l: string) => lines.push(l)
  assert.equal(await runStyleExamplesOnce({ env: { OPENAI_API_KEY: KEY }, blobs, log, fetchImpl }), 'off'); assert.equal(calls.length, 0)
  assert.equal(await runStyleExamplesOnce({ env: { STYLE_EXAMPLES_RUN: 'v2-1', OPENAI_API_KEY: KEY }, blobs, log, fetchImpl, workerId: 'w1' }), 'done')
  assert.equal(calls.length, 5, 'one call per style, the failed one is not retried')
  assert.ok(calls.every((c) => c.url.endsWith('/v1/images/generations') && c.body.model === 'gpt-image-1' && c.body.quality === 'high' && c.body.size === '1536x1024' && c.auth === `Bearer ${KEY}`))
  assert.ok(calls.every((c) => /Joseon|조선/.test(c.body.prompt) && /메주/.test(c.body.prompt) && /sepia/.test(c.body.prompt)), 'the same Joseon scene, no sepia')
  const rec: any = await blobs.getJson('style-examples/candidates/v2-1/run.json')
  assert.equal(rec.status, 'done'); assert.deepEqual(Object.keys(rec.errors), ['webtoon_historical']); assert.equal(rec.order.length, 4)
  assert.ok(await blobs.getBytes(rec.files['compare-new-top-current-bottom']), 'new-vs-current comparison sheet')
  for (const k of rec.order) assert.ok(await blobs.getBytes(rec.files[k]))
  // the variable left in place / a restart: nothing drawn again
  assert.equal(await runStyleExamplesOnce({ env: { STYLE_EXAMPLES_RUN: 'v2-1', OPENAI_API_KEY: KEY }, blobs, log, fetchImpl, workerId: 'w2' }), 'already'); assert.equal(calls.length, 5)
  assert.ok(lines.every((l) => !l.includes(KEY)), 'the key is never logged')
  assert.ok(lines.some((l) => /compare-new-top-current-bottom: memory:\/\//.test(l)), 'links in the log')
  // production unchanged: AUTO and the menu are as before; the candidates are separate
  assert.equal(YADAM_AUTO_STYLE, 'korean_drama_illustration'); assert.ok(!(YADAM_STYLE_KEYS as readonly string[]).includes('joseon_clean_watercolor'))
  assert.equal(YADAM_STYLE_CANDIDATES.length, 5)
})
