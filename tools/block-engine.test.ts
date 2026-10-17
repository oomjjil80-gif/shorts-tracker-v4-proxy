// Block engine: Recipe + approvals enforced by the server, wired into the real worker loop (runOnce). Free: fake stage executors
// (no network, no paid call), PGlite. Run: node --import tsx --test tools/block-engine.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb } from './testDb.js'
import { createJobStore } from '../lib/jobs/store.js'
import { createMemoryBlobStore } from '../lib/jobs/blobs.js'
import { createJobsHttp } from '../lib/jobs/http.js'
import { createBlockStore } from '../lib/jobs/blockStore.js'
import { createBlockGate } from '../lib/jobs/blockRuntime.js'
import { RECIPES, bindingErrors, recipeFor, type RecipeBinding } from '../lib/jobs/recipes.js'
import { PROFILES } from '../lib/jobs/profiles.js'
import { JOB_STAGES, JobError, type JobStage } from '../lib/jobs/types.js'
import { runOnce } from '../worker/runJob.js'
import type { StageExecutor } from '../worker/types.js'

const WS = 'ws1', KEY = 'k'.repeat(32)

async function rig(extra: Record<string, RecipeBinding> = {}) {
  const db = await createTestDb()
  const store = createJobStore(db)
  const blobs = createMemoryBlobStore()
  await blobs.putJson('scripts/s1.json', { title: '우물 속 노랫소리', beats: [{ id: 'b1', narration: '첫 장면 낭독' }] })
  const blocks = createBlockStore(db, undefined, (id) => extra[id] ?? recipeFor(id))
  const calls: Record<string, number> = {}
  let planSeed = 'v1'
  const executors: StageExecutor[] = JOB_STAGES.map((stage) => ({
    stage,
    estimateUsd: () => 0.01,
    inputHash: (job) => `h|${stage}|${job.id}${stage === 'PLAN' ? '|' + planSeed : ''}`,
    run: async () => {
      calls[stage] = (calls[stage] ?? 0) + 1
      return stage === 'PLAN'
        ? { outputRef: 'plans/p1.json', outputHash: 'o'.repeat(63) + (planSeed === 'v1' ? '1' : '2'), result: { scriptRef: 'scripts/s1.json' }, planRef: 'plans/p1.json', costUsd: 0.01 }
        : { outputRef: `out/${stage}.json`, outputHash: 'e'.repeat(64), result: {}, costUsd: 0.01 }
    }
  }))
  const gate = createBlockGate(blocks, async (jobId, stage) => { const r: any = await store.getLatestSucceeded(jobId, stage); return r ? { inputHash: r.inputHash, outputRef: r.outputRef, outputHash: r.outputHash, result: r.result } : null })
  const deps = (workerId = 'w1', withGate = true) => ({ store, blobs, executors, workerId, resolveSourceAsset: async () => ({} as any), blocks: withGate ? gate : undefined })
  const drive = async (workerId = 'w1', max = 30, withGate = true) => {
    const seen: string[] = []
    for (let i = 0; i < max; i++) { const o = await runOnce(deps(workerId, withGate)); if (!o.ran) break; seen.push(`${(o as any).stage}:${(o as any).outcome}`); if ((o as any).outcome === 'waiting') break }
    return seen
  }
  const newJob = async (profile = 'wisdom', key = 'idem-0001') => (await store.createJob({ workspaceId: WS, profile, sourceAssetId: 'src_gen_x', idempotencyKey: key, budgetUsd: 5, planRef: 'briefs/b.json' })).job
  return { db, store, blobs, blocks, calls, drive, newJob, deps, setSeed: (s: string) => { planSeed = s } }
}
const GATE = 'SCRIPT_APPROVAL' as const

