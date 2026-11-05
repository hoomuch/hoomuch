import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../../src/providers/http';
import {
  CONFIG_ENVIRONMENT,
  POLAR_API_VERSION,
  REVENUE_LOOKBACK_MS,
  VERSION_GONE_MESSAGE,
  decodeCursor,
  encodeCursor,
  nextRefundPage,
  orderToCharge,
  polarAdapter,
  readMrr,
  refundToEvent,
} from '../../src/providers/polar';
import { ProviderError, type RevenueEvent } from '../../src/providers/types';
import { cleanEvents } from '../../src/sync/aggregate';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, NOW, route, type RecordedCall, type TestCtx } from '../fixtures/harness';
// Objects built from the property `examples` of Polar's OpenAPI 2026-10 schemas (Subscription, Order, Refund,
// ProductPriceMeteredUnit, MetricsResponse) with coherent ids and dates; error bodies are the RFC 6750 bodies
// Polar's OAuth2 error handler returns. See test/fixtures/polar/.
import subscriptionFx from '../fixtures/polar/subscription.json';
import orderFx from '../fixtures/polar/order.json';
import refundFx from '../fixtures/polar/refund.json';
import meteredPriceFx from '../fixtures/polar/price-metered-unit.json';
import metricsFx from '../fixtures/polar/metrics.json';
import error401Fx from '../fixtures/polar/error-401.json';
import error403Fx from '../fixtures/polar/error-403.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

const OAT = 'polar_oat_FakeTokenForTestsOnly0000000000000000000000000';
const OAT_SANDBOX = 'polar_oat_FakeSandboxTokenForTests111111111111111111111';
const LIVE_HOST = 'api.polar.sh';
const SANDBOX_HOST = 'sandbox-api.polar.sh';
const TODAY = '2026-11-05';
const DAY_MS = 86_400_000;
const PII = ['customer@example.com', 'John Doe', '1 Example Street', 'San Francisco'];

