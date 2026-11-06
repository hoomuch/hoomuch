import { describe, expect, it } from 'vitest';
import {
  DATA_PERMISSION_WARNING,
  RESTRICTED_PROJECTS_WARNING,
  REVENUE_SQL,
  SW_MRR_CHART_PARTIAL_WARNING,
  SW_RESTRICTED_PROJECTS_WARNING,
  SW_SUBSCRIPTIONS_CHART_PARTIAL_WARNING,
  SW_TRIALS_PERMISSION_WARNING,
  SW_TRIALS_SKIPPED_WARNING,
  TRIALS_SQL,
  superwallAdapter,
} from '../../src/providers/superwall';
import { ProviderError, type ConnectionInput } from '../../src/providers/types';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, NOW, route, type RecordedCall, type TestCtx } from '../fixtures/harness';
import definitionsFixture from '../fixtures/superwall/definitions.json';
import mrrChart from '../fixtures/superwall/chart-mrr.json';
import subsChart from '../fixtures/superwall/chart-active-subscriptions.json';
import revenueRows from '../fixtures/superwall/query-revenue.json';
import trialsRows from '../fixtures/superwall/query-trials.json';
import err400Chart from '../fixtures/superwall/error-400-chart.json';
import err401 from '../fixtures/superwall/error-401.json';
import err403 from '../fixtures/superwall/error-403.json';
import err403Data from '../fixtures/superwall/error-403-data.json';
import err404 from '../fixtures/superwall/error-404.json';
import err429 from '../fixtures/superwall/error-429.json';

const KEY = 'sk_TESTsecret0123456789abcdefXYZ';
const ORG = '123';
const DEFS = '/v2/charts/definitions';
const DATA = '/v2/charts/data';
const QUERY = `/v2/organizations/${ORG}/query`;
const TODAY = '2026-11-05'; // NOW = 2026-11-05T12:00:00Z

const input = (apiKey = KEY, organizationId = ORG, extra: Record<string, string> = {}): ConnectionInput => ({
  credentials: { apiKey },
  config: { organizationId, ...extra },
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Json = Record<string, unknown>;

/** POST /v2/charts/data: answers with the MRR or Active Subscriptions fixture, by the requested metric. */
const chartData =
  (overrides: { mrr?: unknown; subs?: unknown } = {}) =>
  (_url: URL, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as Json;
    if (body['y_axis'] === 'mrrValue') return { json: overrides.mrr ?? mrrChart };
    if (body['y_axis'] === 'activeSubscriptionCount') return { json: overrides.subs ?? subsChart };
    return { status: 400, json: err400Chart };
  };

/** GET …/query: answers by statement, so a test fails loudly if the adapter sends anything else. */
const queryData =
  (answers: { revenue?: unknown; trials?: unknown } = {}) =>
  (url: URL) => {
    const q = url.searchParams.get('query');
    if (q === REVENUE_SQL) return { json: answers.revenue ?? revenueRows };
    if (q === TRIALS_SQL) return { json: answers.trials ?? trialsRows };
    return { status: 400, body: 'Code: 62. DB::Exception: Syntax error' };
  };

const emptyRevenue = { meta: clone(revenueRows.meta), data: [], rows: 0 };

const okRoutes = (answers: Parameters<typeof queryData>[0] = {}) => [
  route(DEFS, { json: definitionsFixture }, { query: { organization_id: ORG } }),
  route(DATA, chartData(), { method: 'POST' }),
  route(QUERY, queryData(answers)),
];

async function catchErr(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProviderError) return e;
    throw e;
  }
  throw new Error('expected a ProviderError');
}

const bodyOf = (c: RecordedCall): Json => JSON.parse(c.body ?? 'null') as Json;
const paramsOf = (c: RecordedCall) => new URL(c.url).searchParams;
const logEvents = (ctx: TestCtx) => ctx.logs.map((l) => l.event);

function expectClean(ctx: TestCtx): void {
  expectNoSecretsInLogs(ctx, [KEY, 'sk_TESTsecret']);
}

// ---------------------------------------------------------------------------

