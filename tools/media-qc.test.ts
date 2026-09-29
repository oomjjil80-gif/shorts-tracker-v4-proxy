import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileJobPlan } from '../lib/tracker-core/jobCompile.js'
import { renderPayload } from '../lib/media/render.js'
import { analyzeSourceFile } from '../lib/media/analyze.js'
import { runRenderQc } from '../lib/media/qc.js'
import { runOk } from '../lib/media/ffmpeg.js'
import { sha256 } from '../lib/jobs/blobs.js'
import { makeSyntheticSource } from './fixtures/makeVideo.js'

const dir = mkdtempSync(join(tmpdir(), 'media-qc-'))
const src = join(dir, 'src.mp4'), srcBlack = join(dir, 'src-black.mp4')
await makeSyntheticSource(src)
await makeSyntheticSource(srcBlack, { withBlack: true })
const asset = { sourceAssetId: 'src_qc_fixture_0001', blobPath: 'source-collector/qc.mp4', sha256: 'b'.repeat(64), duration: 12 }
const plan = (variantPlan: any) => ({ schema: 'job-plan/1' as const, profile: 'source_shorts' as const, sourceAssetId: asset.sourceAssetId, variantPlan })
const BEATS = [{ label: 'a', trimStart: 9, trimEnd: 11.5 }, { label: 'b', trimStart: 0, trimEnd: 4 }, { label: 'c', trimStart: 6, trimEnd: 8 }]
const compile = (vp: any) => compileJobPlan({ jobId: 'j', plan: plan(vp), sourceAsset: asset }).manifest.payload
const analysisFor = (file: string) => analyzeSourceFile(file, { sourceAssetId: asset.sourceAssetId, sha256: asset.sha256 })

let n = 0
async function renderAndQc(payload: any, o: { file?: string; qcPayload?: any; mutate?: (out: string) => Promise<string> | string; expectHashOfOriginal?: boolean } = {}) {
  const w = join(dir, `w${++n}`), out = join(w, 'final.mp4'), file = o.file ?? src
  const r = await renderPayload(payload, { sourceFile: file, sourceHasAudio: true, workDir: w, outPath: out })
  const original = readFileSync(out)
  const renderPath = o.mutate ? await o.mutate(out) : out
  const qc = await runRenderQc({
    renderPath, expectedRenderHash: sha256(original), payload: o.qcPayload ?? payload, sourceFile: file, analysis: await analysisFor(file),
    render: { overlayEvents: r.overlayEvents, assSha256: r.assPath ? sha256(r.ass) : null }, workDir: w
  })
  const status = (id: string) => qc.gate.checks.find((c) => c.id === id)?.status
  return { qc, status, r }
}

test('good render: every required check PASSes and the gate passes', async () => {
  const { qc } = await renderAndQc(compile({ profile: 'v1', beats: BEATS, headline: '왜 저럴까?', events: [{ start: 1, end: 3, text: '자막입니다' }], plansTimeDomain: 'source' }))
  assert.equal(qc.gate.decision, 'PASS', JSON.stringify(qc.gate.reasons))
  assert.ok(qc.gate.checks.filter((c) => c.required).length >= 12)
})

test('wrong order / wrong trim: frame matching catches a render that does not match its manifest', async () => {
  const good = compile({ profile: 'v1', beats: BEATS })
  const swapped = compile({ profile: 'v1', beats: [BEATS[1], BEATS[0], BEATS[2]] })
  const { qc, status } = await renderAndQc(swapped, { qcPayload: good })
  assert.equal(status('timeline.segment_order_and_trim'), 'FAIL')
  assert.equal(qc.gate.decision, 'BLOCK')
})

test('truncated / corrupt file: integrity + decode fail, gate blocks', async () => {
  const { qc, status } = await renderAndQc(compile({ profile: 'v1', beats: BEATS }), { mutate: (out) => { const p = out + '.cut.mp4'; writeFileSync(p, readFileSync(out).subarray(0, 60_000)); return p } })
  assert.equal(status('file.integrity'), 'FAIL')
  assert.equal(qc.gate.decision, 'BLOCK')
  assert.notEqual(status('decode.full'), 'PASS')
})

