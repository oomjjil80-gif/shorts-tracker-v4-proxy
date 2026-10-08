// The chosen 그림체 example picture drives the FIRST thumbnail (no AI here: stand-in drawers).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOk } from '../lib/media/ffmpeg.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { styleGate } from '../worker/stages/styleGate.js'
import { STYLE_EXAMPLES, loadStyleExample, styleExampleFor } from '../lib/generative/styleExamples.js'
import { YADAM_STYLE_KEYS } from '../lib/generative/visualStyle.js'
import { STYLE_APPROVAL, styleApprovalRef } from '../lib/generative/styleApproval.js'

const script: any = { title: '썩은 메주를 지워 보낸 시어머니', hook: '며느리는 썩은 메주를 끝까지 지고 갔다', thumbnail: { lines: [{ text: '썩은 메주', color: 'red' }, { text: '지고 간 며느리', color: 'white' }] }, sections: [] }
async function picture(d: string, c: string) { const f = join(d, `${c}.jpg`); await runOk(['-y', '-f', 'lavfi', '-i', `color=c=0x${c}:s=1536x1024,drawgrid=w=96:h=96:t=6:c=white@0.8`, '-frames:v', '1', '-q:v', '3', f]); return { bytes: await readFile(f), contentType: 'image/jpeg', provider: 'standin', model: 'x' } }

test('every 야담 style has its real example file; the thumbnail is drawn FROM it (scene from the story); a missing example stops instead of drawing from text', async () => {
  for (const k of YADAM_STYLE_KEYS) { const e = await loadStyleExample(k); assert.equal(e.style, k); assert.ok(e.bytes.length > 20_000); assert.equal(STYLE_EXAMPLES[k], `yadam/${k}.jpg`) }
  assert.equal(styleExampleFor('senior-warm-watercolor'), null, 'a style without an example keeps its text-described drawing')
  assert.equal(STYLE_APPROVAL.wisdom.enabled, false, 'Wisdom Shorts LOCK: never goes through this')
  const d = await mkdtemp(join(tmpdir(), 'style-ex-')), blobs: any = createMemoryBlobStore(), seen: Array<{ p: string; ref: Buffer }> = []
  let text = 0
  const ex = await loadStyleExample('oriental_painterly')
  const base = { blobs, script, profile: 'yasa_longform', apiKey: 'k', backgroundPrompt: 'SCENE: the bride at the gate at dusk', draw: async () => { text++; return picture(d, '335577') }, drawRef: async (p: string, ref: Buffer) => { seen.push({ p, ref }); return picture(d, '775533') } }
  // 1) a job that was ALREADY waiting with a thumbnail made before (no example): 다시 생성 -> the example is used now
  await blobs.putJson(styleApprovalRef('j-old'), { schema: 'style-approval/1', status: 'pending', attempts: [{ n: 1, backgroundRef: 'x', thumbnailRef: 'y', lines: [], copyIssues: [], imageIssues: [], at: 'then' }], regenerate: true }, { overwrite: true })
  const g = await styleGate({ ...base, jobId: 'j-old', example: async () => ex })
  assert.equal(g.wait, true); assert.equal(text, 0, 'no text-only drawing'); assert.equal(seen.length, 1)
  assert.ok(seen[0].ref.equals(ex.bytes), 'the real example picture is attached'); assert.match(seen[0].p, /^STYLE EXAMPLE ATTACHED/); assert.match(seen[0].p, /Do NOT copy the example's scene/); assert.match(seen[0].p, /SCENE: the bride at the gate at dusk/)
  const rec: any = await blobs.getJson(styleApprovalRef('j-old'))
  assert.deepEqual([rec.attempts.length, rec.attempts[1].example.style, rec.attempts[1].example.sha], [2, 'oriental_painterly', ex.sha])
  // 2) the example file is missing -> STYLE_EXAMPLE_MISSING (not retryable), nothing drawn
  await assert.rejects(() => loadStyleExample('oriental_painterly', join(d, 'nowhere')), /missing or not a JPEG/)
  await assert.rejects(() => styleGate({ ...base, jobId: 'j-missing', example: () => loadStyleExample('oriental_painterly', join(d, 'nowhere')) }), (e: any) => e.code === 'STYLE_EXAMPLE_MISSING' && e.retryable === false && /STYLE_EXAMPLE_MISSING/.test(e.message))
  assert.deepEqual([text, seen.length], [0, 1], 'no silent text fallback, no paid call')
  // 3) a style without an example (Senior watercolor): drawn from its text style as before
  const s = await styleGate({ ...base, jobId: 'j-senior', profile: 'senior_longform', example: async () => null })
  assert.equal(s.wait, true); assert.deepEqual([text, seen.length], [1, 1])
})