const input = (apiKey = OAT, config: Record<string, string> = {}) => ({ credentials: { apiKey }, config });
const sandboxInput = () => input(OAT_SANDBOX, { [CONFIG_ENVIRONMENT]: 'sandbox' });

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${(++seq).toString().padStart(12, '0')}`;

function list(items: Json[], o: { total?: number; limit?: number } = {}): Json {
  const total = o.total ?? items.length;
  return { items, pagination: { total_count: total, max_page: Math.ceil(total / (o.limit ?? 100)) } };
}

function sub(o: { amount?: number; status?: string; metered?: boolean } = {}): Json {
  const s = clone(subscriptionFx);
  s.id = uuid();
  s.status = o.status ?? 'active';
  s.amount = o.amount ?? 1500;
  if (o.metered) s.prices = [...s.prices, clone(meteredPriceFx)];
  return s;
}

interface OrderOpts {
  id?: string;
  created?: string;
  status?: string;
  net?: number;
  tax?: number;
  balance?: number;
  currency?: string;
  fee?: number;
  feeCurrency?: string | null;
  product?: string | null;
}

function order(o: OrderOpts = {}): Json {
  const x = clone(orderFx);
  const net = o.net ?? 1500;
  const tax = o.tax ?? 300;
  x.id = o.id ?? uuid();
  x.created_at = o.created ?? '2026-11-03T09:30:00.000000Z';
  x.status = o.status ?? 'paid';
  x.paid = ['paid', 'refunded', 'partially_refunded'].includes(x.status);
  Object.assign(x, {
    subtotal_amount: net,
    discount_amount: 0,
    net_amount: net,
    tax_amount: tax,
    total_amount: net + tax,
    applied_balance_amount: o.balance ?? 0,
    currency: o.currency ?? 'usd',
    platform_fee_amount: o.fee ?? 112,
    platform_fee_currency: o.feeCurrency === undefined ? 'usd' : o.feeCurrency,
  });
  if (o.product === null) x.product = null;
  else if (o.product !== undefined) x.product.name = o.product;
  return x;
}

function refund(o: { id?: string; created?: string; status?: string; amount?: number; tax?: number; orderId?: string; currency?: string } = {}): Json {
  return {
    ...clone(refundFx),
    id: o.id ?? uuid(),
    created_at: o.created ?? '2026-11-04T08:00:00.000000Z',
    status: o.status ?? 'succeeded',
    amount: o.amount ?? 1500,
    tax_amount: o.tax ?? 300,
    order_id: o.orderId ?? orderFx.id,
    currency: o.currency ?? 'usd',
  };
}

function q(call: RecordedCall): URLSearchParams {
  return new URL(call.url).searchParams;
}

function pathsOf(calls: RecordedCall[]): string[] {
  return calls.map((c) => new URL(c.url).pathname);
}

function expectPolarHeaders(calls: RecordedCall[], host = LIVE_HOST, token = OAT): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    const url = new URL(c.url);
    expect(c.method).toBe('GET');
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe(host);
    expect(url.pathname.startsWith('/v1/')).toBe(true);
    expect(url.pathname.endsWith('/')).toBe(true); // FastAPI routes; we don't follow redirects
    expect(c.headers['authorization']).toBe(`Bearer ${token}`);
    expect(c.headers['polar-version']).toBe(POLAR_API_VERSION);
  }
}

function expectNoPii(ctx: TestCtx, events: RevenueEvent[] = []): void {
  const dump = JSON.stringify({ logs: ctx.logs, events });
  for (const s of PII) expect(dump).not.toContain(s);
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

// ---------- verify ----------

describe('polar verify', () => {
  const okRoutes = () => [
    route('/v1/subscriptions/', { json: list([sub()]) }, { query: { limit: '1' } }),
    route('/v1/metrics/', { json: metricsFx }),
    route('/v1/orders/', { json: list([order()]) }, { query: { limit: '1' } }),
    route('/v1/refunds/', { json: list([refund()]) }, { query: { limit: '1' } }),
  ];

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['personal access token', 'polar_pat_FakeTokenForTestsOnly0000000000000000000000000'],
    ['customer session token', 'polar_cst_FakeTokenForTestsOnly0000000000000000000000000'],
    ['truncated token', 'polar_oat_Fake'],
    ['prefix only', 'polar_oat_'],
    ['inner whitespace', 'polar_oat_FakeTokenForTests Only000000000000000000000'],
    ['header prefix pasted', `Bearer ${OAT}`],
    ['Stripe key', 'rk_live_51FakeKeyForTestsOnly1111111111111111111111111111'],
  ])('rejects a %s on the apiKey field without a network call', async (_label, key) => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await polarAdapter.verify(input(key), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error.length).toBeGreaterThan(10);
    expect(calls).toHaveLength(0);
  });

  it('explains that a personal access token is the wrong kind', async () => {
    const res = await polarAdapter.verify(input('polar_pat_FakeTokenForTestsOnly0000000000000000000000000'), makeCtx(fakeFetch([]).fetch));
    expect(!res.ok && res.error).toMatch(/personal access token.*organization access token/);
  });

  it('accepts a production token with one pinned, authenticated read per scope', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const res = await polarAdapter.verify(input(`  ${OAT}  `), ctx);
    expect(res).toEqual({
      ok: true,
      accountLabel: 'Polar',
      config: { [CONFIG_ENVIRONMENT]: 'production' },
      testMode: false,
      warnings: [],
    });
    expect(pathsOf(calls)).toEqual(['/v1/subscriptions/', '/v1/metrics/', '/v1/orders/', '/v1/refunds/']);
    expectPolarHeaders(calls);
    expect(Object.fromEntries(q(calls[1]!))).toEqual({
      start_date: TODAY,
      end_date: TODAY,
      interval: 'day',
      timezone: 'UTC',
      metrics: 'monthly_recurring_revenue',
    });
    expect(ctx.pageBudget).toBe(1);
    expectNoSecretsInLogs(ctx, [OAT]);
  });

  it('detects a sandbox token (production says 401) and verifies it on the sandbox host', async () => {
    const routes = okRoutes();
    routes[0] = route('/v1/subscriptions/', (url) =>
      url.host === LIVE_HOST ? { status: 401, json: error401Fx } : { json: list([sub()]) },
    );
    const { fetch, calls } = fakeFetch(routes);
    const ctx = makeCtx(fetch, { pageBudget: 5 }); // the production budget for verify (services/connections.ts)
    const res = await polarAdapter.verify(input(OAT_SANDBOX), ctx);
    expect(res).toEqual({
      ok: true,
      accountLabel: 'Polar (sandbox)',
      config: { [CONFIG_ENVIRONMENT]: 'sandbox' },
      testMode: true,
      warnings: [],
    });
    expect(calls.map((c) => `${new URL(c.url).host}${new URL(c.url).pathname}`)).toEqual([
      `${LIVE_HOST}/v1/subscriptions/`,
      `${SANDBOX_HOST}/v1/subscriptions/`,
      `${SANDBOX_HOST}/v1/metrics/`,
      `${SANDBOX_HOST}/v1/orders/`,
      `${SANDBOX_HOST}/v1/refunds/`,
    ]);
    expectPolarHeaders(calls.slice(1), SANDBOX_HOST, OAT_SANDBOX);
    expect(ctx.pageBudget).toBe(0);
    expectNoSecretsInLogs(ctx, [OAT_SANDBOX]);
  });

  it('reports a token rejected by both hosts on the apiKey field after two requests', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/subscriptions/', { status: 401, json: error401Fx })]);
    const ctx = makeCtx(fetch);
    const res = await polarAdapter.verify(input(), ctx);
    expect(res).toEqual({ ok: false, field: 'apiKey', error: expect.stringMatching(/Polar rejected this token in production and in the sandbox/) });
    expect(calls.map((c) => new URL(c.url).host)).toEqual([LIVE_HOST, SANDBOX_HOST]);
    expectNoSecretsInLogs(ctx, [OAT]);
  });

  it.each([
    ['/v1/subscriptions/', 'subscriptions:read'],
    ['/v1/metrics/', 'metrics:read'],
    ['/v1/orders/', 'orders:read'],
    ['/v1/refunds/', 'refunds:read'],
  ])('names the missing scope when %s answers 403', async (path, scope) => {
    const routes = okRoutes().filter((r) => !r.label.startsWith(path));
    const { fetch, calls } = fakeFetch([route(path, { status: 403, json: error403Fx }), ...routes]);
    const ctx = makeCtx(fetch);
    const res = await polarAdapter.verify(input(), ctx);
    expect(res).toEqual({ ok: false, field: 'apiKey', error: `The Polar key is missing the “${scope}” permission.` });
    expect(pathsOf(calls).at(-1)).toBe(path);
    expect(calls.every((c) => new URL(c.url).host === LIVE_HOST)).toBe(true); // a 403 means the token is valid here
    expectNoSecretsInLogs(ctx, [OAT]);
  });

  it('names the missing scope of a sandbox token', async () => {
    const { fetch } = fakeFetch([
      route('/v1/subscriptions/', (url) => (url.host === LIVE_HOST ? { status: 401, json: error401Fx } : { json: list([]) })),
      route('/v1/metrics/', { status: 403, json: error403Fx }),
    ]);
    const res = await polarAdapter.verify(input(OAT_SANDBOX), makeCtx(fetch));
    expect(res).toEqual({ ok: false, field: 'apiKey', error: 'The Polar key is missing the “metrics:read” permission.' });
  });

  it('throws transient failures for the caller to describe', async () => {
    const routes = okRoutes().filter((r) => !r.label.startsWith('/v1/orders/'));
    const { fetch } = fakeFetch([route('/v1/orders/', { status: 503, json: { error: 'ServiceUnavailable', detail: 'down' } }), ...routes]);
    const err = await catchErr(polarAdapter.verify(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
  });
});

// ---------- fetchSnapshot ----------

describe('polar fetchSnapshot', () => {
  const snapshotRoutes = (o: { metrics?: Json; paying?: Json[] | ((page: number) => Json); trials?: number } = {}) => [
    route('/v1/metrics/', { json: o.metrics ?? metricsFx }),
    route('/v1/subscriptions/', { json: list([sub({ status: 'trialing' })], { total: o.trials ?? 7 }) }, { query: { status: 'trialing', limit: '1' } }),
    route(
      '/v1/subscriptions/',
      (url) => {
        const page = Number(url.searchParams.get('page'));
        const p = o.paying ?? [sub({ amount: 0 }), sub({ amount: 0, metered: true }), sub({ amount: 900 }), sub({ amount: 1500, status: 'past_due' })];
        return { json: typeof p === 'function' ? p(page) : list(p, { total: 40 }) };
      },
      { query: { status: ['active', 'past_due'] } },
    ),
  ];

  it('MRR from Polar metrics (USD); active = active + past_due minus $0 ones (metered-only too); trials from total_count', async () => {
    const { fetch, calls } = fakeFetch(snapshotRoutes());
    const ctx = makeCtx(fetch);
    const snap = await polarAdapter.fetchSnapshot(input(), ctx);
    expect(snap).toEqual({
      mrr: { USD: 123456 },
      activeSubscriptions: 38, // 40 − the free one − the metered-only one (no recurring amount, as for Stripe)
      activeTrials: 7,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
    });
    expect(pathsOf(calls)).toEqual(['/v1/metrics/', '/v1/subscriptions/', '/v1/subscriptions/']);
    expectPolarHeaders(calls);
    expect(Object.fromEntries(q(calls[0]!))).toEqual({
      start_date: TODAY,
      end_date: TODAY,
      interval: 'day',
      timezone: 'UTC',
      metrics: 'monthly_recurring_revenue',
    });
    expect(q(calls[1]!).getAll('status')).toEqual(['active', 'past_due']);
    expect(q(calls[1]!).getAll('sorting')).toEqual(['amount', 'started_at']);
    expect(q(calls[1]!).get('limit')).toBe('100');
    expect(q(calls[1]!).get('page')).toBe('1');
    expect(q(calls[2]!).getAll('status')).toEqual(['trialing']);
    expectNoPii(ctx);
    expectNoSecretsInLogs(ctx, [OAT]);
  });

  it('pages through $0 subscriptions until a paying one appears', async () => {
    const zeros = (n: number) => Array.from({ length: n }, () => sub({ amount: 0 }));
    const paid = (n: number) => Array.from({ length: n }, () => sub({ amount: 2000 }));
    const { fetch, calls } = fakeFetch(
      snapshotRoutes({
        paying: (page) => (page === 1 ? list(zeros(100), { total: 250 }) : page === 2 ? list([...zeros(30), ...paid(70)], { total: 250 }) : list(paid(50), { total: 250 })),
      }),
    );
    const snap = await polarAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.activeSubscriptions).toBe(120);
    expect(calls.filter((c) => q(c).get('sorting') === 'amount').map((c) => q(c).get('page'))).toEqual(['1', '2']);
  });

  it('stops on a short last page even when every subscription is $0', async () => {
    // A consistent server: the only two active subscriptions are both $0, so none of them is paying.
    const { fetch, calls } = fakeFetch(snapshotRoutes({ paying: () => list([sub({ amount: 0 }), sub({ amount: 0 })]), trials: 0 }));
    const snap = await polarAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap).toMatchObject({ activeSubscriptions: 0, activeTrials: 0 });
    expect(calls).toHaveLength(3);
  });

  it('leaves a subscription with an unreadable amount in the count (never undercounts on a shape change)', async () => {
    const odd = sub();
    delete odd.amount;
    const { fetch } = fakeFetch(snapshotRoutes({ paying: () => list([sub({ amount: 0 }), odd, sub({ amount: 900 })]) }));
    const snap = await polarAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.activeSubscriptions).toBe(2); // 3 − the $0 one
  });

  it.each([
    ['paying list', { status: ['active', 'past_due'] }],
    ['trialing list', { status: 'trialing', limit: '1' }],
  ])('refuses to guess a count when the %s has no total_count', async (_label, query) => {
    const { fetch } = fakeFetch([
      route('/v1/subscriptions/', { json: { items: [sub()], pagination: {} } }, { query }),
      ...snapshotRoutes(),
    ]);
    const err = await catchErr(polarAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'upstream', message: expect.stringMatching(/couldn’t read/) });
  });

  it('an empty organization has no MRR and no subscriptions', async () => {
    const metrics = clone(metricsFx);
    metrics.periods[0].monthly_recurring_revenue = 0;
    metrics.totals.monthly_recurring_revenue = 0;
    const { fetch } = fakeFetch([
      route('/v1/metrics/', { json: metrics }),
      route('/v1/subscriptions/', { json: list([]) }),
    ]);
    const snap = await polarAdapter.fetchSnapshot(input(), makeCtx(fetch));
    // toEqual, not toMatchObject: `mrr: {}` in toMatchObject matches any map, including { USD: 0 }.
    expect(snap).toEqual({
      mrr: {},
      activeSubscriptions: 0,
      activeTrials: 0,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
    });
  });

  it('refuses to write a zero MRR when the metric is missing from the response', async () => {
    const { fetch, calls } = fakeFetch(snapshotRoutes({ metrics: { periods: [{ timestamp: '2026-11-05T00:00:00Z' }], totals: {}, metrics: {} } }));
    const err = await catchErr(polarAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/couldn’t read/);
    expect(calls).toHaveLength(1);
  });

  it('readMrr: last period first, then totals; rounds and never goes negative', () => {
    expect(readMrr(metricsFx)).toBe(123456);
    expect(readMrr({ periods: [{ monthly_recurring_revenue: 10 }, { monthly_recurring_revenue: 4999.6 }] })).toBe(5000);
    expect(readMrr({ periods: [{ timestamp: 'x' }], totals: { monthly_recurring_revenue: 77 } })).toBe(77);
    expect(readMrr({ periods: [], totals: { monthly_recurring_revenue: -5 } })).toBe(0);
    expect(readMrr({ periods: [] })).toBeNull();
    expect(readMrr(null)).toBeNull();
  });

  it('uses the sandbox host for a sandbox connection', async () => {
    const { fetch, calls } = fakeFetch(snapshotRoutes());
    await polarAdapter.fetchSnapshot(sandboxInput(), makeCtx(fetch));
    expectPolarHeaders(calls, SANDBOX_HOST, OAT_SANDBOX);
  });

  it('names metrics:read when the token can’t read metrics', async () => {
    const { fetch } = fakeFetch([route('/v1/metrics/', { status: 403, json: error403Fx })]);
    const err = await catchErr(polarAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'permission', field: 'apiKey', message: 'The Polar key is missing the “metrics:read” permission.' });
  });

  it('maps 401 to auth and 404 (pinned version removed) to a clear upstream error', async () => {
    const revoked = fakeFetch([route('/v1/metrics/', { status: 401, json: error401Fx })]);
    expect(await catchErr(polarAdapter.fetchSnapshot(input(), makeCtx(revoked.fetch)))).toMatchObject({ kind: 'auth', field: 'apiKey' });

    const gone = fakeFetch([route('/v1/metrics/', { status: 404, json: { detail: 'Not Found' } })]);
    const err = await catchErr(polarAdapter.fetchSnapshot(input(), makeCtx(gone.fetch)));
    expect(err).toMatchObject({ kind: 'upstream', status: 404, message: VERSION_GONE_MESSAGE });
    expect(VERSION_GONE_MESSAGE).toContain(POLAR_API_VERSION);
  });

  it('rejects a malformed token without a network call', async () => {
    const { fetch, calls } = fakeFetch(snapshotRoutes());
    const err = await catchErr(polarAdapter.fetchSnapshot(input('sk_live_nope'), makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'invalid_input', field: 'apiKey' });
    expect(calls).toHaveLength(0);
  });

  it('lets BudgetExhaustedError propagate', async () => {
    const { fetch } = fakeFetch(snapshotRoutes());
    await expect(polarAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 2 }))).rejects.toBeInstanceOf(BudgetExhaustedError);
  });
});

// ---------- fetchRevenue ----------

const SINCE = Date.parse('2026-11-01T00:00:00.000Z');
const FLOOR = SINCE - REVENUE_LOOKBACK_MS; // 2026-10-02

interface ServerState {
  orders: Json[];
  refunds: Json[];
  /** Answer 429 for these "<path>#<page>" keys (once each). */
  rateLimit: Set<string>;
}

/** A fake Polar that filters, sorts and pages orders and refunds the way the API does. */
function polarServer(state: Partial<ServerState> = {}) {
  const s: ServerState = { orders: [], refunds: [], rateLimit: new Set(), ...state };
  const page = (items: Json[], url: URL, path: string) => {
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const p = Number(url.searchParams.get('page') ?? '1');
    const key = `${path}#${p}`;
    if (s.rateLimit.delete(key)) return { status: 429, json: { error: 'TooManyRequests', detail: 'Rate limit exceeded' }, headers: { 'retry-after': '60' } };
    return { json: list(items.slice((p - 1) * limit, p * limit), { total: items.length, limit }) };
  };
  const t = (x: Json) => Date.parse(x.created_at as string);
  const { fetch, calls } = fakeFetch([
    route('/v1/orders/', (url) => {
      const after = Date.parse(url.searchParams.get('created_after')!);
      const before = Date.parse(url.searchParams.get('created_before')!);
      const statuses = url.searchParams.getAll('status');
      const items = s.orders
        .filter((o) => t(o) > after && t(o) < before && (statuses.length === 0 || statuses.includes(o.status)))
        .sort((a, b) => (url.searchParams.get('sorting') === 'created_at' ? t(a) - t(b) : t(b) - t(a)));
      return page(items, url, 'orders');
    }),
    route('/v1/refunds/', (url) => {
      const items = [...s.refunds].sort((a, b) => (url.searchParams.get('sorting') === 'created_at' ? t(a) - t(b) : t(b) - t(a)));
      return page(items, url, 'refunds');
    }),
  ]);
  return { fetch, calls, state: s };
}

