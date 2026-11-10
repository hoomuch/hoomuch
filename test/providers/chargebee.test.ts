import { describe, expect, it } from 'vitest';
import { currencyExponent } from '../../src/lib/money';
import { BudgetExhaustedError } from '../../src/providers/http';
import {
  CHARGEBEE_PERMISSION,
  CHARGEBEE_SNAPSHOT_PAGE_BUDGET,
  LATE_SETTLEMENT_WINDOW_MS,
  chargebeeAdapter,
  chargebeeUnpricedItemsWarning,
  parseSite,
  toMinorUnits,
} from '../../src/providers/chargebee';
import { ProviderError } from '../../src/providers/types';
import { REVENUE_PAGE_BUDGET, SNAPSHOT_PAGE_BUDGET } from '../../src/sync/engine';
import { isStaleCursorError } from '../../src/sync/errors';
import { expectNoSecretsInLogs, expectSubscriptionsAddUp, fakeFetch, makeCtx, NOW, recordSleeps, route, type RecordedCall, type Route } from '../fixtures/harness';
// Sample objects from https://apidocs.chargebee.com/docs/api (API v2, Product Catalog 2.0), verbatim except that
// the docs' `{..}` elision placeholders were removed from the two list samples.
import subscriptionFx from '../fixtures/chargebee/subscription.json';
import listSubscriptionsFx from '../fixtures/chargebee/list_subscriptions.json';
import transactionFx from '../fixtures/chargebee/transaction.json';
import listTransactionsFx from '../fixtures/chargebee/list_transactions.json';
// Error bodies built from the documented attributes, codes and sample messages (docs/api/error-handling).
import errorAuthenticationFx from '../fixtures/chargebee/error_api_authentication_failed.json';
import errorAuthorizationFx from '../fixtures/chargebee/error_api_authorization_failed.json';
import errorSiteNotFoundFx from '../fixtures/chargebee/error_site_not_found.json';
import errorRequestBlockedFx from '../fixtures/chargebee/error_request_blocked.json';
import errorRateLimitFx from '../fixtures/chargebee/error_api_request_limit_exceeded.json';
import errorParamFx from '../fixtures/chargebee/error_param_wrong_value.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

const KEY = 'test_FakeChargebeeKeyForTestsOnly0123456789';
const LIVE_KEY = 'live_FakeChargebeeKeyForTestsOnly9876543210';
const SITE = 'acme-test';
const NOW_S = Math.floor(NOW / 1000);
const DAY_S = 86_400;
const PII = ['John', 'Doe', 'john.doe@example.com', '************1111', '__test__8asukSOXdvg4PD', '__test__KyVnHhSBWlv242pN'];

const input = (o: { site?: string; apiKey?: string } = {}) => ({
  credentials: { apiKey: o.apiKey ?? KEY },
  config: { site: o.site ?? SITE },
});

let seq = 0;
const nextId = (prefix: string) => `${prefix}Fake${(++seq).toString().padStart(4, '0')}`;

// ---------- subscriptions ----------

interface SubOpts {
  /** null → attribute absent. */
  mrr?: number | null;
  currency?: string;
  status?: string;
  deleted?: boolean;
  items?: Json[];
  period?: number;
  unit?: string;
}

function sub(o: SubOpts = {}): Json {
  const s = clone(subscriptionFx);
  s.id = nextId('__test__sub');
  s.status = o.status ?? 'active';
  s.currency_code = o.currency ?? 'USD';
  if (o.mrr === null) delete s.mrr;
  else s.mrr = o.mrr ?? 1000;
  if (o.deleted !== undefined) s.deleted = o.deleted;
  if (o.items) s.subscription_items = o.items;
  if (o.period !== undefined) s.billing_period = o.period;
  if (o.unit !== undefined) s.billing_period_unit = o.unit;
  return s;
}

function item(type: 'plan' | 'addon' | 'charge', amount: number | null, o: Json = {}): Json {
  const it = clone(subscriptionFx.subscription_items[0]);
  it.item_price_id = nextId('price-');
  it.item_type = type;
  if (amount === null) delete it.amount;
  else it.amount = amount;
  return { ...it, ...o };
}

/** A list entry the way Chargebee sends it: the subscription plus the customer (PII) and card. */
function entry(s: Json): Json {
  const e = clone(listSubscriptionsFx.list[0]);
  e.customer.email = 'john.doe@example.com';
  e.card = { object: 'card', first_name: 'John', last_name: 'Doe', masked_number: '************1111', customer_id: e.customer.id };
  e.subscription = s;
  return e;
}

function subList(subs: Json[], next?: string): Json {
  const l: Json = { list: subs.map(entry) };
  if (next) l.next_offset = next;
  return l;
}

// ---------- transactions ----------

function txn(id: string, type: string, status: string, amount: number, o: Json = {}): Json {
  return {
    ...clone(listTransactionsFx.list[0]!.transaction),
    id,
    type,
    status,
    amount,
    date: NOW_S - 3600,
    updated_at: NOW_S - 3600,
    ...o,
  };
}

