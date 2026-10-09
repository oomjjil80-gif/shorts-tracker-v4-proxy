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
import { withLongform, createLongformPlanExecutor, createLongformAssetExecutor, longformRenderExecutor, createLongformRenderExecutor, longformPackageExecutor } from '../worker/stages/longform.js'
import { PIPELINES } from '../lib/jobs/pipeline.js'
import { uploadMetadataErrors } from '../lib/generative/uploadPackage.js'
import { standInPortrait, measureThumbnail, assertThumbnail } from './thumbnailMeasure.js'
import { LONGFORM, ACCENTS, validateLongformScript, normalizeLongformBrief, ttsChunks, cardTimeline, sentencesOf, longformCardsAss, type LongformScript } from '../lib/generative/longform.js'
import { putAddressed } from '../lib/jobs/blobs.js'

const KEY = 'k'.repeat(32)
// derived Shorts are tested in tools/wisdom-derived-shorts.test.ts; here the deriver makes no call and proposes nothing
const NO_DERIVE = async () => ({ ideas: [] })
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

// a stored-free research stand-in (no paid web search in tests): enough fragments for any number of sections
async function fakeResearch({ topic, sections }: { topic: string; sections: number }) {
  const fragments = Array.from({ length: sections * 2 }, (_, k) => ({ id: `f${k + 1}`, type: 'traditional_story' as const, claim: `claim ${k + 1}`, story: `story ${k + 1}`, sourceTitle: 'Source', sourceUrl: `https://www.accesstoinsight.org/f${k + 1}.html`, confidence: 'medium' as const, usableAsDirectBuddhaQuote: false, storyValue: 3 }))
  return { bundle: { topic, model: 'gpt-6-luna', researchedAt: '2026-01-01T00:00:00Z', fragments, sectionMap: Array.from({ length: sections }, (_, i) => ({ section: i + 1, fragmentIds: [`f${2 * i + 1}`, `f${2 * i + 2}`], purpose: `part ${i + 1}` })) }, requests: 1, webSearchCalls: 1 }
}

// A planner (outline -> sections -> upload text) that serves a fixed script, split into exactly the number of sections
// the PLAN asks for. Counts every call so checkpoint reuse can be proven.
function plannerFromScript(script: any, calls: Record<string, number> = {}) {
  const bump = (k: string) => { calls[k] = (calls[k] || 0) + 1 }
  const sents = script.sections.flatMap((x: any) => x.sentences)
  const split = (n: number) => Array.from({ length: n }, (_, i) => sents.slice(Math.floor((i * sents.length) / n), Math.floor(((i + 1) * sents.length) / n)))
  return {
    outline: async (_b: any, n: number) => { bump('outline'); return { title: script.title, hook: script.hook, figure: script.figure, thumbnail: script.thumbnail, sections: split(n).map((_, i) => ({ id: `s${i + 1}`, heading: `part ${i + 1}`, points: ['a', 'b'] })) } },
    section: async (i: any) => { bump('section'); return { sentences: JSON.parse(JSON.stringify(split(i.outline.sections.length)[i.index])) } },
    metadata: async () => { bump('metadata'); return { title: script.title, ...script.metadata } }
  }
}
const sample = (d: string) => plannerFromScript(SAMPLE)
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

test('Longform contract: running time is only a target (never pass/fail), 2-3 line cards, coloured accent, no fade, real-audio timing', () => {
  const brief = SAMPLE_BRIEF()
  assert.deepEqual(validateLongformScript(SAMPLE, brief), [])
  // the running time the user picks is accepted as is (no 20-30 minute window); only non-positive / non-numbers are refused
  const prod = normalizeLongformBrief({ kind: 'topic', text: '나이 들수록 멀리해야 할 사람' })
  assert.equal(prod.targetSeconds, 1500); assert.equal(prod.sample, undefined)
  for (const t of [60, 900, 1500, 2700, 3600, 5400, 7200, 10800]) assert.equal(normalizeLongformBrief({ kind: 'topic', text: '주제입니다', targetSeconds: t }).targetSeconds, t)
  for (const t of [0, -60, 'abc', NaN, Infinity]) assert.throws(() => normalizeLongformBrief({ kind: 'topic', text: '주제입니다', targetSeconds: t }), /positive/)
  // a script shorter or longer than the target is never rejected for its length
  for (const sec of [300, 800, 1500, 2200, 4000]) assert.ok(!validateLongformScript(scriptOfSeconds(sec), prod).some((e) => /length/.test(e)), `${sec}s script must not fail on length`)
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

test('one gate for every path: no model -> PROVIDER_DOWN; a broken section never passes PLAN; PACKAGE needs upload text', async () => {
  const blobs: any = createMemoryBlobStore()
  const brief = await putAddressed(blobs, 'generative-briefs', normalizeLongformBrief({ kind: 'text', text: '짧은 글입니다. 이것으로 롱폼을 만들어 주세요.', targetSeconds: 1500 }))
  const job: any = { id: 'j', profile: 'wisdom_longform', planRef: brief.path }
  const ctx = { job, blobs, previous: async () => null, signal: new AbortController().signal } as any
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: '' }).run(ctx), (e: any) => e.code === 'PROVIDER_DOWN')
  // a section whose cards break the contract is rejected after its one free repair (retryable: the retry resumes)
  const calls: Record<string, number> = {}
  const broken = plannerFromScript(SAMPLE, calls)
  broken.section = async () => { calls.section = (calls.section || 0) + 1; return { sentences: [{ say: '말', show: ['한 줄'], accent: '', color: 'white' }] } as any }
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: fakeResearch, log: () => {}, planner: broken as any }).run(ctx), (e: any) => e.code === 'SECTION_INVALID' && e.retryable === true)
  assert.equal(calls.section, 2) // the draft and its one repair, both rejected
  // PACKAGE refuses a script whose upload text does not pass
  const bad = await putAddressed(blobs, 'generative-scripts', { ...clone(SAMPLE), metadata: { description: 'x', tags: [], hashtags: [], pinnedComment: '' } })
  await assert.rejects(() => longformPackageExecutor.run({ job, blobs, signal: new AbortController().signal, previous: async (st: string) => st === 'RENDER' ? { result: { variants: [{ renderRef: 'renders/a.mp4', thumbnailRef: 'renders/t.jpg' }] } } : { result: { scriptRef: bad.path } } } as any), (e: any) => e.code === 'UPLOAD_PACKAGE_INVALID')
})

