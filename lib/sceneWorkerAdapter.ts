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

/** Executes one approved scene through a caller-provided, already gated stage executor.
 * Reuses identical output and never regenerates unrelated scenes.
 * The caller must enforce Tracker Job budget/lease and record metered usage.
 */
export async function executeApprovedScene(
  blobs: JobBlobStore,
  input: { workspaceId: string; planId: string; sceneId: string; sceneInput: unknown; approved: boolean },
  generate: (sceneInput: unknown) => Promise<{ outputRef: string; outputHash: string }>
) {
  const decision = await lookupApprovedSceneReuse(blobs, input);
  if (decision.kind === 'WAIT_APPROVAL') return { kind: 'WAIT_APPROVAL' as const };
  if (decision.kind === 'REUSE') return { kind: 'REUSE' as const, artifact: decision.artifact };
  if (!blobs.claim) throw new Error('atomic scene artifact claim is required');
  const { saveSceneArtifact } = await import('./sceneArtifactStore.js');
  const output = await generate(input.sceneInput);
  const artifact = await saveSceneArtifact(blobs, {
    workspaceId: input.workspaceId, planId: input.planId,
    sceneId: input.sceneId, inputHash: decision.inputHash,
    outputRef: output.outputRef, outputHash: output.outputHash
  });
  return { kind: 'GENERATED' as const, artifact };
}
