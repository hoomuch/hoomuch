-- MRR movement (SPEC F-26): why MRR moved, not just by how much.
--
-- Adapters that list subscriptions one by one report each paying subscription's id and monthly
-- amount with the snapshot. The sync engine compares that list with the one from the sync before
-- and adds what changed to the day's row: subscriptions that started paying (new), pay more
-- (expansion), pay less (contraction) or stopped counting (churned).
--
-- subscription_states: the list as of the last sync, one row per connection.
--   since: the owner's local day the first list was stored. Movement is known from then on.
--   state: JSON {"<subscription id>": [<monthly minor units>, "<CURRENCY>"]}. Provider ids only,
--          nothing about the customer. Last, so reading `since` never touches it.
CREATE TABLE subscription_states (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  since         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  state         TEXT NOT NULL
);

-- mrr_movements: one row per connection and day (the owner's local day of the sync that saw the
-- change) that had any. Amounts are MoneyMap JSON, positive, in the subscriptions' own currencies.
CREATE TABLE mrr_movements (
  connection_id     TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  day               TEXT NOT NULL,
  new_mrr           TEXT NOT NULL,
  new_count         INTEGER NOT NULL,
  expansion_mrr     TEXT NOT NULL,
  expansion_count   INTEGER NOT NULL,
  contraction_mrr   TEXT NOT NULL,
  contraction_count INTEGER NOT NULL,
  churned_mrr       TEXT NOT NULL,
  churned_count     INTEGER NOT NULL,
  PRIMARY KEY (connection_id, day)
);
