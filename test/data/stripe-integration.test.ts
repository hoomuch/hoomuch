/**
 * End to end through the real pipeline for Stripe's MRR by product, with no Stripe account:
 * Stripe-shaped responses (the docs objects in test/fixtures/stripe) → the real adapter →
 * syncConnection → D1 (snapshots.mrr_by_product) → getDashboardData → the "By product" card.
 *
 * What this can't catch: Stripe's live API answering differently from its docs (e.g. to
 * `GET /v1/products?ids[]=…`). Then the split stays null and MRR is untouched, as the second test shows.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { fxV2 } from '../fixtures/fx';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDashboardData } from '../../src/data/dashboard';
import type { SessionUser } from '../../src/env';
import { encryptJson } from '../../src/lib/crypto';
import { syncConnection } from '../../src/sync/engine';
import { ProductCard } from '../../src/views/pages/dashboard';
import { createTestD1, seedConnection, seedUser, testEnv, TEST_ENCRYPTION_KEY, type TestD1 } from '../fixtures/d1';
import { fakeFetch, route, type FakeResponse, type Route } from '../fixtures/harness';
import balanceTransactionFx from '../fixtures/stripe/balance_transaction.json';
import couponFx from '../fixtures/stripe/coupon.json';
import discountFx from '../fixtures/stripe/discount.json';
import errorPermissionFx from '../fixtures/stripe/error_permission.json';
import listFx from '../fixtures/stripe/list.json';
import productFx from '../fixtures/stripe/product.json';
import subscriptionFx from '../fixtures/stripe/subscription.json';

// Deep clones of the docs objects with a few fields overridden, as in test/providers/stripe.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const NOW_S = Math.floor(NOW / 1000);
const RK_TEST = 'rk_test_51FakeKeyForTestsOnly000000000000000000000000000000000000000000000000000000000000';
const user: SessionUser = { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD' };
/** frankfurter.dev, USD base: 1 USD = 0.9 EUR. */
const FX = { amount: 1, base: 'USD', date: '2026-11-04', rates: { EUR: 0.9 } };

let seq = 0;
const nextId = (prefix: string) => `${prefix}_E2e${(++seq).toString().padStart(4, '0')}`;

function price(amount: number, product: string, o: { interval?: 'month' | 'year'; currency?: string } = {}): Json {
  const p = clone(subscriptionFx.items.data[0]!.price);
  Object.assign(p, {
    id: nextId('price'),
    currency: o.currency ?? 'usd',
    product,
    billing_scheme: 'per_unit',
    tiers_mode: null,
    transform_quantity: null,
    unit_amount: amount,
    unit_amount_decimal: String(amount),
  });
  Object.assign(p.recurring, { interval: o.interval ?? 'month', interval_count: 1, usage_type: 'licensed' });
  return p;
}

function item(p: Json): Json {
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
  Object.assign(it, { quantity: 1, discounts: [], current_trial: null, tax_rates: [] });
  return it;
}

function sub(items: Json[], o: { currency?: string; status?: string; discounts?: Json[] } = {}): Json {
  const s = clone(subscriptionFx);
  s.id = nextId('sub');
  Object.assign(s, { currency: o.currency ?? 'usd', status: o.status ?? 'active', discounts: o.discounts ?? [], default_tax_rates: [] });
  s.items.data = items.map((i) => ({ ...i, subscription: s.id }));
  Object.assign(s.items, { has_more: false, total_count: items.length, url: `/v1/subscription_items?subscription=${s.id}` });
  return s;
}

function discountFor(couponId: string): Json {
  const d = clone(discountFx);
  d.id = nextId('di');
  d.checkout_session = null;
  d.source.coupon = couponId;
  d.end = null;
  return d;
}

const list = (data: Json[], url: string): Json => ({ ...clone(listFx), url, data, has_more: false });

