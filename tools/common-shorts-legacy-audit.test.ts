// Common Shorts conversion audit: legacy General assumptions that would surface as the "next FAIL" in Production.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planVariants, toJobPlan, totalSeconds, type VariantSpec } from '../lib/media/plan.js'
import { computeHighlights, type SourceAnalysis } from '../lib/media/analyze.js'
import { validateStory, semanticFromStory } from '../lib/media/story.js'
import { evaluateContentGate } from '../lib/media/contentGate.js'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'
import { PRESENTATION_LIMITS, selectCues, type PlacedCue } from '../lib/media/presentation.js'
import { buildAss, assFromPayload, captionLines, CAPTION_MIN_PX, fitFontSize, WISDOM_CAPTION_PX, WISDOM_WINDOW_CAPTION } from '../lib/media/ass.js'
const CAP_W = 1080 - 2 * WISDOM_WINDOW_CAPTION.marginX // Wisdom captions: lower visual window, narrower than the canvas
import { textLinesCheck, textBandsCheck } from '../lib/media/screenDna.js'
import { aiAnalyzeStory, AI_PLANNER_PROMPT_VERSION, storyPrompt } from '../lib/media/aiPlanner.js'
import type { SourceFraming } from '../lib/media/framing.js'

const FULL: SourceFraming = { mode: 'full', crop: null, confidence: 0, sampleCount: 7, detector: 'luma-bands-v1' }
const EMBED: SourceFraming = { mode: 'embedded', crop: { x: 0, y: 302, width: 576, height: 420 }, confidence: 1, sampleCount: 7, detector: 'luma-bands-v1' }
const status = (g: any, id: string) => g.checks.find((c: any) => c.id === id)?.status
function analysis(duration: number, sourceAssetId: string): SourceAnalysis {
  const a: SourceAnalysis = {
    schema: 'source-analysis/1', sourceAssetId, sha256: 'a'.repeat(64),
    media: { duration, width: 576, height: 1024, fps: 30, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', orientation: 'portrait' },
    scenes: [{ start: 0, end: duration }], timeline: Array.from({ length: Math.ceil(duration) }, (_, t) => ({ t, visual: 0.03 + ((t * 11) % 7) / 200, audioDb: -25 })),
    ranges: { black: [], freeze: [], silent: [] }, audio: { silentRatio: 0, intentionallySilent: false },
    highlights: [], usable: [{ start: 0, end: duration }], analyzer: { name: 'ffmpeg-signals', version: 1 }
  }
  a.highlights = computeHighlights(a.timeline)
  return a
}
const payloadFor = (a: SourceAnalysis, v: VariantSpec) => compileJobPlan({ jobId: 'job_t', plan: toJobPlan(a.sourceAssetId, v), sourceAsset: { sourceAssetId: a.sourceAssetId, blobPath: 'source-collector/t.mp4', sha256: 'a'.repeat(64), duration: a.media.duration } }).manifest.payload

// The real Golden story (job_cd3cbf03…, completed 2026-09-30 07:33 KST, before the presentation layer existed).
const golden = JSON.parse(readFileSync(new URL('./fixtures/golden-cctv-story.json', import.meta.url), 'utf8'))
function goldenReplay() {
  const a = analysis(golden.duration, golden.sourceAssetId); a.media.width = golden.width; a.media.height = golden.height
  const v = validateStory(golden.story, a, { model: 'fixture', promptVersion: 't' }); assert.ok(v.story, v.errors.join('; '))
  const s = semanticFromStory(v.story!)
  return { a, s, rec: planVariants(a, s)[0] }
}

// ---------------- root cause of the 3 Production FAILs ----------------
test('Golden replay: the pre-presentation manifest (no headline, <=2 captions) fails exactly headline_present / presentation_grounded / presentation_rhythm', () => {
  const { a, s, rec } = goldenReplay()
  // what the 09-30 07:33 PLAN emitted: same story edit, no headline, at most 2 grounded captions, no effects
  const legacy: VariantSpec = { ...rec, headline: undefined, effectCaptions: undefined, events: (rec.events || []).filter((e) => e.text !== '그걸 본 아이가').slice(0, 2) }
  const g = evaluateContentGate({ payload: payloadFor(a, legacy), analysis: a, semantic: s, framing: EMBED })
  const failed = g.checks.filter((c: any) => c.status !== 'PASS').map((c: any) => `${c.status}:${c.id}`).sort()
  assert.deepEqual(failed, ['FAIL:content.headline_present', 'FAIL:content.presentation_grounded', 'FAIL:content.presentation_rhythm'])
})

test('Golden replay: re-planning the same story under Common Shorts passes the full content gate (no criteria loosened)', () => {
  const { a, s, rec } = goldenReplay()
  assert.equal(rec.headline, '왜 바닥을 기어갈까?'); assert.ok((rec.effectCaptions || []).length <= PRESENTATION_LIMITS.effects)
  const secs = totalSeconds(rec.beats); assert.ok(secs >= 15 && secs <= 22, `${secs}s`)
  const g = evaluateContentGate({ payload: payloadFor(a, rec), analysis: a, semantic: s, framing: EMBED })
  assert.equal(g.decision, 'PASS', JSON.stringify(g.reasons))
  for (const id of ['content.headline_present', 'content.presentation_grounded', 'content.presentation_rhythm', 'content.explanation_present', 'content.mobile_foreground']) assert.equal(status(g, id), 'PASS', id)
})

// ---------------- presentation budget: only drawn cues ----------------
test('cue budget: captions keep the 6-message total; effect pops have their own budget on top', () => {
  assert.deepEqual([PRESENTATION_LIMITS.effects, PRESENTATION_LIMITS.contexts, PRESENTATION_LIMITS.payoffs, PRESENTATION_LIMITS.eventsMax, PRESENTATION_LIMITS.totalMessages], [4, 4, 1, 5, 6])
  const cue = (kind: any, t: number): PlacedCue => ({ kind, start: t, end: t + 1, text: `${kind}${t}`, basis: 'b', outStart: t, srcStart: t, srcEnd: t + 1 })
  const { kept, dropped } = selectCues([cue('hook', 0), cue('context', 4), cue('context', 9), cue('context', 14), cue('context', 19), cue('payoff', 24), cue('effect', 7)], 28)
  assert.deepEqual(kept.map((c) => c.kind), ['hook', 'context', 'effect', 'context', 'context', 'context', 'payoff'])
  assert.equal(dropped.length, 0)
})

test('content gate: text count uses headline + captions; drawn effect pops count for rhythm; callouts never count', () => {
  const { a, s, rec } = goldenReplay()
  const p: any = payloadFor(a, rec)
  const withLegacy = { ...p, sourceEffectCaptions: [{ start: 1, end: 2, text: '슥' }, { start: 3, end: 4, text: '휙' }, { start: 5, end: 6, text: '쾅' }], sourceCallouts: [{ start: 1, end: 2, text: '멈춰!!' }] }
  const g = evaluateContentGate({ payload: withLegacy, analysis: a, semantic: s, framing: EMBED })
  assert.equal(status(g, 'content.presentation_grounded'), 'PASS'); assert.equal(status(g, 'content.presentation_rhythm'), 'PASS')
  // rhythm is NOT rescued by undrawn callouts
  const sparse = { ...p, subtitleEvents: p.subtitleEvents.slice(-1), sourceEffectCaptions: [], sourceCallouts: [{ start: 2, end: 3, text: '슥' }, { start: 6, end: 7, text: '휙' }, { start: 10, end: 11, text: '쾅' }] }
  assert.equal(status(evaluateContentGate({ payload: sparse, analysis: a, semantic: s, framing: EMBED }), 'content.presentation_rhythm'), 'FAIL')
})

test('content.headline_present judges the drawn headline: missing / non-Korean / whitespace headline FAIL', () => {
  const { a, s, rec } = goldenReplay()
  const p: any = payloadFor(a, rec)
  assert.equal(status(evaluateContentGate({ payload: p, analysis: a, semantic: s, framing: EMBED }), 'content.headline_present'), 'PASS')
  for (const headline of ['', '   ', 'WHY?']) {
    const g = evaluateContentGate({ payload: { ...p, editorialPlan: { ...p.editorialPlan, headline } }, analysis: a, semantic: s, framing: FULL })
    assert.equal(status(g, 'content.headline_present'), 'FAIL', JSON.stringify(headline))
  }
})

// ---------------- AI planner asks for what Common Shorts draws ----------------
test('AI planner: benchmark prompt asks for one effect per hit and a two-word hook; a one-word hook is repaired, never shipped', async () => {
  assert.equal(AI_PLANNER_PROMPT_VERSION, 'source-story-analysis/15')
  const a = analysis(30, 'src_audit_000001')
  const prompt = storyPrompt(a)
  assert.match(prompt, /ONE effect cue PER visible impact/); assert.match(prompt, /AT LEAST TWO words/); assert.doesNotMatch(prompt, /Do NOT add kind="effect"/)
  const base: any = {
    storyType: 'single_event', confidence: 0.9, causalStart: 1, setupRanges: [{ start: 1, end: 6 }], escalationRanges: [{ start: 6, end: 15 }], payoffRange: { start: 15, end: 19 }, recommendedEnd: 19.5,
    excludeRanges: [], hookStrategy: 'chronological', previewRange: null, hookConfidence: 0.1, hookReason: '',
    openingHook: { start: 1, end: 2.5, text: '왜지?', basis: 'person visibly stops' },
    minimalCaptions: [{ kind: 'context', start: 5.5, end: 7, text: '계속 뒤를 따라간다', basis: 'b' }, { kind: 'context', start: 10.5, end: 12, text: '둘이 같이 걷는다', basis: 'b' }, { kind: 'payoff', start: 15.5, end: 17, text: '결국 같이 움직인다', basis: 'b' }], publishabilityWarnings: []
  }
  let calls = 0
  const fetchImpl = (async (_u: any, init: any) => {
    calls++
    if (calls === 2) assert.match(JSON.parse(String(init.body)).input[0].content[0].text, /at least two words/)
    const body = calls === 1 ? base : { ...base, openingHook: { ...base.openingHook, text: '왜 멈췄을까?' } }
    return { ok: true, status: 200, json: async () => ({ model: 'gpt-test', output_text: JSON.stringify(body) }) }
  }) as unknown as typeof fetch
  const r = await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: Buffer.from('jpg'), fetchImpl })
  assert.equal(calls, 2); assert.equal(r.status, 'ok'); assert.equal(r.story!.minimalCaptions[0].text, '왜 멈췄을까?')
})

