// Static module registry + the per-stage executors the worker runs. No plugin loading, no DAG, no queue:
// each stage executor just looks up the job's Profile (lib/jobs/profiles.ts) and calls that module.
import { JOB_STAGES, type Job, type JobStage } from '../../lib/jobs/types.js'
import { PROFILES, getProfile, type ProfileSpec } from '../../lib/jobs/profiles.js'
import type { StageExecutor } from '../types.js'
import { adapt, type PipelineModule } from './contract.js'
import { featureListErrors } from './features.js'

// The existing executors, built exactly as before by the worker (worker/index.ts).
export type ExistingExecutors = {
  analyze: StageExecutor; sourcePlan: StageExecutor; wisdomPlan: StageExecutor; wisdomAsset: StageExecutor
  compile: StageExecutor; render: StageExecutor; autoQc: StageExecutor; decision: StageExecutor; final: StageExecutor; shortsPackage: StageExecutor
  longformPlan: StageExecutor; longformAsset: StageExecutor; longformRender: StageExecutor; longformPackage: StageExecutor
}
export type ModuleRegistry = Readonly<Record<string, PipelineModule>>

export function createModuleRegistry(x: ExistingExecutors): ModuleRegistry {
  const list = [
    // last argument: features the module cannot work without; optional ones (CAPTION/SOUND/TTS in shorts.render,
    // THUMBNAIL in shorts.package, THUMBNAIL/QC in longform.render) are simply not called when not selected
    adapt('shorts.analyze', ['source'], ['analysis'], x.analyze, ['ANALYZE']),
    adapt('source.plan', ['source', 'analysis'], ['plan'], x.sourcePlan, ['PLAN']),
    adapt('wisdom.plan', ['brief'], ['plan'], x.wisdomPlan, ['PLAN']),
    adapt('wisdom.asset', ['plan'], ['source', 'assets'], x.wisdomAsset, ['IMAGE', 'TTS']),
    adapt('shorts.compile', ['plan', 'source'], ['manifest'], x.compile),
    adapt('shorts.render', ['manifest'], ['render'], x.render, ['RENDER']),
    adapt('shorts.auto_qc', ['render'], ['qc'], x.autoQc, ['QC']),
    adapt('shorts.decision', ['qc'], ['decision'], x.decision),
    adapt('shorts.final', ['render', 'decision'], ['final'], x.final),
    adapt('shorts.package', ['final'], ['package'], x.shortsPackage, ['PACKAGE']),
    adapt('longform.plan', ['brief'], ['plan'], x.longformPlan, ['PLAN']),
    adapt('longform.asset', ['plan'], ['assets'], x.longformAsset, ['IMAGE', 'TTS']),
    adapt('longform.render', ['assets'], ['render'], x.longformRender, ['LONGFORM_RENDER', 'CAPTION']),
    // a Longform job never completes without its thumbnail (existing completion block)
    adapt('longform.package', ['render'], ['package'], x.longformPackage, ['PACKAGE', 'THUMBNAIL'])
  ]
  return Object.freeze(Object.fromEntries(list.map((m) => [m.id, m])))
}

// Checked before the worker runs anything: every stage of every Profile names a registered module for that stage,
// every module's `requires` is available from the Profile input or an earlier stage, the Profile's feature list is in
// a valid order, and every feature a module needs is selected.
export function profileErrors(registry: ModuleRegistry, profiles: readonly ProfileSpec[] = Object.values(PROFILES)): string[] {
  const errors: string[] = []
  for (const p of profiles) {
    errors.push(...featureListErrors(p))
    const have = new Set(p.provides)
    for (const stage of p.stages) {
      const id = p.modules[stage]
      const m = id && Object.prototype.hasOwnProperty.call(registry, id) ? registry[id] : null
      if (!m) { errors.push(`${p.id}.${stage}: module ${id ?? '(none)'} is not registered`); continue }
      if (m.stage !== stage) errors.push(`${p.id}.${stage}: module ${id} runs ${m.stage}`)
      for (const f of m.needs) if (!p.features.includes(f)) errors.push(`${p.id}.${stage}: module ${id} needs feature ${f}, not selected`)
      for (const r of m.requires) if (!have.has(r)) errors.push(`${p.id}.${stage}: module ${id} requires ${r}, not available yet`)
      for (const o of m.produces) have.add(o)
    }
    for (const stage of Object.keys(p.modules)) if (!p.stages.includes(stage as JobStage)) errors.push(`${p.id}: module for ${stage} but ${stage} is not a stage`)
  }
  return errors
}

// One executor per stage (same stage set and order as before), routing each job to its Profile's module.
export function stageExecutorsFor(registry: ModuleRegistry, profiles: readonly ProfileSpec[] = Object.values(PROFILES)): StageExecutor[] {
  const errors = profileErrors(registry, profiles)
  if (errors.length) throw new Error(`profile/module wiring is invalid: ${errors.join('; ')}`)
  const moduleFor = (job: Job, stage: JobStage): PipelineModule => {
    const id = getProfile(job.profile).modules[stage]
    if (!id) throw new Error(`stage ${stage} is not part of profile ${job.profile}`)
    return registry[id]
  }
  return JOB_STAGES.filter((stage) => profiles.some((p) => p.stages.includes(stage))).map((stage) => ({
    stage,
    run: (ctx) => moduleFor(ctx.job, stage).run(ctx),
    inputHash: (job) => moduleFor(job, stage).inputHash(job),
    estimateUsd: (job) => moduleFor(job, stage).estimateUsd(job)
  }))
}
