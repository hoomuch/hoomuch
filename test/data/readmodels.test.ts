import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDashboardData, kpi, PRODUCT_ROWS } from '../../src/data/dashboard';
import { recomputeDailyRevenue, upsertSnapshot } from '../../src/sync/repo';
import { cleanSnapshot } from '../../src/sync/aggregate';
import { STRIPE_PRODUCTS_WARNING } from '../../src/providers/stripe';
import { listTransactions } from '../../src/data/transactions';
import { getConnectionDetail, listConnectionSummaries } from '../../src/data/connections';
import { addDays } from '../../src/lib/time';
import type { SessionUser } from '../../src/env';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const TODAY = '2026-11-05';
const user: SessionUser = { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD' };

let t: TestD1;

function snap(conn: string, day: string, mrr: Record<string, number>, subs: number, trials: number | null = null, extra: { revenuePeriod?: Record<string, number>; days?: number } = {}) {
  t.exec(
    `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period, revenue_period_days, new_customers, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    conn, day, JSON.stringify(mrr), subs, trials, extra.revenuePeriod ? JSON.stringify(extra.revenuePeriod) : null, extra.days ?? null,
  );
}

function rev(conn: string, day: string, currency: string, gross: number, refunds = 0, source: 'transactions' | 'provider' = 'transactions') {
  t.exec(
    'INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES (?, ?, ?, ?, ?, 1, ?)',
    conn, day, currency, gross, refunds, source,
  );
}

function fx(rates: Record<string, number>, day = '2026-11-04') {
  t.exec('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)', day, 'USD', JSON.stringify(rates), NOW);
}

function tx(conn: string, id: string, at: number, amount: number, currency = 'USD', description: string | null = 'Pro') {
  t.exec(
    `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    conn, id, at, amount < 0 ? 'refund' : 'charge', amount, currency, description,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  seedUser(t, { id: 'u2' });
});
afterEach(() => vi.useRealTimers());

describe('kpi', () => {
  it('has no delta without a usable previous value, and measures a change from a loss against its size', () => {
    expect(kpi(500, null)).toEqual({ value: 500, previous: null, deltaPct: null });
    expect(kpi(500, 0)).toEqual({ value: 500, previous: 0, deltaPct: null }); // not Infinity
    expect(kpi(150, 100).deltaPct).toBeCloseTo(50, 10);
    expect(kpi(50, 100).deltaPct).toBeCloseTo(-50, 10);
    // Net revenue can be negative (a refund-heavy period): −100 → +100 is an improvement, not −200 %.
    expect(kpi(100, -100).deltaPct).toBeCloseTo(200, 10);
    expect(kpi(-200, -100).deltaPct).toBeCloseTo(-100, 10);
  });
});

describe('getDashboardData', () => {
  it('returns a valid empty state in one round trip', async () => {
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(t.roundTrips()).toBe(1);
    expect(d.hasConnections).toBe(false);
    expect(d.revenueSeries.map((r) => r.day)).toEqual([
      '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
    ]);
    expect(d.revenueSeries.every((r) => r.total === 0)).toBe(true);
    expect(d.kpis.mrr).toEqual({ value: 0, previous: null, deltaPct: null });
    expect(d.kpis.revenue.previous).toBeNull();
    expect(d.fx).toEqual({ asOf: null, missing: [] });
    expect(d.warnings).toEqual([]);
  });

  it('converts MRR into the display currency, sorts the breakdown and computes shares and deltas', async () => {
    fx({ EUR: 0.9, GBP: 0.8 });
    seedConnection(t, { id: 'stripe1', userId: 'u1', provider: 'stripe', name: 'Acme', createdAt: 1 });
    seedConnection(t, { id: 'ls1', userId: 'u1', provider: 'lemonsqueezy', name: 'Shop', createdAt: 2 });
    // window = 2026-10-07 … 2026-11-05 (30 days)
    snap('stripe1', '2026-10-01', { USD: 100_00 }, 10, 2); // 6 days before start
    snap('stripe1', '2026-10-10', { USD: 110_00 }, 11, 2); // 3 days after start → nearest
    snap('stripe1', TODAY, { USD: 150_00, EUR: 90_00 }, 16, 3);
    snap('ls1', '2026-10-06', { EUR: 450_00 }, 30, null); // 1 day before start → nearest
    snap('ls1', TODAY, { EUR: 540_00 }, 36, null);

    const d = await getDashboardData(testEnv(t.db), user, 30);
    expect(t.roundTrips()).toBe(1);
    // stripe: 150 + 90€→100 = 250 USD; ls: 540€ → 600 USD
    expect(d.kpis.mrr.value).toBe(850_00);
    expect(d.kpis.arr.value).toBe(850_00 * 12);
    // previous: stripe 2026-10-10 (110) + ls 2026-10-06 (450€ → 500) = 610
    expect(d.kpis.mrr.previous).toBe(610_00);
    expect(d.kpis.mrr.deltaPct).toBeCloseTo(((850 - 610) / 610) * 100, 6);
    expect(d.kpis.arr.previous).toBe(610_00 * 12);
    expect(d.kpis.activeSubscriptions).toMatchObject({ value: 52, previous: 41 });
    expect(d.kpis.activeTrials).toMatchObject({ value: 3, previous: 2 });
    expect(d.breakdown.map((b) => [b.id, b.mrr, b.sharePct])).toEqual([
      ['ls1', 600_00, 70.6],
      ['stripe1', 250_00, 29.4],
    ]);
    expect(d.breakdown[0]).toMatchObject({ provider: 'lemonsqueezy', color: '#AD7D00', status: 'ok', activeTrials: null });
    expect(d.fx).toEqual({ asOf: '2026-11-04', missing: [] });
    // MRR series: only days with snapshots, other connections carried forward.
    expect(d.mrrSeries).toEqual([
      { day: '2026-10-10', total: 110_00 + 500_00 },
      { day: TODAY, total: 850_00 },
    ]);
  });

  it('reports a null delta when no connection has an earlier snapshot to compare with', async () => {
    seedConnection(t, { id: 's1', userId: 'u1', provider: 'stripe' });
    snap('s1', TODAY, { USD: 500 }, 1);
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.kpis.mrr).toEqual({ value: 500, previous: null, deltaPct: null });
    expect(d.mrrSeries).toEqual([{ day: TODAY, total: 500 }]);
  });

  it('builds a zero-filled revenue series and compares revenue with the previous window', async () => {
    fx({ EUR: 0.5 });
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe', name: 'A' });
    seedConnection(t, { id: 'b', userId: 'u1', provider: 'demo', name: 'B' });
    rev('a', TODAY, 'USD', 10_00);
    rev('a', '2026-11-03', 'USD', 5_00, 2_00);
    rev('b', '2026-11-03', 'EUR', 5_00); // → 10 USD
    rev('a', '2026-10-30', 'USD', 1_00); // first day of the 7-day window
    rev('a', '2026-10-29', 'USD', 4_00); // previous window
    rev('a', '2026-10-22', 'USD', 4_00); // previous window starts 2026-10-23 → excluded
    rev('a', '2026-11-06', 'USD', 99_00); // future, excluded

    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.revenueSeries).toHaveLength(7);
    expect(d.revenueSeries[0]).toEqual({ day: '2026-10-30', total: 1_00, byConnection: { a: 1_00 } });
    expect(d.revenueSeries[1]).toEqual({ day: '2026-10-31', total: 0, byConnection: {} });
    expect(d.revenueSeries[4]).toEqual({ day: '2026-11-03', total: 13_00, byConnection: { a: 3_00, b: 10_00 } });
    expect(d.revenueSeries[6]).toEqual({ day: TODAY, total: 10_00, byConnection: { a: 10_00 } });
    expect(d.kpis.revenue.value).toBe(24_00);
    expect(d.kpis.revenue.previous).toBe(4_00);
    expect(d.kpis.revenue.deltaPct).toBeCloseTo(500, 6);
    expect(d.breakdown.find((b) => b.id === 'a')!.revenue).toBe(14_00);
    expect(d.breakdown.find((b) => b.id === 'b')!.revenue).toBe(10_00);
    expect(d.revenueSeries.reduce((s, r) => s + r.total, 0)).toBe(d.kpis.revenue.value);
  });

  it('reports RevenueCat without daily history as a period total and leaves it out of revenue totals', async () => {
    seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat', name: 'Main app' });
    t.exec('UPDATE connections SET revenue_synced_until = ? WHERE id = ?', NOW, 'rc');
    snap('rc', TODAY, { USD: 300_00 }, 40, 5, { revenuePeriod: { USD: 1234_00 }, days: 28 });
    seedConnection(t, { id: 'rc2', userId: 'u1', provider: 'revenuecat', name: 'Other app' });
    snap('rc2', TODAY, { USD: 100_00 }, 10, 1);
    rev('rc2', TODAY, 'USD', 7_00, 0, 'provider');

    const d = await getDashboardData(testEnv(t.db), user, 30);
    const rc = d.breakdown.find((b) => b.id === 'rc')!;
    expect(rc.revenue).toBeNull();
    expect(d.breakdown.find((b) => b.id === 'rc2')!.revenue).toBe(7_00);
    expect(d.kpis.revenue.value).toBe(7_00);
    expect(rc.periodRevenue).toEqual({ amount: 1234_00, days: 28 });
    expect(d.breakdown.find((b) => b.id === 'rc2')!.periodRevenue).toBeNull();
    expect(d.warnings).toEqual([]);
  });

  it('does not report missing RevenueCat history before the first revenue sync finished', async () => {
    seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat', name: 'Main app', status: 'pending' });
    const d = await getDashboardData(testEnv(t.db), user, 30);
    expect(d.breakdown[0]!.revenue).toBeNull();
    expect(d.breakdown[0]!.periodRevenue).toBeNull(); // not "no history" yet, just not synced
    expect(d.breakdown[0]).toMatchObject({ status: 'pending', lastSyncedAt: null });
    expect(d.warnings).toEqual([]);
  });

  it('surfaces connections in error without breaking the rest', async () => {
    seedConnection(t, { id: 'ok', userId: 'u1', provider: 'stripe', name: 'Good' });
    seedConnection(t, { id: 'bad', userId: 'u1', provider: 'lemonsqueezy', name: 'Broken', status: 'error', lastError: 'Lemon Squeezy rejected the API key.' });
    snap('ok', TODAY, { USD: 1000 }, 1);
    snap('bad', '2026-11-01', { USD: 500 }, 1); // last known value still counts
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.kpis.mrr.value).toBe(1500);
    expect(d.warnings).toEqual([]); // the row carries it; the dashboard says it
    expect(d.breakdown.find((b) => b.id === 'bad')).toMatchObject({ status: 'error', lastError: 'Lemon Squeezy rejected the API key.' });
  });

  it('leaves out and reports currencies without an FX rate', async () => {
    fx({ EUR: 0.9 });
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe' });
    snap('a', TODAY, { USD: 1000, XAF: 5000 }, 2);
    rev('a', TODAY, 'XAF', 700);
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.kpis.mrr.value).toBe(1000);
    expect(d.fx.missing).toEqual(['XAF']);
    expect(d.fx.asOf).toBeNull(); // nothing was actually converted
    expect(d.warnings).toEqual([]); // reported through fx.missing
  });

  it('without any FX table only the display currency counts', async () => {
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe' });
    snap('a', TODAY, { USD: 1000, EUR: 900 }, 2);
    const d = await getDashboardData(testEnv(t.db), { ...user, baseCurrency: 'EUR' }, 7);
    expect(d.currency).toBe('EUR');
    expect(d.kpis.mrr.value).toBe(900);
    expect(d.fx.missing).toEqual(['USD']);
    expect(d.warnings).toEqual([]);
  });

  it('converts JPY (zero-decimal) correctly into the display currency', async () => {
    fx({ JPY: 150 });
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe' });
    snap('a', TODAY, { JPY: 15000 }, 1);
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.kpis.mrr.value).toBe(100_00);
  });

  it("never includes another user’s data", async () => {
    seedConnection(t, { id: 'mine', userId: 'u1', provider: 'stripe' });
    seedConnection(t, { id: 'theirs', userId: 'u2', provider: 'stripe' });
    snap('theirs', TODAY, { USD: 999_00 }, 9);
    rev('theirs', TODAY, 'USD', 999_00);
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.breakdown.map((b) => b.id)).toEqual(['mine']);
    expect(d.kpis.mrr.value).toBe(0);
    expect(d.kpis.revenue.value).toBe(0);
  });

  it('only compares revenue with a previous window the backfill fully covers', async () => {
    // Connected 10 days ago → history reaches back to day −99; a 30-day window's previous
    // period starts at day −59 (covered), a 90-day window's at day −179 (not covered).
    const created = NOW - 10 * 86_400_000;
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe', createdAt: created });
    t.exec('UPDATE connections SET revenue_synced_until = ? WHERE id = ?', NOW, 'a');
    rev('a', addDays(TODAY, -40), 'USD', 300);
    rev('a', TODAY, 'USD', 600);
    expect((await getDashboardData(testEnv(t.db), user, 30)).kpis.revenue).toMatchObject({ value: 600, previous: 300, deltaPct: 100 });
    expect((await getDashboardData(testEnv(t.db), user, 90)).kpis.revenue).toMatchObject({ value: 900, previous: null });

    // A connection added today also backfills 90 days, so the 30-day comparison stays valid…
    seedConnection(t, { id: 'b', userId: 'u1', provider: 'demo', createdAt: NOW - 1000 });
    rev('b', TODAY, 'USD', 10);
    expect((await getDashboardData(testEnv(t.db), user, 30)).kpis.revenue).toMatchObject({ value: 610, previous: 300 });
    // …while a's history (back to day −99) still doesn't reach a 90-day window's previous period (day −179).
    expect((await getDashboardData(testEnv(t.db), user, 90)).kpis.revenue.previous).toBeNull();
    // Connections that never finished a revenue sync and have no rows don't block the comparison.
    seedConnection(t, { id: 'c', userId: 'u1', provider: 'stripe', createdAt: NOW, status: 'pending' });
    expect((await getDashboardData(testEnv(t.db), user, 30)).kpis.revenue.previous).toBe(300);
  });

  it('handles a 90-day window', async () => {
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe' });
    rev('a', addDays(TODAY, -89), 'USD', 100);
    rev('a', addDays(TODAY, -90), 'USD', 50);
    const d = await getDashboardData(testEnv(t.db), user, 90);
    expect(d.revenueSeries).toHaveLength(90);
    expect(d.revenueSeries[0]!.total).toBe(100);
    expect(d.kpis.revenue).toMatchObject({ value: 100, previous: 50 });
  });
});

