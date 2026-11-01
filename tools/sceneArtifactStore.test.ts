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

test('concurrent writes keep exactly one immutable scene result', async () => {
  const blobs = createMemoryBlobStore();
  const base = {workspaceId:'w',planId:'p',sceneId:'s',inputHash:sceneInputHash({prompt:'same'})};
  const [first,second] = await Promise.allSettled([
    saveSceneArtifact(blobs,{...base,outputRef:'image/a',outputHash:'a'}),
    saveSceneArtifact(blobs,{...base,outputRef:'image/b',outputHash:'b'})
  ]);
  assert.equal([first,second].filter(x=>x.status==='fulfilled').length,1);
  assert.equal([first,second].filter(x=>x.status==='rejected').length,1);
  const stored = await findSceneArtifact(blobs,base);
  assert.ok(stored?.outputRef==='image/a' || stored?.outputRef==='image/b');
});

test('scene storage fails closed when atomic claim is unavailable', async () => {
  const memory = createMemoryBlobStore();
  const unsafe = { getJson: memory.getJson.bind(memory) } as Parameters<typeof saveSceneArtifact>[0];
  const artifact = {workspaceId:'w',planId:'p',sceneId:'s',inputHash:sceneInputHash({text:'safe'}),outputRef:'images/safe',outputHash:'hash'};
  await assert.rejects(saveSceneArtifact(unsafe,artifact),/atomic scene artifact claim is required/);
  assert.equal(await findSceneArtifact(memory,artifact),null);
});
