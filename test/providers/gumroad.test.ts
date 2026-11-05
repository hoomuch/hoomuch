import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../../src/providers/http';
import {
  AUTH_ERROR,
  FIRST_BACKFILL_MIN_MS,
  PERM_SALES,
  RECENT_CHARGES_MS,
  REFUND_LOOKBACK_MS,
  classifySubscriber,
  decodeCursor,
  encodeCursor,
  gumroadAdapter,
  refundFloor,
} from '../../src/providers/gumroad';
import { ProviderError, type RevenuePage } from '../../src/providers/types';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, NOW, route, type RecordedCall, type Route, type TestCtx } from '../fixtures/harness';
// Example responses from https://gumroad.com/api (2026-11-05), verbatim except for the docs' `#` comments and
// `{...}` placeholders, which aren't JSON, and the unquoted id in the subscribers example.
import userFx from '../fixtures/gumroad/user.json';
import productsFx from '../fixtures/gumroad/products.json';
import subscribersFx from '../fixtures/gumroad/subscribers.json';
import salesFx from '../fixtures/gumroad/sales.json';
import saleFx from '../fixtures/gumroad/sale.json';
import partiallyRefundedFx from '../fixtures/gumroad/sale-partially-refunded.json';
import notFoundFx from '../fixtures/gumroad/error-not-found.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

// The access token from Gumroad's "Create an application" help article.
const TOKEN = 'abf11e4ab2850ffd50ef690257f7a1c998a443059513d1a4826f2b3159620505';
const DAY = 86_400_000;
const input = (apiKey = TOKEN) => ({ credentials: { apiKey }, config: {} });
const iso = (ms: number) => new Date(ms).toISOString();
const enc = encodeURIComponent;
/** Customer data that appears in the docs examples and must never come out of the adapter. */
const PII = ['@gumroad', 'affiliate@example.com', 'Twitter handle', 'Loved it', '**** ****', '83DB262A', '85DB562A', '"zip'];

let seq = 0;
const nextId = (prefix: string) => `${prefix}${(++seq).toString().padStart(4, '0')}-FakeIdForTests==`;

// ---------- builders: deep clones of the docs objects with a few fields overridden ----------

interface TierOpts {
  name: string;
  prices: Record<string, number>;
  pwyw?: boolean;
}

function product(o: { id?: string; tiers?: TierOpts[]; currency?: string; legacy?: string; price?: number; tiered?: boolean } = {}): Json {
  const p = clone(productsFx.products[0]);
  const option = p.variants[0].options[0];
  p.id = o.id ?? nextId('prod');
  p.currency = o.currency ?? 'usd';
  p.price = o.price ?? p.price;
  p.is_tiered_membership = o.tiered ?? o.legacy === undefined;
  p.subscription_duration = o.legacy ?? null;
  const tiers = o.tiers ?? [{ name: 'First Tier', prices: { monthly: 300 } }];
  p.recurrences = p.is_tiered_membership ? [...new Set(tiers.flatMap((t) => Object.keys(t.prices)))] : null;
  p.variants = p.is_tiered_membership
    ? [
        {
          title: 'Tier',
          options: tiers.map((t) => ({
            ...clone(option),
            name: t.name,
            is_pay_what_you_want: t.pwyw ?? false,
            recurrence_prices: Object.fromEntries(
              Object.entries(t.prices).map(([rec, cents]) => [rec, { price_cents: cents, suggested_price_cents: null }]),
            ),
          })),
        },
      ]
    : [];
  return p;
}

interface SubOpts {
  id?: string;
  recurrence?: string;
  status?: string;
  trialEnds?: number | null;
  cancelledAt?: number | null;
  endedAt?: number | null;
  failedAt?: number | null;
  purchaseIds?: string[];
}

function subscriber(productId: string, o: SubOpts = {}): Json {
  const s = clone(subscribersFx.subscribers[0]);
  s.id = o.id ?? nextId('sub');
  s.product_id = productId;
  s.recurrence = o.recurrence ?? 'monthly';
  s.status = o.status ?? 'alive';
  s.free_trial_ends_at = o.trialEnds ? iso(o.trialEnds) : null;
  s.cancelled_at = o.cancelledAt ? iso(o.cancelledAt) : null;
  s.ended_at = o.endedAt ? iso(o.endedAt) : null;
  s.failed_at = o.failedAt ? iso(o.failedAt) : null;
  s.purchase_ids = o.purchaseIds ?? [nextId('sale')];
  return s;
}

interface SaleOpts {
  id?: string;
  subscriptionId?: string | null;
  productId?: string;
  price?: number;
  at?: number;
  recurrence?: string | null;
  tier?: string;
  currency?: string;
  tax?: number;
  taxIncluded?: boolean;
  refunded?: boolean;
  partiallyRefunded?: boolean;
  refundable?: string;
  chargedback?: boolean;
  upgrade?: boolean;
  giftReceiver?: boolean;
  fee?: number;
  name?: string;
}

