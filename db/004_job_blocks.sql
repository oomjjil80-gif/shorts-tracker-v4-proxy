-- Block engine (P0 modularisation): the Recipe a Job runs under and each block's progress/approval, kept on the server.
-- A job without a row in job_recipes is a legacy job: it runs exactly as before (no gate). Nothing here deletes or rewrites
-- existing jobs, stage runs or assets.

-- A job may now wait for a user approval of a block's result before any later paid work: wait_reason gains 'BLOCK_APPROVAL'.
-- Only the ONE constraint that is a CHECK on the single column production_jobs.wait_reason is replaced. It is found by structure
-- (pg_constraint.conkey = {wait_reason}), never by name guess or by searching its text, so production_jobs_wait (status <-> wait_reason),
-- production_jobs_lease and any other constraint are left alone. Re-running this file drops and re-creates the same constraint.
DO $$
DECLARE att smallint; c text; n integer; definition text;
BEGIN
  SELECT attnum INTO att FROM pg_attribute WHERE attrelid = 'production_jobs'::regclass AND attname = 'wait_reason' AND NOT attisdropped;
  IF att IS NULL THEN RAISE EXCEPTION 'production_jobs.wait_reason not found; apply 001_jobs.sql first'; END IF;
  -- Fail closed before any DDL if the live schema differs from the known legacy shape.
  SELECT count(*), max(pg_get_constraintdef(oid)) INTO n, definition
    FROM pg_constraint
   WHERE conrelid = 'production_jobs'::regclass AND contype = 'c' AND conkey = ARRAY[att];
  IF n <> 1 OR definition IS NULL OR
     definition NOT LIKE '%DECISION%' OR definition NOT LIKE '%BUDGET%' OR
     definition NOT LIKE '%QC_BLOCKED%' OR definition NOT LIKE '%PROVIDER_DOWN%' THEN
    RAISE EXCEPTION 'Unexpected production_jobs.wait_reason CHECK (count %, definition %); migration aborted without changes', n, definition;
  END IF;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'production_jobs'::regclass AND contype = 'c' AND conkey = ARRAY[att] LOOP
    EXECUTE format('ALTER TABLE production_jobs DROP CONSTRAINT %I', c);
  END LOOP;
  EXECUTE 'ALTER TABLE production_jobs ADD CONSTRAINT production_jobs_wait_reason_check CHECK (wait_reason IS NULL OR wait_reason IN (''DECISION'',''BUDGET'',''QC_BLOCKED'',''PROVIDER_DOWN'',''BLOCK_APPROVAL''))';
END $$;

CREATE TABLE IF NOT EXISTS job_recipes (
  job_id       text PRIMARY KEY REFERENCES production_jobs(id) ON DELETE CASCADE,
  recipe_id    text NOT NULL,
  recipe       jsonb NOT NULL,
  stage_blocks jsonb NOT NULL,
  recipe_hash  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_blocks (
  job_id        text NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  block         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','APPROVED')),
  input_hash    text,
  artifact_hash text,
  output_ref    text,
  output_hash   text,
  result        jsonb,
  approved_hash text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, block)
);
