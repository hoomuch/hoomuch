-- hoomuch v1 schema. See SPEC.md §5.
-- Conventions: ids are UUID text, timestamps are unix epoch milliseconds,
-- days are 'YYYY-MM-DD' (UTC), money is integer minor units + ISO 4217 code.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- id = sha256(token) hex; the raw token only lives in the cookie.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- key = sha256(lower(email) | ip)
CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE connections (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('stripe', 'lemonsqueezy', 'revenuecat', 'demo')),
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
CREATE INDEX idx_connections_user ON connections(user_id);
CREATE INDEX idx_connections_due ON connections(last_synced_at);

-- One row per connection per UTC day (upserted on every sync that day).
CREATE TABLE snapshots (
  connection_id        TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
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

-- Charges and refunds. No end-customer PII is ever stored here.
CREATE TABLE transactions (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,
  occurred_at   INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('charge', 'refund')),
  amount        INTEGER NOT NULL,       -- signed minor units; refunds are negative
  currency      TEXT NOT NULL,
  fee           INTEGER,
  description   TEXT,                   -- product / plan name
  PRIMARY KEY (connection_id, external_id)
);
CREATE INDEX idx_transactions_time ON transactions(connection_id, occurred_at);

-- The unified daily revenue series the dashboard reads.
CREATE TABLE daily_revenue (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,
  currency      TEXT NOT NULL,
  gross         INTEGER NOT NULL DEFAULT 0,  -- >= 0
  refunds       INTEGER NOT NULL DEFAULT 0,  -- >= 0 (positive number)
  count         INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL CHECK (source IN ('transactions', 'provider')),
  PRIMARY KEY (connection_id, day, currency)
);

-- rates = JSON { "EUR": 0.92, ... } meaning units of CUR per 1 unit of base.
CREATE TABLE fx_rates (
  day        TEXT PRIMARY KEY,
  base       TEXT NOT NULL,
  rates      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('cron', 'manual', 'initial')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  ok            INTEGER,
  events        INTEGER NOT NULL DEFAULT 0,
  message       TEXT
);
CREATE INDEX idx_sync_runs_conn ON sync_runs(connection_id, started_at);
