import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBlobStore } from '../lib/jobs/blobs.js';
import { sceneInputHash, saveSceneArtifact } from '../lib/sceneArtifactStore.js';
import { lookupApprovedSceneReuse } from '../lib/sceneWorkerAdapter.js';

test('Worker reuse lookup requires approval and matching input', async () => {
 const blobs=createMemoryBlobStore();
 const base={workspaceId:'w',planId:'p',sceneId:'s',sceneInput:{prompt:'A'}};
 await saveSceneArtifact(blobs,{workspaceId:'w',planId:'p',sceneId:'s',inputHash:sceneInputHash(base.sceneInput),outputRef:'images/a',outputHash:'hash-a'});
 assert.equal((await lookupApprovedSceneReuse(blobs,{...base,approved:false})).kind,'WAIT_APPROVAL');
 assert.equal((await lookupApprovedSceneReuse(blobs,{...base,approved:true})).kind,'REUSE');
 assert.equal((await lookupApprovedSceneReuse(blobs,{...base,sceneInput:{prompt:'B'},approved:true})).kind,'GENERATE_REQUIRED');
});
