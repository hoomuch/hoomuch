/**
 * Regression: on a fresh install the first dashboard render showed a demo at $2,240 MRR, then
 * $4,044 — the snapshot landed before the FX table did, so EUR/GBP couldn't be converted yet.
 * Every path that writes a snapshot must have settled FX first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDashboardData } from '../../src/data/dashboard';
import { runScheduledSync, syncConnection } from '../../src/sync/engine';
import { seedConnection } from '../fixtures/d1';
import { fakeFetch, route } from '../fixtures/harness';
import { fxV2 } from '../fixtures/fx';
import { drainQueue } from '../fixtures/queue';
import { FX_BODY, NOW, setup, teardown, type Ctx } from './helpers';

afterEach(() => teardown());

/** FX answers only after a real delay, so a snapshot written "alongside" it would win the race. */
function slowFx(): void {
  const { fetch } = fakeFetch([
    route('/v2/rates', async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { json: fxV2(FX_BODY) };
    }),
  ]);
  vi.stubGlobal('fetch', fetch);
}

/** Records how many FX rows existed at the moment each snapshot write was committed. */
function watchSnapshotWrites(c: Ctx): number[] {
  const seen: number[] = [];
  const db = c.t.db as unknown as { batch: (s: Array<{ sql: string }>) => Promise<unknown> };
  const original = db.batch.bind(db);
  db.batch = async (stmts) => {
    if (stmts.some((s) => /INSERT INTO snapshots/i.test(s.sql))) {
      seen.push(c.t.rows<{ n: number }>('SELECT COUNT(*) AS n FROM fx_rates')[0]!.n);
    }
    return original(stmts);
  };
  return seen;
}

function seedDemo(c: Ctx): void {
  seedConnection(c.t, {
    id: 'demo',
    userId: c.userId,
    provider: 'demo',
    status: 'pending',
    config: { seed: 'fx-order', anchor: '2026-11-05' },
    createdAt: NOW,
  });
}

describe('FX is loaded before the first snapshot is visible', () => {
  it('initial sync: the snapshot is written only after the FX table exists', async () => {
    const c = setup();
    slowFx();
    seedDemo(c);
    const seen = watchSnapshotWrites(c);

    const r = await syncConnection(c.env, 'demo', 'initial');
    expect(r.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n > 0)).toBe(true);

    const d = await getDashboardData(c.env, { id: c.userId, email: 'u@example.com', baseCurrency: 'USD' }, 30);
    expect(d.fx.missing).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it('cron on a fresh install: FX is settled before any connection syncs', async () => {
    const c = setup();
    slowFx();
    seedDemo(c);
    const seen = watchSnapshotWrites(c);

    await runScheduledSync(c.env, NOW);
    await drainQueue(c.env); // the cron settles FX before it queues anything
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n > 0)).toBe(true);
  });

  it('an FX outage still lets the sync finish (rates are best effort)', async () => {
    const c = setup();
    vi.stubGlobal('fetch', fakeFetch([route('/v2/rates', { status: 503, json: {} })]).fetch);
    seedDemo(c);
    const r = await syncConnection(c.env, 'demo', 'initial');
    expect(r.ok).toBe(true);
    expect(c.t.rows('SELECT * FROM snapshots WHERE connection_id = ?', 'demo').length).toBeGreaterThan(0);
  });
});
