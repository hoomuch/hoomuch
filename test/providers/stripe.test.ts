import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../../src/providers/http';
import { formatMoney } from '../../src/lib/money';
import {
  COUPONS_PERMISSION_WARNING,
  fromStripeAmount,
  PRODUCTS_PERMISSION_WARNING,
  SECRET_KEY_WARNING,
  splitRounded,
  STRIPE_API_VERSION,
  STRIPE_COUPONS_WARNING,
  STRIPE_PRODUCT_SPLIT_SKIPPED_WARNING,
  STRIPE_PRODUCTS_WARNING,
  stripeAdapter,
  stripeDigits,
  stripeDiscountsUnresolvedWarning,
  stripeInclusiveTaxWarning,
  stripeUnpricedItemsWarning,
} from '../../src/providers/stripe';
import { ProviderError, type MetricsSnapshot } from '../../src/providers/types';
import {
  expectNoSecretsInLogs,
  fakeFetch,
  makeCtx,
  NOW,
  route,
  type FakeResponse,
  type RecordedCall,
  type Route,
} from '../fixtures/harness';
// Verbatim example objects from https://docs.stripe.com/api for Stripe-Version 2026-10-28.endive.
import subscriptionFx from '../fixtures/stripe/subscription.json';
import discountFx from '../fixtures/stripe/discount.json';
import couponFx from '../fixtures/stripe/coupon.json';
import priceFx from '../fixtures/stripe/price.json';
import taxRateFx from '../fixtures/stripe/tax_rate.json';
import balanceTransactionFx from '../fixtures/stripe/balance_transaction.json';
import productFx from '../fixtures/stripe/product.json';
import listFx from '../fixtures/stripe/list.json';
import errorInvalidKeyFx from '../fixtures/stripe/error_invalid_key.json';
import errorPermissionFx from '../fixtures/stripe/error_permission.json';

// Fixture variations are deep clones of the docs objects with a few fields overridden, so every
// payload keeps the exact shape of the pinned API version.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

// Same fake key that appears (unmasked) inside error_permission.json, to prove logs mask it.
const RK_TEST = 'rk_test_51FakeKeyForTestsOnly000000000000000000000000000000000000000000000000000000000000';
const RK_LIVE = 'rk_live_51FakeKeyForTestsOnly1111111111111111111111111111';
const SK_LIVE = 'sk_live_51FakeKeyForTestsOnly2222222222222222222222222222';
const SK_TEST = 'sk_test_51FakeKeyForTestsOnly3333333333333333333333333333';
const NOW_S = Math.floor(NOW / 1000);
const DAY_S = 86_400;

const input = (apiKey = RK_TEST) => ({ credentials: { apiKey }, config: {} });

let seq = 0;
const nextId = (prefix: string) => `${prefix}_Fake${(++seq).toString().padStart(4, '0')}`;

interface PriceOpts {
  amount?: number | null;
  decimal?: string | null;
  currency?: string;
  interval?: string;
  count?: number;
  usage?: 'licensed' | 'metered';
  /** true = graduated. */
  tiered?: boolean | 'volume' | 'graduated';
  taxBehavior?: 'inclusive' | 'exclusive' | 'unspecified';
  product?: string;
  id?: string;
  transform?: { divide_by: number; round: 'up' | 'down' };
}

function price(o: PriceOpts = {}): Json {
  const p = clone(subscriptionFx.items.data[0]!.price);
  p.id = o.id ?? nextId('price');
  p.currency = o.currency ?? 'usd';
  p.product = o.product ?? 'prod_FakeMain';
  p.recurring.interval = o.interval ?? 'month';
  p.recurring.interval_count = o.count ?? 1;
  p.recurring.usage_type = o.usage ?? 'licensed';
  p.transform_quantity = o.transform ?? null;
  p.tax_behavior = o.taxBehavior ?? p.tax_behavior;
  if (o.tiered) {
    p.billing_scheme = 'tiered';
    p.tiers_mode = o.tiered === true ? 'graduated' : o.tiered;
    p.unit_amount = null;
    p.unit_amount_decimal = null;
  } else {
    p.unit_amount = o.amount === undefined ? 1000 : o.amount;
    p.unit_amount_decimal = o.decimal !== undefined ? o.decimal : p.unit_amount === null ? null : String(p.unit_amount);
  }
  return p;
}

/** A tier as the Price object returns it (with expand[]=tiers). `upTo` null = inf. */
function tier(upTo: number | null, unit: number | null, flat: number | null = null): Json {
  return {
    flat_amount: flat,
    flat_amount_decimal: flat === null ? null : String(flat),
    unit_amount: unit,
    unit_amount_decimal: unit === null ? null : String(unit),
    up_to: upTo,
  };
}

/** GET /v1/prices/{id}?expand[]=tiers for the tiered price `p`: the docs' Price object with `tiers` included. */
function tieredFull(p: Json, tiers: Json[]): Json {
  return {
    ...clone(priceFx),
    id: p.id,
    currency: p.currency,
    product: p.product,
    recurring: clone(p.recurring),
    billing_scheme: 'tiered',
    tiers_mode: p.tiers_mode,
    unit_amount: null,
    unit_amount_decimal: null,
    tiers,
  };
}

function taxRate(percentage: number, inclusive: boolean): Json {
  return { ...clone(taxRateFx), id: nextId('txr'), percentage, inclusive };
}

function item(p: Json, o: { quantity?: number | null; discounts?: Json[]; trialEnd?: number; taxRates?: Json[] } = {}): Json {
  const it = clone(subscriptionFx.items.data[0]);
  it.id = nextId('si');
  it.price = p;
  Object.assign(it.plan, {
    id: p.id,
    amount: p.unit_amount,
    amount_decimal: p.unit_amount_decimal,
    billing_scheme: p.billing_scheme,
    currency: p.currency,
    interval: p.recurring.interval,
    interval_count: p.recurring.interval_count,
    usage_type: p.recurring.usage_type,
    product: p.product,
  });
  it.quantity = o.quantity === undefined ? 1 : o.quantity;
  it.discounts = o.discounts ?? [];
  it.current_trial = o.trialEnd ? { end_date: o.trialEnd, start_date: o.trialEnd - 14 * DAY_S, trial_offer: 'trlo_Fake1' } : null;
  it.tax_rates = o.taxRates ?? [];
  return it;
}

interface SubOpts {
  currency?: string;
  status?: string;
  discounts?: Json[];
  moreItems?: boolean;
  defaultTaxRates?: Json[];
  /** Stripe Tax on. */
  automaticTax?: boolean;
}

function sub(items: Json[], o: SubOpts = {}): Json {
  const s = clone(subscriptionFx);
  s.id = nextId('sub');
  s.currency = o.currency ?? 'usd';
  s.status = o.status ?? 'active';
  s.discounts = o.discounts ?? [];
  s.default_tax_rates = o.defaultTaxRates ?? [];
  if (o.automaticTax) s.automatic_tax = { enabled: true, liability: { type: 'self' } };
  s.items.data = items.map((i) => ({ ...i, subscription: s.id }));
  s.items.has_more = o.moreItems ?? false;
  s.items.total_count = items.length;
  s.items.url = `/v1/subscription_items?subscription=${s.id}`;
  return s;
}

/** Shorthand: one licensed monthly item. */
const simple = (amount: number, o: SubOpts & PriceOpts = {}) =>
  sub([item(price({ amount, currency: o.currency, interval: o.interval, count: o.count }))], o);

function discount(couponId: string, end: number | null = null): Json {
  const d = clone(discountFx);
  d.id = nextId('di');
  d.checkout_session = null;
  d.source.coupon = couponId;
  d.end = end;
  return d;
}

function coupon(id: string, o: Json): Json {
  return { ...clone(couponFx), id, percent_off: null, duration: 'forever', duration_in_months: null, ...o };
}

function list(data: Json[], hasMore = false, url = '/v1/subscriptions'): Json {
  return { ...clone(listFx), url, data, has_more: hasMore };
}

function bt(id: string, type: string, amount: number, o: Json = {}): Json {
  return {
    ...clone(balanceTransactionFx),
    id,
    type,
    amount,
    net: amount - (o['fee'] ?? 0),
    created: NOW_S - 3600,
    available_on: NOW_S + 2 * DAY_S,
    currency: 'usd',
    fee: 0,
    reporting_category: type === 'payment' ? 'charge' : type === 'payment_refund' ? 'refund' : type,
    source: null,
    ...o,
  };
}

function expectStripeHeaders(calls: RecordedCall[], key = RK_TEST): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.method).toBe('GET');
    expect(c.url.startsWith('https://api.stripe.com/v1/')).toBe(true);
    expect(c.headers['authorization']).toBe(`Bearer ${key}`);
    expect(c.headers['stripe-version']).toBe(STRIPE_API_VERSION);
  }
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

