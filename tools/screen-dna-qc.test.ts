import test from 'node:test'
import assert from 'node:assert/strict'
import * as fx from './screenDnaFixtures.js'
import { SHORTS_SCREEN_DNA, screenDnaSegmentFilter, renderVideoFilters, filterGraphSha256, runScreenDnaQc, geometryContractCheck, sourceGeometryCheck, renderPreservesSourceCheck, textBandsCheck, outputIdentityCheck } from '../lib/media/screenDna.js'
import { evaluateGate } from '../lib/qc/gate.js'
import { assFromPayload } from '../lib/media/ass.js'
import { extractRenderPlan } from '../lib/media/render.js'

const BASE = screenDnaSegmentFilter()
const SUBS = [{ start: 0, end: 1.2, text: '첫 문장입니다' }, { start: 1.2, end: 2.4, text: '둘째 문장입니다' }]
const status = (checks: any[], id: string) => checks.find((c) => c.id === id)?.status

async function build(kind: 'bright' | 'dark' | 'marks' | 'darkBottom', vf = BASE, tamper?: string) {
  const d = fx.dir()
  const src = await fx.source(d, [await fx.image(kind, d, 0), await fx.image(kind, d, 1)], 1.2, vf)
  const manifest = fx.payloadFor(src, 2.4, SUBS)
  const out = await fx.render(d, src, manifest, tamper)
  // receipts exactly as ASSET / RENDER record them
  const assetReceipt = { schema: 'screen-dna-receipt/1', stage: 'ASSET', jobId: 'job_fx', attempt: 1, contract: SHORTS_SCREEN_DNA, segmentFilter: vf, segmentArgv: src.argv, segments: src.items.map((x: any) => ({ beatId: x.beatId, imageSha256: x.image.sha256, durationSec: x.durationSec })), outputSha256: src.sha256, outputRef: 'source-collector/generated/x.mp4' }
  const renderReceipt = { schema: 'screen-dna-receipt/1', stage: 'RENDER', jobId: 'job_fx', attempt: 1, contract: SHORTS_SCREEN_DNA, manifestHash: manifest.manifestHash, sourceSha256: src.sha256, sourceWidth: 1080, sourceHeight: 1920, filterGraphSha256: filterGraphSha256(out.filterGraph), videoFilters: renderVideoFilters(out.filterGraph), renderHash: out.sha256 }
  return { d, src, manifest, out, assetReceipt, renderReceipt }
}
const qc = (b: Awaited<ReturnType<typeof build>>, over: any = {}) => fx.qcInput({ src: b.src, out: b.out, manifest: b.manifest, assetReceipt: b.assetReceipt, renderReceipt: b.renderReceipt, ...over })

let bright: Awaited<ReturnType<typeof build>>
test.before(async () => { bright = await build('bright') })

// ---------- geometry: valid layouts never depend on picture brightness ----------
test('1. 360/1200/360 + bright visual: every Screen DNA check PASS (with and without receipts)', async () => {
  const { input, cuts } = qc(bright)
  const checks = await runScreenDnaQc(input, cuts)
  assert.deepEqual(checks.map((c) => [c.id, c.status]), [['screen_dna.output_identity', 'PASS'], ['screen_dna.geometry_contract', 'PASS'], ['screen_dna.source_geometry', 'PASS'], ['screen_dna.render_preserves_source', 'PASS'], ['screen_dna.text_bands', 'PASS'], ['wisdom.screen_dna_layout', 'PASS']])
  assert.equal(evaluateGate(checks).decision, 'PASS')
  // legacy run (no receipts): contract comes from the ASSET code path and is proven by re-execution
  const legacy = fx.qcInput({ src: bright.src, out: bright.out, manifest: bright.manifest })
  assert.equal(status(await runScreenDnaQc(legacy.input, legacy.cuts), 'wisdom.screen_dna_layout'), 'PASS')
})

for (const [n, kind, label] of [[2, 'dark', 'very dark visual'], [3, 'marks', 'black object + dark horizontal lines inside the visual'], [3, 'darkBottom', 'visual whose lower half is near-black (the Production false-fail shape)']] as const) {
  test(`${n}. same geometry + ${label}: PASS`, async () => {
    const b = await build(kind)
    const { input, cuts } = qc(b)
    const checks = await runScreenDnaQc(input, cuts)
    assert.equal(status(checks, 'wisdom.screen_dna_layout'), 'PASS', JSON.stringify(checks.filter((c) => c.status !== 'PASS')))
  })
}

