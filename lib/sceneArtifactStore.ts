/** Immutable scene output index. A scene can be reused only for the same
 * workspace, plan, scene and input hash. Never executes or approves paid work.
 */
import { sha256, type JobBlobStore } from './jobs/blobs.js';
import { canonicalize } from './tracker-core/renderManifest.js';

export type SceneArtifact = Readonly<{
  workspaceId: string;
  planId: string;
  sceneId: string;
  inputHash: string;
  outputRef: string;
  outputHash: string;
}>;

export function sceneInputHash(input: unknown): string {
  return sha256(canonicalize(input));
}
export function sceneArtifactPath(input: Pick<SceneArtifact, 'workspaceId'|'planId'|'sceneId'|'inputHash'>): string {
  for (const value of Object.values(input)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('scene artifact identity required');
  }
  return 'scene-artifacts/' + sha256(canonicalize(input)) + '.json';
}
export async function findSceneArtifact(blobs: JobBlobStore, identity: Pick<SceneArtifact, 'workspaceId'|'planId'|'sceneId'|'inputHash'>): Promise<SceneArtifact | null> {
  const artifact = await blobs.getJson<SceneArtifact>(sceneArtifactPath(identity));
  if (!artifact) return null;
  for (const key of ['workspaceId','planId','sceneId','inputHash'] as const) {
    if (artifact[key] !== identity[key]) throw new Error('scene artifact identity mismatch');
  }
  if (!artifact.outputRef || !artifact.outputHash) throw new Error('incomplete scene artifact');
  return artifact;
}
export async function saveSceneArtifact(blobs: JobBlobStore, artifact: SceneArtifact): Promise<SceneArtifact> {
  if (!artifact.outputRef || !artifact.outputHash) throw new Error('output identity required');
  const path = sceneArtifactPath(artifact);
  const prior = await findSceneArtifact(blobs, artifact);
  if (prior) {
    if (prior.outputRef !== artifact.outputRef || prior.outputHash !== artifact.outputHash)
      throw new Error('scene artifact already exists with different output');
    return prior;
  }
  await blobs.putJson(path, artifact);
  const saved = await findSceneArtifact(blobs, artifact);
  if (!saved || saved.outputRef !== artifact.outputRef || saved.outputHash !== artifact.outputHash)
    throw new Error('scene artifact write conflict');
  return saved;
}
