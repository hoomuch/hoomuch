-- What a sync couldn't count (MetricsSnapshot.warnings): a JSON list of short sentences, e.g.
-- ["MRR is before discounts: this key can't read Coupons."]. NULL when there was nothing to say.
-- Written with that day's snapshot and shown until a later snapshot no longer carries it. No
-- customer data, keys or raw provider text: the engine caps and masks every entry.
ALTER TABLE snapshots ADD COLUMN warnings TEXT;