describe('getDashboardData products', () => {
  const at = (day: string, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  /** Rebuilds daily_revenue from transactions, as a sync does, so the KPI and the split share a source. */
  async function aggregate(...connectionIds: string[]) {
    for (const id of connectionIds) {
      await t.db.batch(recomputeDailyRevenue(t.db, id, { from: addDays(TODAY, -100), to: TODAY }));
    }
  }

  it('splits revenue by product per connection, puts the rest under no product name, and adds up to the KPI', async () => {
    fx({ EUR: 0.5 });
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Pagekit' });
    seedConnection(t, { id: 'demo', userId: 'u1', provider: 'demo', name: 'Demo' });
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat', name: 'App' });
    tx('ls', 'p1', at(TODAY), 20_00, 'USD', 'Pro');
    tx('ls', 'p2', at('2026-11-03'), 20_00, 'USD', 'Pro');
    tx('ls', 'p3', at('2026-11-03', 15), -5_00, 'USD', 'Pro'); // refund
    tx('ls', 't1', at('2026-11-02'), 10_00, 'EUR', 'Team'); // → 20 USD
    tx('ls', 'o1', Date.parse('2026-10-30T00:00:00.000Z'), 1_00, 'USD', 'Old'); // first instant of the 7-day window
    tx('ls', 'o2', Date.parse('2026-10-29T23:59:59.999Z'), 99_00, 'USD', 'Old'); // the day before: left out
    tx('ls', 'n1', at('2026-11-01'), 3_00, 'USD', null); // a charge without a name
    tx('ls', 'n2', at('2026-11-01'), 1_00, 'USD', '   '); // blank counts as no name
    tx('demo', 'd1', at(TODAY), 7_00, 'USD', 'Pro'); // same name, other connection: its own row
    tx('st', 's1', at(TODAY), 50_00, 'USD', null);
    rev('rc', TODAY, 'USD', 30_00, 0, 'provider');
    await aggregate('ls', 'demo', 'st');

    const roundTrips = t.roundTrips();
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(t.roundTrips() - roundTrips).toBe(1);
    const p = d.products;
    expect(p.rows.map((r) => [r.name, r.connectionName, r.revenue, r.charges])).toEqual([
      ['Pro', 'Pagekit', 35_00, 2],
      ['Team', 'Pagekit', 20_00, 1],
      ['Pro', 'Demo', 7_00, 1],
      ['Old', 'Pagekit', 1_00, 1],
    ]);
    expect(p.rows[0]).toMatchObject({ connectionId: 'ls', dotClass: expect.stringMatching(/^bg-\[#/) });
    expect(p.more).toBeNull();
    // 4 without a name from Lemon Squeezy, Stripe's 50, RevenueCat's 30 (daily totals).
    expect(p.unnamed.revenue).toBe(84_00);
    expect(p.unnamedProviders).toEqual(['Stripe', 'RevenueCat']); // biggest first; Lemon Squeezy names products
    expect(p.named).toBe(true);
    const total = p.rows.reduce((s, r) => s + r.revenue, 0) + p.unnamed.revenue;
    expect(total).toBe(d.kpis.revenue.value);
    expect(p.rows[0]!.sharePct).toBe(23.8); // 35 of 147
    expect(p.unnamed.sharePct).toBe(57.1);
  });

  it('gives a product that lost money no share and lists it last', async () => {
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Pagekit' });
    tx('ls', 'a', at(TODAY), 10_00, 'USD', 'Pro');
    tx('ls', 'b', at(TODAY), -4_00, 'USD', 'Legacy');
    await aggregate('ls');
    const p = (await getDashboardData(testEnv(t.db), user, 7)).products;
    expect(p.rows.map((r) => [r.name, r.revenue, r.charges, r.sharePct])).toEqual([
      ['Pro', 10_00, 1, 100],
      ['Legacy', -4_00, 0, 0],
    ]);
    expect(p.unnamed).toEqual({ revenue: 0, sharePct: 0 });
    expect(p.unnamedProviders).toEqual([]);
  });

  it(`shows ${PRODUCT_ROWS + 1} products in full, and folds anything past ${PRODUCT_ROWS} into one row`, async () => {
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Pagekit' });
    for (let i = 1; i <= PRODUCT_ROWS + 1; i++) tx('ls', `x${i}`, at(TODAY), i * 100, 'USD', `Plan ${i}`);
    await aggregate('ls');
    let p = (await getDashboardData(testEnv(t.db), user, 7)).products;
    expect(p.rows).toHaveLength(PRODUCT_ROWS + 1); // never "1 more product"
    expect(p.more).toBeNull();

    tx('ls', 'y1', at(TODAY), 50, 'USD', 'Tiny A');
    tx('ls', 'y2', at(TODAY), 40, 'USD', 'Tiny B');
    await aggregate('ls');
    p = (await getDashboardData(testEnv(t.db), user, 7)).products;
    expect(p.rows).toHaveLength(PRODUCT_ROWS);
    expect(p.rows[0]!.name).toBe(`Plan ${PRODUCT_ROWS + 1}`);
    expect(p.more).toMatchObject({ count: 3, revenue: 100 + 50 + 40, charges: 3 });
  });

  it('has nothing to split when no provider reports product names', async () => {
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    tx('st', 's1', at(TODAY), 50_00, 'USD', null);
    await aggregate('st');
    const p = (await getDashboardData(testEnv(t.db), user, 7)).products;
    expect(p).toEqual({ rows: [], more: null, unnamed: { revenue: 50_00, sharePct: 100 }, unnamedProviders: ['Stripe'], named: false });
  });

  it('ignores names on a provider that reports daily totals, and another user’s products', async () => {
    seedConnection(t, { id: 'mine', userId: 'u1', provider: 'demo', name: 'Mine' });
    seedConnection(t, { id: 'theirs', userId: 'u2', provider: 'demo', name: 'Theirs' });
    seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat', name: 'App' });
    tx('mine', 'a', at(TODAY), 5_00, 'USD', 'Pro');
    tx('theirs', 'b', at(TODAY), 999_00, 'USD', 'Secret');
    // A daily-totals provider never stores transactions; if one did, its revenue comes from daily_revenue only.
    tx('rc', 'c', at(TODAY), 8_00, 'USD', 'Should not count');
    rev('rc', TODAY, 'USD', 8_00, 0, 'provider');
    await aggregate('mine', 'theirs');
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.products.rows.map((r) => r.name)).toEqual(['Pro']);
    expect(d.products.unnamed.revenue).toBe(8_00);
    expect(d.products.rows[0]!.revenue + d.products.unnamed.revenue).toBe(d.kpis.revenue.value);
  });
});

describe('getDashboardData MRR by product', () => {
  type Split = Array<{ name: string | null; mrr: Record<string, number>; subscriptions: number }> | null;
  function snapSplit(conn: string, day: string, mrr: Record<string, number>, split: Split, warnings: string[] | null = null) {
    t.exec(
      `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, mrr_by_product, warnings, captured_at)
       VALUES (?, ?, ?, 1, NULL, ?, ?, 0)`,
      conn, day, JSON.stringify(mrr), split === null ? null : JSON.stringify(split), warnings ? JSON.stringify(warnings) : null,
    );
  }

  it('splits the latest MRR by product per connection, the rest under no product name, adding up to the KPI', async () => {
    fx({ EUR: 0.5 }); // 1 EUR = 2 USD
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    seedConnection(t, { id: 'st2', userId: 'u1', provider: 'stripe', name: 'Acme EU' });
    seedConnection(t, { id: 'st3', userId: 'u1', provider: 'stripe', name: 'Dormant' });
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Pagekit' });
    seedConnection(t, { id: 'x', userId: 'u2', provider: 'stripe', name: 'Theirs' });
    snapSplit('st', '2026-11-01', { USD: 10_00 }, [{ name: 'Old plan', mrr: { USD: 10_00 }, subscriptions: 1 }]); // not the latest
    snapSplit('st', TODAY, { USD: 100_00, EUR: 10_00 }, [
      { name: 'Pro', mrr: { USD: 60_00, EUR: 10_00 }, subscriptions: 5 },
      { name: 'Team', mrr: { USD: 30_00 }, subscriptions: 2 },
      { name: null, mrr: { USD: 10_00 }, subscriptions: 1 },
    ]);
    snapSplit('st2', TODAY, { USD: 40_00 }, null, [STRIPE_PRODUCTS_WARNING]); // its key can't read product names
    snapSplit('st3', TODAY, {}, null, [STRIPE_PRODUCTS_WARNING]); // no MRR: nothing to ask for
    snapSplit('ls', TODAY, { USD: 50_00 }, null); // Lemon Squeezy doesn't split MRR
    snapSplit('x', TODAY, { USD: 999_00 }, [{ name: 'Secret', mrr: { USD: 999_00 }, subscriptions: 9 }]);

    const roundTrips = t.roundTrips();
    const d = await getDashboardData(testEnv(t.db), user, 30);
    expect(t.roundTrips() - roundTrips).toBe(1);
    const m = d.productMrr;
    expect(m.split).toBe(true);
    expect(m.rows.map((r) => [r.name, r.connectionName, r.mrr, r.subscriptions, r.sharePct])).toEqual([
      ['Pro', 'Acme', 80_00, 5, 38.1],
      ['Team', 'Acme', 30_00, 2, 14.3],
    ]);
    expect(m.rows[0]).toMatchObject({ connectionId: 'st', dotClass: 'bg-[#635BFF]' });
    // Acme's unnamed 10, Acme EU's 40, Pagekit's 50.
    expect(m.unnamed).toEqual({ mrr: 100_00, sharePct: 47.6 });
    expect(m.rows.reduce((s, r) => s + r.mrr, 0) + m.unnamed.mrr).toBe(d.kpis.mrr.value);
    expect(m.needsPermission).toEqual(['Acme EU']);
    expect(m.unnamedProviders).toEqual(['Lemon Squeezy']);
    expect(m.more).toBeNull();
    // The Products: Read warning is the By product card's to say, not a dashboard note.
    expect(d.warnings).toEqual([]);
  });

  it('a split missing for another reason (no Products warning) is plain unnamed MRR, not a permission ask', async () => {
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    seedConnection(t, { id: 'as', userId: 'u1', provider: 'appstore', name: 'iOS' });
    snapSplit('st', TODAY, { USD: 40_00 }, null, ['Product names were skipped this sync.']);
    snapSplit('as', TODAY, { USD: 10_00 }, null);
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.productMrr).toMatchObject({ needsPermission: [], unnamedProviders: ['Stripe', 'App Store Connect'] });
    expect(d.warnings).toEqual(['Acme: Product names were skipped this sync.']);
  });

  it(`merges one name within a connection and folds products past ${PRODUCT_ROWS} into one row`, async () => {
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    const split = Array.from({ length: PRODUCT_ROWS + 2 }, (_, i) => ({ name: `Plan ${i + 1}`, mrr: { USD: (i + 1) * 100 }, subscriptions: 1 }));
    split.push({ name: 'Plan 1', mrr: { USD: 5_000 }, subscriptions: 2 }); // archived product, same name
    snapSplit('st', TODAY, { USD: split.reduce((s, p) => s + p.mrr.USD, 0) }, split);
    const m = (await getDashboardData(testEnv(t.db), user, 7)).productMrr;
    expect(m.rows).toHaveLength(PRODUCT_ROWS);
    expect(m.rows[0]).toMatchObject({ name: 'Plan 1', mrr: 5_100, subscriptions: 3 });
    expect(m.more).toMatchObject({ count: 2, mrr: 200 + 300, subscriptions: 2 });
    expect(m.unnamed.mrr).toBe(0);
  });

  it('has nothing to split when no snapshot carries a split', async () => {
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Pagekit' });
    snap('ls', TODAY, { USD: 50_00 }, 3);
    const m = (await getDashboardData(testEnv(t.db), user, 7)).productMrr;
    expect(m).toMatchObject({ split: false, rows: [], unnamed: { mrr: 50_00 }, needsPermission: [], unnamedProviders: ['Lemon Squeezy'] });
  });

  it('stores the split with the snapshot, and a later snapshot without one clears it', async () => {
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    const raw = {
      mrr: { USD: 30_00 },
      activeSubscriptions: 2,
      activeTrials: 0,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      mrrByProduct: [{ name: 'Pro', mrr: { USD: 30_00 }, subscriptions: 2 }],
    };
    await t.db.batch([upsertSnapshot(t.db, 'st', TODAY, cleanSnapshot(raw).snapshot, NOW)]);
    expect((await getDashboardData(testEnv(t.db), user, 7)).productMrr.rows.map((r) => [r.name, r.mrr])).toEqual([['Pro', 30_00]]);

    await t.db.batch([
      upsertSnapshot(t.db, 'st', TODAY, cleanSnapshot({ ...raw, mrrByProduct: null, warnings: [STRIPE_PRODUCTS_WARNING] }).snapshot, NOW),
    ]);
    expect(t.rows('SELECT mrr_by_product FROM snapshots')).toEqual([{ mrr_by_product: null }]);
    expect((await getDashboardData(testEnv(t.db), user, 7)).productMrr).toMatchObject({ split: false, needsPermission: ['Acme'] });
  });
});

describe('listTransactions', () => {
  beforeEach(() => {
    fx({ EUR: 0.5 });
    seedConnection(t, { id: 's', userId: 'u1', provider: 'stripe', name: 'Acme' });
    seedConnection(t, { id: 'l', userId: 'u1', provider: 'lemonsqueezy', name: 'Shop' });
    seedConnection(t, { id: 'x', userId: 'u2', provider: 'stripe', name: 'Theirs' });
    tx('s', 'txn_1', NOW - 1000, 12_00);
    tx('s', 'txn_2', NOW - 2000, -12_00);
    tx('l', 'order:1', NOW - 3000, 10_00, 'EUR', 'Pro (yearly)');
    tx('l', 'order:2', NOW - 4000, 10_00, 'XAF');
    tx('x', 'txn_9', NOW, 1_00);
  });

  it('lists the newest first with converted display amounts, scoped to the user', async () => {
    const p = await listTransactions(testEnv(t.db), user, { provider: null, page: 1 });
    expect(t.roundTrips()).toBe(1);
    expect(p.items.map((i) => i.externalId)).toEqual(['txn_1', 'txn_2', 'order:1', 'order:2']);
    expect(p.items[1]).toMatchObject({ type: 'refund', amount: -12_00, displayAmount: -12_00, connectionName: 'Acme', color: '#635BFF' });
    expect(p.items[2]).toMatchObject({ amount: 10_00, originalCurrency: 'EUR', displayAmount: 20_00, description: 'Pro (yearly)' });
    expect(p.items[3]!.displayAmount).toBeNull();
    expect(p).toMatchObject({ currency: 'USD', provider: null, page: 1, pageSize: 50, hasMore: false });
  });

  it('filters by provider and paginates', async () => {
    const p1 = await listTransactions(testEnv(t.db), user, { provider: 'stripe', page: 1, pageSize: 1 });
    expect(p1.items.map((i) => i.externalId)).toEqual(['txn_1']);
    expect(p1.hasMore).toBe(true);
    const p2 = await listTransactions(testEnv(t.db), user, { provider: 'stripe', page: 2, pageSize: 1 });
    expect(p2.items.map((i) => i.externalId)).toEqual(['txn_2']);
    expect(p2.hasMore).toBe(false);
    const p3 = await listTransactions(testEnv(t.db), user, { provider: 'stripe', page: 3, pageSize: 1 });
    expect(p3.items).toEqual([]);
  });

  it('clamps bad paging input', async () => {
    const p = await listTransactions(testEnv(t.db), user, { provider: null, page: -4, pageSize: 10_000 });
    expect(p.page).toBe(1);
    expect(p.pageSize).toBe(200);
    const q = await listTransactions(testEnv(t.db), user, { provider: null, page: Number.NaN });
    expect(q.page).toBe(1);
  });
});

describe('connection read models', () => {
  it('returns detail with converted snapshots (latest first, ≤30) and runs (latest first, ≤10)', async () => {
    fx({ EUR: 0.5 });
    seedConnection(t, { id: 'c', userId: 'u1', provider: 'lemonsqueezy', name: 'Shop', config: { storeId: '42' } });
    for (let i = 0; i < 35; i++) snap('c', addDays(TODAY, -i), { EUR: 1000 + i }, i);
    for (let i = 0; i < 12; i++) {
      t.exec(
        'INSERT INTO sync_runs (connection_id, kind, started_at, finished_at, ok, events, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'c', i === 0 ? 'initial' : 'cron', 1000 + i, i === 11 ? null : 2000 + i, i === 11 ? null : i % 2, i, i % 2 ? null : 'boom',
      );
    }
    const d = await getConnectionDetail(testEnv(t.db), { ...user, baseCurrency: 'USD' }, 'c');
    expect(t.roundTrips()).toBe(1);
    expect(d).not.toBeNull();
    expect(d!.config).toEqual({ storeId: '42' });
    expect(d!.snapshots).toHaveLength(30);
    expect(d!.snapshots[0]).toEqual({ day: TODAY, mrr: 2000, activeSubscriptions: 0, activeTrials: null });
    expect(d!.recentRuns).toHaveLength(10);
    expect(d!.recentRuns[0]).toEqual({ kind: 'cron', startedAt: 1011, finishedAt: null, ok: null, events: 11, message: null });
    expect(d!.recentRuns[1]).toMatchObject({ ok: false, message: 'boom' });
    expect(d!.recentRuns[2]).toMatchObject({ ok: true });
    expect(d!.warnings).toEqual([]);
  });

  it('carries the latest snapshot’s warnings only', async () => {
    seedConnection(t, { id: 'c', userId: 'u1', provider: 'stripe', name: 'Acme' });
    t.exec(
      `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, warnings, captured_at) VALUES
         ('c', ?, '{}', 0, '["Old news."]', 0), ('c', ?, '{}', 0, '["MRR is before discounts.","MRR is before discounts.", 7]', 0)`,
      addDays(TODAY, -1),
      TODAY,
    );
    const d = await getConnectionDetail(testEnv(t.db), user, 'c');
    expect(d!.warnings).toEqual(['MRR is before discounts.']);
  });

  it("returns null for someone else’s connection", async () => {
    seedConnection(t, { id: 'c', userId: 'u2', provider: 'stripe' });
    expect(await getConnectionDetail(testEnv(t.db), user, 'c')).toBeNull();
    expect(await listConnectionSummaries(testEnv(t.db), 'u1')).toEqual([]);
  });
});
