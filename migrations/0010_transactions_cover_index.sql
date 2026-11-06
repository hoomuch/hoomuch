-- Read revenue from the index alone (bench/README.md has the measurements).
--
-- The dashboard, the calendar and the sync's daily rebuild all range-scan one connection's
-- transactions by time and read only these columns. With idx_transactions_time (connection_id,
-- occurred_at), every row in the range cost a lookup into the table, where hourly syncs from every
-- tenant leave one connection's rows on scattered pages. This index carries the columns those
-- scans read, so the range is read in order from the index alone: about 7x faster per row on a
-- production-shaped database, for about 40% more index space on transactions.
--
-- It starts with the old index's columns, so every query that used that one uses this one, and the
-- old one is dropped: inserts still maintain two indexes on transactions, not three.
-- On a large instance this takes a few seconds (2.4M rows: ~3 s).
CREATE INDEX idx_transactions_cover ON transactions(connection_id, occurred_at, currency, amount, type, description);
DROP INDEX idx_transactions_time;