function sale(o: SaleOpts = {}): Json {
  const s = clone(salesFx.sales[0]);
  s.id = o.id ?? nextId('sale');
  s.subscription_id = o.subscriptionId === undefined ? null : o.subscriptionId;
  if (s.subscription_id === null) delete s.subscription_id;
  s.product_id = o.productId ?? s.product_id;
  s.price = o.price ?? 1000;
  s.created_at = iso(o.at ?? NOW - 3600_000);
  s.subscription_duration = o.recurrence === undefined ? 'monthly' : o.recurrence;
  s.variants = { Tier: o.tier ?? 'First Tier' };
  s.currency = o.currency ?? 'usd';
  s.tax_cents = o.tax ?? 0;
  if (o.taxIncluded !== undefined) s.tax_included_in_price = o.taxIncluded;
  if (o.refunded !== undefined) s.refunded = o.refunded;
  s.partially_refunded = o.partiallyRefunded ?? false;
  s.amount_refundable_in_currency = o.refundable ?? '0';
  s.chargedback = o.chargedback ?? false;
  if (o.upgrade !== undefined) s.is_upgrade_purchase = o.upgrade;
  s.is_gift_receiver_purchase = o.giftReceiver ?? false;
  s.gumroad_fee = o.fee ?? s.gumroad_fee;
  s.product_name = o.name ?? s.product_name;
  return s;
}

function page(key: 'products' | 'subscribers' | 'sales', items: Json[], next?: string): Json {
  return { success: true, [key]: items, ...(next ? { next_page_key: next, next_page_url: `/v2/${key}?page_key=${next}` } : {}) };
}

const subsPath = (productId: string) => `/v2/products/${enc(productId)}/subscribers`;
const salePath = (saleId: string) => `/v2/sales/${enc(saleId)}`;

function expectGumroadRequests(calls: RecordedCall[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.method).toBe('GET');
    expect(c.url.startsWith('https://api.gumroad.com/v2/')).toBe(true);
    expect(c.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(c.url).not.toContain(TOKEN); // never in the URL
    expect(new URL(c.url).searchParams.has('access_token')).toBe(false);
  }
}

function expectNoPii(ctx: TestCtx, result: unknown): void {
  const dump = JSON.stringify({ result, logs: ctx.logs });
  for (const s of PII) expect(dump).not.toContain(s);
  expectNoSecretsInLogs(ctx, [TOKEN]);
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

const pathsOf = (calls: RecordedCall[]) => calls.map((c) => decodeURIComponent(new URL(c.url).pathname));

// ---------- verify ----------

describe('gumroad verify', () => {
  const okRoutes = () => [
    route('/v2/user', { json: userFx }),
    route('/v2/sales', { json: salesFx }, { query: { after: '2026-11-05' }, absent: ['page_key', 'product_id'] }),
  ];

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['header prefix pasted', `Bearer ${TOKEN}`],
    ['inner whitespace', 'abf11e4ab2850ffd 50ef690257f7a1c998a443059513d1a4826f2b3159620505'],
    ['too short', 'abc123'],
    ['URL', 'https://gumroad.com/settings/advanced'],
  ])('rejects a %s token on the apiKey field without a network call', async (_label, key) => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await gumroadAdapter.verify(input(key), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error.length).toBeGreaterThan(10);
    expect(calls).toHaveLength(0);
  });

  it('accepts a token with 2 authenticated reads and labels the account with the seller name', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const res = await gumroadAdapter.verify(input(`  ${TOKEN}  `), ctx);
    expect(res).toEqual({ ok: true, accountLabel: 'John Smith', config: {}, testMode: false, warnings: [] });
    expect(pathsOf(calls)).toEqual(['/v2/user', '/v2/sales']);
    expectGumroadRequests(calls);
    expect(ctx.pageBudget).toBe(3);
    // The seller's own email is in /user (view_sales); it isn't kept either.
    expect(JSON.stringify({ res, logs: ctx.logs })).not.toContain('johnsmith@gumroad.com');
    expectNoPii(ctx, res);
  });

  it.each([
    [{ name: null, url: 'https://gumroad.com/sailorjohn' }, 'gumroad.com/sailorjohn'],
    [{ name: '  ', url: 'https://sahil.gumroad.com' }, 'sahil.gumroad.com'],
    [{ name: null, url: null }, 'Gumroad'],
  ])('falls back to the profile URL for the label (%o)', async (user, label) => {
    const body = clone(userFx);
    Object.assign(body.user, user);
    const { fetch } = fakeFetch([route('/v2/user', { json: body }), ...okRoutes().slice(1)]);
    const res = await gumroadAdapter.verify(input(), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, accountLabel: label });
  });

  it('reports a rejected token (401, empty body) on the apiKey field after one request', async () => {
    const { fetch, calls } = fakeFetch([route('/v2/user', { status: 401, body: '' })]);
    const ctx = makeCtx(fetch);
    const res = await gumroadAdapter.verify(input(), ctx);
    expect(res).toEqual({ ok: false, error: AUTH_ERROR, field: 'apiKey' });
    expect(AUTH_ERROR).toMatch(/Generate access token/);
    expect(calls).toHaveLength(1);
    expectNoSecretsInLogs(ctx, [TOKEN]);
  });

  it('names the view_sales scope when the token can’t read sales (403)', async () => {
    const { fetch } = fakeFetch([route('/v2/user', { json: userFx }), route('/v2/sales', { status: 403, body: '' })]);
    const res = await gumroadAdapter.verify(input(), makeCtx(fetch));
    expect(res).toMatchObject({ ok: false, field: 'apiKey', error: expect.stringContaining(`“${PERM_SALES}”`) });
  });

  it('throws on outages and on in-band failures instead of accepting the token', async () => {
    const down = fakeFetch([route('/v2/user', { status: 503, json: { success: false } })]);
    expect((await catchErr(gumroadAdapter.verify(input(), makeCtx(down.fetch)))).kind).toBe('upstream');

    const failed = fakeFetch([route('/v2/user', { json: { success: false, message: 'Something went wrong.' } })]);
    const err = await catchErr(gumroadAdapter.verify(input(), makeCtx(failed.fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/Something went wrong/);
  });
});

