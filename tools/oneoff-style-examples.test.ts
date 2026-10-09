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

test('V4 request as sent: the 3 user captures (bars, subtitles and AI label removed, aspect kept) as real images, primary-style contract, no conflicting style words; one call; v3 retired; production untouched', async () => {
  const { buildV4Request, V4_PROMPT, V4_CONTRACT } = await import('../lib/generative/yadamReferenceStyle.js')
  const req = await buildV4Request()
  assert.deepEqual([req.endpoint, req.model, req.size, req.quality], ['https://api.openai.com/v1/images/edits', 'gpt-image-1', '1536x1024', 'high'])
  const imgs = req.form.getAll('image[]') as any[]
  assert.deepEqual(imgs.map((x) => x.name), ['capture-1.png', 'capture-2.png', 'capture-3.png'], 'three real images, in this order')
  for (const [i, x] of req.inputs.entries()) {
    assert.deepEqual([x.source.width, x.source.height], [2340, 1080], 'the original phone capture')
    assert.deepEqual([x.input.width, x.input.height], [1920, 800], 'side bars + subtitles cut, no stretching (1920 wide = the video frame)')
    assert.equal(imgs[i].size, x.input.bytes)
  }
  assert.ok(V4_PROMPT.startsWith(V4_CONTRACT), 'the contract first, verbatim'); assert.equal(String(req.form.get('prompt')), V4_PROMPT)
  assert.doesNotMatch(V4_PROMPT, /watercolor|storybook|faded|muted|folk|textbook|vintage|sepia|quality reference|references? only/i, 'no conflicting style words')
  // the sent pictures carry no burned subtitle: near-white pixels in the bottom 60 rows of each are rare
  for (const x of imgs) {
    const f = join(await mkdtemp(join(tmpdir(), 'v4in-')), x.name); await (await import('node:fs/promises')).writeFile(f, Buffer.from(await x.arrayBuffer()))
    const rows = (await runOk(['-i', f, '-vf', 'crop=1920:60:0:740,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'])).stdout as Buffer
    let white = 0; for (const v of rows) if (v > 235) white++
    assert.ok(white / rows.length < 0.02, `${x.name}: ${(100 * white / rows.length).toFixed(1)}% white in the bottom band`)
  }
  // the one-off: exactly one call with that request, never again for the same id; v3 ids are retired (no call)
  const d = await mkdtemp(join(tmpdir(), 'oneoff4-')), pic = join(d, 'p.jpg')
  await runOk(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1536x1024', '-frames:v', '1', pic]); const bytes = await readFile(pic)
  const calls: any[] = [], blobs: any = createMemoryBlobStore()
  const fetchImpl: any = async (url: string, init: any) => { const fd = init.body as FormData; calls.push({ url, refs: fd.getAll('image[]').map((x: any) => x.name), prompt: String(fd.get('prompt')) }); return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }), { headers: { 'content-type': 'application/json' } }) }
  assert.equal(await runStyleExamplesOnce({ env: { STYLE_EXAMPLES_RUN: 'v3-2', OPENAI_API_KEY: 'sk-x' }, blobs, log: () => {}, fetchImpl }), 'invalid'); assert.equal(calls.length, 0)
  const env = { STYLE_EXAMPLES_RUN: 'v4-1', OPENAI_API_KEY: 'sk-x' }
  assert.equal(await runStyleExamplesOnce({ env, blobs, log: () => {}, fetchImpl, workerId: 'w1' }), 'done')
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].refs, ['capture-1.png', 'capture-2.png', 'capture-3.png']); assert.equal(calls[0].prompt, V4_PROMPT)
  const rec: any = await blobs.getJson('style-examples/candidates/v4-1/run.json')
  assert.equal(rec.report.inputs.length, 3); assert.ok(await blobs.getBytes(rec.files['v4-representative'])); assert.ok(await blobs.getBytes(rec.files['compare-v4-top-references-below']))
  assert.equal(await runStyleExamplesOnce({ env, blobs, log: () => {}, fetchImpl, workerId: 'w2' }), 'already'); assert.equal(calls.length, 1)
  assert.equal(YADAM_AUTO_STYLE, 'korean_drama_illustration', 'production AUTO unchanged')
})