function txnList(txns: Json[], next?: string): Json {
  const l: Json = { list: txns.map((t) => ({ transaction: t })) };
  if (next) l.next_offset = next;
  return l;
}

// ---------- assertions ----------

const pathOf = (c: RecordedCall) => new URL(c.url).pathname;
const params = (c: RecordedCall) => new URL(c.url).searchParams;

function expectChargebeeCalls(calls: RecordedCall[], key = KEY, site = SITE): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.method).toBe('GET');
    expect(c.url.startsWith(`https://${site}.chargebee.com/api/v2/`)).toBe(true);
    expect(c.headers['authorization']).toBe(`Basic ${btoa(`${key}:`)}`);
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

// ---------- helpers ----------

describe('chargebee parseSite', () => {
  it.each([
    ['acme', 'acme', false],
    ['acme-test', 'acme-test', true],
    ['  ACME-Test ', 'acme-test', true],
    ['acme.chargebee.com', 'acme', false],
    ['https://acme-test.chargebee.com/', 'acme-test', true],
    ['https://acme.chargebee.com/d/subscriptions?x=1', 'acme', false],
    ['my-company-2', 'my-company-2', false],
  ])('reduces %j to the site name', (raw, site, testMode) => {
    expect(parseSite(raw)).toEqual({ site, testMode });
  });

  it.each([
    '',
    '   ',
    'acme.evil.com',
    'evil.com/acme.chargebee.com',
    'acme.chargebee.com.evil.com',
    'acme.chargebee.com.',
    'acme@evil.com',
    'user:pw@acme.chargebee.com',
    'acme.chargebee.com:443',
    'acme chargebee',
    'acme%2eevil',
    'acme#.chargebee.com',
    '-acme',
    'acme-',
    'a'.repeat(64),
    'localhost:8787',
    '127.0.0.1',
  ])('rejects %j (it could change the host)', (raw) => {
    expect(parseSite(raw)).toHaveProperty('error');
  });
});

describe('chargebee toMinorUnits', () => {
  it('keeps two-decimal and zero-decimal currencies as Chargebee sends them', () => {
    expect(toMinorUnits(1395, 'USD')).toBe(1395);
    expect(toMinorUnits(1395, 'eur')).toBe(1395);
    expect(toMinorUnits(1500, 'JPY')).toBe(1500); // zero-decimal in both
    expect(toMinorUnits(15000, 'KRW')).toBe(15000);
  });

  it('rescales only where Chargebee and ISO 4217 minor units disagree', () => {
    // HUF / IDR / COP / PKR: two decimals in both, so Chargebee's cents pass through (12,500.00 Ft).
    for (const cur of ['HUF', 'IDR', 'COP', 'PKR']) expect(toMinorUnits(1250000, cur)).toBe(1250000);
    expect(toMinorUnits(5000, 'MGA')).toBe(500000); // Chargebee zero-decimal, ISO 2
    expect(toMinorUnits(150000, 'CLF')).toBe(15000000); // Chargebee cents, ISO 4
    expect(toMinorUnits(100, 'ISK')).toBe(100); // zero-decimal in both
    expect(currencyExponent('HUF')).toBe(2);
  });
});

// ---------- verify ----------