// ---------- fetchSnapshot ----------

interface SnapshotSetup {
  products: Json[];
  subs: Record<string, Json[]>;
  /** Sales GET /sales?product_id=… returns (newest first), per product. */
  productSales?: Record<string, Json[]>;
  /** GET /sales/{id} bodies. */
  lookups?: Record<string, Json>;
}

function snapshotRoutes(s: SnapshotSetup): Route[] {
  const routes: Route[] = [route('/v2/products', { json: page('products', s.products) })];
  for (const p of s.products) {
    routes.push(route(subsPath(p.id), { json: page('subscribers', s.subs[p.id] ?? []) }, { query: { paginated: 'true' } }));
    routes.push(
      route('/v2/sales', { json: page('sales', s.productSales?.[p.id] ?? []) }, { query: { product_id: p.id, after: '2026-10-01' } }),
    );
  }
  for (const [id, body] of Object.entries(s.lookups ?? {})) routes.push(route(salePath(id), { json: body }));
  return routes;
}

async function snapshot(s: SnapshotSetup, pageBudget = 80) {
  const { fetch, calls } = fakeFetch(snapshotRoutes(s));
  const ctx = makeCtx(fetch, { pageBudget });
  const snap = await gumroadAdapter.fetchSnapshot(input(), ctx);
  return { snap, calls, ctx };
}

/** One tiered product and its subscribers, each with its newest charge in the product's recent sales. */
function oneProduct(subs: Array<{ sub?: SubOpts; sale?: SaleOpts | null }>, p: Json = product()): SnapshotSetup {
  const list: Json[] = [];
  const sales: Json[] = [];
  for (const x of subs) {
    const s = subscriber(p.id, x.sub);
    list.push(s);
    if (x.sale !== null) sales.push(sale({ subscriptionId: s.id, productId: p.id, ...x.sale }));
  }
  return { products: [p], subs: { [p.id]: list }, productSales: { [p.id]: sales } };
}

