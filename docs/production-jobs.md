# Production Jobs (P0-2 foundation)

Server SSOT = **Job + Plan/Manifest references**. Episodes stay in the Tracker (IndexedDB); an Episode may carry
`productionJob: { jobId, approvedManifestHash, finalRenderRef }` (optional).

## State
`status`: QUEUED · RUNNING · WAITING_USER · COMPLETE · FAILED · CANCELLED  
`stage` (source_shorts): ANALYZE → PLAN → COMPILE → RENDER → AUTO_QC → DECISION → FINAL → PACKAGE  
`wait_reason`: DECISION · BUDGET · QC_BLOCKED · PROVIDER_DOWN (set iff status = WAITING_USER; enforced by a CHECK)  
REPAIR is a `job_stage_runs.kind`, never a status. `job_stage_runs` is append-only (trigger).

## Behaviour
- **Idempotency**: `UNIQUE(workspace_id, idempotency_key)`; same key + same request returns the existing job, a different request is `409 IDEMPOTENCY_KEY_REUSED`.
- **Lease**: `claimJob` (`FOR UPDATE SKIP LOCKED`) · `heartbeat` · expired RUNNING jobs are reclaimable · results are fenced by lease owner/expiry.
- **Retry**: `failStage` requeues with backoff until `maxAttempts`, then FAILED; deterministic errors (`StageError`) are not retried.
- **Cancel**: idle jobs cancel at once; running jobs get `cancel_requested`, seen on heartbeat and honoured at the stage boundary.
- **Budget**: a stage whose estimate would exceed `budget_usd` parks the job (`BUDGET`) before any attempt starts.
- **Decision**: only a `manifestHash` this job compiled, whose gate PASSed (or an explicit override reason, recorded).
- **QC gate** (`lib/qc/gate.ts`): required checks pass only on PASS; FAIL/UNKNOWN block; errors/timeouts are UNKNOWN; zero required checks never passes.

## Compiler parity
`lib/tracker-core/*` are verbatim copies of the Tracker frontend compiler, pinned by `tracker-core.manifest.json` and a golden hash.
After changing the frontend core: `node tools/tracker-core-manifest.mjs --write` there, then `npm run sync-core` here.

## Operate
```
DATABASE_URL=postgres://…   npm run db:migrate     # applies db/*.sql
DATABASE_URL=… BLOB_READ_WRITE_TOKEN=… npm run worker   # any always-on Node process
```
API (`api/jobs.ts`, header `X-Sync-Key`): `POST {action:create|decision|cancel}`, `GET ?id=`.
No Postgres provider is bound: any `DATABASE_URL` works (node-postgres). Not yet hosted: the Worker process and the database.