describe('chargebee verify', () => {
  const okRoutes = () => [
    route('/api/v2/subscriptions', { json: clone(listSubscriptionsFx) }, { query: { limit: '1' } }),
    route('/api/v2/transactions', { json: clone(listTransactionsFx) }, { query: { limit: '1' } }),
  ];

  it.each(['', 'acme.evil.com', 'evil.com/x', 'acme@evil.com', '-acme'])('rejects site %j on the site field without a network call', async (site) => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await chargebeeAdapter.verify(input({ site }), makeCtx(fetch));
    expect(res).toEqual({ ok: false, field: 'site', error: expect.stringMatching(/part before \.chargebee\.com/) });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['too short', 'abc'],
    ['inner whitespace', 'test_Fake Key0123456789'],
    ['header pasted', 'Basic dGVzdF9GYWtlOg=='],
    ['user:password', 'test_FakeKey0123456789:secret'],
    ['non-ASCII', 'test_FakeKëy0123456789'],
  ])('rejects a %s key on the apiKey field without a network call', async (_label, apiKey) => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await chargebeeAdapter.verify(input({ apiKey }), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error.length).toBeGreaterThan(10);
    expect(calls).toHaveLength(0);
  });

  it('accepts a test-site key with 2 authenticated reads on that site only', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const res = await chargebeeAdapter.verify(input({ apiKey: `  ${KEY}  ` }), ctx);
    expect(res).toEqual({ ok: true, accountLabel: 'Chargebee: acme (test)', config: { site: 'acme-test' }, testMode: true, warnings: [] });
    expect(calls.map(pathOf)).toEqual(['/api/v2/subscriptions', '/api/v2/transactions']);
    expectChargebeeCalls(calls);
    expect(ctx.pageBudget).toBe(3);
    expectNoSecretsInLogs(ctx, [KEY, btoa(`${KEY}:`), ...PII]);
  });

  it('stores the bare site name when a live site URL is pasted, and drops a trailing colon from the key', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await chargebeeAdapter.verify(input({ site: 'https://Acme.chargebee.com/', apiKey: `${LIVE_KEY}:` }), makeCtx(fetch));
    expect(res).toEqual({ ok: true, accountLabel: 'Chargebee: acme', config: { site: 'acme' }, testMode: false, warnings: [] });
    expectChargebeeCalls(calls, LIVE_KEY, 'acme');
  });

  it('reports a rejected key (401) on the apiKey field after one request', async () => {
    const { fetch, calls } = fakeFetch([route('/api/v2/subscriptions', { status: 401, json: errorAuthenticationFx })]);
    const ctx = makeCtx(fetch);
    const res = await chargebeeAdapter.verify(input(), ctx);
    expect(res).toEqual({ ok: false, field: 'apiKey', error: expect.stringMatching(/rejected this key for the site “acme-test”.*test and live sites/) });
    expect(calls).toHaveLength(1);
    expectNoSecretsInLogs(ctx, [KEY, btoa(`${KEY}:`)]);
  });

  it('names the missing transactional-data access when transactions are forbidden (403)', async () => {
    const { fetch } = fakeFetch([
      route('/api/v2/subscriptions', { json: clone(listSubscriptionsFx) }),
      route('/api/v2/transactions', { status: 403, json: errorAuthorizationFx }),
    ]);
    const res = await chargebeeAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({
      ok: false,
      field: 'apiKey',
      error: `The Chargebee key can’t read transactions. Use a read-only key with access to all resources, or a restricted one with “${CHARGEBEE_PERMISSION}” ticked.`,
    });
  });

  it('names subscriptions when the first probe is forbidden, without reading transactions', async () => {
    const { fetch, calls } = fakeFetch([route('/api/v2/subscriptions', { status: 403, json: errorAuthorizationFx }), ...okRoutes()]);
    const res = await chargebeeAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({ ok: false, field: 'apiKey', error: expect.stringMatching(/^The Chargebee key can’t read subscriptions\./) });
    expect(calls.map(pathOf)).toEqual(['/api/v2/subscriptions']);
  });

  it.each([
    ['site_not_found (404)', { status: 404, json: errorSiteNotFoundFx }],
    ['a bare 404', { status: 404, body: '<html>Not found</html>', headers: { 'content-type': 'text/html' } }],
    ['a redirect', { status: 302, body: '', headers: { location: 'https://www.chargebee.com/' } }],
  ])('reports an unknown site on the site field (%s)', async (_label, response) => {
    const { fetch, calls } = fakeFetch([route('/api/v2/subscriptions', response)]);
    const res = await chargebeeAdapter.verify(input({ site: 'acme' }), makeCtx(fetch));
    expect(res).toEqual({ ok: false, field: 'site', error: expect.stringMatching(/no site called “acme”/) });
    expect(calls).toHaveLength(1);
  });

  it('throws a blocked site (request_blocked) and 5xx for the caller to describe', async () => {
    const blocked = fakeFetch([route('/api/v2/subscriptions', { status: 403, json: errorRequestBlockedFx })]);
    const err = await catchErr(chargebeeAdapter.verify(input(), makeCtx(blocked.fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/blocking API requests/);

    const down = fakeFetch([route('/api/v2/subscriptions', { status: 503, json: { message: 'down', api_error_code: 'internal_temporary_error' } })]);
    expect((await catchErr(chargebeeAdapter.verify(input(), makeCtx(down.fetch)))).kind).toBe('upstream');
  });
});

// ---------- snapshot ----------

const ACTIVE = { 'status[in]': '["active","non_renewing"]', limit: '100' };
const TRIALS = { 'status[is]': 'in_trial', limit: '100' };

interface SnapshotSetup {
  active?: Json[];
  trials?: Json[];
  /** Matched before the defaults. */
  extra?: Route[];
  budget?: number;
}

function snapshotRoutes(s: SnapshotSetup): Route[] {
  return [
    ...(s.extra ?? []),
    route('/api/v2/subscriptions', { json: subList(s.active ?? []) }, { query: ACTIVE, absent: ['offset'] }),
    route('/api/v2/subscriptions', { json: subList(s.trials ?? []) }, { query: TRIALS, absent: ['offset'] }),
  ];
}

async function snapshot(s: SnapshotSetup) {
  const { fetch, calls } = fakeFetch(snapshotRoutes(s));
  const ctx = makeCtx(fetch, { pageBudget: s.budget ?? 30 });
  const snap = await chargebeeAdapter.fetchSnapshot(input(), ctx);
  return { snap, ctx, calls };
}

