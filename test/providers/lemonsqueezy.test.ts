import { describe, expect, it } from 'vitest';
import {
  applyDiscount,
  classifySubscription,
  decodeCursor,
  lemonSqueezyAdapter as ls,
  pageShift,
  parsePrice,
  priceAmountMinor,
} from '../../src/providers/lemonsqueezy';
import { BudgetExhaustedError, RateLimitedError } from '../../src/providers/http';
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
import redemptionsJson from '../fixtures/lemonsqueezy/discount-redemptions.json';
import discountsJson from '../fixtures/lemonsqueezy/discounts.json';
import error401 from '../fixtures/lemonsqueezy/error-401.json';
import error404 from '../fixtures/lemonsqueezy/error-404.json';
import error429 from '../fixtures/lemonsqueezy/error-429.json';
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
const DISCOUNTS = fx<ListFixture>(discountsJson).data;
const REDEMPTIONS = fx<ListFixture>(redemptionsJson).data;

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
  discounts?: Row[];
  redemptions?: Row[];
  /** Orders only reachable by id (GET /v1/orders/{id}), e.g. checkouts older than the scanned window. */
  extraOrders?: Row[];
  pageSize?: number;
  me?: unknown;
  /** Answer the first `times` requests to `path` with 429 (Lemon Squeezy sends no Retry-After). */
  throttle?: { path: string; times: number };
}

function lsServer(o: ServerOpts = {}) {
  const state = {
    subscriptions: o.subscriptions ?? clone(SUBS),
    orders: o.orders ?? clone(ORDERS),
    extraOrders: o.extraOrders ?? [],
    invoices: o.invoices ?? clone(INVOICES.data),
    included: clone(INVOICES.included ?? []),
    stores: o.stores ?? clone(STORES),
    discounts: o.discounts ?? clone(DISCOUNTS),
    redemptions: o.redemptions ?? clone(REDEMPTIONS),
  };
  const ps = o.pageSize;
  let throttled = 0;
  const throttle = (path: string, responder: (url: URL) => FakeResponse) => (url: URL): FakeResponse => {
    if (o.throttle && o.throttle.path === path && throttled < o.throttle.times) {
      throttled += 1;
      return { status: 429, json: error429 };
    }
    return responder(url);
  };
  const ff = fakeFetch([
    route('/v1/users/me', { json: o.me ?? usersMe }),
    route('/v1/stores', jsonApiList(() => state.stores)),
    route(/^\/v1\/stores\/[^/]+$/, (url) => single(state.stores)(url)),
    route(/^\/v1\/prices\/[^/]+$/, single(PRICES)),
    route('/v1/subscriptions', throttle('/v1/subscriptions', jsonApiList(() => state.subscriptions, { pageSize: ps }))),
    route('/v1/orders', throttle('/v1/orders', jsonApiList(() => state.orders, { pageSize: ps }))),
    route(/^\/v1\/orders\/[^/]+$/, (url) => single([...state.orders, ...state.extraOrders])(url)),
    route(
      '/v1/subscription-invoices',
      throttle('/v1/subscription-invoices', jsonApiList(() => state.invoices, { pageSize: ps, included: () => state.included })),
    ),
    route('/v1/discounts', jsonApiList(() => state.discounts, { pageSize: ps })),
    route('/v1/discount-redemptions', jsonApiList(() => state.redemptions, { pageSize: ps })),
  ]);
  return { ...ff, state };
}

const pathOf = (c: RecordedCall) => new URL(c.url).pathname;
const callsTo = (calls: RecordedCall[], path: string) => calls.filter((c) => pathOf(c) === path);
const pagesOf = (calls: RecordedCall[], path: string) =>
  callsTo(calls, path).map((c) => Number(new URL(c.url).searchParams.get('page[number]')));
