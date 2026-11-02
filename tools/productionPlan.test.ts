import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionPlan, executeProductionPlan, type ProductionPlan } from '../lib/productionPlan.js';

const plan: ProductionPlan = { id: 'ep02', title: '잭과 콩나무', format: 'video', constraints: { maxScenes: 2, maxCostUsd: 0 }, steps: [
  { id: 'script', kind: 'script', dependsOn: [] },
  { id: 'image-b', kind: 'image', sceneId: 'b', dependsOn: ['script'] },
  { id: 'image-a', kind: 'image', sceneId: 'a', dependsOn: ['script'] },
  { id: 'render', kind: 'render', dependsOn: ['image-a', 'image-b'] },
]};
test('topological execution honors dependencies and scene variability', async () => {
  const called: string[] = [];
  const exec = async (s: { id: string }) => { called.push(s.id); return s.id + '-output'; };
  const result = await executeProductionPlan(plan, { script: exec, image: exec, render: exec }, new Set(plan.steps.map(s => s.id)));
  assert.deepEqual(called, ['script','image-b','image-a','render']);
  assert.equal(result.outputs.get('render'), 'render-output');
});
test('no executor invoked without step approval', async () => {
  let calls = 0;
  await assert.rejects(executeProductionPlan(plan, { script: async () => { calls++; } }, new Set()), /not approved/);
  assert.equal(calls, 0);
});
test('rejects cycles, missing dependencies, duplicates and scene limit', () => {
  assert.throws(() => validateProductionPlan({ ...plan, steps: [{ id:'a', kind:'script', dependsOn:['b'] }, { id:'b', kind:'image', dependsOn:['a'] }] }), /cycle/);
  assert.throws(() => validateProductionPlan({ ...plan, steps: [{ id:'a', kind:'script', dependsOn:['missing'] }] }), /unknown dependency/);
  assert.throws(() => validateProductionPlan({ ...plan, steps: [plan.steps[0],plan.steps[0]] }), /duplicate/);
  assert.throws(() => validateProductionPlan({ ...plan, constraints:{ maxScenes:1 }, steps:plan.steps }), /scene limit/);
});
test('reuses preexisting results without repeated AI or render calls', async () => {
  let count = 0;
  const result = await executeProductionPlan(plan, {
    script: async () => { count++; throw new Error('should reuse'); },
    image: async () => { count++; return 'image'; },
    render: async () => { count++; return 'video'; }
  }, new Set(['image-a','image-b','render']), new Map([['script','approved script']]));
  assert.equal(count, 3);
  assert.equal(result.outputs.get('script'), 'approved script');
});