test('RENDER never fails on the running time (chunk sum or probed narration file); 60-minute target with 53 or 68 minutes passes', async () => {
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
      if (/narration|length|minute|outside/i.test(String(e.message)) && e.code === 'LONGFORM_CONTRACT') return `DURATION_FAIL ${e.message}`
      return `past duration (${e.code || 'error'})` // the stand-in image is not a real image, so the render itself stops later
    }
  }
  const sixty = { kind: 'topic', text: '부처님이 말하는 마음 다스리는 법', targetSeconds: 3600 }
  const rows: any = {}
  for (const sec of [60, 899, 1500, 2101, 3180, 3600, 4080, 7200, 9000]) { rows[sec] = await run(sec, sixty); assert.ok(rows[sec].startsWith('past duration'), `${sec}s: ${rows[sec]}`) }
  // the probed duration of the actual narration file is not a gate either (53 and 68 minutes for a 60-minute target)
  const wav = async (sec: number) => (await runOk(['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', sec.toFixed(3), '-c:a', 'pcm_u8', '-f', 'wav', '-'])).stdout
  for (const sec of [3180, 4080]) { rows[`audio ${sec}`] = await run(sec, sixty, await wav(sec)); assert.ok(rows[`audio ${sec}`].startsWith('past duration'), rows[`audio ${sec}`]) }
  console.log('NO_DURATION_GATE ' + JSON.stringify(rows))
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
    createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: fakeResearch, log: () => {}, planner: sample(d) as any }),
    createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk', image: async () => { imageCalls++; return { bytes: img, contentType: 'image/jpeg', provider: 'standin', model: 'still' } }, tts: async (t: string) => { ttsCalls++; return standInTts(t) } }),
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
  // the Longform thumbnail IS the video title (exact words, wrapped, inside the frame) on the video's own picture
  const { composeTitleThumbnail } = await import('../lib/generative/titleThumbnail.js')
  const expected = await composeTitleThumbnail({ background: blobs.binaries.get(assets.image.ref)!, title: SAMPLE.title })
  assert.equal(expected.lines.join(' '), SAMPLE.title, 'the title, word for word'); assert.ok(expected.ink.x0 >= 32 && expected.ink.x1 <= 1248 && expected.ink.y0 >= 28 && expected.ink.y1 <= 692, JSON.stringify(expected.ink))
  assert.ok((await (await import('node:fs/promises')).readFile(thumb)).equals(expected.bytes), 'the delivered thumbnail is exactly that composition')
  void thumbM; void assertThumbnail; void thumbAccents; void thumbLines
  assert.ok(sync.every((x) => x.voiceOnset !== null && x.cardChange !== null), `every card changes where its sentence is voiced: ${JSON.stringify(sync)}`)
  assert.ok(lines.every((l) => l.length >= 2 && l.length <= 3), 'every card 2-3 lines')
})

// ======================= running time / Voice Profile / long-run stability =======================
import { sectionPlan, longformFigure, BUDDHA_FIGURE, longformImagePrompt } from '../lib/generative/longform.js'
import { LONGFORM_PLANNER_VERSION, longformRenderTimeoutMs, longformConcatTimeoutMs } from '../worker/stages/longform.js'
import { resolveLongformRuntimeVoice } from '../lib/generative/voiceProfile.js'
import { resolveCreativeProfile, briefVoice } from '../lib/generative/creativeProfile.js'
// the Longform voice through the common Creative resolver, in the shape these tests compare
const resolveLongformVoice = (choice: any, topic: string, voiceTone?: any, voiceSpeed?: any) => { const r = resolveCreativeProfile('wisdom_longform', { voiceProfile: choice, voiceTone, voiceSpeed }, topic); return { choice: r.requested.voiceProfile, key: r.resolved.voiceProfile, profileId: r.resolved.voiceProfileId, tone: r.resolved.voiceTone, speed: r.resolved.voiceSpeed } }
const longformVoiceProfile = (brief: any) => briefVoice(brief, 'wisdom_longform')
import { DEFAULT_VOICE_PROFILE, LONGFORM_VOICE_PROFILES, recommendLongformVoice, ttsCacheIdentity } from '../lib/generative/voiceProfile.js'
import { openAiTts, openAiWisdomTts } from '../lib/generative/providers.js'
import { thumbnailFigure } from '../lib/generative/wisdomThumbnail.js'
import { createHash } from 'node:crypto'

// a planner that writes ANY number of valid sections (for 60-120 minute outlines), counting each call
function longPlanner(calls: Record<string, number>, failAt?: { index: number; times: number }) {
  const base = sentencesOf(SAMPLE)
  return {
    outline: async (_b: any, n: number) => { calls.outline = (calls.outline || 0) + 1; return { title: SAMPLE.title, hook: SAMPLE.hook, figure: { name: 'a wise man', imagePrompt: 'an old Western sage in a cloak' }, thumbnail: SAMPLE.thumbnail, sections: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, heading: `part ${i + 1}`, points: ['a', 'b'] })) } },
    section: async (i: any) => {
      calls.section = (calls.section || 0) + 1; calls[`section${i.index + 1}`] = (calls[`section${i.index + 1}`] || 0) + 1
      if (failAt && i.index === failAt.index && failAt.times-- > 0) throw new Error('provider timeout')
      return { sentences: base.slice(0, 3).map((x, k) => ({ ...x, say: `${x.say} (${i.index + 1}-${k + 1})` })) }
    },
    metadata: async () => { calls.metadata = (calls.metadata || 0) + 1; return { title: SAMPLE.title, ...SAMPLE.metadata } }
  }
}
async function planJob(targetSeconds: number, extra: any = {}) {
  const blobs: any = createMemoryBlobStore()
  const brief = normalizeLongformBrief({ kind: 'topic', text: '부처님이 말하는 마음 다스리는 법', targetSeconds, ...extra })
  const stored = await putAddressed(blobs, 'generative-briefs', brief)
  return { blobs, brief, ctx: { job: { id: 'j', profile: 'wisdom_longform', planRef: stored.path }, blobs, previous: async () => null, signal: new AbortController().signal } as any }
}

