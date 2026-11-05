import { describe, expect, it } from 'vitest';
import { adaptyAdapter, HISTORY_UNAVAILABLE_WARNING } from '../../src/providers/adapty';
import { ProviderError, type ConnectionInput, type RevenuePage } from '../../src/providers/types';
import {
  expectNoSecretsInLogs,
  fakeFetch,
  makeCtx,
  NOW,
  recordSleeps,
  route,
  type FakeResponse,
  type RecordedCall,
  type Route,
  type TestCtx,
} from '../fixtures/harness';
import revenueChart from '../fixtures/adapty/chart-revenue-day.json';
import refundChart from '../fixtures/adapty/chart-refund-money-day.json';
import mrrChart from '../fixtures/adapty/chart-mrr.json';
import subsChart from '../fixtures/adapty/chart-subscriptions-active.json';
import trialsChart from '../fixtures/adapty/chart-trials-active.json';
import err400 from '../fixtures/adapty/error-400.json';
import err401 from '../fixtures/adapty/error-401.json';
import err403 from '../fixtures/adapty/error-403.json';
import err429 from '../fixtures/adapty/error-429.json';

// The documented key shape (export-analytics-api-requests: `secret_live_Pj1P1xzM.2CvS…`), with made-up characters.
const KEY = 'secret_live_TeSt1xYz.9AbCdEfGhIjKlMnOpQrStUvWxYz0123';
const PATH = '/api/v1/client-api/metrics/analytics/';
const TODAY = '2026-11-05'; // NOW = 2026-11-05T12:00:00Z

const input = (apiKey = KEY): ConnectionInput => ({ credentials: { apiKey }, config: {} });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Query {
  chart_id: string;
  filters: { date: [string, string] };
  period_unit: string;
  date_type: string;
  format: string;
}

const queryOf = (body: string | undefined): Query => JSON.parse(body ?? 'null') as Query;
const queries = (calls: RecordedCall[]) => calls.map((c) => queryOf(c.body));
const charts = (calls: RecordedCall[]) => queries(calls).map((q) => `${q.chart_id} ${q.filters.date.join('..')}`);

type Handler = FakeResponse | FakeResponse[] | ((q: Query) => FakeResponse);

/** One POST route for the analytics endpoint, answering per `chart_id` (sequences repeat their last answer). */
function analytics(handlers: Partial<Record<string, Handler>>): Route {
  const hits: Record<string, number> = {};
  return route(
    PATH,
    (_url, init) => {
      const q = queryOf(typeof init?.body === 'string' ? init.body : undefined);
      const h = handlers[q.chart_id];
      if (h === undefined) throw new Error(`unexpected chart ${q.chart_id}`);
      if (typeof h === 'function') return h(q);
      if (Array.isArray(h)) {
        const i = hits[q.chart_id] ?? 0;
        hits[q.chart_id] = i + 1;
        return h[Math.min(i, h.length - 1)]!;
      }
      return h;
    },
    { method: 'POST' },
  );
}

/** A documented-shape answer for `metric` with no data points (Adapty's "nothing here" answer). */
const emptyAnswer = (metric = 'revenue') => ({
  json: { data: { [metric]: { ...clone(revenueChart.data.revenue), data: [], value: 0 } } },
});

/** A one-metric answer holding `value` and a total row with `points`. */
function answer(metric: string, value: number, points: Array<[string, number]>, extra: Record<string, unknown> = {}) {
  return {
    json: {
      data: {
        [metric]: {
          ...clone(revenueChart.data.revenue),
          ...extra,
          value,
          data: [{ title: 'Total', type: 'total', value, values: points.map(([x, y]) => ({ x, y })) }],
        },
      },
    },
  };
}

async function catchErr(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProviderError) return e;
    throw e;
  }
  throw new Error('expected a ProviderError');
}

const logEvents = (ctx: TestCtx) => ctx.logs.map((l) => l.event);

function expectClean(ctx: TestCtx): void {
  expectNoSecretsInLogs(ctx, [KEY, 'TeSt1xYz', '9AbCdEfGhIjKlMnOpQrStUvWxYz0123']);
}