describe('chargebee fetchSnapshot', () => {
  it('sums Chargebee’s own MRR per currency over active + non_renewing, skipping $0 subscriptions', async () => {
    const { snap, ctx, calls } = await snapshot({
      active: [
        sub({ mrr: 4900 }),
        sub({ mrr: 1000, status: 'non_renewing' }), // cancels at term end: still MRR
        sub({ mrr: 2500, currency: 'EUR' }),
        sub({ mrr: 1500, currency: 'JPY' }), // zero-decimal: ¥1,500
        sub({ mrr: 1250000, currency: 'HUF' }), // 12,500.00 Ft in Chargebee cents
        sub({ mrr: 0 }), // free plan / 100% discount: neither MRR nor an active subscription
      ],
      trials: [sub({ status: 'in_trial', mrr: 0 }), sub({ status: 'in_trial', mrr: 0 })],
    });
    expect(snap).toEqual({
      mrr: { USD: 5900, EUR: 2500, JPY: 1500, HUF: 1250000 }, // HUF: 12,500.00 Ft, two ISO decimals (fillér)
      activeSubscriptions: 5,
      activeTrials: 2,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      subscriptions: expect.any(Array),
    });
    expectSubscriptionsAddUp(snap);
    expect(calls.map((c) => [params(c).get('status[in]'), params(c).get('status[is]')])).toEqual([
      ['["active","non_renewing"]', null],
      [null, 'in_trial'],
    ]);
    expectChargebeeCalls(calls);
    expect(ctx.logs.find((l) => l.event === 'chargebee_snapshot')?.data).toEqual({
      subscriptions: 5,
      trials: 2,
      zeroMrr: 1,
      skipped: 0,
      currencies: ['USD', 'EUR', 'JPY', 'HUF'],
    });
    expect(JSON.stringify(snap)).not.toMatch(/John|Doe|example\.com/);
    expectNoSecretsInLogs(ctx, [KEY, btoa(`${KEY}:`), ...PII]);
  });

  it('counts dunning subscriptions (active with unpaid invoices) like Stripe’s past_due', async () => {
    const dunning = sub({ mrr: 3000 });
    dunning['due_invoices_count'] = 2;
    dunning['total_dues'] = 6000;
    const { snap } = await snapshot({ active: [dunning] });
    expect(snap.mrr).toEqual({ USD: 3000 });
    expect(snap.activeSubscriptions).toBe(1);
  });

  it('computes MRR from items only when a subscription has no mrr attribute', async () => {
    const { snap, ctx } = await snapshot({
      active: [
        // monthly plan 1000 + addon 500; the one-time charge item is not recurring → 1500
        sub({ mrr: null, items: [item('plan', 1000), item('addon', 500), item('charge', 9900)] }),
        // yearly → 12000 / 12 = 1000
        sub({ mrr: null, unit: 'year', period: 1, items: [item('plan', 12000)] }),
        // every 3 months → 3000 / 3 = 1000
        sub({ mrr: null, unit: 'month', period: 3, items: [item('plan', 3000)] }),
        // weekly → 500 × 52/12 = 2166.67 → 2167
        sub({ mrr: null, unit: 'week', period: 1, items: [item('plan', 500)] }),
        // multi-frequency billing: the item's own period wins → 1000 + 24000/12 = 3000
        sub({ mrr: null, items: [item('plan', 1000), item('addon', 24000, { billing_period: 1, billing_period_unit: 'year' })] }),
        // an addon still in its item trial is left out → 2000
        sub({ mrr: null, items: [item('plan', 2000), item('addon', 700, { trial_end: NOW_S + 7 * DAY_S })] }),
        // multi-decimal pricing: amount_in_decimal (major units) → 1250; unit_price × quantity → 2100
        sub({ mrr: null, items: [item('plan', null, { amount_in_decimal: '12.50' })] }),
        sub({ mrr: null, items: [item('plan', null, { unit_price: 700, quantity: 3 })] }),
        // Product Catalog 1.0 shape: plan_amount + addons → 2500
        { ...sub({ mrr: null, items: [] }), plan_amount: 2000, addons: [{ id: 'extra', quantity: 1, unit_price: 500, amount: 500 }] },
        // free plan → $0, excluded
        sub({ mrr: null, items: [item('plan', 0)] }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 1500 + 1000 + 1000 + 2167 + 3000 + 2000 + 1250 + 2100 + 2500 });
    expect(snap.activeSubscriptions).toBe(9);
    expect(ctx.logs.find((l) => l.event === 'chargebee_mrr_computed')?.data).toEqual({ subscriptions: 10 });
    expect(ctx.logs.some((l) => l.event === 'chargebee_items_unpriced')).toBe(false);
    expect(snap.warnings).toBeUndefined(); // computing from items is logged, not shown
  });

  it('trusts mrr = 0 over the item prices (a 100% discount) and logs items it can’t price', async () => {
    const { snap, ctx } = await snapshot({
      active: [
        sub({ mrr: 0, items: [item('plan', 5000)] }),
        sub({ mrr: null, unit: 'fortnight', items: [item('plan', 5000)] }),
        sub({ mrr: null, items: [item('plan', null, { unit_price: undefined })] }),
      ],
    });
    // toEqual: `mrr: {}` inside toMatchObject would accept any map, e.g. { USD: 5000 } from the item price.
    expect(snap.mrr).toEqual({});
    expect(snap.activeSubscriptions).toBe(0);
    expect(ctx.logs.find((l) => l.event === 'chargebee_items_unpriced')?.data).toEqual({ items: 2 });
  });

  it('warns, with a count, about the items it can’t price, and only then', async () => {
    const healthy = await snapshot({ active: [sub({ mrr: 4900 })], trials: [sub({ status: 'in_trial', mrr: 0 })] });
    expect(healthy.snap.warnings).toBeUndefined();

    const { snap, ctx } = await snapshot({
      active: [
        sub({ mrr: 4900 }),
        sub({ mrr: null, unit: 'fortnight', items: [item('plan', 5000)] }),
        sub({ mrr: null, items: [item('plan', null, { unit_price: undefined }), item('addon', 300)] }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 4900 + 300 });
    expect(snap.warnings).toEqual([chargebeeUnpricedItemsWarning(2)]);
    expect(snap.warnings![0]).toBe('2 subscription items have no amount or billing period hoomuch can read, so they count as 0 in MRR.');
    expect(chargebeeUnpricedItemsWarning(1)).toBe('1 subscription item has no amount or billing period hoomuch can read, so it counts as 0 in MRR.');
    expect(chargebeeUnpricedItemsWarning(100_000).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(snap)).not.toMatch(/John|Doe|example\.com/);
    expectNoSecretsInLogs(ctx, [KEY, btoa(`${KEY}:`), ...PII]);
  });

  it('warns about a single item it can’t price, in the singular', async () => {
    const { snap } = await snapshot({
      active: [sub({ mrr: 4900 }), sub({ mrr: null, unit: 'fortnight', items: [item('plan', 5000)] })],
    });
    expect(snap.mrr).toEqual({ USD: 4900 });
    expect(snap.warnings).toEqual([chargebeeUnpricedItemsWarning(1)]);
    expect(snap.warnings).toEqual(['1 subscription item has no amount or billing period hoomuch can read, so it counts as 0 in MRR.']);
  });

  it('trusts the object over the filter (lists are eventually consistent)', async () => {
    const { snap, ctx } = await snapshot({
      active: [sub({ mrr: 1000 }), sub({ mrr: 9000, status: 'cancelled' }), sub({ mrr: 9000, status: 'in_trial' }), sub({ mrr: 9000, deleted: true }), sub({ mrr: 9000, currency: '' })],
      trials: [sub({ status: 'in_trial' }), sub({ status: 'active' })],
    });
    expect(snap.mrr).toEqual({ USD: 1000 });
    expect(snap).toMatchObject({ activeSubscriptions: 1, activeTrials: 1 });
    expect(ctx.logs.find((l) => l.event === 'chargebee_snapshot')?.data).toMatchObject({ skipped: 4 });
  });

  it('pages with limit=100 and next_offset', async () => {
    const offset = '["1612890918000","230000000081"]';
    const { snap, calls } = await snapshot({
      extra: [
        route('/api/v2/subscriptions', { json: subList([sub({ mrr: 1000 }), sub({ mrr: 2000 })], offset) }, { query: ACTIVE, absent: ['offset'] }),
        route('/api/v2/subscriptions', { json: subList([sub({ mrr: 3000 })]) }, { query: { ...ACTIVE, offset } }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 6000 });
    expect(snap.activeSubscriptions).toBe(3);
    expect(calls).toHaveLength(3);
    expect(params(calls[1]!).get('offset')).toBe(offset);
    expect(params(calls[2]!).get('status[is]')).toBe('in_trial');
  });

  it('lets BudgetExhaustedError propagate instead of returning a partial MRR', async () => {
    const { fetch, calls } = fakeFetch([
      route('/api/v2/subscriptions', { json: subList([sub()], '["1","2"]') }, { query: ACTIVE, absent: ['offset'] }),
      ...snapshotRoutes({}),
    ]);
    const err = await catchErr(chargebeeAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 1 })));
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toHaveLength(1);
  });

  it(`stops after ${CHARGEBEE_SNAPSHOT_PAGE_BUDGET} requests whatever the sync allows, so one sync stays under 150 a minute`, async () => {
    let page = 0;
    const { fetch, calls } = fakeFetch([
      route('/api/v2/subscriptions', () => ({ json: subList([sub()], JSON.stringify([String(++page), '1'])) }), { query: ACTIVE }),
    ]);
    const err = await catchErr(chargebeeAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: SNAPSHOT_PAGE_BUDGET })));
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).reason).toBe('budget');
    expect(calls).toHaveLength(CHARGEBEE_SNAPSHOT_PAGE_BUDGET);
    // With the revenue phase right after it, at most 3/4 of the Starter and test-site limit the merchant shares.
    expect(CHARGEBEE_SNAPSHOT_PAGE_BUDGET + REVENUE_PAGE_BUDGET).toBeLessThanOrEqual(0.75 * 150);
  });

  it('refuses a next_offset that doesn’t move', async () => {
    const { fetch, calls } = fakeFetch([
      route('/api/v2/subscriptions', { json: subList([sub()], '["1","2"]') }, { query: ACTIVE }),
      ...snapshotRoutes({}),
    ]);
    const err = await catchErr(chargebeeAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'upstream', message: expect.stringMatching(/couldn’t read/) });
    expect(calls).toHaveLength(2); // the second page repeats the offset: stop there, not at the budget
  });

  it.each([
    ['a body without `list`', { api_version: 'v2' }],
    ['a numeric next_offset', { list: [], next_offset: 12 }],
    ['an empty next_offset', { list: [], next_offset: '' }],
  ])('refuses %s instead of reporting a partial or zero MRR', async (_label, body) => {
    const { fetch } = fakeFetch(snapshotRoutes({ extra: [route('/api/v2/subscriptions', { json: body }, { query: ACTIVE })] }));
    const err = await catchErr(chargebeeAdapter.fetchSnapshot(input(), makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'upstream', message: expect.stringMatching(/couldn’t read/) });
  });

  it('retries a 429 after Retry-After (snapshots aren’t resumable)', async () => {
    const sleeps = recordSleeps();
    const { snap } = await snapshot({
      extra: [
        route('/api/v2/subscriptions', [{ status: 429, json: errorRateLimitFx, headers: { 'retry-after': '2' } }, { json: subList([sub({ mrr: 700 })]) }], {
          query: ACTIVE,
        }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 700 });
    expect(sleeps).toEqual([2000]);
    recordSleeps();
  });

  it.each([
    ['site', input({ site: 'evil.com/x' })],
    ['apiKey', input({ apiKey: 'not a key' })],
  ])('refuses a malformed stored %s without a network call', async (field, conn) => {
    const { fetch, calls } = fakeFetch(snapshotRoutes({}));
    const err = await catchErr(chargebeeAdapter.fetchSnapshot(conn, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'invalid_input', field });
    expect(calls).toHaveLength(0);
  });
});

