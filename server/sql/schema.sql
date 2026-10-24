-- PostgreSQL persistence used when DATABASE_URL is configured.
-- The file-backed local adapter has the same collection/id/data shape.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_records (
  collection text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS app_records_collection_updated_idx
  ON app_records (collection, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS app_records_user_email_unique
  ON app_records ((lower(data->>'email'))) WHERE collection = 'users';

CREATE UNIQUE INDEX IF NOT EXISTS visit_notes_idempotency_unique
  ON app_records ((data->>'idempotencyScope')) WHERE collection = 'visit_notes' AND data ? 'idempotencyScope';

CREATE UNIQUE INDEX IF NOT EXISTS app_records_api_key_unique
  ON app_records ((data->>'publicKey')) WHERE collection = 'api_keys';

CREATE INDEX IF NOT EXISTS webhook_delivery_due_idx
  ON app_records ((COALESCE((data->>'nextAttemptAt')::timestamptz, '-infinity'::timestamptz)), updated_at)
  WHERE collection = 'webhook_deliveries' AND data->>'status' = 'pending';

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket text PRIMARY KEY,
  window_start_ms bigint NOT NULL,
  hits integer NOT NULL CHECK (hits > 0)
);

CREATE INDEX IF NOT EXISTS rate_limit_counters_window_idx
  ON rate_limit_counters (window_start_ms);
