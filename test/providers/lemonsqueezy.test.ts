import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  lemonSqueezyAdapter as ls,
  pageShift,
  parsePrice,
  priceAmountMinor,
} from '../../src/providers/lemonsqueezy';
import { BudgetExhaustedError } from '../../src/providers/http';
import { ProviderError, type ConnectionConfig, type RevenueEvent, type RevenuePage } from '../../src/providers/types';
import {
  expectNoSecretsInLogs,
  fakeFetch,
  makeCtx,
  route,
  type FakeResponse,
  type RecordedCall,
  type TestCtx,
} from '../fixtures/harness';
import error401 from '../fixtures/lemonsqueezy/error-401.json';
import error404 from '../fixtures/lemonsqueezy/error-404.json';
import ordersJson from '../fixtures/lemonsqueezy/orders.json';
import pricesJson from '../fixtures/lemonsqueezy/prices.json';
import store101 from '../fixtures/lemonsqueezy/store-101.json';
import storesJson from '../fixtures/lemonsqueezy/stores.json';
import invoicesJson from '../fixtures/lemonsqueezy/subscription-invoices.json';
import subscriptionsJson from '../fixtures/lemonsqueezy/subscriptions.json';
import usersMe from '../fixtures/lemonsqueezy/users-me.json';
import usersMeTest from '../fixtures/lemonsqueezy/users-me-test-mode.json';

// ---------------------------------------------------------------------------------------------
// A tiny JSON:API server over the fixtures (filters, page[number]/page[size], include=subscription)
// ---------------------------------------------------------------------------------------------

