import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeProductionPlan } from '../lib/productionRecipeBridge.js';
import { RECIPES } from '../lib/jobs/recipes.js';

test('creative image steps reuse the existing asset block', () => {
 const plan = { id:'ep2', title:'Episode 2', format:'video' as const, steps:[{id:'script',kind:'script' as const,dependsOn:[]},{id:'image1',kind:'image' as const,sceneId:'one',dependsOn:['script']},{id:'image2',kind:'image' as const,sceneId:'two',dependsOn:['script']},{id:'render',kind:'render' as const,dependsOn:['image1','image2']}] };
 const result = bridgeProductionPlan(plan, RECIPES.longform_script_approval.recipe);
 assert.deepEqual(result.sceneIds,['one','two']);
 assert.deepEqual(result.assetStepIds,['image1','image2']);
 assert.equal(result.stepToBlock.render,'RENDER');
});
