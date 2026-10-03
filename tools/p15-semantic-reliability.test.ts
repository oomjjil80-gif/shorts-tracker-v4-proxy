// P1.5 semantic reliability: Production failure reproduction (point-in-time ranges, shared 90s abort lifetime) and the
// cost contract (paid model calls per PLAN). No network: every provider is a mock. No paid call is ever made.
import test from 'node:test'
import assert from 'node:assert/strict'
import { aiAnalyzeStory, normalizeProviderStory, AI_PLANNER_PROMPT_VERSION } from '../lib/media/aiPlanner.js'
import { validateStory, semanticFromStory } from '../lib/media/story.js'
import { planVariants } from '../lib/media/plan.js'
import { evaluateContentGate } from '../lib/media/contentGate.js'
import { createPlanExecutor } from '../worker/stages/plan.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { computeHighlights, type SourceAnalysis } from '../lib/media/analyze.js'

const a: SourceAnalysis = {
  schema: 'source-analysis/1', sourceAssetId: 'src_p15_00000001', sha256: 'a'.repeat(64),
  media: { duration: 30, width: 576, height: 1024, fps: 30, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', orientation: 'portrait' },
  scenes: [{ start: 0, end: 30 }], timeline: Array.from({ length: 30 }, (_, t) => ({ t, visual: 0.1 + ((t * 7) % 5) / 100, audioDb: -25 })),
  ranges: { black: [], freeze: [], silent: [] }, audio: { silentRatio: 0, intentionallySilent: false }, highlights: [], usable: [{ start: 0, end: 30 }], analyzer: { name: 'ffmpeg-signals', version: 1 }
}
a.highlights = computeHighlights(a.timeline)
const JPEG = Buffer.from('jpg')

const good = {
  storyType: 'single_event', confidence: 0.9, causalStart: 1,
  setupRanges: [{ start: 1, end: 6 }], escalationRanges: [{ start: 6, end: 15 }],
  payoffRange: { start: 15, end: 19 }, recommendedEnd: 19.5,
  excludeRanges: [{ start: 0, end: 1, reason: 'foreign_text' }, { start: 20, end: 30, reason: 'product_demo' }],
  hookStrategy: 'chronological', previewRange: null, hookConfidence: 0.1, hookReason: '',
  openingHook: { start: 1, end: 2.5, text: '왜 따라가는 걸까?', basis: 'person is visibly following' },
  minimalCaptions: [
    { kind: 'context', start: 5, end: 6.5, text: '조용히 다가온다', basis: 'person approaches' },
    { kind: 'context', start: 9, end: 10.5, text: '계속 뒤를 따라간다', basis: 'person keeps following' },
    { kind: 'context', start: 12.5, end: 14, text: '옆에 선다', basis: 'person stands beside' },
    { kind: 'payoff', start: 16, end: 17.5, text: '결국 같이 움직인다', basis: 'second subject joins' }
  ], publishabilityWarnings: []
}
// What Production's model actually did: every moment is a point (start == end).
const pointy = {
  ...good,
  payoffRange: { start: 16, end: 16 },
  openingHook: { ...good.openingHook, start: 1, end: 1 },
  minimalCaptions: good.minimalCaptions.map((c) => ({ ...c, end: c.start }))
}
const inverted = { ...good, payoffRange: { start: 19, end: 15 } } // not repairable deterministically

type Step = { body?: any; status?: number; delayMs?: number; hang?: boolean }
function mockProvider(steps: Step[]) {
  const seen: Array<{ at: number; prompt: string }> = []
  const f = (async (_url: any, init: any) => {
    const step = steps[Math.min(seen.length, steps.length - 1)]
    seen.push({ at: Date.now(), prompt: JSON.parse(String(init.body)).input[0].content[0].text })
    await new Promise<void>((resolve, reject) => {
      const t = step.hang ? undefined : setTimeout(resolve, step.delayMs ?? 0)
      init.signal?.addEventListener('abort', () => { if (t) clearTimeout(t); reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })) }, { once: true })
    })
    return { ok: (step.status ?? 200) < 400, status: step.status ?? 200, json: async () => (step.status && step.status >= 400 ? { error: { message: 'no credits remaining' } } : { model: 'gpt-test', output_text: JSON.stringify(step.body), usage: { total_tokens: 10 } }) }
  }) as unknown as typeof fetch
  return { f, seen }
}
const run = (steps: Step[], extra: Record<string, unknown> = {}) => {
  const m = mockProvider(steps)
  return aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: JPEG, fetchImpl: m.f, ...extra }).then((r) => ({ r, m }))
}