const orderLookups = (calls: RecordedCall[]) => calls.map(pathOf).filter((p) => /^\/v1\/orders\/.+/.test(p));
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

  it('a 429 is not retried in the same minute', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/users/me', { status: 429, json: error429 })]);
    const err = await catchErr(ls.verify({ credentials: { apiKey: KEY }, config: {} }, makeCtx(fetch)));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('lemonsqueezy fetchSnapshot', () => {
  async function snap(subs: Row[], config: ConnectionConfig = LIVE, pageSize?: number, budget = 30) {
    const server = lsServer({ subscriptions: subs, pageSize });
    const ctx = makeCtx(server.fetch, { pageBudget: budget });
    const s = await ls.fetchSnapshot(input(config), ctx);
    return { s, ctx, ...server };
  }
  const priceCalls = (calls: RecordedCall[]) => calls.filter((c) => pathOf(c).startsWith('/v1/prices/')).map(pathOf).sort();

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

  it('a cancelled free trial is a trial, never MRR (LS clears trial_ends_at once it is cancelled)', async () => {
    // #15: no subscription item ("null … if the subscription is currently in a free trial").
    const noItem = await snap(subsById(15));
    expect(noItem.s).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 1 });
    expect(priceCalls(noItem.calls)).toEqual([]);
    // #16: item present, but it ends exactly when its price's 14-day trial does.
    const withItem = await snap(subsById(16));
    expect(withItem.s).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 1 });
    expect(priceCalls(withItem.calls)).toEqual(['/v1/prices/12']);
    // #20: same trial price, but it converted and ends a year after the trial: still paying.
    const converted = await snap(subsById(20));
    expect(converted.s).toMatchObject({ mrr: { EUR: 1000 }, activeSubscriptions: 1, activeTrials: 0 });
  });

  it('on_trial counts as a trial only, without fetching its price', async () => {
    const { s, calls } = await snap(subsById(6));
    expect(s).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 1 });
    expect(callsTo(calls, '/v1/prices/12')).toHaveLength(0);
  });

  it('usage-based items are active but add no MRR (and their price is not fetched)', async () => {
    const { s, calls } = await snap(subsById(7));
    expect(s).toMatchObject({ mrr: {}, activeSubscriptions: 1 });
    expect(priceCalls(calls)).toHaveLength(0);
  });

  it('only asks for paying/trial statuses: paused, unpaid and expired never count', async () => {
    const { s, calls } = await snap(subsById(10, 12, 13));
    expect(s).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 0 });
    const statuses = callsTo(calls, '/v1/subscriptions').map((c) => new URL(c.url).searchParams.get('filter[status]'));
    expect(statuses).toEqual(['active', 'past_due', 'cancelled', 'on_trial']);
    for (const c of callsTo(calls, '/v1/subscriptions')) expect(new URL(c.url).searchParams.get('page[size]')).toBe('100');
    expect(callsTo(calls, '/v1/discounts')).toHaveLength(0); // nothing paying: no discount lookups
  });

  it('a live key ignores test-mode records; a test-mode key sees only them', async () => {
    const live = await snap(subsById(1, 8, 14), LIVE);
    expect(live.s).toMatchObject({ mrr: { EUR: 900 }, activeSubscriptions: 1, activeTrials: 0 });
    const test = await snap(subsById(1, 8, 14), TEST);
    expect(test.s).toMatchObject({ mrr: { EUR: 9000 }, activeSubscriptions: 1, activeTrials: 1 });
  });

  it('recurring discounts reduce MRR: forever, and repeating while it runs; once and elapsed ones do not', async () => {
    const { s, calls, ctx } = await snap(subsById(17, 18, 19));
    expect(s).toMatchObject({
      // #17: 50% forever → 450. #18: €3 off each quarterly payment for 6 months (redeemed 2026-09-20) →
      // (2700 − 300) / 3 = 800. #19: 20% for 1 month elapsed on 2026-10-01, plus a `once` discount → 900.
      mrr: { EUR: 450 + 800 + 900 },
      activeSubscriptions: 3,
    });
    expect(callsTo(calls, '/v1/discounts')).toHaveLength(1);
    const redeemed = callsTo(calls, '/v1/discount-redemptions').map((c) => new URL(c.url).searchParams.get('filter[discount_id]'));
    expect(redeemed.sort()).toEqual(['31', '32', '33', '35']); // never the `once` discount 34
    expect(ctx.logs.find((l) => l.event === 'ls_snapshot')?.data).toMatchObject({ discounted: 2, discounts: 'applied' });
  });

  it('applies the terms as redeemed, falling back to the discount’s own terms', async () => {
    const server = lsServer({ subscriptions: subsById(17) });
    const r = server.state.redemptions.find((x) => x.id === '44')!;
    Object.assign(r.attributes, { discount_amount: 25 }); // the discount was 25% when it was redeemed
    const a = await ls.fetchSnapshot(input(), makeCtx(server.fetch));
    expect(a.mrr).toEqual({ EUR: 675 });
    Object.assign(r.attributes, { discount_amount: null, discount_amount_type: null });
    const b = await ls.fetchSnapshot(input(), makeCtx(server.fetch));
    expect(b.mrr).toEqual({ EUR: 450 }); // the discount's current 50%
  });

  it('applyDiscount: percent of the period amount, fixed off each payment, never below zero', () => {
    expect(applyDiscount(2700, { type: 'percent', amount: 10 })).toBe(2430);
    expect(applyDiscount(2700, { type: 'fixed', amount: 300 })).toBe(2400);
    expect(applyDiscount(200, { type: 'fixed', amount: 300 })).toBe(0);
    expect(applyDiscount(900, { type: 'percent', amount: 150 })).toBe(0);
  });

  it('full account: multi-store, multi-currency MoneyMap, one /prices call per distinct price', async () => {
    const { s, calls, ctx } = await snap(SUBS);
    expect(s).toEqual({
      // EUR: 900 (#1) + 1000 (#2) + 2700 (#3) + 900 (#4) + 900 (#11) + 450 (#17, 50% off) + 800 (#18, €3 off)
      //      + 900 (#19) + 1000 (#20, cancelled after converting); USD: 1500 × 2 (#9, past_due)
      mrr: { EUR: 9550, USD: 3000 },
      activeSubscriptions: 11, // 1, 2, 3, 4, 7 (usage-based), 9, 11, 17, 18, 19, 20
      activeTrials: 3, // 6, 15 and 16 (cancelled trials); 14 is test mode
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
    });
    expect(priceCalls(calls)).toEqual(['/v1/prices/11', '/v1/prices/12', '/v1/prices/21', '/v1/prices/22']);
    expect(callsTo(calls, '/v1/users/me')).toHaveLength(0); // mode comes from config
    expect(calls.filter((c) => pathOf(c).startsWith('/v1/stores'))).toHaveLength(0); // currencies too
    expectClean(ctx, s);
  });

  it('pages through each status listing', async () => {
    const { s, calls } = await snap(SUBS, LIVE, 2);
    expect(s.mrr).toEqual({ EUR: 9550, USD: 3000 });
    expect(pagesOf(calls, '/v1/subscriptions').filter((p) => p > 1).length).toBeGreaterThan(0);
    expect(pagesOf(calls, '/v1/discounts')).toEqual([1, 2, 3]);
  });

  it('respects the Store ID filter', async () => {
    const { s, calls } = await snap(SUBS, { ...LIVE, storeId: '102' });
    expect(s).toMatchObject({ mrr: { USD: 3000 }, activeSubscriptions: 1, activeTrials: 0 });
    for (const c of callsTo(calls, '/v1/subscriptions')) expect(new URL(c.url).searchParams.get('filter[store_id]')).toBe('102');
    for (const c of callsTo(calls, '/v1/discounts')) expect(new URL(c.url).searchParams.get('filter[store_id]')).toBe('102');
  });

  it('works for connections without discovered config (looks up mode and store currencies lazily)', async () => {
    const { s, calls } = await snap(SUBS, {});
    expect(s.mrr).toEqual({ EUR: 9550, USD: 3000 });
    expect(callsTo(calls, '/v1/users/me')).toHaveLength(1);
    expect(callsTo(calls, '/v1/stores/101')).toHaveLength(1);
    expect(callsTo(calls, '/v1/stores/102')).toHaveLength(1);
  });

  it('discount lookups that don’t fit in the budget: MRR before discounts, logged, not a failure', async () => {
    // 4 listings + 4 prices + the discount list + one redemption listing, then the budget is gone.
    const { s, ctx, calls } = await snap(SUBS, LIVE, undefined, 10);
    expect(calls).toHaveLength(10);
    expect(s).toMatchObject({ mrr: { EUR: 10100, USD: 3000 }, activeSubscriptions: 11, activeTrials: 3 });
    expect(ctx.logs.find((l) => l.event === 'ls_discounts_skipped')?.data).toMatchObject({ reason: 'budget' });
    expect(ctx.logs.find((l) => l.event === 'ls_snapshot')?.data).toMatchObject({ discounts: 'skipped', discounted: 0 });
  });

  it('lets BudgetExhaustedError propagate', async () => {
    const { fetch } = lsServer();
    await expect(ls.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 3 }))).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('a 429 fails the snapshot at once: no retry in the same minute, no partial snapshot', async () => {
    const server = lsServer({ throttle: { path: '/v1/subscriptions', times: 1 } });
    const ctx = makeCtx(server.fetch, { pageBudget: 30 });
    await expect(ls.fetchSnapshot(input(), ctx)).rejects.toBeInstanceOf(RateLimitedError);
    expect(server.calls).toHaveLength(1);
    expect(ctx.pageBudget).toBe(0);
  });
});

