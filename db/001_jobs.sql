-- Production Job foundation (P0-2). Postgres. Apply with `npm run db:migrate` (DATABASE_URL).
-- Server SSOT is Job + Plan/Manifest references only; Episodes stay in the browser (IndexedDB).

CREATE TABLE IF NOT EXISTS production_jobs (
  id                     text PRIMARY KEY,
  workspace_id           text NOT NULL,
  profile                text NOT NULL,
  source_asset_id        text NOT NULL,
  reference_profile_ref  text,
  status                 text NOT NULL CHECK (status IN ('QUEUED','RUNNING','WAITING_USER','COMPLETE','FAILED','CANCELLED')),
  stage                  text NOT NULL CHECK (stage IN ('ANALYZE','PLAN','ASSET','COMPILE','RENDER','AUTO_QC','DECISION','FINAL','PACKAGE')),
  wait_reason            text CHECK (wait_reason IS NULL OR wait_reason IN ('DECISION','BUDGET','QC_BLOCKED','PROVIDER_DOWN')),
  idempotency_key        text NOT NULL,
  request_hash           text NOT NULL,
  lease_owner            text,
  lease_until            timestamptz,
  heartbeat_at           timestamptz,
  run_after              timestamptz,
  budget_usd             numeric(12,4) NOT NULL DEFAULT 0,
  spent_usd              numeric(12,4) NOT NULL DEFAULT 0,
  plan_rev               integer NOT NULL DEFAULT 0,
  plan_ref               text,
  approved_manifest_hash text CHECK (approved_manifest_hash IS NULL OR approved_manifest_hash ~ '^[0-9a-f]{64}$'),
  cancel_requested       boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  CONSTRAINT production_jobs_idem UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT production_jobs_wait CHECK ((status = 'WAITING_USER') = (wait_reason IS NOT NULL)),
  CONSTRAINT production_jobs_lease CHECK (status <> 'RUNNING' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS production_jobs_claim ON production_jobs (status, stage, created_at);

-- Append-only event log: one row when an attempt STARTS, another when it ends (SUCCEEDED/FAILED).
-- "repair" is a kind of stage run, never a job status.
CREATE TABLE IF NOT EXISTS job_stage_runs (
  id           bigserial PRIMARY KEY,
  job_id       text NOT NULL REFERENCES production_jobs(id),
  stage        text NOT NULL,
  kind         text NOT NULL DEFAULT 'run' CHECK (kind IN ('run','repair')),
  attempt      integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED')),
  input_hash   text,
  output_ref   text,
  output_hash  text,
  provider     text,
  model        text,
  usage_json   jsonb,
  result_json  jsonb,
  cost_usd     numeric(12,4) NOT NULL DEFAULT 0,
  error_json   jsonb,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_stage_runs_job ON job_stage_runs (job_id, id);

CREATE OR REPLACE FUNCTION job_stage_runs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'job_stage_runs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_stage_runs_no_update ON job_stage_runs;
CREATE TRIGGER job_stage_runs_no_update BEFORE UPDATE OR DELETE ON job_stage_runs
  FOR EACH ROW EXECUTE FUNCTION job_stage_runs_append_only();