describe('superwall input validation (no network)', () => {
  const cases: Array<[string, ConnectionInput, 'apiKey' | 'organizationId', RegExp]> = [
    ['empty key', input(''), 'apiKey', /organization API key/],
    ['public SDK key', input('pk_AbCdEfGhIjKlMnOpQrStUv'), 'apiKey', /public API key \(pk_…\)/],
    ['organization ID in the key field', input('123456'), 'apiKey', /looks like an Organization ID/],
    ['truncated key', input('sk_abc'), 'apiKey', /complete Superwall API key/],
    ['key with spaces inside', input('sk_abcdefgh ijklmnopqr'), 'apiKey', /complete Superwall API key/],
    ['empty organization', input(KEY, ''), 'organizationId', /Organization ID/],
    ['key in the organization field', input(KEY, 'sk_OTHERsecret0123456789'), 'organizationId', /looks like an API key/],
    ['slug instead of a number', input(KEY, 'habit-owl'), 'organizationId', /numbers, like 1234/],
    ['path traversal', input(KEY, '../me'), 'organizationId', /numbers, like 1234/],
    ['another site’s URL', input(KEY, 'https://example.com/123/charts'), 'organizationId', /numbers, like 1234/],
  ];

  it.each(cases)('rejects %s on the right field without calling Superwall', async (_name, inp, field, msg) => {
    const { fetch, calls } = fakeFetch([]);
    const res = await superwallAdapter.verify(inp, makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe(field);
    expect(res.error).toMatch(msg);
    expect(res.error).not.toContain('sk_OTHERsecret');
    expect(res.error).not.toContain('AbCdEfGh');
    expect(calls).toHaveLength(0);
  });

  it('takes the Organization ID out of a pasted dashboard address, and trims whitespace', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await superwallAdapter.verify(input(`  ${KEY}\n`, ' https://app.superwall.com/123/audit-log '), makeCtx(fetch));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config['organizationId']).toBe('123');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
  });

  it('fetchSnapshot and fetchRevenue throw invalid_input without network', async () => {
    const { fetch, calls } = fakeFetch([]);
    const ctx = makeCtx(fetch);
    const e1 = await catchErr(superwallAdapter.fetchSnapshot(input('pk_abcdefghijklmnopqrst'), ctx));
    expect(e1.kind).toBe('invalid_input');
    expect(e1.field).toBe('apiKey');
    const e2 = await catchErr(superwallAdapter.fetchRevenue(input(KEY, ''), { since: NOW, cursor: null }, ctx));
    expect(e2.kind).toBe('invalid_input');
    expect(e2.field).toBe('organizationId');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('superwall SQL', () => {
  const statements: Array<[string, string]> = [
    ['revenue', REVENUE_SQL],
    ['trials', TRIALS_SQL],
  ];

  it.each(statements)('the %s statement is one constant, read-only SELECT', (_name, statement) => {
    expect(statement.startsWith('SELECT ')).toBe(true);
    expect(statement).not.toContain(';');
    expect(statement).not.toMatch(/\b(INSERT|ALTER|DROP|CREATE|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE|SYSTEM|OPTIMIZE|KILL|ATTACH|DETACH|SETTINGS|FORMAT|INTO)\b/i);
    expect(statement).not.toContain('$$');
    // Only the documented revenue table, read with FINAL (it's deduplicated in the background).
    expect(statement.match(/\bFROM\s+[a-z_]+\.[a-z_]+/g)).toEqual(['FROM open_revenue.attributed_events_by_ts_rep']);
    expect(statement).toContain('attributed_events_by_ts_rep FINAL');
    expect(statement).toContain('isSandbox = 0');
    // Aggregates only: no end-user identifiers or attributes are ever selected.
    expect(statement).not.toMatch(/appUserId|vendorId|userAttributes|countryCode|headers|meta|props/);
  });

  it('takes dates only as ClickHouse parameters', () => {
    expect(REVENUE_SQL).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(REVENUE_SQL.match(/\{[a-z_]+:[A-Za-z0-9]+\}/g)).toEqual(['{scan_from:Date}', '{day_after:Date}', '{day_from:Date}']);
    expect(TRIALS_SQL).not.toMatch(/\{/);
  });

  // ClickHouse's toInt64 truncates a Float64 toward zero, so a $19.99 day would become 1998
  // (19.99 * 100 = 1998.9999999999998). Static check: the statement only runs in ClickHouse.
  it('rounds dollar sums to cents before the Int64 cast instead of truncating them', () => {
    expect(19.99 * 100).toBeLessThan(1999); // the float behaviour this guards against
    const casts = REVENUE_SQL.match(/toInt64\(\s*\w*/g) ?? [];
    expect(casts).toHaveLength(2); // gross and refunds
    expect(casts.filter((c) => !/^toInt64\(\s*round/i.test(c))).toEqual([]);
    expect(REVENUE_SQL).toContain('toInt64(round(sumIf(amount, isCharge) * 100)) AS gross_minor');
    expect(REVENUE_SQL).toContain('toInt64(round(sumIf(amount, NOT isCharge) * -100)) AS refunds_minor');
  });
});

// ---------------------------------------------------------------------------

describe('superwall verify', () => {
  it('reads definitions, probes the MRR chart and the query API, and records non-secret config', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const ctx = makeCtx(fetch);
    const res = await superwallAdapter.verify(input(), ctx);
    expect(res).toEqual({
      ok: true,
      accountLabel: 'Superwall: Habit Owl',
      config: { organizationId: ORG, reportingCurrency: 'USD', revenueHistory: 'daily' },
      testMode: false,
      warnings: [],
    });
    expect(calls).toHaveLength(3); // contract: at most ~4
    for (const c of calls) {
      expect(c.url.startsWith('https://api.superwall.com/v2/')).toBe(true);
      expect(c.headers['authorization']).toBe(`Bearer ${KEY}`);
    }
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);

    // The chart request uses the keys the definitions list, never guessed ones.
    expect(bodyOf(calls[1]!)).toEqual({
      organization_id: ORG,
      y_axis: 'mrrValue',
      x_axis: 'mrrDate',
      breakdown: null,
      date_filter: { dimension: 'mrrDate', preset: 'last_7_days' },
      date_interval: 'day',
      environment: ['PRODUCTION'],
    });
    expect(calls[1]!.headers['content-type']).toBe('application/json');

    // The probe is today's revenue query: constant SQL, dates as parameters, a GET (read-only in ClickHouse).
    const p = paramsOf(calls[2]!);
    expect(p.get('query')).toBe(REVENUE_SQL);
    expect(p.get('default_format')).toBe('JSON');
    expect(p.get('wait_end_of_query')).toBe('1');
    expect(p.get('param_scan_from')).toBe('2026-11-04');
    expect(p.get('param_day_from')).toBe(TODAY);
    expect(p.get('param_day_after')).toBe('2026-11-06');
    expect(calls[2]!.body).toBeUndefined();
    expectClean(ctx);
  });

  it('maps 401 to an apiKey error, without retrying', async () => {
    const { fetch, calls } = fakeFetch([route(DEFS, { status: 401, json: err401 })]);
    const ctx = makeCtx(fetch);
    const res = await superwallAdapter.verify(input(), ctx);
    expect(res).toMatchObject({ ok: false, field: 'apiKey' });
    if (res.ok) return;
    expect(res.error).toMatch(/rejected the API key/);
    expect(res.error).toMatch(/Settings → API Keys/);
    expect(calls).toHaveLength(1);
    expectClean(ctx);
  });

  it('maps 403 to a permission error that names the scope Superwall asked for', async () => {
    const { fetch, calls } = fakeFetch([route(DEFS, { status: 403, json: err403 })]);
    const res = await superwallAdapter.verify(input(), makeCtx(fetch));
    expect(res).toMatchObject({ ok: false, field: 'apiKey' });
    if (res.ok) return;
    expect(res.error).toContain('missing the “charts:read” permission');
    expect(res.error).toMatch(/belongs to this organization/);
    expect(calls).toHaveLength(1); // nothing else after a failed definitions call
  });

  it('maps 404 (unknown organization) to not_found on organizationId', async () => {
    const { fetch, calls } = fakeFetch([route(DEFS, { status: 404, json: err404 })]);
    const res = await superwallAdapter.verify(input(KEY, '999999'), makeCtx(fetch));
    expect(calls).toHaveLength(1); // 404 is not retried
    expect(res).toMatchObject({ ok: false, field: 'organizationId' });
    if (res.ok) return;
    expect(res.error).toMatch(/couldn’t find this organization/);
    expect(res.error).toMatch(/app\.superwall\.com\//);
  });

  it('fails clearly when the organization lists no MRR chart, without querying chart data', async () => {
    const defs = clone(definitionsFixture);
    defs.chart_types = defs.chart_types.filter((c) => c.name !== 'MRR');
    const { fetch, calls } = fakeFetch([route(DEFS, { json: defs })]);
    const ctx = makeCtx(fetch);
    const res = await superwallAdapter.verify(input(), ctx);
    expect(res).toEqual({ ok: false, error: 'Superwall didn’t list its MRR chart for this organization, so hoomuch can’t read it.' });
    expect(calls).toHaveLength(1);
    expect(logEvents(ctx)).toContain('superwall_charts_missing');
  });

  it('shows Superwall’s reason when it refuses the chart request (400)', async () => {
    const { fetch } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, { status: 400, json: err400Chart }, { method: 'POST' }),
    ]);
    const res = await superwallAdapter.verify(input(), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/HTTP 400: Unknown y_axis metric/);
  });

  it('without data:read, connects with a warning and records that daily revenue is unavailable', async () => {
    const { fetch, calls } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, chartData(), { method: 'POST' }),
      route(QUERY, { status: 403, json: err403Data }),
    ]);
    const ctx = makeCtx(fetch);
    const res = await superwallAdapter.verify(input(), ctx);
    expect(res).toMatchObject({
      ok: true,
      config: { organizationId: ORG, reportingCurrency: 'USD', revenueHistory: 'none' },
      warnings: [DATA_PERMISSION_WARNING],
    });
    expect(calls).toHaveLength(3);
    expect(logEvents(ctx)).toContain('superwall_query_probe_failed');
  });

  it('when the query API is down, connects with a "will retry" warning and leaves revenueHistory unset', async () => {
    const { fetch, calls } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, chartData(), { method: 'POST' }),
      route(QUERY, { status: 500, body: 'Code: 241. DB::Exception: Memory limit exceeded' }),
    ]);
    const res = await superwallAdapter.verify(input(), makeCtx(fetch));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config['revenueHistory']).toBeUndefined();
    expect(res.warnings).toEqual([expect.stringMatching(/try again on the first sync/)]);
    expect(calls).toHaveLength(4); // the slow query is attempted twice, not three times
  });

  it('warns about restricted project access and partial chart coverage, and labels by organization', async () => {
    const defs = clone(definitionsFixture) as unknown as { chart_types: Json[]; scope: Json };
    defs.scope['all_projects'] = false;
    defs.scope['projects'] = [
      { id: 1, name: 'Habit Owl' },
      { id: 2, name: 'Sleep Owl' },
    ];
    const mrr = defs.chart_types.find((c) => c['name'] === 'MRR')!;
    mrr['availability'] = { status: 'partial', application_ids: [456], reason: 'Web apps have no MRR yet' };
    const { fetch } = fakeFetch([
      route(DEFS, { json: defs }),
      route(DATA, chartData(), { method: 'POST' }),
      route(QUERY, queryData()),
    ]);
    const res = await superwallAdapter.verify(input(), makeCtx(fetch));
    expect(res).toMatchObject({
      ok: true,
      accountLabel: 'Superwall organization 123',
      warnings: ['Superwall’s MRR chart covers only some of this organization’s apps: Web apps have no MRR yet', RESTRICTED_PROJECTS_WARNING],
    });
  });

  it('rethrows rate limits so the form shows a generic "try again"', async () => {
    const { fetch } = fakeFetch([route(DEFS, { status: 429, json: err429, headers: { 'retry-after': '0' } })]);
    const e = await catchErr(superwallAdapter.verify(input(), makeCtx(fetch)));
    expect(e.kind).toBe('rate_limit');
  });
});