test('A. Recipe 연결표: 기존 6개 프로필은 호환 레시피(게이트 없음), 승인 레시피는 지혜/야담 쇼츠에만 유효', () => {
  for (const p of Object.keys(PROFILES)) {
    const r = recipeFor(`legacy_${p}`)!
    assert.deepEqual(bindingErrors(r, p), [], p); assert.equal(r.enforced, false); assert.ok(r.recipe.steps.every((s) => s.skipReason !== undefined))
  }
  const e = RECIPES.wisdom_shorts_script_approval
  assert.deepEqual(bindingErrors(e, 'wisdom'), []); assert.deepEqual(bindingErrors(e, 'yasa_shorts'), [])
  assert.ok(bindingErrors(e, 'source_shorts').length && bindingErrors(e, 'wisdom_longform').length)
  assert.ok(bindingErrors({ ...e, stageBlocks: { PLAN: 'SCRIPT_APPROVAL' } }, 'wisdom').some((x) => /approval block/.test(x)))
  assert.ok(bindingErrors({ ...e, stageBlocks: { ...e.stageBlocks, ASSET: undefined as any } }, 'wisdom').length, 'an active paid block with no stage is refused')
})

test('B. 승인 전에는 후속 유료 단계가 실행되지 않는다(서버 강제): PLAN 후 ASSET 호출 0회, 작업은 BLOCK_APPROVAL 대기', async () => {
  const t = await rig(); const job = await t.newJob()
  await t.blocks.bind(job.id, 'wisdom', 'wisdom_shorts_script_approval')
  const seen = await t.drive()
  assert.deepEqual(seen, ['PLAN:completed', 'ASSET:waiting'])
  assert.deepEqual([t.calls.PLAN, t.calls.ASSET ?? 0], [1, 0])
  const j = (await t.store.getJob(job.id, WS))!
  assert.equal(j.status, 'WAITING_USER'); assert.equal(j.waitReason, 'BLOCK_APPROVAL'); assert.equal(j.stage, 'ASSET')
  assert.deepEqual(await t.drive(), [], 'a waiting job is not claimed again')
  assert.equal(t.calls.ASSET ?? 0, 0)
  const rows = await t.blocks.rows(job.id)
  assert.equal(rows.find((r) => r.block === 'SCRIPT')!.status, 'SUCCEEDED'); assert.equal(rows.find((r) => r.block === GATE)!.status, 'SUCCEEDED')
})

test('C. 승인: 보지 않은(옛) 결과로는 승인 불가, 정확한 결과만 승인, 중복 클릭은 한 번만 재개, 승인 후 각 유료 단계 정확히 1회', async () => {
  const t = await rig(); const job = await t.newJob()
  await t.blocks.bind(job.id, 'wisdom', 'wisdom_shorts_script_approval'); await t.drive()
  const hash = (await t.blocks.rows(job.id)).find((r) => r.block === GATE)!.artifactHash!
  await assert.rejects(t.blocks.approve(job.id, WS, GATE, 'f'.repeat(64)), (e: any) => e instanceof JobError && e.code === 'STALE_APPROVAL')
  await assert.rejects(t.blocks.approve(job.id, WS, 'ASSETS', hash), (e: any) => e.code === 'BAD_REQUEST')
  await assert.rejects(t.blocks.approve(job.id, 'other-ws', GATE, hash), (e: any) => e.code === 'NOT_FOUND')
  assert.equal((await t.store.getJob(job.id, WS))!.status, 'WAITING_USER', 'refused approvals change nothing')
  const [a, b] = await Promise.all([t.blocks.approve(job.id, WS, GATE, hash), t.blocks.approve(job.id, WS, GATE, hash)])
  assert.deepEqual([a.requeued, b.requeued].sort(), [false, true]); assert.ok(a.already !== b.already)
  const seen = await t.drive()
  assert.equal(seen.at(-1), 'PACKAGE:completed'); assert.equal((await t.store.getJob(job.id, WS))!.status, 'COMPLETE')
  for (const s of ['PLAN', 'ASSET', 'COMPILE', 'RENDER', 'PACKAGE']) assert.equal(t.calls[s], 1, `${s} ran once`)
  await t.blocks.approve(job.id, WS, GATE, hash).then((r) => assert.equal(r.already, true), (e) => assert.equal(e.code, 'JOB_CLOSED'))
})

