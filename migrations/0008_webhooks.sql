-- Provider webhooks (SPEC F-17). A webhook only tells hoomuch to sync that connection soon; the
-- payload is never read or stored.
--   webhook_nonce:   random, per connection. Its webhook URL carries an HMAC of (id, nonce) under a
--                    key derived from ENCRYPTION_KEY, so no URL token is stored. NULL = webhooks off;
--                    "New URL" replaces it, which turns the old URL off.
--   webhook_last_at: when the last valid call arrived, so the page can show the setup works.
ALTER TABLE connections ADD COLUMN webhook_nonce TEXT;
ALTER TABLE connections ADD COLUMN webhook_last_at INTEGER;

-- sync_runs.kind gains 'webhook'. SQLite can't change a CHECK, so the table is rebuilt. Nothing
-- references sync_runs, so dropping it cascades nowhere (unlike connections in 0003).
CREATE TABLE sync_runs_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('cron', 'manual', 'initial', 'webhook')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  ok            INTEGER,
  events        INTEGER NOT NULL DEFAULT 0,
  message       TEXT
);
INSERT INTO sync_runs_new (id, connection_id, kind, started_at, finished_at, ok, events, message)
SELECT id, connection_id, kind, started_at, finished_at, ok, events, message FROM sync_runs;
DROP TABLE sync_runs;
ALTER TABLE sync_runs_new RENAME TO sync_runs;
CREATE INDEX idx_sync_runs_conn ON sync_runs(connection_id, started_at);
