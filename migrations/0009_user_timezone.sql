-- The user's time zone (SPEC §6): days on the dashboard, calendar and transactions run midnight to
-- midnight there. An IANA name, e.g. 'Europe/Istanbul'.
--   timezone_source: where it came from, like currency_source (0002)
--     default:  never set; UTC
--     inferred: taken once from the zone Cloudflare puts on the user's request
--     chosen:   the user set it in Settings; never changed automatically again
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN timezone_source TEXT NOT NULL DEFAULT 'default'
  CHECK (timezone_source IN ('default', 'inferred', 'chosen'));