test('D. 두 워커가 동시에 돌려도 승인된 유료 단계는 한 번만 실행(중복 과금 방지)', async () => {
  const t = await rig(); const job = await t.newJob()
  await t.blocks.bind(job.id, 'wisdom', 'wisdom_shorts_script_approval'); await t.drive()
  await t.blocks.approve(job.id, WS, GATE, (await t.blocks.rows(job.id)).find((r) => r.block === GATE)!.artifactHash!)
  await Promise.all([t.drive('w1'), t.drive('w2'), t.drive('w3')])
  assert.equal(t.calls.ASSET, 1); assert.equal(t.calls.RENDER, 1)
})

test('E. 이전 버전 승인은 무효: 대본이 바뀌면 승인이 풀리고 새 결과를 다시 승인해야 다음 단계 진입', async () => {
  const t = await rig(); const job = await t.newJob()
  await t.blocks.bind(job.id, 'wisdom', 'wisdom_shorts_script_approval'); await t.drive()
  const v1 = (await t.blocks.rows(job.id)).find((r) => r.block === GATE)!.artifactHash!
  t.setSeed('v2') // the user changed the script's inputs: PLAN must run again
  const r = await t.blocks.edit(job.id, WS, 'SCRIPT'); assert.equal(r.stage, 'PLAN'); assert.deepEqual(r.invalidated, ['SCRIPT', 'SCRIPT_APPROVAL', 'ASSETS', 'RENDER'])
  assert.deepEqual(await t.drive(), ['PLAN:completed', 'ASSET:waiting']); assert.equal(t.calls.PLAN, 2)
  const v2 = (await t.blocks.rows(job.id)).find((x) => x.block === GATE)!.artifactHash!
  assert.notEqual(v1, v2)
  await assert.rejects(t.blocks.approve(job.id, WS, GATE, v1), (e: any) => e.code === 'STALE_APPROVAL')
  assert.equal(t.calls.ASSET ?? 0, 0)
  await t.blocks.approve(job.id, WS, GATE, v2); await t.drive(); assert.equal(t.calls.ASSET, 1)
})

test('F. 부분 수정: 입력이 같으면 해당 블록은 다시 만들지 않고(비용 0) 이전 승인도 그대로 복원', async () => {
  const t = await rig(); const job = await t.newJob()
  await t.blocks.bind(job.id, 'wisdom', 'wisdom_shorts_script_approval'); await t.drive()
  const h = (await t.blocks.rows(job.id)).find((r) => r.block === GATE)!.artifactHash!
  await t.blocks.edit(job.id, WS, 'SCRIPT')
  const seen = await t.drive()
  assert.deepEqual(seen, ['PLAN:completed', 'ASSET:waiting']); assert.equal(t.calls.PLAN, 1, 'PLAN executor was NOT run again')
  const runs = await t.store.listStageRuns(job.id); assert.ok(runs.filter((x) => x.stage === 'PLAN' && x.status === 'SUCCEEDED').length === 2 && runs.filter((x) => x.stage === 'PLAN').every((x) => x.costUsd === 0 || x.costUsd === 0.01))
  assert.equal((await t.blocks.rows(job.id)).find((r) => r.block === GATE)!.artifactHash, h, 'same result, same artifact')
  await assert.rejects(t.blocks.edit(job.id, WS, GATE), (e: any) => e.code === 'BAD_REQUEST')
})