interface Row {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
}
interface ListFixture {
  data: Row[];
  included?: Row[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const fx = <T>(json: unknown): T => clone(json) as T;

const SUBS = fx<ListFixture>(subscriptionsJson).data;
const ORDERS = fx<ListFixture>(ordersJson).data;
const INVOICES = fx<ListFixture>(invoicesJson);
const PRICES = fx<ListFixture>(pricesJson).data;
const STORES = fx<ListFixture>(storesJson).data;

const API = 'https://api.lemonsqueezy.com';
// JWT-shaped like a real LS key, but fake.
const KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiZmFrZS1rZXkifQ.ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Rz';

const LIVE: ConnectionConfig = { storeCurrencies: '{"101":"EUR","102":"USD"}', testMode: 'false' };
const TEST: ConnectionConfig = { storeCurrencies: '{"101":"EUR","102":"USD"}', testMode: 'true' };
const input = (config: ConnectionConfig = LIVE) => ({ credentials: { apiKey: KEY }, config });

function jsonApiList(rows: () => Row[], opts: { pageSize?: number; included?: () => Row[] } = {}) {
  return (url: URL): FakeResponse => {
    let data = rows();
    url.searchParams.forEach((v, k) => {
      const m = /^filter\[(\w+)\]$/.exec(k);
      if (m) data = data.filter((r) => String(r.attributes[m[1]!]) === v);
    });
    const size = opts.pageSize ?? Number(url.searchParams.get('page[size]') ?? '10');
    const number = Number(url.searchParams.get('page[number]') ?? '1');
    const total = data.length;
    const lastPage = Math.max(1, Math.ceil(total / size));
    const slice = data.slice((number - 1) * size, number * size);
    const link = (n: number) => `${API}${url.pathname}?page%5Bnumber%5D=${n}&page%5Bsize%5D=${size}&sort=-createdAt`;
    const body: Record<string, unknown> = {
      meta: {
        page: {
          currentPage: number,
          from: slice.length ? (number - 1) * size + 1 : null,
          lastPage,
          perPage: size,
          to: slice.length ? (number - 1) * size + slice.length : null,
          total,
        },
      },
      jsonapi: { version: '1.0' },
      links: { first: link(1), last: link(lastPage), ...(number < lastPage ? { next: link(number + 1) } : {}) },
      data: slice,
    };
    if (url.searchParams.get('include') === 'subscription' && opts.included) {
      const refs = new Set(slice.map((r) => String(r.attributes['subscription_id'])));
      body['included'] = opts.included().filter((s) => refs.has(s.id));
    }
    return { json: body };
  };
}

function single(rows: Row[]) {
  return (url: URL): FakeResponse => {
    const id = url.pathname.split('/').pop();
    const row = rows.find((r) => r.id === id);
    return row ? { json: { jsonapi: { version: '1.0' }, links: { self: `${API}${url.pathname}` }, data: row } } : { status: 404, json: error404 };
  };
}

interface ServerOpts {
  subscriptions?: Row[];
  orders?: Row[];
  invoices?: Row[];
  stores?: Row[];
  pageSize?: number;
  me?: unknown;
}

function lsServer(o: ServerOpts = {}) {
  const state = {
    subscriptions: o.subscriptions ?? clone(SUBS),
    orders: o.orders ?? clone(ORDERS),
    invoices: o.invoices ?? clone(INVOICES.data),
    included: clone(INVOICES.included ?? []),
    stores: o.stores ?? clone(STORES),
  };
  const ps = o.pageSize;
  const ff = fakeFetch([
    route('/v1/users/me', { json: o.me ?? usersMe }),
    route('/v1/stores', jsonApiList(() => state.stores)),
    route(/^\/v1\/stores\/[^/]+$/, (url) => single(state.stores)(url)),
    route(/^\/v1\/prices\/[^/]+$/, single(PRICES)),
    route('/v1/subscriptions', jsonApiList(() => state.subscriptions, { pageSize: ps })),
    route('/v1/orders', jsonApiList(() => state.orders, { pageSize: ps })),
    route('/v1/subscription-invoices', jsonApiList(() => state.invoices, { pageSize: ps, included: () => state.included })),
  ]);
  return { ...ff, state };
}

const pathOf = (c: RecordedCall) => new URL(c.url).pathname;
const callsTo = (calls: RecordedCall[], path: string) => calls.filter((c) => pathOf(c) === path);
const pagesOf = (calls: RecordedCall[], path: string) =>
  callsTo(calls, path).map((c) => Number(new URL(c.url).searchParams.get('page[number]')));
const subsById = (...ids: number[]) => SUBS.filter((s) => ids.includes(Number(s.id)));

/** Every end-customer (and merchant) name / e-mail in the fixtures. */
function piiValues(): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (['user_email', 'user_name', 'email', 'name'].includes(k) && typeof x === 'string' && /@|\s/.test(x)) out.add(x);
        walk(x);
      }
    }
  };
  [subscriptionsJson, ordersJson, invoicesJson, usersMe].forEach(walk);
  // Store names are merchant data shown in the account label, not customer PII.
  for (const s of STORES) out.delete(String(s.attributes['name']));
  return [...out];
}
const PII = piiValues();

