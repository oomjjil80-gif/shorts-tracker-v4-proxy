// PR2 content-pipeline modularization: feature modules (IMAGE/TTS/CAPTION/SOUND/THUMBNAIL/QC) selectable per Profile.
// Detach proofs use TEST profiles only; the three production profiles select exactly what they always used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PROFILES, type FeatureId, type ProfileSpec } from '../lib/jobs/profiles.js'
import { createMemoryBlobStore, putAddressed } from '../lib/jobs/blobs.js'
import { runOk } from '../lib/media/ffmpeg.js'
import { assFromPayload } from '../lib/media/ass.js'
import { featureListErrors, profileFeatures } from '../worker/modules/features.js'
import { createModuleRegistry, stageExecutorsFor, profileErrors, type ExistingExecutors } from '../worker/modules/registry.js'
import { createGenerativeAssetExecutor, createGenerativePlanExecutor } from '../worker/stages/generative.js'
import { wisdomCaptionEvents } from '../lib/generative/wisdom.js'
import { normalizeGenerativeBrief } from '../lib/generative/contracts.js'
import { createLongformAssetExecutor } from '../worker/stages/longform.js'
import { createRenderExecutor } from '../worker/stages/render.js'
import { withWisdomThumbnail } from '../worker/stages/wisdomThumbnail.js'
import type { StageExecutor } from '../worker/types.js'

const h = (x: string | Buffer) => createHash('sha256').update(x).digest('hex')
const only = (fs: FeatureId[]) => () => new Set(fs)
const without = (id: keyof typeof PROFILES, ...drop: FeatureId[]) => only(PROFILES[id].features.filter((f) => !drop.includes(f)))
const testProfile = (id: keyof typeof PROFILES, features: FeatureId[]): ProfileSpec => ({ ...PROFILES[id], features })
const spy = (stage: any): StageExecutor => ({ stage, estimateUsd: () => 0, inputHash: () => 'x', run: async () => ({}) })
const X: ExistingExecutors = {
  analyze: spy('ANALYZE'), sourcePlan: spy('PLAN'), wisdomPlan: spy('PLAN'), wisdomAsset: spy('ASSET'), compile: spy('COMPILE'), render: spy('RENDER'), autoQc: spy('AUTO_QC'),
  decision: spy('DECISION'), final: spy('FINAL'), shortsPackage: spy('PACKAGE'), longformPlan: spy('PLAN'), longformAsset: spy('ASSET'), longformRender: spy('RENDER'), longformPackage: spy('PACKAGE')
}
const registry = createModuleRegistry(X)

// ---------- compatibility ----------
test('production profiles: feature selection is exactly the existing behaviour and the table is valid', () => {
  assert.deepEqual(PROFILES.source_shorts.features, ['ANALYZE', 'PLAN', 'TTS', 'CAPTION', 'SOUND', 'RENDER', 'QC', 'PACKAGE'])
  assert.deepEqual(PROFILES.wisdom.features, ['PLAN', 'IMAGE', 'TTS', 'ANALYZE', 'CAPTION', 'RENDER', 'QC', 'THUMBNAIL', 'PACKAGE'])
  assert.deepEqual(PROFILES.wisdom_longform.features, ['PLAN', 'IMAGE', 'TTS', 'CAPTION', 'LONGFORM_RENDER', 'THUMBNAIL', 'QC', 'PACKAGE'])
  assert.deepEqual(profileErrors(registry), [])
  // Senior Longform runs the same Longform modules and features (its scenes mode is chosen inside the engine)
  assert.deepEqual(PROFILES.senior_longform.features, PROFILES.wisdom_longform.features)
  assert.deepEqual(PROFILES.senior_longform.modules, PROFILES.wisdom_longform.modules)
  // 숨은야사 Longform too (its DNA-planned scenes mode is chosen inside the engine)
  assert.deepEqual(PROFILES.yasa_longform.features, PROFILES.wisdom_longform.features)
  assert.deepEqual(PROFILES.yasa_longform.modules, PROFILES.wisdom_longform.modules)
  assert.deepEqual(Object.values(PROFILES).map((p) => p.stages.length), [8, 9, 4, 4, 4]) // job stages unchanged
  // Wisdom never mixed General Shorts narration (resolveSourceShortsNarration returned null for it): no SOUND selected
  assert.equal(profileFeatures({ profile: 'wisdom' } as any).has('SOUND'), false)
  assert.equal(profileFeatures({ profile: 'source_shorts' } as any).has('SOUND'), true)
})