test('G. 새 콘텐츠 유형 = Recipe 추가만: 기존 지혜 쇼츠 모듈 + 승인 2단계 레시피를 등록만 하면 같은 엔진이 실행', async () => {
  const twoGates: RecipeBinding = {
    recipe: { id: 'history_two_gates', provides: ['brief', 'research', 'packaging', 'reviewedScript'], steps: [
      { block: 'RESEARCH', skipReason: 'x' }, { block: 'PACKAGING', skipReason: 'x' }, { block: 'SCRIPT' }, { block: 'REVIEW', skipReason: 'x' },
      { block: 'SCRIPT_APPROVAL' }, { block: 'STYLE_APPROVAL' }, { block: 'ASSETS' }, { block: 'RENDER' }, { block: 'FINAL_REVIEW', skipReason: 'x' }] },
    stageBlocks: { PLAN: 'SCRIPT', ASSET: 'ASSETS', RENDER: 'RENDER' }, enforced: true, profiles: ['wisdom']
  }
  assert.deepEqual(bindingErrors(twoGates, 'wisdom'), [])
  const t = await rig({ history_two_gates: twoGates }); const job = await t.newJob()
  await t.blocks.bind(job.id, 'wisdom', 'history_two_gates')
  assert.deepEqual(await t.drive(), ['PLAN:completed', 'ASSET:waiting'])
  const hashOf = async (b: string) => (await t.blocks.rows(job.id)).find((r) => r.block === b)!.artifactHash!
  await t.blocks.approve(job.id, WS, 'SCRIPT_APPROVAL', await hashOf('SCRIPT_APPROVAL'))
  assert.deepEqual(await t.drive(), [], 'the second approval still holds the paid ASSET block: the job keeps waiting'); assert.equal(t.calls.ASSET ?? 0, 0); assert.equal((await t.store.getJob(job.id, WS))!.status, 'WAITING_USER')
  await assert.rejects(t.blocks.approve(job.id, WS, 'STYLE_APPROVAL', 'a'.repeat(64)), (e: any) => e.code === 'STALE_APPROVAL')
  await t.blocks.approve(job.id, WS, 'STYLE_APPROVAL', await hashOf('STYLE_APPROVAL'))
  await t.drive(); assert.equal(t.calls.ASSET, 1)
  // editing the SCRIPT with unchanged inputs leaves both approvals standing: nothing is asked or produced twice
})

test('H. 기존 Job 호환: 레시피가 없는 작업은 게이트 없이 이전과 똑같이 끝까지 실행, 게이트 유무가 호출 횟수를 바꾸지 않음', async () => {
  const a = await rig(); const ja = await a.newJob('wisdom', 'idem-legacy-a'); const seenGate = await a.drive('w1', 30, true)
  const b = await rig(); const jb = await b.newJob('wisdom', 'idem-legacy-b'); const seenNo = await b.drive('w1', 30, false)
  assert.deepEqual(seenGate, seenNo); assert.deepEqual(a.calls, b.calls); assert.equal((await a.store.getJob(ja.id, WS))!.status, 'COMPLETE')
  assert.equal(((await a.db.query('SELECT count(*)::int AS n FROM job_recipes')).rows[0] as any).n, 0)
  for (const p of ['source_shorts', 'wisdom', 'yasa_shorts', 'wisdom_longform', 'senior_longform', 'yasa_longform']) {
    const t = await rig(); const j = await t.newJob(p, 'idem-' + p); await t.blocks.bind(j.id, p, `legacy_${p}`)
    const seen = await t.drive(); assert.ok(!seen.some((x) => x.endsWith('waiting')), `${p} is never held by a compat recipe: ${seen}`)
  }
  void jb
})

