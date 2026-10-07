// Longform scene render (Senior / 숨은야담) in SEGMENTS: a 45~120 minute video no longer goes through one ffmpeg process
// holding every scene picture (it hit the worker's 1 GB and was SIGKILLed). Proven here with real ffmpeg and stand-in
// pictures / narration (no paid call):
//  - the segmented MP4 is the single-graph MP4: same frames (pictures, motion, subtitle cards, cold open), audio = the
//    narration stream itself (stream copy), 1920x1080 SAR 1:1 30 fps yuv420p, exact length, no black frame at a seam
//  - a longer video = more segments, never more pictures per ffmpeg process (45 / 90 / 120 min plans)
//  - a failure at segment N resumes at N (segments 1..N-1 are reused, never rendered again)
//  - a job that FAILED at RENDER is retried as the SAME job: RENDER only, no PLAN / IMAGE / TTS call, -> COMPLETE
// Run: node --import tsx --test tools/longform-chunked-render.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryBlobStore, createVercelJobBlobStore, putAddressed, sha256 } from '../lib/jobs/blobs.js'
import { runOk, probe, detectBlack } from '../lib/media/ffmpeg.js'
import { FONTS_DIR } from '../lib/media/ass.js'
import { createLongformRenderExecutor, longformPackageExecutor, withLongform } from '../worker/stages/longform.js'
import { LONGFORM, cardTimeline, longformCardsAss, sentencesOf } from '../lib/generative/longform.js'
import { RENDER_SEGMENT, planSegments, runFrames, sceneRuns, sceneSegmentArgv, seniorVideoArgv } from '../lib/generative/seniorLongform.js'
import { yasaScenesFor, YASA_ACTS, COLD_OPEN } from '../lib/generative/yasaLongform.js'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { runOnce } from '../worker/runJob.js'

