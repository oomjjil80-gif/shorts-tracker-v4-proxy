// Feature modules: the production functions a Profile selects (lib/jobs/profiles.ts `features`). They run inside the
// existing Job stages; an executor calls a feature only when the job's Profile selected it. Missing a feature that an
// executor cannot work without is a configuration error raised before any paid call — never an automatic insert or a
// hidden fallback.
import type { Job } from '../../lib/jobs/types.js'
import { getProfile, type FeatureId, type ProfileSpec } from '../../lib/jobs/profiles.js'
import { StageError } from '../types.js'

export const FEATURE_IDS: readonly FeatureId[] = ['PLAN', 'ANALYZE', 'IMAGE', 'TTS', 'CAPTION', 'SOUND', 'RENDER', 'LONGFORM_RENDER', 'QC', 'THUMBNAIL', 'PACKAGE']
// What must be selected EARLIER in the list (an inner array = any one of them).
const AFTER: Record<FeatureId, readonly (FeatureId | readonly FeatureId[])[]> = {
  PLAN: [], ANALYZE: [], IMAGE: ['PLAN'], TTS: ['PLAN'], CAPTION: ['PLAN'], SOUND: ['TTS'], RENDER: ['PLAN'],
  LONGFORM_RENDER: ['IMAGE', 'TTS', 'CAPTION'], QC: [['RENDER', 'LONGFORM_RENDER']], THUMBNAIL: ['PLAN'], PACKAGE: [['RENDER', 'LONGFORM_RENDER']]
}

export function featureListErrors(p: Pick<ProfileSpec, 'id' | 'features'>): string[] {
  const errors: string[] = [], seen = new Set<FeatureId>()
  for (const f of p.features) {
    if (!FEATURE_IDS.includes(f)) { errors.push(`${p.id}: unknown feature ${f}`); continue }
    if (seen.has(f)) errors.push(`${p.id}: feature ${f} listed twice`)
    for (const need of AFTER[f]) {
      const any = (Array.isArray(need) ? need : [need]) as FeatureId[]
      if (!any.some((x) => seen.has(x))) errors.push(`${p.id}: feature ${f} needs ${any.join(' or ')} before it`)
    }
    seen.add(f)
  }
  return errors
}

export type FeatureResolver = (job: Job) => ReadonlySet<FeatureId>
// Production: the job's own Profile. Tests pass their own resolver to run an executor with a test Profile.
export const profileFeatures: FeatureResolver = (job) => new Set(getProfile(job.profile).features)

// An executor's hard requirements, checked at the start of its run (before any paid call).
export function needFeatures(selected: ReadonlySet<FeatureId>, needed: readonly FeatureId[], where: string): void {
  const missing = needed.filter((f) => !selected.has(f))
  if (missing.length) throw new StageError('MODULE_CONFIG', `${where} needs feature(s) ${missing.join(', ')} that this profile does not select`)
}