// ---------- revenue ----------

const SINCE = NOW - 90 * DAY_S * 1000;
const SINCE_S = Math.floor(SINCE / 1000);
const LATE_S = LATE_SETTLEMENT_WINDOW_MS / 1000;
const WINDOW = {
  'type[in]': '["payment","refund","payment_reversal"]',
  'updated_at[between]': `[${SINCE_S},${NOW_S}]`,
  'date[after]': String(SINCE_S - LATE_S - 1),
  'sort_by[asc]': 'updated_at',
  limit: '100',
};

describe('chargebee fetchRevenue', () => {
  it('maps payments, refunds, reversals and late failures, and drops everything else', async () => {
    const t = NOW_S - 3600;
    const data = [
      txn('txn_FakePay', 'payment', 'success', 4900, { date: t }),
      txn('txn_FakeRefund', 'refund', 'success', 1000, { date: t - 1, refunded_txn_id: 'txn_FakePay' }),
      txn('txn_FakeReversal', 'payment_reversal', 'success', 2000, { date: t - 2, reference_transaction_id: 'txn_FakeCheck' }),
      // succeeded on day 1, returned by the bank later (dunning for late failures on): charge + reversal
      txn('txn_FakeLate', 'payment', 'late_failure', 3000, { date: t - 10 * DAY_S, updated_at: t - 3 }),
      // a direct debit dated before `since` that settled inside the window still counts, at its date
      txn('txn_FakeSlowDD', 'payment', 'success', 1500, { date: SINCE_S - 5 * DAY_S, updated_at: t - 4, payment_method: 'direct_debit' }),
      txn('txn_FakeYen', 'payment', 'success', 1500, { date: t - 5, currency_code: 'JPY' }),
      txn('txn_FakeForint', 'payment', 'success', 1250000, { date: t - 6, currency_code: 'HUF' }),
      txn('txn_FakePending', 'payment', 'in_progress', 800, { date: t - 7 }),
      txn('txn_FakeFailed', 'payment', 'failure', 800, { date: t - 8, error_text: 'Card declined for john.doe@example.com' }),
      txn('txn_FakeVoided', 'payment', 'voided', 800, { date: t - 9 }),
      txn('txn_FakeNeedsAttention', 'payment', 'needs_attention', 800, { date: t - 10 }),
      txn('txn_FakeRefundPending', 'refund', 'in_progress', 300, { date: t - 11 }),
      { ...clone(transactionFx), date: t - 12, updated_at: t - 12 }, // docs example: an authorization
      txn('txn_FakeZero', 'payment', 'success', 0, { date: t - 13 }),
      txn('txn_FakeDeleted', 'payment', 'success', 900, { date: t - 14, deleted: true }),
    ];
    const { fetch, calls } = fakeFetch([route('/api/v2/transactions', { json: txnList(data) }, { query: WINDOW, absent: ['offset'] })]);
    const ctx = makeCtx(fetch, { pageBudget: 20 });
    const page = await chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);

    const ev = (externalId: string, at: number, type: 'charge' | 'refund', amount: number, currency = 'USD') => ({
      externalId,
      occurredAt: at * 1000,
      type,
      amount,
      currency,
      fee: null,
      description: null,
    });
    expect(page).toEqual({
      events: [
        ev('txn_FakePay', t, 'charge', 4900),
        ev('txn_FakeRefund', t - 1, 'refund', -1000),
        ev('txn_FakeReversal', t - 2, 'refund', -2000),
        ev('txn_FakeLate', t - 10 * DAY_S, 'charge', 3000),
        ev('txn_FakeLate:late_failure', t - 3, 'refund', -3000),
        ev('txn_FakeSlowDD', SINCE_S - 5 * DAY_S, 'charge', 1500),
        ev('txn_FakeYen', t - 5, 'charge', 1500, 'JPY'),
        ev('txn_FakeForint', t - 6, 'charge', 1250000, 'HUF'), // 12,500.00 Ft: Chargebee cents = ISO minor units
      ],
      daily: [],
      nextCursor: null,
      done: true,
    });
    expectChargebeeCalls(calls);
    expect(JSON.stringify(page)).not.toMatch(/example\.com|\*{4}|__test__KyVn/);
    expectNoSecretsInLogs(ctx, [KEY, btoa(`${KEY}:`), ...PII]);
    expect(ctx.logs.find((l) => l.event === 'chargebee_revenue_done')?.data).toEqual({
      pages: 1,
      events: 8,
      ignored: {
        'payment:in_progress': 1,
        'payment:failure': 1,
        'payment:voided': 1,
        'payment:needs_attention': 1,
        'refund:in_progress': 1,
        'authorization:success': 1,
        'payment:success': 2,
      },
    });
  });

  it('resumes from its cursor when pageBudget runs out, with the window frozen', async () => {
    const o1 = '["1762340000000","100"]';
    const o2 = '["1762340500000","200"]';
    const p1 = [txn('txn_Fake1', 'payment', 'success', 100), txn('txn_Fake2', 'payment', 'success', 200)];
    const p2 = [txn('txn_Fake3', 'refund', 'success', 50)];
    const p3 = [txn('txn_Fake4', 'payment', 'success', 400)];
    const routes = () => [
      route('/api/v2/transactions', { json: txnList(p1, o1) }, { query: WINDOW, absent: ['offset'] }),
      route('/api/v2/transactions', { json: txnList(p2, o2) }, { query: { ...WINDOW, offset: o1 } }),
      route('/api/v2/transactions', { json: txnList(p3) }, { query: { ...WINDOW, offset: o2 } }),
    ];

    const first = fakeFetch(routes());
    const r1 = await chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(first.fetch, { pageBudget: 2 }));
    expect(r1).toMatchObject({ daily: [], done: false, nextCursor: expect.any(String) });
    expect(r1.events.map((e) => e.externalId)).toEqual(['txn_Fake1', 'txn_Fake2', 'txn_Fake3']);
    expect(first.calls).toHaveLength(2);

    // An hour later, with a different `since` from the engine: the cursor's window wins.
    const second = fakeFetch(routes());
    const ctx2 = makeCtx(second.fetch, { pageBudget: 20, now: NOW + 3_600_000 });
    const r2 = await chargebeeAdapter.fetchRevenue(input(), { since: SINCE + 86_400_000, cursor: r1.nextCursor }, ctx2);
    expect(r2).toMatchObject({ done: true, nextCursor: null });
    expect(r2.events.map((e) => e.externalId)).toEqual(['txn_Fake4']);
    expect(second.calls).toHaveLength(1);
    expectChargebeeCalls([...first.calls, ...second.calls]);
  });

  it('yields on 429: keeps what it read, empties the budget and returns its cursor', async () => {
    const sleeps = recordSleeps();
    const o1 = '["1762340000000","100"]';
    const { fetch, calls } = fakeFetch([
      route('/api/v2/transactions', { json: txnList([txn('txn_Fake1', 'payment', 'success', 100)], o1) }, { query: WINDOW, absent: ['offset'] }),
      route('/api/v2/transactions', { status: 429, json: errorRateLimitFx, headers: { 'retry-after': '30' } }, { query: { ...WINDOW, offset: o1 } }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 20 });
    const r = await chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(r).toMatchObject({ done: false, nextCursor: expect.any(String) });
    expect(r.events.map((e) => e.externalId)).toEqual(['txn_Fake1']);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    expect(ctx.pageBudget).toBe(0);
    expect(ctx.logs.find((l) => l.event === 'chargebee_revenue_paused')?.data).toMatchObject({ reason: 'rate_limit' });

    const resumed = fakeFetch([route('/api/v2/transactions', { json: txnList([txn('txn_Fake2', 'payment', 'success', 200)]) }, { query: { ...WINDOW, offset: o1 } })]);
    const r2 = await chargebeeAdapter.fetchRevenue(input(), { since: 0, cursor: r.nextCursor }, makeCtx(resumed.fetch));
    expect(r2.events.map((e) => e.externalId)).toEqual(['txn_Fake2']);
    expect(r2.done).toBe(true);
    recordSleeps();
  });

  it('returns a cursor without calling Chargebee when no budget is left', async () => {
    const { fetch, calls } = fakeFetch([]);
    const r = await chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch, { pageBudget: 0 }));
    expect(r).toMatchObject({ events: [], daily: [], done: false });
    expect(calls).toHaveLength(0);

    const later = fakeFetch([route('/api/v2/transactions', { json: txnList([]) }, { query: WINDOW, absent: ['offset'] })]);
    const r2 = await chargebeeAdapter.fetchRevenue(input(), { since: 0, cursor: r.nextCursor }, makeCtx(later.fetch, { now: NOW + 999_000 }));
    expect(r2).toEqual({ events: [], daily: [], nextCursor: null, done: true });
  });

  it('restarts from `since` when handed a cursor it did not write', async () => {
    const { fetch, calls } = fakeFetch([route('/api/v2/transactions', { json: txnList([]) }, { query: WINDOW, absent: ['offset'] })]);
    const ctx = makeCtx(fetch);
    for (const cursor of ['not json', '{"v":2}', '{"v":1,"from":5,"to":1,"dateFrom":0,"offset":null}', `{"v":1,"from":1,"to":2,"dateFrom":0,"offset":"${'x'.repeat(1001)}"}`]) {
      const r = await chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor }, ctx);
      expect(r.done).toBe(true);
    }
    expect(calls).toHaveLength(4);
    expect(ctx.logs.filter((l) => l.event === 'chargebee_cursor_invalid')).toHaveLength(4);
  });

  it('surfaces a rejected offset as a stale-cursor error for the engine', async () => {
    const cursor = JSON.stringify({ v: 1, from: SINCE_S, to: NOW_S, dateFrom: SINCE_S - LATE_S, offset: '["gone","1"]' });
    const { fetch } = fakeFetch([route('/api/v2/transactions', { status: 400, json: errorParamFx })]);
    const err = await catchErr(chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'upstream', status: 400 });
    expect(isStaleCursorError(err)).toBe(true);
  });

  it('books a late failure without updated_at at the payment’s own date (still nets to zero)', async () => {
    const t = NOW_S - 3600;
    const late = txn('txn_FakeLateNoUpdate', 'payment', 'late_failure', 2500, { date: t });
    delete late.updated_at;
    const backwards = txn('txn_FakeLateBackwards', 'payment', 'late_failure', 700, { date: t, updated_at: t - 10 });
    const { fetch } = fakeFetch([route('/api/v2/transactions', { json: txnList([late, backwards]) }, { query: WINDOW })]);
    const page = await chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch));
    expect(page.events.map((e) => [e.externalId, e.occurredAt / 1000, e.amount])).toEqual([
      ['txn_FakeLateNoUpdate', t, 2500],
      ['txn_FakeLateNoUpdate:late_failure', t, -2500],
      ['txn_FakeLateBackwards', t, 700],
      ['txn_FakeLateBackwards:late_failure', t, -700], // an updated_at before the date is not trusted
    ]);
    expect(page.events.reduce((s, e) => s + e.amount, 0)).toBe(0);
  });

  it('refuses a transactions next_offset that doesn’t move (no infinite loop until the budget)', async () => {
    const o1 = '["1762340000000","100"]';
    const { fetch, calls } = fakeFetch([
      route('/api/v2/transactions', { json: txnList([txn('txn_Fake1', 'payment', 'success', 100)], o1) }, { query: WINDOW, absent: ['offset'] }),
      route('/api/v2/transactions', { json: txnList([txn('txn_Fake2', 'payment', 'success', 200)], o1) }, { query: { ...WINDOW, offset: o1 } }),
    ]);
    const err = await catchErr(chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch, { pageBudget: 20 })));
    expect(err).toMatchObject({ kind: 'upstream', message: expect.stringMatching(/couldn’t read/) });
    expect(calls).toHaveLength(2);
  });

  it('throws a key revoked after connecting (401) on the apiKey field instead of pausing', async () => {
    const { fetch } = fakeFetch([route('/api/v2/transactions', { status: 401, json: errorAuthenticationFx })]);
    const err = await catchErr(chargebeeAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'auth', status: 401, field: 'apiKey' });
  });

  it('refuses a malformed key without a network call', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await catchErr(chargebeeAdapter.fetchRevenue(input({ apiKey: 'nope' }), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'invalid_input', field: 'apiKey' });
    expect(calls).toHaveLength(0);
  });
});
