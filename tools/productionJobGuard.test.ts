import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionPlan } from '../lib/productionPlan.js';
test('malformed production plans fail closed before persistence', () => {
 for(const plan of [null, {}, {id:2,title:'t',format:'video',steps:[]}, {id:'p',title:'t',format:'video',steps:[{id:'s',kind:'image',dependsOn:null}]}]) assert.throws(()=>validateProductionPlan(plan as any));
});
