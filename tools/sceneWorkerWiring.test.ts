import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('scene executor is wired inside existing gated and budget-checked Worker stage',()=>{
 const worker=readFileSync('worker/runJob.ts','utf8');
 const types=readFileSync('worker/types.ts','utf8');
 const gate=worker.indexOf("if (deps.blocks) {");
 const budget=worker.indexOf("job.spentUsd + exec.estimateUsd(job)");
 const hook=worker.indexOf("executeScene: (input, generate)");
 const paid=worker.indexOf("const metered = withUsageLedger");
 assert.ok(gate>=0 && gate<budget && budget<paid && paid<hook);
 assert.match(worker,/!deps\.blocks \|\| gate\.kind !== 'RUN' \|\| !input\.approved/);
 assert.match(worker,/workspaceId: job\.workspaceId/);
 assert.match(types,/executeScene\?:/);
});
