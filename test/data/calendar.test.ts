/**
 * The dashboard calendar: its read model, its query parsing, the transactions day filter it links
 * to, and the card's server HTML. Owner: Data Plane (read model) · Experience (card).
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonths, getCalendarMonth, monthBounds, parseCalendarQuery, parseDayParam } from '../../src/data/calendar';
import { getDashboardData } from '../../src/data/dashboard';
import { listTransactions } from '../../src/data/transactions';
import { recomputeDailyRevenue } from '../../src/sync/repo';
import type { CalendarMonth } from '../../src/data/types';
import type { SessionUser } from '../../src/env';
import { CalendarCard, calendarWeeks, cellAmount, heatStep, revenueLine } from '../../src/views/components/calendar-card';
import { FIXTURE_CONNECTIONS } from '../../src/views/fixtures';
import { PageRoot } from '../../src/views/page-root';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const user: SessionUser = { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD', timeZone: 'UTC' };
const at = (iso: string) => Date.parse(iso);

let t: TestD1;

function snap(conn: string, day: string, mrr: Record<string, number>, subs: number, trials: number | null) {
  t.exec(
    `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period, revenue_period_days, new_customers, captured_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
    conn, day, JSON.stringify(mrr), subs, trials,
  );
}

function rev(conn: string, day: string, currency: string, gross: number, refunds = 0) {
  t.exec(
    'INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES (?, ?, ?, ?, ?, 1, ?)',
    conn, day, currency, gross, refunds, 'transactions',
  );
}

function tx(conn: string, id: string, ms: number, amount: number, currency = 'USD') {
  t.exec(
    `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'Pro')`,
    conn, id, ms, amount < 0 ? 'refund' : 'charge', amount, currency,
  );
}

const synced = (id: string) => t.exec('UPDATE connections SET revenue_synced_until = ? WHERE id = ?', NOW, id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  seedUser(t, { id: 'u2' });
  t.exec('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)', '2026-11-04', 'USD', JSON.stringify({ EUR: 0.5 }), NOW);
});
afterEach(() => vi.useRealTimers());

describe('calendar month helpers', () => {
  it('steps months across years and finds their last day', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthBounds('2026-11')).toEqual({ first: '2026-11-01', last: '2026-11-30' });
    expect(monthBounds('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
  });

  it('reads ?month= and ?day=, ignoring junk and the future', () => {
    expect(parseCalendarQuery(undefined, undefined, NOW)).toEqual({ month: '2026-11', day: null });
    expect(parseCalendarQuery('2026-10', undefined, NOW)).toEqual({ month: '2026-10', day: null });
    expect(parseCalendarQuery('2026-12', undefined, NOW)).toEqual({ month: '2026-11', day: null });
    expect(parseCalendarQuery('2026-13', undefined, NOW)).toEqual({ month: '2026-11', day: null });
    expect(parseCalendarQuery('1999-12', undefined, NOW)).toEqual({ month: '2026-11', day: null });
    expect(parseCalendarQuery(undefined, '2026-11-03', NOW)).toEqual({ month: '2026-11', day: '2026-11-03' });
    // The day wins over the month; a future or impossible day falls back to the month.
    expect(parseCalendarQuery('2026-09', '2026-10-31', NOW)).toEqual({ month: '2026-10', day: '2026-10-31' });
    expect(parseCalendarQuery('2026-09', '2026-11-06', NOW)).toEqual({ month: '2026-09', day: null });
    expect(parseDayParam('2026-02-30', NOW)).toBeNull();
    expect(parseDayParam('2026-11-5', NOW)).toBeNull();
    expect(parseDayParam('2026-11-05', NOW)).toBe('2026-11-05');
  });
});

describe('getCalendarMonth', () => {
  beforeEach(() => {
    seedConnection(t, { id: 's', userId: 'u1', provider: 'stripe', name: 'Acme', createdAt: at('2026-10-01T09:00:00Z') });
    seedConnection(t, { id: 'l', userId: 'u1', provider: 'lemonsqueezy', name: 'Shop', createdAt: at('2026-11-02T09:00:00Z') });
    seedConnection(t, { id: 'x', userId: 'u2', provider: 'stripe', name: 'Theirs' });
    synced('s');
    synced('l');

    // Stripe's revenue is grouped from its transactions, per local (here UTC) day.
    tx('s', 'o1', at('2026-10-31T12:00:00Z'), 999);
    tx('s', 'e1', at('2026-11-03T12:00:00Z'), 1000, 'EUR'); // 0.5 EUR per USD → 2000
    tx('s', 'c1', at('2026-11-03T08:00:00Z'), 1000);
    tx('s', 'c2', at('2026-11-03T23:59:59Z'), 500);
    tx('s', 'r1', at('2026-11-03T10:00:00Z'), -300);
    tx('s', 'c3', at('2026-11-04T00:00:00Z'), 500);
    tx('x', 'c9', at('2026-11-03T12:00:00Z'), 100_000);

    snap('s', '2026-10-30', { USD: 10_000 }, 10, 2);
    snap('s', '2026-11-03', { USD: 12_000 }, 12, 1);
    snap('l', '2026-11-04', { EUR: 1000 }, 3, null);
    snap('x', '2026-11-03', { USD: 999_999 }, 99, 9);
  });

  it('reads a month in one round trip, day by day, scoped to the user', async () => {
    const m = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    expect(t.roundTrips()).toBe(1);
    expect(m).toMatchObject({ month: '2026-11', currency: 'USD', today: '2026-11-05', revenueFrom: '2026-07-04', mrrFrom: '2026-10-30' });
    expect(m.days).toHaveLength(30);
    expect(m.days[0]!.day).toBe('2026-11-01');

    const d3 = m.days[2]!;
    expect(d3).toMatchObject({ day: '2026-11-03', net: 3200, gross: 3500, refunds: 300, byConnection: { s: 3200 }, charges: 3, refundCount: 1 });
    expect(m.days[3]).toMatchObject({ net: 500, charges: 1, refundCount: 0 });
    // A covered day without revenue is a real zero; days after today have nothing yet.
    expect(m.days[0]).toMatchObject({ net: 0, charges: 0 });
    expect(m.days[0]!.byConnection).toEqual({}); // inside toMatchObject, `{}` would match any object
    expect(m.days[5]).toMatchObject({ day: '2026-11-06', net: null, mrr: null, mrrChange: null });
  });

  it('carries each connection’s last snapshot forward and compares with the day before', async () => {
    const m = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    const pick = (i: number) => {
      const d = m.days[i]!;
      return [d.mrr, d.mrrChange, d.activeSubscriptions, d.subscriptionsChange, d.activeTrials, d.trialsChange];
    };
    expect(pick(0)).toEqual([10_000, 0, 10, 0, 2, 0]); // Nov 1, carried from Oct 30
    expect(pick(2)).toEqual([12_000, 2000, 12, 2, 1, -1]); // Nov 3
    expect(pick(3)).toEqual([14_000, 2000, 15, 3, 1, 0]); // Nov 4: Shop joins (EUR 10 → $20), no trials
    expect(pick(4)).toEqual([14_000, 0, 15, 0, 1, 0]); // Nov 5
  });

  it('links to the months around it, up to the current one', async () => {
    const nov = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    expect([nov.prevMonth, nov.nextMonth]).toEqual(['2026-10', null]);
    const oct = await getCalendarMonth(testEnv(t.db), user, '2026-10');
    expect([oct.prevMonth, oct.nextMonth]).toEqual(['2026-09', '2026-11']);
    expect(oct.days.at(-1)).toMatchObject({ day: '2026-10-31', net: 999, mrr: 10_000 });
    expect(oct.days[0]).toMatchObject({ net: 0, mrr: null }); // revenue backfilled, MRR not yet recorded
    // History starts on Jul 4 (90 days back from Acme's first day): nothing before it, no earlier month.
    const jul = await getCalendarMonth(testEnv(t.db), user, '2026-07');
    expect(jul.prevMonth).toBeNull();
    expect(jul.days.slice(2, 4).map((d) => d.net)).toEqual([null, 0]);
  });

  it('leaves out a daily-totals provider that can’t report them', async () => {
    t.exec('DELETE FROM connections');
    seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat', config: { revenueHistory: 'none' }, createdAt: at('2026-10-01T09:00:00Z') });
    synced('rc');
    const m = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    expect(m.revenueFrom).toBeNull();
    expect(m.days.every((d) => d.net === null)).toBe(true);
    expect(m.prevMonth).toBeNull();
  });
});

describe('getCalendarMonth revenue at each day’s rate (SPEC §6)', () => {
  const fxDay = (day: string, rates: Record<string, number>) =>
    t.exec('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)', day, 'USD', JSON.stringify(rates), NOW);

  beforeEach(() => {
    t.exec('DELETE FROM fx_rates');
    seedConnection(t, { id: 's', userId: 'u1', provider: 'stripe', name: 'Acme' });
  });

  /** Stores transactions and the daily_revenue a sync derives from them (the FX history reads its currencies). */
  async function sales(...items: Array<[id: string, iso: string, amount: number, currency: string]>) {
    for (const [id, iso, amount, currency] of items) tx('s', id, at(iso), amount, currency);
    await t.db.batch(recomputeDailyRevenue(t.db, 's', { from: '2026-10-01', to: '2026-11-05' }));
  }

  const cell = (m: CalendarMonth, day: string) => {
    const d = m.days.find((x) => x.day === day)!;
    return { gross: d.gross, refunds: d.refunds, net: d.net };
  };

  it('nets each day once, like the dashboard bar, so gross − refunds is the net', async () => {
    fxDay('2026-11-04', { EUR: 0.8 });
    await sales(['c', '2026-11-04T10:00:00Z', 5, 'EUR'], ['r', '2026-11-04T11:00:00Z', -3, 'EUR']);
    const m = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    const bar = (await getDashboardData(testEnv(t.db), user, 7)).revenueSeries.find((r) => r.day === '2026-11-04')!.total;
    // 2 ¢ net at 0.8 = 2.5 ¢ → 3, as the bar; 5 ¢ gross alone = 6.25 → 6; refunds are the rest.
    expect(bar).toBe(3);
    expect(cell(m, '2026-11-04')).toEqual({ gross: 6, refunds: 3, net: 3 });
  });

  it('converts a day’s charges and refunds at that day’s rate, not the latest', async () => {
    fxDay('2026-11-02', { EUR: 0.5 });
    fxDay('2026-11-04', { EUR: 0.8 });
    await sales(['c', '2026-11-02T10:00:00Z', 100_00, 'EUR'], ['r', '2026-11-02T11:00:00Z', -50_00, 'EUR']);
    const m = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    // At Nov 2's 0.5: +100 € = $200, −50 € = $100. (At the latest 0.8: $125 and $62.50.)
    expect(cell(m, '2026-11-02')).toEqual({ gross: 200_00, refunds: 100_00, net: 100_00 });
    expect(m.days[1]!.byConnection).toEqual({ s: 100_00 });
  });
});

