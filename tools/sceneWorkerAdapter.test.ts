import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBlobStore } from '../lib/jobs/blobs.js';
import { sceneInputHash, saveSceneArtifact } from '../lib/sceneArtifactStore.js';
import { lookupApprovedSceneReuse, executeApprovedScene } from '../lib/sceneWorkerAdapter.js';

test('Worker reuse lookup requires approval and matching input', async () => {
 const blobs=createMemoryBlobStore();
 const base={workspaceId:'w',planId:'p',sceneId:'s',sceneInput:{prompt:'A'}};
 await saveSceneArtifact(blobs,{workspaceId:'w',planId:'p',sceneId:'s',inputHash:sceneInputHash(base.sceneInput),outputRef:'images/a',outputHash:'hash-a'});
 assert.equal((await lookupApprovedSceneReuse(blobs,{...base,approved:false})).kind,'WAIT_APPROVAL');
 assert.equal((await lookupApprovedSceneReuse(blobs,{...base,approved:true})).kind,'REUSE');
 assert.equal((await lookupApprovedSceneReuse(blobs,{...base,sceneInput:{prompt:'B'},approved:true})).kind,'GENERATE_REQUIRED');
});

test('scene execution reuses unchanged scenes and regenerates only changed scene', async () => {
 const blobs=createMemoryBlobStore();
 let calls=0;
 const generate=async (_:unknown)=>{calls++;return {outputRef:'image/'+calls,outputHash:'hash/'+calls}};
 const a={workspaceId:'w',planId:'p',sceneId:'a',sceneInput:{prompt:'A'},approved:true};
 const b={...a,sceneId:'b',sceneInput:{prompt:'B'}};
 assert.equal((await executeApprovedScene(blobs,a,generate)).kind,'GENERATED');
 assert.equal((await executeApprovedScene(blobs,b,generate)).kind,'GENERATED');
 assert.equal((await executeApprovedScene(blobs,a,generate)).kind,'REUSE');
 assert.equal(calls,2);
 assert.equal((await executeApprovedScene(blobs,{...a,sceneInput:{prompt:'A changed'}},generate)).kind,'GENERATED');
 assert.equal((await executeApprovedScene(blobs,b,generate)).kind,'REUSE');
 assert.equal(calls,3);
 assert.equal((await executeApprovedScene(blobs,{...b,approved:false},generate)).kind,'WAIT_APPROVAL');
 assert.equal(calls,3);
});
