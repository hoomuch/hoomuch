import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../../src/providers/http';
import { SECRET_KEY_WARNING, STRIPE_API_VERSION, stripeAdapter } from '../../src/providers/stripe';
import { ProviderError } from '../../src/providers/types';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, NOW, route, type RecordedCall, type Route } from '../fixtures/harness';
// Verbatim example objects from https://docs.stripe.com/api for Stripe-Version 2026-10-28.endive.
import subscriptionFx from '../fixtures/stripe/subscription.json';
import discountFx from '../fixtures/stripe/discount.json';
import couponFx from '../fixtures/stripe/coupon.json';
import priceFx from '../fixtures/stripe/price.json';
import balanceTransactionFx from '../fixtures/stripe/balance_transaction.json';
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
  tiered?: boolean;
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
  if (o.tiered) {
    p.billing_scheme = 'tiered';
    p.tiers_mode = 'graduated';
    p.unit_amount = null;
    p.unit_amount_decimal = null;
  } else {
    p.unit_amount = o.amount === undefined ? 1000 : o.amount;
    p.unit_amount_decimal = o.decimal !== undefined ? o.decimal : p.unit_amount === null ? null : String(p.unit_amount);
  }
  return p;
}

function item(p: Json, o: { quantity?: number | null; discounts?: Json[]; trialEnd?: number } = {}): Json {
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
  return it;
}

function sub(items: Json[], o: { currency?: string; status?: string; discounts?: Json[]; moreItems?: boolean } = {}): Json {
  const s = clone(subscriptionFx);
  s.id = nextId('sub');
  s.currency = o.currency ?? 'usd';
  s.status = o.status ?? 'active';
  s.discounts = o.discounts ?? [];
  s.items.data = items.map((i) => ({ ...i, subscription: s.id }));
  s.items.has_more = o.moreItems ?? false;
  s.items.total_count = items.length;
  s.items.url = `/v1/subscription_items?subscription=${s.id}`;
  return s;
}

/** Shorthand: one licensed monthly item. */
const simple = (amount: number, o: Parameters<typeof sub>[1] & PriceOpts = {}) =>
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
  ];

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

  it('accepts a restricted test key with 3 pinned, authenticated reads', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const res = await stripeAdapter.verify(input(`  ${RK_TEST}  `), ctx);
    expect(res).toEqual({ ok: true, accountLabel: 'Stripe (test mode)', config: {}, testMode: true, warnings: [] });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/subscriptions', '/v1/prices', '/v1/balance_transactions']);
    expectStripeHeaders(calls);
    expect(ctx.pageBudget).toBe(2);
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
    ['/v1/prices', 'Products & Prices: Read', 'rak_plan_read'],
    ['/v1/balance_transactions', 'Balance: Read', 'rak_balance_read'],
  ])('names the missing permission when %s is forbidden', async (path, permission, scope) => {
    const err = clone(errorPermissionFx);
    err.error.message = err.error.message.replace('rak_subscription_read', scope);
    const routes = okRoutes().filter((r) => !r.label.startsWith(path));
    const { fetch } = fakeFetch([route(path, { status: 403, json: err }), ...routes]);
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
  /** Matched before the defaults. */
  extra?: Route[];
  budget?: number;
}

function snapshotRoutes(s: SnapshotSetup): Route[] {
  return [
    ...(s.extra ?? []),
    route('/v1/subscriptions', { json: list(s.active ?? []) }, { query: { status: 'active' } }),
    route('/v1/subscriptions', { json: list(s.pastDue ?? []) }, { query: { status: 'past_due' } }),
    route('/v1/subscriptions', { json: list(s.trialing ?? []) }, { query: { status: 'trialing' } }),
    ...(s.coupons ?? []).map((c) => route(`/v1/coupons/${c['id']}`, { json: c })),
    ...(s.prices ?? []).map((p) => route(`/v1/prices/${p['id']}`, { json: p })),
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
    });
    expectStripeHeaders(calls);
  });

  it('excludes metered items and counts tiered prices as 0, logging once without PII', async () => {
    const { snap, ctx } = await snapshot({
      active: [
        sub([item(price({ amount: 2000 })), item(price({ amount: 5, usage: 'metered' }), { quantity: null })]),
        sub([item(price({ tiered: true })), item(price({ amount: 500 }))]),
        sub([item(price({ tiered: true }), { quantity: 40 })]),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 2500 });
    expect(snap.activeSubscriptions).toBe(3);
    const tiered = ctx.logs.filter((l) => l.event === 'stripe_tiered_prices_excluded');
    expect(tiered).toEqual([{ event: 'stripe_tiered_prices_excluded', data: { items: 2 } }]);
    expect(JSON.stringify(ctx.logs)).not.toMatch(/cus_|sub_|si_|price_|prod_/);
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
    expect(snap.activeSubscriptions).toBe(8);

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
    const statuses = calls.map((c) => new URL(c.url).searchParams.get('status'));
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
    const { snap } = await snapshot({
      coupons: [coupon('PCT25', { percent_off: 25 })],
      active: [s],
      extra: [
        route('/v1/subscription_items', { json: list([rest], false, '/v1/subscription_items') }, {
          query: { subscription: s['id'], starting_after: first['id'], limit: '100', 'expand[]': 'data.discounts' },
        }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 1000 + 1500 });
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
});

// ---------- revenue ----------

const SINCE = NOW - 90 * DAY_S * 1000;
const SINCE_S = Math.floor(SINCE / 1000);

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
    expect(r).toMatchObject({ events: [], daily: [], done: false });
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

  it('refuses a malformed key without a network call', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await catchErr(stripeAdapter.fetchRevenue(input('sk_FakeNotStripe'), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});