for (const minutes of [25, 60, 120]) test(`T${minutes === 25 ? 1 : minutes === 60 ? 2 : 3}: ${minutes}-minute targetSeconds reaches PLAN (job_create -> brief -> planner outline/sections)`, async () => {
  // through the real API: the chosen running time is stored in the brief unchanged
  const db = await createTestDb(), store = createJobStore(db), blobs: any = createMemoryBlobStore()
  const handler = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async () => true })
  let status = 0, json: any = null
  await handler({ method: 'POST', headers: { origin: 'https://shorts-production-tracker.vercel.app', 'x-sync-key': KEY }, query: {}, body: { taskType: 'job_create', profile: 'wisdom_longform', idempotencyKey: `lf-runtime-${minutes}`, budgetUsd: 5, input: { kind: 'topic', text: '부처님이 말하는 마음 다스리는 법', targetSeconds: minutes * 60, voiceProfile: 'female-middle', aspectRatio: '16:9' } } } as any,
    { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } } as any)
  assert.equal(status, 201, JSON.stringify(json))
  const job = await store.getJob(json.job.id, json.job.workspaceId ?? undefined as any) ?? json.job
  const brief: any = await blobs.getJson(job.planRef ?? json.job.planRef)
  assert.equal(brief.targetSeconds, minutes * 60); assert.equal(brief.creative.resolved.voiceProfile, 'female-middle')
  // PLAN sizes the script from it: section count and per-section length
  const seen: any[] = [], calls: Record<string, number> = {}
  const planner: any = longPlanner(calls)
  const outline = planner.outline; planner.outline = async (b: any, n: number) => { seen.push({ target: b.targetSeconds, n }); return outline(b, n) }
  const section = planner.section; planner.section = async (i: any) => { seen.push({ chars: i.targetChars }); return section(i) }
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: fakeResearch, log: () => {}, planner }).run({ job: { id: 'j', profile: 'wisdom_longform', planRef: job.planRef ?? json.job.planRef }, blobs, signal: new AbortController().signal } as any)
  const size = sectionPlan(minutes * 60)
  assert.deepEqual(seen[0], { target: minutes * 60, n: size.sections })
  assert.equal(seen[1].chars, size.charsPerSection)
  assert.equal(out.result.targetSeconds, minutes * 60); assert.equal(out.result.sections, size.sections)
})

test('T4-T6: no duration reason ever fails a Longform script/result (60-minute target: 53 and 68 minutes)', () => {
  const sixty = normalizeLongformBrief({ kind: 'topic', text: '부처님 말씀', targetSeconds: 3600 })
  for (const minutes of [53, 68, 10, 150]) assert.deepEqual(validateLongformScript(scriptOfSeconds(minutes * 60), sixty).filter((e) => /length|second|minute/.test(e)), [], `${minutes} min`)
  // long runs get time to finish instead of a fixed 90-minute cap
  assert.equal(longformRenderTimeoutMs(1500), 90 * 60_000)
  assert.ok(longformRenderTimeoutMs(7200) >= 7200_000 + 30 * 60_000)
  assert.ok(longformRenderTimeoutMs(10800) > longformRenderTimeoutMs(7200))
  assert.ok(longformConcatTimeoutMs(1500) >= 15 * 60_000); assert.ok(longformConcatTimeoutMs(10800) > longformConcatTimeoutMs(1500))
})

const mp3Tone = async () => (await runOk(['-f', 'lavfi', '-i', 'sine=f=300:d=0.4', '-c:a', 'libmp3lame', '-f', 'mp3', '-'])).stdout
async function assetFixture(voiceProfile?: string) {
  const d = await mkdtemp(join(tmpdir(), 'lf-voice-'))
  const blobs: any = createMemoryBlobStore()
  const brief = await putAddressed(blobs, 'generative-briefs', normalizeLongformBrief({ kind: 'topic', text: '부처님이 말하는 마음 다스리는 법', targetSeconds: 3600, ...(voiceProfile ? { voiceProfile } : {}) }))
  const script = await putAddressed(blobs, 'generative-scripts', SAMPLE)
  return { d, blobs, brief, ctx: (b: any = blobs, ref = brief.path) => ({ job: { id: 'j', profile: 'wisdom_longform', planRev: 1, planRef: ref }, blobs: b, previous: async () => ({ result: { scriptRef: script.path } }), signal: new AbortController().signal } as any) }
}

test('T7: the female-middle Voice Profile reaches the real TTS provider request (voice + instructions)', async () => {
  const fx = await assetFixture('female-middle'), tone = await mp3Tone(), bodies: any[] = []
  const fakeFetch: any = async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(new Uint8Array(tone), { status: 200 }) }
  const img = await standInImage(fx.d)
  const out: any = await createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk', image: async () => ({ bytes: img, contentType: 'image/jpeg', provider: 's', model: 'm' }), tts: (t, k, p) => openAiTts(t, k, p, fakeFetch) }).run(fx.ctx())
  // a new job: the female-middle voice with the default tone (calm) and speed (1.0)
  const want = resolveLongformRuntimeVoice({ voiceKey: 'female-middle', tone: 'calm', speed: 1 })
  assert.equal(bodies.length, sentencesOf(SAMPLE).length)
  for (const b of bodies) { assert.equal(b.voice, want.voice); assert.equal(b.instructions, want.instructions); assert.equal(b.model, want.model); assert.equal(b.speed, want.speed) }
  assert.match(want.instructions, /^40~50대 한국 여성.*차분한 호흡으로 읽어주세요\.$/)
  assert.equal(out.result.voiceProfileId, 'ko-lf-female-middle-calm-1.0-v2')
  assert.equal(((await fx.blobs.getJson(out.result.assetSpecRef)) as any).voiceProfileId, 'ko-lf-female-middle-calm-1.0-v2')
})

test('T8 + T13: TTS cache is per Voice Profile; an ASSET retry reuses the ONE image and every narration chunk', async () => {
  const fx = await assetFixture('female-middle'), tone = await mp3Tone(), img = await standInImage(fx.d)
  const calls = { image: 0, tts: [] as string[] }
  const deps = { apiKey: 'k', imageKey: 'gk', image: async () => { calls.image++; return { bytes: img, contentType: 'image/jpeg', provider: 's', model: 'm' } }, tts: async (_t: string, _k: string, p: any) => { calls.tts.push(p.id); return { bytes: Buffer.concat([tone, Buffer.from(p.id)]), contentType: 'audio/mpeg', provider: 's', model: 'm' } } }
  const n = sentencesOf(SAMPLE).length
  const first: any = await createLongformAssetExecutor(deps).run(fx.ctx())
  assert.equal(calls.image, 1); assert.equal(calls.tts.length, n) // T10: exactly ONE image
  const retry: any = await createLongformAssetExecutor(deps).run(fx.ctx())
  assert.equal(calls.image, 1); assert.equal(calls.tts.length, n); assert.equal(retry.result.reused, n + 1); assert.equal(retry.result.generated, 0)
  // the same script with ANOTHER voice never reuses the female-middle audio
  const other = await putAddressed(fx.blobs, 'generative-briefs', normalizeLongformBrief({ kind: 'topic', text: '부처님이 말하는 마음 다스리는 법', targetSeconds: 3600, voiceProfile: 'male-senior' }))
  await createLongformAssetExecutor(deps).run(fx.ctx(fx.blobs, other.path))
  assert.equal(calls.tts.length, 2 * n); assert.ok(calls.tts.slice(n).every((id) => id === 'ko-lf-male-senior-calm-1.0-v2'))
  assert.equal(calls.image, 1) // the image is not voice-dependent: still reused
  const text = sentencesOf(SAMPLE)[0].say
  assert.notEqual(ttsCacheIdentity(LONGFORM_VOICE_PROFILES['female-middle'], text), ttsCacheIdentity(LONGFORM_VOICE_PROFILES['male-senior'], text))
})

