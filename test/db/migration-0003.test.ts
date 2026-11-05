/**
 * Migration 0003 rebuilds `connections` to drop the provider CHECK. A naive rebuild would cascade-delete
 * every child row (DROP TABLE runs an implicit DELETE with foreign keys on), so this test applies the real
 * migration files to a database that already holds data, the way `wrangler d1 migrations apply` would.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import schema from '../../migrations/0001_init.sql?raw';
import currencySource from '../../migrations/0002_currency_source.sql?raw';
import providerIds from '../../migrations/0003_provider_ids.sql?raw';

const TABLES = ['connections', 'snapshots', 'transactions', 'daily_revenue', 'sync_runs'] as const;

function seededBefore0003(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  db.exec(currencySource);
  db.exec(`
    INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('u1', 'a@example.com', 'x', 1, 1);
    INSERT INTO connections (id, user_id, provider, name, credentials_enc, key_hint, config, test_mode, status,
                             last_synced_at, revenue_cursor, revenue_synced_until, created_at, updated_at)
      VALUES ('c1', 'u1', 'stripe', 'Stripe', 'v1.iv.ct', '…a1b2', '{"x":"1"}', 1, 'ok', 5, 'cur', 6, 1, 2),
             ('c2', 'u1', 'demo', 'Demo', 'v1.iv.ct', NULL, '{}', 0, 'pending', NULL, NULL, NULL, 1, 1);
    INSERT INTO snapshots VALUES ('c1', '2026-11-01', '{"USD":100}', 3, 1, NULL, NULL, NULL, 10),
                                 ('c2', '2026-11-01', '{"EUR":50}', 1, NULL, NULL, NULL, NULL, 10);
    INSERT INTO transactions VALUES ('c1', 'txn_1', 10, 'charge', 100, 'USD', 3, NULL),
                                    ('c1', 'txn_2', 11, 'refund', -40, 'USD', NULL, NULL);
    INSERT INTO daily_revenue VALUES ('c1', '2026-11-01', 'USD', 100, 40, 2, 'transactions');
    INSERT INTO sync_runs (connection_id, kind, started_at, finished_at, ok, events, message)
      VALUES ('c1', 'initial', 1, 2, 1, 2, NULL), ('c1', 'cron', 3, 4, 0, 0, 'Stripe rejected the API key.');
  `);
  return db;
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('migration 0003 (provider CHECK removed)', () => {
  it('keeps every row in connections and its four child tables', () => {
    const db = seededBefore0003();
    const before = Object.fromEntries(TABLES.map((t) => [t, count(db, t)]));
    const connBefore = db.prepare('SELECT * FROM connections ORDER BY id').all();
    db.exec(providerIds);
    const after = Object.fromEntries(TABLES.map((t) => [t, count(db, t)]));
    expect(after).toEqual(before);
    expect(db.prepare('SELECT * FROM connections ORDER BY id').all()).toEqual(connBefore);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('accepts a new provider id, still cascades deletes, and keeps the AUTOINCREMENT high-water mark', () => {
    const db = seededBefore0003();
    db.exec(providerIds);
    db.exec(`INSERT INTO connections (id, user_id, provider, name, credentials_enc, created_at, updated_at)
             VALUES ('c3', 'u1', 'paddle', 'Paddle', 'v1.iv.ct', 1, 1)`);
    db.exec(`INSERT INTO sync_runs (connection_id, kind, started_at) VALUES ('c3', 'initial', 9)`);
    const ids = (db.prepare('SELECT id FROM sync_runs ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toEqual([1, 2, 3]);

    db.exec(`DELETE FROM connections WHERE id = 'c1'`);
    expect(count(db, 'snapshots')).toBe(1);
    expect(count(db, 'transactions')).toBe(0);
    expect(count(db, 'daily_revenue')).toBe(0);
    expect(count(db, 'sync_runs')).toBe(1);

    db.exec(`DELETE FROM users WHERE id = 'u1'`);
    for (const t of TABLES) expect(count(db, t)).toBe(0);
  });

  it('leaves the same indexes and no leftover *_new tables', () => {
    const db = seededBefore0003();
    const indexes = () =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
    const before = indexes();
    db.exec(providerIds);
    expect(indexes()).toEqual(before);
    const leftovers = db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%_new'`).all();
    expect(leftovers).toEqual([]);
  });
});
