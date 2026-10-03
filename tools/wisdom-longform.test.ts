// Wisdom Longform end to end through the real API + worker loop (runOnce): job_create -> PLAN -> ASSET -> RENDER ->
// PACKAGE -> job_package, then the FINAL MP4 and thumbnail are measured from pixels/audio. Paid providers (planner,
// image, TTS) are replaced by local stand-ins with the same shapes; every other line is the production code path.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { runOnce } from '../worker/runJob.js'
import { runOk, probe } from '../lib/media/ffmpeg.js'
import { withLongform, createLongformPlanExecutor, createLongformAssetExecutor, longformRenderExecutor, longformPackageExecutor } from '../worker/stages/longform.js'
import { PIPELINES } from '../lib/jobs/pipeline.js'
import { standInPortrait, measureThumbnail, assertThumbnail } from './thumbnailMeasure.js'
import { LONGFORM, ACCENTS, validateLongformScript, normalizeLongformBrief, ttsChunks, cardTimeline, sentencesOf, type LongformScript } from '../lib/generative/longform.js'

const KEY = 'k'.repeat(32)
const S = (say: string, show: string[], accent: string, color: any) => ({ say, show, accent, color })
// the shape the planner returns (a short sample with the full Longform structure)
const SAMPLE: LongformScript = {
  schema: 'wisdom-longform-script/1',
  title: '만만하게 보이지 않는 사람들의 5가지 태도', hook: '사람에게 만만하게 보이는 순간, 관계는 달라집니다.',
  figure: { name: 'Seneca', imagePrompt: 'the Roman Stoic philosopher Seneca, elderly, short white beard, wearing a simple dark toga, calm and stern gaze' },
  thumbnail: { lines: [{ text: '절대', color: 'red' }, { text: '만만하게', color: 'purple' }, { text: '보이지 마라', color: 'green' }] },
  metadata: { description: '사람에게 만만하게 보이지 않는 사람들은 무엇이 다를까요? 세네카의 지혜로 관계의 균형을 지키는 태도를 이야기합니다.', tags: ['지혜', '인간관계', '세네카', '스토아철학', '자존감', '인생조언', '철학', '명언'], hashtags: ['지혜', '인간관계', '세네카'], pinnedComment: '여러분은 어떤 순간에 만만하게 보였다고 느끼셨나요? 댓글로 나눠주세요.' },
  sections: [
    { id: 's1', sentences: [
      S('사람에게 만만하게 보이는 순간, 관계는 조용히 달라지기 시작합니다.', ['사람에게', '만만하게 보이는 순간', '관계는 달라진다'], '만만하게 보이는 순간', 'red'),
      S('처음에는 배려였던 행동이 어느새 당연한 의무가 되어 버리죠.', ['배려가', '당연한 의무가 될 때'], '당연한 의무', 'purple'),
      S('세네카는 말했습니다. 자신을 존중하지 않는 사람은 타인에게도 존중받지 못한다고.', ['자신을 존중하지 않으면', '존중받지 못한다'], '존중받지 못한다', 'yellow')
    ] },
    { id: 's2', sentences: [
      S('첫 번째 태도는 모든 부탁에 즉시 대답하지 않는 것입니다.', ['첫 번째', '즉시 대답하지 않는다'], '즉시 대답하지 않는다', 'green'),
      S('잠시 멈추는 그 몇 초가 당신의 시간을 지켜 줍니다.', ['멈추는 몇 초가', '당신을 지킨다'], '멈추는 몇 초', 'red'),
      S('두 번째 태도는 설명을 길게 늘어놓지 않는 것입니다.', ['두 번째', '변명하지 않는다'], '변명하지 않는다', 'purple')
    ] },
    { id: 's3', sentences: [
      S('하지만 단단한 사람은 차갑지 않습니다. 오히려 누구보다 따뜻합니다.', ['단단한 사람은', '차갑지 않다'], '차갑지 않다', 'green'),
      S('경계를 지킬 줄 아는 사람만이 오래 다정할 수 있기 때문입니다.', ['경계를 지키는 사람만', '오래 다정하다'], '오래 다정하다', 'yellow')
    ] }
  ]
}