describe('stripe verify', () => {
  const okRoutes = () => [
    route('/v1/subscriptions', { json: list([sub([item(price())])]) }, { query: { limit: '1' } }),
    route('/v1/prices', { json: list([clone(priceFx)], false, '/v1/prices') }, { query: { limit: '1' } }),
    route('/v1/balance_transactions', { json: list([clone(balanceTransactionFx)], false, '/v1/balance_transactions') }, { query: { limit: '1' } }),
    route('/v1/coupons', { json: list([clone(couponFx)], false, '/v1/coupons') }, { query: { limit: '1' } }),
    route('/v1/products', { json: list([clone(productFx)], false, '/v1/products') }, { query: { limit: '1' } }),
  ];
  const forbidden = (scope: string): Json => {
    const err = clone(errorPermissionFx);
    err.error.message = err.error.message.replace('rak_subscription_read', scope);
    return err;
  };

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['publishable key', 'pk_live_51FakeKey'],
    ['webhook secret', 'whsec_FakeSecret123'],
    ['unknown mode', 'rk_prod_51FakeKey'],
    ['prefix only', 'rk_live_'],
    ['inner whitespace', 'rk_live_51Fake Key'],
    ['header prefix pasted', 'Bearer rk_live_51FakeKey'],
    ['RevenueCat-style key', 'sk_FakeRevenueCatKey'],
  ])('rejects a %s key on the apiKey field without a network call', async (_label, key) => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await stripeAdapter.verify(input(key), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error.length).toBeGreaterThan(10);
    expect(calls).toHaveLength(0);
  });

  it('explains that a publishable key is the wrong kind', async () => {
    const res = await stripeAdapter.verify(input('pk_test_51FakeKey'), makeCtx(fakeFetch([]).fetch));
    expect(!res.ok && res.error).toMatch(/publishable/);
  });

  const PROBES = ['/v1/subscriptions', '/v1/prices', '/v1/balance_transactions', '/v1/coupons', '/v1/products'];

  it('accepts a restricted test key with 5 pinned, authenticated reads, within the verify budget', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const ctx = makeCtx(fetch, { pageBudget: 5 }); // services/connections.ts gives verify 5
    const res = await stripeAdapter.verify(input(`  ${RK_TEST}  `), ctx);
    expect(res).toEqual({ ok: true, accountLabel: 'Stripe (test mode)', config: {}, testMode: true, warnings: [] });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(PROBES);
    expectStripeHeaders(calls);
    expect(ctx.pageBudget).toBe(0);
  });

  it('accepts a key without Products: Read, with a warning that MRR isn’t split by product', async () => {
    const routes = okRoutes().filter((r) => !r.label.startsWith('/v1/products'));
    const { fetch, calls } = fakeFetch([route('/v1/products', { status: 403, json: forbidden('rak_product_read') }), ...routes]);
    const ctx = makeCtx(fetch);
    const res = await stripeAdapter.verify(input(RK_LIVE), ctx);
    expect(res).toEqual({ ok: true, accountLabel: 'Stripe (live)', config: {}, testMode: false, warnings: [PRODUCTS_PERMISSION_WARNING] });
    expect(PRODUCTS_PERMISSION_WARNING).toMatch(/isn’t split by product.*Products: Read/);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(PROBES);
    expectNoSecretsInLogs(ctx, [RK_LIVE, RK_TEST.slice(8)]);
  });

  it('lists both optional permissions when a key has neither', async () => {
    const routes = okRoutes().filter((r) => !r.label.startsWith('/v1/coupons') && !r.label.startsWith('/v1/products'));
    const { fetch } = fakeFetch([
      route('/v1/coupons', { status: 403, json: forbidden('rak_coupon_read') }),
      route('/v1/products', { status: 403, json: forbidden('rak_product_read') }),
      ...routes,
    ]);
    const res = await stripeAdapter.verify(input(SK_TEST), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, warnings: [SECRET_KEY_WARNING, COUPONS_PERMISSION_WARNING, PRODUCTS_PERMISSION_WARNING] });
  });

  it('treats other failures of the products probe like any other request', async () => {
    const routes = okRoutes().filter((r) => !r.label.startsWith('/v1/products'));
    const down = fakeFetch([route('/v1/products', { status: 503, json: { error: { message: 'down' } } }), ...routes]);
    expect((await catchErr(stripeAdapter.verify(input(), makeCtx(down.fetch)))).kind).toBe('upstream');
  });

  it('accepts a key without Coupons: Read, with a warning that MRR is before discounts', async () => {
    const routes = okRoutes().filter((r) => !r.label.startsWith('/v1/coupons'));
    const { fetch, calls } = fakeFetch([route('/v1/coupons', { status: 403, json: forbidden('rak_coupon_read') }), ...routes]);
    const ctx = makeCtx(fetch);
    const res = await stripeAdapter.verify(input(RK_LIVE), ctx);
    expect(res).toEqual({ ok: true, accountLabel: 'Stripe (live)', config: {}, testMode: false, warnings: [COUPONS_PERMISSION_WARNING] });
    expect(COUPONS_PERMISSION_WARNING).toMatch(/before discounts.*Coupons: Read/);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(PROBES);
    expectNoSecretsInLogs(ctx, [RK_LIVE, RK_TEST.slice(8)]);
  });

  it('keeps the secret-key warning next to the coupons warning', async () => {
    const routes = okRoutes().filter((r) => !r.label.startsWith('/v1/coupons'));
    const { fetch } = fakeFetch([route('/v1/coupons', { status: 403, json: forbidden('rak_coupon_read') }), ...routes]);
    const res = await stripeAdapter.verify(input(SK_TEST), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, warnings: [SECRET_KEY_WARNING, COUPONS_PERMISSION_WARNING] });
  });

  it('treats other failures of the coupons probe like any other request', async () => {
    const routes = okRoutes().filter((r) => !r.label.startsWith('/v1/coupons'));
    const down = fakeFetch([route('/v1/coupons', { status: 503, json: { error: { message: 'down' } } }), ...routes]);
    expect((await catchErr(stripeAdapter.verify(input(), makeCtx(down.fetch)))).kind).toBe('upstream');

    const revoked = fakeFetch([route('/v1/coupons', { status: 401, json: errorInvalidKeyFx }), ...okRoutes()]);
    const res = await stripeAdapter.verify(input(), makeCtx(revoked.fetch));
    expect(res).toMatchObject({ ok: false, field: 'apiKey', error: expect.stringMatching(/Stripe rejected this key/) });
  });

  it('labels a live restricted key as live', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await stripeAdapter.verify(input(RK_LIVE), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, accountLabel: 'Stripe (live)', testMode: false, warnings: [] });
    expectStripeHeaders(calls, RK_LIVE);
  });

  it.each([
    [SK_LIVE, false],
    [SK_TEST, true],
  ])('warns about a full-access secret key (%s)', async (key, testMode) => {
    const { fetch } = fakeFetch(okRoutes());
    const res = await stripeAdapter.verify(input(key), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, testMode, warnings: [SECRET_KEY_WARNING] });
    expect(SECRET_KEY_WARNING).toMatch(/full-access secret key/);
  });

  it('reports a rejected key (401) on the apiKey field after one request', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/subscriptions', { status: 401, json: errorInvalidKeyFx })]);
    const ctx = makeCtx(fetch);
    const res = await stripeAdapter.verify(input(RK_LIVE), ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error).toMatch(/Stripe rejected this key/);
    expect(calls).toHaveLength(1);
    expectNoSecretsInLogs(ctx, [RK_LIVE]);
  });

  it('names the missing Subscriptions permission (403) and never logs the key', async () => {
    const { fetch } = fakeFetch([route('/v1/subscriptions', { status: 403, json: errorPermissionFx })]);
    const ctx = makeCtx(fetch);
    const res = await stripeAdapter.verify(input(), ctx);
    expect(res).toEqual({
      ok: false,
      field: 'apiKey',
      error: 'The Stripe key is missing the “Subscriptions: Read” permission (rak_subscription_read).',
    });
    expectNoSecretsInLogs(ctx, [RK_TEST, RK_TEST.slice(8)]);
  });

  it.each([
    ['/v1/prices', 'Prices: Read', 'rak_plan_read'],
    ['/v1/balance_transactions', 'Balance: Read', 'rak_balance_read'],
  ])('names the missing permission when %s is forbidden', async (path, permission, scope) => {
    const routes = okRoutes().filter((r) => !r.label.startsWith(path));
    const { fetch } = fakeFetch([route(path, { status: 403, json: forbidden(scope) }), ...routes]);
    const res = await stripeAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({ ok: false, field: 'apiKey', error: `The Stripe key is missing the “${permission}” permission (${scope}).` });
  });

  it('throws transient upstream failures for the caller to describe', async () => {
    const { fetch } = fakeFetch([route('/v1/subscriptions', { status: 503, json: { error: { message: 'down' } } })]);
    const err = await catchErr(stripeAdapter.verify(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
  });
});

// ---------- snapshot ----------

interface SnapshotSetup {
  active?: Json[];
  pastDue?: Json[];
  trialing?: Json[];
  coupons?: Json[];
  prices?: Json[];
  /** Product names by ID. Products not listed are named after their ID ("prod_FakeMain" → "FakeMain"). */
  products?: Record<string, string>;
  /** Matched before the defaults. */
  extra?: Route[];
  budget?: number;
}

/** GET /v1/products?ids[]=…: the docs' Product object for each requested ID. */
function productsFor(names: Record<string, string> = {}) {
  return (url: URL): FakeResponse => {
    const data = url.searchParams
      .getAll('ids[]')
      .map((id) => ({ ...clone(productFx), id, name: names[id] ?? id.replace(/^prod_/, '') }));
    return { json: list(data, false, '/v1/products') };
  };
}