test('1. REPRO: point-in-time payoffRange fails strict validation (Production failure) but is recovered deterministically with ONE call', async () => {
  const raw = validateStory(normalizeProviderStory(pointy).story === undefined ? pointy : { ...pointy, minimalCaptions: [{ kind: 'hook', ...pointy.openingHook }, ...pointy.minimalCaptions] }, a, { model: 't', promptVersion: 't' })
  assert.equal(raw.story, null)
  assert.ok(raw.errors.some((e) => /payoffRange: empty or inverted range \(16\.\.16/.test(e)), raw.errors.join('; '))
  assert.ok(raw.errors.some((e) => /minimalCaptions\[0\]: empty or inverted range/.test(e)))
  const { r, m } = await run([{ body: pointy }])
  assert.equal(r.status, 'ok', r.reason ?? '')
  assert.equal(m.seen.length, 1, 'no repair call needed')
  assert.equal(r.calls, 1)
  assert.deepEqual(r.story!.payoffRange, { start: 16, end: 19.5 })
  assert.ok(r.warnings.some((w) => /payoffRange .* recommendedEnd/.test(w)))
  assert.ok(r.story!.minimalCaptions.every((c) => c.end - c.start > 0.2))
})

test('2. two zero-length captions (hook + context) are widened from their own anchor; text/anchor/kind unchanged', async () => {
  const body = { ...good, openingHook: { ...good.openingHook, end: good.openingHook.start }, minimalCaptions: good.minimalCaptions.map((c, i) => (i < 2 ? { ...c, end: c.start } : c)) }
  const { r, m } = await run([{ body }])
  assert.equal(r.status, 'ok', r.reason ?? ''); assert.equal(m.seen.length, 1)
  const hook = r.story!.minimalCaptions.find((c) => c.kind === 'hook')!
  assert.deepEqual([hook.start, hook.text], [1, '왜 따라가는 걸까?']); assert.ok(hook.end > hook.start + 0.2)
  const ctx = r.story!.minimalCaptions.filter((c) => c.kind === 'context')
  assert.deepEqual(ctx.map((c) => c.start), [5, 9, 12.5])
  assert.equal(r.warnings.filter((w) => /widened/.test(w)).length, 3)
})

test('normalizer never guesses: inverted ranges, far-away recommendedEnd and out-of-source cues are left untouched', () => {
  const n = normalizeProviderStory({ ...good, payoffRange: { start: 10, end: 10 }, recommendedEnd: 19.5, openingHook: { ...good.openingHook, start: 29.9, end: 29.9 } }, 30)
  assert.deepEqual(n.story.payoffRange, { start: 10, end: 10 }, 'span 9.5s > 4s => not derived')
  assert.equal(n.story.minimalCaptions[0].end, 29.9, 'hook at the very end of the source is not widened past it')
  const inv = normalizeProviderStory({ ...good, payoffRange: { start: 19, end: 15 }, minimalCaptions: [{ kind: 'context', start: 9, end: 5, text: 'x', basis: 'b' }] }, 30)
  assert.deepEqual(inv.story.payoffRange, { start: 19, end: 15 }); assert.equal(inv.story.minimalCaptions.at(-1).end, 5)
  const drop = normalizeProviderStory({ ...good, setupRanges: [{ start: 3, end: 3 }, { start: 1, end: 6 }], excludeRanges: [{ start: 9, end: 9, reason: 'repeat' }] }, 30)
  assert.equal(drop.story.setupRanges.length, 1); assert.equal(drop.story.excludeRanges.length, 0)
  const prev = normalizeProviderStory({ ...good, hookStrategy: 'preview', previewRange: { start: 15, end: 15 } }, 30)
  assert.equal(prev.story.previewRange, null); assert.equal(prev.story.hookStrategy, 'chronological')
})

test('3. REPRO shared-timer bug: slow first call (75% of budget) then repair — repair keeps its OWN budget', async () => {
  // old code: one controller/timer for both calls => repair received only the remaining 25% and was aborted
  const { r, m } = await run([{ body: inverted, delayMs: 150 }, { body: good, delayMs: 100 }], { timeoutMs: 200, repairTimeoutMs: 200 })
  assert.equal(m.seen.length, 2)
  assert.equal(r.status, 'ok', r.reason ?? ''); assert.equal(r.calls, 2)
  assert.match(m.seen[1].prompt, /CORRECTION REQUIRED/)
  assert.match(m.seen[1].prompt, /payoffRange: empty or inverted range \(15\.\.19|payoffRange/)
})

test('4. repair that itself times out => exact invalid state with both reasons; never ok, never a third call', async () => {
  const { r, m } = await run([{ body: inverted }, { hang: true }], { timeoutMs: 200, repairTimeoutMs: 120 })
  assert.equal(r.status, 'invalid'); assert.equal(r.story, null)
  assert.match(r.reason!, /repair failed: provider unreachable \(repair call, \d+ms of 120ms\)/)
  assert.equal(m.seen.length, 2); assert.equal(r.calls, 2)
})

test('5. valid first answer => zero repair calls', async () => {
  const { r, m } = await run([{ body: good }])
  assert.equal(r.status, 'ok'); assert.equal(m.seen.length, 1); assert.equal(r.calls, 1)
})

test('6. partially invalid first answer (not recoverable deterministically) => exactly one repair, then ok', async () => {
  const { r, m } = await run([{ body: inverted }, { body: good }])
  assert.equal(r.status, 'ok'); assert.equal(m.seen.length, 2)
  assert.deepEqual((r.usage as any).attempts.length, 2)
})

test('7. 429 is final: first-call 429 => 1 call; repair-call 429 => 2 calls total, invalid, no further retry', async () => {
  const one = await run([{ status: 429 }, { body: good }])
  assert.equal(one.r.status, 'failed'); assert.match(one.r.reason!, /provider 429/); assert.equal(one.m.seen.length, 1)
  const two = await run([{ body: inverted }, { status: 429 }, { body: good }])
  assert.equal(two.r.status, 'invalid'); assert.match(two.r.reason!, /repair failed: provider 429/); assert.equal(two.m.seen.length, 2)
})

test('8. network timeout on the first call is bounded and final (no repair into a dead provider)', async () => {
  const t0 = Date.now()
  const { r, m } = await run([{ hang: true }, { body: good }], { timeoutMs: 100, repairTimeoutMs: 100 })
  assert.equal(r.status, 'failed'); assert.match(r.reason!, /provider unreachable \(first call/); assert.equal(m.seen.length, 1)
  assert.ok(Date.now() - t0 < 1500)
})

test('stage abort (lease lost / cancel) cancels the in-flight provider call', async () => {
  const ctl = new AbortController()
  const m = mockProvider([{ hang: true }])
  setTimeout(() => ctl.abort(), 50)
  const r = await aiAnalyzeStory(a, { apiKey: 'k', model: 'm', keyframeJpeg: JPEG, fetchImpl: m.f, signal: ctl.signal, timeoutMs: 5000 })
  assert.equal(r.status, 'failed'); assert.equal(m.seen.length, 1)
})

const planHarness = async () => {
  const blobs = createMemoryBlobStore()
  const ref = (await blobs.putJson('analysis/x.json', a)).path
  const sheet = (await blobs.putBytes('analysis/keyframes/x.jpg', JPEG, 'image/jpeg')).path
  const previous = async () => ({ outputRef: ref, result: { keyframeSheetRef: sheet } }) as any
  const job = (id: string): any => ({ id, sourceAssetId: a.sourceAssetId, planRev: 0, referenceProfileRef: null })
  return { blobs, previous, job }
}
const exec = (m: { f: typeof fetch }, extra: Record<string, unknown> = {}) => createPlanExecutor({ openAi: { apiKey: 'k', model: 'm', fetchImpl: m.f }, ...extra } as any)
const go = (e: any, h: any, id: string) => e.run({ job: h.job(id), blobs: h.blobs, previous: h.previous, signal: new AbortController().signal })

test('9. same deterministic input (retry, rerun, another Job on the same source) never pays for the semantic answer twice', async () => {
  const h = await planHarness(); const m = mockProvider([{ body: good }])
  const r1: any = await go(exec(m), h, 'job_a')
  const r2: any = await go(exec(m), h, 'job_b')
  assert.equal(m.seen.length, 1, 'second PLAN served from the semantic cache')
  assert.deepEqual([r1.result.semantic.aiCalls, r2.result.semantic.aiCalls], [1, 0])
  assert.equal(r2.result.semantic.status, 'ok'); assert.equal(r2.result.provider, 'openai')
  assert.deepEqual(r1.result.semantic.storySummary, r2.result.semantic.storySummary)
})

test('failed / invalid answers are NEVER cached (a transient outage must not freeze a bad result)', async () => {
  const h = await planHarness(); const m = mockProvider([{ status: 500 }, { body: good }])
  const r1: any = await go(exec(m), h, 'job_a')
  assert.equal(r1.result.semantic.status, 'failed')
  const r2: any = await go(exec(m), h, 'job_a')
  assert.equal(r2.result.semantic.status, 'ok'); assert.equal(m.seen.length, 2)
})

test('cache is keyed by prompt version / model / analysis: a different model does not reuse another model answer', async () => {
  const h = await planHarness(); const m = mockProvider([{ body: good }])
  await go(exec(m), h, 'job_a')
  const other = createPlanExecutor({ openAi: { apiKey: 'k', model: 'another-model', fetchImpl: m.f } } as any)
  await go(other, h, 'job_b')
  assert.equal(m.seen.length, 2)
})

test('10. Reference job: semantic ok (incl. cached) keeps the existing PlanBridge conditioning and reference result', async () => {
  const h = await planHarness(); const m = mockProvider([{ body: good }])
  const id = 'ref_' + 'a'.repeat(64) + ':editing.cadence'
  const profile: any = { schema: 'reference-profile/1', profileVersion: 1, referenceAssetIds: ['ref_' + 'a'.repeat(64)], sourceAnalysisHashes: ['a'.repeat(64)], constraints: [{ id, axis: 'editing', value: { status: 'measured', meanSceneSeconds: 2 }, evidence: [{ kind: 'time', start: 0, end: 2 }], appliesTo: ['PLAN', 'RENDER', 'QC'] }] }
  const e = exec(m, { resolveReferenceProfile: async () => profile })
  const r1: any = await go(e, h, 'job_ref1'); const r2: any = await go(e, h, 'job_ref2')
  for (const r of [r1, r2]) { assert.equal(r.result.semantic.status, 'ok'); assert.ok(r.result.reference.changes.length > 0, 'beats were really conditioned'); assert.ok([...r.result.reference.applied, ...r.result.reference.unknown].includes(id)) }
  assert.deepEqual(r1.result.reference, r2.result.reference, 'cached semantic answer yields the identical reference conditioning')
  assert.equal(m.seen.length, 1)
})

test('11. fail-closed: semantic invalid/failed => heuristic plan is never content-PASS, never publishable', async () => {
  const { r } = await run([{ body: inverted }, { hang: true }], { timeoutMs: 100, repairTimeoutMs: 80 })
  assert.equal(r.status, 'invalid')
  const [v1] = planVariants(a, { status: r.status, reason: r.reason, story: null })
  assert.ok(v1)
  const { toJobPlan } = await import('../lib/media/plan.js'); const { compileJobPlan } = await import('../lib/tracker-core/jobCompile.js')
  const payload = compileJobPlan({ jobId: 'job_t', plan: toJobPlan(a.sourceAssetId, v1), sourceAsset: { sourceAssetId: a.sourceAssetId, blobPath: 'source-collector/t.mp4', sha256: 'a'.repeat(64), duration: 30 } }).manifest.payload
  const g = evaluateContentGate({ payload, analysis: a, semantic: { status: r.status, reason: r.reason, story: null }, framing: { mode: 'full', crop: null, confidence: 0, sampleCount: 7, detector: 'luma-bands-v1' } as any })
  assert.notEqual(g.decision, 'PASS')
  assert.ok(g.checks.some((c: any) => c.status === 'UNKNOWN'))
})

test('prompt version is bumped (cache + PLAN inputHash separate old and new prompt behaviour)', () => assert.equal(AI_PLANNER_PROMPT_VERSION, 'source-story-analysis/13'))
test('normalization does not turn explicit semantic uncertainty into PASS', async () => {
  const { r } = await run([{ body: { ...pointy, storyType: 'unclear', confidence: 0.3 } }])
  assert.equal(r.status, 'low_confidence')
  void semanticFromStory
})


test('validated single_event remains semantic ok when provider confidence is advisory-low; unclear still fails closed', () => {
  const validatedLow = validateStory({ ...good, confidence: 0.42, minimalCaptions: [{ kind: 'hook', ...good.openingHook }, ...good.minimalCaptions] }, a, { model: 't', promptVersion: AI_PLANNER_PROMPT_VERSION })
  assert.ok(validatedLow.story, validatedLow.errors.join('; '))
  const usable = semanticFromStory(validatedLow.story!)
  assert.equal(usable.status, 'ok')
  assert.match(usable.reason || '', /confidence=0\.42/)

  const validatedUnclear = validateStory({ ...good, storyType: 'unclear', confidence: 0.42, minimalCaptions: [{ kind: 'hook', ...good.openingHook }, ...good.minimalCaptions] }, a, { model: 't', promptVersion: AI_PLANNER_PROMPT_VERSION })
  assert.ok(validatedUnclear.story, validatedUnclear.errors.join('; '))
  assert.equal(semanticFromStory(validatedUnclear.story!).status, 'low_confidence')
})