const card = (k: number) => ({ show: ['썩은 메주를', `지고 간 날 ${k}`], accent: '썩은 메주', color: 'red' })
// a stand-in 숨은야담 script: a 4-beat cold open over main-story pictures, then `scenes` scenes x 2 sentences
function standIn(scenes: number, perSentence: number) {
  const sc = Array.from({ length: scenes }, (_, i) => ({ id: `s${i + 1}`, place: `p${i}`, time: 't', characters: ['bride'], action: `a${i}`, mood: 'm', visual: `v${i}` }))
  let k = 0
  const sections = [0, 1].map((a) => { const own = sc.slice(a * scenes / 2, (a + 1) * scenes / 2); return { id: `a${a + 1}`, heading: `h${a}`, scenes: own, sentences: own.flatMap((s) => [0, 1].map(() => ({ say: `며느리는 썩은 메주를 끝까지 지고 갔다 ${++k}`, scene: s.id, ...card(k) }))) } })
  const coldOpen = { sentences: [2, 5, 1, 7].map((i) => ({ say: `시어머니가 메주를 내밀었다 ${i}`, scene: sc[i].id, ...card(100 + i) })) }
  const script: any = { schema: 'yasa-longform-script/1', title: '5년 만에 친정 가는 며느리에게 썩은 메주만 지워 보낸 시어머니, 그 이유', hook: 'h', figure: { name: 'n', imagePrompt: 'p' }, thumbnail: { lines: [{ text: '썩은 메주', color: 'red' }, { text: '비밀', color: 'white' }] }, metadata: { description: '시집온 뒤 5년 동안 친정에 가지 못한 며느리가 있었습니다. 시어머니는 선물 대신 썩은 메주 한 덩이만 지워 보냈습니다. 길 위에서 쫓겨나고 도둑으로 몰리면서도 며느리는 그 짐을 내려놓지 않았습니다. 마지막에 밝혀지는 시어머니의 진짜 마음과 메주 속에 숨겨진 물건이 무엇이었는지, 그리고 그 물건이 친정 식구들을 어떻게 지켜 냈는지 끝까지 확인해 보세요. 조선 후기 한 양반가에서 전해 내려오는 이야기를 바탕으로 다시 구성했습니다.', tags: ['조선 야담', '며느리 이야기', '시어머니 사연', '메주 이야기', '숨은 야담', '고부 갈등', '조선 후기'], hashtags: ['#숨은야담', '#야담', '#조선이야기'], pinnedComment: '여러분이라면 썩은 메주를 받은 며느리처럼 끝까지 지고 갔을까요?' }, characters: [], coldOpen, sections }
  const n = sentencesOf(script).length
  return { script, sc, n, seconds: n * perSentence }
}
async function fixture(o: { scenes: number; perSentence: number }) {
  const d = await mkdtemp(join(tmpdir(), 'chunked-')), blobs: any = createMemoryBlobStore()
  const { script, sc, n, seconds } = standIn(o.scenes, o.perSentence)
  const images: any[] = []
  for (const [i, s] of sc.entries()) {
    const f = join(d, `p${i}.jpg`), hue = (i * 360) / sc.length
    await runOk(['-y', '-f', 'lavfi', '-i', `color=c=red:s=1536x1024,hue=h=${hue.toFixed(0)}:s=${i % 2 ? 0.6 : 1},drawgrid=w=96:h=96:t=6:c=white@0.8`, '-frames:v', '1', '-q:v', '3', f])
    const b = await readFile(f), ref = `generative-assets/images/${sha256(b)}.jpg`; await blobs.putBytes(ref, b, 'image/jpeg')
    images.push({ sceneId: s.id, ref, sha256: sha256(b) })
  }
  // the narration exactly as the ASSET stage makes it (aac 160k, 44.1 kHz, stereo), a tone that changes every sentence
  const nar = join(d, 'narration.m4a')
  await runOk(['-y', '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*(220+40*mod(floor(t/${o.perSentence}),7))*t)':s=44100:d=${seconds}`, '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', nar])
  const narRef = `generative-assets/audio/${sha256(await readFile(nar))}.m4a`; await blobs.putBytes(narRef, await readFile(nar), 'audio/mp4')
  const scriptRef = (await putAddressed(blobs, 'generative-scripts', script)).path
  const chunks = Array.from({ length: n }, (_, k) => ({ index: k, sentences: [k], seconds: o.perSentence }))
  const assets = await putAddressed(blobs, 'generative-assets', { schema: 'longform-assets/1', scriptRef, image: { ref: images[0].ref }, images, narration: { ref: narRef, seconds }, chunks })
  return { d, blobs, script, assetsRef: assets.path, images, nar, seconds, chunks }
}
const ctxOf = (fx: any, id = 'job_chunk') => ({ job: { id, profile: 'yasa_longform', planRev: 1 }, blobs: fx.blobs, previous: async (st: string) => (st === 'ASSET' ? { result: { assetSpecRef: fx.assetsRef } } : null), signal: new AbortController().signal } as any)
const gray = async (f: string, t: number) => (await runOk(['-ss', t.toFixed(3), '-i', f, '-frames:v', '1', '-vf', 'scale=192:108,format=gray', '-f', 'rawvideo', '-'])).stdout
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length }
const packetMd5 = async (f: string) => (await runOk(['-i', f, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'])).stdout.toString().trim()

test('SEGMENTED = SINGLE GRAPH: same frames at every scene and every seam (cold open, motion, subtitles); narration copied as is; format unchanged', async () => {
  const fx = await fixture({ scenes: 8, perSentence: 0.4 })
  const seen: string[][] = []
  const ex = createLongformRenderExecutor({ features: () => new Set(['LONGFORM_RENDER', 'CAPTION', 'QC']) as any, segment: { maxRuns: 4, maxSeconds: 9999 }, segmentRunner: (argv: string[], opts: any) => { seen.push(argv); return runOk(argv, opts) } })
  const r: any = await ex.run(ctxOf(fx))
  const seg = r.result.segments
  assert.ok(seg.segments >= 3 && seg.made === seg.segments && seg.reused === 0, JSON.stringify(seg))
  assert.ok(seen.every((a) => a.filter((x) => x === '-i').length <= 4), 'at most 4 pictures per ffmpeg process here')
  const out = join(fx.d, 'segmented.mp4'); await writeFile(out, await fx.blobs.getBytes(r.result.variants[0].renderRef))
  const info = await probe(out)
  assert.deepEqual([info.width, info.height, info.sar, info.fps, info.pixFmt, info.videoCodec, info.audioCodec, info.sampleRate, info.channels], [1920, 1080, '1:1', 30, 'yuv420p', 'h264', 'aac', 44100, 2])
  assert.ok(Math.abs(Number(info.duration) - fx.seconds) < 0.1, `${info.duration} vs ${fx.seconds}`)
  const frames = Number((await runOk(['-i', out, '-map', '0:v', '-c', 'copy', '-f', 'null', '-'])).stderr.match(/frame=\s*(\d+)/g)!.pop()!.replace(/\D/g, ''))
  assert.equal(frames, Math.round(fx.seconds * LONGFORM.fps), 'frame-exact: no frame lost or doubled at a seam')
  assert.equal(await packetMd5(out), await packetMd5(fx.nar), 'the audio IS the narration (stream copy, no seam in the sound)')
  assert.deepEqual(await detectBlack(out, { minDuration: 0.05 }), [], 'no black frame at a seam')
  // the old single-graph render of the same assets
  const tl = cardTimeline(fx.script, fx.chunks, fx.chunks.map((c: any) => c.seconds)), spans = sceneRuns(fx.script, tl)
  const files: string[] = []; for (const [i, x] of fx.images.entries()) { const f = join(fx.d, `in${i}.jpg`); await writeFile(f, await fx.blobs.getBytes(x.ref)); files.push(f) }
  const runs = spans.map((s, i) => ({ image: fx.images.findIndex((x: any) => x.sceneId === s.sceneId), seconds: (i === spans.length - 1 ? fx.seconds : spans[i + 1].start) - s.start, ...(s.cold ? { cold: true } : {}) }))
  const ass = join(fx.d, 'all.ass'); await writeFile(ass, longformCardsAss(fx.script, tl, 'bottom').ass)
  const single = join(fx.d, 'single.mp4')
  await runOk(seniorVideoArgv({ images: files, runs, audio: fx.nar, ass, fontsDir: FONTS_DIR, out: single, seconds: fx.seconds, threads: 4 }))
  // compare: the middle of every scene run, and just before / after every seam
  const seams = planSegments(runs.map((x) => ({ seconds: x.seconds, cold: !!x.cold })), { maxRuns: 4, maxSeconds: 9999 }).slice(1).map((g) => spans[g.from].start)
  const times = [...spans.map((s, i) => (s.start + (i === spans.length - 1 ? fx.seconds : spans[i + 1].start)) / 2), ...seams.flatMap((t) => [t - 0.2, t + 0.2])]
  const diffs = []
  for (const t of times) diffs.push(Number(mad(await gray(out, t), await gray(single, t)).toFixed(2)))
  assert.ok(Math.max(...diffs) < 4, `frames differ: ${JSON.stringify(diffs)}`)
  // the cold open is in the FIRST segment, all of it, with its stronger motion (and setsar)
  assert.equal(seen[0].filter((x) => x === '-i').length, 4); assert.ok(seen[0].join(' ').includes('1+0.16*t') && seen[0].join(' ').includes(',setsar=1,fps='))
  assert.ok(seen.slice(1).every((a) => !a.join(' ').includes('1+0.16*t')), 'no cold-open motion outside the first segment')
})

test('MEMORY CONTRACT: 45 / 90 / 120 min plans — more segments, never more pictures per ffmpeg process; cold open in segment 1', () => {
  const plan = (minutes: number) => {
    const t = minutes * 60, perAct = yasaScenesFor(t).map((r) => r.max), pictures = perAct.reduce((a, b) => a + b, 0)
    const cold = Array.from({ length: COLD_OPEN.beats.max }, () => ({ seconds: COLD_OPEN.seconds.max / COLD_OPEN.beats.max, cold: true }))
    const main = YASA_ACTS.flatMap((a, i) => Array.from({ length: perAct[i] }, () => ({ seconds: (t * a.share) / perAct[i] })))
    const runs = [...cold, ...main], segs = planSegments(runs)
    return { minutes, runs: runs.length, pictures, segs, maxRuns: Math.max(...segs.map((g) => g.to - g.from)), maxSec: Math.max(...segs.map((g) => runs.slice(g.from, g.to).reduce((a, r) => a + r.seconds, 0))), coldInFirst: segs[0].to >= cold.length }
  }
  const rows = [45, 60, 90, 120].map(plan)
  console.log('SEGMENT_PLANS ' + JSON.stringify(rows.map(({ segs, ...x }) => ({ ...x, segments: segs.length }))))
  for (const r of rows) {
    assert.ok(r.maxRuns <= RENDER_SEGMENT.maxRuns, `${r.minutes}: ${r.maxRuns} pictures in one process`)
    assert.ok(r.maxSec <= RENDER_SEGMENT.maxSeconds + 1e-6, `${r.minutes}: ${r.maxSec}s in one process`)
    assert.ok(r.coldInFirst, `${r.minutes}: the whole cold open is in segment 1`)
    assert.ok(r.segs.every((g, i) => i === 0 || g.from === r.segs[i - 1].to) && r.segs.at(-1)!.to === r.runs, 'segments cover every run once, in order')
  }
  const [m45, , m90, m120] = rows
  assert.ok(m90.segs.length > m45.segs.length && m120.segs.length > m90.segs.length, 'a longer video = more segments')
  assert.ok(m90.runs > RENDER_SEGMENT.maxRuns * 3, '90 min: the whole video would never fit one process')
  // the argv of one segment carries only its own pictures (the 90-minute video as one graph would carry all of them)
  const argv = sceneSegmentArgv({ images: Array.from({ length: m90.runs }, (_, i) => `p${i}.jpg`), runs: [0, 1, 2].map((i) => ({ image: i, frames: 300, index: i })), ass: 'a.ass', fontsDir: 'f', out: 'o.mp4', threads: 4 })
  assert.equal(argv.filter((x) => x === '-i').length, 3); assert.ok(argv.includes('-an') && argv.includes('-frames:v'))
  assert.deepEqual(runFrames([0, 1.016, 2.033, 3.05], 4.1), [30, 31, 31, 31], 'cumulative rounding: frames add up to round(total*fps)')
})

test('RESUME: a failure at segment 3 -> the retry renders 3.. only (1-2 reused); the cache is the job\'s render-segments/', async () => {
  const fx = await fixture({ scenes: 8, perSentence: 0.4 })
  const calls: number[] = []
  let fail = true
  const runner = (argv: string[], opts: any, index: number) => { calls.push(index); if (index === 2 && fail) { fail = false; return Promise.reject(Object.assign(new Error('ffmpeg killed (SIGKILL)'), { code: 'FFMPEG_KILLED' })) } return runOk(argv, opts) }
  const ex = () => createLongformRenderExecutor({ features: () => new Set(['LONGFORM_RENDER', 'CAPTION', 'QC']) as any, segment: { maxRuns: 3, maxSeconds: 9999 }, segmentRunner: runner })
  await assert.rejects(() => ex().run(ctxOf(fx, 'job_resume')), /SIGKILL/)
  assert.deepEqual(calls, [0, 1, 2])
  const stored = [...fx.blobs.binaries.keys()].filter((k: string) => k.startsWith('render-segments/job_resume/'))
  assert.equal(stored.length, 2, 'segments 1 and 2 were kept')
  calls.length = 0
  const r: any = await ex().run(ctxOf(fx, 'job_resume'))
  assert.deepEqual(calls[0], 2, 'the retry starts at the failed segment'); assert.ok(!calls.includes(0) && !calls.includes(1), 'segments 1-2 never rendered again')
  assert.equal(r.result.segments.reused, 2); assert.equal(r.result.segments.made, r.result.segments.segments - 2)
  calls.length = 0
  const again: any = await ex().run(ctxOf(fx, 'job_resume'))
  assert.deepEqual(calls, [], 'a full rerun renders no segment at all'); assert.equal(again.result.segments.reused, again.result.segments.segments)
})

test('SAME-JOB RETRY: a Longform FAILED at RENDER is rendered again as the same job (no PLAN / IMAGE / TTS call) -> COMPLETE', async () => {
  const fx = await fixture({ scenes: 8, perSentence: 0.4 })
  const db = await createTestDb(), store = createJobStore(db, { maxAttempts: 2, retryBackoffMs: () => 0 }), KEY = 'r'.repeat(32)
  ;(fx.blobs as any).presign = async (ref: string) => ({ url: `memory://${ref}`, validUntil: 'x' })
  const handler = createJobsHttp({ getStore: async () => store, blobs: fx.blobs, sourceExists: async () => true })
  const call = async (method: string, opts: { body?: any; query?: any } = {}) => {
    let status = 0, json: any = null
    const req: any = { method, headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: opts.query || {}, body: opts.body }
    const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }
    await handler(req, res); return { status, json }
  }
  const created = await call('POST', { body: { taskType: 'job_create', profile: 'yasa_longform', idempotencyKey: 'yadam-retry-0001', budgetUsd: 5, input: { kind: 'topic', text: '썩은 메주를 지워 보낸 시어머니', targetSeconds: 2700 } } })
  assert.equal(created.status, 201); const jobId = created.json.job.id
  // PLAN and ASSET already succeeded (the paid steps) — stand-ins that count their calls
  const paid = { PLAN: 0, ASSET: 0 }
  const plan = { stage: 'PLAN', estimateUsd: () => 0, inputHash: () => 'p', run: async () => { paid.PLAN++; return { result: { scriptRef: (fx.script && (await putAddressed(fx.blobs, 'generative-scripts', fx.script)).path) } } } } as any
  const asset = { stage: 'ASSET', estimateUsd: () => 0, inputHash: () => 'a', run: async () => { paid.ASSET++; return { outputRef: fx.assetsRef, result: { assetSpecRef: fx.assetsRef } } } } as any
  const broken = createLongformRenderExecutor({ features: () => new Set(['LONGFORM_RENDER', 'CAPTION', 'THUMBNAIL', 'QC']) as any, segment: { maxRuns: 3, maxSeconds: 9999 }, segmentRunner: async (_a: string[], _o: any, i: number) => { if (i >= 1) throw new Error('ffmpeg exit null: SIGKILL'); return runOk(_a, _o) } })
  const tick = (render: any) => runOnce({ store, blobs: fx.blobs, executors: withLongform([], [plan, asset, render, longformPackageExecutor]), resolveSourceAsset: async () => { throw new Error('none') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 } as any)
  for (let i = 0; i < 6; i++) { const r: any = await tick(broken); if (!r.ran) break }
  let job = (await call('GET', { query: { taskType: 'job_get', id: jobId } })).json.job
  assert.deepEqual([job.status, job.stage], ['FAILED', 'RENDER'], JSON.stringify(job))
  assert.deepEqual(paid, { PLAN: 1, ASSET: 1 })
  // "영상 제작 다시 시도": the same job, RENDER only
  const retry = await call('POST', { body: { taskType: 'job_retry_render', jobId } })
  assert.equal(retry.status, 200, JSON.stringify(retry.json)); assert.deepEqual([retry.json.job.id, retry.json.job.status, retry.json.job.stage], [jobId, 'QUEUED', 'RENDER'])
  const renders: number[] = []
  const healthy = createLongformRenderExecutor({ features: () => new Set(['LONGFORM_RENDER', 'CAPTION', 'THUMBNAIL', 'QC']) as any, segment: { maxRuns: 3, maxSeconds: 9999 }, segmentRunner: (a: string[], o: any, i: number) => { renders.push(i); return runOk(a, o) } })
  for (let i = 0; i < 6; i++) { const r: any = await tick(healthy); if (!r.ran) break }
  job = (await call('GET', { query: { taskType: 'job_get', id: jobId } })).json.job
  assert.equal(job.status, 'COMPLETE', JSON.stringify(job)); assert.equal(job.id, jobId)
  assert.deepEqual(paid, { PLAN: 1, ASSET: 1 }, 'no PLAN / IMAGE / TTS call on the retry')
  assert.ok(!renders.includes(0), 'segment 1 (made before the failure) is reused')
  const pk = (await call('GET', { query: { taskType: 'job_package', id: jobId } })).json
  assert.match(pk.videoUrl, /^memory:\/\/renders\/.+\.mp4$/)
  // only a Longform FAILED at RENDER with PLAN + ASSET done can be retried this way
  assert.equal((await call('POST', { body: { taskType: 'job_retry_render', jobId } })).status, 409, 'a COMPLETE job is not retried')
  assert.equal((await call('POST', { body: { taskType: 'job_retry_render', jobId: 'job_nope' } })).status, 404)
})

test('a stored segment comes back to disk as a STREAM (the worker never holds a whole segment in memory)', async () => {
  const d = await mkdtemp(join(tmpdir(), 'getfile-')), body = Buffer.alloc(3 * 1024 * 1024, 7)
  const store = createVercelJobBlobStore({ put: async () => ({}), get: async (p: string) => (p === 'render-segments/j/h/segment-001.mp4' ? { statusCode: 200, stream: new Blob([body]).stream() } : { statusCode: 404 }) } as any)
  assert.equal(await store.getFile!('render-segments/j/h/segment-001.mp4', join(d, 'a.mp4')), true)
  assert.ok((await readFile(join(d, 'a.mp4'))).equals(body))
  assert.equal(await store.getFile!('render-segments/j/h/segment-002.mp4', join(d, 'b.mp4')), false, 'not there -> rendered')
})