test('wrong format (720p) and missing audio are FAIL, not tolerated', async () => {
  const payload = compile({ profile: 'v1', beats: BEATS })
  const small = await renderAndQc(payload, { mutate: async (out) => { const p = out + '.720.mp4'; await runOk(['-y', '-i', out, '-vf', 'scale=720:1280', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', p]); return p } })
  assert.equal(small.status('video.format'), 'FAIL'); assert.equal(small.qc.gate.decision, 'BLOCK')
  const mute = await renderAndQc(payload, { mutate: async (out) => { const p = out + '.mute.mp4'; await runOk(['-y', '-i', out, '-an', '-c:v', 'copy', '-movflags', '+faststart', p]); return p } })
  assert.equal(mute.status('audio.format'), 'FAIL'); assert.equal(mute.status('audio.present_and_alive'), 'FAIL')
})

test('black frames inside the output block the gate', async () => {
  const { qc, status } = await renderAndQc(compile({ profile: 'v1', beats: [{ label: 'a', trimStart: 3.5, trimEnd: 6.5 }, { label: 'b', trimStart: 0, trimEnd: 2 }] }), { file: srcBlack })
  assert.equal(status('visual.no_black'), 'FAIL'); assert.equal(qc.gate.decision, 'BLOCK')
})

test('overlay that cannot fit the safe area is FAIL (clipping is measured, not assumed)', async () => {
  const payload = compile({ profile: 'v1', beats: BEATS, effectCaptions: [{ text: '가'.repeat(40), start: 0, end: 2, xPct: 92, yPct: 50, fontSizePct: 12 }] })
  const { status, qc } = await renderAndQc(payload)
  assert.equal(status('overlay.safe_area_no_clipping'), 'FAIL'); assert.equal(qc.gate.decision, 'BLOCK')
})

test('overlay list that differs from what the manifest asks for is FAIL', async () => {
  const payload = compile({ profile: 'v1', beats: BEATS, headline: '제목', events: [{ start: 1, end: 3, text: '자막' }], plansTimeDomain: 'source' })
  const w = join(dir, `w-ov`), out = join(w, 'final.mp4')
  const r = await renderPayload(payload, { sourceFile: src, sourceHasAudio: true, workDir: w, outPath: out })
  const qc = await runRenderQc({ renderPath: out, expectedRenderHash: sha256(readFileSync(out)), payload, sourceFile: src, analysis: await analysisFor(src), render: { overlayEvents: r.overlayEvents.slice(1), assSha256: sha256(r.ass) }, workDir: w })
  assert.equal(qc.gate.checks.find((c) => c.id === 'overlay.matches_manifest')?.status, 'FAIL')
})

test('a check that cannot run is UNKNOWN and blocks (missing source file)', async () => {
  const payload = compile({ profile: 'v1', beats: BEATS })
  const w = join(dir, 'w-unk'), out = join(w, 'final.mp4')
  const r = await renderPayload(payload, { sourceFile: src, sourceHasAudio: true, workDir: w, outPath: out })
  const qc = await runRenderQc({ renderPath: out, expectedRenderHash: sha256(readFileSync(out)), payload, sourceFile: join(dir, 'does-not-exist.mp4'), analysis: await analysisFor(src), render: { overlayEvents: r.overlayEvents, assSha256: null }, workDir: w })
  assert.equal(qc.gate.checks.find((c) => c.id === 'timeline.segment_order_and_trim')?.status, 'UNKNOWN')
  assert.equal(qc.gate.decision, 'BLOCK')
})

test('unsupported manifests are refused by the renderer (never approximated)', async () => {
  const payload = compile({ profile: 'v1', beats: BEATS })
  const bad = JSON.parse(JSON.stringify(payload)); bad.bgm = { assetId: 'x' }
  await assert.rejects(() => renderPayload(bad, { sourceFile: src, sourceHasAudio: true, workDir: join(dir, 'wx'), outPath: join(dir, 'wx', 'o.mp4') }), /BGM/)
  const bad2 = JSON.parse(JSON.stringify(payload)); bad2.renderSettings = { width: 1920, height: 1080, fps: 30 }
  await assert.rejects(() => renderPayload(bad2, { sourceFile: src, sourceHasAudio: true, workDir: join(dir, 'wy'), outPath: join(dir, 'wy', 'o.mp4') }), /1080x1920/)
  const bad3 = JSON.parse(JSON.stringify(payload)); bad3.cuts[1].start += 1
  await assert.rejects(() => renderPayload(bad3, { sourceFile: src, sourceHasAudio: true, workDir: join(dir, 'wz'), outPath: join(dir, 'wz', 'o.mp4') }), /contiguous/)
})

test('source without an audio track still renders a valid AAC track (silent by design)', async () => {
  const noAudio = join(dir, 'silent.mp4'); await makeSyntheticSource(noAudio, { noAudio: true })
  const w = join(dir, 'w-na'), out = join(w, 'final.mp4')
  const payload = compile({ profile: 'v1', beats: BEATS })
  const r = await renderPayload(payload, { sourceFile: noAudio, sourceHasAudio: false, workDir: w, outPath: out })
  const analysis = await analysisFor(noAudio)
  assert.equal(analysis.audio.intentionallySilent, true)
  const qc = await runRenderQc({ renderPath: out, expectedRenderHash: sha256(readFileSync(out)), payload, sourceFile: noAudio, analysis, render: { overlayEvents: r.overlayEvents, assSha256: null }, workDir: w })
  assert.equal(qc.gate.decision, 'PASS', JSON.stringify(qc.gate.reasons))
})
