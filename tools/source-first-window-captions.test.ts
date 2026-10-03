// Source-first General Shorts: explanation captions over the lower visual window, one large pop per real impact
// (퍽! 퍽! 퍽!) inside the window, and a planner that writes captions which add meaning instead of narrating the picture.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fx from './screenDnaFixtures.js'
import { assFromPayload, WINDOW_CAPTION, EFFECT_MIN_PCT, captionLines } from '../lib/media/ass.js'
import { COMMON_SHORTS_SCREEN_DNA as DNA, CAPTION_WINDOW_ZONE, EFFECT_WINDOW_ZONE, windowFit } from '../lib/media/screenDnaContract.js'
import { textBandsCheck, textLinesCheck, runScreenDnaQc, renderVideoFilters, filterGraphSha256 } from '../lib/media/screenDna.js'
import { planPresentation, PRESENTATION_LIMITS, type Cue } from '../lib/media/presentation.js'
import { presentationFor } from '../lib/media/plan.js'
import { storyPrompt, AI_PLANNER_PROMPT_VERSION } from '../lib/media/aiPlanner.js'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'
import { extractRenderPlan } from '../lib/media/render.js'
import { evaluateGate } from '../lib/qc/gate.js'

const HITS = [{ start: 1.0, end: 1.5, text: '퍽!' }, { start: 1.4, end: 1.9, text: '퍽!' }, { start: 1.9, end: 2.35, text: '퍽!' }]
const payload = (profile?: string, extra: any = {}) => ({
  totalDuration: 2.4,
  editorialPlan: { profile, headline: '소파에 누운 남편 결국 아내가 폭발' },
  subtitleEvents: [{ start: 0, end: 1.2, text: '남편이 또 약속을 잊었다' }, { start: 1.2, end: 2.4, text: '오늘은 그냥 안 넘어간다' }],
  sourceEffectCaptions: HITS.map((h, k) => ({ ...h, xPct: [40, 60, 50][k], yPct: [42, 36, 48][k], fontSizePct: 13, animation: 'pop' })),
  ...extra
})
const posOf = (line: string) => { const m = /\\pos\((\d+),(\d+)\)/.exec(line); return m ? { x: Number(m[1]), y: Number(m[2]) } : null }
const fsOf = (line: string) => Number(/\\fs(\d+)/.exec(line)?.[1])

test('General: explanation captions sit at the bottom of the CENTER visual window, never in the bottom black band', () => {
  const { ass, events } = assFromPayload(payload())
  const zone = CAPTION_WINDOW_ZONE()
  assert.ok(zone.y >= DNA.center.y && zone.y + zone.h === DNA.center.y + DNA.center.h)
  const subs = ass.split('\n').filter((l) => l.includes(',WindowSub,'))
  assert.equal(subs.length, 2)
  for (const l of subs) {
    const p = posOf(l)!
    assert.match(l, /\\an2/)
    assert.ok(p.y > DNA.center.y + DNA.center.h / 2 && p.y < DNA.bottom.y, `caption baseline ${p.y} is inside the lower visual window`)
    assert.ok(fsOf(l) >= 60, 'large caption')
  }
  assert.ok(events.filter((e) => e.kind === 'subtitle').every((e) => e.zone && e.zone.y === zone.y))
  assert.ok(!ass.split('\n').some((l) => l.includes(',WisdomSub,')))
})

test('Wisdom (pre-composed) keeps its captions in the bottom band', () => {
  const { ass, events } = assFromPayload(payload('wisdom-v1'))
  assert.equal(ass.split('\n').filter((l) => l.includes(',WisdomSub,')).length, 2)
  assert.ok(events.filter((e) => e.kind === 'subtitle').every((e) => !e.zone))
})

test('long caption shrinks to at most 2 lines; never below the minimum size', () => {
  const long = '이 남자가 오늘 처음으로 진짜 큰일 났다는 걸 깨닫는 순간'
  const { ass } = assFromPayload(payload(undefined, { subtitleEvents: [{ start: 0, end: 2, text: long }] }))
  const l = ass.split('\n').find((x) => x.includes(',WindowSub,'))!
  assert.ok(fsOf(l) >= WINDOW_CAPTION.minPx && captionLines(long, 908, fsOf(l)) <= 2)
})

