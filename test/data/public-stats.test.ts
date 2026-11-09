import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDashboardData, getProductStats } from '../../src/data/dashboard';
import { parsePublicStats, PUBLIC_SERIES_DAYS } from '../../src/data/types';
import { addDays } from '../../src/lib/time';
import type { SessionUser } from '../../src/env';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const TODAY = '2026-11-05';
const owner = { id: 'u1', timeZone: 'UTC' };

let t: TestD1;

function snap(conn: string, day: string, mrr: Record<string, number>, subs: number, warnings: string[] | null = null) {
  t.exec(
    `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period, revenue_period_days, new_customers, captured_at, warnings)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?)`,
    conn, day, JSON.stringify(mrr), subs, warnings ? JSON.stringify(warnings) : null,
  );
}

/** A day's revenue as the engine stores it for a transactions provider: the charge plus the daily row. */
function rev(conn: string, day: string, currency: string, gross: number) {
  t.exec(
    'INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES (?, ?, ?, ?, 0, 1, ?)',
    conn, day, currency, gross, 'transactions',
  );
  t.exec(
    `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
     VALUES (?, ?, ?, 'charge', ?, ?, NULL, 'Pro')`,
    conn, `rev:${day}:${currency}`, Date.parse(`${day}T12:00:00.000Z`), gross, currency,
  );
}

function fx(rates: Record<string, number>, day = '2026-11-04') {
  t.exec('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)', day, 'USD', JSON.stringify(rates), NOW);
}

/** Two months of history on a transactions provider: MRR growing, revenue every few days. */
function seedHistory(conn: string, mrrNow: number, currency = 'USD') {
  for (let i = 60; i >= 0; i -= 5) {
    snap(conn, addDays(TODAY, -i), { [currency]: mrrNow - i * 10 }, 10 + Math.floor((60 - i) / 10));
    rev(conn, addDays(TODAY, -i), currency, 2_000 + i);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  seedUser(t, { id: 'u2' });
});
afterEach(() => vi.useRealTimers());

