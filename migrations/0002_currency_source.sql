-- Where the display currency came from (design/system.md §7).
--   default:  never set; the dashboard picks it from the first real connection's numbers
--   inferred: picked that way, once
--   chosen:   the user set it in Settings; never changed automatically again
ALTER TABLE users ADD COLUMN currency_source TEXT NOT NULL DEFAULT 'default'
  CHECK (currency_source IN ('default', 'inferred', 'chosen'));
