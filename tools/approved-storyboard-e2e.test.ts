// 수락 시나리오(무료 모의): 확정 12장 스토리보드(프런트 Adapter가 만든 고정 입력) → 기존 Job API → Worker PLAN/승인/ASSET
// → 5번 장면만 고친 확정본 → 수정 Job ASSET(그림 1장만) → 실제 ffmpeg RENDER(1920×1080) → PACKAGE 저장·읽기 → 저장소 재생성 후 복구.
// 외부 HTTP(Gemini·TTS)만 모의, 다른 주소는 실패. 유료 호출 0. 합성 색 이미지로 순서·흑백을 확인하며, 실제 Gemini 화질은 검증 범위가 아니다.
// Run: node --import tsx --test tools/approved-storyboard-e2e.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createBlockStore } from '../lib/jobs/blockStore.js'
import { createBlockGate } from '../lib/jobs/blockRuntime.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { sha256, type JobBlobStore } from '../lib/jobs/blobs.js'
import { createLongformPlanExecutor, createLongformAssetExecutor, createLongformRenderExecutor, longformPackageExecutor } from '../worker/stages/longform.js'
import { runOnce } from '../worker/runJob.js'
import { meteredFetch } from '../lib/generative/usageLedger.js'

const PLAN = JSON.parse(await readFile(new URL('./fixtures/approved-cheese-plan.json', import.meta.url), 'utf8'))
const PLAN_R2 = JSON.parse(await readFile(new URL('./fixtures/approved-cheese-plan-r2.json', import.meta.url), 'utf8'))
const scenesOf = (p: any) => p.steps[0].config.script.sections.map((x: any) => x.scenes[0])
// the storyboard panels the browser uploaded (same bytes as the frontend fixture: 1×1 PNG + panel number)
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const panelBytes = (n: number) => Buffer.concat([PNG1, Buffer.from(`storyboard-panel-${String(n).padStart(2, '0')}`)])

function diskBlobs(dir: string): JobBlobStore {
  const file = (p: string) => join(dir, sha256(p))
  const get = async (p: string) => { try { return await readFile(file(p)) } catch (e: any) { if (e.code === 'ENOENT') return null; throw e } }
  const put = async (p: string, b: Buffer, overwrite = false) => { try { await writeFile(file(p), b, { flag: overwrite ? 'w' : 'wx' }); return true } catch (e: any) { if (e.code === 'EEXIST') return false; throw e } }
  return {
    async putJson(p, v, o) { const b = Buffer.from(JSON.stringify(v)); await put(p, b, o?.overwrite); return { path: p, sha256: sha256((await get(p))!) } },
    async getJson(p) { const b = await get(p); return b ? JSON.parse(b.toString()) : null },
    async putBytes(p, b) { await put(p, b); return { path: p, sha256: sha256(b), bytes: b.length } }, getBytes: get,
    async putFile(p, f) { const b = await readFile(f); const uploaded = await put(p, b); return { path: p, bytes: b.length, uploaded } },
    async claim(p, v) { return put(p, Buffer.from(JSON.stringify(v))) },
  }
}
// narration audio: length follows the text (so every scene is on screen long enough to sample)
function wav(seconds: number) { const rate = 24000, n = Math.round(rate * seconds), b = Buffer.alloc(44 + n * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(1500 * Math.sin(i * 0.05)), 44 + i * 2); return b }
// one saturated colour per scene (scene 8 deliberately red: the RENDER must still make it black-and-white)
const COLORS = ['0x2040ff', '0x20c040', '0xffd000', '0xff00c8', '0x00d0d0', '0xff8000', '0x8040ff', '0xff2020', '0x40ff80', '0x0080ff', '0xc0c000', '0xff4080']
const R2_COLOR = '0x804000'