test('퍽! is drawn three separate times, large, centred inside the visual window above the captions', () => {
  const { ass, events } = assFromPayload(payload())
  const fxl = ass.split('\n').filter((l) => l.includes(',Fx,'))
  assert.equal(fxl.length, 3)
  const zone = EFFECT_WINDOW_ZONE()
  const fxe = events.filter((e) => e.kind === 'effect')
  assert.deepEqual(fxe.map((e) => e.start), [1.0, 1.4, 1.9])
  for (const l of fxl) {
    const p = posOf(l)!
    assert.ok(p.y > zone.y && p.y < zone.y + zone.h, `effect y ${p.y} inside the window`)
    assert.ok(fsOf(l) >= Math.round(EFFECT_MIN_PCT / 100 * 1080) - 2, `effect size ${fsOf(l)}`)
  }
  assert.ok(fxe.every((e) => e.zone?.y === zone.y))
  // a payload asking for a tiny or top-band effect is still drawn large inside the window
  const tiny = assFromPayload(payload(undefined, { sourceEffectCaptions: [{ start: 0.2, end: 0.7, text: '퍽!', yPct: 5, fontSizePct: 3 }] }))
  const t = tiny.ass.split('\n').find((l) => l.includes(',Fx,'))!
  assert.ok(posOf(t)!.y >= zone.y && fsOf(t) >= 130)
})

test('the zone-aware text check: window captions and effects PASS (no new or stricter rule)', async () => {
  const o = assFromPayload(payload())
  const i: any = { overlays: o, dna: DNA }
  const bands = await textBandsCheck(i)
  assert.equal(bands.status, 'PASS', JSON.stringify(bands.evidence))
  assert.equal((await textLinesCheck(i)).status, 'PASS')
})

test('presentation: every hit gets its own effect; effects do not take caption slots', () => {
  const beats = [{ trimStart: 0, trimEnd: 12 }]
  const cues: Cue[] = [
    { kind: 'hook', start: 0, end: 1, text: '소파 위 남편 큰일', basis: 'b' },
    { kind: 'context', start: 1, end: 3, text: '약속을 또 잊었다', basis: 'b' },
    { kind: 'context', start: 4, end: 6, text: '아내 표정이 심상찮다', basis: 'b' },
    { kind: 'context', start: 8, end: 10, text: '이번엔 안 봐준다', basis: 'b' },
    { kind: 'payoff', start: 10.5, end: 12, text: '결국 사과 엔딩', basis: 'b' },
    { kind: 'effect', start: 6.2, end: 6.7, text: '퍽!', basis: 'hit 1' },
    { kind: 'effect', start: 6.8, end: 7.3, text: '퍽!', basis: 'hit 2' },
    { kind: 'effect', start: 7.4, end: 7.9, text: '퍽!', basis: 'hit 3' },
    { kind: 'effect', start: 7.45, end: 7.95, text: '퍽!', basis: 'same hit twice' }
  ]
  const { placed, report } = planPresentation(beats, cues)
  assert.deepEqual(placed.filter((c) => c.kind === 'effect').map((c) => c.srcStart), [6.2, 6.8, 7.4])
  assert.equal(placed.filter((c) => c.kind === 'context').length, 3)
  assert.ok(placed.some((c) => c.kind === 'payoff'))
  assert.ok(report.dropped.some((d) => d.kind === 'effect' && /0\.5s|within/.test(d.reason)))
  assert.ok(PRESENTATION_LIMITS.effects >= 3)
  // VariantSpec: one pop per hit, never two on the same frame, all large
  const story: any = { minimalCaptions: cues }
  const v = presentationFor(beats as any, story)
  const e = v.effectCaptions as any[]
  assert.equal(e.length, 3)
  for (let k = 1; k < e.length; k++) assert.ok(e[k - 1].end <= e[k].start)
  assert.ok(e.every((x) => x.fontSizePct >= EFFECT_MIN_PCT))
})