// ---------------- the drawn text format (pixels) ----------------
const W = 1080
// Wisdom band captions (General captions are drawn over the visual window: tools/source-first-window-captions.test.ts)
const overlaysFor = (headline: string, subs: string[]) => buildAss({ totalDuration: 4, screenDna: true, wisdomLayout: true, headline, subtitles: subs.map((t, i) => ({ start: i, end: i + 1, text: t })) })
const linesQc = (o: any) => textLinesCheck({ overlays: o } as any)

test('screen_dna.text_lines: real two-line white/yellow headline and short captions PASS', async () => {
  const r = await linesQc(overlaysFor('왜 바닥을 기어갈까?', ['갑자기 기어가기 시작', '결국 아이도 따라간다']))
  assert.equal(r.status, 'PASS', JSON.stringify(r.evidence))
  const head = (r.evidence as any).rows.find((x: any) => x.kind === 'headline')
  assert.deepEqual([head.lines, head.colours], [2, ['white', 'yellow']])
})

test('screen_dna.text_lines: one-line headline, swapped colours or a 3-line caption FAIL', async () => {
  assert.equal((await linesQc(overlaysFor('기어간다', []))).status, 'FAIL') // one word -> one line
  const ok = overlaysFor('왜 바닥을 기어갈까?', [])
  const swapped = { ...ok, ass: ok.ass.replace('\\c&H00FFFFFF&', '\\c&H0000D7FF&').replace('\\N{\\c&H0000D7FF&}', '\\N{\\c&H00FFFFFF&}') }
  assert.equal((await linesQc(swapped)).status, 'FAIL')
  const three = overlaysFor('왜 바닥을 기어갈까?', ['첫째 줄'])
  const forced = { ...three, ass: three.ass.replace(/(,WisdomWindowSub,,0,0,0,,\{\\an2\\pos\(\d+,\d+\)\\fs\d+\})첫째 줄/, '$1첫째 줄\\N둘째 줄\\N셋째 줄') }
  assert.notEqual(forced.ass, three.ass)
  assert.equal((await linesQc(forced)).status, 'FAIL')
})