const sample = (d: string) => async () => SAMPLE
// image stand-in: a lit bust on the LEFT of a dark frame (the ASSET must mirror it to the right)
async function standInImage(d: string) {
  const p = join(d, 'portrait.jpg')
  await standInPortrait(p, { side: 'left', tint: [205, 160, 110], bg: [26, 18, 12] }) // figure on the LEFT: must be mirrored
  return (await import('node:fs/promises')).readFile(p)
}
// TTS stand-in: speech-length tone (chars / pace) with short pauses, mp3 like the OpenAI voice
const standInTts = async (text: string) => {
  const sec = [...text].length / LONGFORM.charsPerSecond
  const r = await runOk(['-f', 'lavfi', '-i', `sine=f=220:d=${sec.toFixed(2)}`, '-af', 'volume=0.4', '-c:a', 'libmp3lame', '-f', 'mp3', '-'])
  return { bytes: r.stdout, contentType: 'audio/mpeg', provider: 'standin', model: 'tone' }
}

async function frameRgb(path: string, t: number, w: number, h: number) {
  return (await runOk(['-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-vf', `scale=${w}:${h},format=rgb24`, '-f', 'rawvideo', '-'])).stdout
}
const madRegion = (a: Buffer, b: Buffer, w: number, x0: number, x1: number, y0: number, y1: number) => { let s = 0, n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const o = (y * w + x) * 3; s += Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]); n += 3 } return s / n }
// pixels close to an accent colour inside a region
function accentPixels(f: Buffer, w: number, x0: number, x1: number, y0: number, y1: number) {
  const out: Record<string, number> = { red: 0, purple: 0, green: 0, yellow: 0, white: 0 }
  const ref = Object.entries(ACCENTS).map(([k, hex]) => [k, parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * w + x) * 3; for (const [k, r, g, b] of ref) if (Math.abs(f[o] - r) + Math.abs(f[o + 1] - g) + Math.abs(f[o + 2] - b) < 60) out[k]++ }
  return out
}
// text rows on the left column (bright glyph pixels on the darkened side): number of text lines and their height
function textLines(f: Buffer, w: number, h: number) {
  const rows: number[] = []
  for (let y = 0; y < h; y++) { let c = 0; for (let x = 60; x < Math.round(w * 0.6); x++) { const o = (y * w + x) * 3; if (f[o] + f[o + 1] + f[o + 2] > 450 || Math.max(f[o], f[o + 1], f[o + 2]) - Math.min(f[o], f[o + 1], f[o + 2]) > 140) c++ } rows.push(c) }
  const lines: Array<[number, number]> = []
  rows.forEach((c, k) => { if (c > 6) { const l = lines[lines.length - 1]; if (l && k - l[1] <= 8) l[1] = k; else lines.push([k, k]) } })
  return lines.filter(([a, b]) => b - a >= 20)
}