describe('gumroad fetchSnapshot', () => {
  it('prices the docs subscriber at its newest charge from the docs sales (USD, monthly)', async () => {
    const p = clone(productsFx.products[0]);
    const sub = clone(subscribersFx.subscribers[0]);
    const s = clone(salesFx.sales[0]);
    s.subscription_id = sub.id;
    s.created_at = iso(NOW - 10 * DAY);
    const { snap, calls, ctx } = await snapshot({ products: [p], subs: { [p.id]: [sub] }, productSales: { [p.id]: [s] } });
    expect(snap).toEqual({
      mrr: { USD: 1000 },
      activeSubscriptions: 1,
      activeTrials: 0,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
    });
    expect(pathsOf(calls)).toEqual(['/v2/products', `/v2/products/${p.id}/subscribers`, '/v2/sales']);
    expect(new URL(calls[2]!.url).searchParams.get('after')).toBe(new Date(NOW - RECENT_CHARGES_MS).toISOString().slice(0, 10));
    expectGumroadRequests(calls);
    expectNoPii(ctx, snap);
  });

  it('counts trials, pending cancellations and failing renewals; leaves out ended ones', async () => {
    const setup = oneProduct([
      { sub: { status: 'alive' } },
      { sub: { status: 'pending_cancellation', cancelledAt: NOW + 10 * DAY } }, // active until the period ends
      { sub: { status: 'pending_failure' } }, // renewal retrying, like past_due
      { sub: { status: 'payment_method_update_required' } },
      { sub: { status: 'alive', trialEnds: NOW + 5 * DAY }, sale: { price: 0 } }, // free trial
      { sub: { status: 'pending_cancellation', trialEnds: NOW + 2 * DAY, cancelledAt: NOW + 2 * DAY }, sale: null },
      { sub: { status: 'alive', trialEnds: NOW - 5 * DAY } }, // trial over and charged
      { sub: { status: 'cancelled', cancelledAt: NOW - DAY } },
      { sub: { status: 'alive', endedAt: NOW - DAY } },
      { sub: { status: 'failed_payment', failedAt: NOW - DAY } },
      { sub: { status: 'fixed_subscription_period_ended' } },
      { sub: { status: 'something_new' } },
    ]);
    const { snap, ctx } = await snapshot(setup);
    expect(snap.activeTrials).toBe(2);
    expect(snap.activeSubscriptions).toBe(5);
    expect(snap.mrr).toEqual({ USD: 5000 });
    expect(ctx.logs.find((l) => l.event === 'gumroad_unknown_status')?.data).toEqual({ subscribers: 1 });
  });

  it('classifies statuses and timestamps directly', () => {
    const base = { status: 'alive', trialEndsAt: null, cancelledAt: null, endedAt: null, failedAt: null };
    expect(classifySubscriber(base, NOW)).toBe('paying');
    expect(classifySubscriber({ ...base, trialEndsAt: NOW + 1 }, NOW)).toBe('trial');
    expect(classifySubscriber({ ...base, trialEndsAt: NOW }, NOW)).toBe('paying');
    expect(classifySubscriber({ ...base, cancelledAt: NOW }, NOW)).toBe('none');
    expect(classifySubscriber({ ...base, status: 'pending_cancellation', cancelledAt: NOW + 1 }, NOW)).toBe('paying');
    expect(classifySubscriber({ ...base, status: 'cancelled' }, NOW)).toBe('none');
    expect(classifySubscriber({ ...base, status: null }, NOW)).toBe('unknown');
  });

  it.each([
    ['quarterly', 3000],
    ['biannually', 6000],
    ['yearly', 12000],
    ['every_two_years', 24000],
  ])('normalizes a %s charge to a month', async (recurrence, price) => {
    const p = product({ tiers: [{ name: 'First Tier', prices: { [recurrence]: price } }] });
    const { snap } = await snapshot(oneProduct([{ sub: { recurrence }, sale: { price, recurrence } }], p));
    expect(snap.mrr).toEqual({ USD: 1000 });
  });

  it('keeps Gumroad’s merchant-of-record tax out (never in price) and backs inclusive seller tax out', async () => {
    const { snap } = await snapshot(
      oneProduct([
        { sale: { price: 1000, tax: 125, taxIncluded: false } }, // docs GET /sales/:id: tax added on top
        { sale: { price: 1210, tax: 210, taxIncluded: true } }, // legacy inclusive seller tax
      ]),
    );
    expect(snap.mrr).toEqual({ USD: 2000 });
  });

  it('reads amounts as USD whatever the listing currency is (price is canonical USD cents)', async () => {
    const p = product({ currency: 'eur', tiers: [{ name: 'First Tier', prices: { monthly: 900 } }] });
    const { snap } = await snapshot(oneProduct([{ sale: { price: 1000, currency: 'eur' } }], p));
    expect(snap.mrr).toEqual({ USD: 1000 });
  });

  it('looks up the newest purchase of a subscriber that didn’t renew in the last 35 days', async () => {
    const p = product({ tiers: [{ name: 'Gold', prices: { yearly: 12000 } }] });
    const sub = subscriber(p.id, { recurrence: 'yearly', purchaseIds: ['old-FakeId==', 'new-FakeId=='] });
    const looked = clone(saleFx);
    looked.sale.id = 'new-FakeId==';
    looked.sale.subscription_id = sub.id;
    looked.sale.subscription_duration = 'yearly';
    looked.sale.price = 9000; // e.g. a purchasing-power-parity price: the list price would say 12000
    const { snap, calls } = await snapshot({
      products: [p],
      subs: { [p.id]: [sub] },
      productSales: { [p.id]: [] },
      lookups: { 'new-FakeId==': looked },
    });
    expect(snap.mrr).toEqual({ USD: 750 });
    expect(pathsOf(calls)).toEqual(['/v2/products', `/v2/products/${p.id}/subscribers`, '/v2/sales', '/v2/sales/new-FakeId==']);
    expect(calls[3]!.url).toBe(`https://api.gumroad.com/v2/sales/new-FakeId%3D%3D`);
  });

  it('uses the newest sale only: an older charge of the same subscription doesn’t override it', async () => {
    const p = product({ tiers: [{ name: 'First Tier', prices: { monthly: 300 } }] });
    const sub = subscriber(p.id);
    const sales = [
      sale({ subscriptionId: sub.id, price: 1500, at: NOW - 2 * DAY }),
      sale({ subscriptionId: sub.id, price: 1000, at: NOW - 32 * DAY }),
    ];
    const { snap } = await snapshot({ products: [p], subs: { [p.id]: [sub] }, productSales: { [p.id]: sales } });
    expect(snap.mrr).toEqual({ USD: 1500 });
  });

  it('falls back to the list price of the named tier for upgrade prorations, $0 charges and recurrence changes', async () => {
    const p = product({
      tiers: [
        { name: 'Basic', prices: { monthly: 500, yearly: 5000 } },
        { name: 'Pro', prices: { monthly: 2000, yearly: 20000 } },
      ],
    });
    const { snap, ctx } = await snapshot(
      oneProduct(
        [
          { sale: { price: 777, upgrade: true, tier: 'Pro' } }, // prorated upgrade to Pro → 2000
          { sale: { price: 0, tier: 'Basic' } }, // trial ended, first charge not made yet → 500
          { sub: { recurrence: 'yearly' }, sale: { price: 500, recurrence: 'monthly', tier: 'pro' } }, // switched to yearly → 20000/12
        ],
        p,
      ),
    );
    expect(snap.mrr).toEqual({ USD: 2000 + 500 + 1667 });
    expect(snap.activeSubscriptions).toBe(3);
    expect(ctx.logs.find((l) => l.event === 'gumroad_snapshot')?.data?.['priced']).toMatchObject({ charge: 0, list: 3 });
  });

  it('ignores a looked-up sale that belongs to another subscription', async () => {
    const p = product({ tiers: [{ name: 'Only', prices: { monthly: 800 } }] });
    const sub = subscriber(p.id, { purchaseIds: ['x-FakeId=='] });
    const other = clone(saleFx);
    other.sale.id = 'x-FakeId==';
    other.sale.subscription_id = 'someone-else==';
    const { snap } = await snapshot({ products: [p], subs: { [p.id]: [sub] }, lookups: { 'x-FakeId==': other } });
    expect(snap.mrr).toEqual({ USD: 800 }); // list price, product currency
  });

  it('treats an unknown purchase (in-band "not found") as no charge and uses the list price', async () => {
    const p = product({ currency: 'eur', tiers: [{ name: 'Only', prices: { monthly: 800 } }] });
    const sub = subscriber(p.id, { purchaseIds: ['gone-FakeId=='] });
    const { snap } = await snapshot({
      products: [p],
      subs: { [p.id]: [sub] },
      lookups: { 'gone-FakeId==': { success: false, message: 'The sale was not found.' } },
    });
    expect(snap.mrr).toEqual({ EUR: 800 });
  });

  describe('out of lookup budget', () => {
    // The 2 required requests (products, subscribers) and nothing left for the sales scan or lookups.
    const required = 2;

    it('prices a single-tier product exactly from its list price', async () => {
      const p = product({ currency: 'gbp', tiers: [{ name: 'Only', prices: { monthly: 800, yearly: 8000 } }] });
      const setup = oneProduct([{}, { sub: { recurrence: 'yearly' } }], p);
      const { snap, calls, ctx } = await snapshot(setup, required);
      expect(snap.mrr).toEqual({ GBP: 800 + 667 });
      expect(snap.activeSubscriptions).toBe(2);
      expect(calls).toHaveLength(2);
      expect(ctx.logs.find((l) => l.event === 'gumroad_mrr_estimated')?.data).toEqual({ estimated: 0, budget: true });
    });

    it('prices an unknown tier at the cheapest tier (a lower bound) and logs it', async () => {
      const p = product({
        tiers: [
          { name: 'Free', prices: { monthly: 0 } },
          { name: 'Basic', prices: { monthly: 500 } },
          { name: 'Pro', prices: { monthly: 2000 } },
        ],
      });
      const { snap, ctx } = await snapshot(oneProduct([{}, {}], p), required);
      expect(snap.mrr).toEqual({ USD: 1000 });
      expect(ctx.logs.find((l) => l.event === 'gumroad_mrr_estimated')?.data).toEqual({ estimated: 2, budget: true });
    });

    it('treats a pay-what-you-want tier’s minimum as an estimate', async () => {
      const p = product({ tiers: [{ name: 'PWYW', prices: { monthly: 300 }, pwyw: true }] });
      const { snap, ctx } = await snapshot(oneProduct([{}], p), required);
      expect(snap.mrr).toEqual({ USD: 300 });
      expect(ctx.logs.find((l) => l.event === 'gumroad_mrr_estimated')?.data).toMatchObject({ estimated: 1 });
    });

    it('looks up ambiguous subscribers before ones whose list price is exact', async () => {
      const simple = product({ tiers: [{ name: 'Only', prices: { monthly: 800 } }] });
      const tiered = product({
        tiers: [
          { name: 'Basic', prices: { monthly: 500 } },
          { name: 'Pro', prices: { monthly: 2000 } },
        ],
      });
      const a = subscriber(simple.id, { purchaseIds: ['a-FakeId=='] });
      const b = subscriber(tiered.id, { purchaseIds: ['b-FakeId=='] });
      const proSale = clone(saleFx);
      proSale.sale.id = 'b-FakeId==';
      proSale.sale.subscription_id = b.id;
      proSale.sale.price = 2000;
      const setup: SnapshotSetup = {
        products: [simple, tiered],
        subs: { [simple.id]: [a], [tiered.id]: [b] },
        productSales: {},
        lookups: { 'b-FakeId==': proSale },
      };
      // products + 2 subscriber lists + 2 product sales scans + 1 lookup.
      const { snap, calls } = await snapshot(setup, 6);
      expect(pathsOf(calls).slice(-1)).toEqual(['/v2/sales/b-FakeId==']);
      expect(snap.mrr).toEqual({ USD: 800 + 2000 });
    });
  });

  it('leaves free tiers out of MRR and the active count', async () => {
    const p = product({ tiers: [{ name: 'Free', prices: { monthly: 0 } }] });
    const { snap } = await snapshot(oneProduct([{ sale: { price: 0, tier: 'Free' } }], p));
    expect(snap).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 0 });
  });

  it('skips products that aren’t memberships and prices legacy subscriptions from their base price', async () => {
    const ebook = product({ tiered: false });
    ebook.subscription_duration = null;
    const legacy = product({ legacy: 'monthly', price: 500, currency: 'cad' });
    const s = subscriber(legacy.id, { purchaseIds: [] });
    const { fetch, calls } = fakeFetch([
      route('/v2/products', { json: page('products', [ebook, legacy]) }),
      route(subsPath(legacy.id), { json: page('subscribers', [s]) }),
      route('/v2/sales', { json: page('sales', []) }, { query: { product_id: legacy.id } }),
    ]);
    const snap = await gumroadAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ CAD: 500 });
    expect(pathsOf(calls)).toEqual(['/v2/products', `/v2/products/${legacy.id}/subscribers`, '/v2/sales']);
  });

  it('follows next_page_key for products, subscribers and product sales', async () => {
    const p1 = product();
    const p2 = product({ tiers: [{ name: 'Only', prices: { monthly: 400 } }] });
    const s1 = subscriber(p2.id);
    const s2 = subscriber(p2.id);
    const { fetch, calls } = fakeFetch([
      route('/v2/products', { json: page('products', [p1], 'pk-products-2') }, { absent: ['page_key'] }),
      route('/v2/products', { json: page('products', [p2]) }, { query: { page_key: 'pk-products-2' } }),
      route(subsPath(p1.id), { json: page('subscribers', []) }),
      route(subsPath(p2.id), { json: page('subscribers', [s1], '20241004235318372406-857093235') }, { absent: ['page_key'] }),
      route(subsPath(p2.id), { json: page('subscribers', [s2]) }, { query: { page_key: '20241004235318372406-857093235', paginated: 'true' } }),
      route('/v2/sales', { json: page('sales', [sale({ subscriptionId: s1.id, price: 450 })], 'pk-sales-2') }, { absent: ['page_key'] }),
      route('/v2/sales', { json: page('sales', [sale({ subscriptionId: s2.id, price: 550 })]) }, { query: { page_key: 'pk-sales-2' } }),
    ]);
    const snap = await gumroadAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ USD: 1000 });
    expect(snap.activeSubscriptions).toBe(2);
    expect(calls).toHaveLength(7);
  });

  it('stops scanning a product’s sales once all its subscribers are found', async () => {
    const p = product();
    const s = subscriber(p.id);
    const { fetch, calls } = fakeFetch([
      route('/v2/products', { json: page('products', [p]) }),
      route(subsPath(p.id), { json: page('subscribers', [s]) }),
      route('/v2/sales', { json: page('sales', [sale({ subscriptionId: s.id })], 'pk-more') }),
    ]);
    await gumroadAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(calls).toHaveLength(3);
  });

  it('skips a product that vanished between the two listings', async () => {
    const p = product();
    const { fetch } = fakeFetch([route('/v2/products', { json: page('products', [p]) }), route(subsPath(p.id), { json: notFoundFx })]);
    const ctx = makeCtx(fetch);
    const snap = await gumroadAdapter.fetchSnapshot(input(), ctx);
    expect(snap).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 0 });
    expect(ctx.logs.find((l) => l.event === 'gumroad_snapshot')?.data).toMatchObject({ vanished: 1 });
  });

  it('fails instead of writing a partial snapshot when the required listings don’t fit in the budget', async () => {
    const p = product();
    const { fetch } = fakeFetch(snapshotRoutes(oneProduct([{}], p)));
    await expect(gumroadAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 1 }))).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('refuses a repeated next_page_key instead of looping', async () => {
    const { fetch } = fakeFetch([route('/v2/products', { json: page('products', [], 'same-key') })]);
    const err = await catchErr(gumroadAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
  });

  it('maps a revoked token and a missing scope', async () => {
    const revoked = fakeFetch([route('/v2/products', { status: 401, body: '' })]);
    expect((await catchErr(gumroadAdapter.fetchSnapshot(input(), makeCtx(revoked.fetch)))).kind).toBe('auth');

    const p = product();
    const scoped = fakeFetch([route('/v2/products', { json: page('products', [p]) }), route(subsPath(p.id), { status: 403, body: '' })]);
    const err = await catchErr(gumroadAdapter.fetchSnapshot(input(), makeCtx(scoped.fetch)));
    expect(err.kind).toBe('permission');
    expect(err.message).toContain(PERM_SALES);
  });

  it('rejects a malformed token before any request', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await catchErr(gumroadAdapter.fetchSnapshot(input('Bearer x'), makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'invalid_input', field: 'apiKey' });
    expect(calls).toHaveLength(0);
  });
});