// ---------- configuration errors before anything runs ----------
test('wrong feature order / unknown / duplicate is blocked before execution', () => {
  assert.match(featureListErrors({ id: 'source_shorts', features: ['ANALYZE', 'PLAN', 'SOUND', 'TTS', 'CAPTION', 'RENDER', 'QC', 'PACKAGE'] }).join(';'), /SOUND needs TTS before it/)
  assert.match(featureListErrors({ id: 'wisdom_longform', features: ['PLAN', 'IMAGE', 'TTS', 'LONGFORM_RENDER', 'CAPTION', 'THUMBNAIL', 'QC', 'PACKAGE'] }).join(';'), /LONGFORM_RENDER needs CAPTION before it/)
  assert.match(featureListErrors({ id: 'wisdom', features: ['QC', 'PLAN', 'RENDER'] }).join(';'), /QC needs RENDER or LONGFORM_RENDER/)
  assert.match(featureListErrors({ id: 'wisdom', features: ['PLAN', 'IMAGE', 'IMAGE', 'BGM' as any] }).join(';'), /IMAGE listed twice.*unknown feature BGM/)
  const bad = testProfile('source_shorts', ['ANALYZE', 'PLAN', 'SOUND', 'TTS', 'CAPTION', 'RENDER', 'QC', 'PACKAGE'])
  assert.throws(() => stageExecutorsFor(registry, [bad]), /profile\/module wiring is invalid: .*SOUND needs TTS/)
})

test('a module whose required feature is not selected is a configuration error (no automatic insert)', () => {
  assert.match(profileErrors(registry, [testProfile('wisdom', ['PLAN', 'TTS', 'ANALYZE', 'CAPTION', 'RENDER', 'QC', 'THUMBNAIL', 'PACKAGE'])]).join(';'), /wisdom\.ASSET: module wisdom\.asset needs feature IMAGE/)
  assert.match(profileErrors(registry, [testProfile('wisdom_longform', ['PLAN', 'IMAGE', 'TTS', 'CAPTION', 'LONGFORM_RENDER', 'QC', 'PACKAGE'])]).join(';'), /longform\.package needs feature THUMBNAIL/)
  assert.match(profileErrors(registry, [testProfile('wisdom_longform', ['PLAN', 'IMAGE', 'TTS', 'LONGFORM_RENDER', 'THUMBNAIL', 'QC', 'PACKAGE'])]).join(';'), /LONGFORM_RENDER needs CAPTION|longform\.render needs feature CAPTION/)
  assert.match(profileErrors(registry, [testProfile('source_shorts', ['ANALYZE', 'PLAN', 'CAPTION', 'SOUND', 'RENDER', 'QC', 'PACKAGE'])]).join(';'), /SOUND needs TTS/)
})

// ---------- Wisdom ASSET: IMAGE / TTS / CAPTION ----------
async function wisdomFixture() {
  const jpg = (await runOk(['-f', 'lavfi', '-i', 'color=c=gray:s=64x96:d=1', '-frames:v', '1', '-f', 'mjpeg', '-'])).stdout
  const mp3 = (await runOk(['-f', 'lavfi', '-i', 'sine=f=440:d=1.2', '-c:a', 'libmp3lame', '-f', 'mp3', '-'])).stdout
  const blobs: any = createMemoryBlobStore()
  const script: any = { schema: 'wisdom-script/1', title: '나이 들수록 말을 아끼는 이유', hook: 'h', ending: 'e', totalSeconds: 6, beats: [1, 2, 3].map((i) => ({ id: 'b' + i, narration: '나레이션 ' + i + '번 문장입니다', visualGoal: 'g', imagePrompt: 'scene ' + i, durationSec: 2 })) }
  const stored = await putAddressed(blobs, 'generative-scripts', script)
  const calls = { image: 0, tts: 0 }
  const deps = { apiKey: 'k', image: async (p: string) => { calls.image++; return { bytes: Buffer.concat([jpg, Buffer.from(p)]), contentType: 'image/jpeg', provider: 'standin', model: 'm' } }, tts: async () => { calls.tts++; return { bytes: mp3, contentType: 'audio/mpeg', provider: 'standin', model: 'm' } } }
  const ctx = (n: string) => ({ job: { id: 'j', profile: 'wisdom', planRev: 1, sourceAssetId: 'src_gen_' + n } as any, blobs, attempt: 1, previous: async (s: string) => (s === 'PLAN' ? { result: { scriptRef: stored.path } } : null) as any, signal: new AbortController().signal } as any)
  return { blobs, calls, deps, ctx }
}