function expectClean(ctx: TestCtx, output: unknown): void {
  expect(PII.length).toBeGreaterThan(20);
  const dump = JSON.stringify(output);
  for (const p of PII) expect(dump).not.toContain(p);
  expect(dump).not.toContain(KEY);
  expectNoSecretsInLogs(ctx, [KEY, ...PII]);
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

// ---------------------------------------------------------------------------------------------

describe('lemonsqueezy verify', () => {
  it('live key, all stores: maps stores → currencies, reports live mode, ≤ 3 requests', async () => {
    const { fetch, calls } = lsServer();
    const ctx = makeCtx(fetch);
    const r = await ls.verify({ credentials: { apiKey: KEY }, config: {} }, ctx);
    expect(r).toEqual({
      ok: true,
      accountLabel: '2 stores',
      config: { storeCurrencies: '{"101":"EUR","102":"USD"}', testMode: 'false' },
      testMode: false,
      warnings: [],
    });
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls.map(pathOf)).toEqual(['/v1/users/me', '/v1/stores']);
    for (const c of calls) {
      expect(c.url.startsWith(`${API}/v1/`)).toBe(true);
      expect(c.headers['accept']).toBe('application/vnd.api+json');
      expect(c.headers['authorization']).toBe(`Bearer ${KEY}`);
    }
    expectClean(ctx, r);
  });

  it('test-mode key with a Store ID: reads that store only and labels it', async () => {
    const { fetch, calls } = fakeFetch([
      route('/v1/users/me', { json: usersMeTest }),
      route('/v1/stores/101', { json: store101 }),
    ]);
    const ctx = makeCtx(fetch);
    const r = await ls.verify({ credentials: { apiKey: KEY }, config: { storeId: '#101' } }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.testMode).toBe(true);
    expect(r.accountLabel).toBe('Store: Acme Studio (EUR)');
    expect(r.config).toEqual({ storeCurrencies: '{"101":"EUR"}', testMode: 'true', storeId: '101' });
    expect(calls.map(pathOf)).toEqual(['/v1/users/me', '/v1/stores/101']);
    expectClean(ctx, r);
  });

  it('unknown store → not found on the storeId field', async () => {
    const { fetch } = lsServer();
    const r = await ls.verify({ credentials: { apiKey: KEY }, config: { storeId: '999' } }, makeCtx(fetch));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('storeId');
    expect(r.error).toContain('999');
  });

  it('rejects a malformed Store ID before calling the API', async () => {
    const { fetch, calls } = lsServer();
    const r = await ls.verify({ credentials: { apiKey: KEY }, config: { storeId: 'acme-studio' } }, makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'storeId' });
    expect(calls).toHaveLength(0);
  });

  it('401 → auth error on the apiKey field, no retry, key never logged', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/users/me', { status: 401, json: error401 })]);
    const ctx = makeCtx(fetch);
    const r = await ls.verify({ credentials: { apiKey: KEY }, config: {} }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('apiKey');
    expect(r.error).toMatch(/rejected the API key/);
    expect(calls).toHaveLength(1);
    expectNoSecretsInLogs(ctx, [KEY]);
  });

  it('a key that sees no stores verifies with a warning', async () => {
    const { fetch } = lsServer({ stores: [] });
    const r = await ls.verify({ credentials: { apiKey: KEY }, config: {} }, makeCtx(fetch));
    expect(r).toMatchObject({ ok: true, accountLabel: 'Lemon Squeezy (no stores)', config: { storeCurrencies: '{}' } });
    if (r.ok) expect(r.warnings).toHaveLength(1);
  });

  it('upstream failures are thrown for the caller to describe', async () => {
    const { fetch } = fakeFetch([route('/v1/users/me', { status: 503, json: {} })]);
    const err = await catchErr(ls.verify({ credentials: { apiKey: KEY }, config: {} }, makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
  });
});

// ---------------------------------------------------------------------------------------------

describe('lemonsqueezy fetchSnapshot', () => {
  async function snap(subs: Row[], config: ConnectionConfig = LIVE, pageSize?: number) {
    const server = lsServer({ subscriptions: subs, pageSize });
    const ctx = makeCtx(server.fetch, { pageBudget: 30 });
    const s = await ls.fetchSnapshot(input(config), ctx);
    return { s, ctx, ...server };
  }

  it('monthly price: unit_price × 1', async () => {
    const { s } = await snap(subsById(1));
    expect(s.mrr).toEqual({ EUR: 900 });
    expect(s.activeSubscriptions).toBe(1);
  });

  it('yearly and quarterly prices are normalised to a month', async () => {
    expect((await snap(subsById(2))).s.mrr).toEqual({ EUR: 1000 }); // 12000 / 12
    expect((await snap(subsById(11))).s.mrr).toEqual({ EUR: 900 }); // 2700 every 3 months
  });

  it('quantity > 1 multiplies the unit price', async () => {
    expect((await snap(subsById(3))).s.mrr).toEqual({ EUR: 2700 });
  });

  it('cancelled but still in its grace period counts; cancelled and ended does not', async () => {
    const a = await snap(subsById(4));
    expect(a.s.mrr).toEqual({ EUR: 900 });
    expect(a.s.activeSubscriptions).toBe(1);
    const b = await snap(subsById(5));
    expect(b.s.mrr).toEqual({});
    expect(b.s.activeSubscriptions).toBe(0);
  });

  it('on_trial counts as a trial only, without fetching its price', async () => {
    const { s, calls } = await snap(subsById(6));
    expect(s).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 1 });
    expect(callsTo(calls, '/v1/prices/12')).toHaveLength(0);
  });

  it('usage-based items are active but add no MRR (and their price is not fetched)', async () => {
    const { s, calls } = await snap(subsById(7));
    expect(s).toMatchObject({ mrr: {}, activeSubscriptions: 1 });
    expect(calls.filter((c) => pathOf(c).startsWith('/v1/prices/'))).toHaveLength(0);
  });

  it('only asks for paying/trial statuses: paused, unpaid and expired never count', async () => {
    const { s, calls } = await snap(subsById(10, 12, 13));
    expect(s).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 0 });
    const statuses = callsTo(calls, '/v1/subscriptions').map((c) => new URL(c.url).searchParams.get('filter[status]'));
    expect(statuses).toEqual(['active', 'past_due', 'cancelled', 'on_trial']);
    for (const c of callsTo(calls, '/v1/subscriptions')) expect(new URL(c.url).searchParams.get('page[size]')).toBe('100');
  });

  it('a live key ignores test-mode records; a test-mode key sees only them', async () => {
    const live = await snap(subsById(1, 8, 14), LIVE);
    expect(live.s).toMatchObject({ mrr: { EUR: 900 }, activeSubscriptions: 1, activeTrials: 0 });
    const test = await snap(subsById(1, 8, 14), TEST);
    expect(test.s).toMatchObject({ mrr: { EUR: 9000 }, activeSubscriptions: 1, activeTrials: 1 });
  });

  it('full account: multi-store, multi-currency MoneyMap, one /prices call per distinct price', async () => {
    const { s, calls, ctx } = await snap(SUBS);
    expect(s).toEqual({
      // EUR: 900 (#1) + 1000 (#2) + 2700 (#3) + 900 (#4) + 900 (#11); USD: 1500 × 2 (#9, past_due)
      mrr: { EUR: 6400, USD: 3000 },
      activeSubscriptions: 7, // 1, 2, 3, 4, 7 (usage-based), 9, 11
      activeTrials: 1, // 6 (14 is test mode)
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
    });
    const priceCalls = calls.filter((c) => pathOf(c).startsWith('/v1/prices/')).map(pathOf).sort();
    expect(priceCalls).toEqual(['/v1/prices/11', '/v1/prices/12', '/v1/prices/21', '/v1/prices/22']);
    expect(callsTo(calls, '/v1/users/me')).toHaveLength(0); // mode comes from config
    expect(calls.filter((c) => pathOf(c).startsWith('/v1/stores'))).toHaveLength(0); // currencies too
    expectClean(ctx, s);
  });

  it('pages through each status listing', async () => {
    const { s, calls } = await snap(SUBS, LIVE, 2);
    expect(s.mrr).toEqual({ EUR: 6400, USD: 3000 });
    expect(pagesOf(calls, '/v1/subscriptions').filter((p) => p > 1).length).toBeGreaterThan(0);
  });

  it('respects the Store ID filter', async () => {
    const { s, calls } = await snap(SUBS, { ...LIVE, storeId: '102' });
    expect(s).toMatchObject({ mrr: { USD: 3000 }, activeSubscriptions: 1, activeTrials: 0 });
    for (const c of callsTo(calls, '/v1/subscriptions')) expect(new URL(c.url).searchParams.get('filter[store_id]')).toBe('102');
  });

  it('works for connections without discovered config (looks up mode and store currencies lazily)', async () => {
    const { s, calls } = await snap(SUBS, {});
    expect(s.mrr).toEqual({ EUR: 6400, USD: 3000 });
    expect(callsTo(calls, '/v1/users/me')).toHaveLength(1);
    expect(callsTo(calls, '/v1/stores/101')).toHaveLength(1);
    expect(callsTo(calls, '/v1/stores/102')).toHaveLength(1);
  });

  it('lets BudgetExhaustedError propagate', async () => {
    const { fetch } = lsServer();
    await expect(ls.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 3 }))).rejects.toBeInstanceOf(BudgetExhaustedError);
  });
});