const pagesOf = (calls: RecordedCall[], path: string) =>
  calls.filter((c) => new URL(c.url).pathname === path).map((c) => Number(q(c).get('page')));

const byId = (events: RevenueEvent[]) => new Map(events.map((e) => [e.externalId, e]));
const sorted = (events: RevenueEvent[]) => [...events].sort((a, b) => a.externalId.localeCompare(b.externalId));

describe('polar fetchRevenue', () => {
  const O = {
    paid: order({ id: 'o-paid', created: '2026-11-03T09:30:00.000000Z' }),
    eur: order({ id: 'o-eur', created: '2026-11-02T10:00:00.000000Z', status: 'refunded', net: 900, tax: 180, currency: 'eur', fee: 60, feeCurrency: 'usd', product: 'Team · Yearly' }),
    credit: order({ id: 'o-credit', created: '2026-11-01T00:00:00.000000Z', status: 'partially_refunded', net: 2000, tax: 400, balance: -500, product: null }),
    late: order({ id: 'o-late', created: '2026-10-20T06:00:00.000000Z' }), // renewal paid on a dunning retry
    free: order({ id: 'o-free', created: '2026-11-03T12:00:00.000000Z', net: 0, tax: 0 }),
    pending: order({ id: 'o-pending', created: '2026-11-04T12:00:00.000000Z', status: 'pending' }),
    old: order({ id: 'o-old', created: '2026-09-01T12:00:00.000000Z' }),
  };
  const R = {
    full: refund({ id: 'r-full', created: '2026-11-04T08:00:00.000000Z', orderId: 'o-paid' }),
    pending: refund({ id: 'r-pending', created: '2026-11-04T09:00:00.000000Z', status: 'pending' }),
    failed: refund({ id: 'r-failed', created: '2026-11-03T09:00:00.000000Z', status: 'failed' }),
    taxOnly: refund({ id: 'r-tax', created: '2026-11-02T09:00:00.000000Z', amount: 0, tax: 180, currency: 'eur', orderId: 'o-eur' }),
    eur: refund({ id: 'r-eur', created: '2026-11-02T11:00:00.000000Z', amount: 900, tax: 180, currency: 'eur', orderId: 'o-eur' }),
    lookback: refund({ id: 'r-lookback', created: '2026-10-10T09:00:00.000000Z', amount: 700, tax: 0, orderId: 'o-unknown' }),
    beforeFloor: refund({ id: 'r-before-floor', created: '2026-09-30T09:00:00.000000Z' }),
  };

  const EXPECTED: RevenueEvent[] = [
    { externalId: 'order:o-paid', occurredAt: Date.parse('2026-11-03T09:30:00Z'), type: 'charge', amount: 1500, currency: 'USD', fee: 112, description: 'Pro' },
    { externalId: 'order:o-eur', occurredAt: Date.parse('2026-11-02T10:00:00Z'), type: 'charge', amount: 900, currency: 'EUR', fee: null, description: 'Team · Yearly' },
    { externalId: 'order:o-credit', occurredAt: SINCE, type: 'charge', amount: 1500, currency: 'USD', fee: 112, description: 'Pro' },
    { externalId: 'order:o-late', occurredAt: Date.parse('2026-10-20T06:00:00Z'), type: 'charge', amount: 1500, currency: 'USD', fee: 112, description: 'Pro' },
    { externalId: 'refund:r-full', occurredAt: Date.parse('2026-11-04T08:00:00Z'), type: 'refund', amount: -1500, currency: 'USD', fee: null, description: 'Pro' },
    { externalId: 'refund:r-eur', occurredAt: Date.parse('2026-11-02T11:00:00Z'), type: 'refund', amount: -900, currency: 'EUR', fee: null, description: 'Team · Yearly' },
    { externalId: 'refund:r-lookback', occurredAt: Date.parse('2026-10-10T09:00:00Z'), type: 'refund', amount: -700, currency: 'USD', fee: null, description: null },
  ];

  const fullServer = () => polarServer({ orders: Object.values(O).map(clone), refunds: Object.values(R).map(clone) });

  it('returns pre-tax charges and refunds with a 30-day lookback, in two requests', async () => {
    const server = fullServer();
    const ctx = makeCtx(server.fetch);
    const page = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page).toMatchObject({ daily: [], nextCursor: null, done: true });
    expect(sorted(page.events)).toEqual(sorted(EXPECTED));
    expect(pathsOf(server.calls)).toEqual(['/v1/orders/', '/v1/refunds/']);
    expectPolarHeaders(server.calls);

    const oq = q(server.calls[0]!);
    expect(oq.get('created_after')).toBe(new Date(FLOOR - 1).toISOString());
    expect(oq.get('created_before')).toBe(new Date(NOW + 1).toISOString());
    expect(oq.getAll('status')).toEqual(['paid', 'refunded', 'partially_refunded']);
    expect(oq.get('sorting')).toBe('created_at');
    expect(oq.get('limit')).toBe('100');
    const rq = q(server.calls[1]!);
    expect(rq.get('sorting')).toBe('-created_at');
    expect(rq.has('succeeded')).toBe(false); // a succeeded refund can still fail; filtering would shift pages

    // The engine's own validation accepts every event.
    expect(cleanEvents(page.events, NOW).skipped).toEqual({});
    expectNoPii(ctx, page.events);
    expectNoSecretsInLogs(ctx, [OAT]);
  });

  it('stops reading refunds at the first one older than the lookback floor', async () => {
    const older = Array.from({ length: 150 }, (_, i) => refund({ created: new Date(FLOOR - (i + 1) * 3_600_000).toISOString() }));
    const server = polarServer({ refunds: [clone(R.full), ...older] });
    const page = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch));
    expect(page.done).toBe(true);
    expect(page.events.map((e) => e.externalId)).toEqual(['refund:r-full']);
    expect(pagesOf(server.calls, '/v1/refunds/')).toEqual([1]);
  });

  it('uses the sandbox host for a sandbox connection', async () => {
    const server = fullServer();
    await polarAdapter.fetchRevenue(sandboxInput(), { since: SINCE, cursor: null }, makeCtx(server.fetch));
    expectPolarHeaders(server.calls, SANDBOX_HOST, OAT_SANDBOX);
  });

  it('returns a cursor when the budget runs out and resumes in the same frozen window', async () => {
    const many = Array.from({ length: 230 }, (_, i) =>
      order({ id: `o-${String(i).padStart(3, '0')}`, created: new Date(SINCE + i * 60_000).toISOString() }),
    );
    const server = polarServer({ orders: many, refunds: [clone(R.full)] });

    const first = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch, { pageBudget: 1 }));
    expect(first).toMatchObject({ done: false, daily: [] });
    expect(first.events).toHaveLength(100);
    expect(decodeCursor(first.nextCursor)).toEqual({ v: 1, since: SINCE, until: NOW, phase: 'orders', page: 2, total: 230 });

    // An order created after the first call's window must not shift pages or appear in this pass.
    server.state.orders.push(order({ id: 'o-after-window', created: new Date(NOW + 60_000).toISOString() }));
    const later = makeCtx(server.fetch, { now: NOW + 3_600_000 });
    const second = await polarAdapter.fetchRevenue(input(), { since: SINCE + DAY_MS, cursor: first.nextCursor }, later);
    expect(second).toMatchObject({ done: true, nextCursor: null });
    expect(pagesOf(server.calls, '/v1/orders/')).toEqual([1, 2, 3]);
    const orderCalls = server.calls.filter((c) => new URL(c.url).pathname === '/v1/orders/');
    for (const c of orderCalls) expect(q(c).get('created_before')).toBe(new Date(NOW + 1).toISOString());
    const merged = byId([...first.events, ...second.events]);
    expect(merged.size).toBe(231);
    expect(merged.has('order:o-after-window')).toBe(false);
  });

  it('drains to the same result one request per call, starting from a zero budget', async () => {
    const server = fullServer();
    const zero = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch, { pageBudget: 0 }));
    expect(zero).toMatchObject({ events: [], done: false });
    expect(server.calls).toHaveLength(0);
    expect(decodeCursor(zero.nextCursor)).toMatchObject({ since: SINCE, phase: 'orders', page: 1 });

    const events: RevenueEvent[] = [];
    let cursor = zero.nextCursor;
    for (let i = 0; i < 10 && cursor; i++) {
      const p = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor }, makeCtx(server.fetch, { pageBudget: 1 }));
      events.push(...p.events);
      cursor = p.nextCursor;
      if (p.done) break;
    }
    expect(cursor).toBeNull();
    // Refund descriptions come from orders read in the same call, so a split run has fewer of them.
    expect(sorted(events).map((e) => ({ ...e, description: null }))).toEqual(sorted(EXPECTED).map((e) => ({ ...e, description: null })));
  });

  it('a 429 keeps what was read and resumes from the refused page', async () => {
    const many = Array.from({ length: 150 }, (_, i) => order({ id: `o-${i}`, created: new Date(SINCE + i * 60_000).toISOString() }));
    const server = polarServer({ orders: many, refunds: [clone(R.full)], rateLimit: new Set(['orders#2']) });
    const ctx = makeCtx(server.fetch, { pageBudget: 20 });
    const first = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(first).toMatchObject({ done: false });
    expect(first.events).toHaveLength(100);
    expect(decodeCursor(first.nextCursor)).toMatchObject({ phase: 'orders', page: 2 });
    expect(ctx.pageBudget).toBe(0);
    expect(pagesOf(server.calls, '/v1/orders/')).toEqual([1, 2]); // no retry loop on a per-minute window

    const second = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: first.nextCursor }, makeCtx(server.fetch));
    expect(second.done).toBe(true);
    expect(byId([...first.events, ...second.events]).size).toBe(151);
  });

  it('a 429 on refunds resumes in the refunds phase', async () => {
    const server = polarServer({ orders: [clone(O.paid)], refunds: [clone(R.full)], rateLimit: new Set(['refunds#1']) });
    const first = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch));
    expect(first.events.map((e) => e.externalId)).toEqual(['order:o-paid']);
    expect(decodeCursor(first.nextCursor)).toMatchObject({ phase: 'refunds', page: 1, total: null });
    const second = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: first.nextCursor }, makeCtx(server.fetch));
    expect(second).toMatchObject({ done: true, events: [expect.objectContaining({ externalId: 'refund:r-full' })] });
  });

  it('skips refund pages that only hold already-read refunds when many arrived between calls', async () => {
    const at = (i: number) => new Date(NOW - (i + 1) * 3_600_000).toISOString();
    const server = polarServer({ refunds: Array.from({ length: 250 }, (_, i) => refund({ id: `r-${i}`, created: at(i) })) });
    const first = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch, { pageBudget: 2 }));
    expect(decodeCursor(first.nextCursor)).toMatchObject({ phase: 'refunds', page: 2, total: 250 });

    // 250 newer refunds arrive: old page 2 is now page 4.
    const fresh = Array.from({ length: 250 }, (_, i) => refund({ id: `r-new-${i}`, created: new Date(NOW + (i + 1) * 1000).toISOString() }));
    server.state.refunds.push(...fresh);
    const ctx = makeCtx(server.fetch);
    const second = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: first.nextCursor }, ctx);
    expect(second.done).toBe(true);
    expect(pagesOf(server.calls, '/v1/refunds/')).toEqual([1, 2, 4, 5]);
    const merged = byId([...first.events, ...second.events]);
    for (let i = 0; i < 250; i++) expect(merged.has(`refund:r-${i}`)).toBe(true);
    expect(ctx.logs.some((l) => l.event === 'polar_refund_drift')).toBe(true);
  });

  it('an unreadable cursor restarts from since', async () => {
    const server = fullServer();
    const ctx = makeCtx(server.fetch);
    const p = await polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: 'garbage{' }, ctx);
    expect(p.done).toBe(true);
    expect(sorted(p.events)).toEqual(sorted(EXPECTED));
    expect(ctx.logs.some((l) => l.event === 'polar_cursor_invalid')).toBe(true);
  });

  it('rejects a non-finite since', async () => {
    const err = await catchErr(polarAdapter.fetchRevenue(input(), { since: Number.NaN, cursor: null }, makeCtx(fullServer().fetch)));
    expect(err.kind).toBe('invalid_input');
  });

  it('does not swallow a missing scope', async () => {
    const { fetch } = fakeFetch([route('/v1/orders/', { status: 403, json: error403Fx })]);
    const err = await catchErr(polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'permission', message: 'The Polar key is missing the “orders:read” permission.' });
  });

  it('throws a revoked token (401) mid-backfill instead of returning a cursor or a finished page', async () => {
    const { fetch } = fakeFetch([
      route('/v1/orders/', { json: list([order({ id: 'o-1' })]) }),
      route('/v1/refunds/', { status: 401, json: error401Fx }),
    ]);
    const err = await catchErr(polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'auth', field: 'apiKey' });
  });

  it.each([
    ['orders', '/v1/orders/'],
    ['refunds', '/v1/refunds/'],
  ])('refuses a 200 %s page without `items` (never reports done on an unreadable page)', async (_label, path) => {
    const routes = [route(path, { json: { detail: 'unexpected' } }), route('/v1/orders/', { json: list([]) }), route('/v1/refunds/', { json: list([]) })];
    const { fetch } = fakeFetch(routes);
    const err = await catchErr(polarAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'upstream', message: expect.stringMatching(/couldn’t read/) });
  });
});

