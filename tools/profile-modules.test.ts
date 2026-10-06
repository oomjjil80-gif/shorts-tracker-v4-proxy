// PR1 content-pipeline modularization: one Profile table + static module registry, behaviour identical to main.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PROFILES, getProfile, isProfileId } from '../lib/jobs/profiles.js'
import { PIPELINES, pipelineFor, firstStage, nextStage } from '../lib/jobs/pipeline.js'
import { createModuleRegistry, stageExecutorsFor, profileErrors, type ExistingExecutors } from '../worker/modules/registry.js'
import { withLongform } from '../worker/stages/longform.js'
import type { StageExecutor } from '../worker/types.js'

// main @ 1b654e9 lib/jobs/pipeline.ts, verbatim
const MAIN_PIPELINES = {
  source_shorts: ['ANALYZE', 'PLAN', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE'],
  wisdom: ['PLAN', 'ASSET', 'ANALYZE', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE'],
  wisdom_longform: ['PLAN', 'ASSET', 'RENDER', 'PACKAGE']
}

// spy executors standing in for the real ones: each reports its own name from run/inputHash/estimateUsd
const spy = (name: string, stage: any, usd: number): StageExecutor => ({ stage, estimateUsd: () => usd, inputHash: () => `hash:${name}`, run: async () => ({ result: name }) })
const X: ExistingExecutors = {
  analyze: spy('analyze', 'ANALYZE', 0), sourcePlan: spy('sourcePlan', 'PLAN', 0.05), wisdomPlan: spy('wisdomPlan', 'PLAN', 0.2), wisdomAsset: spy('wisdomAsset', 'ASSET', 0.75),
  compile: spy('compile', 'COMPILE', 0), render: spy('render', 'RENDER', 0), autoQc: spy('autoQc', 'AUTO_QC', 0), decision: spy('decision', 'DECISION', 0), final: spy('final', 'FINAL', 0),
  shortsPackage: spy('shortsPackage', 'PACKAGE', 0.07), longformPlan: spy('longformPlan', 'PLAN', 0.3), longformAsset: spy('longformAsset', 'ASSET', 1.0),
  longformRender: spy('longformRender', 'RENDER', 0), longformPackage: spy('longformPackage', 'PACKAGE', 0)
}
// main @ 1b654e9 worker/index.ts wiring, verbatim apart from the spies
function mainWiring(x: ExistingExecutors): StageExecutor[] {
  const sourcePlanExecutor = x.sourcePlan, generativePlanExecutor = x.wisdomPlan
  const planRouter = { ...sourcePlanExecutor, run: (ctx:any) => ctx.job.profile === 'wisdom' ? generativePlanExecutor.run(ctx) : sourcePlanExecutor.run(ctx), inputHash: (job:any) => job.profile === 'wisdom' ? generativePlanExecutor.inputHash(job) : sourcePlanExecutor.inputHash(job), estimateUsd: (job:any) => job.profile === 'wisdom' ? generativePlanExecutor.estimateUsd(job) : sourcePlanExecutor.estimateUsd(job) }
  return withLongform([x.analyze, planRouter as any, x.wisdomAsset, x.compile, x.render, x.autoQc, x.decision, x.final, x.shortsPackage],
    [x.longformPlan, x.longformAsset, x.longformRender, x.longformPackage])
}

for (const id of ['source_shorts', 'wisdom', 'wisdom_longform'] as const) {
  test(`${id}: stage sequence identical to main; first/next stage unchanged`, () => {
    assert.deepEqual([...PIPELINES[id]], MAIN_PIPELINES[id])
    assert.deepEqual([...pipelineFor(id)], MAIN_PIPELINES[id])
    assert.deepEqual([...getProfile(id).stages], MAIN_PIPELINES[id])
    const seq = MAIN_PIPELINES[id]
    for (let i = 0; i < seq.length; i++) assert.equal(nextStage(id, seq[i] as any), seq[i + 1] ?? null)
    assert.equal(firstStage(id, false), seq[0])
    assert.equal(firstStage(id, true), id === 'source_shorts' ? 'COMPILE' : seq[0]) // main: only source_shorts resumes a client plan at COMPILE
  })

  test(`${id}: every stage runs the same executor as main's wiring (run, inputHash, estimateUsd)`, async () => {
    const before = new Map(mainWiring(X).map((e) => [e.stage, e]))
    const after = new Map(stageExecutorsFor(createModuleRegistry(X)).map((e) => [e.stage, e]))
    const job: any = { id: 'job_1', profile: id, planRev: 1 }
    for (const stage of MAIN_PIPELINES[id]) {
      const a = before.get(stage as any)!, b = after.get(stage as any)!
      assert.deepEqual(await b.run({ job } as any), await a.run({ job } as any), `${id}.${stage} run`)
      assert.equal(b.inputHash(job), a.inputHash(job), `${id}.${stage} inputHash`)
      assert.equal(b.estimateUsd(job), a.estimateUsd(job), `${id}.${stage} estimateUsd`)
    }
  })
}

test('worker claims the same stage set in the same order as main', () => {
  assert.deepEqual(stageExecutorsFor(createModuleRegistry(X)).map((e) => e.stage), mainWiring(X).map((e) => e.stage))
})

test('unknown profile is rejected immediately (table lookup, pipeline, worker routing)', async () => {
  for (const bad of ['nope', 'wisdom-v1', '__proto__', 'constructor', 'toString', '']) {
    assert.equal(isProfileId(bad), false, bad)
    assert.throws(() => getProfile(bad), /unknown job profile/)
    assert.throws(() => pipelineFor(bad), /unknown job profile/)
  }
  const plan = stageExecutorsFor(createModuleRegistry(X)).find((e) => e.stage === 'PLAN')!
  assert.throws(() => plan.estimateUsd({ profile: 'nope' } as any), /unknown job profile/)
  assert.deepEqual(Object.keys(PROFILES), ['source_shorts', 'wisdom', 'wisdom_longform', 'senior_longform'])
})

test('a missing / wrong module is rejected before anything runs', () => {
  const registry = createModuleRegistry(X)
  const { ['wisdom.asset']: _gone, ...missing } = registry
  assert.throws(() => stageExecutorsFor(missing), /wisdom\.ASSET: module wisdom\.asset is not registered/)
  // a module registered for another stage
  assert.match(profileErrors({ ...registry, 'wisdom.asset': registry['wisdom.plan'] }).join(';'), /wisdom\.ASSET: module wisdom\.asset runs PLAN/)
  // a module whose requirement is not produced earlier in that profile
  const lf: any = { ...PROFILES.wisdom_longform, stages: ['ASSET', 'PLAN', 'RENDER', 'PACKAGE'] }
  assert.match(profileErrors(registry, [lf]).join(';'), /longform\.asset requires plan/)
  assert.deepEqual(profileErrors(registry), []) // the real table is complete
})