test('T9: Wisdom Shorts voice and cache identity are unchanged; legacy Longform briefs keep the default voice', async () => {
  const bodies: any[] = []
  const fakeFetch: any = async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(Buffer.from('x'), { status: 200 }) }
  await openAiWisdomTts('같은 문장', 'k', fakeFetch)
  assert.deepEqual({ voice: bodies[0].voice, instructions: bodies[0].instructions, speed: bodies[0].speed, model: bodies[0].model }, { voice: 'marin', instructions: '한국어로 차분하고 따뜻하게, 과장하지 말고 또렷하게 읽어주세요.', speed: 1, model: 'gpt-4o-mini-tts' })
  assert.equal(ttsCacheIdentity(DEFAULT_VOICE_PROFILE, '문장'), 'tts-v1|문장') // the Shorts/legacy cache key format
  assert.equal(longformVoiceProfile({} as any), DEFAULT_VOICE_PROFILE)
  // the Wisdom Shorts ASSET narrates with the voice resolved at job_create: AUTO (and a brief from before Creative
  // Settings) is the house voice itself -> the same request as openAiWisdomTts and the same tts-v1 key
  const { normalizeGenerativeBrief } = await import('../lib/generative/contracts.js')
  for (const brief of [normalizeGenerativeBrief({ kind: 'topic', text: '나이 들수록 말을 아끼는 이유', targetSeconds: 40 }), {}]) {
    const v = briefVoice(brief as any, 'wisdom')
    assert.equal(v, DEFAULT_VOICE_PROFILE); assert.equal(ttsCacheIdentity(v, '문장'), 'tts-v1|문장')
  }
  const gen = (await import('node:fs')).readFileSync(new URL('../worker/stages/generative.ts', import.meta.url), 'utf8')
  assert.match(gen, /ak=sha256\(ttsCacheIdentity\(voice,b\.narration\)\)/); assert.match(gen, /au=await tts\(b\.narration,apiKey,voice\)/)
})

test('Voice Profile choices: UI keys only (provider values live in voiceProfile.ts); auto picks ONE profile from the topic', () => {
  assert.deepEqual(Object.keys(LONGFORM_VOICE_PROFILES), ['male-young', 'male-middle', 'male-senior', 'female-young', 'female-middle', 'female-senior'])
  assert.equal(new Set(Object.values(LONGFORM_VOICE_PROFILES).map((p) => p.id)).size, 6)
  assert.equal(recommendLongformVoice('부처님이 말하는 마음 다스리는 법'), 'male-senior')
  assert.equal(recommendLongformVoice('쇼펜하우어의 인생론'), 'male-middle')
  assert.equal(recommendLongformVoice('지친 마음을 위로하는 말'), 'female-middle')
  assert.deepEqual(resolveLongformVoice('auto', '부처님 말씀'), { choice: 'auto', key: 'male-senior', profileId: 'ko-lf-male-senior-calm-1.0-v2', tone: 'calm', speed: 1 })
  assert.deepEqual(resolveLongformVoice('female-middle', '부처님 말씀'), { choice: 'female-middle', key: 'female-middle', profileId: 'ko-lf-female-middle-calm-1.0-v2', tone: 'calm', speed: 1 })
  assert.throws(() => resolveLongformVoice('marin', 'x')) // provider values are not accepted from the client
})

test('T11 + T12: figure right / text left kept; the card k starts exactly where narration chunk k starts (measured audio)', async () => {
  const fx = await assetFixture('female-middle'), img = await standInImage(fx.d)
  const out: any = await createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk', image: async () => ({ bytes: img, contentType: 'image/jpeg', provider: 's', model: 'm' }), tts: async (t: string) => standInTts(t) }).run(fx.ctx())
  const m: any = await fx.blobs.getJson(out.result.assetSpecRef)
  assert.equal(m.image.mirrored, true) // the stand-in figure was on the LEFT: mirrored to the right
  assert.match(longformImagePrompt(SAMPLE), /RIGHT third of the frame \(right 35-40%\).*LEFT 60%/)
  const tl = cardTimeline(SAMPLE, m.chunks, m.chunks.map((c: any) => c.seconds))
  let acc = 0
  tl.forEach((t, i) => { assert.equal(t.start, Number(acc.toFixed(3))); acc += m.chunks[i].seconds })
  // the levelled track (loudnorm) is probed again: same length, at most its last 100 ms frame of silence added
  assert.ok(m.narration.seconds >= acc - 0.01 && m.narration.seconds <= acc + 0.11, `${m.narration.seconds} vs ${acc}`)
  const { ass } = longformCardsAss(SAMPLE, tl)
  assert.match(ass, /\\an4\\pos\(100,540\)/); assert.doesNotMatch(ass, /\\fad|\\move|\\t\(/)
})

test('T13 + T14: a 120-minute script is written section by section; a failure mid-way resumes from the stored sections', async () => {
  const { ctx, blobs } = await planJob(7200)
  const size = sectionPlan(7200)
  assert.ok(size.sections >= 20, `120 min -> ${size.sections} sections`)
  const calls: Record<string, number> = {}
  // section 10 fails (twice = draft + repair) -> retryable SECTION_INVALID; sections 1-9 are already checkpointed
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: fakeResearch, log: () => {}, planner: longPlanner(calls, { index: 9, times: 2 }) as any }).run(ctx), (e: any) => e.code === 'SECTION_INVALID' && e.retryable === true && /section-010/.test(e.message))
  assert.equal(calls.outline, 1); assert.equal(calls.section, 9 + 2)
  const ck = `longform-plan-checkpoints/${createHash('sha256').update(`${ctx.job.planRef}|${LONGFORM_PLANNER_VERSION}`).digest('hex')}`
  for (let i = 1; i <= 9; i++) assert.ok(await blobs.getJson(`${ck}/section-${String(i).padStart(3, '0')}.json`), `section ${i} checkpoint`)
  // the retry: the outline and sections 1-9 are reused, only 10..N are written, nothing starts from scratch
  const again: Record<string, number> = {}
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: fakeResearch, log: () => {}, planner: longPlanner(again) as any }).run(ctx)
  assert.equal(again.outline, undefined); for (let i = 1; i <= 9; i++) assert.equal(again[`section${i}`], undefined, `section ${i} reused`)
  assert.equal(again.section, size.sections - 9); assert.equal(again.metadata, 1)
  assert.equal(out.result.checkpoints.reused.length, 1 + 9); assert.equal(out.result.sections, size.sections)
  // a full rerun reuses everything (0 planner calls)
  const third: Record<string, number> = {}
  await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: fakeResearch, log: () => {}, planner: longPlanner(third) as any }).run(ctx)
  assert.deepEqual(third, {})
})