describe('lemonsqueezy classifySubscription', () => {
  const NOW = Date.parse('2026-11-05T12:00:00Z');
  const trialPrice = parsePrice(PRICES.find((p) => p.id === '12')!); // yearly, 14-day trial
  const noTrialPrice = parsePrice(PRICES.find((p) => p.id === '11')!);
  const item = { price_id: 12, quantity: 1 };
  const cancelled = (a: Record<string, unknown>) => ({ status: 'cancelled', trial_ends_at: null, first_subscription_item: item, ...a });

  it('reads the trial from the price', () => {
    expect(trialPrice.trial).toEqual({ interval: 'day', count: 14 });
    expect(noTrialPrice.trial).toBeNull();
  });

  it('cancelled: ended → none; no item → trial; ends at the trial end → trial; ends later → paying', () => {
    const created = '2026-10-30T00:00:00Z';
    expect(classifySubscription(cancelled({ ends_at: '2026-11-01T00:00:00Z' }), NOW)).toBe('none');
    expect(classifySubscription(cancelled({ ends_at: '2026-11-13T00:00:00Z', first_subscription_item: null }), NOW)).toBe('trial');
    const inTrial = cancelled({ created_at: created, ends_at: '2026-11-13T00:00:00Z' });
    expect(classifySubscription(inTrial, NOW, trialPrice)).toBe('trial');
    expect(classifySubscription(inTrial, NOW, noTrialPrice)).toBe('paying');
    expect(classifySubscription(inTrial, NOW)).toBe('paying'); // without the price there is no evidence
    const converted = cancelled({ created_at: '2025-11-01T00:00:00Z', ends_at: '2026-11-15T00:00:00Z' });
    expect(classifySubscription(converted, NOW, trialPrice)).toBe('paying');
    // An undocumented-but-harmless trial_ends_at still wins.
    expect(classifySubscription(cancelled({ ends_at: '2026-11-13T00:00:00Z', trial_ends_at: '2026-11-13T00:00:00Z' }), NOW)).toBe('trial');
  });

  it('other statuses', () => {
    expect(classifySubscription({ status: 'active', first_subscription_item: null }, NOW)).toBe('paying');
    expect(classifySubscription({ status: 'past_due' }, NOW)).toBe('paying');
    expect(classifySubscription({ status: 'on_trial' }, NOW)).toBe('trial');
    for (const status of ['paused', 'unpaid', 'expired', 'nope']) expect(classifySubscription({ status }, NOW)).toBe('none');
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
    expect(p).toMatchObject({ interval: 'year', intervalCount: 1, usageBased: false, trial: null });
    expect(priceAmountMinor(p, 1)).toBe(11000);
    expect(priceAmountMinor(p, 5)).toBe(2 * 10000 + 1000 + 3 * 1000 + 1000);
  });

  it('volume: all units at the tier the quantity reaches', () => {
    const p = withAttrs({ scheme: 'volume' });
    expect(priceAmountMinor(p, 2)).toBe(2 * 10000 + 1000);
    expect(priceAmountMinor(p, 5)).toBe(5 * 1000 + 1000);
  });

  it('volume / graduated without tiers are unpriced: unit_price is not used for them', () => {
    for (const scheme of ['volume', 'graduated']) {
      expect(priceAmountMinor(withAttrs({ scheme, tiers: [] }), 3)).toBeNull();
      expect(priceAmountMinor(withAttrs({ scheme, tiers: null }), 3)).toBeNull();
    }
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

/** Net of tax: charges are total − tax, refunds scaled by (total − tax) / total. */
const EXPECTED: RevenueEvent[] = [
  charge('order:5001', 999, 'EUR', '2026-11-04T10:00:00Z', 'Acme Pro · Monthly'), // 1199 − 200 VAT
  charge('order:5002', 750, 'EUR', '2026-11-01T09:00:00Z', 'Acme Pro · Monthly'),
  refund('order:5002:refund', 750, 'EUR', '2026-11-02T08:00:00Z', 'Acme Pro · Monthly'),
  charge('order:5003', 1667, 'USD', '2026-10-30T15:00:00Z', 'Beta Sync'),
  refund('order:5003:refund', 417, 'USD', '2026-10-31T10:00:00Z', 'Beta Sync'), // 500 × 1667 / 2000; refunded_at null → updated_at
  refund('order:5008:refund', 250, 'EUR', '2026-11-03T12:00:00Z', 'Acme Pro · Monthly'), // late refund, order before since
  charge('invoice:7001', 750, 'EUR', '2026-11-03T00:00:00Z', 'Acme Pro · Monthly'),
  charge('invoice:7002', 375, 'EUR', '2026-11-02T12:00:00Z', 'Acme Pro · Monthly'),
  charge('invoice:7004', 2500, 'USD', '2026-10-28T00:00:00Z', 'Beta Sync'),
  refund('invoice:7004:refund', 2500, 'USD', '2026-10-29T00:00:00Z', 'Beta Sync'),
  charge('invoice:7005', 10000, 'EUR', '2026-10-27T00:00:00Z', 'Acme Pro · Yearly'), // initial, after a $0 trial checkout
  refund('invoice:7008:refund', 750, 'EUR', '2026-11-04T00:00:00Z', 'Acme Pro · Monthly'), // late partial refund
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
async function drain(server: ReturnType<typeof lsServer>, budget: number, maxCalls = 50, first: string | null = null) {
  let cursor: string | null = first;
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

/** Moves subscription 2's free-trial checkout out of the scanned window: only GET /orders/4990 knows it. */
function oldCheckout(server: ReturnType<typeof lsServer>, total: number): void {
  const sub = server.state.included.find((s) => s.id === '2')!;
  Object.assign(sub.attributes, { order_id: 4990, created_at: '2026-08-01T00:00:00.000000Z' });
  const order = clone(ORDERS.find((o) => o.id === '5011')!);
  order.id = '4990';
  Object.assign(order.attributes, { total, created_at: '2026-08-01T00:00:00.000000Z', updated_at: '2026-08-01T00:00:00.000000Z' });
  server.state.extraOrders.push(order);
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

  it('paid order → one charge, net of tax, in the order currency with the product name', async () => {
    const e = byId((await revenue()).page.events);
    expect(e.get('order:5001')).toEqual(EXPECTED[0]);
    for (const id of ['order:5004', 'order:5006', 'order:5007']) expect(e.has(id)).toBe(false); // pending, failed, $0 trial checkout
  });

  it('revenue excludes tax (merchant of record): charge = total − tax, refunds scaled by (total − tax) / total', async () => {
    const e = byId((await revenue()).page.events);
    expect(e.get('order:5001')?.amount).toBe(1199 - 200);
    expect(e.get('invoice:7001')?.amount).toBe(900 - 150);
    expect(e.get('order:5003:refund')?.amount).toBe(-Math.round((500 * (2000 - 333)) / 2000));
    expect(e.get('invoice:7008:refund')?.amount).toBe(-Math.round((900 * (2700 - 450)) / 2700));
    // A record without a tax field is all revenue.
    const orders = clone(ORDERS);
    delete orders.find((r) => r.id === '5001')!.attributes['tax'];
    expect(byId((await revenue({ orders })).page.events).get('order:5001')?.amount).toBe(1199);
  });

  it('refunded and partial_refund orders produce a charge and a separate negative refund', async () => {
    const e = byId((await revenue()).page.events);
    expect(e.get('order:5002')?.amount).toBe(750);
    expect(e.get('order:5002:refund')).toMatchObject({ type: 'refund', amount: -750, occurredAt: at('2026-11-02T08:00:00Z') });
    expect(e.get('order:5003')?.amount).toBe(1667);
    expect(e.get('order:5003:refund')).toMatchObject({ type: 'refund', amount: -417, currency: 'USD' });
  });

  it('partial refunds: one event per record, the cumulative amount, dated refunded_at once there is one', async () => {
    const orders = clone(ORDERS);
    const o = orders.find((r) => r.id === '5003')!;
    // A second partial refund: refunded_amount is cumulative, refunded_at stays null (docs example).
    Object.assign(o.attributes, { refunded_amount: 800, updated_at: '2026-11-03T09:00:00.000000Z' });
    let refunds = (await revenue({ orders })).page.events.filter((e) => e.externalId.startsWith('order:5003:'));
    expect(refunds).toEqual([refund('order:5003:refund', Math.round((800 * 1667) / 2000), 'USD', '2026-11-03T09:00:00Z', 'Beta Sync')]);
    // Then the rest: a full refund sets refunded_at, which wins over a later updated_at.
    Object.assign(o.attributes, {
      status: 'refunded',
      refunded: true,
      refunded_amount: 2000,
      refunded_at: '2026-11-04T08:00:00.000000Z',
      updated_at: '2026-11-04T09:30:00.000000Z',
    });
    refunds = (await revenue({ orders })).page.events.filter((e) => e.externalId.startsWith('order:5003:'));
    expect(refunds).toEqual([refund('order:5003:refund', 1667, 'USD', '2026-11-04T08:00:00Z', 'Beta Sync')]);
  });

  it('initial invoices: skipped when the checkout order charged money, counted after a $0 (trial) checkout', async () => {
    const { page, calls } = await revenue();
    const e = byId(page.events);
    expect(e.has('invoice:7003')).toBe(false); // initial; checkout order 5002 charged €9 → same money
    expect(e.has('invoice:7011')).toBe(false); // initial, subscription not included → assume paid at checkout
    expect(e.get('invoice:7001')).toMatchObject({ type: 'charge', amount: 750 }); // renewal
    expect(e.get('invoice:7002')).toMatchObject({ type: 'charge', amount: 375 }); // updated
    expect(e.get('invoice:7005')).toMatchObject({ type: 'charge', amount: 10000 }); // checkout order 5011 was $0
    for (const id of ['invoice:7006', 'invoice:7007']) expect(e.has(id)).toBe(false); // pending, void
    // The refunded initial invoice 7003 reports the same refund as order 5002: it lands once.
    expect([...e.keys()].filter((k) => k.startsWith('order:5002:refund'))).toHaveLength(1);
    expect(orderLookups(calls)).toEqual([]); // both checkouts were in the order scan
  });

  it('decides by money, not by timing: a paid checkout means the later initial invoice is not counted', async () => {
    const orders = clone(ORDERS);
    Object.assign(orders.find((r) => r.id === '5011')!.attributes, { total: 12000, tax: 2000 });
    const e = byId((await revenue({ orders })).page.events);
    expect(e.has('invoice:7005')).toBe(false); // created 14 days after its subscription, but already paid
  });

  it('a checkout older than the scan is looked up once (GET /orders/{id})', async () => {
    for (const [total, counted] of [
      [0, true],
      [12000, false],
    ] as const) {
      const server = lsServer();
      oldCheckout(server, total);
      const ctx = makeCtx(server.fetch, { pageBudget: 20 });
      const page = await ls.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
      expect(page.done).toBe(true);
      expect(orderLookups(server.calls)).toEqual(['/v1/orders/4990']);
      expect(byId(page.events).has('invoice:7005')).toBe(counted);
    }
  });

  it('order lookups that don’t fit in the budget continue from the cursor (lookups first, then the page)', async () => {
    const server = lsServer();
    oldCheckout(server, 0);
    const first = await ls.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(server.fetch, { pageBudget: 2 }));
    expect(first.done).toBe(false);
    expect(decodeCursor(first.nextCursor)).toMatchObject({ phase: 'invoices', page: 1, pending: ['4990'] });
    expect(first.events.some((e) => e.externalId.startsWith('invoice:'))).toBe(false); // the page waits for its lookup

    const second = await ls.fetchRevenue(input(), { since: SINCE, cursor: first.nextCursor }, makeCtx(server.fetch, { pageBudget: 1 }));
    expect(server.calls.map(pathOf).slice(2)).toEqual(['/v1/orders/4990']);
    expect(decodeCursor(second.nextCursor)).toMatchObject({ phase: 'invoices', page: 1, pending: [], orders: { '4990': 0 } });

    const third = await ls.fetchRevenue(input(), { since: SINCE, cursor: second.nextCursor }, makeCtx(server.fetch, { pageBudget: 1 }));
    expect(third.done).toBe(true);
    expect(orderLookups(server.calls)).toEqual(['/v1/orders/4990']);
    expect(sorted([...byId([...first.events, ...second.events, ...third.events]).values()])).toEqual(sorted(EXPECTED));
  });

  it('a cursor that had to drop carried orders looks every unseen checkout up instead of assuming it was paid', async () => {
    const server = lsServer();
    const cursor = JSON.stringify({ v: 2, since: SINCE, phase: 'invoices', page: 1, total: null, pending: [], orders: {}, complete: false });
    const page = await ls.fetchRevenue(input(), { since: SINCE, cursor }, makeCtx(server.fetch));
    expect(page.done).toBe(true);
    expect(orderLookups(server.calls).sort()).toEqual(['/v1/orders/5002', '/v1/orders/5011']);
    const e = byId(page.events);
    expect(e.get('invoice:7005')?.amount).toBe(10000);
    expect(e.has('invoice:7003')).toBe(false);
  });

  it('a refund reported only on the initial invoice is booked under its order', async () => {
    const orders = clone(ORDERS);
    const o = orders.find((r) => r.id === '5002')!;
    Object.assign(o.attributes, { status: 'paid', refunded: false, refunded_amount: 0, refunded_at: null });
    const e = byId((await revenue({ orders })).page.events);
    expect(e.get('order:5002')?.amount).toBe(750);
    expect(e.get('order:5002:refund')).toMatchObject({ amount: -750, occurredAt: at('2026-11-02T08:00:00Z') });
  });

  it('invoice refunds become refund events (full and late partial)', async () => {
    const e = byId((await revenue()).page.events);
    expect(e.get('invoice:7004')?.amount).toBe(2500);
    expect(e.get('invoice:7004:refund')).toMatchObject({ amount: -2500, occurredAt: at('2026-10-29T00:00:00Z') });
    expect(e.get('invoice:7008')).toBeUndefined(); // charged before `since`
    expect(e.get('invoice:7008:refund')?.amount).toBe(-750);
  });

  it('since cut-off: older records only contribute refunds made after since; paging stops at the lookback floor', async () => {
    const { page, calls } = await revenue({ pageSize: 3 });
    const e = byId(page.events);
    expect(e.has('order:5008')).toBe(false);
    expect(e.get('order:5008:refund')?.amount).toBe(-250);
    for (const id of ['order:5009', 'order:5010', 'order:5010:refund', 'order:5011', 'invoice:7010']) expect(e.has(id)).toBe(false);
    for (const ev of page.events) expect(ev.occurredAt).toBeGreaterThanOrEqual(SINCE);
    // 14 orders in pages of 3: page 4 holds 2026-09-15 (< since − 30 days) → page 5 is never read.
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
      charge('invoice:7009', 7500, 'EUR', '2026-10-30T00:00:00Z', 'Acme Pro · Monthly'),
      charge('order:5005', 3750, 'EUR', '2026-10-28T00:00:00Z', 'Acme Pro · Monthly'),
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
    // The $0 checkout seen on order page 4 travels in the cursor to the invoice pages: no lookups.
    expect(orderLookups(server.calls)).toEqual([]);
    expect(decodeCursor(pages[4]!.nextCursor)?.orders).toEqual({ '5007': 0, '5011': 0 });
  });

  it('a 429 returns what was read plus a cursor at the unread page; the next sync finishes', async () => {
    const server = lsServer({ throttle: { path: '/v1/subscription-invoices', times: 1 } });
    const ctx = makeCtx(server.fetch, { pageBudget: 20 });
    const first = await ls.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(first.done).toBe(false);
    expect(callsTo(server.calls, '/v1/subscription-invoices')).toHaveLength(1); // no retry in the same minute
    expect(ctx.pageBudget).toBe(0);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.every((e) => e.externalId.startsWith('order:'))).toBe(true);
    expect(decodeCursor(first.nextCursor)).toMatchObject({ phase: 'invoices', page: 1 });
    expect(ctx.logs.find((l) => l.event === 'ls_revenue')?.data).toMatchObject({ rateLimited: true });

    const second = await ls.fetchRevenue(input(), { since: SINCE, cursor: first.nextCursor }, makeCtx(server.fetch));
    expect(second.done).toBe(true);
    expect(sorted([...byId([...first.events, ...second.events]).values()])).toEqual(sorted(EXPECTED));
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
    expect(byId(second.events).get('order:5008:refund')?.amount).toBe(-250);
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
    const ok = { v: 2, since: 1, phase: 'invoices', page: 2, total: 7, pending: ['9'], orders: { '5': 0, '6': -1, '7': 900 }, complete: true };
    const enc = (patch: Record<string, unknown>) => JSON.stringify({ ...ok, ...patch });
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(enc({ v: 1 }))).toBeNull(); // v1 cursors don't carry checkout orders: restart
    expect(decodeCursor(enc({ phase: 'refunds' }))).toBeNull();
    expect(decodeCursor(enc({ page: 0 }))).toBeNull();
    expect(decodeCursor(enc({ pending: [5] }))).toBeNull();
    expect(decodeCursor(enc({ orders: { '5': 'zero' } }))).toBeNull();
    expect(decodeCursor(enc({ orders: { '5': -2 } }))).toBeNull();
    expect(decodeCursor(enc({ complete: 'yes' }))).toBeNull();
    expect(decodeCursor(enc({}))).toEqual(ok);
  });
});
