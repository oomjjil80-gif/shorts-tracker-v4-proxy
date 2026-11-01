/** Read-only scene reuse decision for a future Worker adapter.
 * This module never executes a stage or bypasses Tracker's approval/budget gate.
 */
import type { JobBlobStore } from './jobs/blobs.js';
import { findSceneArtifact, sceneInputHash } from './sceneArtifactStore.js';

export async function lookupApprovedSceneReuse(
  blobs: JobBlobStore,
  input: { workspaceId: string; planId: string; sceneId: string; sceneInput: unknown; approved: boolean }
) {
  if (!input.approved) return { kind: 'WAIT_APPROVAL' as const };
  const inputHash = sceneInputHash(input.sceneInput);
  const artifact = await findSceneArtifact(blobs, { workspaceId: input.workspaceId, planId: input.planId, sceneId: input.sceneId, inputHash });
  return artifact ? { kind: 'REUSE' as const, artifact } : { kind: 'GENERATE_REQUIRED' as const, inputHash };
}