test('Buddha topic: the representative figure stays the Buddha (never a generic or Western sage); Wisdom Shorts figure rule unchanged', async () => {
  assert.equal(longformFigure('부처님이 말하는 마음 다스리는 법', 'an old sage'), BUDDHA_FIGURE)
  for (const t of ['석가모니의 가르침', '붓다의 말씀', 'Buddha on anger']) assert.equal(longformFigure(t, 'x'), BUDDHA_FIGURE)
  assert.match(longformFigure('쇼펜하우어의 인생론', 'x'), /^Arthur Schopenhauer/)
  assert.equal(longformFigure('나이 들수록 멀리할 사람', 'a calm elder'), 'a calm elder')
  assert.equal(thumbnailFigure('부처님 말씀', 'x'), 'x') // the Shorts thumbnail rule (wisdom.ts) is not touched
  const { ctx, blobs } = await planJob(1500)
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: fakeResearch, log: () => {}, planner: longPlanner({}) as any }).run(ctx)
  const script: any = await blobs.getJson(out.result.scriptRef)
  assert.equal(script.figure.imagePrompt, BUDDHA_FIGURE) // the planner suggested "an old Western sage": replaced
})

// ======================= RESEARCH (once per topic, cached, never repeated by a retry) =======================
import { openAiLongformResearcher, researchPath } from '../lib/generative/longformResearch.js'
import { researchJson } from './researchFixture.js'

// the real researcher behind a fake Responses API: every request it makes is counted
function researchApi(steps: Array<{ status: number; body?: any }> = [{ status: 200 }]) {
  const calls: any[] = []
  const f = (async (_u: string, init: any) => {
    calls.push(JSON.parse(init.body))
    const s = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (s.status !== 200) return new Response(JSON.stringify(s.body ?? {}), { status: s.status })
    return new Response(JSON.stringify({ model: 'gpt-6-luna', output: [{ type: 'web_search_call', action: { type: 'search' } }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(researchJson()) }] }] }), { status: 200 })
  }) as any
  return { research: openAiLongformResearcher(f, async () => {}), calls }
}

test('RESEARCH MISS -> 1 request, bundle stored; HIT (another job, same topic) -> 0 requests; outline/sections get the bundle', async () => {
  const { ctx, blobs, brief } = await planJob(3600)
  const api = researchApi(), logs: string[] = [], seen: any[] = []
  const planner: any = longPlanner({})
  const outline = planner.outline; planner.outline = async (b: any, n: number, k: string, r: any, research: any) => { seen.push({ outline: research?.fragments.length }); return outline(b, n) }
  const section = planner.section; planner.section = async (i: any) => { seen.push({ index: i.index, ids: i.fragments.map((x: any) => x.id) }); return section(i) }
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: api.research, log: (l) => logs.push(l), planner }).run(ctx)
  assert.equal(api.calls.length, 1)
  const ref = researchPath(brief.text, 11)
  const stored: any = await blobs.getJson(ref)
  assert.equal(stored.fragments.length, 24); assert.equal(stored.model, 'gpt-6-luna')
  assert.deepEqual(out.result.research, { ref, cache: 'MISS', model: 'gpt-6-luna', requests: 1, webSearchCalls: 1, fragments: 24 })
  assert.match(logs.join('\n'), /\[longform-research\] .*"cache":"MISS".*"requests":1/); assert.doesNotMatch(logs.join('\n'), /Bearer|"k"/)
  // the outline saw the whole bundle; each section only its own 2 fragments from the section map
  assert.deepEqual(seen[0], { outline: 24 })
  for (const s of seen.slice(1)) assert.deepEqual(s.ids, stored.sectionMap[s.index].fragmentIds)
  // a second job on the same topic (different brief/job): research reused, 0 requests
  const b2 = await putAddressed(blobs, 'generative-briefs', { ...brief, voice: undefined })
  const api2 = researchApi(), logs2: string[] = []
  const out2: any = await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: api2.research, log: (l) => logs2.push(l), planner: longPlanner({}) as any }).run({ ...ctx, job: { ...ctx.job, id: 'j2', planRef: b2.path } })
  assert.equal(api2.calls.length, 0); assert.equal(out2.result.research.cache, 'HIT'); assert.equal(out2.result.research.requests, 0)
  assert.match(logs2.join('\n'), /"cache":"HIT"/)
})

test('RESEARCH is not repeated by an OUTLINE or SECTION failure: the retry resumes from the stored research', async () => {
  const { ctx } = await planJob(3600)
  const api = researchApi()
  const failing: any = longPlanner({}); failing.outline = async () => { throw new Error('provider timeout') }
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: api.research, log: () => {}, planner: failing }).run(ctx), (e: any) => e.code === 'OUTLINE_INVALID' && e.retryable === true)
  assert.equal(api.calls.length, 1)
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: api.research, log: () => {}, planner: longPlanner({}, { index: 4, times: 2 }) as any }).run(ctx), (e: any) => e.code === 'SECTION_INVALID' && e.retryable === true)
  assert.equal(api.calls.length, 1, 'outline retry: 0 research requests')
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: api.research, log: () => {}, planner: longPlanner({}) as any }).run(ctx)
  assert.equal(api.calls.length, 1, 'section retry: 0 research requests'); assert.equal(out.result.research.cache, 'HIT')
  assert.equal(out.result.checkpoints.reused.includes('outline'), true)
})

test('cost guard: credit_balance_exhausted / quota stop the job at once (no retry, nothing stored); planner billing errors are not repaired', async () => {
  const { ctx, blobs, brief } = await planJob(3600)
  const api = researchApi([{ status: 429, body: { error: { code: 'credit_balance_exhausted', message: 'Your credit balance is too low' } } }, { status: 200 }])
  const logs: string[] = []
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: api.research, log: (l) => logs.push(l), planner: longPlanner({}) as any }).run(ctx), (e: any) => e.code === 'PROVIDER_BILLING' && e.retryable === false)
  assert.equal(api.calls.length, 1); assert.equal(await blobs.getJson(researchPath(brief.text, 11)), null)
  assert.match(logs.join('\n'), /"code":"credit_balance_exhausted"/)
  // a transient failure that persists: 2 requests, then a NON-retryable failure (the stage retry does not pay again)
  const flaky = researchApi([{ status: 502 }])
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: flaky.research, log: () => {}, planner: longPlanner({}) as any }).run(ctx), (e: any) => e.code === 'RESEARCH_FAILED' && e.retryable === false)
  assert.equal(flaky.calls.length, 2)
  // research stored, then the outline call hits the quota: 1 outline call (no repair), non-retryable
  const ok = researchApi(), calls: Record<string, number> = {}
  const planner: any = longPlanner(calls)
  planner.outline = async () => { calls.outline = (calls.outline || 0) + 1; throw Object.assign(new Error('OpenAI billing stop (HTTP 429): insufficient_quota'), { stop: true, code: 'insufficient_quota' }) }
  await assert.rejects(() => createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: ok.research, log: () => {}, planner }).run(ctx), (e: any) => e.code === 'PROVIDER_BILLING' && e.retryable === false)
  assert.equal(calls.outline, 1)
})