describe('listTransactions by day', () => {
  it('narrows the list to one UTC day and says which', async () => {
    seedConnection(t, { id: 's', userId: 'u1', provider: 'stripe', name: 'Acme' });
    tx('s', 'before', at('2026-11-02T23:59:59.999Z'), 100);
    tx('s', 'first', at('2026-11-03T00:00:00Z'), 200);
    tx('s', 'last', at('2026-11-03T23:59:59.999Z'), -50);
    tx('s', 'after', at('2026-11-04T00:00:00Z'), 300);
    const p = await listTransactions(testEnv(t.db), user, { provider: null, page: 1, day: '2026-11-03' });
    expect(p.items.map((i) => i.externalId)).toEqual(['last', 'first']);
    expect(p.day).toBe('2026-11-03');
    const all = await listTransactions(testEnv(t.db), user, { provider: null, page: 1 });
    expect(all.items).toHaveLength(4);
    expect(all.day).toBeNull();
  });
});

describe('provider daily totals stay with their owner', () => {
  it('leaves another user’s totals out of the calendar and the dashboard', async () => {
    seedConnection(t, { id: 'mine', userId: 'u1', provider: 'revenuecat', name: 'App' });
    seedConnection(t, { id: 'theirs', userId: 'u2', provider: 'revenuecat', name: 'Their app' });
    const total = (conn: string, gross: number) =>
      t.exec(
        "INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES (?, '2026-11-03', 'USD', ?, 0, 1, 'provider')",
        conn, gross,
      );
    total('mine', 5_00);
    total('theirs', 999_00);

    const m = await getCalendarMonth(testEnv(t.db), user, '2026-11');
    expect(m.days[2]).toMatchObject({ day: '2026-11-03', net: 5_00 });
    expect(m.days[2]!.byConnection).toEqual({ mine: 5_00 });
    const d = await getDashboardData(testEnv(t.db), user, 7);
    expect(d.kpis.revenue.value).toBe(5_00);
  });
});