// ---------- fetchRevenue ----------

const INCREMENTAL_SINCE = NOW - 3 * DAY;
const BACKFILL_SINCE = Date.parse('2026-08-08T00:00:00.000Z'); // 90-day first backfill

async function revenue(routes: Route[], since: number, opts: { cursor?: string | null; pageBudget?: number } = {}) {
  const { fetch, calls } = fakeFetch(routes);
  const ctx = makeCtx(fetch, { pageBudget: opts.pageBudget ?? 20 });
  const res: RevenuePage = await gumroadAdapter.fetchRevenue(input(), { since, cursor: opts.cursor ?? null }, ctx);
  return { res, calls, ctx };
}

const salesRoute = (sales: Json[], next?: string, opts: { pageKey?: string } = {}) =>
  route('/v2/sales', { json: page('sales', sales, next) }, opts.pageKey ? { query: { page_key: opts.pageKey } } : { absent: ['page_key'] });

describe('gumroad fetchRevenue', () => {
  it('turns the docs sale into a USD charge with its fee and product name', async () => {
    const s = clone(salesFx.sales[0]);
    s.created_at = '2026-11-04T19:38:56Z';
    const { res, calls, ctx } = await revenue([route('/v2/sales', { json: { ...clone(salesFx), sales: [s], next_page_key: undefined } })], INCREMENTAL_SINCE);
    expect(res).toEqual({
      events: [
        {
          externalId: 'B28UKN-dvxYabdavG97Y-Q==',
          occurredAt: Date.parse('2026-11-04T19:38:56Z'),
          type: 'charge',
          amount: 1000,
          currency: 'USD',
          fee: 60,
          description: 'Pencil Icon PSD',
        },
      ],
      daily: [],
      nextCursor: null,
      done: true,
    });
    expectGumroadRequests(calls);
    expect(new URL(calls[0]!.url).searchParams.get('after')).toBe('2026-10-03'); // since − 30 days
    expectNoPii(ctx, res);
  });

  it('reads the first backfill from `since` with no refund lookback', async () => {
    expect(refundFloor(BACKFILL_SINCE, NOW)).toBe(BACKFILL_SINCE);
    expect(refundFloor(INCREMENTAL_SINCE, NOW)).toBe(INCREMENTAL_SINCE - REFUND_LOOKBACK_MS);
    expect(refundFloor(NOW - FIRST_BACKFILL_MIN_MS, NOW)).toBe(NOW - FIRST_BACKFILL_MIN_MS - REFUND_LOOKBACK_MS);

    const inWindow = sale({ at: BACKFILL_SINCE + DAY, refunded: true });
    const before = sale({ at: BACKFILL_SINCE - DAY, refunded: true });
    const { res, calls } = await revenue([salesRoute([inWindow, before], 'pk-never-read')], BACKFILL_SINCE);
    expect(new URL(calls[0]!.url).searchParams.get('after')).toBe('2026-08-08');
    expect(res.events.map((e) => [e.externalId, e.type, e.amount])).toEqual([
      [inWindow.id, 'charge', 1000],
      [`${inWindow.id}:refund`, 'refund', -1000],
    ]);
    expect(res.done).toBe(true);
    expect(calls).toHaveLength(1); // the older sale ends the traversal
  });

  it('dates refunds at their sale and reports late refunds of already-stored sales', async () => {
    const fresh = sale({ at: NOW - DAY });
    const refundedRecently = sale({ at: NOW - 20 * DAY, refunded: true, price: 2500, fee: 250 });
    const untouched = sale({ at: NOW - 25 * DAY });
    const tooOld = sale({ at: NOW - 40 * DAY, refunded: true });
    const { res, ctx } = await revenue([salesRoute([fresh, refundedRecently, untouched, tooOld])], INCREMENTAL_SINCE);
    expect(res.events).toEqual([
      expect.objectContaining({ externalId: fresh.id, type: 'charge', amount: 1000 }),
      {
        externalId: `${refundedRecently.id}:refund`,
        occurredAt: NOW - 20 * DAY,
        type: 'refund',
        amount: -2500,
        currency: 'USD',
        fee: null,
        description: 'Pencil Icon PSD',
      },
    ]);
    expect(ctx.logs.find((l) => l.event === 'gumroad_revenue')?.data).toMatchObject({ charges: 1, refunds: 1, lateRefunds: 1, done: true });
  });

  it('prices the docs partial refund from amount_refundable_in_currency ($10, $8 refundable → −$2)', async () => {
    const s = clone(partiallyRefundedFx.sale);
    s.created_at = iso(NOW - DAY);
    const { res } = await revenue([salesRoute([s])], INCREMENTAL_SINCE);
    expect(res.events.map((e) => [e.externalId, e.type, e.amount, e.fee])).toEqual([
      ['A-m3CDDC5dlrSdKZp0RFhA==', 'charge', 1000, 115],
      ['A-m3CDDC5dlrSdKZp0RFhA==:refund', 'refund', -200, null],
    ]);
  });

  it.each([
    ['1,234.5', 125_000, -1550], // $1,250 sale, $1,234.50 still refundable
    ['0', 1000, -1000],
    ['12.34', 2000, -766],
  ])('parses refundable "%s" as USD', async (refundable, price, refund) => {
    const s = sale({ at: NOW - DAY, price, partiallyRefunded: true, refundable });
    const { res } = await revenue([salesRoute([s])], INCREMENTAL_SINCE);
    expect(res.events.find((e) => e.type === 'refund')?.amount).toBe(refund);
  });

  it('skips a partial refund it can’t price (listing currency other than USD) and logs it', async () => {
    const s = sale({ at: NOW - DAY, currency: 'eur', partiallyRefunded: true, refundable: '7,5' });
    const { res, ctx } = await revenue([salesRoute([s])], INCREMENTAL_SINCE);
    expect(res.events.map((e) => e.type)).toEqual(['charge']);
    expect(res.events[0]!.currency).toBe('USD');
    expect(ctx.logs.find((l) => l.event === 'gumroad_revenue')?.data).toMatchObject({ partialUnpriced: 1 });
  });

  it('reverses a chargeback in full, and a full refund wins over a partial one', async () => {
    const disputed = sale({ at: NOW - DAY, chargedback: true });
    const both = sale({ at: NOW - DAY, refunded: true, partiallyRefunded: true, refundable: '9' });
    const { res } = await revenue([salesRoute([disputed, both])], INCREMENTAL_SINCE);
    expect(res.events.filter((e) => e.type === 'refund').map((e) => e.amount)).toEqual([-1000, -1000]);
  });

  it('keeps merchant-of-record tax out and backs inclusive seller tax out of charges and refunds', async () => {
    const mor = clone(saleFx.sale); // docs: price 1000, tax_cents 125, tax_included_in_price false
    mor.created_at = iso(NOW - DAY);
    const inclusive = sale({ at: NOW - DAY, price: 1210, tax: 210, taxIncluded: true, partiallyRefunded: true, refundable: '6.05' });
    const { res } = await revenue([salesRoute([mor, inclusive])], INCREMENTAL_SINCE);
    expect(res.events.map((e) => [e.type, e.amount])).toEqual([
      ['charge', 1000],
      ['charge', 1000],
      ['refund', -500], // half of 1210 refunded → half of the 1000 net
    ]);
  });

  it('skips $0 sales (free products, trial sign-ups, bundle items) and gift copies', async () => {
    const { res, ctx } = await revenue(
      [salesRoute([sale({ at: NOW - DAY, price: 0 }), sale({ at: NOW - DAY, giftReceiver: true }), sale({ at: NOW - DAY, price: 300 })])],
      INCREMENTAL_SINCE,
    );
    expect(res.events.map((e) => e.amount)).toEqual([300]);
    expect(ctx.logs.find((l) => l.event === 'gumroad_revenue')?.data).toMatchObject({ skipped: 2 });
  });

  it('pages with page_key, pauses with a cursor when the budget runs out, and resumes with the same window', async () => {
    const a = sale({ at: NOW - DAY });
    const b = sale({ at: NOW - 2 * DAY });
    const c = sale({ at: NOW - 2.5 * DAY });
    const routes = [
      salesRoute([a], '20261104120000000000-111'),
      salesRoute([b], '20261103120000000000-222', { pageKey: '20261104120000000000-111' }),
      salesRoute([c], undefined, { pageKey: '20261103120000000000-222' }),
    ];
    const first = await revenue(routes, INCREMENTAL_SINCE, { pageBudget: 2 });
    expect(first.res.done).toBe(false);
    expect(first.res.events.map((e) => e.externalId)).toEqual([a.id, b.id]);
    const cursor = decodeCursor(first.res.nextCursor);
    expect(cursor).toEqual({
      v: 1,
      since: INCREMENTAL_SINCE,
      floor: INCREMENTAL_SINCE - REFUND_LOOKBACK_MS,
      pageKey: '20261103120000000000-222',
    });

    // Resumed a day later with a different `since`: the cursor's window wins.
    const { fetch, calls } = fakeFetch(routes);
    const later = await gumroadAdapter.fetchRevenue(input(), { since: NOW, cursor: first.res.nextCursor }, makeCtx(fetch, { now: NOW + DAY }));
    expect(later.done).toBe(true);
    expect(later.nextCursor).toBeNull();
    expect(later.events.map((e) => e.externalId)).toEqual([c.id]);
    expect(new URL(calls[0]!.url).searchParams.get('after')).toBe('2026-10-03');
  });

  it('returns its cursor without a request when there is no budget', async () => {
    const { res, calls } = await revenue([], INCREMENTAL_SINCE, { pageBudget: 0 });
    expect(calls).toHaveLength(0);
    expect(res).toMatchObject({ events: [], done: false });
    expect(decodeCursor(res.nextCursor)).toMatchObject({ pageKey: null, since: INCREMENTAL_SINCE });
  });

  it('keeps what it read and returns the unread page on a 429', async () => {
    const a = sale({ at: NOW - DAY });
    const { res, ctx } = await revenue(
      [salesRoute([a], 'pk-2'), route('/v2/sales', { status: 429, body: '' }, { query: { page_key: 'pk-2' } })],
      INCREMENTAL_SINCE,
    );
    expect(res.events.map((e) => e.externalId)).toEqual([a.id]);
    expect(res.done).toBe(false);
    expect(decodeCursor(res.nextCursor)?.pageKey).toBe('pk-2');
    expect(ctx.pageBudget).toBe(0);
    expect(ctx.logs.find((l) => l.event === 'gumroad_revenue')?.data).toMatchObject({ rateLimited: true });
  });

  it('restarts on an invalid cursor', async () => {
    const a = sale({ at: NOW - DAY });
    const { res, ctx, calls } = await revenue([salesRoute([a])], INCREMENTAL_SINCE, { cursor: '{"v":1,"since":1,"floor":2,"pageKey":null}' });
    expect(res.done).toBe(true);
    expect(calls).toHaveLength(1);
    expect(ctx.logs.some((l) => l.event === 'gumroad_cursor_invalid')).toBe(true);
  });

  it('validates cursors', () => {
    const ok = { v: 1 as const, since: INCREMENTAL_SINCE, floor: INCREMENTAL_SINCE - DAY, pageKey: '20230119081040000000-123456' };
    expect(decodeCursor(encodeCursor(ok))).toEqual(ok);
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('nope')).toBeNull();
    expect(decodeCursor(JSON.stringify({ ...ok, v: 2 }))).toBeNull();
    expect(decodeCursor(JSON.stringify({ ...ok, pageKey: 'a b' }))).toBeNull();
    expect(decodeCursor(JSON.stringify({ ...ok, floor: ok.since + 1 }))).toBeNull();
  });

  it('maps a missing view_sales scope to a permission error', async () => {
    const err = await catchErr(revenue([route('/v2/sales', { status: 403, body: '' })], INCREMENTAL_SINCE));
    expect(err.kind).toBe('permission');
    expect(err.message).toContain(PERM_SALES);
  });

  it('surfaces a sales query timeout (400) as an upstream error', async () => {
    const body = { status: 400, error: "Query timed out. Try narrowing your date range with 'after'/'before' or filtering by product_id." };
    const err = await catchErr(revenue([route('/v2/sales', { status: 400, json: body })], BACKFILL_SINCE));
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/Query timed out/);
  });
});