test('LOUDNESS: the narration is levelled ONCE to about -17 LUFS (true peak <= -1.5 dBTP); every sentence still starts where its card does (+-0.03 s)', async () => {
  const fx = await assetFixture('female-middle'), img = await standInImage(fx.d)
  // quiet TTS (about -30 LUFS), like the soft OpenAI voice that made the last 58-minute talk too quiet
  const quiet = async (text: string) => {
    const n = [...text].length, sec = (n / LONGFORM.charsPerSecond) * (0.6 + 0.8 * ((n * 7) % 5) / 4)
    const r = await runOk(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.25', '-f', 'lavfi', '-i', `sine=f=${200 + (n % 7) * 40}:d=${sec.toFixed(2)}`, '-filter_complex', '[0][1]concat=n=2:v=0:a=1,volume=0.03', '-c:a', 'libmp3lame', '-f', 'mp3', '-'])
    return { bytes: r.stdout, contentType: 'audio/mpeg', provider: 'standin', model: 'tone' }
  }
  const out: any = await createLongformAssetExecutor({ apiKey: 'k', imageKey: 'gk', image: async () => ({ bytes: img, contentType: 'image/jpeg', provider: 's', model: 'm' }), tts: quiet as any }).run(fx.ctx())
  const m: any = await fx.blobs.getJson(out.result.assetSpecRef)
  assert.equal(m.narration.loudness, 'loudnorm=I=-17:TP=-1.5:LRA=11')
  const file = join(fx.d, 'narration.m4a'); await (await import('node:fs/promises')).writeFile(file, await fx.blobs.getBytes(m.narration.ref))
  // the project's own ffmpeg (ffmpeg-static on CI), not whatever is on PATH
  const { runFfmpeg } = await import('../lib/media/ffmpeg.js')
  const ff = async (args: string[]) => (await runFfmpeg(args)).stderr
  const meter = await ff(['-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  const summary = meter.slice(meter.lastIndexOf('Summary:'))
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)![1]), peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)![1])
  assert.ok(lufs >= -18.5 && lufs <= -15.5, `integrated loudness ${lufs} LUFS`)
  assert.ok(peak <= -1.0, `true peak ${peak} dBTP (no clipping)`)
  // sentence onsets in the levelled track vs the card timeline: card k start + where the voice starts inside sentence k's
  // own TTS audio (measured on that sentence alone), so loudnorm may not move any sentence by more than 0.03 s
  const firstSound = async (f: string) => Number(/silence_end: ([\d.]+)/.exec(await ff(['-nostats', '-i', f, '-af', 'silencedetect=n=-90dB:d=0.15', '-f', 'null', '-']))?.[1] ?? 0)
  const sd = await ff(['-nostats', '-i', file, '-af', 'silencedetect=n=-90dB:d=0.15', '-f', 'null', '-'])
  const onsets = [...sd.matchAll(/silence_end: ([\d.]+)/g)].map((x) => Number(x[1]))
  const tl = cardTimeline(SAMPLE, m.chunks, m.chunks.map((c: any) => c.seconds))
  assert.equal(onsets.length, tl.length)
  for (const [i, t] of tl.entries()) {
    const own = join(fx.d, `s${i}.mp3`); await (await import('node:fs/promises')).writeFile(own, await fx.blobs.getBytes(m.chunks[i].ref))
    const want = t.start + await firstSound(own)
    assert.ok(Math.abs(onsets[i] - want) <= 0.03, `sentence ${i + 1}: voice ${onsets[i]} vs card ${want}`)
  }
  const sum = m.chunks.reduce((s: number, c: any) => s + c.seconds, 0)
  assert.ok(m.narration.seconds >= sum - 0.01 && m.narration.seconds <= sum + 0.11)
  // the level is applied once, on the whole track: never per sentence
  const src = (await import('node:fs')).readFileSync(new URL('../worker/stages/longform.ts', import.meta.url), 'utf8')
  assert.match(src, /assembleNarration\(/); assert.equal(src.match(/LONGFORM_LOUDNORM/g)!.length, 2) // the shared engine's pass, recorded in the manifest
})

// ======================= SENIOR LONGFORM: the same engine in its story "scenes" mode =======================
import { LONGFORM_MODES, longformMode } from '../lib/generative/longform.js'
import { mergeSameScenes, seniorActErrors, seniorScenePlan, seniorScenes, sceneRuns, characterLine, sceneMotion, SENIOR } from '../lib/generative/seniorLongform.js'
import { VISUAL_STYLE_PROFILES } from '../lib/generative/visualStyle.js'