describe('polar record mapping', () => {
  it('orderToCharge: only paid states, pre-tax, net of customer balance, fee only in the order currency', () => {
    expect(orderToCharge(orderFx)).toEqual({
      externalId: `order:${orderFx.id}`,
      occurredAt: Date.parse(orderFx.created_at),
      type: 'charge',
      amount: 1500, // total_amount 1800 includes 300 tax
      currency: 'USD',
      fee: 112,
      description: 'Pro',
    });
    for (const status of ['draft', 'pending', 'void', 'mystery']) expect(orderToCharge({ ...orderFx, status })).toBeNull();
    expect(orderToCharge({ ...orderFx, applied_balance_amount: -2000 })).toBeNull(); // paid entirely from a credit
    expect(orderToCharge({ ...orderFx, applied_balance_amount: 250 })?.amount).toBe(1750); // settled an earlier debt
    expect(orderToCharge({ ...orderFx, currency: 'eur' })?.fee).toBeNull();
    expect(orderToCharge({ ...orderFx, platform_fee_currency: null })?.fee).toBeNull();
    expect(orderToCharge({ ...orderFx, product: null, description: 'Pro – prorated' })?.description).toBe('Pro – prorated');
    expect(orderToCharge({ ...orderFx, created_at: 'nope' })).toBeNull();
    expect(orderToCharge(null)).toBeNull();
  });

  it('refundToEvent: succeeded, pre-tax, negative; tax-only refunds are not revenue', () => {
    const names = new Map([[refundFx.order_id, 'Pro']]);
    expect(refundToEvent(refundFx, names)).toEqual({
      externalId: `refund:${refundFx.id}`,
      occurredAt: Date.parse(refundFx.created_at),
      type: 'refund',
      amount: -1500,
      currency: 'USD',
      fee: null,
      description: 'Pro',
    });
    expect(refundToEvent(refundFx, new Map())?.description).toBeNull();
    for (const status of ['pending', 'failed', 'canceled']) expect(refundToEvent({ ...refundFx, status }, names)).toBeNull();
    expect(refundToEvent({ ...refundFx, amount: 0 }, names)).toBeNull();
  });
});