test('IMAGE excluded: 0 image calls (and 0 TTS) — Wisdom ASSET fails as a configuration error before any paid call', async () => {
  const { blobs, calls, deps, ctx } = await wisdomFixture()
  const before = blobs.binaries.size
  await assert.rejects(createGenerativeAssetExecutor({ ...deps, features: without('wisdom', 'IMAGE') }).run(ctx('a')), (e: any) => e.code === 'MODULE_CONFIG' && /IMAGE/.test(e.message) && e.retryable === false)
  assert.deepEqual(calls, { image: 0, tts: 0 }); assert.equal(blobs.binaries.size, before)
  const lfCalls = { image: 0, tts: 0 }
  await assert.rejects(createLongformAssetExecutor({ apiKey: 'k', image: async () => { lfCalls.image++; throw new Error('no') }, tts: async () => { lfCalls.tts++; throw new Error('no') }, features: without('wisdom_longform', 'IMAGE') })
    .run({ job: { id: 'l', profile: 'wisdom_longform', planRev: 1 }, blobs, previous: async () => null, signal: new AbortController().signal } as any), (e: any) => e.code === 'MODULE_CONFIG')
  assert.deepEqual(lfCalls, { image: 0, tts: 0 })
})

test('TTS excluded: 0 TTS calls (and 0 image) — Wisdom ASSET fails as a configuration error before any paid call', async () => {
  const { calls, deps, ctx } = await wisdomFixture()
  await assert.rejects(createGenerativeAssetExecutor({ ...deps, features: without('wisdom', 'TTS') }).run(ctx('b')), (e: any) => e.code === 'MODULE_CONFIG' && /TTS/.test(e.message))
  assert.deepEqual(calls, { image: 0, tts: 0 })
})

test('CAPTION excluded in Wisdom ASSET: no caption events; IMAGE/TTS cache is reused (no extra call, same assets, same timing)', async () => {
  const { blobs, calls, deps, ctx } = await wisdomFixture()
  const full: any = await createGenerativeAssetExecutor(deps).run(ctx('c'))
  assert.deepEqual(calls, { image: 3, tts: 3 })
  const fullPlan: any = await blobs.getJson(full.result.timedPlanRef)
  assert.ok(fullPlan.variantPlan.events.length > 0)
  // stage retry with a different (caption-less) selection: every image/TTS comes from the cache
  const noCap: any = await createGenerativeAssetExecutor({ ...deps, features: without('wisdom', 'CAPTION') }).run(ctx('c'))
  assert.deepEqual(calls, { image: 3, tts: 3 }, 'no image/TTS call: caching untouched by the CAPTION change')
  assert.equal(noCap.result.reused, 6); assert.equal(noCap.result.generated, 0)
  const a: any = await blobs.getJson(full.result.assetSpecRef), b: any = await blobs.getJson(noCap.result.assetSpecRef)
  assert.deepEqual(b.items.map((x: any) => [x.image.ref, x.tts.ref, x.durationSec]), a.items.map((x: any) => [x.image.ref, x.tts.ref, x.durationSec]))
  assert.equal(noCap.result.source.sha256, full.result.source.sha256) // same composed video
  assert.deepEqual((await blobs.getJson(noCap.result.timedPlanRef) as any).variantPlan.events, [])
  // and a plain retry with the production selection reuses everything too
  await createGenerativeAssetExecutor(deps).run(ctx('c'))
  assert.deepEqual(calls, { image: 3, tts: 3 })
})