const FAMILY = '어머니가 마지막으로 차려준 밥상'
const CAST = [
  { id: 'mother', name: '김순자', role: '어머니', gender: 'female', age: '75', face: 'kind wrinkled face, small gentle eyes', hair: 'short permed grey hair', build: 'small', outfit: 'lavender cardigan over a floral blouse', colors: 'lavender, cream' },
  { id: 'son', name: '박민수', role: '아들', gender: 'male', age: '48', face: 'tired square face', hair: 'short black hair', build: 'medium', outfit: 'navy work jacket', colors: 'navy, grey' }
]
const PLACES = ['시골집 마루', '재래시장', '병원 대기실', '버스 정류장', '작은 국밥집', '아파트 거실', '논두렁 길']
// 6 acts x 4-5 scenes (27 pictures); act 1 also lists the SAME scene twice in a row (same place/time/people/action)
const actScenes = (a: number) => {
  const sc = Array.from({ length: a % 2 === 0 ? 5 : 4 }, (_, j) => ({ id: `a${a + 1}s${j + 1}`, place: PLACES[(a + j) % 7], time: j % 2 ? '저녁' : '아침', characters: j % 3 === 0 ? ['mother'] : ['mother', 'son'], action: `action ${a + 1}-${j + 1}`, mood: 'warm', visual: `visual ${a + 1}-${j + 1}` }))
  return a === 0 ? [sc[0], { ...sc[0], id: 'a1dup' }, ...sc.slice(1)] : sc
}
function seniorPlanner(calls: Record<string, number> = {}) {
  const base = sentencesOf(SAMPLE)
  return {
    outline: async (_b: any, n: number) => { calls.outline = (calls.outline || 0) + 1; return { title: SAMPLE.title, hook: SAMPLE.hook, figure: { name: '김순자', imagePrompt: 'an elderly Korean mother' }, thumbnail: SAMPLE.thumbnail, characters: CAST, sections: Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, heading: `act ${i + 1}`, points: ['a', 'b'], scenes: actScenes(i) })) } },
    section: async (i: any) => { calls.section = (calls.section || 0) + 1; return { sentences: i.outline.sections[i.index].scenes.map((sc: any, k: number) => ({ ...base[k % base.length], say: `${base[k % base.length].say} (${i.index + 1}-${k + 1})`, scene: sc.id })) } },
    metadata: async () => ({ title: SAMPLE.title, ...SAMPLE.metadata })
  }
}
// a scene picture stand-in: its own colour (hue from the scene's place in the story) with a white grid, so the
// rendered frame tells which scene is on screen and whether the picture moves
async function scenePicture(d: string, prompt: string) {
  const m = /visual (\d+)-(\d+)/.exec(prompt)!, idx = (Number(m[1]) - 1) * 5 + Number(m[2]) - 1
  const hue = (idx * 360) / 30, l = idx % 2 ? 0.35 : 0.6, c = (1 - Math.abs(2 * l - 1)) * 0.75, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), k = l - c / 2
  const [r, g, b] = (hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]).map((v) => Math.round((v + k) * 255))
  const f = join(d, `p${idx}.jpg`)
  await runOk(['-y', '-f', 'lavfi', '-i', `color=c=0x${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}:s=1536x1024,drawgrid=w=128:h=128:t=8:c=white@0.8`, '-frames:v', '1', '-q:v', '3', f])
  return { bytes: await (await import('node:fs/promises')).readFile(f), contentType: 'image/jpeg', provider: 'standin', model: 'scene', rgb: [r, g, b] }
}
const shortTts = async () => { const r = await runOk(['-f', 'lavfi', '-i', 'sine=f=330:d=0.8', '-af', 'volume=0.4', '-c:a', 'libmp3lame', '-f', 'mp3', '-']); return { bytes: r.stdout, contentType: 'audio/mpeg', provider: 'standin', model: 'tone' } }
async function seniorJob(input: any = {}) {
  const blobs: any = createMemoryBlobStore()
  const brief = normalizeLongformBrief({ kind: 'topic', text: FAMILY, targetSeconds: 3600, ...input }, 'senior_longform')
  const stored = await putAddressed(blobs, 'generative-briefs', brief)
  const job = { id: 'senior1', profile: 'senior_longform', planRev: 1, planRef: stored.path }
  const runs: Record<string, any> = {}
  const ctx = () => ({ job, blobs, previous: async (s: string) => runs[s] ?? null, signal: new AbortController().signal } as any)
  return { blobs, brief, job, runs, ctx }
}

test('SENIOR 17-21: Wisdom Longform keeps its single-image mode; Senior is the scenes mode: 6 acts, ~24-30 pictures, watercolor by default', async () => {
  assert.deepEqual([LONGFORM_MODES.wisdom_longform.images, LONGFORM_MODES.senior_longform.images], ['single', 'scenes'])
  assert.equal(longformMode('wisdom_longform').research, true); assert.equal(longformMode('senior_longform').research, false)
  assert.deepEqual(seniorScenePlan(3600), { acts: 6, scenesPerAct: { min: 4, max: 5 }, charsPerAct: 3720 })
  const { ctx, runs, brief } = await seniorJob()
  assert.equal(brief.creative!.resolved.visualStyleProfile, 'senior-warm-watercolor')
  const calls: Record<string, number> = {}, research: any[] = []
  const out: any = await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, research: async (...a: any[]) => { research.push(a); throw new Error('no research for a story') }, log: () => {}, planner: seniorPlanner(calls) as any }).run(ctx())
  runs.PLAN = out
  assert.equal(research.length, 0, 'a Senior story is not researched')
  assert.deepEqual([calls.outline, calls.section], [1, 6])
  const script: any = await ctx().blobs.getJson(out.result.scriptRef)
  assert.equal(script.schema, 'senior-longform-script/1'); assert.equal(script.sections.length, 6)
  const pics = seniorScenes(script)
  assert.equal(pics.length, 27); assert.ok(pics.length >= 24 && pics.length <= 30)
  assert.equal(out.result.scenes, 27); assert.deepEqual(out.result.creative.resolved.visualStyleProfile, 'senior-warm-watercolor')
  // the repeated scene was merged: its sentence is told over the first scene's picture
  assert.ok(!pics.some((s: any) => s.id === 'a1dup')); assert.deepEqual(script.sections[0].sentences.slice(0, 2).map((x: any) => x.scene), ['a1s1', 'a1s1'])
})

test('SENIOR 22: a new picture only when place/time/people/action change; scenes are used in order', () => {
  const sc = (id: string, o: any = {}) => ({ id, place: '부엌', time: '아침', characters: ['mother'], action: '밥을 짓는다', mood: 'warm', visual: 'v', ...o })
  const say = (scene: string) => ({ say: '문장', show: ['가', '나'], accent: '가', color: 'red' as const, scene })
  const m = mergeSameScenes({ scenes: [sc('s1'), sc('s2'), sc('s3', { place: '마당' }), sc('s4', { place: '마당', action: '빨래를 넌다' }), sc('s5', { place: '마당', action: '빨래를 넌다', characters: ['mother', 'son'] })], sentences: ['s1', 's1', 's2', 's3', 's4', 's5'].map(say) })
  assert.deepEqual(m.scenes.map((s) => s.id), ['s1', 's3', 's4', 's5']) // same place/time/people/action = one picture
  assert.deepEqual(m.sentences.map((x) => x.scene), ['s1', 's1', 's1', 's3', 's4', 's5'])
  const ids = new Set(['mother', 'son'])
  assert.deepEqual(seniorActErrors({ scenes: [sc('s1'), sc('s2', { place: '마당' })], sentences: [say('s1'), say('s2')] }, ids), [])
  assert.match(seniorActErrors({ scenes: [sc('s1'), sc('s2', { place: '마당' })], sentences: [say('s2'), say('s1')] }, ids).join(';'), /out_of_order/)
  assert.match(seniorActErrors({ scenes: [sc('s1'), sc('s2', { place: '마당' })], sentences: [say('s1')] }, ids).join(';'), /scene s2 has no sentence/)
  assert.match(seniorActErrors({ scenes: [sc('s1', { characters: ['ghost'] })], sentences: [say('s1')] }, ids).join(';'), /characters.unknown:ghost/)
})