test('wisdom_longform is a separate pipeline; Shorts pipelines are unchanged', () => {
  assert.deepEqual(PIPELINES.wisdom, ['PLAN', 'ASSET', 'ANALYZE', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE'])
  assert.deepEqual(PIPELINES.wisdom_longform, ['PLAN', 'ASSET', 'RENDER', 'PACKAGE'])
  // routing: a Shorts job never reaches a Longform executor
  const calls: string[] = []
  const shorts: any = { stage: 'PLAN', estimateUsd: () => 1, inputHash: () => 's', run: async () => { calls.push('shorts'); return {} } }
  const lf: any = { stage: 'PLAN', estimateUsd: () => 2, inputHash: () => 'l', run: async () => { calls.push('longform'); return {} } }
  const [r] = withLongform([shorts], [lf])
  r.run({ job: { profile: 'wisdom' } } as any); r.run({ job: { profile: 'wisdom_longform' } } as any)
  assert.deepEqual(calls, ['shorts', 'longform'])
  assert.equal(r.estimateUsd({ profile: 'wisdom' } as any), 1)
})

test('script contract: sentences, 1-3 line cards with an accent inside, length sized to the target', () => {
  const brief = normalizeLongformBrief({ kind: 'topic', text: '만만하게 보이지 않는 사람들의 태도', targetSeconds: 60 })
  assert.deepEqual(validateLongformScript(SAMPLE, brief), [])
  assert.throws(() => normalizeLongformBrief({ kind: 'topic', text: '주제', targetSeconds: 1500 }))
  assert.equal(normalizeLongformBrief({ kind: 'topic', text: '나이 들수록 멀리해야 할 사람' }).targetSeconds, 1500)
  const bad = JSON.parse(JSON.stringify(SAMPLE)); bad.sections[0].sentences[0].accent = '없는 말'
  assert.ok(validateLongformScript(bad, brief).some((e) => /accent/.test(e)))
  // TTS chunks keep every sentence once, in order
  const chunks = ttsChunks(SAMPLE, 80)
  assert.ok(chunks.length > 1)
  assert.deepEqual(chunks.flatMap((c) => c.sentences), sentencesOf(SAMPLE).map((_, k) => k))
  assert.equal(chunks.map((c) => c.text).join(' '), sentencesOf(SAMPLE).map((x) => x.say).join(' '))
  const tl = cardTimeline(SAMPLE, chunks, chunks.map(() => 5))
  for (let k = 1; k < tl.length; k++) assert.equal(tl[k].start, tl[k - 1].end)
})

test('REAL RUN: job_create -> PLAN -> ASSET -> RENDER -> PACKAGE -> final 16:9 MP4 + thumbnail measured', async () => {
  const d = await mkdtemp(join(tmpdir(), 'longform-e2e-'))
  const db = await createTestDb(), store = createJobStore(db), blobs = createMemoryBlobStore()
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  const call = async (method: string, opts: { body?: any; query?: any } = {}) => {
    let status = 0, json: any = null
    const req: any = { method, headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: opts.query || {}, body: opts.body }
    const res: any = { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } }
    await handler(req, res); return { status, json }
  }
  ;(blobs as any).presign = async (ref: string) => ({ url: `memory://${ref}`, validUntil: 'x' })
  const created = await call('POST', { body: { taskType: 'job_create', profile: 'wisdom_longform', idempotencyKey: 'lf-sample-0001', budgetUsd: 5, input: { kind: 'topic', text: '만만하게 보이지 않는 사람들의 태도', targetSeconds: 60, aspectRatio: '16:9' } } })
  assert.equal(created.status, 201, JSON.stringify(created.json)); const jobId = created.json.job.id
  assert.equal(created.json.job.stage, 'PLAN')

  let imageCalls = 0, ttsCalls = 0
  const img = await standInImage(d)
  const executors = withLongform([], [
    createLongformPlanExecutor({ apiKey: 'k', plan: sample(d) as any }),
    createLongformAssetExecutor({ apiKey: 'k', image: async () => { imageCalls++; return { bytes: img, contentType: 'image/jpeg', provider: 'standin', model: 'still' } }, tts: async (t: string) => { ttsCalls++; return standInTts(t) } }),
    longformRenderExecutor, longformPackageExecutor
  ])
  for (let i = 0; i < 8; i++) { const r = await runOnce({ store, blobs, executors, resolveSourceAsset: async () => { throw new Error('longform has no source asset') }, workerId: 'w1', leaseMs: 600_000, heartbeatMs: 3_600_000 }); if (!r.ran) break; assert.ok(r.ran && r.outcome === 'completed', JSON.stringify(r)) }
  const job = (await call('GET', { query: { taskType: 'job_get', id: jobId } })).json.job
  assert.equal(job.status, 'COMPLETE', JSON.stringify(job.runs)); assert.equal(job.final.publishable, true)
  assert.equal(imageCalls, 1, 'exactly ONE image per video')

  const pk = (await call('GET', { query: { taskType: 'job_package', id: jobId } })).json
  for (const k of ['title', 'description', 'tags', 'hashtags', 'pinnedComment']) assert.ok(pk.upload[k] && String(pk.upload[k]).length, k)
  assert.match(pk.thumbnailUrl, /^memory:\/\/renders\/.+\.jpg$/); assert.match(pk.videoUrl, /^memory:\/\/renders\/.+\.mp4$/)
  const preview = (await call('GET', { query: { taskType: 'job_preview', id: jobId } })).json.previews
  assert.equal(preview.length, 1); assert.equal(preview[0].publishable, true)

  // ---- the FINAL MP4 ----
  const mp4 = join(d, 'final.mp4'), thumb = join(d, 'thumbnail.jpg')
  await writeFile(mp4, blobs.binaries.get(pk.package.finalRenderRef)!); await writeFile(thumb, blobs.binaries.get(pk.package.thumbnailRef)!)
  const info = await probe(mp4), tinfo = await probe(thumb)
  const W = 1920, H = 1080
  const runs = await store.listStageRuns(jobId)
  const assets: any = await blobs.getJson((runs.find((r: any) => r.stage === 'ASSET' && r.status === 'SUCCEEDED')!.result as any).assetSpecRef)
  const script: any = SAMPLE
  const tl = cardTimeline(script, assets.chunks, assets.chunks.map((c: any) => c.seconds))
  // sample frames: the middle of every card
  const shots: any[] = []
  for (const t of tl) { const f = await frameRgb(mp4, (t.start + t.end) / 2, W, H); shots.push({ t: Number(((t.start + t.end) / 2).toFixed(2)), text: sentencesOf(script)[t.k].show.join(' / '), f }) }
  const first = shots[0].f
  const imageStill = shots.map((s) => Number(madRegion(first, s.f, W, Math.round(W * 0.66), W, 0, H).toFixed(3)))
  const textChange = shots.slice(1).map((s, k) => Number(madRegion(shots[k].f, s.f, W, 60, Math.round(W * 0.6), 0, H).toFixed(2)))
  const lines = shots.map((s) => textLines(s.f, W, H))
  const accents = shots.map((s) => accentPixels(s.f, W, 60, Math.round(W * 0.6), 0, H))
  // figure side: brightness/detail of the right vs the left column of the picture (frame without text: thumbnail-free region)
  const lum = (f: Buffer, x0: number, x1: number) => { let s = 0, n = 0; for (let y = 0; y < H; y += 4) for (let x = x0; x < x1; x += 4) { const o = (y * W + x) * 3; s += f[o] + f[o + 1] + f[o + 2]; n++ } return s / n / 3 }
  const tf = (await runOk(['-i', thumb, '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'rawvideo', '-'])).stdout
  const pic = join(d, 'picture.jpg'); await writeFile(pic, blobs.binaries.get(assets.image.ref)!)
  const picRgb = (await runOk(['-i', pic, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=rgb24', '-f', 'rawvideo', '-'])).stdout
  const thumbM = measureThumbnail(tf, picRgb, SAMPLE.thumbnail.lines as any)
  const thumbAccents = thumbM.accent, thumbLines = thumbM.lineHeights
  const report = {
    jobId, stages: runs.filter((r: any) => r.status === 'SUCCEEDED').map((r: any) => r.stage), mp4: { w: info.width, h: info.height, duration: info.duration, hasAudio: info.hasAudio, narrationSeconds: assets.narration.seconds },
    imageCalls, ttsCalls, chunks: assets.chunks.length, mirrored: assets.image.mirrored, subjectSide: assets.image.subjectSide,
    rightColumnLum: Number(lum(first, Math.round(W * 0.66), W).toFixed(1)), leftColumnLumNoText: null,
    imageStillMaxMad: Math.max(...imageStill), textChangeMad: textChange, linesPerCard: lines.map((l) => l.length), lineHeights: lines.map((l) => l.map(([a, b]) => b - a + 1)),
    accentPixelsPerCard: accents.map((a) => Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== 'white' && v > 200))),
    cards: tl.map((t) => [t.start, t.end]), thumbnail: { w: tinfo.width, h: tinfo.height, ...thumbM }
  }
  console.log('LONGFORM_REPORT ' + JSON.stringify(report))
  const out = process.env.LONGFORM_SAMPLE_OUT
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'wisdom-longform-sample.mp4'), blobs.binaries.get(pk.package.finalRenderRef)!); writeFileSync(join(out, 'wisdom-longform-thumbnail.jpg'), blobs.binaries.get(pk.package.thumbnailRef)!); writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, package: pk.upload }, null, 2)) }

  assert.deepEqual([info.width, info.height], [1920, 1080]) // 16:9
  assert.ok(info.hasAudio && Math.abs(Number(info.duration) - assets.narration.seconds) < 1.0, 'narration only, full length')
  assert.equal(assets.image.mirrored, true, 'a figure on the left is mirrored to the right')
  assert.ok(Math.max(...imageStill) < 1.5, `image fixed for the whole video: ${imageStill}`)
  assert.ok(textChange.every((m) => m > 2), `left text changes card to card: ${textChange}`)
  assert.ok(lines.every((l) => l.length >= 1 && l.length <= 3), `1-3 text lines per card: ${lines.map((l) => l.length)}`)
  assert.ok(lines.every((l) => l.every(([a, b]) => b - a + 1 >= 60)), `large text: ${JSON.stringify(report.lineHeights)}`)
  assert.ok(accents.every((a) => Object.entries(a).some(([k, v]) => k !== 'white' && v > 400)), `every card has a coloured key phrase: ${JSON.stringify(report.accentPixelsPerCard)}`)
  assert.ok(accents.every((a) => a.white > 2000), 'the rest of the card is white')
  assert.deepEqual([tinfo.width, tinfo.height], [1280, 720])
  assertThumbnail(thumbM, 'longform'); void thumbAccents; void thumbLines
})
