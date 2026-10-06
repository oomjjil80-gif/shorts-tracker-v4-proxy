import type { JobStage } from './types.js'

// One table for every production Profile: its stage order, the module that runs each stage (id in
// worker/modules/registry.ts, which adapts the existing executors) and the few job-level facts that used to be
// `profile === ...` checks elsewhere. No workflow engine: stages still run one at a time in this fixed order.
export type ProfileId = 'source_shorts' | 'wisdom' | 'wisdom_longform' | 'senior_longform'
// Production features a Profile selects, in order (worker/modules/features.ts checks the order and what each needs).
// A feature that is not selected is never called. Job stages are unchanged: features run inside the existing stages.
export type FeatureId = 'PLAN' | 'ANALYZE' | 'IMAGE' | 'TTS' | 'CAPTION' | 'SOUND' | 'RENDER' | 'LONGFORM_RENDER' | 'QC' | 'THUMBNAIL' | 'PACKAGE'
export type ProfileSpec = {
  id: ProfileId
  // what job_create accepts: a registered source video, a Wisdom Shorts brief or a Wisdom Longform brief
  input: 'source_asset' | 'wisdom_brief' | 'longform_brief'
  // what exists before the first stage (module `requires` are checked against this + earlier `produces`)
  provides: readonly string[]
  stages: readonly JobStage[]
  features: readonly FeatureId[]
  modules: Readonly<Partial<Record<JobStage, string>>>
  // a client-supplied plan skips ahead to this stage
  resumeWithPlanAt?: JobStage
  // which job_package view the phone gets
  packageView: 'shorts' | 'longform'
}

const SHORTS_TAIL = { COMPILE: 'shorts.compile', RENDER: 'shorts.render', AUTO_QC: 'shorts.auto_qc', DECISION: 'shorts.decision', FINAL: 'shorts.final', PACKAGE: 'shorts.package' } as const

export const PROFILES: Readonly<Record<ProfileId, ProfileSpec>> = {
  source_shorts: {
    id: 'source_shorts', input: 'source_asset', provides: ['source'], packageView: 'shorts', resumeWithPlanAt: 'COMPILE',
    // ASSET is skipped for source_shorts
    stages: ['ANALYZE', 'PLAN', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE'],
    // RENDER stage internals: TTS -> CAPTION -> SOUND (source audio + narration mix only, no BGM) -> RENDER
    features: ['ANALYZE', 'PLAN', 'TTS', 'CAPTION', 'SOUND', 'RENDER', 'QC', 'PACKAGE'],
    modules: { ANALYZE: 'shorts.analyze', PLAN: 'source.plan', ...SHORTS_TAIL }
  },
  wisdom: {
    id: 'wisdom', input: 'wisdom_brief', provides: ['brief'], packageView: 'shorts',
    stages: ['PLAN', 'ASSET', 'ANALYZE', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE'],
    features: ['PLAN', 'IMAGE', 'TTS', 'ANALYZE', 'CAPTION', 'RENDER', 'QC', 'THUMBNAIL', 'PACKAGE'],
    modules: { PLAN: 'wisdom.plan', ASSET: 'wisdom.asset', ANALYZE: 'shorts.analyze', ...SHORTS_TAIL }
  },
  // 16:9 Wisdom Longform: one static image + narration + left key-phrase cards (worker/stages/longform.ts)
  wisdom_longform: {
    id: 'wisdom_longform', input: 'longform_brief', provides: ['brief'], packageView: 'longform',
    stages: ['PLAN', 'ASSET', 'RENDER', 'PACKAGE'],
    // ONE image, 16:9, sentence cards, length gate, no BGM/SFX; QC stays inside RENDER (no AUTO_QC stage)
    features: ['PLAN', 'IMAGE', 'TTS', 'CAPTION', 'LONGFORM_RENDER', 'THUMBNAIL', 'QC', 'PACKAGE'],
    modules: { PLAN: 'longform.plan', ASSET: 'longform.asset', RENDER: 'longform.render', PACKAGE: 'longform.package' }
  },
  // 16:9 Senior Longform: the SAME Longform engine and modules in its story "scenes" mode (six acts, a picture per visual
  // scene in one style with a Character Bible, bottom subtitle cards, gentle motion); see LONGFORM_MODES
  senior_longform: {
    id: 'senior_longform', input: 'longform_brief', provides: ['brief'], packageView: 'longform',
    stages: ['PLAN', 'ASSET', 'RENDER', 'PACKAGE'],
    features: ['PLAN', 'IMAGE', 'TTS', 'CAPTION', 'LONGFORM_RENDER', 'THUMBNAIL', 'QC', 'PACKAGE'],
    modules: { PLAN: 'longform.plan', ASSET: 'longform.asset', RENDER: 'longform.render', PACKAGE: 'longform.package' }
  }
}

export const isProfileId = (id: string): id is ProfileId => Object.prototype.hasOwnProperty.call(PROFILES, id)
export const profileOf = (id: string): ProfileSpec | null => (isProfileId(id) ? PROFILES[id] : null)
export function getProfile(id: string): ProfileSpec {
  const p = profileOf(id)
  if (!p) throw new Error(`unknown job profile: ${id}`)
  return p
}