describe('polar cursor helpers', () => {
  it('nextRefundPage never moves past unread refunds', () => {
    expect(nextRefundPage(2, 0)).toBe(3);
    expect(nextRefundPage(2, 99)).toBe(3);
    expect(nextRefundPage(2, 100)).toBe(3);
    expect(nextRefundPage(2, 250)).toBe(4);
    expect(nextRefundPage(3, -1)).toBe(2);
    expect(nextRefundPage(1, -500)).toBe(1);
  });

  it('decodeCursor round-trips and rejects malformed input', () => {
    const c = { v: 1 as const, since: 1, until: 2, phase: 'refunds' as const, page: 3, total: 7 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('{"v":2,"since":1,"until":2,"phase":"orders","page":1,"total":null}')).toBeNull();
    expect(decodeCursor('{"v":1,"since":3,"until":2,"phase":"orders","page":1,"total":null}')).toBeNull();
    expect(decodeCursor('{"v":1,"since":1,"until":2,"phase":"invoices","page":1,"total":null}')).toBeNull();
    expect(decodeCursor('{"v":1,"since":1,"until":2,"phase":"orders","page":0,"total":null}')).toBeNull();
    expect(decodeCursor('{"v":1,"since":1,"until":2,"phase":"orders","page":1,"total":-1}')).toBeNull();
  });
});
