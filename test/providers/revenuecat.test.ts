import { describe, expect, it } from 'vitest';
import {
  CHARTS_PERMISSION_WARNING,
  CHARTS_UNSUPPORTED_WARNING,
  isoPeriodDays,
  RC_TRIALS_MISSING_WARNING,
  revenueCatAdapter,
} from '../../src/providers/revenuecat';
import { ProviderError, type ConnectionInput, type RevenuePage } from '../../src/providers/types';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, NOW, recordSleeps, route, type TestCtx } from '../fixtures/harness';
import overviewFixture from '../fixtures/revenuecat/overview.json';
import overviewPartialEur from '../fixtures/revenuecat/overview-partial-eur.json';
import revenueChart from '../fixtures/revenuecat/chart-revenue-day.json';
import refundsChart from '../fixtures/revenuecat/chart-refunds-day.json';
import err400 from '../fixtures/revenuecat/error-400.json';
import err401 from '../fixtures/revenuecat/error-401.json';
import err403 from '../fixtures/revenuecat/error-403.json';
import err404 from '../fixtures/revenuecat/error-404.json';
import err429 from '../fixtures/revenuecat/error-429.json';
import err500 from '../fixtures/revenuecat/error-500.json';

const KEY = 'sk_TESTsecret0123456789abcdefXYZ';
const PROJECT = 'proj1ab2c3d4';
const OVERVIEW = `/v2/projects/${PROJECT}/metrics/overview`;
const REVENUE = `/v2/projects/${PROJECT}/charts/revenue`;
const REFUNDS = `/v2/projects/${PROJECT}/charts/refunds`;
const TODAY = '2026-11-05'; // NOW = 2026-11-05T12:00:00Z