const charge = (id: string, amount: number, hoursAgo: number): Json => ({
  ...clone(balanceTransactionFx),
  id,
  type: 'charge',
  reporting_category: 'charge',
  amount,
  fee: 0,
  net: amount,
  currency: 'usd',
  created: NOW_S - hoursAgo * 3600,
  source: null,
});

const NAMES: Record<string, string> = { prod_Pro: 'Pro', prod_Team: 'Team' };

/** GET /v1/products?ids[]=…: the docs' Product object for each ID asked for. */
function products(url: URL): FakeResponse {
  const data = url.searchParams.getAll('ids[]').map((id) => ({ ...clone(productFx), id, name: NAMES[id] ?? id }));
  return { json: list(data, '/v1/products') };
}

/** What a key without Products: Read gets back. */
const PRODUCTS_FORBIDDEN: FakeResponse = (() => {
  const body = clone(errorPermissionFx);
  body.error.message = body.error.message.replace('rak_subscription_read', 'rak_product_read');
  return { status: 403, json: body };
})();

/**
 * One Stripe account: Pro $12/month, Pro $120/year (→ $10), Pro $12 + Team $29 with 20% off the
 * subscription (→ $9.60 + $23.20), Team €29 (→ $32.22 at 0.9), and a trial that isn't MRR.
 */
function stripeRoutes(productsResponse: FakeResponse | ((url: URL) => FakeResponse)): Route[] {
  const active = [
    sub([item(price(1200, 'prod_Pro'))]),
    sub([item(price(12000, 'prod_Pro', { interval: 'year' }))]),
    sub([item(price(1200, 'prod_Pro')), item(price(2900, 'prod_Team'))], { discounts: [discountFor('OFF20')] }),
    sub([item(price(2900, 'prod_Team', { currency: 'eur' }))], { currency: 'eur' }),
  ];
  const trialing = [sub([item(price(2900, 'prod_Team'))], { status: 'trialing' })];
  return [
    route('/v2/rates', { json: fxV2(FX) }),
    route('/v1/subscriptions', { json: list(active, '/v1/subscriptions') }, { query: { status: 'active' } }),
    route('/v1/subscriptions', { json: list([], '/v1/subscriptions') }, { query: { status: 'past_due' } }),
    route('/v1/subscriptions', { json: list(trialing, '/v1/subscriptions') }, { query: { status: 'trialing' } }),
    route('/v1/coupons/OFF20', { json: { ...clone(couponFx), id: 'OFF20', percent_off: 20, amount_off: null, duration: 'forever', duration_in_months: null } }),
    route('/v1/products', productsResponse),
    route('/v1/balance_transactions', {
      json: list([charge('txn_E2e1', 4100, 2), charge('txn_E2e2', 1200, 30)], '/v1/balance_transactions'),
    }),
  ];
}