test('SENIOR 18 + 23-25 + REAL RENDER: one picture per scene in ONE style with the Character Bible; common voice; each scene on screen for its narration with gentle motion', async () => {
  const { ctx, runs, brief, blobs } = await seniorJob({ voiceProfile: 'auto', voiceTone: 'calm', voiceSpeed: 0.9 })
  runs.PLAN = await createLongformPlanExecutor({ apiKey: 'k', derive: NO_DERIVE, log: () => {}, planner: seniorPlanner() as any }).run(ctx())
  const d = await mkdtemp(join(tmpdir(), 'senior-'))
  const prompts: string[] = [], voices: string[] = [], colors = new Map<string, number[]>()
  const deps = { apiKey: 'k', imageKey: 'gk', image: async (p: string) => { prompts.push(p); const x = await scenePicture(d, p); return x }, tts: async (_t: string, _k: string, v: any) => { voices.push(v.id); return shortTts() } }
  runs.ASSET = await createLongformAssetExecutor(deps as any).run(ctx())
  const m: any = await blobs.getJson(runs.ASSET.result.assetSpecRef)
  // 18: one picture per scene (27), not one per sentence (28)
  assert.equal(prompts.length, 27); assert.equal(m.images.length, 27); assert.equal(m.chunks.length, 28)
  // the one style everywhere, the same Character Bible line for the same person in every picture
  const wc = VISUAL_STYLE_PROFILES['senior-warm-watercolor']
  assert.ok(prompts.every((p) => p.includes(wc.promptPrefix) && p.includes(wc.negativePrompt)))
  const motherLine = characterLine(CAST[0] as any), sonLine = characterLine(CAST[1] as any)
  assert.ok(prompts.every((p) => p.includes(motherLine)), 'the mother looks the same in every scene')
  assert.equal(prompts.filter((p) => p.includes(sonLine)).length, seniorScenes((await blobs.getJson(runs.PLAN.result.scriptRef)) as any).filter((s: any) => s.characters.includes('son')).length)
  // 25: the voice is the one resolved at job_create (auto -> 어머니 topic -> female-senior, calm, 0.9)
  assert.equal(brief.creative!.resolved.voiceProfileId, 'ko-lf-female-senior-calm-0.9-v2')
  assert.ok(voices.length === 28 && voices.every((v) => v === 'ko-lf-female-senior-calm-0.9-v2'))
  // an ASSET retry pays for nothing; another style is another set of pictures (other cache keys)
  prompts.length = 0; voices.length = 0
  await createLongformAssetExecutor(deps as any).run(ctx())
  assert.deepEqual([prompts.length, voices.length], [0, 0])
  const other = await seniorJob({ visualStyleProfile: 'realistic-documentary' })
  other.runs.PLAN = runs.PLAN; Object.assign(other.blobs.files, blobs.files)
  for (const [k, v] of blobs.files) other.blobs.files.set(k, v); for (const [k, v] of blobs.binaries) other.blobs.binaries.set(k, v)
  await createLongformAssetExecutor(deps as any).run(other.ctx())
  assert.equal(prompts.length, 27); assert.ok(prompts.every((p) => p.includes(VISUAL_STYLE_PROFILES['realistic-documentary'].promptPrefix) && !p.includes(wc.promptPrefix)))
  // REAL RENDER: 16:9, the length of the narration, every scene on screen while its sentences are told
  const r: any = await createLongformRenderExecutor({ features: () => new Set(['LONGFORM_RENDER', 'CAPTION', 'QC']) as any }).run(ctx())
  assert.equal(r.result.scenePictures, 27); assert.equal(r.result.canvas, '1920x1080')
  const file = join(d, 'senior.mp4'); await (await import('node:fs/promises')).writeFile(file, await blobs.getBytes(r.result.variants[0].renderRef))
  const info = await probe(file)
  assert.ok(Math.abs(Number(info.duration) - m.narration.seconds) < 0.5, `${info.duration} vs ${m.narration.seconds}`)
  const script: any = await blobs.getJson(runs.PLAN.result.scriptRef)
  const tl = cardTimeline(script, m.chunks, m.chunks.map((c: any) => c.seconds)), spans = sceneRuns(script, tl)
  assert.equal(spans.length, 27)
  const frame = async (t: number) => (await runOk(['-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'crop=900:500:510:180,scale=90:50', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])).stdout
  const mean = (b: Buffer) => [0, 1, 2].map((c) => { let s = 0; for (let i = c; i < b.length; i += 3) s += b[i]; return s / (b.length / 3) })
  const own = await Promise.all(m.images.map(async (x: any) => { const f = join(d, `own-${x.sceneId}.jpg`); await (await import('node:fs/promises')).writeFile(f, await blobs.getBytes(x.ref)); return mean((await runOk(['-i', f, '-vf', 'scale=90:60', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])).stdout) }))
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  for (const [i, s] of spans.entries()) {
    const got = mean(await frame((s.start + s.end) / 2)), want = m.images.findIndex((x: any) => x.sceneId === s.sceneId)
    const nearest = own.map((o, j) => [dist(o, got), j]).sort((a, b) => a[0] - b[0])[0][1]
    assert.equal(nearest, want, `scene ${i + 1} (${s.sceneId}) on screen at ${((s.start + s.end) / 2).toFixed(2)}s`)
  }
  // gentle motion: a panning scene moves, a still scene does not
  const diff = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length }
  const pan = spans.findIndex((_, i) => sceneMotion(i) === 'pan-right'), still = spans.findIndex((_, i) => sceneMotion(i) === 'still')
  const moved = diff(await frame(spans[pan].start + 0.1), await frame(spans[pan].end - 0.1)), held = diff(await frame(spans[still].start + 0.1), await frame(spans[still].end - 0.1))
  assert.ok(moved > 3 && held < 1.5, `pan ${moved.toFixed(2)} vs still ${held.toFixed(2)}`)
  // subtitles at the bottom over the picture (Wisdom keeps its left column)
  assert.match(longformCardsAss(script, tl, 'bottom').ass, /\\an2\\pos\(960,1010\)/)
  assert.match(longformCardsAss(SAMPLE, cardTimeline(SAMPLE, ttsChunks(SAMPLE), ttsChunks(SAMPLE).map(() => 1))).ass, /\\an4\\pos\(100,540\)/)
  assert.equal(SENIOR.acts, 6)
})
