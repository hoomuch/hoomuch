-- Drop the provider CHECK on connections, so adding a provider never needs another table rebuild.
-- The app validates every write with isProviderId (src/providers/types.ts).
--
-- SQLite can't alter a CHECK, so `connections` is rebuilt. The usual copy → drop → rename would
-- DESTROY DATA here: with foreign keys on (always, in D1), DROP TABLE does an implicit DELETE, and
-- that fires ON DELETE CASCADE into snapshots, transactions, daily_revenue and sync_runs. So:
--   1. build connections_new, and the four child tables pointing at connections_new;
--   2. drop the old children, then the old parent (nothing references it any more, so no cascade);
--   3. rename. SQLite rewrites the children's REFERENCES connections_new → connections.
-- No BEGIN/COMMIT: D1 applies a migration file atomically and rejects explicit transactions.
-- test/db/migration-0003.test.ts checks rows survive and cascades still work afterwards.

PRAGMA defer_foreign_keys = on;

CREATE TABLE connections_new (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL,
  name                 TEXT NOT NULL,
  credentials_enc      TEXT NOT NULL,              -- AES-GCM blob of the secret fields (JSON)
  key_hint             TEXT,                       -- e.g. "…a1b2", safe to display
  config               TEXT NOT NULL DEFAULT '{}', -- JSON: non-secret fields + adapter-discovered config
  test_mode            INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'ok', 'error')),
  last_synced_at       INTEGER,
  last_sync_started_at INTEGER,
  last_error           TEXT,
  revenue_cursor       TEXT,                       -- opaque adapter cursor while a backfill is in progress
  revenue_synced_until INTEGER,                    -- high-water mark of fully synced revenue (ms)
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
INSERT INTO connections_new
  (id, user_id, provider, name, credentials_enc, key_hint, config, test_mode, status, last_synced_at,
   last_sync_started_at, last_error, revenue_cursor, revenue_synced_until, created_at, updated_at)
SELECT
   id, user_id, provider, name, credentials_enc, key_hint, config, test_mode, status, last_synced_at,
   last_sync_started_at, last_error, revenue_cursor, revenue_synced_until, created_at, updated_at
FROM connections;

CREATE TABLE snapshots_new (
  connection_id        TEXT NOT NULL REFERENCES connections_new(id) ON DELETE CASCADE,
  day                  TEXT NOT NULL,
  mrr                  TEXT NOT NULL,   -- MoneyMap JSON, e.g. {"USD":12300,"EUR":4500}
  active_subscriptions INTEGER NOT NULL,
  active_trials        INTEGER,
  revenue_period       TEXT,            -- MoneyMap JSON, provider-reported trailing revenue
  revenue_period_days  INTEGER,         -- 30, or 28 for RevenueCat
  new_customers        INTEGER,
  captured_at          INTEGER NOT NULL,
  PRIMARY KEY (connection_id, day)
);
INSERT INTO snapshots_new
  (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period, revenue_period_days,
   new_customers, captured_at)
SELECT
   connection_id, day, mrr, active_subscriptions, active_trials, revenue_period, revenue_period_days,
   new_customers, captured_at
FROM snapshots;

CREATE TABLE transactions_new (
  connection_id TEXT NOT NULL REFERENCES connections_new(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,
  occurred_at   INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('charge', 'refund')),
  amount        INTEGER NOT NULL,       -- signed minor units; refunds are negative
  currency      TEXT NOT NULL,
  fee           INTEGER,
  description   TEXT,                   -- product / plan name
  PRIMARY KEY (connection_id, external_id)
);
INSERT INTO transactions_new (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
SELECT connection_id, external_id, occurred_at, type, amount, currency, fee, description FROM transactions;

CREATE TABLE daily_revenue_new (
  connection_id TEXT NOT NULL REFERENCES connections_new(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,
  currency      TEXT NOT NULL,
  gross         INTEGER NOT NULL DEFAULT 0,  -- >= 0
  refunds       INTEGER NOT NULL DEFAULT 0,  -- >= 0 (positive number)
  count         INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL CHECK (source IN ('transactions', 'provider')),
  PRIMARY KEY (connection_id, day, currency)
);
INSERT INTO daily_revenue_new (connection_id, day, currency, gross, refunds, count, source)
SELECT connection_id, day, currency, gross, refunds, count, source FROM daily_revenue;

CREATE TABLE sync_runs_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES connections_new(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('cron', 'manual', 'initial')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  ok            INTEGER,
  events        INTEGER NOT NULL DEFAULT 0,
  message       TEXT
);
INSERT INTO sync_runs_new (id, connection_id, kind, started_at, finished_at, ok, events, message)
SELECT id, connection_id, kind, started_at, finished_at, ok, events, message FROM sync_runs;

-- Children first: once they're gone, dropping the old parent cascades into nothing.
DROP TABLE snapshots;
DROP TABLE transactions;
DROP TABLE daily_revenue;
DROP TABLE sync_runs;
DROP TABLE connections;

ALTER TABLE connections_new RENAME TO connections;
ALTER TABLE snapshots_new RENAME TO snapshots;
ALTER TABLE transactions_new RENAME TO transactions;
ALTER TABLE daily_revenue_new RENAME TO daily_revenue;
ALTER TABLE sync_runs_new RENAME TO sync_runs;

CREATE INDEX idx_connections_user ON connections(user_id);
CREATE INDEX idx_connections_due ON connections(last_synced_at);
CREATE INDEX idx_transactions_time ON transactions(connection_id, occurred_at);
CREATE INDEX idx_sync_runs_conn ON sync_runs(connection_id, started_at);
