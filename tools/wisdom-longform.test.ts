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
import { uploadMetadataErrors } from '../lib/generative/uploadPackage.js'
import { standInPortrait, measureThumbnail, assertThumbnail } from './thumbnailMeasure.js'
import { LONGFORM, ACCENTS, validateLongformScript, normalizeLongformBrief, ttsChunks, cardTimeline, sentencesOf, longformCardsAss, type LongformScript } from '../lib/generative/longform.js'
import { putAddressed } from '../lib/jobs/blobs.js'

const KEY = 'k'.repeat(32)
const S = (say: string, show: string[], accent: string, color: any) => ({ say, show, accent, color })
// the shape the planner returns (a short sample with the full Longform structure)
const SAMPLE: LongformScript = {
  schema: 'wisdom-longform-script/1',
  title: '만만하게 보이지 않는 사람들의 5가지 태도', hook: '사람에게 만만하게 보이는 순간, 관계는 달라집니다.',
  figure: { name: 'Seneca', imagePrompt: 'the Roman Stoic philosopher Seneca, elderly, short white beard, wearing a simple dark toga, calm and stern gaze' },
  thumbnail: { lines: [{ text: '절대', color: 'red' }, { text: '만만하게', color: 'purple' }, { text: '보이지 마라', color: 'green' }] },
  metadata: {
    description: '친절한데도 늘 손해만 보는 사람과, 조용한데도 함부로 대하지 못하는 사람은 무엇이 다를까요? 스토아 철학자 세네카의 말을 바탕으로 부탁에 바로 답하지 않기, 변명을 줄이기, 경계를 지키면서도 다정함을 잃지 않는 법을 일상 장면으로 풀어 봅니다. 관계에서 자꾸 지치는 분이라면 오늘 영상에서 나를 지키는 기준 하나를 가져가 보세요.',
    tags: ['세네카', '스토아 철학', '만만해 보이는 사람', '거절하는 법', '자존감 높이기', '인간관계 경계', '호구 탈출', '부탁 거절', '착한 사람 콤플렉스', '관계 스트레스'],
    hashtags: ['세네카', '스토아철학', '인간관계', '자존감'],
    pinnedComment: '부탁을 받으면 바로 대답하시는 편인가요, 아니면 잠시 멈추시나요? 만만하게 보였다고 느낀 순간이 있다면 댓글로 나눠 주세요.'
  },
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
  const n = [...text].length, sec = (n / LONGFORM.charsPerSecond) * (0.6 + 0.8 * ((n * 7) % 5) / 4)
  const r = await runOk(['-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:d=0.25`, '-f', 'lavfi', '-i', `sine=f=${200 + (n % 7) * 40}:d=${sec.toFixed(2)}`, '-filter_complex', '[0][1]concat=n=2:v=0:a=1,volume=0.5', '-c:a', 'libmp3lame', '-f', 'mp3', '-'])
  return { bytes: r.stdout, contentType: 'audio/mpeg', provider: 'standin', model: 'tone' }
}
// sentence onsets in the final narration: silence -> sound transitions of the MP4's own audio track
async function audioOnsets(mp4: string): Promise<number[]> {
  const pcm = (await runOk(['-i', mp4, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'])).stdout, win = 80 // 10 ms
  const out: number[] = []; let silent = 0
  for (let i = 0; i + win * 2 <= pcm.length; i += win * 2) {
    let e = 0; for (let k = i; k < i + win * 2; k += 2) e += Math.abs(pcm.readInt16LE(k))
    const loud = e / win > 300
    if (loud && silent >= 10) out.push(Number(((i / 2) / 8000).toFixed(2)))
    silent = loud ? 0 : silent + 1
  }
  return out
}
// card changes in the final video: left-column picture changes sampled at 20 fps
async function cardChanges(mp4: string): Promise<number[]> {
  const W = 96, H = 54, raw = (await runOk(['-i', mp4, '-vf', `fps=20,crop=1150:1080:0:0,scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'])).stdout, F = W * H
  const out: number[] = []
  for (let f = 1; f * F + F <= raw.length; f++) { let d = 0; for (let k = 0; k < F; k++) d += Math.abs(raw[f * F + k] - raw[(f - 1) * F + k]); if (d / F > 6) out.push(Number((f / 20).toFixed(2))) }
  return out.filter((t, i, a) => i === 0 || t - a[i - 1] > 0.3)
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

const SAMPLE_BRIEF = () => normalizeLongformBrief({ kind: 'topic', text: '만만하게 보이지 않는 사람들의 태도', targetSeconds: 50, sample: true })
const clone = (x: any) => JSON.parse(JSON.stringify(x))
// a script whose narration is ~n seconds (repeats the sample sentences with distinct numbering)
function scriptOfSeconds(n: number) {
  const s = clone(SAMPLE), base = sentencesOf(SAMPLE), out: any[] = []
  let k = 0
  while ([...out.map((x) => x.say).join(' ')].length / LONGFORM.charsPerSecond < n) { const b = base[k % base.length]; out.push({ ...b, say: `${b.say} (${k + 1})` }); k++ }
  s.sections = [{ id: 's1', sentences: out }]
  return s
}

test('Longform contract (Astra cases): length, 2-3 line cards, coloured accent, no fade, real-audio timing', () => {
  const brief = SAMPLE_BRIEF()
  assert.deepEqual(validateLongformScript(SAMPLE, brief), [])
  // target selection remains 20-30 minutes; final production narration is allowed to breathe naturally inside 15-35 minutes.
  const prod = normalizeLongformBrief({ kind: 'topic', text: '나이 들수록 멀리해야 할 사람' })
  assert.equal(prod.targetSeconds, 1500); assert.equal(prod.sample, undefined)
  assert.throws(() => normalizeLongformBrief({ kind: 'topic', text: '주제입니다', targetSeconds: 900 }))
  assert.throws(() => normalizeLongformBrief({ kind: 'topic', text: '주제입니다', targetSeconds: 60 })) // short only as an explicit sample
  assert.ok(validateLongformScript(scriptOfSeconds(800), prod).some((e) => /^length/.test(e)), 'clearly short output must be rejected')
  assert.ok(!validateLongformScript(scriptOfSeconds(900), prod).some((e) => /^length/.test(e)), '15-minute result is allowed')
  assert.ok(!validateLongformScript(scriptOfSeconds(1500), prod).some((e) => /^length/.test(e)), '25-minute result passes')
  assert.ok(validateLongformScript(scriptOfSeconds(2200), prod).some((e) => /^length/.test(e)), 'runaway output must be rejected')
  // cards: 1 line, no accent, white accent, accent not on the card, a line too wide -> rejected
  const card = (mut: (x: any) => void) => { const s = clone(SAMPLE); mut(s.sections[0].sentences[0]); return validateLongformScript(s, brief) }
  assert.ok(card((x) => { x.show = ['사람에게'] ; x.accent = '사람에게' }).some((e) => /show\.lines/.test(e)))
  assert.ok(card((x) => { x.accent = '' }).some((e) => /accent\.missing/.test(e)))
  assert.ok(card((x) => { x.color = 'white' }).some((e) => /color\.not_accent/.test(e)))
  assert.ok(card((x) => { x.accent = '없는 말' }).some((e) => /accent\.not_in_show/.test(e)))
  assert.ok(card((x) => { x.show = ['사람에게 만만하게 보이는 그 순간', '관계는 달라진다'] }).some((e) => /show\.too_wide/.test(e)))
  // no fade in the drawn cards
  const chunks = ttsChunks(SAMPLE)
  const secs = chunks.map((c, i) => 1 + (i % 3) * 1.7) // deliberately NOT proportional to the characters
  const tl = cardTimeline(SAMPLE, chunks, secs)
  const { ass } = longformCardsAss(SAMPLE, tl)
  assert.doesNotMatch(ass, /\\fad|\\fade|\\t\(/)
  // timing: one narration chunk per sentence; card k starts exactly where sentence k's measured audio starts
  assert.deepEqual(chunks.map((c) => c.sentences), sentencesOf(SAMPLE).map((_, k) => [k]))
  assert.equal(chunks.map((c) => c.text).join(' '), sentencesOf(SAMPLE).map((x) => x.say).join(' '))
  let acc = 0
  tl.forEach((t, i) => { assert.equal(t.start, Number(acc.toFixed(3))); acc += secs[i] })
  // a merged / reordered / repeated chunk list is refused
  assert.throws(() => cardTimeline(SAMPLE, [{ sentences: [0, 1] }, ...chunks.slice(2)], [1, ...secs.slice(2)]))
  assert.throws(() => cardTimeline(SAMPLE, [chunks[1], chunks[0], ...chunks.slice(2)], secs))
  // upload text: the old generic text is rejected at PLAN
  const generic = { ...clone(SAMPLE), metadata: { description: SAMPLE.sections[0].sentences.map((x) => x.say).join(' '), tags: ['만만하게', '보이지', '사람들의', '지혜', '인생', '철학'], hashtags: ['지혜', '인생', '철학'], pinnedComment: '오늘 이야기에서 가장 마음에 남은 문장은 무엇인가요? 여러분의 생각도 댓글로 남겨주세요.' } }
  const ge = validateLongformScript(generic, brief)
  for (const k of ['upload.description.copies_script', 'upload.hashtags.fixed_set', 'upload.pinnedComment.generic']) assert.ok(ge.includes(k), `${k}: ${ge}`)
})

test('one gate for every path: no model -> PROVIDER_DOWN; a 3-second script never passes PLAN; PACKAGE needs upload text', async () => {
  const blobs: any = createMemoryBlobStore()
  const brief = await putAddressed(blobs, 'generative-briefs', normalizeLongformBrief({ kind: 'text', text: '짧은 글입니다. 이것으로 롱폼을 만들어 주세요.', targetSeconds: 1500 }))
  const job: any = { id: 'j', profile: 'wisdom_longform', planRef: brief.path }
  const ctx = { job, blobs, previous: async () => null, signal: new AbortController().signal } as any
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: '' }).run(ctx), (e: any) => e.code === 'PROVIDER_DOWN')
  const tiny = clone(SAMPLE); tiny.sections = [{ id: 's1', sentences: [SAMPLE.sections[0].sentences[0]] }] // ~3 seconds
  let calls = 0
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', plan: async () => { calls++; return clone(tiny) } }).run(ctx), (e: any) => e.code === 'SCRIPT_INVALID' && /length/.test(e.message))
  assert.equal(calls, 2) // the draft and its one repair, both rejected
  // PACKAGE refuses a script whose upload text does not pass
  const bad = await putAddressed(blobs, 'generative-scripts', { ...clone(SAMPLE), metadata: { description: 'x', tags: [], hashtags: [], pinnedComment: '' } })
  await assert.rejects(() => longformPackageExecutor.run({ job, blobs, signal: new AbortController().signal, previous: async (st: string) => st === 'RENDER' ? { result: { variants: [{ renderRef: 'renders/a.mp4', thumbnailRef: 'renders/t.jpg' }] } } : { result: { scriptRef: bad.path } } } as any), (e: any) => e.code === 'UPLOAD_PACKAGE_INVALID')
})

test('B1: the FINAL voiced narration must be inside 20-30 minutes exactly (RENDER executor path); sample keeps its band', async () => {
  const run = async (seconds: number, briefIn: any, audio?: Buffer) => {
    const blobs: any = createMemoryBlobStore()
    const brief = await putAddressed(blobs, 'generative-briefs', normalizeLongformBrief(briefIn))
    const script = await putAddressed(blobs, 'generative-scripts', SAMPLE)
    const n = sentencesOf(SAMPLE).length
    await blobs.putBytes('img/x.jpg', Buffer.from('not-an-image'), 'image/jpeg'); await blobs.putBytes('aud/x.m4a', audio ?? Buffer.from('not-audio'), 'audio/mp4')
    const assets = await putAddressed(blobs, 'generative-assets', { schema: 'longform-assets/1', scriptRef: script.path, image: { ref: 'img/x.jpg' }, narration: { ref: 'aud/x.m4a', seconds }, chunks: Array.from({ length: n }, (_, k) => ({ index: k, sentences: [k], seconds: seconds / n })) })
    try {
      await longformRenderExecutor.run({ job: { id: 'j', profile: 'wisdom_longform', planRef: brief.path }, blobs, signal: new AbortController().signal, previous: async () => ({ result: { assetSpecRef: assets.path } }) } as any)
      return 'rendered'
    } catch (e: any) {
      if (e.code === 'LONGFORM_CONTRACT' && /^narration \d/.test(e.message)) return 'LENGTH_FAIL' // chunk-sum gate
      if (e.code === 'LONGFORM_CONTRACT' && /^narration audio:/.test(e.message)) return 'AUDIO_FAIL' // probed audio-file gate
      return `past length gates (${e.code || 'error'})`
    }
  }
  const prod = { kind: 'topic', text: '나이 들수록 멀리해야 할 사람' }
  const rows: any = {}
  for (const sec of [899, 899.9, 2100.1, 2101]) { rows[sec] = await run(sec, prod); assert.equal(rows[sec], 'LENGTH_FAIL', `${sec}s must fail`) }
  for (const sec of [900, 1081, 1500, 1979, 2100]) { rows[sec] = await run(sec, prod); assert.notEqual(rows[sec], 'LENGTH_FAIL', `${sec}s must pass the length gate`) }
  // explicit sample brief: its own band (target 50s -> 42.5-57.5s), unchanged
  const sample = { kind: 'topic', text: '만만하게 보이지 않는 사람들의 태도', targetSeconds: 50, sample: true }
  rows['sample 45'] = await run(45, sample); assert.notEqual(rows['sample 45'], 'LENGTH_FAIL')
  rows['sample 60'] = await run(60, sample); assert.equal(rows['sample 60'], 'LENGTH_FAIL')
  console.log('B1 ' + JSON.stringify(rows))
  // B1-final: the probed duration of the actual narration file, same contract, no rounding/tolerance.
  // The chunk sum is kept in range (1500s) so only the audio-file gate decides.
  const wav = async (sec: number) => (await runOk(['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', sec.toFixed(3), '-c:a', 'pcm_u8', '-f', 'wav', '-'])).stdout
  const probed: any = {}
  for (const [sec, expect] of [[899.9, 'AUDIO_FAIL'], [900.0, 'PASS'], [1500.0, 'PASS'], [2100.0, 'PASS'], [2100.1, 'AUDIO_FAIL']] as const) {
    const audio = await wav(sec), d = await mkdtemp(join(tmpdir(), 'b1a-')); await writeFile(join(d, 'a.wav'), audio)
    const measured = (await probe(join(d, 'a.wav'))).duration
    const got = await run(1500, prod, audio)
    probed[sec] = { probed: measured, result: got }
    assert.equal(measured, sec, `probe reads ${sec}s exactly`)
    if (expect === 'PASS') assert.ok(/^past length gates/.test(got), `${sec}s audio must pass: ${got}`)
    else assert.equal(got, expect, `${sec}s audio must fail`)
  }
  // the chunk-sum gate still applies even when the audio file is in range
  assert.equal(await run(2200, prod, await wav(1500)), 'LENGTH_FAIL')
  // sample brief keeps its band on the audio file too (target 50s -> 42.5-57.5s)
  const sample2 = { kind: 'topic', text: '만만하게 보이지 않는 사람들의 태도', targetSeconds: 50, sample: true }
  probed['sample 45 audio'] = await run(45, sample2, await wav(45)); assert.ok(/^past length gates/.test(probed['sample 45 audio']))
  probed['sample 57.6 audio'] = await run(45, sample2, await wav(57.6)); assert.equal(probed['sample 57.6 audio'], 'AUDIO_FAIL')
  console.log('B1_AUDIO ' + JSON.stringify(probed))
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
  const created = await call('POST', { body: { taskType: 'job_create', profile: 'wisdom_longform', idempotencyKey: 'lf-sample-0001', budgetUsd: 5, input: { kind: 'topic', text: '만만하게 보이지 않는 사람들의 태도', targetSeconds: 50, sample: true, aspectRatio: '16:9' } } })
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
  assert.equal(imageCalls, 1, 'exactly ONE image per video'); assert.equal(ttsCalls, sentencesOf(SAMPLE).length, 'one narration call per sentence')

  const pk = (await call('GET', { query: { taskType: 'job_package', id: jobId } })).json
  for (const k of ['title', 'description', 'tags', 'hashtags', 'pinnedComment']) assert.ok(pk.upload[k] && String(pk.upload[k]).length, k)
  assert.deepEqual(uploadMetadataErrors({ ...pk.upload, description: pk.upload.description.split('\n\n#')[0] }, { narration: sentencesOf(SAMPLE).map((x) => x.say).join(' '), format: 'longform' }), [])
  console.log('EXAMPLE_B ' + JSON.stringify(pk.upload))
  if (process.env.LONGFORM_SAMPLE_OUT) { mkdirSync(process.env.LONGFORM_SAMPLE_OUT, { recursive: true }); writeFileSync(join(process.env.LONGFORM_SAMPLE_OUT, 'upload-example-B-longform.json'), JSON.stringify({ topic: '만만하게 보이지 않는 사람들의 태도', format: 'Wisdom Longform', upload: pk.upload, thumbnailLines: SAMPLE.thumbnail.lines }, null, 2)) }
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
  // audio-video sync measured on the MP4: every sentence onset (after the 0.25s lead-in) has a card change at its start
  const onsets = await audioOnsets(mp4), changes = await cardChanges(mp4)
  const sync = tl.slice(1).map((t) => { const onset = onsets.find((o) => Math.abs(o - (t.start + 0.25)) < 0.2) ?? null; const change = changes.find((c) => Math.abs(c - t.start) < 0.15) ?? null; return { cardStart: t.start, voiceOnset: onset, cardChange: change } })
  ;(report as any).sync = sync
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
  assert.ok(sync.every((x) => x.voiceOnset !== null && x.cardChange !== null), `every card changes where its sentence is voiced: ${JSON.stringify(sync)}`)
  assert.ok(lines.every((l) => l.length >= 2 && l.length <= 3), 'every card 2-3 lines')
})
