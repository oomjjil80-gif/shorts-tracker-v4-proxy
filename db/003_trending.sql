-- 급상승 탐색: real view-count observations (YouTube Data API mostPopular chart). Append-only history; ranking is computed on read.
CREATE TABLE IF NOT EXISTS trend_observations (
  id bigserial PRIMARY KEY,
  list_group text NOT NULL CHECK (list_group IN ('KR','GLOBAL')),
  video_id text NOT NULL,
  region_code text NOT NULL,
  title text NOT NULL,
  channel text NOT NULL DEFAULT '',
  thumbnail_url text NOT NULL DEFAULT '',
  view_count bigint NOT NULL CHECK (view_count >= 0),
  observed_at timestamptz NOT NULL,
  UNIQUE (list_group, video_id, observed_at)
);
CREATE INDEX IF NOT EXISTS trend_observations_lookup ON trend_observations (list_group, video_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS trend_observations_time ON trend_observations (list_group, observed_at DESC);
-- one row: the hourly claim (prevents duplicate runs across workers/restarts) + last result
CREATE TABLE IF NOT EXISTS trend_state (
  key text PRIMARY KEY,
  last_run_at timestamptz NOT NULL,
  last_status text NOT NULL DEFAULT '',
  last_error text NOT NULL DEFAULT ''
);