describe('getProductStats', () => {
  it('is the USD dashboard of the product’s connections, in one round trip', async () => {
    fx({ EUR: 0.9 });
    seedConnection(t, { id: 'stripe-1', userId: 'u1', provider: 'stripe', lastSyncedAt: NOW - 1_000, createdAt: NOW - 120 * 86_400_000 });
    seedConnection(t, { id: 'paddle-1', userId: 'u1', provider: 'paddle', lastSyncedAt: NOW - 5_000, createdAt: NOW - 120 * 86_400_000 });
    seedHistory('stripe-1', 50_000);
    seedHistory('paddle-1', 9_000, 'EUR');

    // The same two connections are all u2's dashboard has.
    seedConnection(t, { id: 'stripe-2', userId: 'u2', provider: 'stripe', createdAt: NOW - 120 * 86_400_000 });
    seedConnection(t, { id: 'paddle-2', userId: 'u2', provider: 'paddle', createdAt: NOW - 120 * 86_400_000 });
    t.exec(`INSERT INTO snapshots SELECT REPLACE(connection_id, '-1', '-2'), day, mrr, active_subscriptions, active_trials,
              revenue_period, revenue_period_days, new_customers, captured_at, mrr_by_product, warnings FROM snapshots`);
    t.exec(`INSERT INTO daily_revenue SELECT REPLACE(connection_id, '-1', '-2'), day, currency, gross, refunds, count, source FROM daily_revenue`);
    t.exec(`INSERT INTO transactions SELECT REPLACE(connection_id, '-1', '-2'), external_id, occurred_at, type, amount, currency, fee, description FROM transactions`);

    // u1 has a third connection outside the product: it must not count.
    seedConnection(t, { id: 'lemon-1', userId: 'u1', provider: 'lemonsqueezy', createdAt: NOW - 120 * 86_400_000 });
    seedHistory('lemon-1', 99_000);

    const before = t.roundTrips();
    const stats = await getProductStats(t.db, owner, new Set(['stripe-1', 'paddle-1']), NOW);
    expect(t.roundTrips() - before).toBe(1);

    const u2: SessionUser = { id: 'u2', email: 'u2@example.com', baseCurrency: 'USD', timeZone: 'UTC' };
    const dash = await getDashboardData(testEnv(t.db), u2, 30);
    expect(stats).not.toBeNull();
    expect(stats!.mrr).toEqual(dash.kpis.mrr);
    expect(stats!.activeSubscriptions).toEqual(dash.kpis.activeSubscriptions);
    expect(stats!.revenue).toEqual(dash.kpis.revenue);
    // EUR MRR converted at the latest rate: 9000 / 0.9 = 10000.
    expect(stats!.mrr.value).toBe(50_000 + 10_000);
    expect(stats!.currency).toBe('USD');

    const dash90 = await getDashboardData(testEnv(t.db), u2, 90);
    const dash364 = await getDashboardData(testEnv(t.db), u2, 364);
    const h = stats!.history;
    expect(h.today).toBe(TODAY);
    // A year of days (the calendar image), ending today; the last 90 are the dashboard's own.
    expect(h.revenueDaily).toHaveLength(PUBLIC_SERIES_DAYS);
    expect(h.revenueDaily[0]!.day).toBe(addDays(TODAY, -(PUBLIC_SERIES_DAYS - 1)));
    expect(h.revenueDaily.slice(-90)).toEqual(dash90.revenueSeries.map((d) => ({ day: d.day, total: d.total })));
    // The weeks are the year's dashboard, and the days added up.
    expect(h.revenueWeekly).toEqual(dash364.revenueSeries.map((d) => ({ day: d.day, to: d.to, total: d.total })));
    expect(h.revenueWeekly.reduce((a, w) => a + w.total, 0)).toBe(h.revenueDaily.reduce((a, d) => a + d.total, 0));
    expect(h.mrrDaily).toEqual(dash364.mrrSeries);
    // Everything held, each EUR day at its rate (only one on file, so that one): 61 days back here.
    let total = 0;
    for (let i = 60; i >= 0; i -= 5) total += 2_000 + i + Math.round((2_000 + i) / 0.9);
    expect(stats!.revenueTotal).toBe(total);
    expect(stats!.revenueSince).toBe(addDays(TODAY, -60));
    // The same total by calendar month, September to November, the first clipped to the history.
    expect(h.revenueMonthly.map((m) => [m.day, m.to])).toEqual([
      ['2026-09-06', '2026-09-30'],
      ['2026-10-01', '2026-10-31'],
      ['2026-11-01', TODAY],
    ]);
    expect(h.revenueMonthly.reduce((a, m) => a + m.total, 0)).toBe(total);
    // MRR at each month's last snapshot, the last being today's.
    expect(h.mrrMonthly.map((m) => m.day)).toEqual(['2026-09-26', '2026-10-31', TODAY]);
    expect(h.mrrMonthly.at(-1)!.total).toBe(stats!.mrr.value);

    expect(stats!.providers.sort()).toEqual(['paddle', 'stripe']);
    expect(stats!.since).toBe(addDays(TODAY, -60));
    expect(stats!.syncedAt).toBe(NOW - 5_000); // the older of the two
    expect(stats!.estimated).toBe(false);
    expect(stats!.revenuePartial).toBe(false);
    expect(stats!.missingFx).toEqual([]);
    expect(parsePublicStats(JSON.stringify(stats))).toEqual(stats);
  });

  it('never counts demo data or a test-mode key, even when asked to', async () => {
    seedConnection(t, { id: 'demo', userId: 'u1', provider: 'demo' });
    seedConnection(t, { id: 'test', userId: 'u1', provider: 'stripe', testMode: true });
    seedConnection(t, { id: 'live', userId: 'u1', provider: 'stripe' });
    snap('demo', TODAY, { USD: 1_000_000 }, 500);
    snap('test', TODAY, { USD: 2_000_000 }, 900);
    snap('live', TODAY, { USD: 12_345 }, 7);

    const stats = await getProductStats(t.db, owner, new Set(['demo', 'test', 'live']), NOW);
    expect(stats!.mrr.value).toBe(12_345);
    expect(stats!.activeSubscriptions.value).toBe(7);
    expect(stats!.providers).toEqual(['stripe']);

    expect(await getProductStats(t.db, owner, new Set(['demo', 'test']), NOW)).toBeNull();
  });

  it('reads only the owner’s connections', async () => {
    seedConnection(t, { id: 'theirs', userId: 'u2', provider: 'stripe' });
    snap('theirs', TODAY, { USD: 50_000 }, 5);
    expect(await getProductStats(t.db, owner, new Set(['theirs']), NOW)).toBeNull();
  });

  it('is null until a connection has a snapshot', async () => {
    seedConnection(t, { id: 'new', userId: 'u1', provider: 'stripe', status: 'pending' });
    expect(await getProductStats(t.db, owner, new Set(['new']), NOW)).toBeNull();
    expect(await getProductStats(t.db, owner, new Set(), NOW)).toBeNull();
  });

  it('says when a figure is estimated, revenue leaves a connection out, or a currency has no rate', async () => {
    seedConnection(t, { id: 'stripe', userId: 'u1', provider: 'stripe' });
    seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat' });
    snap('stripe', TODAY, { USD: 1_000, XYZ: 500 }, 1, ['Coupons are not counted.']);
    snap('rc', TODAY, { USD: 2_000 }, 2); // no daily revenue rows

    const stats = await getProductStats(t.db, owner, new Set(['stripe', 'rc']), NOW);
    expect(stats!.estimated).toBe(true);
    expect(stats!.revenuePartial).toBe(true);
    expect(stats!.missingFx).toEqual(['XYZ']);
    expect(stats!.mrr.value).toBe(3_000);
    expect(stats!.syncedAt).toBeNull();
  });

  it('counts days in the owner’s zone', async () => {
    seedConnection(t, { id: 'stripe', userId: 'u1', provider: 'stripe' });
    const evening = NOW + 6 * 3_600_000; // 18:00 UTC, 03:00 the next day in Tokyo
    snap('stripe', '2026-11-06', { USD: 1_000 }, 1); // tomorrow in UTC, today in Tokyo
    const utc = await getProductStats(t.db, owner, new Set(['stripe']), evening);
    const tokyo = await getProductStats(t.db, { id: 'u1', timeZone: 'Asia/Tokyo' }, new Set(['stripe']), evening);
    expect(utc!.mrr.value).toBe(0); // the dashboard reads snapshots up to today
    expect(tokyo!.mrr.value).toBe(1_000);
    expect(tokyo!.history.today).toBe('2026-11-06');
  });
});

describe('parsePublicStats', () => {
  it('reads only the current shape', () => {
    expect(parsePublicStats(null)).toBeNull();
    expect(parsePublicStats('not json')).toBeNull();
    expect(parsePublicStats(JSON.stringify({ v: 2, currency: 'USD' }))).toBeNull();
    expect(parsePublicStats(JSON.stringify({ v: 1, currency: 'EUR', mrr: {}, revenue: {}, activeSubscriptions: {} }))).toBeNull();
  });
});