// ---------- geometry: 0px contract, enforced by the execution contract AND the pixels ----------
const variants: Array<[number, string, string]> = [
  [4, 'center y=359', BASE.replace('pad=1080:1920:0:360', 'pad=1080:1920:0:359')],
  [5, 'center y=361', BASE.replace('pad=1080:1920:0:360', 'pad=1080:1920:0:361')],
  [6, 'center height=1198', BASE.replaceAll('1080:1200', '1080:1198').replace('s=1080x1200', 's=1080x1198')],
  [7, 'center height=1202', BASE.replaceAll('1080:1200', '1080:1202').replace('s=1080x1200', 's=1080x1202')],
  [8, 'y=100 h=1200 with wisdom metadata', BASE.replace('pad=1080:1920:0:360', 'pad=1080:1920:0:100')]
]
for (const [n, label, vf] of variants) {
  test(`${n}. ${label}: FAIL`, async () => {
    const b = await build('bright', vf)
    const { input, cuts } = qc(b)
    assert.equal(input.manifest.payload.editorialPlan.profile, 'wisdom-v1')
    const checks = await runScreenDnaQc(input, cuts)
    // the execution receipt carries the real filter: exact 0px contract fails
    assert.equal(status(checks, 'screen_dna.geometry_contract'), 'FAIL')
    assert.equal(status(checks, 'wisdom.screen_dna_layout'), 'FAIL')
    assert.equal(evaluateGate(checks).decision, 'BLOCK')
    // without any receipt the pixels alone still refute it (yuv420p rounds pad y=361 to 360, so that one is pixel-identical
    // to the contract and is caught by the receipt above)
    const legacy = fx.qcInput({ src: b.src, out: b.out, manifest: b.manifest })
    const px = await sourceGeometryCheck(legacy.input)
    if (n !== 5) assert.equal(px.status, 'FAIL', JSON.stringify(px.evidence))
  })
}

