import type { JobStage } from './types.js'
import { getProfile } from './profiles.js'
import type { BlockId } from './recipe.js'

/** Read-only compatibility view of the existing production worker. No state mutation. */
export type LegacyBlockMapping = Readonly<{ stage: JobStage; block: BlockId; module: string; note: string }>
const BLOCK_FOR_STAGE: Readonly<Partial<Record<JobStage, BlockId>>> = {
  ANALYZE: 'RESEARCH',
  PLAN: 'SCRIPT',
  ASSET: 'ASSETS',
  COMPILE: 'ASSETS',
  RENDER: 'RENDER',
  AUTO_QC: 'FINAL_REVIEW',
  DECISION: 'FINAL_REVIEW',
  FINAL: 'FINAL_REVIEW',
  PACKAGE: 'FINAL_REVIEW'
}
export function legacyBlockMapping(profileId: string): readonly LegacyBlockMapping[] {
  const profile = getProfile(profileId)
  return profile.stages.map(stage => ({
    stage,
    block: BLOCK_FOR_STAGE[stage]!,
    module: profile.modules[stage]!,
    note: 'compatibility only; does not imply independent approval or block execution'
  }))
}
