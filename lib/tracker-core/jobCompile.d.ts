import type { RenderManifest } from './renderManifest.js'
export const JOB_PLAN_SCHEMA: 'job-plan/1'
export type SourceIdentity = { sourceAssetId: string | null; blobPath: string | null; sha256: string | null }
export function compileJobPlan(input: { jobId: string; plan: any; sourceAsset: any; assetManifestResult?: any }): { manifest: RenderManifest; identity: SourceIdentity[] }