test('captions: a caption that would wrap to 3+ lines is shrunk until libass draws <= 2 lines; fitting captions keep their size', async () => {
  // ~80 chars (Wisdom beats allow 90): at the 42px floor libass draws this in 3 lines
  const long = '오래 함께한 사람일수록 서로를 잘 안다고 믿지만 사실은 가장 많이 오해하고 있는 경우가 많습니다 그래서 거리를 두는 지혜가 필요합니다 결국 관계도'
  const o = overlaysFor('왜 사람을 줄여야 할까?', [long, '짧은 자막입니다'])
  const dlg = o.ass.split('\n').filter((l) => l.includes(',WisdomWindowSub,'))
  const fsLong = Number(/\\fs(\d+)/.exec(dlg[0])![1]), fsShort = Number(/\\fs(\d+)/.exec(dlg[1])![1])
  assert.ok(fsLong < 42 && fsLong >= CAPTION_MIN_PX && captionLines(long, CAP_W, fsLong) <= 2, `fs ${fsLong}`)
  assert.equal(fsShort, WISDOM_WINDOW_CAPTION.basePx) // unchanged: the Wisdom base size for a caption that already fits
  const r = await linesQc(o)
  assert.equal(r.status, 'PASS', JSON.stringify(r.evidence))
  assert.ok((r.evidence as any).rows.filter((x: any) => x.kind === 'subtitle').every((x: any) => x.lines <= 2))
  assert.equal((await textBandsCheck({ overlays: o } as any)).status, 'PASS')
})