// ---------------------------------------------------------------------------

describe('superwall fetchSnapshot', () => {
  it('reads MRR and active subscriptions from Superwall’s charts and trials from the query API', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const ctx = makeCtx(fetch);
    const snap = await superwallAdapter.fetchSnapshot(input(KEY, ORG, { revenueHistory: 'daily' }), ctx);
    expect(snap).toEqual({
      mrr: { USD: 407189 },
      activeSubscriptions: 409,
      activeTrials: 57,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
    });
    expect(calls).toHaveLength(4);
    expect(bodyOf(calls[1]!)['y_axis']).toBe('mrrValue');
    expect(bodyOf(calls[2]!)).toMatchObject({
      y_axis: 'activeSubscriptionCount',
      x_axis: 'mrrDate',
      breakdown: null, // the chart's default country breakdown is not applied
      environment: ['PRODUCTION'],
    });
    expect(paramsOf(calls[3]!).get('query')).toBe(TRIALS_SQL);
    expectClean(ctx);
  });

  it('skips the trials query for a key verify found without data:read', async () => {
    const { fetch, calls } = fakeFetch([route(DEFS, { json: definitionsFixture }), route(DATA, chartData(), { method: 'POST' })]);
    const snap = await superwallAdapter.fetchSnapshot(input(KEY, ORG, { revenueHistory: 'none' }), makeCtx(fetch));
    expect(snap.activeTrials).toBeNull();
    expect(snap.mrr).toEqual({ USD: 407189 });
    expect(calls).toHaveLength(3);
    expect(snap.warnings).toEqual([SW_TRIALS_PERMISSION_WARNING]);
  });

  it('reports trials as unknown (null) when the query API refuses, and still returns the snapshot', async () => {
    const { fetch } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, chartData(), { method: 'POST' }),
      route(QUERY, { status: 403, json: err403Data }),
    ]);
    const ctx = makeCtx(fetch);
    const snap = await superwallAdapter.fetchSnapshot(input(), ctx);
    expect(snap.activeTrials).toBeNull();
    expect(snap.activeSubscriptions).toBe(409);
    expect(logEvents(ctx)).toContain('superwall_trials_unavailable');
    expect(snap.warnings).toEqual([SW_TRIALS_PERMISSION_WARNING]);
    expectClean(ctx);
  });

  it('says trials are skipped this time when the trials query fails for another reason', async () => {
    const { fetch } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, chartData(), { method: 'POST' }),
      route(QUERY, { status: 400, body: 'Code: 62. DB::Exception: Syntax error' }),
    ]);
    const snap = await superwallAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.activeTrials).toBeNull();
    expect(snap.warnings).toEqual([SW_TRIALS_SKIPPED_WARNING]);
    expect(JSON.stringify(snap.warnings)).not.toMatch(/DB::Exception/); // never Superwall's raw answer
  });

  it('warns about restricted project access and partial chart coverage in fixed words, never Superwall’s reason', async () => {
    const defs = clone(definitionsFixture) as unknown as { chart_types: Json[]; scope: Json };
    defs.scope['all_projects'] = false;
    for (const c of defs.chart_types) {
      if (c['name'] === 'MRR') c['availability'] = { status: 'partial', application_ids: [456], reason: 'Web apps have no MRR yet' };
      if (c['name'] === 'Active Subscriptions') c['availability'] = { status: 'unavailable', reason: 'Not yet' };
    }
    const { fetch } = fakeFetch([route(DEFS, { json: defs }), route(DATA, chartData(), { method: 'POST' }), route(QUERY, queryData())]);
    const snap = await superwallAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.warnings).toEqual([SW_RESTRICTED_PROJECTS_WARNING, SW_MRR_CHART_PARTIAL_WARNING, SW_SUBSCRIPTIONS_CHART_PARTIAL_WARNING]);
    expect(JSON.stringify(snap.warnings)).not.toMatch(/Web apps|Not yet/);
    for (const w of [SW_RESTRICTED_PROJECTS_WARNING, SW_MRR_CHART_PARTIAL_WARNING, SW_SUBSCRIPTIONS_CHART_PARTIAL_WARNING, SW_TRIALS_PERMISSION_WARNING, SW_TRIALS_SKIPPED_WARNING]) {
      expect(w.length).toBeLessThanOrEqual(200);
      expect(w).toMatch(/\.$/);
    }
  });

  it('reports trials as unknown when Superwall has no store or RevenueCat events at all', async () => {
    const noData = { ...clone(trialsRows), data: [{ active_trials: '0', subscriptions: '0' }] };
    const { fetch } = fakeFetch(okRoutes({ trials: noData }));
    const snap = await superwallAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.activeTrials).toBeNull();
    expect(snap.warnings).toBeUndefined(); // nothing in hoomuch changes it
  });

  it('keeps yesterday’s value when today’s point hasn’t been computed yet (no false drop to zero)', async () => {
    const mrr = clone(mrrChart);
    mrr.data[6]!.values = {} as typeof mrr.data[6]['values'];
    const subs = clone(subsChart);
    subs.data[6]!.values.null.y = 0;
    const { fetch } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, chartData({ mrr, subs }), { method: 'POST' }),
      route(QUERY, queryData()),
    ]);
    const ctx = makeCtx(fetch);
    const snap = await superwallAdapter.fetchSnapshot(input(), ctx);
    expect(snap.mrr).toEqual({ USD: 406620 });
    expect(snap.activeSubscriptions).toBe(408);
    expect(logEvents(ctx).filter((e) => e === 'superwall_chart_used_last_complete_day')).toHaveLength(2);
    expect(snap.warnings).toBeUndefined(); // normal until Superwall computes today's point
  });

  it('adds up series if Superwall answers with a breakdown, and ignores future points', async () => {
    const mrr = clone(mrrChart) as unknown as { data: Json[] };
    mrr.data[6] = { x: '2026-11-05T00:00:00.000Z', incomplete: true, values: { US: { y: 3000.5, extra: {} }, DE: { y: 1000.25, extra: {} } } };
    mrr.data.push({ x: '2026-11-06', incomplete: true, values: { US: { y: 1, extra: {} } } });
    const { fetch } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, chartData({ mrr }), { method: 'POST' }),
      route(QUERY, queryData()),
    ]);
    const snap = await superwallAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ USD: 400075 });
  });

  it('a chart with no points reads as zero (an organization with no subscriptions yet)', async () => {
    const empty = { ...clone(mrrChart), data: [] };
    const { fetch } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, chartData({ mrr: empty, subs: { ...clone(subsChart), data: [] } }), { method: 'POST' }),
      route(QUERY, queryData()),
    ]);
    const ctx = makeCtx(fetch);
    const snap = await superwallAdapter.fetchSnapshot(input(), ctx);
    expect(snap.mrr).toEqual({ USD: 0 });
    expect(snap.activeSubscriptions).toBe(0);
    expect(logEvents(ctx)).toContain('superwall_chart_empty');
    expect(snap.warnings).toBeUndefined();
  });

  it('fails (keeping the previous snapshot) on a chart it can’t read', async () => {
    const { fetch } = fakeFetch([
      route(DEFS, { json: definitionsFixture }),
      route(DATA, chartData({ mrr: { object: 'chart_data', data: [[1793923200, 4071.89]] } }), { method: 'POST' }),
    ]);
    const ctx = makeCtx(fetch);
    const e = await catchErr(superwallAdapter.fetchSnapshot(input(), ctx));
    expect(e.kind).toBe('upstream');
    expect(e.message).toMatch(/MRR chart hoomuch couldn’t read/);
    expect(ctx.logs.find((l) => l.event === 'superwall_unreadable')?.data).toMatchObject({ data: 1, point: 'object' });
  });

  it('fails when the MRR chart isn’t a currency (wrong metric)', async () => {
    const mrr = clone(mrrChart);
    mrr.y_axis.value_type = 'percentage';
    const { fetch } = fakeFetch([route(DEFS, { json: definitionsFixture }), route(DATA, chartData({ mrr }), { method: 'POST' })]);
    const e = await catchErr(superwallAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(e.kind).toBe('upstream');
    expect(e.message).toMatch(/unexpected unit/);
  });

  it('finds the charts by name whatever their keys are', async () => {
    const defs = clone(definitionsFixture) as unknown as { chart_types: Json[] };
    for (const c of defs.chart_types) {
      if (c['name'] === 'MRR') Object.assign(c, { key: 'x1', y_axis: 'm_2026_mrr', x_axis: 'stateDay', date_dimension: 'tsDate' });
    }
    const { fetch, calls } = fakeFetch([
      route(DEFS, { json: defs }),
      route(DATA, (_u, init) => {
        const b = JSON.parse(String(init?.body)) as Json;
        return { json: b['y_axis'] === 'm_2026_mrr' ? { ...clone(mrrChart), y_axis: { ...mrrChart.y_axis, key: 'm_2026_mrr' } } : subsChart };
      }, { method: 'POST' }),
      route(QUERY, queryData()),
    ]);
    const snap = await superwallAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ USD: 407189 });
    expect(bodyOf(calls[1]!)).toMatchObject({ y_axis: 'm_2026_mrr', x_axis: 'stateDay', date_filter: { dimension: 'tsDate' } });
  });

  it('fails when the Active Subscriptions chart answers in a currency (wrong metric), not as a count', async () => {
    const subs = clone(subsChart);
    subs.y_axis.value_type = 'currency';
    const { fetch, calls } = fakeFetch([route(DEFS, { json: definitionsFixture }), route(DATA, chartData({ subs }), { method: 'POST' })]);
    const e = await catchErr(superwallAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(e.kind).toBe('upstream');
    expect(e.message).toMatch(/Active Subscriptions chart in an unexpected unit/);
    expect(calls).toHaveLength(3); // no trials query after a failed required chart
  });

  it('leaves trials unknown (no query) when the budget is spent on the required charts', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const snap = await superwallAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 3 }));
    expect(snap).toEqual({
      mrr: { USD: 407189 },
      activeSubscriptions: 409,
      activeTrials: null,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      warnings: [SW_TRIALS_SKIPPED_WARNING],
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([DEFS, DATA, DATA]);
  });

  it('maps 404 on any call to not_found on organizationId', async () => {
    const { fetch } = fakeFetch([route(DEFS, { status: 404, json: err404 })]);
    const e = await catchErr(superwallAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(e.kind).toBe('not_found');
    expect(e.field).toBe('organizationId');
  });
});