let t: TestD1;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  seedConnection(t, {
    id: 'st1',
    userId: 'u1',
    provider: 'stripe',
    name: 'Acme',
    status: 'pending',
    credentialsEnc: await encryptJson(TEST_ENCRYPTION_KEY, { apiKey: RK_TEST }),
    createdAt: NOW,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const card = async (rangeDays: 7 | 30 = 30) =>
  renderToStaticMarkup(createElement(ProductCard, { data: await getDashboardData(testEnv(t.db), user, rangeDays) }));

describe('Stripe MRR by product end to end', () => {
  it('stores the split with the snapshot and shows it on the dashboard, adding up to MRR', async () => {
    const { fetch, calls } = fakeFetch(stripeRoutes(products));
    vi.stubGlobal('fetch', fetch);
    const env = testEnv(t.db);

    const r = await syncConnection(env, 'st1', 'initial');
    expect(r).toMatchObject({ ok: true, snapshot: true, error: null });
    // The names cost one request for both products, and only read calls went out.
    const lookups = calls.filter((c) => new URL(c.url).pathname === '/v1/products');
    expect(lookups.map((c) => new URL(c.url).searchParams.getAll('ids[]').sort())).toEqual([['prod_Pro', 'prod_Team']]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);

    // In D1: whole minor units per currency, product and plan names only.
    const stored = t.rows<{ mrr: string; mrr_by_product: string | null }>('SELECT mrr, mrr_by_product FROM snapshots');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.mrr)).toEqual({ USD: 1200 + 1000 + 3280, EUR: 2900 });
    const split = JSON.parse(stored[0]!.mrr_by_product!) as Array<{ name: string; mrr: Record<string, number>; subscriptions: number }>;
    expect([...split].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'Pro', mrr: { USD: 1200 + 1000 + 960 }, subscriptions: 3 },
      { name: 'Team', mrr: { USD: 2320, EUR: 2900 }, subscriptions: 2 },
    ]);

    const d = await getDashboardData(env, user, 30);
    const eur = d.kpis.mrr.value - 5480; // €29 in USD at the day's rate
    expect(eur).toBeGreaterThan(3200);
    expect(d.productMrr.rows.map((p) => [p.name, p.connectionName, p.mrr, p.subscriptions])).toEqual([
      ['Team', 'Acme', 2320 + eur, 2],
      ['Pro', 'Acme', 3160, 3],
    ]);
    expect(d.productMrr.rows.reduce((s, p) => s + p.mrr, 0)).toBe(d.kpis.mrr.value);
    expect(d.productMrr).toMatchObject({ more: null, unnamed: { mrr: 0 }, needsPermission: [], split: true });
    expect(d.productMrr.rows.reduce((s, p) => s + p.sharePct, 0)).toBeCloseTo(100, 0);
    // Revenue has no product names on Stripe, so only MRR is split.
    expect(d.kpis.revenue.value).toBe(5300);
    expect(d.products).toMatchObject({ rows: [], named: false, unnamedProviders: ['Stripe'] });

    const html = await card();
    expect(html).toContain('>By product<');
    expect(html).toContain('>Team<');
    expect(html).toContain('>Pro<');
    expect(html).toContain('$32'); // Pro, $31.60 in whole units
    expect(html).toContain('Revenue from Stripe comes without product names, so only MRR is split here.');
    expect(html).not.toContain('Products: Read');
  });

  it('keeps MRR whole without Products: Read, says what to add, and splits after the key gets it', async () => {
    const first = fakeFetch(stripeRoutes(PRODUCTS_FORBIDDEN));
    vi.stubGlobal('fetch', first.fetch);
    const env = testEnv(t.db);

    expect(await syncConnection(env, 'st1', 'initial')).toMatchObject({ ok: true, snapshot: true, error: null });
    const before = await getDashboardData(env, user, 30);
    expect(before.productMrr).toMatchObject({ rows: [], split: false, needsPermission: ['Acme'] });
    expect(before.productMrr.unnamed.mrr).toBe(before.kpis.mrr.value); // all of it, nothing lost
    expect(t.rows<{ v: string | null }>('SELECT mrr_by_product AS v FROM snapshots')[0]!.v).toBeNull();
    const html = await card();
    expect(html).toContain('Acme can split MRR by product once its Stripe key has Products: Read.');
    expect(html).toContain('Revenue from Stripe comes without product names, so it can’t be split by product.');

    // The owner adds Products: Read; the next sync the same day rewrites the snapshot with a split.
    vi.setSystemTime(NOW + 60 * 60_000);
    const second = fakeFetch(stripeRoutes(products));
    vi.stubGlobal('fetch', second.fetch);
    expect(await syncConnection(env, 'st1', 'cron')).toMatchObject({ ok: true, snapshot: true, error: null });
    const after = await getDashboardData(env, user, 30);
    expect(after.kpis.mrr.value).toBe(before.kpis.mrr.value);
    expect(after.productMrr).toMatchObject({ split: true, needsPermission: [], unnamed: { mrr: 0 } });
    expect(after.productMrr.rows.map((p) => p.name)).toEqual(['Team', 'Pro']);
    expect(await card()).not.toContain('Products: Read');
  });
});