// ---------------------------------------------------------------------------

describe('adapty input validation (no network)', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['an empty key', '', /Secret API key/],
    ['the Public SDK key', 'public_live_AbCdEfGh.IjKlMnOpQrStUvWx', /Public SDK key \(public_…\).*secret_live_/],
    ['a RevenueCat secret key', 'sk_AbCdEfGhIjKlMnOpQrStUv', /start with “secret_live_”/],
    ['a truncated secret key', 'secret_live_abc', /complete Adapty Secret API key/],
    ['a key with spaces inside', 'secret_live_AbCdEfGh IjKlMnOpQrStUv', /complete Adapty Secret API key/],
  ];

  it.each(cases)('rejects %s on apiKey without calling Adapty', async (_name, key, msg) => {
    const { fetch, calls } = fakeFetch([]);
    const res = await adaptyAdapter.verify(input(key), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error).toMatch(msg);
    expect(res.error).toMatch(/App settings → General/);
    expect(res.error).not.toContain('AbCdEfGh');
    expect(calls).toHaveLength(0);
  });

  it('accepts a pasted "Api-Key …" header value and surrounding whitespace', async () => {
    const { fetch, calls } = fakeFetch([analytics({ mrr: { json: mrrChart }, revenue: emptyAnswer() })]);
    const res = await adaptyAdapter.verify(input(`  Api-Key ${KEY}\n`), makeCtx(fetch));
    expect(res.ok).toBe(true);
    expect(calls[0]!.headers['authorization']).toBe(`Api-Key ${KEY}`);
  });

  it('fetchSnapshot and fetchRevenue throw invalid_input without network', async () => {
    const { fetch, calls } = fakeFetch([]);
    const ctx = makeCtx(fetch);
    const e1 = await catchErr(adaptyAdapter.fetchSnapshot(input('public_live_AbCdEfGhIjKl'), ctx));
    expect(e1).toMatchObject({ kind: 'invalid_input', field: 'apiKey' });
    const e2 = await catchErr(adaptyAdapter.fetchRevenue(input(''), { since: NOW, cursor: null }, ctx));
    expect(e2).toMatchObject({ kind: 'invalid_input', field: 'apiKey' });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('adapty verify', () => {
  it('runs two read-only analytics queries and records non-secret config', async () => {
    const { fetch, calls } = fakeFetch([analytics({ mrr: { json: mrrChart }, revenue: emptyAnswer() })]);
    const ctx = makeCtx(fetch);
    const res = await adaptyAdapter.verify(input(), ctx);
    expect(res).toEqual({
      ok: true,
      accountLabel: 'Adapty app',
      config: { reportingCurrency: 'USD', revenueHistory: 'daily' },
      testMode: false, // sandbox purchases never reach Adapty's charts
      warnings: [],
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe('https://api-admin.adapty.io/api/v1/client-api/metrics/analytics/');
      expect(c.method).toBe('POST');
      expect(c.headers['authorization']).toBe(`Api-Key ${KEY}`);
      expect(c.headers['adapty-tz']).toBe('UTC');
      expect(c.headers['content-type']).toBe('application/json');
    }
    expect(queries(calls)).toEqual([
      { chart_id: 'mrr', filters: { date: [TODAY, TODAY] }, period_unit: 'day', date_type: 'purchase_date', format: 'json' },
      { chart_id: 'revenue', filters: { date: [TODAY, TODAY] }, period_unit: 'day', date_type: 'purchase_date', format: 'json' },
    ]);
    expectClean(ctx);
  });

  it('maps 401 to an apiKey error about the Secret API key, without retrying', async () => {
    const { fetch, calls } = fakeFetch([analytics({ mrr: { status: 401, json: err401 } })]);
    const ctx = makeCtx(fetch);
    const res = await adaptyAdapter.verify(input(), ctx);
    expect(res).toMatchObject({ ok: false, field: 'apiKey' });
    if (res.ok) return;
    expect(res.error).toMatch(/Adapty rejected the API key/);
    expect(res.error).toMatch(/secret_live_/);
    expect(calls).toHaveLength(1);
    expectClean(ctx);
  });

  it('maps 403 to a permission error on apiKey that carries Adapty’s reason', async () => {
    const { fetch, calls } = fakeFetch([analytics({ mrr: { status: 403, json: err403 } })]);
    const res = await adaptyAdapter.verify(input(), makeCtx(fetch));
    expect(res).toMatchObject({ ok: false, field: 'apiKey' });
    if (res.ok) return;
    expect(res.error).toBe('Adapty denied this key access to analytics: You do not have permission to perform this action.');
    expect(calls).toHaveLength(1); // no revenue probe after a failed MRR query
  });

  it('shows Adapty’s validation message when it refuses the query (400)', async () => {
    const { fetch } = fakeFetch([analytics({ mrr: { status: 400, json: err400 } })]);
    const res = await adaptyAdapter.verify(input(), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('Adapty refused the analytics query (HTTP 400): "subscriptions_activ" is not a valid choice.');
  });

  it('warns (but connects) when the revenue chart is refused', async () => {
    const { fetch, calls } = fakeFetch([analytics({ mrr: { json: mrrChart }, revenue: { status: 400, json: err400 } })]);
    const ctx = makeCtx(fetch);
    const res = await adaptyAdapter.verify(input(), ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings).toEqual([HISTORY_UNAVAILABLE_WARNING]);
    expect(res.config['revenueHistory']).toBe('none');
    expect(calls).toHaveLength(2);
    expect(ctx.logs.find((l) => l.event === 'adapty_revenue_unavailable')?.data).toEqual({ reason: 'rejected', status: 400 });
  });

  it('does not fail verify when the revenue probe hits a transient error', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([analytics({ mrr: { json: mrrChart }, revenue: { status: 503, json: {} } })]);
    const res = await adaptyAdapter.verify(input(), makeCtx(fetch));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config['revenueHistory']).toBeUndefined();
    expect(res.warnings).toEqual(["hoomuch couldn’t check Adapty’s revenue chart just now. It will try again on the first sync."]);
  });

  it('rethrows outages and unreadable answers so the form shows "try again"', async () => {
    recordSleeps();
    const a = fakeFetch([analytics({ mrr: { status: 500, json: {} } })]);
    expect((await catchErr(adaptyAdapter.verify(input(), makeCtx(a.fetch)))).kind).toBe('upstream');
    expect(a.calls).toHaveLength(3); // retried by fetchJson

    const b = fakeFetch([analytics({ mrr: { json: { data: [] } } })]);
    const ctx = makeCtx(b.fetch);
    expect((await catchErr(adaptyAdapter.verify(input(), ctx))).kind).toBe('upstream');
    expect(ctx.logs.find((l) => l.event === 'adapty_chart_unreadable')?.data).toEqual({ chart: 'mrr', data: 'array' });
  });
});

// ---------------------------------------------------------------------------

describe('adapty fetchSnapshot', () => {
  const snapshotRoutes = (over: Partial<Record<string, Handler>> = {}) =>
    analytics({
      mrr: { json: mrrChart },
      subscriptions_active: { json: subsChart },
      trials_active: { json: trialsChart },
      revenue: answer('revenue', 5084.1, [[TODAY, 5084.1]]),
      ...over,
    });

  it('reads gross MRR, the active counts and the trailing 30-day revenue', async () => {
    const { fetch, calls } = fakeFetch([snapshotRoutes()]);
    const ctx = makeCtx(fetch);
    const snap = await adaptyAdapter.fetchSnapshot(input(), ctx);
    expect(snap).toEqual({
      mrr: { USD: 454567 }, // gross `revenue` metric, not proceeds (3500.17) or net_revenue (3120.40)
      activeSubscriptions: 512,
      activeTrials: 34,
      revenuePeriod: { USD: 508410 },
      revenuePeriodDays: 30,
      newCustomers: null,
    });
    expect(charts(calls)).toEqual([
      `mrr ${TODAY}..${TODAY}`,
      `subscriptions_active ${TODAY}..${TODAY}`,
      `trials_active ${TODAY}..${TODAY}`,
      `revenue 2026-10-07..${TODAY}`,
    ]);
    expect(logEvents(ctx)).not.toContain('adapty_unexpected_unit'); // count charts' "count" unit is fine
    expectClean(ctx);
  });

  it('keeps the snapshot when an optional chart is refused, and logs it', async () => {
    const { fetch } = fakeFetch([snapshotRoutes({ trials_active: { status: 400, json: err400 } })]);
    const ctx = makeCtx(fetch);
    const snap = await adaptyAdapter.fetchSnapshot(input(), ctx);
    expect(snap.activeTrials).toBeNull();
    expect(snap.mrr).toEqual({ USD: 454567 });
    expect(snap.revenuePeriod).toEqual({ USD: 508410 });
    expect(ctx.logs.find((l) => l.event === 'adapty_snapshot_chart_unavailable')?.data).toEqual({
      chart: 'trials_active',
      reason: 'rejected',
      status: 400,
    });
  });

  it('skips the optional charts when the budget runs out', async () => {
    const { fetch, calls } = fakeFetch([snapshotRoutes()]);
    const ctx = makeCtx(fetch, { pageBudget: 2 });
    const snap = await adaptyAdapter.fetchSnapshot(input(), ctx);
    expect(snap).toMatchObject({ activeSubscriptions: 512, activeTrials: null, revenuePeriod: null, revenuePeriodDays: null });
    expect(calls).toHaveLength(2);
    expect(logEvents(ctx).filter((e) => e === 'adapty_snapshot_skipped')).toHaveLength(2);
  });

  it('fails the snapshot (instead of writing a false zero) when MRR can’t be read', async () => {
    const { fetch } = fakeFetch([snapshotRoutes({ mrr: { json: { data: { revenue: { title: 'mrr' } } } } })]);
    await expect(adaptyAdapter.fetchSnapshot(input(), makeCtx(fetch))).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('fails the snapshot on a transient error in a required chart', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([snapshotRoutes({ subscriptions_active: { status: 502, json: {} } })]);
    await expect(adaptyAdapter.fetchSnapshot(input(), makeCtx(fetch))).rejects.toMatchObject({ kind: 'upstream', status: 502 });
  });

  it('accepts a lone metric under any gross name, value_to, and a missing unit (USD)', async () => {
    const mrr = { data: { mrr: { value: null, value_to: 0.29, data: [] } } };
    const subs = { data: { subscriptions_active: { value: '3', data: [] } } };
    const { fetch } = fakeFetch([snapshotRoutes({ mrr: { json: mrr }, subscriptions_active: { json: subs } })]);
    const snap = await adaptyAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ USD: 29 }); // 0.29 * 100 = 28.999999999999996
    expect(snap.activeSubscriptions).toBe(3);
  });

  it('never reads an after-commission metric on its own', async () => {
    const { fetch } = fakeFetch([snapshotRoutes({ mrr: { json: { data: { proceeds: mrrChart.data.proceeds } } } })]);
    await expect(adaptyAdapter.fetchSnapshot(input(), makeCtx(fetch))).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('throws auth on 401', async () => {
    const { fetch } = fakeFetch([snapshotRoutes({ mrr: { status: 401, json: err401 } })]);
    expect(await catchErr(adaptyAdapter.fetchSnapshot(input(), makeCtx(fetch)))).toMatchObject({ kind: 'auth', field: 'apiKey' });
  });
});

// ---------------------------------------------------------------------------

describe('adapty fetchRevenue', () => {
  const SINCE = Date.parse('2026-10-30T08:15:00Z');

  const expected = [
    { day: '2026-10-30', currency: 'USD', gross: 12999, refunds: 0, count: 0 },
    { day: '2026-10-31', currency: 'USD', gross: 0, refunds: 0, count: 0 },
    { day: '2026-11-01', currency: 'USD', gross: 5549, refunds: 999, count: 0 }, // net 45.50 + 9.99 refunded
    { day: '2026-11-02', currency: 'USD', gross: 0, refunds: 0, count: 0 }, // absent from the series
    { day: '2026-11-03', currency: 'USD', gross: 999, refunds: 1498, count: 0 }, // net −4.99
    { day: '2026-11-04', currency: 'USD', gross: 1999, refunds: 0, count: 0 },
    { day: '2026-11-05', currency: 'USD', gross: 1234, refunds: 0, count: 0 }, // today, overwritten by later syncs
  ];

  /** Net revenue and refunds per day, for answers built per query. */
  const NET: Record<string, number> = { '2026-10-30': 129.99, '2026-11-01': 45.5, '2026-11-03': -4.99, '2026-11-04': 19.99, '2026-11-05': 12.34 };
  const REFUNDED: Record<string, number> = { '2026-11-01': 9.99, '2026-11-03': 14.98 };

  it('maps since → filters.date and combines revenue and refund_money per UTC day', async () => {
    const { fetch, calls } = fakeFetch([analytics({ revenue: { json: revenueChart }, refund_money: { json: refundChart } })]);
    const ctx = makeCtx(fetch);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page).toEqual<RevenuePage>({ events: [], daily: expected, nextCursor: null, done: true });
    expect(charts(calls)).toEqual([`revenue 2026-10-30..${TODAY}`, `refund_money 2026-10-30..${TODAY}`]);
    // gross − refunds reproduces Adapty's own (gross, refund-netted) revenue: 202.83, not proceeds or net revenue
    expect(page.daily.reduce((s, p) => s + p.gross - p.refunds, 0)).toBe(20283);
    expect(ctx.logs.find((l) => l.event === 'adapty_revenue_fetched')?.data).toEqual({
      windows: 1,
      refundWindows: 1,
      days: 7,
      perDay: false,
    });
    expectClean(ctx);
  });

  it('keeps net revenue exact with refunds = 0 when refund_money is unavailable', async () => {
    const { fetch, calls } = fakeFetch([analytics({ revenue: { json: revenueChart }, refund_money: { status: 400, json: err400 } })]);
    const ctx = makeCtx(fetch);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page.done).toBe(true);
    expect(page.daily.find((p) => p.day === '2026-11-01')).toEqual({ day: '2026-11-01', currency: 'USD', gross: 4550, refunds: 0, count: 0 });
    // a net-negative day can't have negative gross: the deficit shows up as refunds
    expect(page.daily.find((p) => p.day === '2026-11-03')).toEqual({ day: '2026-11-03', currency: 'USD', gross: 0, refunds: 499, count: 0 });
    expect(page.daily.reduce((s, p) => s + p.gross - p.refunds, 0)).toBe(20283);
    expect(calls).toHaveLength(2);
    expect(ctx.logs.find((l) => l.event === 'adapty_refunds_unavailable')?.data).toEqual({ reason: 'rejected', status: 400 });
  });

  it('degrades to an empty, finished page when the revenue chart is refused', async () => {
    const { fetch, calls } = fakeFetch([analytics({ revenue: { status: 403, json: err403 } })]);
    const ctx = makeCtx(fetch);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(calls).toHaveLength(1);
    expect(ctx.logs.find((l) => l.event === 'adapty_revenue_unavailable')?.data).toEqual({ reason: 'permission', status: 403 });
  });

  it('falls back to one-day queries and the documented value when the series shape is unknown', async () => {
    const unknownRows = (q: Query, value: number) => ({
      json: { data: { [q.chart_id === 'revenue' ? 'revenue' : 'common']: { value, unit: 'USD', data: [{ label: q.filters.date[0], amount: value }] } } },
    });
    const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    const { fetch, calls } = fakeFetch([
      analytics({
        revenue: (q) => unknownRows(q, q.filters.date[0] === q.filters.date[1] ? (NET[q.filters.date[0]] ?? 0) : sum(NET)),
        refund_money: (q) => unknownRows(q, REFUNDED[q.filters.date[0]] ?? 0),
      }),
    ]);
    const ctx = makeCtx(fetch);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page).toEqual<RevenuePage>({ events: [], daily: expected, nextCursor: null, done: true });
    expect(charts(calls).slice(0, 3)).toEqual([
      `revenue 2026-10-30..${TODAY}`,
      'revenue 2026-10-30..2026-10-30',
      'refund_money 2026-10-30..2026-10-30',
    ]);
    expect(calls).toHaveLength(1 + 7 * 2);
    // the shape is logged (key names and lengths), never the amounts
    expect(ctx.logs.find((l) => l.event === 'adapty_series_unreadable')?.data).toEqual({
      chart: 'revenue',
      metrics: 'revenue',
      rows: 1,
      row: 'amount,label',
      points: 'undefined',
      point: 'undefined',
    });
    expect(JSON.stringify(ctx.logs)).not.toContain('202.83');
    expect(ctx.logs.find((l) => l.event === 'adapty_revenue_fetched')?.data).toMatchObject({ perDay: true, days: 7 });
  });

  it('does not trust a series whose days don’t add up to the documented value', async () => {
    const wrong = clone(revenueChart);
    wrong.data.revenue.value = 999.99; // e.g. cumulative points, or a row that isn't the total
    const { fetch, calls } = fakeFetch([
      analytics({
        revenue: (q) => (q.filters.date[0] === q.filters.date[1] ? answer('revenue', NET[q.filters.date[0]] ?? 0, []) : { json: wrong }),
        refund_money: (q) => answer('common', REFUNDED[q.filters.date[0]] ?? 0, []),
      }),
    ]);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000, cursor: null }, makeCtx(fetch));
    expect(charts(calls)).toEqual([
      `revenue 2026-11-04..${TODAY}`,
      'revenue 2026-11-04..2026-11-04',
      'refund_money 2026-11-04..2026-11-04',
      `revenue ${TODAY}..${TODAY}`,
      `refund_money ${TODAY}..${TODAY}`,
    ]);
    expect(page.daily).toEqual(expected.slice(5));
  });

  it('in per-day mode, pauses with a cursor before a day it can’t finish', async () => {
    const { fetch, calls } = fakeFetch([
      analytics({
        revenue: (q) => (q.filters.date[0] === q.filters.date[1] ? answer('revenue', NET[q.filters.date[0]] ?? 0, []) : { json: { data: { revenue: { value: 1, data: [{}] } } } }),
        refund_money: (q) => answer('common', REFUNDED[q.filters.date[0]] ?? 0, []),
      }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 6 });
    const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page).toEqual<RevenuePage>({ events: [], daily: expected.slice(0, 2), nextCursor: '2026-11-01', done: false });
    expect(calls).toHaveLength(5);
    expect(ctx.logs.find((l) => l.event === 'adapty_revenue_paused')?.data).toEqual({ reason: 'budget', resumeFrom: '2026-11-01', days: 2 });
  });

  it('treats an empty answer as zero revenue for every day', async () => {
    const { fetch } = fakeFetch([analytics({ revenue: emptyAnswer(), refund_money: emptyAnswer('common') })]);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch));
    expect(page.daily).toHaveLength(7);
    expect(page.daily.every((p) => p.gross === 0 && p.refunds === 0)).toBe(true);
  });

  it('accepts datetime points and drops points outside the requested window', async () => {
    const body = answer('revenue', 1.5, [
      ['2026-11-04T00:00:00+00:00', 999], // outside [today, today]
      [`${TODAY}T00:00:00+00:00`, 1.5],
    ]);
    const { fetch } = fakeFetch([analytics({ revenue: body, refund_money: emptyAnswer('common') })]);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: NOW, cursor: null }, makeCtx(fetch));
    expect(page.daily).toEqual([{ day: TODAY, currency: 'USD', gross: 150, refunds: 0, count: 0 }]);
  });

  it('splits long ranges into 92-day windows and resumes from the cursor', async () => {
    const { fetch, calls } = fakeFetch([analytics({ revenue: emptyAnswer(), refund_money: emptyAnswer('common') })]);
    const since = Date.parse('2026-05-01T00:00:00Z'); // 189 days up to today
    const first = await adaptyAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch, { pageBudget: 3 }));
    expect(first).toMatchObject({ done: false, nextCursor: '2026-08-01' });
    expect(first.daily).toHaveLength(92);
    expect(first.daily[0]).toEqual({ day: '2026-05-01', currency: 'USD', gross: 0, refunds: 0, count: 0 });

    const second = await adaptyAdapter.fetchRevenue(input(), { since, cursor: first.nextCursor }, makeCtx(fetch, { pageBudget: 10 }));
    expect(second).toMatchObject({ done: true, nextCursor: null });
    expect(second.daily).toHaveLength(97);
    expect(second.daily.at(-1)?.day).toBe(TODAY);
    expect(charts(calls)).toEqual([
      'revenue 2026-05-01..2026-07-31',
      'refund_money 2026-05-01..2026-07-31',
      'revenue 2026-08-01..2026-10-31',
      'refund_money 2026-08-01..2026-10-31',
      `revenue 2026-11-01..${TODAY}`,
      `refund_money 2026-11-01..${TODAY}`,
    ]);
  });

  it('returns a cursor without calling when there isn’t budget for revenue and its refunds', async () => {
    for (const pageBudget of [0, 1]) {
      const { fetch, calls } = fakeFetch([]);
      const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch, { pageBudget }));
      expect(page).toEqual({ events: [], daily: [], nextCursor: '2026-10-30', done: false });
      expect(calls).toHaveLength(0);
    }
  });

  it('retries a 429 and spends one budget unit per logical request', async () => {
    const sleeps = recordSleeps();
    const { fetch, calls } = fakeFetch([
      analytics({ revenue: [{ status: 429, json: err429 }, { json: revenueChart }], refund_money: { json: refundChart } }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page.daily).toEqual(expected);
    expect(sleeps).toHaveLength(1); // no Retry-After from Adapty: fetchJson's backoff
    expect(calls).toHaveLength(3);
    expect(ctx.pageBudget).toBe(3);
  });

  it('throws rate_limit when 429s persist before anything was read', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([analytics({ revenue: { status: 429, json: err429 } })]);
    const err = await catchErr(adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('rate_limit');
  });

  it('keeps finished windows and pauses at the rate-limited one', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([
      analytics({
        revenue: (q) => (q.filters.date[0] === '2026-08-01' ? { status: 429, json: err429 } : emptyAnswer()),
        refund_money: emptyAnswer('common'),
      }),
    ]);
    const ctx = makeCtx(fetch);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: Date.parse('2026-05-01T00:00:00Z'), cursor: null }, ctx);
    expect(page).toMatchObject({ done: false, nextCursor: '2026-08-01' });
    expect(page.daily).toHaveLength(92);
    expect(ctx.logs.find((l) => l.event === 'adapty_revenue_paused')?.data).toMatchObject({ reason: 'rate_limit' });
  });

  it('throws upstream on persistent 5xx so the next sync retries the same range', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([analytics({ revenue: { status: 500, json: {} } })]);
    const err = await catchErr(adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: '2026-10-30' }, makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.status).toBe(500);
  });

  it('ignores a malformed cursor and returns nothing for a future since', async () => {
    const { fetch, calls } = fakeFetch([analytics({ revenue: { json: revenueChart }, refund_money: { json: refundChart } })]);
    const page = await adaptyAdapter.fetchRevenue(input(), { since: SINCE, cursor: 'garbage' }, makeCtx(fetch));
    expect(page.daily).toEqual(expected);

    const future = await adaptyAdapter.fetchRevenue(input(), { since: NOW + 3 * 86_400_000, cursor: null }, makeCtx(fetch));
    expect(future).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(calls).toHaveLength(2);
  });
});
