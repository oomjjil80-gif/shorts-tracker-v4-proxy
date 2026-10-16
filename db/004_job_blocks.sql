-- Block engine (P0 modularisation): the Recipe a Job runs under and each block's progress/approval, kept on the server.
-- A job without a row in job_recipes is a legacy job: it runs exactly as before (no gate). Nothing here deletes or rewrites
-- existing jobs, stage runs or assets.

-- a job may now wait for a user approval of a block's result before any later paid work
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'production_jobs'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%PROVIDER_DOWN%' LOOP
    EXECUTE format('ALTER TABLE production_jobs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE production_jobs ADD CONSTRAINT production_jobs_wait_reason_check
  CHECK (wait_reason IS NULL OR wait_reason IN ('DECISION','BUDGET','QC_BLOCKED','PROVIDER_DOWN','BLOCK_APPROVAL'));

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
