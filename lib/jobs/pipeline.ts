import type { JobStage } from './types.js'
import { PROFILES, getProfile } from './profiles.js'

// Minimal per-profile stage order (no generic workflow engine), declared once in ./profiles.ts.
export const PIPELINES: Record<string, readonly JobStage[]> = Object.fromEntries(Object.values(PROFILES).map((p) => [p.id, p.stages]))

export function pipelineFor(profile: string): readonly JobStage[] {
  return getProfile(profile).stages
}

export function nextStage(profile: string, stage: JobStage): JobStage | null {
  const p = pipelineFor(profile)
  const i = p.indexOf(stage)
  if (i < 0) throw new Error(`stage ${stage} is not part of profile ${profile}`)
  return p[i + 1] ?? null
}

export function firstStage(profile: string, hasPlan: boolean): JobStage {
  const p = getProfile(profile)
  return hasPlan && p.resumeWithPlanAt ? p.resumeWithPlanAt : p.stages[0]
}