function snapshotRoutes(s: SnapshotSetup): Route[] {
  return [
    ...(s.extra ?? []),
    route('/v1/subscriptions', { json: list(s.active ?? []) }, { query: { status: 'active' } }),
    route('/v1/subscriptions', { json: list(s.pastDue ?? []) }, { query: { status: 'past_due' } }),
    route('/v1/subscriptions', { json: list(s.trialing ?? []) }, { query: { status: 'trialing' } }),
    ...(s.coupons ?? []).map((c) => route(`/v1/coupons/${c['id']}`, { json: c })),
    ...(s.prices ?? []).map((p) => route(`/v1/prices/${p['id']}`, { json: p })),
    route('/v1/products', productsFor(s.products)),
  ];
}

async function snapshot(s: SnapshotSetup) {
  const { fetch, calls } = fakeFetch(snapshotRoutes(s));
  const ctx = makeCtx(fetch, { pageBudget: s.budget ?? 30 });
  const snap = await stripeAdapter.fetchSnapshot(input(), ctx);
  return { snap, ctx, calls };
}

const pathOf = (c: RecordedCall) => new URL(c.url).pathname;

describe('stripe fetchSnapshot', () => {
  it('normalizes every interval, interval_count, quantity and decimal amount to a month', async () => {
    const { snap, calls } = await snapshot({
      active: [
        simple(1000), // monthly → 1000
        simple(12000, { interval: 'year' }), // yearly → 1000
        simple(3000, { count: 3 }), // quarterly → 1000
        simple(500, { interval: 'week' }), // 500 × 52/12 = 2166.67 → 2167
        simple(100, { interval: 'day' }), // 100 × 365/12 = 3041.67 → 3042
        sub([item(price({ amount: 900 }), { quantity: 3 })]), // 3 seats → 2700
        sub([item(price({ amount: null, decimal: '1249.75' }))]), // unit_amount_decimal → 1250
        sub([item(price({ amount: 1000, transform: { divide_by: 5, round: 'up' } }), { quantity: 7 })]), // 2 packs → 2000
      ],
    });
    expect(snap).toEqual({
      mrr: { USD: 1000 + 1000 + 1000 + 2167 + 3042 + 2700 + 1250 + 2000 },
      activeSubscriptions: 8,
      activeTrials: 0,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      // Every fixture price is prod_FakeMain; its name is read once.
      mrrByProduct: [{ name: 'FakeMain', mrr: { USD: 1000 + 1000 + 1000 + 2167 + 3042 + 2700 + 1250 + 2000 }, subscriptions: 8 }],
    });
    expectStripeHeaders(calls);
    expect(calls.filter((c) => pathOf(c) === '/v1/products')).toHaveLength(1);
  });

  // The docs' examples (https://docs.stripe.com/subscriptions/pricing-models/tiered-pricing).
  const FONT_TIERS = [tier(5, 700), tier(10, 650), tier(null, 600)];
  const FLAT_TIERS = [tier(5, 500, 1000), tier(10, 400, 2000), tier(15, 300, 3000), tier(20, 200, 4000), tier(null, 100, 5000)];

  it('prices licensed tiered items from their tiers: volume, graduated, flat amounts, decimals, up_to inf', async () => {
    const vol = price({ id: 'price_FakeVolume', tiered: 'volume' });
    const grad = price({ id: 'price_FakeGraduated', tiered: 'graduated' });
    const volFlat = price({ id: 'price_FakeVolumeFlat', tiered: 'volume' });
    const gradFlat = price({ id: 'price_FakeGraduatedFlat', tiered: 'graduated' });
    const decimal = price({ id: 'price_FakeDecimal', tiered: 'volume', interval: 'year' });
    // Unsorted on purpose; amounts only as decimal strings.
    const decimalTiers = [
      { ...tier(null, null), unit_amount_decimal: '12.5', flat_amount_decimal: '99.5' },
      { ...tier(10, null), unit_amount_decimal: '20.25' },
    ];
    const { snap, calls, ctx } = await snapshot({
      prices: [
        tieredFull(vol, FONT_TIERS),
        tieredFull(grad, FONT_TIERS),
        tieredFull(volFlat, FLAT_TIERS),
        tieredFull(gradFlat, FLAT_TIERS),
        tieredFull(decimal, decimalTiers),
      ],
      active: [
        sub([item(vol, { quantity: 6 })]), // 6 × 6.50 = 39 USD
        sub([item(vol, { quantity: 20 })]), // 20 × 6 = 120 USD
        sub([item(grad, { quantity: 6 })]), // 5 × 7 + 1 × 6.50 = 41.50 USD
        sub([item(grad, { quantity: 25 })]), // 35 + 32.50 + 15 × 6 = 157.50 USD
        sub([item(volFlat, { quantity: 12 })]), // 12 × 3 + 30 = 66 USD
        sub([item(gradFlat, { quantity: 12 })]), // (25 + 10) + (20 + 20) + (6 + 30) = 111 USD
        sub([item(gradFlat, { quantity: 0 }), item(price({ amount: 100 }))]), // quantity 0 bills the first flat fee: 10 + 1 USD
        sub([item(volFlat, { quantity: 0 })]), // 10 USD
        sub([item(decimal, { quantity: 24 })]), // yearly, 24 × 12.5 + 99.5 = 399.5 → 400 / 12 → 33
      ],
    });
    expect(snap.mrr).toEqual({ USD: 3900 + 12000 + 4150 + 15750 + 6600 + 11100 + 1100 + 1000 + 33 });
    expect(snap.activeSubscriptions).toBe(9);

    const priceCalls = calls.filter((c) => pathOf(c).startsWith('/v1/prices/'));
    expect(priceCalls.map(pathOf).sort()).toEqual([vol, grad, volFlat, gradFlat, decimal].map((p) => `/v1/prices/${p['id']}`).sort()); // cached
    for (const c of priceCalls) expect(new URL(c.url).searchParams.getAll('expand[]')).toEqual(['tiers']);
    expect(ctx.logs.some((l) => l.event === 'stripe_tiered_prices_unpriced')).toBe(false);
  });

  it('reads tiers in the subscription’s currency from currency_options (once per price and currency)', async () => {
    const p = price({ id: 'price_FakeTieredMulti', tiered: 'volume', currency: 'usd' });
    const eurTiers = [tier(5, 600), tier(null, 500)];
    const withEur = {
      ...tieredFull(p, FONT_TIERS),
      currency_options: {
        eur: { custom_unit_amount: null, tax_behavior: 'unspecified', unit_amount: null, unit_amount_decimal: null, tiers: eurTiers },
        usd: { custom_unit_amount: null, tax_behavior: 'unspecified', unit_amount: null, unit_amount_decimal: null, tiers: FONT_TIERS },
      },
    };
    const { snap, calls } = await snapshot({
      extra: [
        route('/v1/prices/price_FakeTieredMulti', { json: withEur }, { query: { 'expand[]': ['currency_options', 'currency_options.eur.tiers'] } }),
        route('/v1/prices/price_FakeTieredMulti', { json: tieredFull(p, FONT_TIERS) }, { query: { 'expand[]': ['tiers'] } }),
      ],
      active: [
        sub([item(p, { quantity: 4 })], { currency: 'eur' }), // 4 × 6 EUR
        sub([item(p, { quantity: 6 })], { currency: 'eur' }), // 6 × 5 EUR
        sub([item(p, { quantity: 6 })], { currency: 'usd' }), // default currency: 6 × 6.50 USD
      ],
    });
    expect(snap.mrr).toEqual({ EUR: 2400 + 3000, USD: 3900 });
    const expands = calls.filter((c) => pathOf(c) === '/v1/prices/price_FakeTieredMulti').map((c) => new URL(c.url).searchParams.getAll('expand[]'));
    expect(expands).toEqual([['currency_options', 'currency_options.eur.tiers'], ['tiers']]);
  });

  it('leaves out metered items and the tiered items it can’t price, logging once without PII instead of failing', async () => {
    const noTiers = price({ id: 'price_FakeNoTiers', tiered: 'graduated' });
    const noMode = price({ id: 'price_FakeNoMode', tiered: 'volume' });
    noMode.tiers_mode = null;
    const eurOnly = price({ id: 'price_FakeTieredEur', tiered: 'volume', currency: 'usd' });
    const badExpand = { error: { message: 'This property cannot be expanded (currency_options.eur.tiers).', type: 'invalid_request_error' } };
    const { snap, ctx, calls } = await snapshot({
      prices: [{ ...tieredFull(noTiers, FONT_TIERS), tiers: null }, tieredFull(noMode, FONT_TIERS)],
      extra: [route('/v1/prices/price_FakeTieredEur', { status: 400, json: badExpand })],
      active: [
        sub([item(price({ amount: 2000 })), item(price({ amount: 5, usage: 'metered' }), { quantity: null })]), // 2000
        sub([item(noTiers, { quantity: 3 }), item(price({ amount: 500 }))]), // 500
        sub([item(noMode, { quantity: 40 })]), // 0: not active
        sub([item(eurOnly, { quantity: 2 })], { currency: 'eur' }), // 0
        sub([item(eurOnly, { quantity: 9 })], { currency: 'eur' }), // 0, and no second request
      ],
    });
    expect(snap.mrr).toEqual({ USD: 2500 });
    expect(snap.activeSubscriptions).toBe(2);
    expect(calls.filter((c) => pathOf(c) === '/v1/prices/price_FakeTieredEur')).toHaveLength(1);
    const unpriced = ctx.logs.filter((l) => l.event === 'stripe_tiered_prices_unpriced');
    expect(unpriced).toEqual([{ event: 'stripe_tiered_prices_unpriced', data: { items: 4 } }]);
    const ownLogs = ctx.logs.filter((l) => l.event.startsWith('stripe_'));
    expect(JSON.stringify(ownLogs)).not.toMatch(/cus_|sub_|si_|price_|prod_/);
    expect(JSON.stringify(ctx.logs)).not.toMatch(/cus_|sub_|si_/);
  });

  it('counts only subscriptions with positive MRR as active, like Stripe', async () => {
    const { snap, ctx } = await snapshot({
      coupons: [coupon('FREE100', { percent_off: 100 })],
      active: [
        simple(1000),
        simple(0), // free plan
        simple(2000, { discounts: [discount('FREE100')] }), // 100% off forever
        sub([item(price({ amount: 5, usage: 'metered' }), { quantity: null })]), // metered only
        sub([item(price({ amount: 100 }), { trialEnd: NOW_S + DAY_S })]), // only a running (paid) trial offer
      ],
      pastDue: [simple(0, { status: 'past_due' }), simple(500, { status: 'past_due' })],
    });
    expect(snap.mrr).toEqual({ USD: 1500 });
    expect(snap.activeSubscriptions).toBe(2);
    expect(snap.activeTrials).toBe(1);
    expect(ctx.logs.find((l) => l.event === 'stripe_snapshot')?.data).toEqual({ subscriptions: 2, zeroMrr: 5, trials: 1, currencies: ['USD'], products: 1 });
  });

  it('counts trial offers per item on active, past_due and trialing subscriptions, legacy trials once', async () => {
    const running = NOW_S + 7 * DAY_S;
    const { snap } = await snapshot({
      active: [
        sub([
          item(price({ amount: 3000 }), { trialEnd: running }),
          item(price({ amount: 1000 }), { trialEnd: running }),
          item(price({ amount: 2000 }), { trialEnd: NOW_S - DAY_S }), // trial over: paid
        ]),
      ],
      pastDue: [sub([item(price({ amount: 500 })), item(price({ amount: 900 }), { trialEnd: running })], { status: 'past_due' })],
      trialing: [
        simple(1000, { status: 'trialing' }), // legacy trial_end
        sub([item(price({ amount: 0 }), { trialEnd: running }), item(price({ amount: 0 }), { trialEnd: running })], { status: 'trialing' }),
      ],
    });
    expect(snap.activeTrials).toBe(2 + 1 + 1 + 2);
    expect(snap.mrr).toEqual({ USD: 2500 });
    expect(snap.activeSubscriptions).toBe(2);
  });

  it('backs inclusive manual tax rates out of MRR after discounts, and leaves exclusive rates and Stripe Tax alone', async () => {
    const vat20 = taxRate(20, true);
    const salesTax = taxRate(8.25, false);
    const { snap, ctx, calls } = await snapshot({
      coupons: [coupon('OFF120', { amount_off: 120, currency: 'usd' })],
      active: [
        // price tax_behavior is "unspecified" (docs object): the rate's `inclusive` decides → 1200 / 1.2
        simple(1200, { defaultTaxRates: [vat20] }),
        // the item's own rates replace the subscription's: 1100 / 1.1 + 2400 / 1.2
        sub([item(price({ amount: 1100 }), { taxRates: [taxRate(10, true)] }), item(price({ amount: 2400 }))], { defaultTaxRates: [vat20] }),
        // exclusive tax is added on top of the price → 1000
        simple(1000, { defaultTaxRates: [salesTax] }),
        // several inclusive rates add up; the exclusive one doesn't count → 1150 / 1.15
        sub([item(price({ amount: 1150 }), { taxRates: [taxRate(5, true), taxRate(10, true), salesTax] })]),
        // discount first, then tax: (1200 − 120) / 1.2 = 900, not 1200 / 1.2 − 120 = 880
        simple(1200, { defaultTaxRates: [vat20], discounts: [discount('OFF120')] }),
        // Stripe Tax: the rate isn't on the subscription → left in, counted
        sub([item(price({ amount: 1200, taxBehavior: 'inclusive' }))], { automaticTax: true }),
        sub([item(price({ amount: 1200, taxBehavior: 'exclusive' }))], { automaticTax: true }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 1000 + (1000 + 2000) + 1000 + 1000 + 900 + 1200 + 1200 });
    expect(ctx.logs.filter((l) => l.event === 'stripe_inclusive_tax_unknown')).toEqual([
      { event: 'stripe_inclusive_tax_unknown', data: { items: 1 } },
    ]);
    // Tax rates are embedded: nothing but the product names on top.
    expect(calls.map(pathOf).filter((p) => !p.startsWith('/v1/subscriptions') && !p.startsWith('/v1/coupons/'))).toEqual(['/v1/products']);
  });

  it('applies percent_off and amount_off discounts per coupon duration, order, scope and end date', async () => {
    const coupons = [
      coupon('PCT25', { percent_off: 25 }),
      coupon('OFF500Y', { amount_off: 500, currency: 'usd', duration: 'repeating', duration_in_months: 12 }),
      coupon('ONCE100', { percent_off: 100, duration: 'once' }),
      coupon('ITEM50', { percent_off: 50 }),
      coupon('OFF300', { amount_off: 300, currency: 'usd' }),
      coupon('PRODONLY', { percent_off: 10, applies_to: { products: ['prod_FakeSpecial'] } }),
      coupon('PCT20', { percent_off: 20 }),
      coupon('OFF500', { amount_off: 500, currency: 'usd' }),
    ];
    const { snap, calls, ctx } = await snapshot({
      coupons,
      active: [
        // 25% forever: 4000 → 3000
        simple(4000, { discounts: [discount('PCT25')] }),
        // 5 USD off every (yearly) invoice, still running: 1000 − 500/12 (42) → 958
        simple(12000, { interval: 'year', discounts: [discount('OFF500Y', NOW_S + 30 * DAY_S)] }),
        // expired repeating discount: ignored without even looking the coupon up → 1500
        simple(1500, { discounts: [discount('EXPIRED50', NOW_S - 1)] }),
        // one-time coupon is not recurring revenue → 700
        simple(700, { discounts: [discount('ONCE100')] }),
        // item discount first (2000 → 1000), then 3 USD off the subscription: 2000 − 300 → 1700
        sub([item(price({ amount: 2000 }), { discounts: [discount('ITEM50')] }), item(price({ amount: 1000 }))], {
          discounts: [discount('OFF300')],
        }),
        // coupon restricted to one product: 1000 × 0.9 + 1000 → 1900
        sub([item(price({ amount: 1000, product: 'prod_FakeSpecial' })), item(price({ amount: 1000, product: 'prod_FakeOther' }))], {
          discounts: [discount('PRODONLY')],
        }),
        // stacked in order: 5000 × 0.8 − 500 → 3500 (the reverse order would give 3600)
        simple(5000, { discounts: [discount('PCT20'), discount('OFF500')] }),
        // amount_off larger than the price never goes negative → 0
        simple(300, { discounts: [discount('OFF500')] }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 3000 + 958 + 1500 + 700 + 1700 + 1900 + 3500 });
    expect(snap.activeSubscriptions).toBe(7); // the one discounted to 0 has no MRR, so it isn't active

    const couponCalls = calls.filter((c) => pathOf(c).startsWith('/v1/coupons/'));
    expect(couponCalls.map(pathOf).sort()).toEqual(coupons.map((c) => `/v1/coupons/${c['id']}`).sort()); // cached, no EXPIRED50
    for (const c of couponCalls) expect(new URL(c.url).searchParams.getAll('expand[]')).toEqual(['applies_to', 'currency_options']);
    expect(ctx.logs.some((l) => l.event === 'stripe_discounts_unresolved')).toBe(false);
  });

  it('keeps currencies apart (JPY is zero-decimal), counts past_due as active and trialing only as trials', async () => {
    const { snap } = await snapshot({
      active: [simple(1000), simple(900, { currency: 'eur' }), simple(1500, { currency: 'jpy' }), simple(250, { currency: 'eur' })],
      pastDue: [simple(800, { currency: 'gbp', status: 'past_due' })],
      trialing: [simple(99900, { status: 'trialing' }), simple(5000, { status: 'trialing', currency: 'eur' })],
    });
    expect(snap.mrr).toEqual({ USD: 1000, EUR: 1150, JPY: 1500, GBP: 800 });
    expect(snap.activeSubscriptions).toBe(5);
    expect(snap.activeTrials).toBe(2);
  });

  it('reads a HUF 4,990.00 price as 499000 fillér, the same unit hoomuch stores and shows as HUF 4,990', async () => {
    const { snap } = await snapshot({ active: [simple(499000, { currency: 'huf' })] });
    expect(snap.mrr).toEqual({ HUF: 499000 });
    expect(formatMoney(snap.mrr['HUF']!, 'HUF')).toBe('HUF\u00a04,990'); // not HUF 499,000
  });

  it('passes IDR, COP and PKR through in hundredths and converts MGA, ISK and UGX to ISO minor units', async () => {
    const coupons = [coupon('OFF1000ISK', { amount_off: 100000, currency: 'isk' })]; // ISK 1,000 off
    const { snap } = await snapshot({
      coupons,
      active: [
        simple(15000000, { currency: 'idr' }), // IDR 150,000.00
        simple(4990000, { currency: 'cop' }), // COP 49,900.00
        simple(99900, { currency: 'pkr' }), // PKR 999.00
        simple(500000, { currency: 'isk' }), // Stripe's ISK 5,000 (two-decimal representation) → 5000
        simple(1200000, { currency: 'isk', interval: 'year', discounts: [discount('OFF1000ISK')] }), // (12,000 − 1,000)/12 → 917
        simple(5000000, { currency: 'ugx' }), // UGX 50,000 → 50000
        simple(20000, { currency: 'mga' }), // Ar 20,000 (zero-decimal at Stripe) → 2000000
        simple(10000, { currency: 'mga', interval: 'year' }), // Ar 10,000/yr → 1000000/12 = 83333 (converted before rounding)
      ],
    });
    expect(snap.mrr).toEqual({
      IDR: 15000000,
      COP: 4990000,
      PKR: 99900,
      ISK: 5000 + 917,
      UGX: 50000,
      MGA: 2000000 + 83333,
    });
  });

  it('pages through subscriptions with limit=100, starting_after and the discount expansions', async () => {
    const page1 = [simple(1000), simple(2000)];
    const page2 = [simple(3000)];
    const expand = ['data.discounts', 'data.items.data.discounts'];
    const { snap, calls } = await snapshot({
      extra: [
        route('/v1/subscriptions', { json: list(page1, true) }, { query: { status: 'active', limit: '100', 'expand[]': expand }, absent: ['starting_after'] }),
        route('/v1/subscriptions', { json: list(page2) }, { query: { status: 'active', limit: '100', 'expand[]': expand, starting_after: page1[1]!['id'] } }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 6000 });
    expect(snap.activeSubscriptions).toBe(3);
    const statuses = calls.filter((c) => pathOf(c) === '/v1/subscriptions').map((c) => new URL(c.url).searchParams.get('status'));
    expect(statuses).toEqual(['active', 'active', 'past_due', 'trialing']);
    const trialingCall = new URL(calls[3]!.url);
    expect(trialingCall.searchParams.getAll('expand[]')).toEqual([]);
  });

  it('excludes only the items that are in a trial offer', async () => {
    const { snap } = await snapshot({
      active: [
        sub([
          item(price({ amount: 5000 }), { trialEnd: NOW_S + 7 * DAY_S }), // still in trial
          item(price({ amount: 2000 }), { trialEnd: NOW_S - DAY_S }), // trial over → paid
          item(price({ amount: 1000 })),
        ]),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 3000 });
    expect(snap.activeTrials).toBe(1);
    expect(snap.activeSubscriptions).toBe(1);
  });

  it('reads currency_options (once per price) when a multi-currency price bills in another currency', async () => {
    const multi = price({ id: 'price_FakeMulti', amount: 1000, currency: 'usd' });
    const full = {
      ...clone(priceFx),
      id: 'price_FakeMulti',
      currency_options: {
        eur: { custom_unit_amount: null, tax_behavior: 'unspecified', unit_amount: 900, unit_amount_decimal: '900' },
        usd: { custom_unit_amount: null, tax_behavior: 'unspecified', unit_amount: 1000, unit_amount_decimal: '1000' },
      },
    };
    const off = coupon('OFF5MULTI', { amount_off: 500, currency: 'usd', currency_options: { eur: { amount_off: 400 } } });
    const { snap, calls } = await snapshot({
      prices: [full],
      coupons: [off],
      active: [
        sub([item(multi)], { currency: 'eur', discounts: [discount('OFF5MULTI')] }), // 900 − 400
        sub([item(multi)], { currency: 'eur' }), // 900
        sub([item(multi)], { currency: 'usd' }), // default currency: no lookup needed
      ],
    });
    expect(snap.mrr).toEqual({ EUR: 1400, USD: 1000 });
    const priceCalls = calls.filter((c) => pathOf(c) === '/v1/prices/price_FakeMulti');
    expect(priceCalls).toHaveLength(1);
    expect(new URL(priceCalls[0]!.url).searchParams.getAll('expand[]')).toEqual(['currency_options']);
  });

  it('falls back to undiscounted MRR (and logs it) when the key lacks Coupons: Read', async () => {
    const forbidden = clone(errorPermissionFx);
    forbidden.error.message = forbidden.error.message.replace('rak_subscription_read', 'rak_coupon_read');
    const { snap, calls, ctx } = await snapshot({
      extra: [route(/^\/v1\/coupons\//, { status: 403, json: forbidden })],
      active: [simple(4000, { discounts: [discount('PCT25')] }), simple(5000, { discounts: [discount('PCT20')] })],
    });
    expect(snap.mrr).toEqual({ USD: 9000 });
    expect(calls.filter((c) => pathOf(c).startsWith('/v1/coupons/'))).toHaveLength(1);
    const events = ctx.logs.map((l) => l.event);
    expect(events).toContain('stripe_coupon_permission_missing');
    expect(ctx.logs.find((l) => l.event === 'stripe_discounts_unresolved')?.data).toEqual({ discounts: 2 });
    expectNoSecretsInLogs(ctx, [RK_TEST, RK_TEST.slice(8)]);
  });

  it('treats a deleted coupon (404) as unresolved instead of failing', async () => {
    const { snap, ctx } = await snapshot({
      extra: [route('/v1/coupons/GONE', { status: 404, json: { error: { message: 'No such coupon', type: 'invalid_request_error' } } })],
      active: [simple(4000, { discounts: [discount('GONE')] })],
    });
    expect(snap.mrr).toEqual({ USD: 4000 });
    expect(ctx.logs.find((l) => l.event === 'stripe_discounts_unresolved')?.data).toEqual({ discounts: 1 });
  });

  it('fetches the rest of a truncated items list', async () => {
    const first = item(price({ amount: 1000 }));
    const s = sub([first], { moreItems: true });
    const rest = item(price({ amount: 2000 }), { discounts: [discount('PCT25')] });
    const trial = item(price({ amount: 9000 }), { trialEnd: NOW_S + DAY_S });
    const { snap } = await snapshot({
      coupons: [coupon('PCT25', { percent_off: 25 })],
      active: [s],
      extra: [
        route('/v1/subscription_items', { json: list([rest, trial], false, '/v1/subscription_items') }, {
          query: { subscription: s['id'], starting_after: first['id'], limit: '100', 'expand[]': 'data.discounts' },
        }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 1000 + 1500 });
    expect(snap.activeTrials).toBe(1);
  });

  it('lets BudgetExhaustedError propagate instead of returning a partial MRR', async () => {
    const { fetch, calls } = fakeFetch([
      route('/v1/subscriptions', { json: list([simple(1000)], true) }, { query: { status: 'active' }, absent: ['starting_after'] }),
      ...snapshotRoutes({}),
    ]);
    const err = await catchErr(stripeAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 1 })));
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toHaveLength(1);
  });

  it('refuses a malformed key without a network call', async () => {
    const { fetch, calls } = fakeFetch(snapshotRoutes({}));
    const err = await catchErr(stripeAdapter.fetchSnapshot(input('pk_live_51Fake'), makeCtx(fetch)));
    expect(err.kind).toBe('invalid_input');
    expect(err.field).toBe('apiKey');
    expect(calls).toHaveLength(0);
  });

  it('keeps a subscription set to cancel at period end in MRR until it actually ends (SPEC §6)', async () => {
    const leaving = simple(1500);
    leaving['cancel_at_period_end'] = true;
    leaving['cancel_at'] = NOW_S + 10 * DAY_S;
    const { snap } = await snapshot({ active: [leaving, simple(500)] });
    expect(snap.mrr).toEqual({ USD: 2000 });
    expect(snap.activeSubscriptions).toBe(2);
  });

  it('leaves out discounts it can’t apply (bare ID, amount_off in another currency without currency_options) and logs them', async () => {
    const { snap, ctx } = await snapshot({
      coupons: [coupon('OFF5USD', { amount_off: 500, currency: 'usd' })],
      active: [
        simple(4000, { currency: 'eur', discounts: [discount('OFF5USD')] }), // a USD amount off an EUR invoice: unknown → 4000
        simple(3000, { discounts: ['di_FakeNotExpanded' as unknown as Json] }), // not expanded → 3000
      ],
    });
    expect(snap.mrr).toEqual({ EUR: 4000, USD: 3000 });
    expect(ctx.logs.find((l) => l.event === 'stripe_discounts_unresolved')?.data).toEqual({ discounts: 2 });
  });

  it.each([
    [500, 'upstream'],
    [429, 'rate_limit'],
  ] as const)('fails the snapshot when a coupon lookup answers %i instead of silently dropping the discount', async (status, kind) => {
    const { fetch } = fakeFetch(
      snapshotRoutes({
        extra: [route('/v1/coupons/PCT25', { status, json: { error: { message: 'nope', type: 'api_error' } } })],
        active: [simple(4000, { discounts: [discount('PCT25')] })],
      }),
    );
    const err = await catchErr(stripeAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 30 })));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('surfaces a revoked key (401) during a snapshot as an auth error', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/subscriptions', { status: 401, json: errorInvalidKeyFx })]);
    const ctx = makeCtx(fetch);
    const err = await catchErr(stripeAdapter.fetchSnapshot(input(), ctx));
    expect(err.kind).toBe('auth');
    expect(calls).toHaveLength(1); // a 401 is not retried
    expectNoSecretsInLogs(ctx, [RK_TEST]);
  });

  it.each([
    ['a list without data', { json: { object: 'list', has_more: false, url: '/v1/subscriptions' } }],
    ['a non-JSON body', { body: '<html>Bad Gateway</html>' }],
  ])('refuses %s as unreadable instead of reporting an MRR of 0', async (_label, responder) => {
    const { fetch } = fakeFetch([route('/v1/subscriptions', responder)]);
    const err = await catchErr(stripeAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/couldn’t read/);
  });

  it('stops paging when Stripe says has_more but sends an empty page', async () => {
    const { snap, calls } = await snapshot({
      extra: [route('/v1/subscriptions', { json: list([], true) }, { query: { status: 'active' } })],
    });
    expect(snap.mrr).toEqual({});
    expect(calls.map((c) => new URL(c.url).searchParams.get('status'))).toEqual(['active', 'past_due', 'trialing']);
  });
});

// ---------- revenue ----------

const SINCE = NOW - 90 * DAY_S * 1000;
const SINCE_S = Math.floor(SINCE / 1000);

describe('stripe fetchSnapshot: MRR by product', () => {
  const byName = (snap: MetricsSnapshot) => [...(snap.mrrByProduct ?? [])].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  it('splits each subscription’s MRR over its products after discounts and tax, adding up to MRR', async () => {
    const { snap, calls } = await snapshot({
      products: { prod_Pro: 'Pro', prod_Seat: 'Extra seats', prod_Team: 'Team', prod_Addon: 'Add-on' },
      coupons: [coupon('PCT10', { percent_off: 10 }), coupon('ADDONFREE', { percent_off: 100, applies_to: { products: ['prod_Addon'] } })],
      active: [
        // 3000 + 3 × 1000, then 10% off the subscription → 2700 each.
        sub([item(price({ amount: 3000, product: 'prod_Pro' })), item(price({ amount: 1000, product: 'prod_Seat' }), { quantity: 3 })], {
          discounts: [discount('PCT10')],
        }),
        sub([item(price({ amount: 12000, interval: 'year', product: 'prod_Pro' }))]), // → 1000
        sub([item(price({ amount: 2500, product: 'prod_Team' }), { taxRates: [taxRate(25, true)] })]), // 2500 / 1.25 → 2000
        // The add-on is free forever: it isn't in the split and doesn't count the subscription under it.
        sub([item(price({ amount: 500, product: 'prod_Addon' })), item(price({ amount: 1000, product: 'prod_Pro' }))], {
          discounts: [discount('ADDONFREE')],
        }),
        sub([item(price({ amount: 900, currency: 'eur', product: 'prod_Pro' }))], { currency: 'eur' }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 5400 + 1000 + 2000 + 1000, EUR: 900 });
    expect(byName(snap)).toEqual([
      { name: 'Extra seats', mrr: { USD: 2700 }, subscriptions: 1 },
      { name: 'Pro', mrr: { USD: 2700 + 1000 + 1000, EUR: 900 }, subscriptions: 4 },
      { name: 'Team', mrr: { USD: 2000 }, subscriptions: 1 },
    ]);
    const lookups = calls.filter((c) => pathOf(c) === '/v1/products').map((c) => new URL(c.url).searchParams);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.getAll('ids[]')).toEqual(['prod_Pro', 'prod_Seat', 'prod_Team']);
    expect(lookups[0]!.get('limit')).toBe('100');
  });

  it('rounds each subscription’s split to whole minor units that add up to its MRR', async () => {
    // 1000 with 7% inclusive tax is 934.58…: three of them make 2803.74…, so MRR is 2804.
    const taxed = (product: string) => item(price({ amount: 1000, product }), { taxRates: [taxRate(7, true)] });
    const { snap } = await snapshot({ active: [sub([taxed('prod_A'), taxed('prod_B'), taxed('prod_C')])] });
    expect(snap.mrr).toEqual({ USD: 2804 });
    expect(byName(snap).map((p) => p.mrr['USD'])).toEqual([935, 935, 934]);
  });

  it('splitRounded hands out the rounding by largest remainder', () => {
    const split = splitRounded(new Map([['a', 1.6], ['b', 1.6], ['c', 0.8]]), 4);
    expect(Object.fromEntries(split)).toEqual({ a: 2, b: 1, c: 1 });
    expect(Object.fromEntries(splitRounded(new Map([['a', 2.5]]), 3))).toEqual({ a: 3 });
    expect(Object.fromEntries(splitRounded(new Map(), 0))).toEqual({});
  });

  it('reads names 100 products per request, and leaves a product the list doesn’t return without one', async () => {
    const subs = Array.from({ length: 101 }, (_, i) => sub([item(price({ amount: 100 + i, product: `prod_P${i}` }))]));
    const allBut = (url: URL): FakeResponse => {
      const ids = url.searchParams.getAll('ids[]').filter((id) => id !== 'prod_P7');
      return { json: list(ids.map((id) => ({ ...clone(productFx), id, name: `Plan ${id.slice(6)}` })), false, '/v1/products') };
    };
    const { snap, calls } = await snapshot({ active: subs, extra: [route('/v1/products', allBut)] });
    const lookups = calls.filter((c) => pathOf(c) === '/v1/products').map((c) => new URL(c.url).searchParams.getAll('ids[]'));
    expect(lookups.map((ids) => ids.length)).toEqual([100, 1]);
    expect(snap.mrrByProduct).toHaveLength(101);
    expect(snap.mrrByProduct?.find((p) => p.mrr['USD'] === 107)?.name).toBeNull();
    expect(snap.mrrByProduct?.find((p) => p.mrr['USD'] === 100)?.name).toBe('Plan 0');
  });

  it('leaves the split null, and MRR as it is, when the key lacks Products: Read', async () => {
    const forbidden = clone(errorPermissionFx);
    forbidden.error.message = forbidden.error.message.replace('rak_subscription_read', 'rak_product_read');
    const { snap, calls, ctx } = await snapshot({
      extra: [route('/v1/products', { status: 403, json: forbidden })],
      active: [simple(4000), simple(1000)],
    });
    expect(snap.mrr).toEqual({ USD: 5000 });
    expect(snap.activeSubscriptions).toBe(2);
    expect(snap.mrrByProduct).toBeNull();
    expect(calls.filter((c) => pathOf(c) === '/v1/products')).toHaveLength(1);
    expect(ctx.logs.find((l) => l.event === 'stripe_product_permission_missing')?.data).toEqual({
      reason: 'permission',
      effect: 'mrr_not_split_by_product',
    });
    expectNoSecretsInLogs(ctx, [RK_TEST, RK_TEST.slice(8)]);
  });

  it('skips the names instead of failing the snapshot when the budget is spent or Stripe fails', async () => {
    // 3 requests read the subscriptions (active, past_due, trialing); none is left for names.
    const spent = await snapshot({ active: [simple(4000)], budget: 3 });
    expect(spent.snap.mrr).toEqual({ USD: 4000 });
    expect(spent.snap.mrrByProduct).toBeNull();
    expect(spent.calls.filter((c) => pathOf(c) === '/v1/products')).toHaveLength(0);
    expect(spent.ctx.logs.find((l) => l.event === 'stripe_product_names_skipped')?.data).toEqual({ reason: 'budget', products: 1 });

    const down = await snapshot({ active: [simple(4000)], extra: [route('/v1/products', { status: 503, json: { error: { message: 'down' } } })] });
    expect(down.snap.mrr).toEqual({ USD: 4000 });
    expect(down.snap.mrrByProduct).toBeNull();
    expect(down.ctx.logs.find((l) => l.event === 'stripe_product_names_skipped')?.data).toMatchObject({ reason: 'upstream' });
  });

  it('has nothing to split, and asks for no names, without MRR', async () => {
    const { snap, calls } = await snapshot({ active: [simple(0)], trialing: [simple(1000, { status: 'trialing' })] });
    expect(snap.mrrByProduct).toEqual([]);
    expect(calls.filter((c) => pathOf(c) === '/v1/products')).toHaveLength(0);
  });
});

describe('stripe fetchSnapshot: warnings', () => {
  it('has no warnings for a healthy snapshot with discounts, tax rates and product names', async () => {
    const { snap } = await snapshot({
      coupons: [coupon('PCT25', { percent_off: 25 })],
      active: [simple(4000, { discounts: [discount('PCT25')] }), simple(1200, { defaultTaxRates: [taxRate(20, true)] })],
      trialing: [simple(1000, { status: 'trialing' })],
    });
    expect(snap.mrr).toEqual({ USD: 3000 + 1000 });
    expect(snap.warnings).toBeUndefined();
  });

  it('says MRR is before discounts when the key lacks Coupons: Read, once and without a count', async () => {
    const forbidden = clone(errorPermissionFx);
    forbidden.error.message = forbidden.error.message.replace('rak_subscription_read', 'rak_coupon_read');
    const { snap, ctx } = await snapshot({
      extra: [route(/^\/v1\/coupons\//, { status: 403, json: forbidden })],
      active: [simple(4000, { discounts: [discount('PCT25')] }), simple(5000, { discounts: [discount('PCT20')] })],
    });
    expect(snap.warnings).toEqual([STRIPE_COUPONS_WARNING]);
    expect(STRIPE_COUPONS_WARNING).toBe(COUPONS_PERMISSION_WARNING); // same words as verify's
    expectNoSecretsInLogs(ctx, [RK_TEST, RK_TEST.slice(8)]);
  });

  it('counts the discounts it couldn’t apply (deleted coupon, bare ID, amount_off in another currency)', async () => {
    const { snap } = await snapshot({
      coupons: [coupon('OFF5USD', { amount_off: 500, currency: 'usd' })],
      extra: [route('/v1/coupons/GONE', { status: 404, json: { error: { message: 'No such coupon', type: 'invalid_request_error' } } })],
      active: [
        simple(4000, { discounts: [discount('GONE')] }),
        simple(3000, { discounts: ['di_FakeNotExpanded' as unknown as Json] }),
        simple(2000, { currency: 'eur', discounts: [discount('OFF5USD')] }),
      ],
    });
    expect(snap.warnings).toEqual([stripeDiscountsUnresolvedWarning(3)]);
    expect(snap.warnings![0]).toBe('3 discounts couldn’t be read or applied, so MRR is shown before them.');
  });

  it('counts the items it couldn’t price (tiers it can’t read, an unknown interval)', async () => {
    const noTiers = price({ id: 'price_FakeNoTiersW', tiered: 'graduated' });
    const { snap } = await snapshot({
      prices: [{ ...tieredFull(noTiers, [tier(null, 100)]), tiers: null }],
      active: [sub([item(noTiers, { quantity: 3 }), item(price({ amount: 500 }))]), simple(700, { interval: 'fortnight' })],
    });
    expect(snap.mrr).toEqual({ USD: 500 });
    expect(snap.warnings).toEqual([stripeUnpricedItemsWarning(2)]);
    expect(snap.warnings![0]).toBe('2 subscription items have prices hoomuch can’t read, so they count as 0 in MRR.');
  });

  it('says MRR includes tax for tax-inclusive prices under Stripe Tax', async () => {
    const { snap } = await snapshot({
      active: [
        sub([item(price({ amount: 1200, taxBehavior: 'inclusive' }))], { automaticTax: true }),
        sub([item(price({ amount: 1200, taxBehavior: 'exclusive' }))], { automaticTax: true }),
      ],
    });
    expect(snap.warnings).toEqual([stripeInclusiveTaxWarning(1)]);
    expect(snap.warnings![0]).toBe(
      'MRR includes tax on 1 subscription item: its price is tax-inclusive under Stripe Tax, which doesn’t say the rate.',
    );
  });

  it('names the missing Products: Read with STRIPE_PRODUCTS_WARNING', async () => {
    const forbidden = clone(errorPermissionFx);
    forbidden.error.message = forbidden.error.message.replace('rak_subscription_read', 'rak_product_read');
    const { snap, ctx } = await snapshot({ extra: [route('/v1/products', { status: 403, json: forbidden })], active: [simple(4000)] });
    expect(snap.mrrByProduct).toBeNull();
    expect(snap.warnings).toEqual([STRIPE_PRODUCTS_WARNING]);
    expect(STRIPE_PRODUCTS_WARNING).toBe(PRODUCTS_PERMISSION_WARNING);
    expectNoSecretsInLogs(ctx, [RK_TEST, RK_TEST.slice(8)]);
  });

  it('says the split was skipped this time when the budget is spent or Stripe fails', async () => {
    const spent = await snapshot({ active: [simple(4000)], budget: 3 });
    expect(spent.snap.warnings).toEqual([STRIPE_PRODUCT_SPLIT_SKIPPED_WARNING]);
    const down = await snapshot({ active: [simple(4000)], extra: [route('/v1/products', { status: 503, json: { error: { message: 'down' } } })] });
    expect(down.snap.warnings).toEqual([STRIPE_PRODUCT_SPLIT_SKIPPED_WARNING]);
  });

  it('lists several problems in one snapshot, each once', async () => {
    const forbidden = clone(errorPermissionFx);
    forbidden.error.message = forbidden.error.message.replace('rak_subscription_read', 'rak_coupon_read');
    const { snap } = await snapshot({
      extra: [
        route(/^\/v1\/coupons\//, { status: 403, json: forbidden }),
        route('/v1/products', { status: 403, json: { ...forbidden, error: { ...forbidden.error, message: 'rak_product_read' } } }),
      ],
      active: [
        simple(4000, { discounts: [discount('PCT25')] }),
        simple(5000, { discounts: [discount('PCT20')] }),
        simple(700, { interval: 'fortnight' }),
      ],
    });
    expect(snap.warnings).toEqual([STRIPE_COUPONS_WARNING, stripeUnpricedItemsWarning(1), STRIPE_PRODUCTS_WARNING]);
  });

  it('keeps every sentence short, calm and free of IDs', () => {
    const all = [
      STRIPE_COUPONS_WARNING,
      STRIPE_PRODUCTS_WARNING,
      STRIPE_PRODUCT_SPLIT_SKIPPED_WARNING,
      ...[1, 2, 100_000].flatMap((n) => [stripeUnpricedItemsWarning(n), stripeDiscountsUnresolvedWarning(n), stripeInclusiveTaxWarning(n)]),
    ];
    for (const w of all) {
      expect(w.length).toBeLessThanOrEqual(200);
      expect(w).toMatch(/\.$/);
      expect(w).not.toMatch(/https?:|rk_|sk_|prod_|price_|sub_/);
    }
    expect(stripeUnpricedItemsWarning(1)).toBe('1 subscription item has a price hoomuch can’t read, so it counts as 0 in MRR.');
    expect(stripeDiscountsUnresolvedWarning(1)).toBe('1 discount couldn’t be read or applied, so MRR is shown before it.');
  });
});

describe('stripe fetchRevenue', () => {
  it('maps balance transaction types to charges/refunds in the settlement currency and drops the rest', async () => {
    const t = NOW_S - 3600;
    const data = [
      bt('txn_FakeCharge', 'charge', 2000, { fee: 88, created: t, description: 'Payment from jenny.rosen@example.com' }),
      bt('txn_FakePayment', 'payment', 1500, { fee: 50, currency: 'eur', created: t - 1 }),
      bt('txn_FakeRefund', 'refund', -500, { created: t - 2, description: 'REFUND FOR CHARGE (jenny.rosen@example.com)' }),
      bt('txn_FakePaymentRefund', 'payment_refund', -300, { currency: 'eur', created: t - 3 }),
      bt('txn_FakePaymentFailure', 'payment_failure_refund', -1500, { currency: 'eur', created: t - 4, reporting_category: 'charge_failure' }),
      bt('txn_FakePaymentReversal', 'payment_reversal', -700, { created: t - 5 }),
      bt('txn_FakeRefundFailure', 'refund_failure', 500, { created: t - 6 }),
      bt('txn_FakeDispute', 'adjustment', -2000, { fee: 1500, created: t - 7, reporting_category: 'dispute' }),
      bt('txn_FakeDisputeWon', 'adjustment', 2000, { created: t - 8, reporting_category: 'dispute_reversal' }),
      bt('txn_FakeOtherAdj', 'adjustment', 100, { created: t - 9, reporting_category: 'other_adjustment' }),
      bt('txn_FakePayout', 'payout', -10000, { created: t - 10 }),
      { ...clone(balanceTransactionFx), created: t - 11 }, // docs example: a Connect transfer
      bt('txn_FakeStripeFee', 'stripe_fee', -200, { created: t - 12, reporting_category: 'fee' }),
      bt('txn_FakeAppFee', 'application_fee', 300, { created: t - 13, reporting_category: 'platform_earning' }),
      bt('txn_FakeYen', 'charge', 1500, { fee: 54, currency: 'jpy', created: t - 14 }),
      bt('txn_FakeZero', 'charge', 0, { created: t - 15 }),
    ];
    const { fetch, calls } = fakeFetch([
      route('/v1/balance_transactions', { json: list(data, false, '/v1/balance_transactions') }, {
        query: { 'created[gte]': String(SINCE_S), 'created[lte]': String(NOW_S), limit: '100' },
        absent: ['starting_after'],
      }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 20 });
    const page = await stripeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);

    const ev = (externalId: string, offset: number, type: 'charge' | 'refund', amount: number, currency: string, fee: number) => ({
      externalId,
      occurredAt: (t - offset) * 1000,
      type,
      amount,
      currency,
      fee,
      description: null,
    });
    expect(page).toEqual({
      events: [
        ev('txn_FakeCharge', 0, 'charge', 2000, 'USD', 88),
        ev('txn_FakePayment', 1, 'charge', 1500, 'EUR', 50),
        ev('txn_FakeRefund', 2, 'refund', -500, 'USD', 0),
        ev('txn_FakePaymentRefund', 3, 'refund', -300, 'EUR', 0),
        ev('txn_FakePaymentFailure', 4, 'refund', -1500, 'EUR', 0),
        ev('txn_FakePaymentReversal', 5, 'refund', -700, 'USD', 0),
        ev('txn_FakeRefundFailure', 6, 'charge', 500, 'USD', 0),
        ev('txn_FakeDispute', 7, 'refund', -2000, 'USD', 1500),
        ev('txn_FakeDisputeWon', 8, 'charge', 2000, 'USD', 0),
        ev('txn_FakeYen', 14, 'charge', 1500, 'JPY', 54),
      ],
      daily: [],
      nextCursor: null,
      done: true,
    });
    expectStripeHeaders(calls);
    expect(JSON.stringify(page)).not.toContain('example.com');
    expectNoSecretsInLogs(ctx, [RK_TEST, 'jenny.rosen@example.com']);
    expect(ctx.logs.find((l) => l.event === 'stripe_revenue_done')?.data).toEqual({
      pages: 1,
      events: 10,
      ignored: { adjustment: 1, payout: 1, transfer: 1, stripe_fee: 1, application_fee: 1, charge: 1 },
    });
  });

  it('converts balance transaction amounts and fees to ISO minor units (HUF unchanged, ISK/UGX ÷100, MGA ×100)', async () => {
    const t = NOW_S - 3600;
    const data = [
      bt('txn_FakeHuf', 'charge', 499000, { fee: 15000, currency: 'huf', created: t }),
      bt('txn_FakeIsk', 'charge', 500000, { fee: 2500, currency: 'isk', created: t - 1 }),
      bt('txn_FakeUgx', 'refund', -500000, { currency: 'ugx', created: t - 2 }),
      bt('txn_FakeMga', 'charge', 20000, { fee: 700, currency: 'mga', created: t - 3 }),
    ];
    const { fetch } = fakeFetch([route('/v1/balance_transactions', { json: list(data, false, '/v1/balance_transactions') })]);
    const page = await stripeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch, { pageBudget: 20 }));
    expect(page.events.map((e) => [e.externalId, e.type, e.amount, e.currency, e.fee])).toEqual([
      ['txn_FakeHuf', 'charge', 499000, 'HUF', 15000],
      ['txn_FakeIsk', 'charge', 5000, 'ISK', 25],
      ['txn_FakeUgx', 'refund', -5000, 'UGX', 0],
      ['txn_FakeMga', 'charge', 2000000, 'MGA', 70000],
    ]);
  });

  it('resumes from its cursor when pageBudget runs out mid-backfill, with a fixed time window', async () => {
    const p1 = [bt('txn_Fake1', 'charge', 100, { created: NOW_S - 10 }), bt('txn_Fake2', 'charge', 200, { created: NOW_S - 20 })];
    const p2 = [bt('txn_Fake3', 'refund', -50, { created: NOW_S - 30 }), bt('txn_Fake4', 'charge', 400, { created: NOW_S - 40 })];
    const p3 = [bt('txn_Fake5', 'payment', 500, { created: NOW_S - 50 })];
    const window = { 'created[gte]': String(SINCE_S), 'created[lte]': String(NOW_S), limit: '100' };
    const routes = () => [
      route('/v1/balance_transactions', { json: list(p1, true) }, { query: window, absent: ['starting_after'] }),
      route('/v1/balance_transactions', { json: list(p2, true) }, { query: { ...window, starting_after: 'txn_Fake2' } }),
      route('/v1/balance_transactions', { json: list(p3, false) }, { query: { ...window, starting_after: 'txn_Fake4' } }),
    ];

    const first = fakeFetch(routes());
    const ctx1 = makeCtx(first.fetch, { pageBudget: 2 });
    const r1 = await stripeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx1);
    expect(r1.done).toBe(false);
    expect(r1.daily).toEqual([]);
    expect(r1.nextCursor).toEqual(expect.any(String));
    expect(r1.events.map((e) => e.externalId)).toEqual(['txn_Fake1', 'txn_Fake2', 'txn_Fake3', 'txn_Fake4']);
    expect(first.calls).toHaveLength(2);

    // An hour later, with a different `since` from the engine: the cursor's window wins.
    const second = fakeFetch(routes());
    const ctx2 = makeCtx(second.fetch, { pageBudget: 20, now: NOW + 3_600_000 });
    const r2 = await stripeAdapter.fetchRevenue(input(), { since: SINCE + 86_400_000, cursor: r1.nextCursor }, ctx2);
    expect(r2).toEqual({
      events: [{ externalId: 'txn_Fake5', occurredAt: (NOW_S - 50) * 1000, type: 'charge', amount: 500, currency: 'USD', fee: 0, description: null }],
      daily: [],
      nextCursor: null,
      done: true,
    });
    expect(second.calls).toHaveLength(1);
    expectStripeHeaders([...first.calls, ...second.calls]);
  });

  it('returns its cursor untouched without calling Stripe when no budget is left', async () => {
    const { fetch, calls } = fakeFetch([]);
    const r = await stripeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch, { pageBudget: 0 }));
    expect(r).toMatchObject({ events: [], daily: [], done: false, nextCursor: expect.any(String) });
    expect(calls).toHaveLength(0);

    const { fetch: fetch2, calls: calls2 } = fakeFetch([
      route('/v1/balance_transactions', { json: list([]) }, { query: { 'created[gte]': String(SINCE_S), 'created[lte]': String(NOW_S) }, absent: ['starting_after'] }),
    ]);
    const r2 = await stripeAdapter.fetchRevenue(input(), { since: 0, cursor: r.nextCursor }, makeCtx(fetch2, { now: NOW + 999_000 }));
    expect(r2).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(calls2).toHaveLength(1);
  });

  it('restarts from `since` when handed a cursor it did not write', async () => {
    const { fetch, calls } = fakeFetch([
      route('/v1/balance_transactions', { json: list([]) }, { query: { 'created[gte]': String(SINCE_S) }, absent: ['starting_after'] }),
    ]);
    const ctx = makeCtx(fetch);
    for (const cursor of ['not json', '{"v":2}', '{"v":1,"gte":1,"lte":2,"after":"cus_123"}']) {
      const r = await stripeAdapter.fetchRevenue(input(), { since: SINCE, cursor }, ctx);
      expect(r.done).toBe(true);
    }
    expect(calls).toHaveLength(3);
    expect(ctx.logs.filter((l) => l.event === 'stripe_cursor_invalid')).toHaveLength(3);
  });

  it('finishes on an empty page that claims has_more, and refuses a page whose last item has no id', async () => {
    const empty = fakeFetch([route('/v1/balance_transactions', { json: list([], true, '/v1/balance_transactions') })]);
    const r = await stripeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(empty.fetch));
    expect(r).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(empty.calls).toHaveLength(1);

    const noId: Json = bt('txn_FakeNoId', 'charge', 100);
    delete noId['id'];
    const broken = fakeFetch([route('/v1/balance_transactions', { json: list([noId], true, '/v1/balance_transactions') })]);
    const err = await catchErr(stripeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(broken.fetch)));
    expect(err.kind).toBe('upstream');
    expect(broken.calls).toHaveLength(1); // would otherwise re-read page 1 until the budget ran out
  });

  it('refuses a malformed key without a network call', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await catchErr(stripeAdapter.fetchRevenue(input('sk_FakeNotStripe'), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});

// ---------- amount units ----------

describe('stripe amount units', () => {
  it('follows docs.stripe.com/currencies: zero-decimal list, ISK/UGX two-decimal, HUF/TWD two-decimal', () => {
    // The documented zero-decimal list. UGX is in it too, but its special case (and stripe-android's
    // SERVER_DECIMAL_DIGITS) say it is sent as a two-decimal value, like ISK.
    for (const c of ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']) {
      expect(stripeDigits(c), c).toBe(0);
    }
    for (const c of ['ISK', 'UGX', 'HUF', 'TWD', 'IDR', 'COP', 'PKR', 'USD', 'EUR']) expect(stripeDigits(c), c).toBe(2);
    expect(stripeDigits('kwd')).toBe(3);
  });

  it('converts only where Stripe and ISO 4217 disagree', () => {
    expect(fromStripeAmount(499000, 'huf')).toBe(499000);
    expect(fromStripeAmount(1500, 'jpy')).toBe(1500);
    expect(fromStripeAmount(1250, 'kwd')).toBe(1250);
    expect(fromStripeAmount(500, 'isk')).toBe(5); // "to charge 5 ISK, provide an amount value of 500"
    expect(fromStripeAmount(500, 'UGX')).toBe(5);
    expect(fromStripeAmount(5000, 'mga')).toBe(500000);
    expect(fromStripeAmount(1249.5, 'isk')).toBeCloseTo(12.495); // unrounded; callers round once
  });
});