test('captions: the 2-line guard never changes a caption that already fits (Wisdom/General rendering unchanged)', () => {
  for (const t of ['첫 문장입니다', '나이가 들수록 사람을 줄여야 하는 이유가 있습니다', '갑자기 기어가기 시작', '쇼펜하우어는 고독을 두려워하지 말라고 말했습니다']) {
    const withGuard = buildAss({ totalDuration: 2, screenDna: true, wisdomLayout: true, headline: '', subtitles: [{ start: 0, end: 1, text: t }] }).ass
    const fs = Number(/\\fs(\d+)/.exec(withGuard.split('\n').find((l) => l.includes(',WisdomWindowSub,'))!)![1])
    assert.ok(captionLines(t, CAP_W, fs) <= 2)
    assert.equal(fs, fitFontSize(t, CAP_W - 40, WISDOM_WINDOW_CAPTION.basePx, 2, WISDOM_CAPTION_PX.min), t) // the guard did not engage
  }
  // the Golden payload drawn as-is: headline over the whole edit, captions in the bottom band
  const { a, rec } = goldenReplay()
  const p: any = payloadFor(a, rec)
  const built = assFromPayload({ ...p, totalDuration: totalSeconds(rec.beats) })
  assert.ok(built.events.some((e) => e.kind === 'headline' && e.start === 0))
  assert.ok(!built.events.some((e) => e.kind === 'callout'))
  assert.ok(built.events.filter((e) => e.kind !== 'headline').every((e) => e.zone && e.zone.y >= 360 && e.zone.y + e.zone.h <= 1560)) // inside the visual window
})

test('black-picture checks look at the visual window: a black window under a bright headline is caught (was a false PASS)', async () => {
  const { runOk, detectBlack } = await import('../lib/media/ffmpeg.js')
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  const f = join(mkdtempSync(join(tmpdir(), 'audit-black-')), 'black-window.mp4')
  // DNA frame: black bands + black visual window, a large bright headline block in the top band (like the real headline)
  await runOk(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=2', '-vf', 'drawbox=x=60:y=40:w=960:h=280:color=white:t=fill,format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f])
  assert.deepEqual(await detectBlack(f), []) // whole-frame measurement: the headline hides the black picture
  const crop = 'crop=1080:1200:0:360'
  assert.ok((await detectBlack(f, { crop })).length >= 1)
  const src = (await import('node:fs')).readFileSync(new URL('../lib/media/qc.ts', import.meta.url), 'utf8')
  assert.match(src, /detectBlack\(i\.renderPath, \{ crop: WINDOW_CROP \}\)/); assert.match(src, /grayFrame\(i\.renderPath, t, 32, 36, WINDOW_CROP\)/)
})
