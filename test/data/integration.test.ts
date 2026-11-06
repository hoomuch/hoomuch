/**
 * End-to-end through the real pipeline in Node: demo connection → syncConnection → D1 → read models.
 * This is the SPEC "Definition of Done" path ("adds a demo connection and the dashboard fills").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fxV2 } from '../fixtures/fx';
import { syncConnection } from '../../src/sync/engine';
import { getDashboardData } from '../../src/data/dashboard';
import { listTransactions } from '../../src/data/transactions';
import { getConnectionDetail } from '../../src/data/connections';
import { encryptJson } from '../../src/lib/crypto';
import type { SessionUser } from '../../src/env';
import { createTestD1, seedConnection, seedUser, testEnv, TEST_ENCRYPTION_KEY, type TestD1 } from '../fixtures/d1';
import { fakeFetch, route } from '../fixtures/harness';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const user: SessionUser = { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD', timeZone: 'UTC' };
let t: TestD1;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const { fetch } = fakeFetch([
    route('/v2/rates', { json: fxV2({ date: '2026-11-04', rates: { EUR: 0.9, GBP: 0.8, JPY: 150 } }) }),
  ]);
  vi.stubGlobal('fetch', fetch);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  seedConnection(t, {
    id: 'demo1',
    userId: 'u1',
    provider: 'demo',
    name: 'Demo',
    status: 'pending',
    credentialsEnc: await encryptJson(TEST_ENCRYPTION_KEY, {}),
    config: { seed: 'integration', anchor: '2026-11-05' },
    createdAt: NOW,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('demo connection end to end', () => {
  it('fills the dashboard, transactions and connection detail after one sync', async () => {
    const env = testEnv(t.db);
    const r = await syncConnection(env, 'demo1', 'initial');
    expect(r).toMatchObject({ ok: true, snapshot: true, done: true, error: null });
    expect(r.events).toBeGreaterThan(500);

    const d90 = await getDashboardData(env, user, 90);
    expect(d90.hasConnections).toBe(true);
    expect(d90.kpis.mrr.value).toBeGreaterThan(0);
    expect(d90.kpis.mrr.deltaPct).not.toBeNull();
    expect(d90.kpis.mrr.deltaPct!).toBeGreaterThan(0); // slow growth
    expect(d90.mrrSeries).toHaveLength(90);
    expect(d90.revenueSeries).toHaveLength(90);
    expect(d90.revenueSeries.filter((x) => x.total !== 0).length).toBeGreaterThan(80);
    expect(d90.kpis.revenue.previous).toBeNull(); // nothing before the 90-day backfill
    expect(d90.fx).toEqual({ asOf: '2026-11-04', daily: true, missing: [] });
    expect(d90.warnings).toEqual([]);

    const d30 = await getDashboardData(env, user, 30);
    expect(d30.kpis.revenue.previous).not.toBeNull();
    expect(d30.revenueSeries).toHaveLength(30);
    // MRR ≈ revenue run-rate: 30 days of charges within ±25 % of MRR.
    expect(d30.kpis.revenue.value / d30.kpis.mrr.value).toBeGreaterThan(0.75);
    expect(d30.kpis.revenue.value / d30.kpis.mrr.value).toBeLessThan(1.25);

    const tx = await listTransactions(env, user, { provider: 'demo', page: 1 });
    expect(tx.items).toHaveLength(50);
    expect(tx.hasMore).toBe(true);
    expect(tx.items.every((i) => i.displayAmount !== null)).toBe(true);

    const detail = await getConnectionDetail(env, user, 'demo1');
    expect(detail!.status).toBe('ok');
    expect(detail!.snapshots).toHaveLength(30);
    expect(detail!.recentRuns[0]).toMatchObject({ kind: 'initial', ok: true });

    // A second sync is idempotent for the read model.
    vi.setSystemTime(NOW + 60 * 60_000);
    const again = await syncConnection(env, 'demo1', 'cron');
    expect(again.ok).toBe(true);
    const d30b = await getDashboardData(env, user, 30);
    expect(d30b.kpis.mrr.value).toBe(d30.kpis.mrr.value);
    expect(d30b.kpis.revenue.value).toBeGreaterThanOrEqual(d30.kpis.revenue.value);
    expect(t.rows<{ n: number }>('SELECT COUNT(*) AS n FROM snapshots')[0]!.n).toBe(91);
  });
});
