import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore, sha256 } from '../lib/jobs/blobs.js'
import { runOnce } from '../worker/runJob.js'
import { analyzeExecutor } from '../worker/stages/analyze.js'
import { createPlanExecutor } from '../worker/stages/plan.js'
import { compileExecutor } from '../worker/stages/compile.js'
import { renderExecutor } from '../worker/stages/render.js'
import { autoQcExecutor } from '../worker/stages/autoQc.js'
import { decisionExecutor, finalExecutor, packageExecutor } from '../worker/stages/finish.js'
import { probe, fullDecode } from '../lib/media/ffmpeg.js'
import { makeSyntheticSource } from './fixtures/makeVideo.js'
import { createJobsHttp } from '../lib/jobs/http.js'

const dir = mkdtempSync(join(tmpdir(), 'p1-pipe-'))
const srcPath = join(dir, 'source.mp4')
await makeSyntheticSource(srcPath, { withBlack: false })
const srcSha = sha256(readFileSync(srcPath))
const asset = { sourceAssetId: 'src_p1_fixture_0001', blobPath: 'source-collector/p1/fixture.mp4', sha256: srcSha, duration: 12, width: 576, height: 1024 }

async function setup(executors = [analyzeExecutor, createPlanExecutor(), compileExecutor, renderExecutor, autoQcExecutor, decisionExecutor, finalExecutor, packageExecutor]) {
  const db = await createTestDb()
  const store = createJobStore(db)
  const blobs = createMemoryBlobStore()
  let downloads = 0
  const deps = {
    store, blobs, executors, workerId: 'w1',
    resolveSourceAsset: async (id: string) => { if (id !== asset.sourceAssetId) throw Object.assign(new Error('nf'), { code: 'SOURCE_ASSET_NOT_FOUND' }); return asset },
    resolveSourceFile: async () => { downloads++; return { path: srcPath, cleanup: async () => {} } }
  }
  const drive = async (jobId: string, max = 12) => {
    const trail: string[] = []
    for (let n = 0; n < max; n++) {
      const out = await runOnce(deps)
      if (!out.ran) break
      trail.push(`${out.stage}:${out.outcome}`)
      const j = (await store.getJob(jobId))!
      if (j.status === 'WAITING_USER' || j.status === 'COMPLETE' || j.status === 'FAILED') break
    }
    return trail
  }
  return { db, store, blobs, deps, drive, downloads: () => downloads }
}

