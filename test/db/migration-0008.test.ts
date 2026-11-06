/**
 * Migration 0008 rebuilds `sync_runs` to add 'webhook' to the `kind` CHECK. This applies the real
 * migration files to a database that already holds sync runs, the way `wrangler d1 migrations apply`
 * would, and checks the rebuilt table kept its rows, index, foreign key and CHECK.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import schema from '../../migrations/0001_init.sql?raw';
import currencySource from '../../migrations/0002_currency_source.sql?raw';
import providerIds from '../../migrations/0003_provider_ids.sql?raw';
import emailVerification from '../../migrations/0004_email_verification.sql?raw';
import mrrByProduct from '../../migrations/0005_snapshot_mrr_by_product.sql?raw';
import snapshotWarnings from '../../migrations/0006_snapshot_warnings.sql?raw';
import syncQueue from '../../migrations/0007_sync_queue.sql?raw';
import webhooks from '../../migrations/0008_webhooks.sql?raw';
import { openSyncRun } from '../../src/sync/repo';
import { createTestD1, seedConnection, seedUser } from '../fixtures/d1';

const RUNS = [
  { id: 1, connection_id: 'c1', kind: 'initial', started_at: 1, finished_at: 2, ok: 1, events: 2, message: null },
  { id: 2, connection_id: 'c1', kind: 'cron', started_at: 3, finished_at: 4, ok: 0, events: 0, message: 'Stripe rejected the API key.' },
  { id: 3, connection_id: 'c2', kind: 'manual', started_at: 5, finished_at: null, ok: null, events: 0, message: null },
];

function seededBefore0008(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of [schema, currencySource, providerIds, emailVerification, mrrByProduct, snapshotWarnings, syncQueue]) db.exec(m);
  db.exec(`
    INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('u1', 'a@example.com', 'x', 1, 1);
    INSERT INTO connections (id, user_id, provider, name, credentials_enc, status, created_at, updated_at)
      VALUES ('c1', 'u1', 'stripe', 'Stripe', 'v1.iv.ct', 'ok', 1, 1),
             ('c2', 'u1', 'paddle', 'Paddle', 'v1.iv.ct', 'syncing', 1, 1);
    INSERT INTO sync_runs (connection_id, kind, started_at, finished_at, ok, events, message)
      VALUES ('c1', 'initial', 1, 2, 1, 2, NULL),
             ('c1', 'cron', 3, 4, 0, 0, 'Stripe rejected the API key.'),
             ('c2', 'manual', 5, NULL, NULL, 0, NULL);
  `);
  return db;
}

const runs = (db: DatabaseSync) => db.prepare('SELECT * FROM sync_runs ORDER BY id').all().map((r) => ({ ...r }));

describe('migration 0008 (webhooks, sync_runs rebuilt)', () => {
  it('keeps every sync run, with its id, and every connection', () => {
    const db = seededBefore0008();
    expect(runs(db)).toEqual(RUNS);
    db.exec(webhooks);
    expect(runs(db)).toEqual(RUNS);
    expect(db.prepare('SELECT id, webhook_nonce, webhook_last_at FROM connections ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { id: 'c1', webhook_nonce: null, webhook_last_at: null },
      { id: 'c2', webhook_nonce: null, webhook_last_at: null },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%_new'`).all()).toEqual([]);
  });

  it('restores the index on (connection_id, started_at)', () => {
    const db = seededBefore0008();
    db.exec(webhooks);
    expect({ ...db.prepare(`SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sync_runs_conn'`).get() }).toEqual({
      tbl_name: 'sync_runs',
    });
    expect(db.prepare(`PRAGMA index_info('idx_sync_runs_conn')`).all().map((r) => (r as { name: string }).name)).toEqual([
      'connection_id',
      'started_at',
    ]);
  });

  it('accepts a webhook run, rejects an unknown kind, and still cascades a deleted connection', () => {
    const db = seededBefore0008();
    db.exec(webhooks);
    db.exec(`INSERT INTO sync_runs (connection_id, kind, started_at) VALUES ('c1', 'webhook', 9)`);
    expect(() => db.exec(`INSERT INTO sync_runs (connection_id, kind, started_at) VALUES ('c1', 'bogus', 10)`)).toThrow(/CHECK constraint failed/);
    expect(() => db.exec(`INSERT INTO sync_runs (connection_id, kind, started_at) VALUES ('nope', 'cron', 10)`)).toThrow(/FOREIGN KEY constraint failed/);
    expect(runs(db).map((r) => [r.id, r.kind])).toEqual([[1, 'initial'], [2, 'cron'], [3, 'manual'], [4, 'webhook']]);

    db.exec(`DELETE FROM connections WHERE id = 'c1'`);
    expect(runs(db).map((r) => r.id)).toEqual([3]);
  });

  it('lets the sync engine open a webhook run', async () => {
    const t = createTestD1();
    seedUser(t, { id: 'u1' });
    seedConnection(t, { id: 'c1', userId: 'u1', provider: 'stripe' });
    expect(await openSyncRun(t.db, 'c1', 'webhook', 1_000)).toBe(1);
    expect(t.rows('SELECT id, kind, started_at, finished_at FROM sync_runs')).toEqual([{ id: 1, kind: 'webhook', started_at: 1_000, finished_at: null }]);
  });
});