const input = (apiKey = KEY, projectId = PROJECT): ConnectionInput => ({
  credentials: { apiKey },
  config: { projectId },
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const dayQuery = (start: string, end: string) => ({
  resolution: '0',
  start_date: start,
  end_date: end,
  currency: 'USD',
  realtime: 'true',
});

/** A documented-shape day chart with no data points, echoing the requested range. */
const emptyChart = (displayName: string) => (url: URL) => ({
  json: {
    ...clone(revenueChart),
    display_name: displayName,
    start_date: Date.parse(`${url.searchParams.get('start_date')}T00:00:00Z`),
    end_date: Date.parse(`${url.searchParams.get('end_date')}T00:00:00Z`),
    values: [],
    summary: null,
  },
});

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
  expectNoSecretsInLogs(ctx, [KEY, 'sk_TESTsecret']);
}

// ---------------------------------------------------------------------------

describe('revenuecat input validation (no network)', () => {
  const cases: Array<[string, ConnectionInput, 'apiKey' | 'projectId', RegExp]> = [
    ['empty key', input(''), 'apiKey', /secret API key/],
    ['Apple public SDK key', input('appl_AbCdEfGhIjKlMnOpQrStUv'), 'apiKey', /public SDK key \(appl_…\).*sk_/],
    ['Google public SDK key', input('goog_AbCdEfGhIjKlMnOpQrStUv'), 'apiKey', /public SDK key \(goog_…\)/],
    ['Test Store key', input('test_AbCdEfGhIjKlMnOpQrStUv'), 'apiKey', /public SDK key/],
    ['project ID in the key field', input('proj1ab2c3d4'), 'apiKey', /looks like a Project ID/],
    ['Stripe-style key', input('rk_live_51Habcdefghijkl'), 'apiKey', /start with “sk_”/],
    ['truncated secret key', input('sk_abc'), 'apiKey', /complete RevenueCat secret key/],
    ['key with spaces inside', input('sk_abcdefgh ijklmnop'), 'apiKey', /complete RevenueCat secret key/],
    ['empty project', input(KEY, ''), 'projectId', /Project ID/],
    ['secret key in the project field', input(KEY, 'sk_OTHERsecret0123456789'), 'projectId', /looks like an API key/],
    ['dashboard URL as project', input(KEY, 'https://app.revenuecat.com/projects/1ab2c3d4/overview'), 'projectId', /not a URL/],
    ['path traversal in project', input(KEY, '../customers'), 'projectId', /not a URL/],
    ['odd characters in project', input(KEY, 'proj$1ab'), 'projectId', /doesn’t look like a RevenueCat Project ID/],
    ['over-long project', input(KEY, 'p'.repeat(256)), 'projectId', /doesn’t look like a RevenueCat Project ID/],
  ];

  it.each(cases)('rejects %s on the right field without calling RevenueCat', async (_name, inp, field, msg) => {
    const { fetch, calls } = fakeFetch([]);
    const ctx = makeCtx(fetch);
    const res = await revenueCatAdapter.verify(inp, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe(field);
    expect(res.error).toMatch(msg);
    expect(res.error).not.toContain('sk_OTHERsecret');
    expect(res.error).not.toContain('AbCdEfGh');
    expect(calls).toHaveLength(0);
  });

  it('trims surrounding whitespace before validating', async () => {
    const { fetch, calls } = fakeFetch([
      route(OVERVIEW, { json: overviewFixture }),
      route(REVENUE, emptyChart('Revenue')),
    ]);
    const res = await revenueCatAdapter.verify(input(`  ${KEY}\n`, ` ${PROJECT} `), makeCtx(fetch));
    expect(res.ok).toBe(true);
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
  });

  it('fetchSnapshot and fetchRevenue throw invalid_input without network', async () => {
    const { fetch, calls } = fakeFetch([]);
    const ctx = makeCtx(fetch);
    const e1 = await catchErr(revenueCatAdapter.fetchSnapshot(input('goog_abcdefghijklmnop'), ctx));
    expect(e1.kind).toBe('invalid_input');
    expect(e1.field).toBe('apiKey');
    const e2 = await catchErr(revenueCatAdapter.fetchRevenue(input(KEY, ''), { since: NOW, cursor: null }, ctx));
    expect(e2.kind).toBe('invalid_input');
    expect(e2.field).toBe('projectId');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('revenuecat verify', () => {
  it('succeeds with overview + one Charts probe, and records non-secret config', async () => {
    const { fetch, calls } = fakeFetch([
      route(OVERVIEW, { json: overviewFixture }, { query: { currency: 'USD' } }),
      route(REVENUE, emptyChart('Revenue'), { query: dayQuery(TODAY, TODAY) }),
    ]);
    const ctx = makeCtx(fetch);
    const res = await revenueCatAdapter.verify(input(), ctx);
    expect(res).toEqual({
      ok: true,
      accountLabel: 'RevenueCat project proj1ab2c3d4',
      config: { projectId: PROJECT, reportingCurrency: 'USD', revenueHistory: 'daily' },
      testMode: false,
      warnings: [],
    });
    expect(calls).toHaveLength(2); // contract: at most ~3
    for (const c of calls) {
      expect(c.url.startsWith('https://api.revenuecat.com/v2/projects/proj1ab2c3d4/')).toBe(true);
      expect(c.headers['authorization']).toBe(`Bearer ${KEY}`);
      expect(c.method).toBe('GET');
    }
    expectClean(ctx);
  });

  it('maps 401 to an apiKey error that explains v2 secret keys, without retrying', async () => {
    const { fetch, calls } = fakeFetch([route(OVERVIEW, { status: 401, json: err401 })]);
    const ctx = makeCtx(fetch);
    const res = await revenueCatAdapter.verify(input(), ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error).toMatch(/rejected the API key/);
    expect(res.error).toMatch(/v2/);
    expect(calls).toHaveLength(1);
    expectClean(ctx);
  });

  it('maps 403 to a permission error that names the exact scope', async () => {
    const { fetch, calls } = fakeFetch([route(OVERVIEW, { status: 403, json: err403 })]);
    const ctx = makeCtx(fetch);
    const res = await revenueCatAdapter.verify(input(), ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error).toContain('missing the “charts_metrics:overview:read” permission');
    expect(res.error).toMatch(/created in this project/);
    expect(calls).toHaveLength(1); // no Charts probe after a failed overview
    expectClean(ctx);
  });

  it('maps 404 (unknown project) to not_found on projectId', async () => {
    const { fetch, calls } = fakeFetch([route('/v2/projects/proj9z9z9z9z/metrics/overview', { status: 404, json: err404 })]);
    const res = await revenueCatAdapter.verify(input(KEY, 'proj9z9z9z9z'), makeCtx(fetch));
    expect(calls).toHaveLength(1); // 404 is not retried
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('projectId');
    expect(res.error).toMatch(/couldn’t find this project/);
    expect(res.error).not.toMatch(/add “proj”/);
  });

  it('on a 404 for an ID without the proj prefix, says to add it (dashboard URLs drop it)', async () => {
    const { fetch } = fakeFetch([route('/v2/projects/1ab2c3d4/metrics/overview', { status: 404, json: err404 })]);
    const res = await revenueCatAdapter.verify(input(KEY, '1ab2c3d4'), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('projectId');
    expect(res.error).toMatch(/add “proj” in front/);
  });

  it('rethrows 423 Locked on the overview, so the form shows "try again" instead of a key error', async () => {
    const { fetch } = fakeFetch([route(OVERVIEW, { status: 423, json: { type: 'resource_locked', message: 'Locked' } })]);
    const err = await catchErr(revenueCatAdapter.verify(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.status).toBeUndefined();
  });

  it('warns (but connects) when the key cannot read Charts', async () => {
    const { fetch, calls } = fakeFetch([
      route(OVERVIEW, { json: overviewFixture }),
      route(REVENUE, { status: 403, json: err403 }),
    ]);
    const ctx = makeCtx(fetch);
    const res = await revenueCatAdapter.verify(input(), ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings).toEqual([CHARTS_PERMISSION_WARNING]);
    expect(res.warnings[0]).toContain(
      "This key can’t read Charts, so hoomuch will show RevenueCat’s 28-day revenue total instead of a daily history.",
    );
    expect(res.warnings[0]).toContain('charts_metrics:charts:read');
    expect(res.config['revenueHistory']).toBe('none');
    expect(calls).toHaveLength(2);
    expect(logEvents(ctx)).toContain('revenuecat_charts_unavailable');
    expectClean(ctx);
  });

  it('warns differently when Charts rejects the daily request (400 parameter_error)', async () => {
    const { fetch } = fakeFetch([route(OVERVIEW, { json: overviewFixture }), route(REVENUE, { status: 400, json: err400 })]);
    const res = await revenueCatAdapter.verify(input(), makeCtx(fetch));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings).toEqual([CHARTS_UNSUPPORTED_WARNING]);
    expect(res.config['revenueHistory']).toBe('none');
  });

  it('does not fail verify when the Charts probe hits a transient error', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([route(OVERVIEW, { json: overviewFixture }), route(REVENUE, { status: 503, json: err500 })]);
    const res = await revenueCatAdapter.verify(input(), makeCtx(fetch));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config['revenueHistory']).toBeUndefined();
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/couldn’t check RevenueCat Charts access/);
  });

  it('rethrows upstream outages on the overview so the form shows "try again"', async () => {
    recordSleeps();
    const { fetch, calls } = fakeFetch([route(OVERVIEW, { status: 500, json: err500 })]);
    const err = await catchErr(revenueCatAdapter.verify(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(calls).toHaveLength(3); // retried by fetchJson
  });

  it('shows RevenueCat’s reason (no field) when it refuses the overview request itself (400)', async () => {
    const { fetch } = fakeFetch([route(OVERVIEW, { status: 400, json: { ...err400, param: 'project_id', message: 'Invalid project id' } })]);
    const res = await revenueCatAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({ ok: false, error: 'RevenueCat returned HTTP 400: Invalid project id' });
  });

  it('connects with an "unknown" Charts warning when only the overview fits the budget', async () => {
    const { fetch, calls } = fakeFetch([route(OVERVIEW, { json: overviewFixture })]);
    const res = await revenueCatAdapter.verify(input(), makeCtx(fetch, { pageBudget: 1 }));
    expect(res).toMatchObject({ ok: true, config: { projectId: PROJECT, reportingCurrency: 'USD' } });
    if (!res.ok) return;
    expect(res.config).not.toHaveProperty('revenueHistory'); // decided on the first sync, not guessed
    expect(res.warnings).toEqual([expect.stringMatching(/couldn’t check RevenueCat Charts access/)]);
    expect(calls).toHaveLength(1);
  });

  it('never reports test mode: API v2 secret keys are project-wide, with no sandbox variant', async () => {
    const { fetch } = fakeFetch([route(OVERVIEW, { json: overviewFixture }), route(REVENUE, emptyChart('Revenue'))]);
    const res = await revenueCatAdapter.verify(input(), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, testMode: false });
  });
});

// ---------------------------------------------------------------------------

describe('revenuecat fetchSnapshot', () => {
  it('maps the overview metrics, converting float dollars to integer cents', async () => {
    const { fetch, calls } = fakeFetch([route(OVERVIEW, { json: overviewFixture }, { query: { currency: 'USD' } })]);
    const ctx = makeCtx(fetch);
    const snap = await revenueCatAdapter.fetchSnapshot(input(), ctx);
    expect(snap).toEqual({
      mrr: { USD: 454567 }, // 4545.67 * 100 = 454566.99999999994 → rounded
      activeSubscriptions: 512,
      activeTrials: 34,
      revenuePeriod: { USD: 508410 }, // 5084.1
      revenuePeriodDays: 28, // from "P28D"
      newCustomers: 1290,
    });
    expect(calls).toHaveLength(1);
    expect(logEvents(ctx)).not.toContain('revenuecat_overview_missing_metrics');
    expectClean(ctx);
  });

  it('handles missing metrics and the reported (non-USD) currency', async () => {
    const { fetch } = fakeFetch([route(OVERVIEW, { json: overviewPartialEur })]);
    const ctx = makeCtx(fetch);
    const snap = await revenueCatAdapter.fetchSnapshot(input(), ctx);
    expect(snap).toEqual({
      mrr: { EUR: 29 }, // 0.29 * 100 = 28.999999999999996
      activeSubscriptions: 3,
      activeTrials: null,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      warnings: [RC_TRIALS_MISSING_WARNING], // the revenue and new-customer cards aren't snapshot figures: no warning
    });
    const missing = ctx.logs.find((l) => l.event === 'revenuecat_overview_missing_metrics');
    expect(missing?.data).toEqual({ missing: ['active_trials', 'revenue', 'new_customers'] });
    expect(RC_TRIALS_MISSING_WARNING.length).toBeLessThanOrEqual(200);
  });

  it('warns only about missing trials, not about a missing revenue or new-customers card', async () => {
    const body = { ...clone(overviewFixture), metrics: overviewFixture.metrics.filter((m) => m.id !== 'revenue' && m.id !== 'new_customers') };
    const { fetch } = fakeFetch([route(OVERVIEW, { json: body })]);
    const snap = await revenueCatAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.activeTrials).toBe(34);
    expect(snap.warnings).toBeUndefined();
  });

  it('fails the snapshot (instead of writing a false zero) when the overview lacks MRR or subscriptions', async () => {
    const { fetch } = fakeFetch([route(OVERVIEW, { json: { object: 'overview_metrics', metrics: [], currency: 'USD' } })]);
    await expect(revenueCatAdapter.fetchSnapshot(input(), makeCtx(fetch))).rejects.toMatchObject({ kind: 'upstream' });

    // Either one missing is enough: a 0 subscription count next to a real MRR is just as false.
    for (const keep of ['mrr', 'active_subscriptions']) {
      const body = { ...clone(overviewFixture), metrics: overviewFixture.metrics.filter((m) => m.id === keep) };
      const one = fakeFetch([route(OVERVIEW, { json: body })]);
      await expect(revenueCatAdapter.fetchSnapshot(input(), makeCtx(one.fetch))).rejects.toMatchObject({ kind: 'upstream' });
    }
  });

  it('respects zero-decimal currencies and the payload period', async () => {
    const body = clone(overviewFixture);
    body.currency = 'JPY';
    body.metrics.find((m) => m.id === 'mrr')!.value = 123456.4;
    body.metrics.find((m) => m.id === 'revenue')!.period = 'P30D';
    const { fetch } = fakeFetch([route(OVERVIEW, { json: body })]);
    const snap = await revenueCatAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ JPY: 123456 });
    expect(snap.revenuePeriodDays).toBe(30);
  });

  it('falls back to 28 days (and logs) when the revenue period is unparseable', async () => {
    const body = clone(overviewFixture);
    body.metrics.find((m) => m.id === 'revenue')!.period = 'P0D';
    const { fetch } = fakeFetch([route(OVERVIEW, { json: body })]);
    const ctx = makeCtx(fetch);
    const snap = await revenueCatAdapter.fetchSnapshot(input(), ctx);
    expect(snap.revenuePeriodDays).toBe(28);
    expect(logEvents(ctx)).toContain('revenuecat_unexpected_period');
  });

  it('rejects an unreadable payload as upstream', async () => {
    const { fetch } = fakeFetch([route(OVERVIEW, { json: { object: 'overview_metrics' } })]);
    const err = await catchErr(revenueCatAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
  });

  it('throws auth on 401 and not_found on projectId for 404', async () => {
    const a = fakeFetch([route(OVERVIEW, { status: 401, json: err401 })]);
    expect((await catchErr(revenueCatAdapter.fetchSnapshot(input(), makeCtx(a.fetch)))).kind).toBe('auth');
    const b = fakeFetch([route(OVERVIEW, { status: 404, json: err404 })]);
    const e = await catchErr(revenueCatAdapter.fetchSnapshot(input(), makeCtx(b.fetch)));
    expect(e.kind).toBe('not_found');
    expect(e.field).toBe('projectId');
  });

  it('parses ISO 8601 periods', () => {
    expect(isoPeriodDays('P28D')).toBe(28);
    expect(isoPeriodDays('P0D')).toBe(0);
    expect(isoPeriodDays('P4W')).toBe(28);
    expect(isoPeriodDays('PT1H')).toBeNull();
    expect(isoPeriodDays('P')).toBeNull();
    expect(isoPeriodDays(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('revenuecat fetchRevenue', () => {
  const SINCE = Date.parse('2026-10-30T08:15:00Z');

  const expectedWithRefunds = [
    { day: '2026-10-30', currency: 'USD', gross: 12999, refunds: 0, count: 7 },
    { day: '2026-10-31', currency: 'USD', gross: 0, refunds: 0, count: 0 }, // explicit zero (null count)
    { day: '2026-11-01', currency: 'USD', gross: 5549, refunds: 999, count: 3 }, // net 45.50 + 9.99 refunded
    { day: '2026-11-02', currency: 'USD', gross: 0, refunds: 0, count: 0 }, // absent from the payload
    { day: '2026-11-03', currency: 'USD', gross: 999, refunds: 1498, count: 1 }, // net −4.99
    { day: '2026-11-04', currency: 'USD', gross: 1999, refunds: 0, count: 1 },
    { day: '2026-11-05', currency: 'USD', gross: 1234, refunds: 0, count: 2 }, // incomplete today, kept
  ];

  it('maps since → start_date and combines the Revenue and Refunds charts per UTC day', async () => {
    const { fetch, calls } = fakeFetch([
      route(REVENUE, { json: revenueChart }, { query: dayQuery('2026-10-30', TODAY) }),
      route(REFUNDS, { json: refundsChart }, { query: dayQuery('2026-10-30', TODAY) }),
    ]);
    const ctx = makeCtx(fetch);
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page).toEqual<RevenuePage>({ events: [], daily: expectedWithRefunds, nextCursor: null, done: true });
    expect(calls).toHaveLength(2);
    // gross − refunds reproduces RevenueCat's own (net) revenue total: 202.83
    expect(page.daily.reduce((s, p) => s + p.gross - p.refunds, 0)).toBe(20283);
    const fetched = ctx.logs.find((l) => l.event === 'revenuecat_revenue_fetched');
    expect(fetched?.data).toEqual({ windows: 1, refundWindows: 1, days: 7, incompleteDays: 1 });
    expectClean(ctx);
  });

  it('keeps net revenue exact with refunds = 0 when the Refunds chart is unavailable', async () => {
    const { fetch, calls } = fakeFetch([
      route(REVENUE, { json: revenueChart }),
      route(REFUNDS, { status: 404, json: err404 }),
    ]);
    const ctx = makeCtx(fetch);
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page.done).toBe(true);
    expect(page.daily.find((p) => p.day === '2026-11-01')).toEqual({ day: '2026-11-01', currency: 'USD', gross: 4550, refunds: 0, count: 3 });
    // a net-negative day can't have negative gross: the deficit shows up as refunds
    expect(page.daily.find((p) => p.day === '2026-11-03')).toEqual({ day: '2026-11-03', currency: 'USD', gross: 0, refunds: 499, count: 1 });
    expect(page.daily.reduce((s, p) => s + p.gross - p.refunds, 0)).toBe(20283);
    expect(calls).toHaveLength(2);
    expect(logEvents(ctx)).toContain('revenuecat_refunds_unavailable');
  });

  it('degrades to an empty, finished page on a Charts 403 instead of failing the sync', async () => {
    const { fetch, calls } = fakeFetch([route(REVENUE, { status: 403, json: err403 })]);
    const ctx = makeCtx(fetch);
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(calls).toHaveLength(1); // no Refunds request after Revenue was refused
    const log = ctx.logs.find((l) => l.event === 'revenuecat_charts_unavailable');
    expect(log?.data).toEqual({ chart: 'revenue', reason: 'permission', status: 403 });
    expectClean(ctx);
  });

  it('degrades on a payload that is not the documented day/object shape', async () => {
    const legacy = { ...clone(revenueChart), values: [[1793318400, 129.99, 7]] };
    const weekly = { ...clone(revenueChart), resolution: 'week' };
    for (const body of [legacy, weekly]) {
      const { fetch } = fakeFetch([route(REVENUE, { json: body })]);
      const ctx = makeCtx(fetch);
      const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
      expect(page).toEqual({ events: [], daily: [], nextCursor: null, done: true });
      expect(ctx.logs.find((l) => l.event === 'revenuecat_charts_unavailable')?.data).toMatchObject({ reason: 'unreadable' });
    }
  });

  it('logs the shape (never the values) of an unreadable chart, so array rows can be diagnosed', async () => {
    const arrayRows = { ...clone(revenueChart), values: [[1793318400, 129.99, 7]] };
    const { fetch } = fakeFetch([route(REVENUE, { json: arrayRows })]);
    const ctx = makeCtx(fetch);
    await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    const shape = ctx.logs.find((l) => l.event === 'revenuecat_chart_unreadable')?.data;
    expect(shape).toEqual({ chart: 'revenue', resolution: 'day', values: 1, row: 'array(3)' });
    expect(JSON.stringify(ctx.logs)).not.toContain('129.99');
  });

  it('treats 423 Locked as temporary: thrown without a 4xx status, so a resumed backfill keeps its cursor', async () => {
    const { fetch, calls } = fakeFetch([route(REVENUE, { status: 423, json: { type: 'resource_locked', message: 'Locked' } })]);
    const err = await catchErr(revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: '2026-10-30' }, makeCtx(fetch)));
    expect(calls).toHaveLength(1);
    expect(err.kind).toBe('upstream');
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/HTTP 423/);
  });

  it('retries a 429 using RevenueCat backoff and spends one budget unit per logical request', async () => {
    const sleeps = recordSleeps();
    // No Retry-After header and a distinctive backoff_ms, so the sleep can only have come from the body.
    const { fetch, calls } = fakeFetch([
      route(REVENUE, [{ status: 429, json: { ...err429, backoff_ms: 2500 } }, { json: revenueChart }]),
      route(REFUNDS, { json: refundsChart }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page.daily).toEqual(expectedWithRefunds);
    expect(sleeps).toEqual([2500]);
    expect(calls).toHaveLength(3);
    expect(ctx.pageBudget).toBe(3);
  });

  it('throws a revoked key (401) on Charts instead of finishing the backfill with no history', async () => {
    const { fetch, calls } = fakeFetch([route(REVENUE, { status: 401, json: err401 })]);
    const err = await catchErr(revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: '2026-10-30' }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'auth', status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('labels points with the chart’s reported currency, and ignores a Refunds chart in another currency', async () => {
    const eurRevenue = { ...clone(revenueChart), yaxis_currency: 'EUR' };
    const { fetch } = fakeFetch([route(REVENUE, { json: eurRevenue }), route(REFUNDS, { json: refundsChart })]); // refunds: USD
    const ctx = makeCtx(fetch);
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page.daily.map((p) => p.currency)).toEqual(Array(7).fill('EUR'));
    // USD refunds must not be mixed into EUR revenue: net stays exact, refunds only where the net is negative.
    expect(page.daily.find((p) => p.day === '2026-11-01')).toEqual({ day: '2026-11-01', currency: 'EUR', gross: 4550, refunds: 0, count: 3 });
    expect(page.daily.find((p) => p.day === '2026-11-03')).toEqual({ day: '2026-11-03', currency: 'EUR', gross: 0, refunds: 499, count: 1 });
    expect(ctx.logs.find((l) => l.event === 'revenuecat_refunds_unavailable')?.data).toEqual({ reason: 'currency_mismatch', status: null });
  });

  it('throws rate_limit (not a silent fallback) when the 429s persist', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([route(REVENUE, { status: 429, json: err429 })]);
    const err = await catchErr(revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('rate_limit');
  });

  it('throws upstream on persistent 5xx so the next sync retries the same range', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([route(REVENUE, { status: 500, json: err500 })]);
    const err = await catchErr(revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
  });

  it('skips the Refunds chart when only one request of budget is left', async () => {
    const { fetch, calls } = fakeFetch([route(REVENUE, { json: revenueChart })]);
    const ctx = makeCtx(fetch, { pageBudget: 1 });
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page.done).toBe(true);
    // Without Refunds, each day is RevenueCat's net revenue; only the net-negative day shows a refund.
    expect(page.daily).toEqual([
      { day: '2026-10-30', currency: 'USD', gross: 12999, refunds: 0, count: 7 },
      { day: '2026-10-31', currency: 'USD', gross: 0, refunds: 0, count: 0 },
      { day: '2026-11-01', currency: 'USD', gross: 4550, refunds: 0, count: 3 },
      { day: '2026-11-02', currency: 'USD', gross: 0, refunds: 0, count: 0 },
      { day: '2026-11-03', currency: 'USD', gross: 0, refunds: 499, count: 1 },
      { day: '2026-11-04', currency: 'USD', gross: 1999, refunds: 0, count: 1 },
      { day: '2026-11-05', currency: 'USD', gross: 1234, refunds: 0, count: 2 },
    ]);
    expect(calls).toHaveLength(1);
    expect(logEvents(ctx)).toContain('revenuecat_refunds_skipped');
  });

  it('returns a cursor without calling when the budget is already spent', async () => {
    const { fetch, calls } = fakeFetch([]);
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch, { pageBudget: 0 }));
    expect(page).toEqual({ events: [], daily: [], nextCursor: '2026-10-30', done: false });
    expect(calls).toHaveLength(0);
  });

  it('splits long ranges into windows and resumes from the cursor', async () => {
    const { fetch, calls } = fakeFetch([
      route(REVENUE, emptyChart('Revenue')),
      route(REFUNDS, emptyChart('Refunds')),
    ]);
    const since = Date.parse('2025-09-01T00:00:00Z'); // 431 days before today
    const first = await revenueCatAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch, { pageBudget: 2 }));
    expect(first.done).toBe(false);
    expect(first.nextCursor).toBe('2026-09-02');
    expect(first.daily).toHaveLength(366);
    expect(first.daily[0]).toEqual({ day: '2025-09-01', currency: 'USD', gross: 0, refunds: 0, count: 0 });
    expect(new URL(calls[0]!.url).searchParams.get('start_date')).toBe('2025-09-01');
    expect(new URL(calls[0]!.url).searchParams.get('end_date')).toBe('2026-09-01');

    const second = await revenueCatAdapter.fetchRevenue(
      input(),
      { since, cursor: first.nextCursor },
      makeCtx(fetch, { pageBudget: 10 }),
    );
    expect(second.done).toBe(true);
    expect(second.nextCursor).toBeNull();
    expect(second.daily.map((p) => p.day)).toEqual(expect.arrayContaining(['2026-09-02', TODAY]));
    expect(second.daily).toHaveLength(65);
    expect(new URL(calls[2]!.url).searchParams.get('start_date')).toBe('2026-09-02');
    expect(new URL(calls[2]!.url).searchParams.get('end_date')).toBe(TODAY);
  });

  it('ignores a malformed cursor and returns nothing for a future since', async () => {
    const { fetch, calls } = fakeFetch([
      route(REVENUE, { json: revenueChart }, { query: dayQuery('2026-10-30', TODAY) }),
      route(REFUNDS, { json: refundsChart }),
    ]);
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: SINCE, cursor: 'garbage' }, makeCtx(fetch));
    expect(page.daily).toHaveLength(7);

    const future = await revenueCatAdapter.fetchRevenue(
      input(),
      { since: NOW + 3 * 86_400_000, cursor: null },
      makeCtx(fetch),
    );
    expect(future).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(calls).toHaveLength(2);
  });

  it('finds the money and count measures by unit/name, not by position', async () => {
    const body = clone(revenueChart);
    body.measures = [revenueChart.measures[1]!, revenueChart.measures[0]!]; // Transactions (#) first, Revenue ($) second
    body.values = [
      { cohort: 1793836800, incomplete: true, measure: 0, value: 2 },
      { cohort: 1793836800, incomplete: true, measure: 1, value: 12.34 },
    ];
    const { fetch } = fakeFetch([route(REVENUE, { json: body }), route(REFUNDS, emptyChart('Refunds'))]);
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: NOW, cursor: null }, makeCtx(fetch));
    expect(page.daily).toEqual([{ day: TODAY, currency: 'USD', gross: 1234, refunds: 0, count: 2 }]);
  });

  it('accepts millisecond cohorts and drops points outside the requested window', async () => {
    const body = clone(revenueChart);
    body.values = [
      { cohort: 1793232000000, incomplete: false, measure: 0, value: 999 }, // 2026-10-29: outside
      { cohort: 1793836800000, incomplete: true, measure: 0, value: 1.5 },
      { cohort: 1793836800000, incomplete: true, measure: 1, value: 1 },
    ];
    const { fetch } = fakeFetch([
      route(REVENUE, { json: body }, { query: dayQuery(TODAY, TODAY) }),
      route(REFUNDS, emptyChart('Refunds')),
    ]);
    const page = await revenueCatAdapter.fetchRevenue(input(), { since: NOW, cursor: null }, makeCtx(fetch));
    expect(page.daily).toEqual([{ day: TODAY, currency: 'USD', gross: 150, refunds: 0, count: 1 }]);
  });
});
