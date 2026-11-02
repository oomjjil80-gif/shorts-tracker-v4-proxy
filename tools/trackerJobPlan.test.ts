import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTrackerJobPlan } from '../lib/trackerJobPlan.js';

const plan = { id:'episode-2', title:'Episode 2', format:'video' as const, steps:[
 { id:'script', kind:'script' as const, dependsOn:[] },
 { id:'scene-a', kind:'image' as const, sceneId:'a', dependsOn:['script'] },
 { id:'render', kind:'render' as const, dependsOn:['scene-a'] }
] };

test('preflight maps creative scenes to existing Job stages', () => {
 const result = prepareTrackerJobPlan(plan,'wisdom_longform','longform_script_approval');
 assert.equal(result.stageBlocks.PLAN,'SCRIPT');
 assert.equal(result.stageBlocks.ASSET,'ASSETS');
 assert.equal(result.stageBlocks.RENDER,'RENDER');
 assert.deepEqual(result.bridge.sceneIds,['a']);
});
test('preflight rejects legacy recipe and unsupported carousel', () => {
 assert.throws(() => prepareTrackerJobPlan(plan,'wisdom_longform','legacy_wisdom_longform'),/legacy recipe/);
 assert.throws(() => prepareTrackerJobPlan({...plan,format:'carousel'},'wisdom_longform','longform_script_approval'),/carousel/);
});
