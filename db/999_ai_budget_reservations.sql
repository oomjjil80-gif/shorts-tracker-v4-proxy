-- Additive schema only. DO NOT apply until database backup and restore are verified.
CREATE TABLE IF NOT EXISTS ai_monthly_budget (
  month_kst char(6) PRIMARY KEY,
  spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0)
);
CREATE TABLE IF NOT EXISTS ai_paid_approvals (
  approval_id text PRIMARY KEY,
  job_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','gemini')),
  quote_micro_usd bigint NOT NULL CHECK (quote_micro_usd > 0),
  month_kst char(6) NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  reservation_id text UNIQUE
);
CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  reservation_id text PRIMARY KEY,
  approval_id text NOT NULL UNIQUE REFERENCES ai_paid_approvals(approval_id),
  month_kst char(6) NOT NULL REFERENCES ai_monthly_budget(month_kst),
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd > 0),
  actual_micro_usd bigint CHECK (actual_micro_usd >= 0),
  status text NOT NULL CHECK (status IN ('reserved','settled','cancelled'))
);