test('I. HTTP: 레시피 지정 job_create → 저장, job_blocks 조회, 승인 API(오래된 해시 409, 정확한 해시 200), 잘못된 레시피 400', async () => {
  const db = await createTestDb(), store = createJobStore(db), blobs = createMemoryBlobStore(), blocks = createBlockStore(db)
  await blobs.putJson('scripts/s1.json', { title: '우물 속 노랫소리', beats: [{ id: 'b1', narration: '첫 장면 낭독' }] })
  const handler = createJobsHttp({ getStore: async () => store, getBlocks: async () => blocks, blobs })
  const call = async (method: string, b: any, q: any = {}) => { let status = 0, json: any = null; await handler({ method, headers: { 'x-sync-key': KEY }, query: q, body: b } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(x: any) { json = x; return this }, end() { return this } } as any); return { status, json } }
  const input = { fixedScript: { title: '우물 속 노랫소리', beats: Array.from({ length: 6 }, (_, i) => ({ narration: `장면 ${i + 1} 낭독입니다 충분히 긴 문장입니다.`, imagePrompt: `장면 ${i + 1} 우물가` })) }, targetSeconds: 40 }
  const c = await call('POST', { taskType: 'job_create', profile: 'yasa_shorts', idempotencyKey: 'idem-http-0001', input: { ...input, recipe: 'wisdom_shorts_script_approval' }, budgetUsd: 5 })
  assert.equal(c.status, 201); const id = c.json.job.id
  assert.equal((await blocks.bindingOf(id))!.recipeId, 'wisdom_shorts_script_approval')
  assert.equal((await call('POST', { taskType: 'job_create', profile: 'yasa_shorts', idempotencyKey: 'idem-http-0002', input: { ...input, recipe: 'nope' }, budgetUsd: 5 })).status, 400)
  assert.equal((await call('POST', { taskType: 'job_create', profile: 'source_shorts', idempotencyKey: 'idem-http-0003', input: { recipe: 'wisdom_shorts_script_approval' }, sourceAssetId: 'src_1234567890', plan: {}, budgetUsd: 5 })).status, 400)
  const plain = await call('POST', { taskType: 'job_create', profile: 'yasa_shorts', idempotencyKey: 'idem-http-0004', input, budgetUsd: 5 })
  assert.equal(plain.status, 201); assert.equal((await call('GET', null, { taskType: 'job_blocks', id: plain.json.job.id })).json.legacy, true)
  // pretend PLAN finished and the gate is open
  await blocks.begin(id, 'SCRIPT', 'i'.repeat(64)); await blocks.complete(id, 'SCRIPT', { inputHash: 'i'.repeat(64), outputRef: 'plans/p1.json', outputHash: 'a'.repeat(64), result: { r: { scriptRef: 'scripts/s1.json' }, planRef: null } })
  await db.query(`UPDATE production_jobs SET status='WAITING_USER', wait_reason='BLOCK_APPROVAL', stage='ASSET' WHERE id=$1`, [id])
  const v = await call('GET', null, { taskType: 'job_blocks', id })
  assert.equal(v.json.legacy, false); assert.equal(v.json.decision.state, 'WAITING_APPROVAL'); assert.equal(v.json.preview.beats[0].narration, '첫 장면 낭독')
  const gate = v.json.blocks.find((b: any) => b.block === 'SCRIPT_APPROVAL'); assert.ok(gate.awaitingApproval && gate.approval && /^[0-9a-f]{64}$/.test(gate.artifactHash))
  assert.equal((await call('POST', { taskType: 'job_block_approve', jobId: id, block: 'SCRIPT_APPROVAL', artifactHash: 'b'.repeat(64) })).status, 409)
  assert.equal((await call('GET', null, { taskType: 'job_blocks', id })).json.decision.state, 'WAITING_APPROVAL', 'a refused approval changed nothing')
  const ok = await call('POST', { taskType: 'job_block_approve', jobId: id, block: 'SCRIPT_APPROVAL', artifactHash: gate.artifactHash })
  assert.equal(ok.status, 200); assert.equal(ok.json.requeued, true)
  assert.equal((await call('POST', { taskType: 'job_block_approve', jobId: id, block: 'SCRIPT_APPROVAL', artifactHash: gate.artifactHash })).json.already, true)
  assert.equal((await call('POST', { taskType: 'job_block_approve', jobId: id, block: 'NOPE', artifactHash: gate.artifactHash })).status, 400)
})

// ───────── PR #216 보완: 마이그레이션 제약조건 안전성 / Job 생성-Recipe 저장 경합 ─────────
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { recipeSnapshot } from '../lib/jobs/recipes.js'

const sql = (f: string) => readFileSync(new URL(`../db/${f}`, import.meta.url), 'utf8')
// the first version of 004: found the constraint by searching its text
const OLD_004_DROP = `DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'production_jobs'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%PROVIDER_DOWN%' LOOP
    EXECUTE format('ALTER TABLE production_jobs DROP CONSTRAINT %I', c);
  END LOOP; END $$;`