// ---------------------------------------------------------------------------

describe('superwall fetchRevenue', () => {
  it('returns one USD point per day, zeros included, from a single query', async () => {
    const { fetch, calls } = fakeFetch([route(QUERY, queryData())]);
    const ctx = makeCtx(fetch);
    const page = await superwallAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-01T09:30:00Z'), cursor: null }, ctx);
    expect(page).toEqual({
      events: [],
      daily: [
        { day: '2026-11-01', currency: 'USD', gross: 0, refunds: 0, count: 0 },
        { day: '2026-11-02', currency: 'USD', gross: 38961, refunds: 0, count: 39 },
        { day: '2026-11-03', currency: 'USD', gross: 41959, refunds: 999, count: 41 },
        { day: '2026-11-04', currency: 'USD', gross: 0, refunds: 0, count: 0 },
        { day: '2026-11-05', currency: 'USD', gross: 0, refunds: 4999, count: 0 },
      ],
      nextCursor: null,
      done: true,
    });
    expect(calls).toHaveLength(1);
    const p = paramsOf(calls[0]!);
    expect(p.get('query')).toBe(REVENUE_SQL);
    expect([p.get('param_scan_from'), p.get('param_day_from'), p.get('param_day_after')]).toEqual(['2026-10-31', '2026-11-01', '2026-11-06']);
    expect(calls[0]!.method).toBe('GET');
    expectClean(ctx);
  });

  it('backfills in 31-day windows and resumes from its cursor when the budget runs out', async () => {
    const { fetch, calls } = fakeFetch([route(QUERY, { json: emptyRevenue })]);
    const since = Date.parse('2026-08-07T00:00:00Z'); // 91 days ending today
    const first = await superwallAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch, { pageBudget: 2 }));
    expect(first.done).toBe(false);
    expect(first.nextCursor).toBe('2026-10-08');
    expect(first.daily).toHaveLength(62);
    expect(first.daily[0]!.day).toBe('2026-08-07');
    expect(first.daily.at(-1)!.day).toBe('2026-10-07');
    expect(calls.map((c) => [paramsOf(c).get('param_day_from'), paramsOf(c).get('param_day_after')])).toEqual([
      ['2026-08-07', '2026-09-07'],
      ['2026-09-07', '2026-10-08'],
    ]);

    const rest = await superwallAdapter.fetchRevenue(input(), { since, cursor: first.nextCursor }, makeCtx(fetch));
    expect(rest).toMatchObject({ done: true, nextCursor: null });
    expect(rest.daily.map((d) => d.day)).toEqual(
      Array.from({ length: 29 }, (_, i) => new Date(Date.parse('2026-10-08T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10)),
    );
  });

  it('on a rate limit, stops at once and hands back a cursor with what it already has', async () => {
    const { fetch, calls } = fakeFetch([route(QUERY, [{ json: emptyRevenue }, { status: 429, json: err429 }])]);
    const ctx = makeCtx(fetch);
    const page = await superwallAdapter.fetchRevenue(input(), { since: Date.parse('2026-08-07T00:00:00Z'), cursor: null }, ctx);
    expect(page).toMatchObject({ done: false, nextCursor: '2026-09-07' });
    expect(page.daily).toHaveLength(31);
    expect(calls).toHaveLength(2); // 'yield': no retries on 429
    expect(ctx.pageBudget).toBe(0);
    expect(logEvents(ctx)).toContain('superwall_revenue_paused');
  });

  it('on a rate limit before anything was read, hands back `since` as the cursor (nothing is lost)', async () => {
    const { fetch, calls } = fakeFetch([route(QUERY, { status: 429, json: err429 })]);
    const ctx = makeCtx(fetch);
    const page = await superwallAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-01T09:30:00Z'), cursor: null }, ctx);
    expect(page).toEqual({ events: [], daily: [], nextCursor: '2026-11-01', done: false });
    expect(calls).toHaveLength(1);
    expect(ctx.logs.find((l) => l.event === 'superwall_revenue_paused')?.data).toEqual({ reason: 'rate_limit', resumeFrom: '2026-11-01', days: 0 });
  });

  it('returns its cursor without a request when there is no budget, and nothing for a future `since`', async () => {
    const { fetch, calls } = fakeFetch([route(QUERY, { json: emptyRevenue })]);
    const broke = await superwallAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-01T09:30:00Z'), cursor: null }, makeCtx(fetch, { pageBudget: 0 }));
    expect(broke).toEqual({ events: [], daily: [], nextCursor: '2026-11-01', done: false });

    const future = await superwallAdapter.fetchRevenue(input(), { since: NOW + 2 * 86_400_000, cursor: null }, makeCtx(fetch));
    expect(future).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(calls).toHaveLength(0);
  });

  it('starts at the UTC day of `since`, whatever offset it was written with', async () => {
    const { fetch, calls } = fakeFetch([route(QUERY, { json: emptyRevenue })]);
    const since = Date.parse('2026-11-04T23:30:00-02:00'); // 2026-11-05T01:30Z
    const page = await superwallAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch));
    expect(paramsOf(calls[0]!).get('param_day_from')).toBe(TODAY);
    expect(page.daily.map((d) => d.day)).toEqual([TODAY]);
  });

  it('throws on a persistent 5xx (after one retry) instead of pausing or reporting zero revenue', async () => {
    const { fetch, calls } = fakeFetch([route(QUERY, { status: 503, body: 'Service Unavailable' })]);
    const e = await catchErr(superwallAdapter.fetchRevenue(input(), { since: NOW, cursor: null }, makeCtx(fetch)));
    expect(e).toMatchObject({ kind: 'upstream', status: 503 });
    expect(calls).toHaveLength(2); // QUERY_MAX_ATTEMPTS
  });

  it('throws auth on a revoked key mid-backfill', async () => {
    const { fetch } = fakeFetch([route(QUERY, [{ json: emptyRevenue }, { status: 401, json: err401 }])]);
    const e = await catchErr(superwallAdapter.fetchRevenue(input(), { since: Date.parse('2026-08-07T00:00:00Z'), cursor: null }, makeCtx(fetch)));
    expect(e.kind).toBe('auth');
  });

  it('without data:read, finishes with no history instead of failing the sync', async () => {
    const { fetch } = fakeFetch([route(QUERY, { status: 403, json: err403Data })]);
    const ctx = makeCtx(fetch);
    const page = await superwallAdapter.fetchRevenue(input(), { since: NOW, cursor: null }, ctx);
    expect(page).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(logEvents(ctx)).toContain('superwall_query_unavailable');
  });

  it('surfaces a refused query (400) as an error instead of reporting zero revenue', async () => {
    const { fetch } = fakeFetch([route(QUERY, { status: 400, body: "Code: 47. DB::Exception: Unknown identifier 'isFamilyShare'" })]);
    const e = await catchErr(superwallAdapter.fetchRevenue(input(), { since: NOW, cursor: null }, makeCtx(fetch)));
    expect(e.kind).toBe('upstream');
    expect(e.status).toBe(400);
  });

  it('fails on a result it can’t read, logging column names only', async () => {
    const bad = { ...clone(revenueRows), data: [{ day: '2026-11-05', gross: '100' }] };
    const { fetch } = fakeFetch([route(QUERY, { json: bad })]);
    const ctx = makeCtx(fetch);
    const e = await catchErr(superwallAdapter.fetchRevenue(input(), { since: NOW, cursor: null }, ctx));
    expect(e.message).toMatch(/revenue query result hoomuch couldn’t read/);
    expect(ctx.logs.find((l) => l.event === 'superwall_unreadable')?.data).toEqual({ what: 'a revenue query result', columns: 'day,gross' });
  });

  it('accepts unquoted numbers, ignores rows outside the window, and never goes negative', async () => {
    const rows = {
      ...clone(revenueRows),
      data: [
        { day: '2026-11-04', gross_minor: 1200, refunds_minor: -5, charges: 2 },
        { day: '2026-11-03', gross_minor: '999', refunds_minor: '0', charges: '1' },
      ],
    };
    const { fetch } = fakeFetch([route(QUERY, { json: rows })]);
    const page = await superwallAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-04T00:00:00Z'), cursor: null }, makeCtx(fetch));
    expect(page.daily).toEqual([
      { day: '2026-11-04', currency: 'USD', gross: 1200, refunds: 0, count: 2 },
      { day: '2026-11-05', currency: 'USD', gross: 0, refunds: 0, count: 0 },
    ]);
  });

  it('ignores a malformed cursor and starts from `since`', async () => {
    const { fetch, calls } = fakeFetch([route(QUERY, { json: emptyRevenue })]);
    await superwallAdapter.fetchRevenue(input(), { since: NOW, cursor: '2026-13-45' }, makeCtx(fetch));
    expect(paramsOf(calls[0]!).get('param_day_from')).toBe(TODAY);
  });
});