describe('the calendar card’s zone', () => {
  it('names the zone the page says the days run in', () => {
    const inZone = (timeZone: string) =>
      renderToStaticMarkup(
        createElement(PageRoot, { json: '{}', now: NOW, timeZone }, createElement(CalendarCard, { calendar: month(), connections: FIXTURE_CONNECTIONS })),
      );
    expect(inZone('America/Los_Angeles')).toContain('Net revenue per day (America/Los Angeles).');
    expect(inZone('UTC')).toContain('Net revenue per day (UTC).');
  });
});

// ---------- the card ----------

function month(overrides: Partial<CalendarMonth> = {}): CalendarMonth {
  const days = Array.from({ length: 30 }, (_, i) => {
    const day = `2026-11-${String(i + 1).padStart(2, '0')}`;
    const past = day <= '2026-11-05';
    return {
      day,
      net: past ? (i + 1) * 100_00 : null,
      gross: past ? (i + 1) * 100_00 : 0,
      refunds: 0,
      byConnection: past ? { [FIXTURE_CONNECTIONS[0]!.id]: (i + 1) * 60_00, [FIXTURE_CONNECTIONS[1]!.id]: (i + 1) * 40_00 } : {},
      charges: past ? i + 1 : 0,
      refundCount: 0,
      mrr: past ? 5000_00 + i * 10_00 : null,
      activeSubscriptions: past ? 400 + i : null,
      activeTrials: past ? 20 : null,
      mrrChange: past ? 10_00 : null,
      subscriptionsChange: past ? 1 : null,
      trialsChange: past ? 0 : null,
    };
  });
  days[1] = { ...days[1]!, net: -25_00, gross: 0, refunds: 25_00, refundCount: 1, charges: 0, byConnection: {} };
  return { month: '2026-11', currency: 'USD', today: '2026-11-05', days, revenueFrom: '2026-08-08', mrrFrom: '2026-10-01', prevMonth: '2026-10', nextMonth: null, ...overrides };
}