// ---------- General Shorts RENDER: TTS -> CAPTION -> SOUND -> RENDER ----------
async function renderFixture() {
  const d = await mkdtemp(join(tmpdir(), 'pf-render-'))
  const src = join(d, 'src.mp4')
  await runOk(['-y', '-f', 'lavfi', '-i', 'testsrc=s=360x640:d=2:r=30', '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src])
  const voice = (await runOk(['-f', 'lavfi', '-i', 'sine=f=600:d=1', '-c:a', 'libmp3lame', '-f', 'mp3', '-'])).stdout
  const blobs: any = createMemoryBlobStore()
  const plan = await putAddressed(blobs, 'plans', { schema: 'job-plan/1', profile: 'source_shorts', sourceAssetId: 'src_test_000001', variantPlan: { beats: [{ trimStart: 0, trimEnd: 2 }], audioMode: 'dub', voiceover: { mode: 'timed', lines: [{ start: 0, end: 2, text: '안녕하세요 오늘의 이야기입니다' }], sourceVolume: 0, voiceVolume: 1 } } })
  const payload = { renderSettings: { width: 1080, height: 1920 }, cuts: [{ mediaType: 'source_video', sourceVideo: { trimStart: 0, trimEnd: 2 }, start: 0, duration: 2 }], editorialPlan: { headline: '테스트 제목' }, subtitleEvents: [{ start: 0, end: 2, text: '자막 한 줄' }] }
  const manifestHash = h(JSON.stringify(payload))
  const m = await putAddressed(blobs, 'manifests', { manifestHash, payload, identity: [] })
  const calls = { tts: 0, caption: 0, sound: 0 }
  const deps = {
    apiKey: 'k', tts: async () => { calls.tts++; return { bytes: voice, contentType: 'audio/mpeg', provider: 'standin', model: 'm' } },
    caption: (p: any) => { calls.caption++; return assFromPayload(p) }
  }
  const ctx = { job: { id: 'r', profile: 'source_shorts', planRev: 1, planRef: plan.path, sourceAssetId: 'src_test_000001' } as any, attempt: 1, blobs, signal: new AbortController().signal,
    previous: async (s: string) => (s === 'COMPILE' ? { result: { variants: [{ variantId: 'v1', label: 'a', manifestHash, manifestRef: m.path, gate: { decision: 'PASS' }, identity: [] }] } } : null) as any,
    resolveSourceAsset: async () => ({ sourceAssetId: 'src_test_000001', blobPath: 'x', sha256: null }), resolveSourceFile: async () => ({ path: src, cleanup: async () => {} }) } as any
  return { calls, deps, ctx }
}
const runRender = async (fx: any, features: any) => {
  const { resolveSourceShortsNarration } = await import('../worker/stages/sourceNarration.js')
  const narration = async (o: any) => { fx.calls.sound++; return resolveSourceShortsNarration(o) }
  return (await createRenderExecutor({ ...fx.deps, narration, features }).run(fx.ctx) as any).result.variants[0]
}

test('General Shorts RENDER with every feature: TTS once, caption once, narration mixed (production behaviour)', async () => {
  const fx = await renderFixture()
  const v = await runRender(fx, profileFeatures)
  assert.deepEqual(fx.calls, { tts: 1, caption: 1, sound: 1 })
  assert.ok(v.voiceover?.ref?.startsWith('source-shorts-assets/audio/')); assert.ok(v.assSha256)
})

test('SOUND excluded: 0 audio-mix calls and no narration TTS (SOUND is its only consumer); caption still drawn', async () => {
  const fx = await renderFixture()
  const v = await runRender(fx, without('source_shorts', 'SOUND'))
  assert.deepEqual(fx.calls, { tts: 0, caption: 1, sound: 0 })
  assert.equal(v.voiceover, null); assert.ok(v.assSha256)
})

test('TTS excluded (with SOUND, which needs it): 0 TTS calls; the render has no narration', async () => {
  const fx = await renderFixture()
  const p = testProfile('source_shorts', ['ANALYZE', 'PLAN', 'CAPTION', 'RENDER', 'QC', 'PACKAGE'])
  assert.deepEqual(profileErrors(registry, [p]), [])
  const v = await runRender(fx, only([...p.features]))
  assert.deepEqual(fx.calls, { tts: 0, caption: 1, sound: 0 })
  assert.equal(v.voiceover, null)
})

test('CAPTION excluded: 0 caption-generation calls, no overlay; TTS + SOUND unaffected', async () => {
  const fx = await renderFixture()
  const v = await runRender(fx, without('source_shorts', 'CAPTION'))
  assert.deepEqual(fx.calls, { tts: 1, caption: 0, sound: 1 })
  assert.equal(v.assSha256, null); assert.ok(v.voiceover)
  assert.deepEqual(v.overlayEvents, [])
})

// ---------- THUMBNAIL (Wisdom Shorts PACKAGE) ----------
test('THUMBNAIL excluded: 0 thumbnail image/render calls, upload text still made by PACKAGE (one kit call, no repair)', async () => {
  const blobs: any = createMemoryBlobStore()
  const script = await putAddressed(blobs, 'generative-scripts', { schema: 'wisdom-script/1', title: '나이 들수록 설명하지 말아야 할 5가지', hook: '나이가 들수록 말을 아끼는 사람이 더 단단해 보입니다.', beats: [{ narration: '나이가 들수록 말을 아끼는 사람이 더 단단해 보입니다. 특히 이 다섯 가지는 굳이 설명하지 않는 게 좋습니다. 선택, 거절, 사생활, 오해, 그리고 떠난 사람 앞에서 침묵이 대답입니다.' }] })
  const pkgExec: any = { stage: 'PACKAGE', estimateUsd: () => 0, inputHash: () => 'x', run: async ({ blobs }: any) => { const s = await putAddressed(blobs, 'packages', { schema: 'shorts-package/1', finalRenderRef: 'renders/a.mp4' }); return { outputRef: s.path, outputHash: 'h', result: { packageRef: s.path } } } }
  const metadata = {
    title: '나이 들수록 설명하면 손해 보는 5가지｜말을 아끼는 사람이 단단한 이유',
    description: '나이가 들수록 모든 걸 해명하려는 습관이 오히려 관계를 피곤하게 만듭니다. 선택, 거절, 사생활, 오해, 그리고 떠난 사람 앞에서 왜 침묵이 더 강한 대답이 되는지 다섯 가지 장면으로 정리했습니다. 말을 줄이고도 존중받는 태도를 찾고 있다면 끝까지 보세요.',
    tags: ['말을 아끼는 법', '거절하는 법', '해명하지 않기', '중년 인간관계', '사생활 지키기', '오해 대처법', '침묵의 힘', '단단한 사람', '인간관계 조언'],
    hashtags: ['#말을아끼는법', '#거절하는법', '#인간관계', '#지혜'],
    pinnedComment: '다섯 가지 중에서 가장 설명하고 싶어지는 건 무엇인가요? 거절할 때인가요, 오해받을 때인가요?'
  }
  const calls = { kit: 0, image: 0 }
  // copy that would FAIL the thumbnail rules (it is the title): with THUMBNAIL off it must not trigger a repair call
  const kit = async () => { calls.kit++; return { lines: [{ text: '나이 들수록 설명하지 말아야 할 5가지', color: 'white' }] as any, figure: 'x', metadata } }
  const image = async () => { calls.image++; throw new Error('must not be called') }
  const run = (features: any) => withWisdomThumbnail(pkgExec, { apiKey: 'k', kit, image, features }).run({ job: { id: 'j', profile: 'wisdom' }, blobs, previous: async (s: string) => (s === 'PLAN' ? { result: { scriptRef: script.path } } : null), signal: new AbortController().signal } as any)
  const r: any = await run(without('wisdom', 'THUMBNAIL'))
  assert.deepEqual(calls, { kit: 1, image: 0 })
  assert.equal(r.result.thumbnailRef, null); assert.equal(r.result.uploadReady, true); assert.equal(r.result.thumbnailError, undefined)
  const pkg: any = await blobs.getJson(r.result.packageRef)
  assert.equal(pkg.metadata.title, metadata.title); assert.equal(pkg.thumbnailRef, undefined)
  // production selection: the same bad copy is repaired once (existing behaviour) and the thumbnail is attempted
  calls.kit = 0
  const prod: any = await run(profileFeatures)
  assert.equal(calls.kit, 2); assert.match(String(prod.result.thumbnailError), /thumbnail copy/)
})

// ---------- Astra blockers on #146 ----------
test('CAPTION excluded in Wisdom PLAN: 0 wisdomCaptionEvents calls, events=[]; production plan byte-identical', async () => {
  const blobs: any = createMemoryBlobStore()
  // the planner fixture of tools/p2-planner.test.ts (a script that passes validation and semantic QC)
  const brief = await putAddressed(blobs, 'generative-briefs', normalizeGenerativeBrief({ kind: 'text', text: '관계는 숫자보다 깊이가 중요합니다.', targetSeconds: 40 }))
  const beats = Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, narration: [`관계의 숫자보다 마음의 깊이를 보세요.`, `많은 관계는 때로 마음을 지치게 합니다.`, `하지만 중요한 건 서로를 편안하게 하는 깊이입니다.`, `관계는 숫자보다 깊이가 오래 남습니다.`][i], visualGoal: `goal ${i + 1}`, imagePrompt: `scene ${i + 1}`, durationSec: 10 }))
  const script: any = { schema: 'wisdom-script/1', title: '관계의 깊이', hook: '많은 사람이 꼭 필요할까요?', beats, ending: '편안한 몇 사람이면 충분합니다.', totalSeconds: 40 }
  const bible: any = { schema: 'wisdom-visual-bible/1', style: 'editorial watercolor', palette: 'warm muted', lighting: 'soft', composition: 'single focus', characterPolicy: 'consistent recurring person', negative: 'text, watermark, clutter' }
  let n = 0
  const captions: typeof wisdomCaptionEvents = (...a) => { n++; return wisdomCaptionEvents(...a) }
  const run = (deps: any) => createGenerativePlanExecutor({ apiKey: 'test', plan: async () => ({ script: JSON.parse(JSON.stringify(script)), visualBible: bible }), ...deps }).run({ job: { id: 'p', profile: 'wisdom', planRef: brief.path, sourceAssetId: 'src_gen_p' }, blobs, previous: async () => null, signal: new AbortController().signal } as any) as any
  const plain = await run({})
  const prod = await run({ captions })
  assert.ok(n > 0); assert.equal(prod.outputHash, plain.outputHash) // production: same plan blob as before
  assert.ok(((await blobs.getJson(prod.planRef)) as any).variantPlan.events.length > 0)
  n = 0
  const noCap = await run({ captions, features: without('wisdom', 'CAPTION') })
  assert.equal(n, 0)
  assert.deepEqual(((await blobs.getJson(noCap.planRef)) as any).variantPlan.events, [])
})

