import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static guard regression: no Job or blob write may occur after preflight while
// scene-level worker persistence is not implemented. No DB or paid calls.
test('productionPlan remains fail-closed before job creation', () => {
 const http = readFileSync(new URL('../lib/jobs/http.ts', import.meta.url), 'utf8');
 const start = http.indexOf("if (taskType === 'job_create')");
 const guard = http.indexOf('if (body.input?.productionPlan !== undefined)', start);
 const reject = http.indexOf("throw new JobError('BAD_REQUEST', 'productionPlan execution is not enabled", guard);
 const create = http.indexOf('await store.createJob(', start);
 assert.ok(start >= 0 && guard > start && reject > guard && create > reject);
 assert.ok(http.slice(guard,reject).includes('prepareTrackerJobPlan('));
});