test('9. full-frame or blur-fill picture declared as fixed Screen DNA: FAIL', async () => {
  const full = await build('bright', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p')
  const a = fx.qcInput({ src: full.src, out: full.out, manifest: full.manifest, assetReceipt: { ...full.assetReceipt, segmentFilter: BASE, segmentArgv: [...full.src.argv.slice(0, 9), BASE] } })
  const ca = await runScreenDnaQc(a.input, a.cuts)
  assert.equal(status(ca, 'screen_dna.source_geometry'), 'FAIL')
  assert.equal(status(ca, 'wisdom.screen_dna_layout'), 'FAIL')
  // correct source, but the render blur-fills the canvas instead of keeping the window
  const blur = await build('bright', BASE, 'split[a][b];[a]gblur=sigma=30[bg];[b]crop=1080:1200:0:360,scale=-2:1100[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2')
  const b = qc(blur, { renderReceipt: { ...blur.renderReceipt, renderHash: blur.out.sha256 } })
  const cb = await runScreenDnaQc(b.input, b.cuts)
  assert.equal(status(cb, 'screen_dna.render_preserves_source'), 'FAIL')
})

test('16. correct source geometry but the render crops/scales the visual window: FAIL', async () => {
  const b = await build('bright', BASE, 'split[a][b];[a]null[base];[b]crop=1080:1180:0:370,scale=1080:1200[c];[base][c]overlay=0:360')
  const { input, cuts } = qc(b, { renderReceipt: { ...b.renderReceipt, renderHash: b.out.sha256 } })
  assert.equal((await sourceGeometryCheck(input)).status, 'PASS')
  assert.equal((await renderPreservesSourceCheck(input, cuts)).status, 'FAIL')
})

// ---------- text: glyph masks, every event, every animated frame ----------
const draw = (y0: number, y1: number) => `{\\an7\\pos(0,0)\\p1}m 100 ${y0} l 980 ${y0} 980 ${y1} 100 ${y1}{\\p0}`
function overlaysWith(events: Array<{ kind: 'headline' | 'subtitle'; start: number; end: number; body: string }>) {
  const header = assFromPayload({ ...bright.manifest.payload, totalDuration: 2.4 }).ass.split('\n').filter((l: string) => !l.startsWith('Dialogue:'))
  const t = (s: number) => `0:00:${s.toFixed(2).padStart(5, '0')}`
  return {
    ass: [...header, ...events.map((e) => `Dialogue: 1,${t(e.start)},${t(e.end)},${e.kind === 'headline' ? 'WisdomHead' : 'WisdomSub'},,0,0,0,,${e.body}`)].join('\n'),
    events: events.map((e) => ({ kind: e.kind, text: e.body, start: e.start, end: e.end }))
  }
}
const textQc = (o: any) => textBandsCheck({ ...qc(bright).input, overlays: o })

test('10/11/12. headline or subtitle 1px into the visual window FAIL; flush to the band edge PASS', async () => {
  assert.equal((await textQc(overlaysWith([{ kind: 'headline', start: 0, end: 1, body: draw(300, 360) }, { kind: 'subtitle', start: 0, end: 1, body: draw(1560, 1700) }]))).status, 'PASS')
  assert.equal((await textQc(overlaysWith([{ kind: 'headline', start: 0, end: 1, body: draw(300, 361) }]))).status, 'FAIL')
  assert.equal((await textQc(overlaysWith([{ kind: 'subtitle', start: 0, end: 1, body: draw(1559, 1700) }]))).status, 'FAIL')
  // real headline + subtitles of the fixture
  assert.equal((await textQc(qc(bright).input.overlays)).status, 'PASS')
})

test('13/14. only the 13th, or only the last, text event is wrong: FAIL (no first-N sampling)', async () => {
  const good = Array.from({ length: 16 }, (_, k) => ({ kind: 'subtitle' as const, start: k * 0.1, end: k * 0.1 + 0.1, body: draw(1600, 1700) }))
  const at = (k: number) => good.map((e, j) => (j === k ? { ...e, body: draw(900, 1000) } : e))
  const r13 = await textQc(overlaysWith(at(12)))
  assert.equal(r13.status, 'FAIL'); assert.deepEqual((r13.evidence as any).failed.map((f: any) => f.k), [12])
  const rLast = await textQc(overlaysWith(at(15)))
  assert.equal(rLast.status, 'FAIL'); assert.deepEqual((rLast.evidence as any).failed.map((f: any) => f.k), [15])
})

test('15. a single-frame intrusion in the middle (1-frame event, or one animated frame): FAIL', async () => {
  const ok = { kind: 'subtitle' as const, start: 0, end: 2, body: draw(1600, 1700) }
  const oneFrameEvent = await textQc(overlaysWith([ok, { kind: 'subtitle', start: 1.0, end: 1.03, body: draw(1300, 1400) }, ok]))
  assert.equal(oneFrameEvent.status, 'FAIL')
  // scale about the origin pulls the subtitle up into the window for ~1 frame only
  const animated = await textQc(overlaysWith([{ kind: 'subtitle', start: 0, end: 2, body: `{\\an7\\pos(0,0)\\t(1000,1001,\\fscy90)\\t(1033,1034,\\fscy100)\\p1}m 100 1600 l 980 1600 980 1700 100 1700{\\p0}` }]))
  assert.equal(animated.status, 'FAIL', JSON.stringify(animated.evidence))
  const bad = (animated.evidence as any).failed[0]
  assert.ok(bad.badFrames.length >= 1 && bad.badFrames.length <= 2, JSON.stringify(bad))
})

// ---------- identity / receipts ----------
test('17. receipt or MP4 from another job / attempt / render: FAIL', async () => {
  const cases = [
    { renderReceipt: { ...bright.renderReceipt, jobId: 'job_other' } },
    { renderReceipt: { ...bright.renderReceipt, attempt: 2 } },
    { assetReceipt: { ...bright.assetReceipt, jobId: 'job_other' } },
    { assetReceipt: { ...bright.assetReceipt, attempt: 3 } },
    { assetReceipt: { ...bright.assetReceipt, outputSha256: 'f'.repeat(64) } },
    { renderReceipt: { ...bright.renderReceipt, renderHash: 'e'.repeat(64) } }
  ]
  for (const c of cases) assert.equal((await geometryContractCheck(qc(bright, c).input)).status, 'FAIL', JSON.stringify(Object.keys(c)))
  // the MP4 QC looked at is not the variant's render
  const mixed = qc(bright); mixed.input.renderBytesSha256 = 'd'.repeat(64)
  assert.equal((await outputIdentityCheck(mixed.input)).status, 'FAIL')
  // the latest ASSET produced a different source than the one the job resolves
  const stale = qc(bright); stale.input.assetRun.result.source.sha256 = 'c'.repeat(64)
  assert.equal((await outputIdentityCheck(stale.input)).status, 'FAIL')
})

test('18. missing geometry evidence is UNKNOWN and blocks', async () => {
  const noManifest = qc(bright); noManifest.input.assetManifest = null
  const noImage = qc(bright); noImage.input.getBytes = async () => null
  const noAsset = qc(bright); noAsset.input.assetRun = null
  for (const x of [noManifest, noImage, noAsset]) {
    const checks = await runScreenDnaQc(x.input, x.cuts)
    assert.equal(status(checks, 'wisdom.screen_dna_layout'), 'UNKNOWN')
    assert.equal(evaluateGate(checks).decision, 'BLOCK')
  }
})

test('19. output that is not 1080x1920: FAIL', async () => {
  const b = await build('bright', BASE, 'scale=1080:1918')
  const { input } = qc(b, { renderReceipt: { ...b.renderReceipt, renderHash: b.out.sha256 } })
  assert.equal(b.out.info.height, 1918)
  assert.equal((await outputIdentityCheck(input)).status, 'FAIL')
})

test('20. Screen DNA QC is read-only: no media/manifest/receipt changes, no regeneration', async () => {
  const { readFileSync } = await import('node:fs')
  const before = [fx.sha(readFileSync(bright.src.path)), fx.sha(readFileSync(bright.out.path)), bright.manifest.manifestHash, ...bright.src.items.map((x: any) => fx.sha(readFileSync(x.image.ref)))]
  const { input, cuts } = qc(bright)
  const reads: string[] = []; const getBytes = input.getBytes
  input.getBytes = async (ref: string) => { reads.push(ref); return getBytes(ref) }
  await runScreenDnaQc(input, cuts)
  const after = [fx.sha(readFileSync(bright.src.path)), fx.sha(readFileSync(bright.out.path)), bright.manifest.manifestHash, ...bright.src.items.map((x: any) => fx.sha(readFileSync(x.image.ref)))]
  assert.deepEqual(after, before)
  assert.deepEqual([...new Set(reads)].sort(), bright.src.items.map((x: any) => x.image.ref).sort())
  assert.equal(extractRenderPlan(bright.manifest.payload).total, 2.4)
})

test('AUTO_QC (wisdom) runs the Screen DNA contract checks end-to-end and no longer uses luma framing', async () => {
  const { readFileSync } = await import('node:fs')
  const { createMemoryBlobStore, putAddressed } = await import('../lib/jobs/blobs.js')
  const { analyzeSourceFile } = await import('../lib/media/analyze.js')
  const { createAutoQcExecutor } = await import('../worker/stages/autoQc.js')
  const blobs: any = createMemoryBlobStore()
  const b = bright
  for (const it of b.src.items) await blobs.putBytes(it.image.ref, readFileSync(it.image.ref), 'image/jpeg')
  const manifestRef = (await putAddressed(blobs, 'manifests', b.manifest)).path
  const renderRef = `renders/${b.out.sha256}.mp4`; await blobs.putBytes(renderRef, readFileSync(b.out.path), 'video/mp4')
  const assetSpecRef = (await putAddressed(blobs, 'generative-assets', { schema: 'generative-assets/1', items: b.src.items })).path
  const analysisRef = (await putAddressed(blobs, 'analysis', await analyzeSourceFile(b.src.path, { sourceAssetId: 'src_gen_fx', sha256: b.src.sha256 }))).path
  const built = assFromPayload({ ...b.manifest.payload, totalDuration: 2.4 })
  const runs: Record<string, any> = {
    ASSET: { attempt: 1, result: { assetSpecRef, source: { sha256: b.src.sha256 }, geometryReceipt: b.assetReceipt } },
    ANALYZE: { attempt: 1, outputRef: analysisRef, result: {} },
    RENDER: { attempt: 1, result: { variants: [{ variantId: 'v1', label: '추천', manifestHash: b.manifest.manifestHash, manifestRef, renderRef, renderHash: b.out.sha256, duration: 2.4, overlayEvents: built.events, assSha256: fx.sha(built.ass), sourceFraming: null, geometryReceipt: b.renderReceipt }] } },
    PLAN: null
  }
  const ex = createAutoQcExecutor(null)
  const out: any = await ex.run({ job: { id: 'job_fx', profile: 'wisdom', planRev: 1, sourceAssetId: 'src_gen_fx' } as any, attempt: 1, blobs, previous: async (s: string) => runs[s] ?? null, signal: new AbortController().signal,
    resolveSourceAsset: async () => ({ sourceAssetId: 'src_gen_fx', blobPath: 'x', sha256: b.src.sha256 }), resolveSourceFile: async () => ({ path: b.src.path, cleanup: async () => {} }) } as any)
  const checks = out.result.variants[0].gate.checks
  for (const id of ['screen_dna.output_identity', 'screen_dna.geometry_contract', 'screen_dna.source_geometry', 'screen_dna.render_preserves_source', 'screen_dna.text_bands', 'wisdom.screen_dna_layout']) assert.equal(status(checks, id), 'PASS', `${id}: ${JSON.stringify(checks.find((c: any) => c.id === id))}`)
  assert.ok(!JSON.stringify(checks.find((c: any) => c.id === 'wisdom.screen_dna_layout')).includes('luma'))
  assert.equal(ex.estimateUsd({} as any), 0)
})