test('P1 pipeline: source -> ANALYZE -> PLAN -> COMPILE -> RENDER -> AUTO_QC -> DECISION (real ffmpeg, real files)', async () => {
  const { store, blobs, drive } = await setup()
  const { job } = await store.createJob({ workspaceId: 'ws', profile: 'source_shorts', sourceAssetId: asset.sourceAssetId, idempotencyKey: 'idem-p1-0001', budgetUsd: 5 })
  assert.equal(job.stage, 'ANALYZE')
  const trail = await drive(job.id)
  assert.deepEqual(trail, ['ANALYZE:completed', 'PLAN:completed', 'COMPILE:completed', 'RENDER:completed', 'AUTO_QC:completed', 'DECISION:waiting'])

  const at = (await store.getJob(job.id))!
  assert.deepEqual([at.status, at.stage, at.waitReason], ['WAITING_USER', 'DECISION', 'DECISION'])
  const runs = await store.listStageRuns(job.id)
  for (const stage of ['ANALYZE', 'PLAN', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION']) assert.ok(runs.some((r) => r.stage === stage && r.status === 'SUCCEEDED'), `${stage} SUCCEEDED`)

  // ANALYZE produced a machine-readable analysis bound to the registered source
  const analysis: any = await blobs.getJson((await store.getLatestSucceeded(job.id, 'ANALYZE'))!.outputRef!)
  assert.equal(analysis.schema, 'source-analysis/1'); assert.equal(analysis.sha256, srcSha)
  assert.ok(analysis.timeline.length >= 12 && analysis.scenes.length >= 3)

  // PLAN -> immutable, distinct variants; job continues from the recommended plan
  const plan = (await store.getLatestSucceeded(job.id, 'PLAN'))!
  const planned = (plan.result as any).variants
  assert.ok(planned.length >= 1 && planned.length <= 3)
  assert.equal(at.planRef, planned[0].planRef); assert.equal(at.planRev, 1)

  // RENDER: real MP4s in blob storage, one per passing variant (rendered once, final quality)
  const render = (await store.getLatestSucceeded(job.id, 'RENDER'))!
  const rv = (render.result as any).variants
  assert.equal(rv.length, planned.length)
  assert.equal([...blobs.binaries.keys()].filter((k) => k.startsWith('renders/') && k.endsWith('.mp4')).length, new Set(rv.map((v: any) => v.renderHash)).size)

  // AUTO_QC: every required check PASS for the rendered file (measured on the real bytes)
  const qc = (await store.getLatestSucceeded(job.id, 'AUTO_QC'))!.result as any
  assert.equal(qc.recommendedVariantId, 'v1')
  const gate = qc.variants[0].gate
  assert.equal(gate.decision, 'PASS', JSON.stringify(gate.reasons))
  assert.ok(gate.counts.requiredTotal >= 12 && gate.counts.requiredPass === gate.counts.requiredTotal)
  for (const id of ['decode.full', 'timeline.segment_order_and_trim', 'duration.matches_manifest', 'video.format', 'audio.present_and_alive', 'visual.no_black']) assert.equal(gate.checks.find((c: any) => c.id === id)?.status, 'PASS', id)

  // content gate is recorded separately; without a semantic model it is BLOCK (UNKNOWN) and the video is NOT publishable
  const v0 = qc.variants[0]
  assert.equal(v0.contentGate.decision, 'BLOCK'); assert.equal(v0.publishable, false)
  assert.ok(v0.contentGate.checks.some((c: any) => c.id === 'content.payoff_present' && c.status === 'UNKNOWN'))
  assert.equal(qc.semantic.status, 'unavailable'); assert.equal(qc.publishable, 0)

  // the stored MP4 is a real 1080x1920 H.264/AAC file that fully decodes
  const bytes = blobs.binaries.get(rv[0].renderRef)!
  const f = join(dir, 'check.mp4'); (await import('node:fs')).writeFileSync(f, bytes)
  const info = await probe(f)
  assert.deepEqual([info.width, info.height, info.videoCodec, info.audioCodec, info.pixFmt, info.sar], [1080, 1920, 'h264', 'aac', 'yuv420p', '1:1'])
  assert.equal((await fullDecode(f)).ok, true)
  assert.ok(Math.abs(info.duration! - rv[0].duration) < 0.1)
})

test('DECISION -> FINAL -> PACKAGE: the chosen render is promoted as the same blob (no re-render); job COMPLETE', async () => {
  const { store, blobs, drive, deps } = await setup()
  const { job } = await store.createJob({ workspaceId: 'ws', profile: 'source_shorts', sourceAssetId: asset.sourceAssetId, idempotencyKey: 'idem-p1-0002', budgetUsd: 5 })
  await drive(job.id)
  const qc = (await store.getLatestSucceeded(job.id, 'AUTO_QC'))!.result as any
  const chosen = qc.variants[qc.variants.length - 1]
  const rendersBefore = blobs.binaries.size
  const decided = await store.recordDecision({ jobId: job.id, workspaceId: 'ws', manifestHash: chosen.manifestHash })
  assert.deepEqual([decided.status, decided.stage, decided.approvedManifestHash], ['QUEUED', 'FINAL', chosen.manifestHash])
  const trail = await drive(job.id)
  assert.deepEqual(trail, ['FINAL:completed', 'PACKAGE:completed'])
  const done = (await store.getJob(job.id))!
  assert.equal(done.status, 'COMPLETE')
  const fin = (await store.getLatestSucceeded(job.id, 'FINAL'))!.result as any
  assert.equal(fin.finalRenderRef, chosen.renderRef); assert.equal(fin.promoted, 'same-blob')
  assert.equal(blobs.binaries.size, rendersBefore, 'promotion wrote no new render')
  const pkg: any = await blobs.getJson((await store.getLatestSucceeded(job.id, 'PACKAGE'))!.outputRef!)
  assert.deepEqual([pkg.schema, pkg.renderHash, pkg.manifestHash, pkg.sourceAssetId], ['shorts-package/1', chosen.renderHash, chosen.manifestHash, asset.sourceAssetId])
  assert.equal(pkg.qc.decision, 'PASS'); assert.ok(pkg.qc.checks.length >= 12)
  void deps
})

test('QC block: a corrupted render is never promoted (AUTO_QC blocks; decision without override is refused)', async () => {
  const { store, blobs, drive } = await setup()
  const { job } = await store.createJob({ workspaceId: 'ws', profile: 'source_shorts', sourceAssetId: asset.sourceAssetId, idempotencyKey: 'idem-p1-0003', budgetUsd: 5 })
  // run up to RENDER, then corrupt every rendered file before AUTO_QC sees it
  for (let n = 0; n < 4; n++) await runOnce({ ...(await (async () => ({}))()), store, blobs, executors: [analyzeExecutor, createPlanExecutor(), compileExecutor, renderExecutor], workerId: 'w1', resolveSourceAsset: async () => asset, resolveSourceFile: async () => ({ path: srcPath, cleanup: async () => {} }) } as any)
  for (const [k, v] of blobs.binaries) if (k.endsWith('.mp4')) blobs.binaries.set(k, v.subarray(0, Math.floor(v.length / 2)))
  const out = await runOnce({ store, blobs, executors: [autoQcExecutor], workerId: 'w1', resolveSourceAsset: async () => asset, resolveSourceFile: async () => ({ path: srcPath, cleanup: async () => {} }) })
  assert.equal(out.ran && out.outcome, 'waiting')
  const j = (await store.getJob(job.id))!
  assert.deepEqual([j.status, j.stage, j.waitReason], ['WAITING_USER', 'AUTO_QC', 'QC_BLOCKED'])
  const qc = (await store.getLatestSucceeded(job.id, 'AUTO_QC'))!.result as any
  assert.ok(qc.variants.every((v: any) => v.gate.decision === 'BLOCK'))
  assert.equal(qc.recommendedVariantId, null)
  assert.ok(qc.variants[0].gate.checks.some((c: any) => c.id === 'file.integrity' && c.status === 'FAIL'))
})

test('job_create without a plan starts at ANALYZE; job_get exposes a phone-sized view; job_preview signs only this job\'s renders', async () => {
  const { store, blobs, drive } = await setup()
  const http = createJobsHttp({ getStore: async () => store, blobs, sourceExists: async (id) => id === asset.sourceAssetId })
  const KEY = 'k'.repeat(32)
  const call = async (method: string, o: any) => { let status = 0, json: any; await http({ method, headers: { 'x-sync-key': KEY }, query: o.query || {}, body: o.body } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(b: any) { json = b; return this }, end() { return this } } as any); return { status, json } }
  const c = await call('POST', { body: { taskType: 'job_create', profile: 'source_shorts', sourceAssetId: asset.sourceAssetId, idempotencyKey: 'idem-http-p1-1' } })
  assert.equal(c.status, 201); assert.equal(c.json.job.stage, 'ANALYZE')
  // the API workspace is sha256(key): drive the same job through the worker
  const j0 = (await store.getJob(c.json.job.id))!
  await drive(j0.id)
  const g = await call('GET', { query: { taskType: 'job_get', id: j0.id } })
  assert.equal(g.json.job.status, 'WAITING_USER'); assert.equal(g.json.job.waitReason, 'DECISION')
  assert.deepEqual(g.json.job.stages.map((s: any) => s.state), ['done', 'done', 'done', 'done', 'done', 'waiting', 'pending', 'pending'])
  assert.ok(g.json.job.variants.length >= 1 && g.json.job.variants[0].recommended === true && g.json.job.variants[0].qc === 'PASS')
  const p = await call('GET', { query: { taskType: 'job_preview', id: j0.id } })
  assert.equal(p.status, 200)
  assert.ok(p.json.previews.length >= 1 && p.json.previews.every((x: any) => x.url.includes('renders/')))
  const pick = g.json.job.variants[0]
  const d = await call('POST', { body: { taskType: 'job_decision', jobId: j0.id, manifestHash: pick.manifestHash } })
  assert.equal(d.status, 200); assert.equal(d.json.job.stage, 'FINAL')
})

test('with a semantic story model: chronological story edit, captions grounded, technical AND content gate PASS => publishable; PACKAGE records it', async () => {
  const story = {
    storyType: 'single_event', confidence: 0.9, causalStart: 0, setupRanges: [{ start: 0, end: 3 }], escalationRanges: [{ start: 3, end: 6 }],
    payoffRange: { start: 9, end: 11.5 }, recommendedEnd: 11.8, excludeRanges: [{ start: 6, end: 9, reason: 'repeat' }],
    hookStrategy: 'chronological', previewRange: null, hookConfidence: 0.1, hookReason: '',
    minimalCaptions: [
      { kind: 'hook', start: 0, end: 1.8, text: '무슨 일이 생길까?', basis: 'the visible setup begins' },
      { kind: 'payoff', start: 9.5, end: 11, text: '마지막 장면', basis: 'colour bars change' }
    ], publishabilityWarnings: []
  }
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'gpt-test', output_text: JSON.stringify(story) }) })) as unknown as typeof fetch
  const { store, drive } = await setup([analyzeExecutor, createPlanExecutor({ openAi: { apiKey: 'k', model: 'm', fetchImpl } }), compileExecutor, renderExecutor, autoQcExecutor, decisionExecutor, finalExecutor, packageExecutor])
  const { job } = await store.createJob({ workspaceId: 'ws', profile: 'source_shorts', sourceAssetId: asset.sourceAssetId, idempotencyKey: 'idem-p1-sem1', budgetUsd: 5 })
  const trail = await drive(job.id)
  assert.deepEqual(trail, ['ANALYZE:completed', 'PLAN:completed', 'COMPILE:completed', 'RENDER:completed', 'AUTO_QC:completed', 'DECISION:waiting'])
  const analyzeRun = (await store.getLatestSucceeded(job.id, 'ANALYZE'))!
  assert.ok((analyzeRun.result as any).keyframeSheetRef, 'timestamped keyframe sheet produced for the model')
  const plan = (await store.getLatestSucceeded(job.id, 'PLAN'))!.result as any
  assert.equal(plan.semantic.status, 'ok'); assert.equal(plan.provider, 'openai')
  const qc = (await store.getLatestSucceeded(job.id, 'AUTO_QC'))!.result as any
  const v = qc.variants.find((x: any) => x.variantId === qc.recommendedVariantId)
  assert.equal(v.gate.decision, 'PASS', JSON.stringify(v.gate.reasons))
  assert.equal(v.contentGate.decision, 'PASS', JSON.stringify(v.contentGate.reasons))
  assert.equal(v.publishable, true)
  assert.ok(Math.abs(v.duration - 8.8) < 0.15, `story edit length ${v.duration}`)
  await store.recordDecision({ jobId: job.id, workspaceId: 'ws', manifestHash: v.manifestHash })
  assert.deepEqual(await drive(job.id), ['FINAL:completed', 'PACKAGE:completed'])
  const pkgRun = (await store.getLatestSucceeded(job.id, 'PACKAGE'))!
  assert.equal((pkgRun.result as any).publishable, true)
})