test('확정 12장 → 승인 → 12장면 그림·음성 → 5번만 수정 → 수정 Job 1장만 재생성 → 1920×1080 MP4·PACKAGE → 복구', async () => {
  const db = await createTestDb(), dir = await mkdtemp(join(tmpdir(), 'approved12-'))
  const jpeg = (c: string) => { const f = join(dir, `${c}.jpg`); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=640x360:d=1`, '-frames:v', '1', '-y', f]); return f }
  const pics = new Map<string, Buffer>(); for (const c of [...COLORS, R2_COLOR]) pics.set(c, await readFile(jpeg(c)))
  const labels = scenesOf(PLAN).map((s: any) => s.action)
  let blobs = diskBlobs(dir), store = createJobStore(db), blocks = createBlockStore(db)
  // the panels are already in the workspace image store (cardnews_image_put, content-addressed): exact fixture refs
  for (const [i, sc] of scenesOf(PLAN).entries()) { assert.equal(sha256(panelBytes(i + 1)), sc.panel.sha256, `fixture panel ${i + 1}`); await blobs.putBytes(sc.panel.ref, panelBytes(i + 1), 'image/png') }
  const refs: string[][] = []
  const calls: { image: string[]; tts: number } = { image: [], tts: 0 }, original = globalThis.fetch
  globalThis.fetch = meteredFetch((async (url: any, init: any) => {
    const body = JSON.parse(init.body)
    if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
      const prompt = body.input[0].text; calls.image.push(prompt); refs.push(body.input.slice(1).map((x: any) => Buffer.from(x.data, 'base64').toString('latin1')))
      const i = labels.findIndex((l: string) => prompt.includes(`Action: ${l}.`)), color = prompt.includes('Action: 쥐덫을 놓는 거인.') ? R2_COLOR : COLORS[i]
      assert.ok(color, `unknown scene prompt: ${prompt.slice(0, 120)}`)
      return Response.json({ output_image: { data: pics.get(color)!.toString('base64'), mime_type: 'image/jpeg' }, usage: {} })
    }
    assert.equal(String(url), 'https://api.openai.com/v1/audio/speech', 'unexpected paid endpoint')
    calls.tts++; return new Response(new Uint8Array(wav(Math.max(1, [...String(body.input)].length / 25))), { headers: { 'content-type': 'audio/mpeg' } })
  }) as any, () => {})
  const call = async (b: any, method = 'POST') => { let status = 0, json: any; await createJobsHttp({ getStore: async () => store, getBlocks: async () => blocks, blobs })({ method, headers: { 'x-sync-key': 'k'.repeat(32) }, body: method === 'POST' ? b : undefined, query: method === 'GET' ? b : {} } as any, { setHeader() {}, status(n: number) { status = n; return this }, json(v: any) { json = v; return this } } as any); return { status, json } }
  const deps = (executors?: any[]) => ({ store, blobs, workerId: 'approved-12', resolveSourceAsset: async () => ({} as any), blocks: createBlockGate(blocks, async (id, stage) => store.getLatestSucceeded(id, stage)), executors: executors ?? [createLongformPlanExecutor({ apiKey: 'mock' }), createLongformAssetExecutor({ apiKey: 'mock', imageKey: 'mock' })] })
  // the request the browser Adapter sends (jobRequestFor): same profile, recipe and plan
  const create = (p: any, key: string) => call({ taskType: 'job_create', profile: 'senior_longform', idempotencyKey: key, budgetUsd: 10, input: { kind: 'text', text: `${p.title} — 치즈에 구멍을 낸 범인은 쥐가 아니었습니다.`, targetSeconds: 120, recipe: 'longform_script_approval', productionPlan: p } })
  const approve = async (id: string) => { const v = await call({ taskType: 'job_blocks', id }, 'GET'); const row = v.json.blocks.find((x: any) => x.block === 'SCRIPT_APPROVAL'); const a = await call({ taskType: 'job_block_approve', jobId: id, block: 'SCRIPT_APPROVAL', artifactHash: row.artifactHash }); assert.equal(a.status, 200, JSON.stringify(a.json)) }
  try {
    // 1) 확정 12장 그대로 저장
    // 다른 작업 공간의 칸 이미지를 가리키는 계획은 Job 생성 전에 거절
    const foreign = structuredClone(PLAN); foreign.steps[0].config.script.sections[0].scenes[0].panel.ref = foreign.steps[0].config.script.sections[0].scenes[0].panel.ref.replace(/cardnews\/[0-9a-f]{64}/, `cardnews/${'0'.repeat(64)}`)
    const bad = await create(foreign, 'approved-cheese-foreign'); assert.equal(bad.status, 400); assert.match(JSON.stringify(bad.json), /not in this workspace/)
    const a = await create(PLAN, 'approved-cheese-r1'); assert.equal(a.status, 201, JSON.stringify(a.json)); const id = a.json.job.id
    const saved: any = await blobs.getJson((await store.getJob(id))!.planRef!); assert.deepEqual(saved.productionPlan, PLAN)
    assert.equal((await create(PLAN, 'approved-cheese-r1')).json.job.id, id, 'same approved plan → same Job')
    // 2) 승인 전 유료 호출 0
    assert.equal((await runOnce(deps()) as any).outcome, 'completed')
    assert.equal((await runOnce(deps()) as any).outcome, 'waiting'); assert.equal(calls.image.length, 0); assert.equal(calls.tts, 0)
    await approve(id)
    assert.equal((await runOnce(deps()) as any).outcome, 'completed')
    // 3) 12장면 순서·내용·규칙이 Gemini 입력까지
    assert.equal(calls.image.length, 12, 'one Gemini picture per storyboard scene (12, not 48)')
    calls.image.forEach((p, i) => assert.ok(p.includes(`Action: ${labels[i]}.`), `scene ${i + 1} in order`))
    // 각 장면 = 그 장면의 승인 스토리보드 칸을 실제 이미지 입력으로(프롬프트에는 주소 없음)
    refs.forEach((r, i) => assert.deepEqual(r, [panelBytes(i + 1).toString('latin1')], `scene ${i + 1} draws from panel ${i + 1}`))
    assert.ok(calls.image.every((p) => p.includes('APPROVED STORYBOARD PANEL') && !p.includes('cardnews/')))
    assert.match(calls.image[2], /고객의 항의/); assert.match(calls.image[2], /항의합니다/)
    assert.match(calls.image[7], /COLOR: black-and-white/); assert.match(calls.image[7], /REVEAL SCENE: .*외눈/); assert.ok(!/IDENTITY HIDDEN/.test(calls.image[7]))
    for (const i of [0, 1, 2, 3, 4, 5, 6]) assert.match(calls.image[i], /IDENTITY HIDDEN \(before the reveal\): 거인의 얼굴 정면과 외눈을 보여 주지 않는다/)
    for (const i of [8, 9, 10, 11]) assert.ok(!/IDENTITY HIDDEN|REVEAL SCENE|black-and-white/.test(calls.image[i]))
    const first: any = await store.getLatestSucceeded(id, 'ASSET'), assets1: any = await blobs.getJson(first.outputRef)
    assert.deepEqual(assets1.images.map((x: any) => x.sceneId), scenesOf(PLAN).map((s: any) => s.id))
    const tts = calls.tts; assert.ok(tts > 0)
    // 4) Worker·저장소 재생성 후 재개: 같은 장면 추가 호출 0
    blobs = diskBlobs(dir); store = createJobStore(db); blocks = createBlockStore(db)
    assert.notEqual((await runOnce(deps()) as any).outcome, 'completed'); assert.equal(calls.image.length, 12)
    // 5) 5번 장면만 고친 확정본 → 새 Job, 그림 1장만, 음성 그대로
    const b = await create(PLAN_R2, 'approved-cheese-r2'); assert.equal(b.status, 201, JSON.stringify(b.json)); const id2 = b.json.job.id; assert.notEqual(id2, id)
    assert.equal((await runOnce(deps()) as any).outcome, 'completed'); assert.equal((await runOnce(deps()) as any).outcome, 'waiting'); await approve(id2)
    const [p1, p2] = await Promise.all([runOnce(deps()), runOnce({ ...deps(), workerId: 'other' })]); assert.equal([p1, p2].filter((x) => x.ran).length, 1, 'concurrent workers run the stage once')
    assert.equal(calls.image.length, 13, '12 + 1'); assert.match(calls.image[12], /쥐덫을 놓는 거인/); assert.deepEqual(refs[12], [panelBytes(5).toString('latin1')], 'the redrawn scene still draws from its panel'); assert.equal(calls.tts, tts, 'narration unchanged → no new TTS')
    const second: any = await store.getLatestSucceeded(id2, 'ASSET'), assets2: any = await blobs.getJson(second.outputRef)
    assets1.images.forEach((x: any, i: number) => { if (i === 4) assert.notEqual(assets2.images[i].ref, x.ref); else assert.equal(assets2.images[i].ref, x.ref, `scene ${i + 1} kept`) })
    assert.equal(second.usage.paidCalls, 1)
    // 6) 수정 Job을 실제 ffmpeg로 렌더 + PACKAGE
    for (let n = 0; n < 4; n++) { const r = await runOnce(deps([createLongformRenderExecutor(), longformPackageExecutor])); if (!r.ran) break }
    const render: any = await store.getLatestSucceeded(id2, 'RENDER'); assert.ok(render, JSON.stringify(await store.listStageRuns(id2)))
    const mp4 = await blobs.getBytes(render.outputRef); assert.ok(mp4 && mp4.length > 1000)
    const mp4File = join(dir, 'revised.mp4'); await writeFile(mp4File, mp4)
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', mp4File], { encoding: 'utf8' }))
    const video = probe.streams.find((x: any) => x.codec_type === 'video')
    assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.ok(probe.streams.some((x: any) => x.codec_type === 'audio')); assert.ok(Number(probe.format.duration) > 10)
    // 화면 순서·흑백: 화면 위쪽 한 점의 색을 초당 4장 읽어 장면 순서대로 나오는지, 8번 구간이 무채색인지 확인
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4File, '-vf', 'crop=8:8:956:180,scale=1:1,fps=4', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    const px: number[][] = []; for (let i = 0; i + 2 < raw.length; i += 3) px.push([raw[i], raw[i + 1], raw[i + 2]])
    const dist = (p: number[], hex: string) => { const v = parseInt(hex.slice(2), 16), c = [(v >> 16) & 255, (v >> 8) & 255, v & 255]; return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) }
    const gray = (p: number[]) => Math.max(...p) - Math.min(...p) < 18
    const expected = COLORS.map((c, i) => (i === 4 ? R2_COLOR : c)), candidates = expected.filter((_, i) => i !== 7), seq: string[] = []
    // the nearest scene colour (JPEG/YUV shifts colours a little); a frame far from every colour is a transition and skipped
    for (const p of px) { const best = candidates.reduce((a, c) => (dist(p, c) < dist(p, a) ? c : a)), k = gray(p) ? 'GRAY' : dist(p, best) < 80 ? best : null; if (k && seq[seq.length - 1] !== k) seq.push(k) }
    assert.deepEqual(seq, expected.map((c, i) => (i === 7 ? 'GRAY' : c)), 'all 12 scenes, in order; scene 5 is the revised picture; scene 8 black-and-white')
    // 7) PACKAGE 저장·읽기, 저장소 재생성 후 복구
    const pkgRun: any = await store.getLatestSucceeded(id2, 'PACKAGE'); assert.ok(pkgRun, JSON.stringify(await store.listStageRuns(id2)))
    const fresh = diskBlobs(dir), pkg: any = await fresh.getJson(pkgRun.outputRef)
    assert.equal(pkg.finalRenderRef, render.outputRef); assert.equal(pkg.aspectRatio, '16:9'); assert.ok(pkg.metadata?.title)
    assert.equal(sha256((await fresh.getBytes(pkg.finalRenderRef))!), sha256(mp4))
    const done = await call({ taskType: 'job_get', id: id2 }, 'GET'); assert.equal(done.json.job.status, 'COMPLETE', JSON.stringify(done.json.job))
    const pack = await call({ taskType: 'job_package', id: id2 }, 'GET'); assert.equal(pack.status, 200); assert.equal(pack.json.package.finalRenderRef, render.outputRef)
  } finally { globalThis.fetch = original; await db.close!() }
})

test('장면 규칙·스토리보드 칸 참조 검증: 알 수 없는 키·잘못된 값·주소/해시 불일치는 Job 생성 전에 거절', async () => {
  const { sceneRuleErrors, sceneRuleLines, sceneSegmentArgv, scenePanelErrors } = await import('../lib/generative/seniorLongform.js')
  const sha = 'a'.repeat(64), ws = 'b'.repeat(64)
  assert.deepEqual(scenePanelErrors({ ref: `cardnews/${ws}/images/${sha}.png`, sha256: sha }), [])
  assert.deepEqual(scenePanelErrors({ ref: `https://x/${sha}.png`, sha256: sha }), ['panel.ref'])
  assert.deepEqual(scenePanelErrors({ ref: `cardnews/${ws}/images/${sha}.png`, sha256: 'c'.repeat(64) }), ['panel.sha256'], 'the hash must be the stored file\'s own hash')
  assert.deepEqual(sceneRuleErrors(undefined), [])
  assert.deepEqual(sceneRuleErrors({ monochrome: true, reveal: '외눈을 보여 준다' }), [])
  assert.deepEqual(sceneRuleErrors({ color: 'sepia' }), ['rules.color.unknown'])
  assert.deepEqual(sceneRuleErrors({ monochrome: 'yes' }), ['rules.monochrome'])
  assert.deepEqual(sceneRuleErrors({ hideIdentity: 'a', reveal: 'b' }), ['rules.hide_and_reveal'])
  assert.deepEqual(sceneRuleLines(undefined), [])
  const argv = sceneSegmentArgv({ images: ['a.jpg', 'b.jpg'], runs: [{ image: 0, frames: 30, index: 0 }, { image: 1, frames: 30, index: 1, mono: true }], ass: 'x.ass', fontsDir: 'f', out: 'o.mp4', threads: 1 })
  const graph = argv[argv.indexOf('-filter_complex') + 1]
  assert.equal(graph.split('hue=s=0').length - 1, 1, 'only the monochrome scene is desaturated'); assert.ok(graph.indexOf('hue=s=0') > graph.indexOf('[1:v]'))
})
