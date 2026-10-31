import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBlobStore } from '../lib/jobs/blobs.js';
import { sceneInputHash, saveSceneArtifact, findSceneArtifact } from '../lib/sceneArtifactStore.js';

test('scene results reuse only identical workspace and scene input', async () => {
  const blobs = createMemoryBlobStore();
  const a = { workspaceId:'workspace-a',planId:'ep1',sceneId:'scene1',inputHash:sceneInputHash({text:'first'}),outputRef:'images/one.png',outputHash:'hash-one' };
  await saveSceneArtifact(blobs,a);
  assert.deepEqual(await findSceneArtifact(blobs,a),a);
  assert.equal(await findSceneArtifact(blobs,{...a,sceneId:'scene2'}),null);
  assert.equal(await findSceneArtifact(blobs,{...a,workspaceId:'workspace-b'}),null);
  assert.equal(await findSceneArtifact(blobs,{...a,inputHash:sceneInputHash({text:'changed'})}),null);
  await assert.rejects(saveSceneArtifact(blobs,{...a,outputRef:'images/two.png'}),/different output/);
});