const card = (props: Partial<Parameters<typeof CalendarCard>[0]> = {}) =>
  renderToStaticMarkup(createElement(CalendarCard, { calendar: month(), connections: FIXTURE_CONNECTIONS, ...props }));

describe('CalendarCard', () => {
  it('lays the month out in Monday-first weeks', () => {
    const weeks = calendarWeeks(month().days);
    expect(weeks).toHaveLength(6); // Nov 1, 2026 is a Sunday
    expect(weeks[0]!.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(weeks[0]![6]!.day).toBe('2026-11-01');
    expect(weeks.at(-1)![0]!.day).toBe('2026-11-30');
  });

  it('tints in four steps against the best day, never for nothing or a loss', () => {
    expect([heatStep(null, 100), heatStep(0, 100), heatStep(-5, 100), heatStep(1, 100), heatStep(26, 100), heatStep(100, 100)]).toEqual([0, 0, 0, 1, 2, 4]);
    expect(cellAmount(845_50, 'USD')).toBe('$846');
    expect(cellAmount(1234_56, 'USD')).toBe('$1.2K');
    expect(cellAmount(-25_00, 'USD')).toBe('-$25');
  });

  it('links every day up to today, speaks each one, and shows the month without a pick', () => {
    const out = card();
    expect(out).toContain('id="calendar"');
    expect(out.match(/<a [^>]*data-day=/g)).toHaveLength(5);
    expect(out).toContain('href="/dashboard?day=2026-11-03#calendar"');
    expect(out).toContain('aria-label="Thursday, Nov 5, 2026, today: $500.00 net revenue"');
    expect(out).toContain('aria-label="Monday, Nov 2, 2026: -$25.00 net revenue"');
    expect(out).toContain('href="/dashboard?month=2026-10#calendar"');
    expect(out).toContain('aria-label="Previous month, October 2026"');
    expect(out).not.toContain('Next month');
    expect(out).toContain('November so far');
    expect(out).toContain('Pick a day to see what happened.');
    expect(out).not.toContain('aria-current');
  });

  it('opens the picked day: revenue, connections, end-of-day figures and its transactions', () => {
    const out = card({ selected: '2026-11-03' });
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="true"[^>]*aria-label="Tuesday, Nov 3, 2026/);
    expect(out).toContain('Tuesday, Nov 3, 2026');
    expect(out).toContain('$300.00');
    expect(out).toContain('$300.00 from 3 charges.');
    expect(out).toContain(FIXTURE_CONNECTIONS[0]!.name);
    expect(out).toContain('MRR at day end');
    expect(out).toContain('href="/transactions?provider=all&amp;day=2026-11-03"');
    expect(out).toContain('See the 3 transactions');
    expect(out).toContain('href="/dashboard?month=2026-11#calendar"'); // close → the month
  });

  it('ignores a picked day outside the month or after today', () => {
    expect(card({ selected: '2026-11-06' })).toContain('November so far');
    expect(card({ selected: '2026-10-03' })).toContain('November so far');
  });

  it('says what a refund-only day was', () => {
    const d = month().days[1]!;
    expect(revenueLine(d, 'USD')).toBe('$25.00 refunded (1 refund).');
    expect(revenueLine({ ...d, refunds: 0 }, 'USD')).toBe('No charges or refunds.');
  });
});
