import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCalendarMonth } from '../../src/data/calendar';
import { getDashboardData, getDashboardPage, kpi, PRODUCT_ROWS } from '../../src/data/dashboard';
import type { DashboardData } from '../../src/data/types';
import { recomputeDailyRevenue, upsertSnapshot } from '../../src/sync/repo';
import { cleanSnapshot } from '../../src/sync/aggregate';
import { STRIPE_PRODUCTS_WARNING } from '../../src/providers/stripe';
import { encodeCursor, listTransactions, parseCursor } from '../../src/data/transactions';
import { getConnectionDetail, listConnectionSummaries } from '../../src/data/connections';
import { addDays } from '../../src/lib/time';
import { CONNECTION_VIEW_COLUMNS } from '../../src/db/queries';
import type { SessionUser } from '../../src/env';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const TODAY = '2026-11-05';
const user: SessionUser = { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD', timeZone: 'UTC' };

let t: TestD1;

function snap(conn: string, day: string, mrr: Record<string, number>, subs: number, trials: number | null = null, extra: { revenuePeriod?: Record<string, number>; days?: number } = {}) {
  t.exec(
    `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period, revenue_period_days, new_customers, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    conn, day, JSON.stringify(mrr), subs, trials, extra.revenuePeriod ? JSON.stringify(extra.revenuePeriod) : null, extra.days ?? null,
  );
}

/**
 * A day's revenue as the engine stores it: for a transactions provider, the charge and refund it's
 * built from (at noon UTC) plus the derived daily_revenue row; for a provider total, the row only.
 */
function rev(conn: string, day: string, currency: string, gross: number, refunds = 0, source: 'transactions' | 'provider' = 'transactions') {
  t.exec(
    'INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES (?, ?, ?, ?, ?, 1, ?)',
    conn, day, currency, gross, refunds, source,
  );
  if (source !== 'transactions') return;
  const noon = Date.parse(`${day}T12:00:00.000Z`);
  if (gross) tx(conn, `rev:${day}:${currency}:charge`, noon, gross, currency, null);
  if (refunds) tx(conn, `rev:${day}:${currency}:refund`, noon + 1, -refunds, currency, null);
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
    expect(d.fx).toEqual({ asOf: null, daily: false, missing: [] });
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
    expect(d.fx).toEqual({ asOf: '2026-11-04', daily: false, missing: [] });
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
    const d = await getDashboardData(testEnv(t.db), { ...user, baseCurrency: 'EUR', timeZone: 'UTC' }, 7);
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

  it('rounds products so they add up to the revenue KPI exactly', async () => {
    fx({ EUR: 0.8 });
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Pagekit' });
    tx('ls', 'a', at('2026-11-04'), 10_01, 'EUR', 'Pro');
    tx('ls', 'b', at('2026-11-04'), 10_01, 'EUR', 'Team');
    await aggregate('ls');
    const d = await getDashboardData(testEnv(t.db), user, 7);
    // The KPI converts the day once: 20.02 € at 0.8 = $25.025 → 2503. Each 10.01 € alone is
    // $12.5125 → 1251, so the leftover cent goes to one of them (ties: by name).
    expect(d.kpis.revenue.value).toBe(25_03);
    expect(d.products.rows.map((r) => [r.name, r.revenue])).toEqual([
      ['Pro', 12_52],
      ['Team', 12_51],
    ]);
    expect(d.products.unnamed.revenue).toBe(0);
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

  it('reads cursors back as written, and ignores junk', () => {
    const c = { at: NOW, connectionId: 'l', externalId: 'order:1~a~b' };
    expect(parseCursor(encodeCursor(c))).toEqual(c);
    for (const junk of [undefined, '', 'x', '12~l', '-1~l~x', `${NOW}~~x`, `1e3~l~x`, `${'9'.repeat(17)}~l~x`, `${NOW}~l~${'x'.repeat(513)}`]) {
      expect(parseCursor(junk), String(junk)).toBeNull();
    }
  });

  it('clamps bad paging input', async () => {
    const p = await listTransactions(testEnv(t.db), user, { provider: null, page: -4, pageSize: 10_000 });
    expect(p.page).toBe(1);
    expect(p.pageSize).toBe(200);
    const q = await listTransactions(testEnv(t.db), user, { provider: null, page: Number.NaN });
    expect(q.page).toBe(1);
  });

  it('pages through every connection merged newest first, ties across page edges included', async () => {
    // Each connection only sorts its newest (offset + pageSize + 1) rows: check that no page loses
    // or repeats a row against one sort of everything, with many shared instants (ties at every
    // page edge and at every connection's cutoff), on both sides of midnight.
    seedConnection(t, { id: 'p', userId: 'u1', provider: 'paddle', name: 'Paddle' });
    type Row = { conn: string; id: string; at: number };
    const rows: Row[] = [
      { conn: 's', id: 'txn_1', at: NOW - 1000 },
      { conn: 's', id: 'txn_2', at: NOW - 2000 },
      { conn: 'l', id: 'order:1', at: NOW - 3000 },
      { conn: 'l', id: 'order:2', at: NOW - 4000 },
    ];
    let n = 0;
    for (const conn of ['s', 'l', 'p']) {
      for (let i = 0; i < 30; i++) {
        // 9 instants per connection, shared with the others; 13:00 to 12:20 the day before included.
        const at = NOW - (i % 9) * 3 * 60 * 60_000 - (conn === 'p' ? 0 : (i % 2) * 60_000);
        const id = `${conn}-${String((i * 7) % 30).padStart(2, '0')}-${n++}`;
        tx(conn, id, at, 1_00);
        rows.push({ conn, id, at });
      }
    }
    const newestFirst = (a: Row, b: Row) => b.at - a.at || (a.conn < b.conn ? -1 : a.conn > b.conn ? 1 : 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    async function expectPages(want: Row[], opts: { provider: 'stripe' | null; day?: string }) {
      const ids = [...want].sort(newestFirst).map((r) => r.id);
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(ids.length / 7) + 1; page++) {
        const p = await listTransactions(testEnv(t.db), user, { ...opts, page, pageSize: 7 });
        seen.push(...p.items.map((i) => i.externalId));
        expect(p.hasMore, `page ${page}`).toBe(page * 7 < ids.length);
      }
      expect(seen).toEqual(ids);

      // The same pages through the Next links' cursors, then back through the Previous links'.
      const pages: string[][] = [];
      let p = await listTransactions(testEnv(t.db), user, { ...opts, page: 1, pageSize: 7 });
      pages.push(p.items.map((i) => i.externalId));
      while (p.nextCursor) {
        p = await listTransactions(testEnv(t.db), user, { ...opts, page: p.page + 1, pageSize: 7, before: parseCursor(p.nextCursor) });
        pages.push(p.items.map((i) => i.externalId));
      }
      expect(pages.flat()).toEqual(ids);
      expect(pages.length).toBe(Math.max(1, Math.ceil(ids.length / 7)));
      for (let i = pages.length - 1; i > 0; i--) {
        expect(p.prevCursor, `page ${p.page}`).not.toBeNull();
        p = await listTransactions(testEnv(t.db), user, { ...opts, page: p.page - 1, pageSize: 7, after: parseCursor(p.prevCursor) });
        expect(p.items.map((x) => x.externalId), `back to page ${p.page}`).toEqual(pages[i - 1]);
        expect(p.hasMore).toBe(true);
      }
    }
    const onDay = (day: string) => (r: Row) => new Date(r.at).toISOString().slice(0, 10) === day;
    await expectPages(rows, { provider: null });
    await expectPages(rows.filter((r) => r.conn === 's'), { provider: 'stripe' });
    await expectPages(rows.filter(onDay(TODAY)), { provider: null, day: TODAY });
    await expectPages(rows.filter(onDay('2026-11-04')), { provider: null, day: '2026-11-04' });
    expect(rows.filter(onDay('2026-11-04')).length).toBeGreaterThan(7);
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
    const d = await getConnectionDetail(testEnv(t.db), { ...user, baseCurrency: 'USD', timeZone: 'UTC' }, 'c');
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

describe('revenue at each day’s exchange rate (SPEC §6)', () => {
  const at = (day: string) => Date.parse(`${day}T12:00:00.000Z`);

  beforeEach(async () => {
    // 1 USD = 0.5 € on Nov 2, 0.8 € from Nov 4 (the latest). Nov 3 has no row (a holiday).
    fx({ EUR: 0.5 }, '2026-11-02');
    fx({ EUR: 0.8 }, '2026-11-04');
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    tx('st', 'a', at('2026-11-02'), 100_00, 'EUR', 'Pro');
    tx('st', 'b', at('2026-11-03'), 100_00, 'EUR', 'Pro');
    tx('st', 'c', at('2026-11-04'), 100_00, 'EUR', null);
    await t.db.batch(recomputeDailyRevenue(t.db, 'st', { from: '2026-11-02', to: '2026-11-04' }));
    snap('st', TODAY, { EUR: 80_00 }, 1);
  });

  it('dashboard: each day’s revenue at its own rate, MRR at the latest, products adding up to the KPI', async () => {
    const d = await getDashboardData(testEnv(t.db), user, 7);
    const byDay = Object.fromEntries(d.revenueSeries.map((r) => [r.day, r.total]));
    expect(byDay['2026-11-02']).toBe(200_00); // 100 € at 0.5
    expect(byDay['2026-11-03']).toBe(200_00); // the holiday takes Nov 2's rate
    expect(byDay['2026-11-04']).toBe(125_00); // 100 € at 0.8
    expect(d.kpis.revenue.value).toBe(525_00);
    expect(d.kpis.mrr.value).toBe(100_00); // 80 € at the latest 0.8
    expect(d.fx).toEqual({ asOf: '2026-11-04', daily: true, missing: [] });
    expect(d.products.rows.map((p) => [p.name, p.revenue])).toEqual([['Pro', 400_00]]);
    expect(d.products.rows.reduce((s, p) => s + p.revenue, 0) + d.products.unnamed.revenue).toBe(d.kpis.revenue.value);
  });

  it('calendar and transactions use the same day rates', async () => {
    const { getCalendarMonth } = await import('../../src/data/calendar');
    const cal = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    const net = Object.fromEntries(cal.days.filter((x) => x.day <= '2026-11-04').map((x) => [x.day, x.net]));
    expect(net).toMatchObject({ '2026-11-02': 200_00, '2026-11-03': 200_00, '2026-11-04': 125_00 });

    const page = await listTransactions(testEnv(t.db), user, { provider: null, page: 1 });
    expect(page.items.map((i) => [i.externalId, i.displayAmount])).toEqual([
      ['c', 125_00],
      ['b', 200_00],
      ['a', 200_00],
    ]);
  });
});

describe('which day’s rate each figure takes (SPEC §6)', () => {
  /** Stripe sales, and the daily_revenue a sync derives from them (the rate history reads its currencies). */
  async function sales(...items: Array<[id: string, iso: string, amount: number, currency: string]>) {
    for (const [id, iso, amount, currency] of items) tx('st', id, Date.parse(iso), amount, currency);
    await t.db.batch(recomputeDailyRevenue(t.db, 'st', { from: '2026-04-01', to: TODAY }));
  }
  const bars = (d: DashboardData) => Object.fromEntries(d.revenueSeries.map((r) => [r.day, r.total]));
  const shown = async (u: SessionUser, day: string | null = null) =>
    Object.fromEntries((await listTransactions(testEnv(t.db), u, { provider: null, page: 1, day })).items.map((i) => [i.externalId, i.displayAmount]));

  beforeEach(() => seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' }));

  it('converts into a non-USD display currency at its own rate of the day too', async () => {
    fx({ EUR: 0.5, GBP: 0.4 }, '2026-11-02');
    fx({ EUR: 0.8, GBP: 0.6 }, '2026-11-04');
    await sales(['eur', '2026-11-02T12:00:00Z', 100_00, 'EUR'], ['usd', '2026-11-02T13:00:00Z', 100_00, 'USD']);
    const gbp: SessionUser = { ...user, baseCurrency: 'GBP' };
    // 100 € = $200 on Nov 2 = £80 at its £0.4 per $; $100 = £40. (At the latest £0.6: £120 and £60.)
    expect(bars(await getDashboardData(testEnv(t.db), gbp, 7))['2026-11-02']).toBe(80_00 + 40_00);
    expect(await shown(gbp)).toEqual({ eur: 80_00, usd: 40_00 });
  });

  it('converts the previous period at its own days’ rates, as far back as it reaches', async () => {
    fx({ EUR: 0.4 }, '2026-09-10');
    fx({ EUR: 0.5 }, '2026-10-26');
    fx({ EUR: 0.8 }, '2026-11-04');
    await sales(['old', '2026-09-15T12:00:00Z', 100_00, 'EUR'], ['prev', '2026-10-27T12:00:00Z', 100_00, 'EUR'], ['now', '2026-11-04T12:00:00Z', 100_00, 'EUR']);
    // 7 days (Oct 30–Nov 5 against Oct 23–29): 100 € at 0.8, against 100 € at Oct 26's 0.5.
    expect((await getDashboardData(testEnv(t.db), user, 7)).kpis.revenue).toEqual({ value: 125_00, previous: 200_00, deltaPct: -37.5 });
    // 30 days (Oct 7–Nov 5 against Sep 7–Oct 6): Sep 15 takes Sep 10's 0.4.
    expect((await getDashboardData(testEnv(t.db), user, 30)).kpis.revenue).toMatchObject({ value: 200_00 + 125_00, previous: 250_00 });
  });

  it('converts MRR, its trend and the calendar’s MRR at the latest rate, never the day’s', async () => {
    fx({ EUR: 0.5 }, '2026-11-02');
    fx({ EUR: 0.8 }, '2026-11-04');
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Shop' });
    await sales(['one', '2026-11-03T12:00:00Z', 1_00, 'EUR']); // so the rate history holds EUR
    snap('st', '2026-11-02', { EUR: 80_00 }, 1);
    snap('st', TODAY, { EUR: 80_00 }, 1);
    snap('ls', '2026-10-28', { EUR: 40_00 }, 1); // before the window, carried into it
    // 80 € and 40 € at the latest 0.8 are $100 and $50 on every day (at Nov 2's 0.5: $160 and $80).
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.mrrSeries).toEqual([
      { day: '2026-11-02', total: 150_00 },
      { day: TODAY, total: 150_00 },
    ]);
    expect(d.kpis.mrr).toEqual({ value: 150_00, previous: 150_00, deltaPct: 0 });
    const cal = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    expect(cal.days.find((x) => x.day === '2026-11-02')!.mrr).toBe(150_00);
  });

  it('looks back before a range’s first day for its rate: a Sunday takes Friday’s', async () => {
    fx({ EUR: 0.5 }, '2026-10-30'); // Friday
    fx({ EUR: 0.8 }, '2026-11-02'); // Monday
    await sales(['sun', '2026-11-01T12:00:00Z', 100_00, 'EUR']);
    expect(bars(await getDashboardData(testEnv(t.db), user, 7))['2026-11-01']).toBe(200_00);
    // The calendar's November and that day's transactions start on the Sunday itself.
    const cal = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    expect(cal.days[0]).toMatchObject({ day: '2026-11-01', net: 200_00 });
    expect(await shown(user, '2026-11-01')).toEqual({ sun: 200_00 });
  });

  it('takes a transaction’s rate on its day in the user’s zone, like its bar', async () => {
    fx({ EUR: 0.5 }, '2026-11-02');
    fx({ EUR: 0.8 }, '2026-11-03');
    await sales(['eve', '2026-11-03T03:00:00Z', 100_00, 'EUR']); // 7 pm on Nov 2 in Los Angeles
    const la: SessionUser = { ...user, timeZone: 'America/Los_Angeles' };
    expect(bars(await getDashboardData(testEnv(t.db), la, 7))['2026-11-02']).toBe(200_00);
    expect(await shown(la)).toEqual({ eve: 200_00 }); // not Nov 3's (UTC) $125
  });

  it('reads a three-decimal currency right at the day rate (KWD)', async () => {
    fx({ KWD: 0.3 }, '2026-11-02');
    fx({ KWD: 0.25 }, '2026-11-04');
    await sales(['kwd', '2026-11-02T12:00:00Z', 1_500, 'KWD']); // 1.500 KWD
    // 1.500 KWD at 0.3 per $ = $5.00 (at the latest 0.25: $6.00; read as 15.00 KWD: $50.00).
    expect(bars(await getDashboardData(testEnv(t.db), user, 7))['2026-11-02']).toBe(5_00);
    expect(await shown(user)).toEqual({ kwd: 5_00 });
  });

  it('reads a zero-decimal display currency right at the day rate (JPY)', async () => {
    fx({ EUR: 0.5, JPY: 150 }, '2026-11-02');
    fx({ EUR: 0.8, JPY: 100 }, '2026-11-04');
    await sales(['usd', '2026-11-02T12:00:00Z', 10_00, 'USD'], ['eur', '2026-11-02T13:00:00Z', 10_00, 'EUR']);
    const jpy: SessionUser = { ...user, baseCurrency: 'JPY' };
    // At Nov 2's ¥150 per $: $10 = ¥1,500, 10 € = $20 = ¥3,000. Yen have no minor unit.
    expect(bars(await getDashboardData(testEnv(t.db), jpy, 7))['2026-11-02']).toBe(4_500);
    expect(await shown(jpy)).toEqual({ usd: 1_500, eur: 3_000 });
  });

  it('a transaction older than every stored rate takes the oldest one, on a page of its own too', async () => {
    fx({ EUR: 0.5 }, '2026-06-01'); // the oldest stored rates
    fx({ EUR: 0.8 }, '2026-11-04');
    await sales(['new', '2026-11-02T12:00:00Z', 100_00, 'EUR'], ['old', '2026-04-02T12:00:00Z', 100_00, 'EUR']);
    // Page 2 holds only April's sale: no stored rate is near its day, and the oldest (0.5) applies,
    // as FxHistory.rateOn says, not the latest (0.8).
    const page2 = await listTransactions(testEnv(t.db), user, { provider: null, page: 2, pageSize: 1 });
    expect(page2.items.map((i) => [i.externalId, i.displayAmount])).toEqual([['old', 200_00]]);
    expect(await shown(user)).toEqual({ new: 200_00, old: 200_00 });
  });

  it('a currency without rates in the range takes the latest as its day rate; the latest table’s date stays with MRR', async () => {
    fx({ EUR: 0.5 }, '2026-10-01'); // the only rates, from before the range's history
    await sales(['eur', '2026-11-02T12:00:00Z', 100_00, 'EUR']);
    let d = await getDashboardData(testEnv(t.db), user, 7);
    expect(bars(d)['2026-11-02']).toBe(200_00); // Oct 1's 0.5, the newest rate on or before Nov 2
    // The footnote says "revenue at each day's exchange rate" and names no table: none was used for MRR.
    expect(d.fx).toEqual({ asOf: null, daily: true, missing: [] });
    snap('st', TODAY, { EUR: 10_00 }, 1);
    d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.fx).toEqual({ asOf: '2026-10-01', daily: true, missing: [] });
  });
});

describe('the dashboard page in one round trip', () => {
  const at = (day: string, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);

  beforeEach(async () => {
    fx({ EUR: 0.8 }, '2026-10-01');
    fx({ EUR: 0.5 }, '2026-11-04');
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme', createdAt: at('2026-08-01') });
    seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat', name: 'App', config: { revenueHistory: 'daily' }, createdAt: at('2026-08-01') });
    seedConnection(t, { id: 'x', userId: 'u2', provider: 'stripe', name: 'Theirs' });
    // This window and the one before it, refunds and two currencies, on both sides of the edge.
    for (const [id, day, amount, currency, product] of [
      ['a', '2026-10-06', 50_00, 'USD', 'Pro'], ['b', '2026-10-06', -10_00, 'USD', 'Pro'], ['c', '2026-10-07', 40_00, 'EUR', 'Team'],
      ['d', '2026-10-07', 30_00, 'EUR', null], ['e', '2026-11-01', 20_00, 'USD', 'Pro'], ['f', '2026-11-01', -5_00, 'EUR', 'Team'],
      // Two products with refunds on one day and currency: their rows add up to one revenue row.
      ['g', '2026-10-20', 30_00, 'USD', 'Pro'], ['h', '2026-10-20', -3_00, 'USD', 'Pro'],
      ['i', '2026-10-20', 25_00, 'USD', 'Team'], ['j', '2026-10-20', -4_00, 'USD', 'Team'],
    ] as const) tx('st', id, at(day), amount, currency, product);
    await t.db.batch(recomputeDailyRevenue(t.db, 'st', { from: '2026-09-01', to: TODAY }));
    rev('rc', '2026-10-06', 'USD', 7_00, 1_00, 'provider');
    rev('rc', '2026-11-02', 'USD', 9_00, 0, 'provider');
    tx('x', 'theirs', at('2026-11-01'), 99_00);
    snap('st', '2026-10-01', { USD: 100_00 }, 10);
    snap('st', TODAY, { USD: 120_00 }, 12);
    snap('rc', TODAY, { USD: 30_00 }, 3, 1);
  });

  it('equals the dashboard, the calendar and the connection list read on their own', async () => {
    const env = testEnv(t.db);
    const before = t.roundTrips();
    const page = await getDashboardPage(env, user, 30, '2026-10');
    expect(t.roundTrips() - before).toBe(1);
    expect(page.data).toEqual(await getDashboardData(env, user, 30));
    expect(page.calendar).toEqual(await getCalendarMonth(env, user, '2026-10'));
    expect(page.connections).toEqual(await listConnectionSummaries(env, 'u1'));
  });

  it('counts each window’s revenue once, this window’s from the product rows', async () => {
    const d = await getDashboardData(testEnv(t.db), user, 30);
    // This window (Oct 7 – Nov 5): 70 € on Oct 7 and −5 € on Nov 1, both at Oct 1's 0.8 (Nov 4's
    // 0.5 comes after them), 55 $ − 7 $ on Oct 20, 20 $ on Nov 1, and RevenueCat's 9 $.
    expect(d.kpis.revenue.value).toBe(87_50 - 6_25 + 48_00 + 20_00 + 9_00);
    expect(d.revenueSeries.find((r) => r.day === '2026-10-20')!.total).toBe(48_00);
    // The window before (Sep 7 – Oct 6): 50 $ − 10 $ and RevenueCat's 7 $ − 1 $.
    expect(d.kpis.revenue.previous).toBe(40_00 + 6_00);
    expect(d.breakdown.find((b) => b.id === 'st')!.revenue).toBe(87_50 - 6_25 + 48_00 + 20_00);
    expect(d.products.rows.reduce((s, p) => s + p.revenue, 0) + d.products.unnamed.revenue).toBe(d.kpis.revenue.value);
  });
});

describe('connection reads', () => {
  it('select every column but the encrypted credentials', () => {
    const columns = t.rows<{ name: string }>('PRAGMA table_info(connections)').map((c) => c.name);
    expect(columns).toContain('credentials_enc');
    expect(CONNECTION_VIEW_COLUMNS.split(',').map((c) => c.trim()).sort()).toEqual(columns.filter((c) => c !== 'credentials_enc').sort());
  });
});