test('MODULE_CONFIG contract: wiring errors from stageExecutorsFor carry code MODULE_CONFIG, retryable false', () => {
  const isConfig = (e: any) => e?.code === 'MODULE_CONFIG' && e?.retryable === false && /profile\/module wiring is invalid/.test(e.message)
  const { ['wisdom.plan']: _gone, ...missingModule } = registry
  const cases: [string, () => unknown][] = [
    ['IMAGE missing', () => stageExecutorsFor(registry, [testProfile('wisdom', ['PLAN', 'TTS', 'ANALYZE', 'CAPTION', 'RENDER', 'QC', 'THUMBNAIL', 'PACKAGE'])])],
    ['TTS missing', () => stageExecutorsFor(registry, [testProfile('wisdom_longform', ['PLAN', 'IMAGE', 'CAPTION', 'LONGFORM_RENDER', 'THUMBNAIL', 'QC', 'PACKAGE'])])],
    ['wrong feature order', () => stageExecutorsFor(registry, [testProfile('source_shorts', ['ANALYZE', 'PLAN', 'SOUND', 'TTS', 'CAPTION', 'RENDER', 'QC', 'PACKAGE'])])],
    ['module missing', () => stageExecutorsFor(missingModule)]
  ]
  for (const [name, fn] of cases) assert.throws(fn, isConfig, name)
})