describe('lemonsqueezy price schemes', () => {
  const docsExample = {
    type: 'prices',
    id: '1',
    attributes: {
      category: 'subscription',
      scheme: 'graduated',
      usage_aggregation: null,
      unit_price: 999,
      unit_price_decimal: null,
      package_size: 1,
      tiers: [
        { last_unit: 2, unit_price: 10000, unit_price_decimal: null, fixed_fee: 1000 },
        { last_unit: 'inf', unit_price: 1000, unit_price_decimal: null, fixed_fee: 1000 },
      ],
      renewal_interval_unit: 'year',
      renewal_interval_quantity: 1,
    },
  };
  const withAttrs = (a: Record<string, unknown>) => parsePrice({ ...docsExample, attributes: { ...docsExample.attributes, ...a } });

  it('graduated: each tier prices its own units (+ its flat fee)', () => {
    const p = parsePrice(docsExample);
    expect(p).toMatchObject({ interval: 'year', intervalCount: 1, usageBased: false });
    expect(priceAmountMinor(p, 1)).toBe(11000);
    expect(priceAmountMinor(p, 5)).toBe(2 * 10000 + 1000 + 3 * 1000 + 1000);
  });

  it('volume: all units at the tier the quantity reaches', () => {
    const p = withAttrs({ scheme: 'volume' });
    expect(priceAmountMinor(p, 2)).toBe(2 * 10000 + 1000);
    expect(priceAmountMinor(p, 5)).toBe(5 * 1000 + 1000);
  });

  it('package: whole packages of package_size', () => {
    expect(priceAmountMinor(withAttrs({ scheme: 'package', tiers: null, unit_price: 1000, package_size: 5 }), 7)).toBe(2000);
  });

  it('standard with unit_price_decimal, and usage-based → null', () => {
    const dec = withAttrs({ scheme: 'standard', tiers: null, unit_price: null, unit_price_decimal: '999.5' });
    expect(priceAmountMinor(dec, 2)).toBe(1999);
    expect(priceAmountMinor(withAttrs({ scheme: 'standard', tiers: null, usage_aggregation: 'sum' }), 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

const SINCE = Date.parse('2026-10-25T00:00:00Z');
const at = (iso: string) => Date.parse(iso);
const charge = (externalId: string, amount: number, currency: string, iso: string, description: string | null): RevenueEvent => ({
  externalId,
  occurredAt: at(iso),
  type: 'charge',
  amount,
  currency,
  fee: null,
  description,
});
const refund = (externalId: string, amount: number, currency: string, iso: string, description: string | null): RevenueEvent => ({
  ...charge(externalId, -amount, currency, iso, description),
  type: 'refund',
});

const EXPECTED: RevenueEvent[] = [
  charge('order:5001', 1199, 'EUR', '2026-11-04T10:00:00Z', 'Acme Pro · Monthly'),
  charge('order:5002', 900, 'EUR', '2026-11-01T09:00:00Z', 'Acme Pro · Monthly'),
  refund('order:5002:refund', 900, 'EUR', '2026-11-02T08:00:00Z', 'Acme Pro · Monthly'),
  charge('order:5003', 2000, 'USD', '2026-10-30T15:00:00Z', 'Beta Sync'),
  refund('order:5003:refund', 500, 'USD', '2026-10-31T10:00:00Z', 'Beta Sync'), // partial: refunded_at null → updated_at
  refund('order:5008:refund', 300, 'EUR', '2026-11-03T12:00:00Z', 'Acme Pro · Monthly'), // late refund, order before since
  charge('invoice:7001', 900, 'EUR', '2026-11-03T00:00:00Z', 'Acme Pro · Monthly'),
  charge('invoice:7002', 450, 'EUR', '2026-11-02T12:00:00Z', 'Acme Pro · Monthly'),
  charge('invoice:7004', 3000, 'USD', '2026-10-28T00:00:00Z', 'Beta Sync'),
  refund('invoice:7004:refund', 3000, 'USD', '2026-10-29T00:00:00Z', 'Beta Sync'),
  charge('invoice:7005', 12000, 'EUR', '2026-10-27T00:00:00Z', 'Acme Pro · Yearly'), // initial, after a 14-day trial
  refund('invoice:7008:refund', 900, 'EUR', '2026-11-04T00:00:00Z', 'Acme Pro · Monthly'), // late partial refund
];

const byId = (events: RevenueEvent[]) => new Map(events.map((e) => [e.externalId, e]));
const sorted = (events: RevenueEvent[]) => [...events].sort((a, b) => a.externalId.localeCompare(b.externalId));

async function revenue(opts: ServerOpts & { config?: ConnectionConfig; budget?: number; since?: number } = {}) {
  const server = lsServer(opts);
  const ctx = makeCtx(server.fetch, { pageBudget: opts.budget ?? 20 });
  const page = await ls.fetchRevenue(input(opts.config), { since: opts.since ?? SINCE, cursor: null }, ctx);
  return { page, ctx, ...server };
}

/** Calls fetchRevenue with a fresh budget per call until done; returns all events (later ones win). */
async function drain(server: ReturnType<typeof lsServer>, budget: number, maxCalls = 50) {
  let cursor: string | null = null;
  const all = new Map<string, RevenueEvent>();
  const pages: RevenuePage[] = [];
  for (let i = 0; i < maxCalls; i++) {
    const ctx = makeCtx(server.fetch, { pageBudget: budget });
    const p = await ls.fetchRevenue(input(), { since: SINCE, cursor }, ctx);
    pages.push(p);
    for (const e of p.events) all.set(e.externalId, e);
    if (p.done) return { events: [...all.values()], pages };
    expect(p.nextCursor).not.toBeNull();
    cursor = p.nextCursor;
  }
  throw new Error('fetchRevenue never finished');
}

describe('lemonsqueezy fetchRevenue', () => {
  it('reads orders then invoices and returns exactly the expected events', async () => {
    const { page, calls, ctx } = await revenue();
    expect(page.done).toBe(true);
    expect(page.nextCursor).toBeNull();
    expect(page.daily).toEqual([]);
    expect(sorted(page.events)).toEqual(sorted(EXPECTED));
    expect(calls.map(pathOf)).toEqual(['/v1/orders', '/v1/subscription-invoices']);
    const inv = new URL(callsTo(calls, '/v1/subscription-invoices')[0]!.url);
    expect(inv.searchParams.get('include')).toBe('subscription');
    expect(inv.searchParams.get('page[size]')).toBe('100');
    expectClean(ctx, page);
  });

  it('paid order → one charge with total, order currency and product name', async () => {
    const e = byId((await revenue()).page.events);
    expect(e.get('order:5001')).toEqual(EXPECTED[0]);
    for (const id of ['order:5004', 'order:5006', 'order:5007']) expect(e.has(id)).toBe(false); // pending, failed, $0 trial checkout
  });

  it('refunded and partial_refund orders produce a charge and a separate negative refund', async () => {
    const e = byId((await revenue()).page.events);
    expect(e.get('order:5002')?.amount).toBe(900);
    expect(e.get('order:5002:refund')).toMatchObject({ type: 'refund', amount: -900, occurredAt: at('2026-11-02T08:00:00Z') });
    expect(e.get('order:5003')?.amount).toBe(2000);
    expect(e.get('order:5003:refund')).toMatchObject({ type: 'refund', amount: -500, currency: 'USD' });
  });

  it('initial invoices paid at checkout are not counted again; renewal and updated are', async () => {
    const e = byId((await revenue()).page.events);
    expect(e.has('invoice:7003')).toBe(false); // initial, same money as order 5002
    expect(e.has('invoice:7011')).toBe(false); // initial, subscription not included → assume checkout
    expect(e.get('invoice:7001')).toMatchObject({ type: 'charge', amount: 900 }); // renewal
    expect(e.get('invoice:7002')).toMatchObject({ type: 'charge', amount: 450 }); // updated
    expect(e.get('invoice:7005')).toMatchObject({ type: 'charge', amount: 12000 }); // initial, charged at trial end
    for (const id of ['invoice:7006', 'invoice:7007']) expect(e.has(id)).toBe(false); // pending, void
    // The refunded initial invoice 7003 reports the same refund as order 5002: it lands once.
    expect([...e.keys()].filter((k) => k.startsWith('order:5002:refund'))).toHaveLength(1);
  });

  it('a refund reported only on the initial invoice is booked under its order', async () => {
    const orders = clone(ORDERS);
    const o = orders.find((r) => r.id === '5002')!;
    Object.assign(o.attributes, { status: 'paid', refunded: false, refunded_amount: 0, refunded_at: null });
    const e = byId((await revenue({ orders })).page.events);
    expect(e.get('order:5002')?.amount).toBe(900);
    expect(e.get('order:5002:refund')).toMatchObject({ amount: -900, occurredAt: at('2026-11-02T08:00:00Z') });
  });

  it('invoice refunds become refund events (full and late partial)', async () => {
    const e = byId((await revenue()).page.events);
    expect(e.get('invoice:7004')?.amount).toBe(3000);
    expect(e.get('invoice:7004:refund')).toMatchObject({ amount: -3000, occurredAt: at('2026-10-29T00:00:00Z') });
    expect(e.get('invoice:7008')).toBeUndefined(); // charged before `since`
    expect(e.get('invoice:7008:refund')?.amount).toBe(-900);
  });

  it('since cut-off: older records only contribute refunds made after since; paging stops at the lookback floor', async () => {
    const { page, calls } = await revenue({ pageSize: 3 });
    const e = byId(page.events);
    expect(e.has('order:5008')).toBe(false);
    expect(e.get('order:5008:refund')?.amount).toBe(-300);
    for (const id of ['order:5009', 'order:5010', 'order:5010:refund', 'order:5011', 'invoice:7010']) expect(e.has(id)).toBe(false);
    for (const ev of page.events) expect(ev.occurredAt).toBeGreaterThanOrEqual(SINCE);
    // 14 orders in pages of 3: page 4 holds 2026-10-01 (< since − 14 days) → page 5 is never read.
    expect(pagesOf(calls, '/v1/orders')).toEqual([1, 2, 3, 4]);
    expect(pagesOf(calls, '/v1/subscription-invoices')).toEqual([1, 2, 3, 4]);
    expect(sorted(page.events)).toEqual(sorted(EXPECTED));
  });

  it('respects the Store ID filter', async () => {
    const { page, calls } = await revenue({ config: { ...LIVE, storeId: '102' } });
    expect(page.events.map((e) => e.externalId).sort()).toEqual(['invoice:7004', 'invoice:7004:refund', 'order:5003', 'order:5003:refund']);
    for (const c of calls) expect(new URL(c.url).searchParams.get('filter[store_id]')).toBe('102');
  });

  it('a test-mode key sees only test-mode records', async () => {
    const { page } = await revenue({ config: TEST });
    expect(sorted(page.events)).toEqual([
      charge('invoice:7009', 9000, 'EUR', '2026-10-30T00:00:00Z', 'Acme Pro · Monthly'),
      charge('order:5005', 4500, 'EUR', '2026-10-28T00:00:00Z', 'Acme Pro · Monthly'),
    ]);
  });

  it('returns a cursor when pageBudget runs out, and the resumed call finishes', async () => {
    const server = lsServer({ pageSize: 3 });
    const ctx1 = makeCtx(server.fetch, { pageBudget: 2 });
    const first = await ls.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx1);
    expect(first).toMatchObject({ done: false, daily: [] });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(server.calls).toHaveLength(2);
    expect(first.events.length).toBeGreaterThan(0);

    const ctx2 = makeCtx(server.fetch, { pageBudget: 20 });
    // A resumed run keeps the cursor's window even if the caller's `since` moved.
    const second = await ls.fetchRevenue(input(), { since: SINCE + 86_400_000, cursor: first.nextCursor }, ctx2);
    expect(second.done).toBe(true);
    expect(second.nextCursor).toBeNull();
    expect(pagesOf(server.calls, '/v1/orders')).toEqual([1, 2, 3, 4]);
    const merged = new Map([...first.events, ...second.events].map((e) => [e.externalId, e]));
    expect(sorted([...merged.values()])).toEqual(sorted(EXPECTED));
  });

  it('drains to the same result one page per call (including a zero-budget start)', async () => {
    const server = lsServer({ pageSize: 3 });
    const zero = await ls.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch, { pageBudget: 0 }));
    expect(zero).toMatchObject({ events: [], done: false });
    expect(server.calls).toHaveLength(0);
    expect(decodeCursor(zero.nextCursor)).toMatchObject({ since: SINCE, phase: 'orders', page: 1 });

    const { events, pages } = await drain(server, 1);
    expect(sorted(events)).toEqual(sorted(EXPECTED));
    expect(pages.length).toBe(8); // 4 order pages + 4 invoice pages
  });

  it('re-anchors the page number when records were removed between runs (no skipped records)', async () => {
    const server = lsServer({ pageSize: 3 });
    const first = await ls.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch, { pageBudget: 2 }));
    expect(decodeCursor(first.nextCursor)).toMatchObject({ phase: 'orders', page: 3, total: 14 });
    // Three already-read orders disappear: naive page 3 would now start at what used to be page 4.
    server.state.orders.splice(0, 3);
    const ctx = makeCtx(server.fetch, { pageBudget: 20 });
    const second = await ls.fetchRevenue(input(), { since: SINCE, cursor: first.nextCursor }, ctx);
    expect(second.done).toBe(true);
    expect(byId(second.events).get('order:5008:refund')?.amount).toBe(-300);
    expect(pagesOf(server.calls, '/v1/orders')).toEqual([1, 2, 3, 2, 3]);
    expect(ctx.logs.some((l) => l.event === 'ls_page_drift')).toBe(true);
  });

  it('skips pages that only hold already-read records when many new ones arrived between runs', async () => {
    const server = lsServer({ pageSize: 3 });
    const first = await ls.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch, { pageBudget: 2 }));
    const fresh = [1, 2, 3, 4, 5, 6].map((n) => {
      const o = clone(ORDERS[0]!);
      o.id = String(6000 + n);
      o.attributes['created_at'] = `2026-11-05T0${n}:00:00.000000Z`;
      return o;
    });
    server.state.orders.unshift(...fresh.reverse());
    const second = await ls.fetchRevenue(input(), { since: SINCE, cursor: first.nextCursor }, makeCtx(server.fetch, { pageBudget: 20 }));
    expect(second.done).toBe(true);
    // page 3 now holds old page 1; jump straight to page 5 (old page 3) instead of re-reading pages 3–4.
    expect(pagesOf(server.calls, '/v1/orders')).toEqual([1, 2, 3, 5, 6]);
    const merged = byId([...first.events, ...second.events]);
    for (const e of EXPECTED) expect(merged.get(e.externalId)).toEqual(e);
  });

  it('an unreadable cursor restarts from since', async () => {
    const server = lsServer();
    const ctx = makeCtx(server.fetch);
    const p = await ls.fetchRevenue(input(), { since: SINCE, cursor: 'garbage{' }, ctx);
    expect(p.done).toBe(true);
    expect(sorted(p.events)).toEqual(sorted(EXPECTED));
    expect(ctx.logs.some((l) => l.event === 'ls_cursor_invalid')).toBe(true);
  });
});

describe('lemonsqueezy cursor helpers', () => {
  it('pageShift never moves past unread records', () => {
    expect(pageShift(0, 100)).toBe(0);
    expect(pageShift(99, 100)).toBe(0);
    expect(pageShift(100, 100)).toBe(1);
    expect(pageShift(250, 100)).toBe(2);
    expect(pageShift(-1, 100)).toBe(-1);
    expect(pageShift(-101, 100)).toBe(-2);
  });

  it('decodeCursor rejects malformed input', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('{"v":2,"since":1,"phase":"orders","page":1,"total":null}')).toBeNull();
    expect(decodeCursor('{"v":1,"since":1,"phase":"refunds","page":1,"total":null}')).toBeNull();
    expect(decodeCursor('{"v":1,"since":1,"phase":"invoices","page":0,"total":null}')).toBeNull();
    expect(decodeCursor('{"v":1,"since":1,"phase":"invoices","page":2,"total":7}')).toEqual({
      v: 1,
      since: 1,
      phase: 'invoices',
      page: 2,
      total: 7,
    });
  });
});
