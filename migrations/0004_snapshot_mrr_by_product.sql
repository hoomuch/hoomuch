-- MRR split by product (SPEC F-18): a JSON list of {name, mrr, subscriptions}, where `mrr` is a
-- MoneyMap like snapshots.mrr. NULL when the provider doesn't split MRR by product, or couldn't on
-- that day (e.g. a Stripe key without Products: Read). Product and plan names only, no customer data.
ALTER TABLE snapshots ADD COLUMN mrr_by_product TEXT;
