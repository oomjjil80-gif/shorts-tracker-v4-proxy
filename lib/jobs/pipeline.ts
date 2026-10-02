import type { JobStage } from './types.js'

// Minimal per-profile stage order (no generic workflow engine). ASSET is skipped for source_shorts.
export const PIPELINES: Record<string, readonly JobStage[]> = {
  source_shorts: ['ANALYZE', 'PLAN', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE'],
  wisdom: ['PLAN', 'ASSET', 'ANALYZE', 'COMPILE', 'RENDER', 'AUTO_QC', 'DECISION', 'FINAL', 'PACKAGE']
}

export function pipelineFor(profile: string): readonly JobStage[] {
  const p = PIPELINES[profile]
  if (!p) throw new Error(`unknown job profile: ${profile}`)
  return p
}

export function nextStage(profile: string, stage: JobStage): JobStage | null {
  const p = pipelineFor(profile)
  const i = p.indexOf(stage)
  if (i < 0) throw new Error(`stage ${stage} is not part of profile ${profile}`)
  return p[i + 1] ?? null
}

export function firstStage(profile: string, hasPlan: boolean): JobStage {
  const p = pipelineFor(profile)
  return profile === 'source_shorts' && hasPlan ? 'COMPILE' : p[0]
}