test('planner prompt: captions add meaning (never restate the picture), one effect per hit, whole-video foreign-text audit', () => {
  assert.equal(AI_PLANNER_PROMPT_VERSION, 'source-story-analysis/14')
  const p = storyPrompt({ media: { duration: 30, hasAudio: true }, scenes: [], usable: [], ranges: { black: [], freeze: [], silent: [] }, timeline: [] } as any)
  assert.match(p, /NEVER restate what the viewer can already see/)
  assert.match(p, /context \(who\/why\), curiosity/)
  assert.match(p, /ONE effect cue PER visible impact/)
  assert.match(p, /three separate hits = three separate "퍽!" cues/)
  assert.match(p, /WHOLE-VIDEO FOREIGN-TEXT AUDIT: scan EVERY tile/)
  assert.doesNotMatch(p, /Do NOT add kind="effect"/)
})

test('framing: a landscape source is fitted whole into the window (no person cut at the sides)', () => {
  const f = windowFit(1280, 720, null)
  assert.deepEqual(f.output, { x: 0, y: 656, width: 1080, height: 608 })
  const p = windowFit(720, 1280, null)
  assert.equal(p.output.height, 1200); assert.ok(p.output.width < 1080)
})

test('render end-to-end: window captions + three 퍽! over a real General render keep every Screen DNA check PASS', async () => {
  const d = fx.dir()
  const src = await fx.generalSource(d, 'bright', '720x1280')
  const plan: any = { schema: 'job-plan/1', profile: 'source_shorts', sourceAssetId: 'src_raw_fx', variantPlan: { profile: 'v1', beats: [{ label: 'a', trimStart: 0, trimEnd: 2.4 }], headline: '소파 위 남편\\N결국 큰일 났다', events: payload().subtitleEvents, plansTimeDomain: 'source', effectCaptions: payload().sourceEffectCaptions, timeDomain: 'source' } }
  const c = compileJobPlan({ jobId: 'job_gen', plan, sourceAsset: { sourceAssetId: 'src_raw_fx', blobPath: `source-collector/${src.sha256}.mp4`, sha256: src.sha256, duration: 2.4, width: 720, height: 1280 } as any })
  const manifest: any = { ...c.manifest, identity: c.identity }
  assert.equal(manifest.payload.sourceEffectCaptions.length, 3) // PLAN -> manifest
  const out = await fx.generalRender(d, src, manifest)
  const total = extractRenderPlan(manifest.payload).total
  const overlays = assFromPayload({ ...manifest.payload, totalDuration: total })
  assert.equal(overlays.events.filter((e) => e.kind === 'effect').length, 3) // manifest -> ASS
  const receipt = { schema: 'screen-dna-receipt/1', stage: 'RENDER', jobId: 'job_gen', attempt: 1, contract: DNA, composer: 'render', manifestHash: manifest.manifestHash, sourceSha256: src.sha256, sourceWidth: 720, sourceHeight: 1280, filterGraphSha256: filterGraphSha256(out.filterGraph), videoFilters: renderVideoFilters(out.filterGraph), renderHash: out.sha256 }
  const input: any = { job: { id: 'job_gen' }, composer: 'render', sourceFile: src.path, sourceSha256: src.sha256, renderPath: out.path, renderBytesSha256: out.sha256, output: { width: out.info.width, height: out.info.height }, variant: { manifestHash: manifest.manifestHash, renderHash: out.sha256, geometryReceipt: receipt }, manifest, renderRun: { attempt: 1 }, assetRun: null, assetManifest: null, getBytes: async () => null, overlays }
  const checks = await runScreenDnaQc(input, extractRenderPlan(manifest.payload).cuts)
  assert.ok(checks.every((x) => x.status === 'PASS'), JSON.stringify(checks.filter((x) => x.status !== 'PASS')))
  assert.equal(evaluateGate(checks).decision, 'PASS')
})