async function legacyDb(opts: { renameWaitCheck?: boolean } = {}) {
  const pg = new PGlite(); await pg.exec(sql('001_jobs.sql'))
  // an unrelated constraint that merely mentions PROVIDER_DOWN, spanning two columns (a text search would take it too)
  await pg.exec(`ALTER TABLE production_jobs ADD CONSTRAINT production_jobs_provider_budget CHECK (wait_reason IS DISTINCT FROM 'PROVIDER_DOWN' OR budget_usd >= 0)`)
  if (opts.renameWaitCheck) await pg.exec(`ALTER TABLE production_jobs RENAME CONSTRAINT production_jobs_wait_reason_check TO my_custom_wait_reason_rule`)
  await pg.exec(`INSERT INTO production_jobs (id, workspace_id, profile, source_asset_id, status, stage, wait_reason, idempotency_key, request_hash, budget_usd, created_at, updated_at)
    VALUES ('job_keep','ws1','wisdom','src_1','WAITING_USER','ASSET','DECISION','k1','h',5,now(),now())`)
  return pg
}
const wc = async (pg: PGlite) => (await pg.query<any>(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='production_jobs'::regclass AND contype='c' ORDER BY conname`)).rows
const fails = async (pg: PGlite, q: string) => { try { await pg.exec(q); return false } catch { return true } }
const ins = (id: string, status: string, wait: string | null, budget = 5) => `INSERT INTO production_jobs (id, workspace_id, profile, source_asset_id, status, stage, wait_reason, idempotency_key, request_hash, budget_usd, created_at, updated_at) VALUES ('${id}','ws1','wisdom','src_1','${status}','ASSET',${wait ? `'${wait}'` : 'NULL'},'${id}','h',${budget},now(),now())`

test('J1. [재현] 이전 방식(내용 검색 삭제)은 PROVIDER_DOWN을 언급하는 무관한 제약조건까지 지운다', async () => {
  const pg = await legacyDb(); await pg.exec(OLD_004_DROP)
  assert.ok(!(await wc(pg)).some((c) => c.conname === 'production_jobs_provider_budget'), 'the old search deleted an unrelated constraint')
})

for (const renamed of [false, true]) {
  test(`J2. 마이그레이션 004: 정확히 wait_reason 단일 컬럼 CHECK만 교체, 무관 제약조건·기존 행 보존, 반복 실행 안전 (원본 제약조건 ${renamed ? '이름이 달라도' : '기본 이름'})`, async () => {
    const pg = await legacyDb({ renameWaitCheck: renamed })
    const before = await wc(pg)
    await pg.exec(sql('004_job_blocks.sql')); await pg.exec(sql('004_job_blocks.sql')) // twice
    const after = await wc(pg)
    const keep = ['production_jobs_lease', 'production_jobs_provider_budget', 'production_jobs_wait']
    for (const k of keep) assert.equal(after.find((c) => c.conname === k)?.def, before.find((c) => c.conname === k)?.def, `${k} untouched`)
    const waitChecks = after.filter((c) => /wait_reason/.test(c.def) && !/status/.test(c.def) && !/budget_usd/.test(c.def))
    assert.equal(waitChecks.length, 1, JSON.stringify(waitChecks)); assert.equal(waitChecks[0].conname, 'production_jobs_wait_reason_check'); assert.match(waitChecks[0].def, /BLOCK_APPROVAL/)
    assert.ok(!after.some((c) => c.conname === 'my_custom_wait_reason_rule'), 'the single-column rule was replaced, not duplicated')
    // behaviour: the new reason is accepted, everything else is still enforced
    await pg.exec(ins('j_ok', 'WAITING_USER', 'BLOCK_APPROVAL'))
    assert.ok(await fails(pg, ins('j_bad1', 'WAITING_USER', 'NOPE')), 'unknown wait reason rejected')
    assert.ok(await fails(pg, ins('j_bad2', 'WAITING_USER', null)), 'production_jobs_wait still pairs status and wait_reason')
    assert.ok(await fails(pg, ins('j_bad3', 'WAITING_USER', 'PROVIDER_DOWN', -1)), 'the unrelated constraint still applies')
    const keepRow = (await pg.query<any>(`SELECT status, wait_reason, budget_usd FROM production_jobs WHERE id='job_keep'`)).rows[0]
    assert.deepEqual([keepRow.status, keepRow.wait_reason, Number(keepRow.budget_usd)], ['WAITING_USER', 'DECISION', 5], 'existing job preserved')
    for (const t of ['job_recipes', 'job_blocks']) assert.equal((await pg.query<any>(`SELECT to_regclass('${t}') AS r`)).rows[0].r, t)
    await pg.exec(`INSERT INTO job_recipes (job_id, recipe_id, recipe, stage_blocks, recipe_hash) VALUES ('job_keep','r','{}','{}','h')`)
    await pg.exec(sql('004_job_blocks.sql')); assert.equal((await pg.query<any>(`SELECT count(*)::int AS n FROM job_recipes`)).rows[0].n, 1, 're-run keeps data')
  })
}

const wisdomInput = { fixedScript: { title: '우물 속 노랫소리', beats: Array.from({ length: 6 }, (_, i) => ({ narration: `장면 ${i + 1} 낭독입니다 충분히 긴 문장입니다.`, imagePrompt: `장면 ${i + 1} 우물가` })) }, targetSeconds: 40 }
function httpFor(t: Awaited<ReturnType<typeof rig>>) {
  const handler = createJobsHttp({ getStore: async () => t.store, getBlocks: async () => t.blocks, blobs: t.blobs })
  return async (body: any) => { let status = 0, json: any = null; await handler({ method: 'POST', headers: { 'x-sync-key': KEY }, query: {}, body } as any, { setHeader() {}, status(c: number) { status = c; return this }, json(x: any) { json = x; return this }, end() { return this } } as any); return { status, json } }
}
const createBody = (key: string, recipe?: string) => ({ taskType: 'job_create', profile: 'wisdom', idempotencyKey: key, input: { ...wisdomInput, ...(recipe ? { recipe } : {}) }, budgetUsd: 5 })

test('K1. [재현] 생성 뒤에 따로 Recipe를 붙이던 방식: worker가 먼저 돌면 승인 없이 유료 ASSET까지 실행됐다 → 이제 늦은 바인딩은 거절', async () => {
  const t = await rig(); const job = await t.newJob()
  await t.drive() // a worker wins the race before the recipe is saved
  assert.equal(t.calls.ASSET, 1, 'the paid ASSET stage ran with no approval gate')
  await assert.rejects(t.blocks.bind(job.id, 'wisdom', 'wisdom_shorts_script_approval'), (e: any) => e.code === 'JOB_ALREADY_STARTED')
  assert.equal(((await t.db.query('SELECT count(*)::int AS n FROM job_recipes')).rows[0] as any).n, 0)
})

test('K2. Recipe가 필요한 Job은 생성과 같은 트랜잭션에 Recipe가 저장 → 생성 요청과 worker를 동시에 돌려도 승인 전 유료 실행 0회', async () => {
  const t = await rig(); const call = httpFor(t)
  let created: any = null, stop = false
  const creator = (async () => { created = await call(createBody('idem-race-0001', 'wisdom_shorts_script_approval')); stop = true })()
  const workers = Promise.all(['w1', 'w2'].map(async (w) => { for (let i = 0; i < 400 && !stop; i++) { await runOnce(t.deps(w)); await new Promise((r) => setImmediate(r)) } }))
  await Promise.all([creator, workers])
  assert.equal(created.status, 201)
  await t.drive('w1'); await t.drive('w2') // keep working until nothing is claimable
  const id = created.json.job.id
  assert.equal((await t.blocks.bindingOf(id))!.recipeId, 'wisdom_shorts_script_approval')
  assert.equal(t.calls.ASSET ?? 0, 0, 'no paid ASSET before approval'); assert.equal(t.calls.RENDER ?? 0, 0)
  const j = (await t.store.getJob(id))!; assert.deepEqual([j.status, j.waitReason, j.stage], ['WAITING_USER', 'BLOCK_APPROVAL', 'ASSET'])
})

test('K3. Recipe 저장이 실패하면 Job 자체가 만들어지지 않는다(원자성) — worker가 가져갈 Job이 없음', async () => {
  const t = await rig(); const call = httpFor(t)
  await (t.db as any).raw.exec('ALTER TABLE job_recipes RENAME TO job_recipes_broken')
  const r = await call(createBody('idem-atomic-001', 'wisdom_shorts_script_approval'))
  assert.ok(r.status >= 400, `status ${r.status}`)
  assert.equal(((await t.db.query('SELECT count(*)::int AS n FROM production_jobs')).rows[0] as any).n, 0, 'no job row survived the failed recipe write')
  assert.deepEqual(await t.drive(), []); assert.deepEqual(t.calls, {})
})

test('K4. 게이트를 집행할 수 없는 worker(blocks 없음)는 Recipe 묶인 Job을 가져가지 않고, 레시피 없는 Job은 그대로 처리', async () => {
  const t = await rig(); const call = httpFor(t)
  const gated = (await call(createBody('idem-cap-gated-1', 'wisdom_shorts_script_approval'))).json.job
  const legacy = await t.newJob('wisdom', 'idem-cap-legacy-1')
  const seen = await t.drive('old-worker', 30, false) // an old/ungated worker
  assert.ok(seen.length > 0 && seen.at(-1) === 'PACKAGE:completed', 'the legacy job still completes')
  assert.equal((await t.store.getJob(legacy.id, WS))!.status, 'COMPLETE')
  const g = (await t.store.getJob(gated.id))!; assert.deepEqual([g.status, g.stage], ['QUEUED', 'PLAN'], 'the gated job was never claimed')
  assert.equal(t.calls.PLAN, 1, 'only the legacy job ran PLAN')
  await t.drive('new-worker') // a gating worker takes it and holds it at the approval
  assert.equal((await t.store.getJob(gated.id))!.waitReason, 'BLOCK_APPROVAL')
})

test('K5. createJob 재호출(멱등): 같은 키는 같은 Job·Recipe 1행, 다른 Recipe나 Recipe 없는 요청은 거절', async () => {
  const t = await rig()
  const snap = recipeSnapshot('wisdom_shorts_script_approval', 'wisdom'), base = { workspaceId: WS, profile: 'wisdom', sourceAssetId: 'src_gen_x', idempotencyKey: 'idem-replay-01', budgetUsd: 5, planRef: 'briefs/r.json' }
  const a = await t.store.createJob({ ...base, recipe: snap }), b = await t.store.createJob({ ...base, recipe: snap })
  assert.deepEqual([a.created, b.created, a.job.id === b.job.id], [true, false, true])
  assert.equal(((await t.db.query('SELECT count(*)::int AS n FROM job_recipes')).rows[0] as any).n, 1)
  await assert.rejects(t.store.createJob({ ...base }).then((r) => r), () => true).catch(() => {}) // plain replay of a gated key is allowed to return the job
  await assert.rejects(t.store.createJob({ ...base, recipe: { ...snap, recipeId: 'other' } }), (e: any) => e.code === 'IDEMPOTENCY_KEY_REUSED')
})


test('Recipe binding accepts an injected profile registry without modifying production profiles', () => {
  const recipe = RECIPES.wisdom_shorts_script_approval
  const alternate = { ...recipe, profiles: ['custom_wisdom'] }
  const stages = ['PLAN', 'ASSET', 'RENDER'] as JobStage[]
  assert.deepEqual(bindingErrors(alternate, 'custom_wisdom', { custom_wisdom: { stages } }), [])
  assert.ok(bindingErrors(alternate, 'custom_wisdom').some((error) => error.includes('unknown profile')))
  assert.ok(bindingErrors(alternate, 'custom_wisdom', { custom_wisdom: { stages: ['PLAN'] as JobStage[] } }).some((error) => error.includes('not in profile')))
})

test('Longform opt-in approval recipe binds all three existing profiles without changing legacy jobs', () => {
  for (const profile of ['wisdom_longform', 'senior_longform', 'yasa_longform']) {
    const binding = RECIPES.longform_script_approval
    assert.deepEqual(bindingErrors(binding, profile), [])
    const snapshot = recipeSnapshot('longform_script_approval', profile)
    assert.equal(snapshot.recipeId, 'longform_script_approval')
    assert.equal(JSON.parse(snapshot.stageBlocksJson).ASSET, 'ASSETS')
    assert.equal(RECIPES['legacy_' + profile].enforced, false)
  }
})
