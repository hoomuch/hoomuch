import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError, RateLimitedError } from '../../src/providers/http';
import {
  DISCOUNTS_WARNING,
  PADDLE_API_VERSION,
  PADDLE_COUNT_CAPPED_WARNING,
  PADDLE_DISCOUNTS_WARNING,
  PADDLE_METRICS_PERMISSION_WARNING,
  PADDLE_METRICS_UNAVAILABLE_WARNING,
  PADDLE_SNAPSHOT_PAGE_BUDGET,
  REFUND_LOOKBACK_MS,
  REJECTED_KEY_MESSAGE,
  paddleAdapter,
  paddleDiscountsUnresolvedWarning,
  paddleUnpricedItemsWarning,
} from '../../src/providers/paddle';
import { ProviderError } from '../../src/providers/types';
import { REVENUE_PAGE_BUDGET, SNAPSHOT_PAGE_BUDGET } from '../../src/sync/engine';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, NOW, route, type RecordedCall, type Route } from '../fixtures/harness';
// Verbatim example responses from https://developer.paddle.com/api-reference (Paddle-Version 1), read 2026-11-05.
import apiRootFx from '../fixtures/paddle/api-root.json';
import metricsMrrFx from '../fixtures/paddle/metrics-mrr.json';
import subscriptionsFx from '../fixtures/paddle/subscriptions.json';
import transactionsFx from '../fixtures/paddle/transactions.json';
import adjustmentsFx from '../fixtures/paddle/adjustments.json';
import discountsFx from '../fixtures/paddle/discounts.json';
import errorInvalidTokenFx from '../fixtures/paddle/error-invalid-token.json';
import errorForbiddenFx from '../fixtures/paddle/error-forbidden.json';
import errorTooManyRequestsFx from '../fixtures/paddle/error-too-many-requests.json';
import errorNotInSandboxFx from '../fixtures/paddle/error-not-available-in-sandbox.json';
import errorBillingNotEnabledFx from '../fixtures/paddle/error-paddle-billing-not-enabled.json';

// Variations are deep clones of the docs objects with a few fields overridden, so every payload keeps the
// documented shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

// The example keys printed on Paddle's Authentication page (not real keys).
const LIVE_KEY = 'pdl_live_apikey_01gtgztp8f4kek3yd4g1wrksa3_q6TGTJyvoIz7LDtXT65bX7_AQO';
const SANDBOX_KEY = 'pdl_sdbx_apikey_01gtgztp8f4kek3yd4g1wrksa3_q6TGTJyvoIz7LDtXT65bX7_AQO';
const LEGACY_KEY = 'da3f01dbed7a549cf0d8eb454bf5fded90d021f9975eba5cae';
const input = (apiKey = LIVE_KEY) => ({ credentials: { apiKey }, config: {} });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
/** A Paddle-shaped ID: prefix + 26 lowercase letters/digits. */
const pid = (prefix: string) => `${prefix}_01fake${String(++seq).padStart(20, '0')}`;

const ALL_READ = ['subscription.read', 'transaction.read', 'adjustment.read', 'metrics.read', 'discount.read'];

function root(permissions: string[], o: { name?: string; environment?: string } = {}): Json {
  const r = clone(apiRootFx);
  r.data.api.environment = o.environment ?? 'production';
  r.data.caller.auth_type = 'api_key';
  r.data.caller.account = { id: 'slr_01k1e8w9df9pz73s399svdkxtg', name: o.name ?? 'AeroEdit' };
  r.data.caller.permissions = permissions;
  return r;
}

function list(data: Json[], o: { hasMore?: boolean; total?: number; perPage?: number; path?: string } = {}): Json {
  const meta = clone(subscriptionsFx.meta);
  const last = data[data.length - 1];
  meta.pagination = {
    per_page: o.perPage ?? 50,
    next: `https://api.paddle.com${o.path ?? '/subscriptions'}?after=${last ? last['id'] : ''}`,
    has_more: o.hasMore ?? false,
    estimated_total: o.total ?? data.length,
  };
  return { data, meta };
}

function expectPaddleHeaders(calls: RecordedCall[], key = LIVE_KEY): void {
  expect(calls.length).toBeGreaterThan(0);
  const base = key.startsWith('pdl_sdbx_') ? 'https://sandbox-api.paddle.com/' : 'https://api.paddle.com/';
  for (const c of calls) {
    expect(c.method).toBe('GET');
    expect(c.url.startsWith(base)).toBe(true);
    expect(c.headers['authorization']).toBe(`Bearer ${key}`);
    expect(c.headers['paddle-version']).toBe(PADDLE_API_VERSION);
    expect(new URL(c.url).searchParams.has('include')).toBe(false); // never pull customer data in
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

const pathOf = (c: RecordedCall) => new URL(c.url).pathname;
const queryOf = (c: RecordedCall, k: string) => new URL(c.url).searchParams.get(k);

// ---------- verify ----------

describe('paddle verify', () => {
  it.each([
    [LIVE_KEY, 'https://api.paddle.com/'],
    [SANDBOX_KEY, 'https://sandbox-api.paddle.com/'],
  ])('accepts the documented example key %s as well-formed (69 chars, one request to its own host)', async (key, url) => {
    expect(key).toHaveLength(69);
    const { fetch, calls } = fakeFetch([route('/', { json: root(ALL_READ) })]);
    await paddleAdapter.verify(input(key), makeCtx(fetch));
    expect(calls.map((c) => c.url)).toEqual([url]); // the format check let it through
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['legacy key', LEGACY_KEY],
    ['client-side token', 'live_7d279f61a3499fed520f7cd8c08'],
    ['truncated key', LIVE_KEY.slice(0, -1)],
    ['unknown environment', LIVE_KEY.replace('pdl_live_', 'pdl_test_')],
    ['inner whitespace', LIVE_KEY.replace('apikey_', 'apikey _')],
    ['header prefix pasted', `Bearer ${LIVE_KEY}`],
    ['Stripe key', 'rk_live_51FakeKeyForTestsOnly1111111111111111111111111111'],
  ])('rejects a %s on the apiKey field without a network call', async (_label, key) => {
    const { fetch, calls } = fakeFetch([route('/', { json: root(ALL_READ) })]);
    const res = await paddleAdapter.verify(input(key), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error.length).toBeGreaterThan(10);
    expect(calls).toHaveLength(0);
  });

  it('explains legacy keys and client-side tokens', async () => {
    const ctx = makeCtx(fakeFetch([]).fetch);
    const legacy = await paddleAdapter.verify(input(LEGACY_KEY), ctx);
    expect(!legacy.ok && legacy.error).toMatch(/legacy Paddle API key.*new API key/);
    const token = await paddleAdapter.verify(input('test_7d279f61a3499fed520f7cd8c08'), ctx);
    expect(!token.ok && token.error).toMatch(/client-side token/);
  });

  it('accepts a live key with one pinned, authenticated GET / and labels it with the account name', async () => {
    const { fetch, calls } = fakeFetch([route('/', { json: root(ALL_READ) })]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const res = await paddleAdapter.verify(input(`  ${LIVE_KEY}  `), ctx);
    expect(res).toEqual({ ok: true, accountLabel: 'AeroEdit', config: {}, testMode: false, warnings: [] });
    expect(calls.map((c) => c.url)).toEqual(['https://api.paddle.com/']);
    expectPaddleHeaders(calls);
    expect(ctx.pageBudget).toBe(4);
    expectNoSecretsInLogs(ctx, [LIVE_KEY, LIVE_KEY.slice(16)]);
  });

  it('sends a sandbox key to the sandbox API and does not require Metrics there', async () => {
    const perms = ['subscription.read', 'transaction.read', 'adjustment.read', 'discount.read'];
    const { fetch, calls } = fakeFetch([route('/', { json: root(perms, { environment: 'sandbox' }) })]);
    const res = await paddleAdapter.verify(input(SANDBOX_KEY), makeCtx(fetch));
    expect(res).toEqual({ ok: true, accountLabel: 'AeroEdit (sandbox)', config: {}, testMode: true, warnings: [] });
    expect(calls.map((c) => c.url)).toEqual(['https://sandbox-api.paddle.com/']);
    expectPaddleHeaders(calls, SANDBOX_KEY);
  });

  it('falls back to a generic label when the account has no name', async () => {
    const { fetch } = fakeFetch([route('/', { json: root(ALL_READ, { name: '  ' }) })]);
    const res = await paddleAdapter.verify(input(), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, accountLabel: 'Paddle (live)' });
  });

  it('names a missing required permission', async () => {
    const { fetch } = fakeFetch([route('/', { json: root(ALL_READ.filter((p) => p !== 'metrics.read')) })]);
    const res = await paddleAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({ ok: false, field: 'apiKey', error: 'The Paddle key is missing the “Metrics: Read” permission (metrics.read).' });
  });

  it('names every missing permission at once', async () => {
    const { fetch } = fakeFetch([route('/', { json: root(['metrics.read', 'discount.read']) })]);
    const res = await paddleAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({
      ok: false,
      field: 'apiKey',
      error:
        'The Paddle key is missing these permissions: Subscriptions: Read (subscription.read), Transactions: Read (transaction.read), Adjustments: Read (adjustment.read).',
    });
  });

  it('warns (but accepts) without Discounts: Read', async () => {
    const { fetch } = fakeFetch([route('/', { json: root(ALL_READ.filter((p) => p !== 'discount.read')) })]);
    const res = await paddleAdapter.verify(input(), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, warnings: [DISCOUNTS_WARNING] });
  });

  it('counts a write permission as read, and warns that the key can change data', async () => {
    const perms = ['subscription.write', 'transaction.read', 'adjustment.write', 'metrics.read', 'discount.read', 'customer.write'];
    const { fetch } = fakeFetch([route('/', { json: root(perms) })]);
    const res = await paddleAdapter.verify(input(), makeCtx(fetch));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/can also change data in Paddle \(adjustment\.write, customer\.write, subscription\.write\)/);
  });

  it('rejects a key Paddle answers anonymously (caller.account is null)', async () => {
    const { fetch } = fakeFetch([route('/', { json: clone(apiRootFx) })]);
    const res = await paddleAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({ ok: false, field: 'apiKey', error: REJECTED_KEY_MESSAGE });
  });

  it('maps 403 invalid_token to a rejected key after one request, without logging the key', async () => {
    const { fetch, calls } = fakeFetch([route('/', { status: 403, json: errorInvalidTokenFx })]);
    const ctx = makeCtx(fetch);
    const res = await paddleAdapter.verify(input(), ctx);
    expect(res).toEqual({ ok: false, field: 'apiKey', error: REJECTED_KEY_MESSAGE });
    expect(calls).toHaveLength(1);
    expectNoSecretsInLogs(ctx, [LIVE_KEY, LIVE_KEY.slice(16)]);
  });

  it('explains a Paddle Classic account (paddle_billing_not_enabled)', async () => {
    const { fetch } = fakeFetch([route('/', { status: 403, json: errorBillingNotEnabledFx })]);
    const res = await paddleAdapter.verify(input(), makeCtx(fetch));
    expect(!res.ok && res.error).toMatch(/Paddle Billing isn’t turned on.*not Paddle Classic/);
  });

  it('throws transient failures for the caller to describe; a 429 gives up at once', async () => {
    const down = fakeFetch([route('/', { status: 503, json: { error: { type: 'api_error', code: 'service_unavailable' } } })]);
    expect((await catchErr(paddleAdapter.verify(input(), makeCtx(down.fetch)))).kind).toBe('upstream');

    const limited = fakeFetch([route('/', { status: 429, json: errorTooManyRequestsFx, headers: { 'retry-after': '60' } })]);
    const ctx = makeCtx(limited.fetch, { pageBudget: 5 });
    const err = await catchErr(paddleAdapter.verify(input(), ctx));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.kind).toBe('rate_limit');
    expect(limited.calls).toHaveLength(1);
    expect(ctx.pageBudget).toBe(0);
  });
});

// ---------- snapshot: Paddle's MRR metric ----------

function metrics(points: Array<[string, string]>, updatedAt: string, currency = 'USD'): Json {
  const m = clone(metricsMrrFx);
  m.data.timeseries = points.map(([timestamp, amount]) => ({ timestamp, amount }));
  m.data.updated_at = updatedAt;
  m.data.currency_code = currency;
  return m;
}

const countRoutes = (active: number, trials: number): Route[] => [
  route('/subscriptions', { json: list(active > 0 ? [clone(subscriptionsFx.data[0])] : [], { hasMore: active > 1, total: active, perPage: 1 }) }, {
    query: { status: 'active,past_due', per_page: '1' },
  }),
  route('/subscriptions', { json: list(trials > 0 ? [clone(subscriptionsFx.data[0])] : [], { hasMore: trials > 1, total: trials, perPage: 1 }) }, {
    query: { status: 'trialing', per_page: '1' },
  }),
];

describe('paddle fetchSnapshot (metrics)', () => {
  it('reads the newest refreshed MRR point and counts subscriptions from estimated_total in 3 requests', async () => {
    // The docs example (2025-09-01 … 09-04), moved into the requested window: Paddle only returns points in [from, to).
    const docs = clone(metricsMrrFx);
    const shift = Date.parse('2026-11-01T00:00:00Z') - Date.parse('2025-09-01T00:00:00Z');
    const moved = (t: string) => iso(Date.parse(t) + shift).replace('.000Z', 'Z');
    for (const p of docs.data.timeseries) p.timestamp = moved(p.timestamp);
    for (const k of ['starts_at', 'ends_at', 'updated_at']) docs.data[k] = moved(docs.data[k]);
    const { fetch, calls } = fakeFetch([
      route('/metrics/monthly-recurring-revenue', { json: docs }, { query: { from: '2026-10-29', to: '2026-11-06' } }),
      ...countRoutes(1234, 56),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 10 });
    const snap = await paddleAdapter.fetchSnapshot(input(), ctx);
    expect(snap).toEqual({
      mrr: { USD: 1420987654 }, // the docs example's last point
      activeSubscriptions: 1234,
      activeTrials: 56,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
    });
    expect(calls).toHaveLength(3);
    expectPaddleHeaders(calls);
    expect(ctx.logs.find((l) => l.event === 'paddle_snapshot')?.data).toMatchObject({ source: 'metrics', day: '2026-11-04' });
  });

  it('ignores points Paddle has not refreshed yet instead of reading them as 0', async () => {
    const m = metrics(
      [
        ['2026-11-03T00:00:00Z', '410000'],
        ['2026-11-04T00:00:00Z', '420000'],
        ['2026-11-05T00:00:00Z', '0'],
      ],
      '2026-11-04T21:00:00Z',
      'EUR',
    );
    const { fetch } = fakeFetch([route('/metrics/monthly-recurring-revenue', { json: m }), ...countRoutes(3, 0)]);
    const snap = await paddleAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ EUR: 420000 });
    expect(snap).toMatchObject({ activeSubscriptions: 3, activeTrials: 0 });
  });

  it('reports a refreshed zero as no MRR rather than estimating', async () => {
    const m = metrics([['2026-11-05T00:00:00Z', '0']], '2026-11-05T03:00:00Z');
    const { fetch, calls } = fakeFetch([route('/metrics/monthly-recurring-revenue', { json: m }), ...countRoutes(0, 0)]);
    const snap = await paddleAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({});
    expect(snap).toMatchObject({ activeSubscriptions: 0, activeTrials: 0 });
    expect(calls).toHaveLength(3);
  });

  it('counts by paging when Paddle skips the count (estimated_total −1)', async () => {
    const m = metrics([['2026-11-05T00:00:00Z', '5000']], '2026-11-05T03:00:00Z');
    const page1 = [clone(subscriptionsFx.data[0]), clone(subscriptionsFx.data[3])];
    const page2 = [clone(subscriptionsFx.data[4])];
    const { fetch } = fakeFetch([
      route('/metrics/monthly-recurring-revenue', { json: m }),
      route('/subscriptions', { json: list(page1.slice(0, 1), { hasMore: true, total: -1, perPage: 1 }) }, { query: { status: 'active,past_due', per_page: '1' } }),
      route('/subscriptions', { json: list(page1, { hasMore: true, total: -1, perPage: 200 }) }, {
        query: { status: 'active,past_due', per_page: '200' },
        absent: ['after'],
      }),
      route('/subscriptions', { json: list(page2, { total: -1, perPage: 200 }) }, {
        query: { status: 'active,past_due', per_page: '200', after: page1[1]!['id'] },
      }),
      countRoutes(0, 0)[1]!,
    ]);
    const snap = await paddleAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.activeSubscriptions).toBe(3);
  });

  it('lets a 429 propagate (MRR would be partial)', async () => {
    const { fetch, calls } = fakeFetch([route('/metrics/monthly-recurring-revenue', { status: 429, json: errorTooManyRequestsFx })]);
    const ctx = makeCtx(fetch);
    const err = await catchErr(paddleAdapter.fetchSnapshot(input(), ctx));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(1);
    expect(ctx.pageBudget).toBe(0);
  });

  it('fails the snapshot on a 5xx from the metric instead of estimating', async () => {
    const { fetch, calls } = fakeFetch(
      estimateRoutes({
        subs: [simple(4000)],
        extra: [route('/metrics/monthly-recurring-revenue', { status: 500, json: { error: { type: 'api_error', code: 'internal_error', detail: 'oops' } } })],
      }),
    );
    const err = await catchErr(paddleAdapter.fetchSnapshot(input(LIVE_KEY), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.status).toBe(500);
    expect(calls.map(pathOf)).toEqual([
      '/metrics/monthly-recurring-revenue',
      '/metrics/monthly-recurring-revenue',
      '/metrics/monthly-recurring-revenue',
    ]);
  });
});

// ---------- snapshot: estimate from subscriptions ----------

interface ItemOpts {
  amount?: number;
  currency?: string;
  interval?: string;
  frequency?: number;
  quantity?: number;
  status?: string;
  recurring?: boolean;
  priceId?: string;
  productId?: string;
  overrides?: Array<[string, number]>;
  oneTimePrice?: boolean;
}

const BASE_SUB = subscriptionsFx.data[0]; // active, USD, monthly: 10 × 30.00 + 1 × 100.00

function item(o: ItemOpts = {}): Json {
  const it = clone(BASE_SUB.items[0]);
  it.status = o.status ?? 'active';
  it.quantity = o.quantity ?? 1;
  it.recurring = o.recurring ?? true;
  const p = it.price;
  p.id = o.priceId ?? pid('pri');
  p.product_id = o.productId ?? 'pro_01gsz4t5hdjse780zja8vvr7jg';
  it.product.id = p.product_id;
  p.unit_price = { amount: String(o.amount ?? 1000), currency_code: o.currency ?? 'USD' };
  const countries = ['DE', 'FR', 'GB', 'JP', 'IE'];
  p.unit_price_overrides = (o.overrides ?? []).map(([currency_code, amount], i) => ({
    country_codes: [countries[i] ?? 'DE'],
    unit_price: { amount: String(amount), currency_code },
  }));
  p.billing_cycle = o.oneTimePrice ? null : { interval: o.interval ?? 'month', frequency: o.frequency ?? 1 };
  if (it.status === 'trialing') it.trial_dates = { starts_at: iso(NOW - DAY), ends_at: iso(NOW + 13 * DAY) };
  return it;
}

interface SubOpts {
  currency?: string;
  status?: string;
  discount?: Json | null;
}

function sub(items: Json[], o: SubOpts = {}): Json {
  const s = clone(BASE_SUB);
  s.id = pid('sub');
  s.status = o.status ?? 'active';
  s.currency_code = o.currency ?? 'USD';
  s.items = items;
  s.discount = o.discount ?? null;
  const cycle = items[0]?.['price']?.['billing_cycle'];
  if (cycle) s.billing_cycle = clone(cycle);
  return s;
}

const simple = (amount: number, o: ItemOpts & SubOpts = {}) => sub([item({ ...o, amount })], o);

/** A subscription's `discount` reference. */
function subDiscount(id: string, o: { type?: 'recurring' | 'one-off'; endsAt?: string | null } = {}): Json {
  return { id, starts_at: iso(NOW - 30 * DAY), ends_at: o.endsAt ?? null, type: o.type ?? 'recurring' };
}

/** A discount entity, from the docs example (10% percentage, recur=false) with overrides. */
function discount(id: string, o: Json): Json {
  return { ...clone(discountsFx.data[0]), id, recur: true, maximum_recurring_intervals: null, restrict_to: null, ...o };
}

interface EstimateSetup {
  subs?: Json[];
  trials?: number;
  discounts?: Json[];
  customDiscounts?: Json[];
  /** Matched before the defaults. */
  extra?: Route[];
  budget?: number;
  key?: string;
}

function estimateRoutes(s: EstimateSetup): Route[] {
  return [
    ...(s.extra ?? []),
    route('/subscriptions', { json: list(s.subs ?? [], { perPage: 200 }) }, {
      query: { status: 'active,past_due', per_page: '200' },
      absent: ['after'],
    }),
    countRoutes(0, s.trials ?? 0)[1]!,
    route('/discounts', (url) => {
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const pool = url.searchParams.get('mode') === 'custom' ? (s.customDiscounts ?? []) : (s.discounts ?? []);
      return { json: list(pool.filter((d) => ids.includes(d['id'])), { path: '/discounts', perPage: 200 }) };
    }),
  ];
}

async function estimate(s: EstimateSetup) {
  const { fetch, calls } = fakeFetch(estimateRoutes(s));
  const ctx = makeCtx(fetch, { pageBudget: s.budget ?? 30 });
  const snap = await paddleAdapter.fetchSnapshot(input(s.key ?? SANDBOX_KEY), ctx);
  return { snap, ctx, calls };
}

const estimateLog = (ctx: { logs: Array<{ event: string; data?: Record<string, unknown> }> }) =>
  ctx.logs.find((l) => l.event === 'paddle_mrr_estimate')?.data;

describe('paddle fetchSnapshot (estimate from subscriptions)', () => {
  it('never asks a sandbox account for metrics, and reads the docs example list', async () => {
    // The docs example list also holds a paused and a canceled subscription; only active + past_due count.
    const { snap, calls, ctx } = await estimate({ subs: clone(subscriptionsFx).data, trials: 4 });
    expect(snap).toEqual({
      // monthly 10 × 3000 + 10000 = 40000; yearly (50 × 50000 + 300000) / 12 = 208333 + 25000; past_due 40000
      mrr: { USD: 40000 + 208333 + 25000 + 40000 },
      activeSubscriptions: 3,
      activeTrials: 4,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
    });
    expect(calls.map(pathOf)).toEqual(['/subscriptions', '/subscriptions']); // no discounts in use → no lookup
    expectPaddleHeaders(calls, SANDBOX_KEY);
    expect(ctx.logs.find((l) => l.event === 'paddle_snapshot')?.data).toMatchObject({ source: 'subscriptions' });
    expect(JSON.stringify(ctx.logs)).not.toMatch(/sub_|ctm_|pri_|pro_|add_/);
  });

  it('normalizes interval, frequency and quantity, and skips trialing, paused and one-time items', async () => {
    const { snap, ctx } = await estimate({
      subs: [
        simple(12000, { interval: 'year' }), // 1000
        simple(3000, { frequency: 3 }), // quarterly → 1000
        simple(500, { interval: 'week' }), // 500 × 52/12 = 2166.67 → 2167
        simple(100, { interval: 'day' }), // 100 × 365/12 = 3041.67 → 3042
        sub([item({ amount: 900, quantity: 3 })]), // 3 seats → 2700
        sub([
          item({ amount: 2000 }),
          item({ amount: 5000, status: 'trialing' }), // item-level trial
          item({ amount: 7000, status: 'inactive' }),
          item({ amount: 9000, recurring: false }),
          item({ amount: 9500, oneTimePrice: true }),
        ]), // 2000
      ],
    });
    expect(snap.mrr).toEqual({ USD: 1000 + 1000 + 2167 + 3042 + 2700 + 2000 });
    expect(snap.activeSubscriptions).toBe(6);
    expect(estimateLog(ctx)).toMatchObject({ trialItems: 1, unpricedItems: 0 });
  });

  it('keeps currencies apart, uses a country price in the subscription currency, and skips what it cannot price', async () => {
    const { snap, ctx } = await estimate({
      subs: [
        simple(1000),
        simple(1500, { currency: 'JPY', interval: 'month' }),
        // Docs example price: base 5.00 USD, overrides 7.00 EUR (IE, FR, DE) and 6.00 GBP (GB).
        sub([item({ amount: 500, overrides: [['EUR', 700], ['GBP', 600]] })], { currency: 'EUR' }),
        sub([item({ amount: 500, overrides: [['EUR', 700], ['GBP', 600]] })], { currency: 'GBP' }),
        // Two EUR prices for different countries: which one this customer pays is unknown.
        sub([item({ amount: 500, overrides: [['EUR', 700], ['EUR', 800]] })], { currency: 'EUR' }),
        // No CAD price at all.
        sub([item({ amount: 500 })], { currency: 'CAD' }),
        simple(250, { currency: 'eur' }),
      ],
    });
    expect(snap.mrr).toEqual({ USD: 1000, JPY: 1500, EUR: 950, GBP: 600 });
    expect(snap.activeSubscriptions).toBe(7); // unpriced subscriptions still count
    expect(estimateLog(ctx)).toMatchObject({ unpricedItems: 2, overridePrices: 2 });
  });

  it('counts subscriptions with MRR above 0 (past_due included), and unpriced ones, but not free or trial-only ones', async () => {
    const pct100 = pid('dsc');
    const { snap, ctx } = await estimate({
      discounts: [discount(pct100, { type: 'percentage', amount: '100' })],
      subs: [
        simple(1000),
        simple(800, { status: 'past_due' }),
        sub([item({ amount: 500 })], { currency: 'CAD' }), // no CAD price: MRR unknown, not 0, so counted
        simple(0), // free plan
        sub([item({ amount: 0 }), item({ amount: 0, interval: 'year' })]),
        simple(4000, { discount: subDiscount(pct100) }), // 100% off
        sub([item({ amount: 4000, status: 'trialing' })]), // only an item-level trial
      ],
    });
    expect(snap.mrr).toEqual({ USD: 1800 });
    expect(snap.activeSubscriptions).toBe(3);
    expect(estimateLog(ctx)).toMatchObject({ zeroSubscriptions: 4, unpricedItems: 1, trialItems: 1 });
  });

  it('applies percentage, flat and flat_per_seat discounts with restrict_to, recur and end dates', async () => {
    const seat = 'pri_01gsz8x8sawmvhz1pv30nge1ke';
    const addonProduct = 'pro_01h1vjes1y163xfj1rh1tkfb65';
    const ids = {
      pct10: pid('dsc'),
      pct125: pid('dsc'),
      flat500: pid('dsc'),
      flatYear: pid('dsc'),
      perSeat: 'dsc_01gtf15svsqzgp9325ss4ebmwt', // docs example: 10.00 USD off per seat, restricted to the seat price
      product: pid('dsc'),
      noRecur: 'dsc_01gtgztp8fpchantd5g1wrksa3', // docs example: recur=false
      limited: pid('dsc'),
      expired: pid('dsc'),
      oneOff: pid('dsc'),
      archived: pid('dsc'),
      big: pid('dsc'),
    };
    const discounts = [
      discount(ids.pct10, { type: 'percentage', amount: '10' }),
      discount(ids.pct125, { type: 'percentage', amount: '12.5' }),
      discount(ids.flat500, { type: 'flat', amount: '500', currency_code: 'USD' }),
      discount(ids.flatYear, { type: 'flat', amount: '1200', currency_code: 'USD' }),
      { ...clone(discountsFx.data[1]), recur: true },
      discount(ids.product, { type: 'percentage', amount: '50', restrict_to: [addonProduct] }),
      clone(discountsFx.data[0]),
      discount(ids.limited, { type: 'percentage', amount: '20', maximum_recurring_intervals: 3 }),
      discount(ids.archived, { type: 'percentage', amount: '25', status: 'archived' }),
      discount(ids.big, { type: 'flat', amount: '99999', currency_code: 'USD' }),
    ];
    const seatSub = (d: Json) => sub([item({ amount: 3000, quantity: 10, priceId: seat }), item({ amount: 10000, productId: addonProduct })], { discount: d });
    const { snap, calls, ctx } = await estimate({
      discounts,
      subs: [
        simple(4000, { discount: subDiscount(ids.pct10) }), // 3600
        simple(4000, { discount: subDiscount(ids.pct125) }), // 3500
        simple(4000, { discount: subDiscount(ids.flat500) }), // 3500
        simple(12000, { interval: 'year', discount: subDiscount(ids.flatYear) }), // 1000 − 1200/12 → 900
        seatSub(subDiscount(ids.perSeat)), // 30000 − 10 × 1000 + 10000 → 30000
        seatSub(subDiscount(ids.product)), // 30000 + 10000 × 0.5 → 35000
        simple(4000, { discount: subDiscount(ids.noRecur) }), // first period only → 4000
        simple(4000, { discount: subDiscount(ids.limited, { endsAt: iso(NOW + 40 * DAY) }) }), // still running → 3200
        simple(4000, { discount: subDiscount(ids.expired, { endsAt: iso(NOW - DAY) }) }), // over → 4000, not looked up
        simple(4000, { discount: subDiscount(ids.oneOff, { type: 'one-off' }) }), // trial-only → 4000, not looked up
        simple(4000, { discount: subDiscount(ids.archived) }), // archived discounts still apply → 3000
        simple(300, { discount: subDiscount(ids.big) }), // never below 0 (and no longer counted)
      ],
    });
    expect(snap.mrr).toEqual({ USD: 3600 + 3500 + 3500 + 900 + 30000 + 35000 + 4000 + 3200 + 4000 + 4000 + 3000 });
    expect(snap.activeSubscriptions).toBe(11);

    const lookups = calls.filter((c) => pathOf(c) === '/discounts');
    expect(lookups).toHaveLength(1);
    const asked = queryOf(lookups[0]!, 'id')!.split(',');
    expect(asked.sort()).toEqual(
      [ids.pct10, ids.pct125, ids.flat500, ids.flatYear, ids.perSeat, ids.product, ids.noRecur, ids.limited, ids.archived, ids.big].sort(),
    );
    expect(queryOf(lookups[0]!, 'status')).toBe('active,archived');
    expect(queryOf(lookups[0]!, 'mode')).toBeNull();
    expect(estimateLog(ctx)).toMatchObject({ unresolvedDiscounts: 0 });
  });

  it('asks again with mode=custom for discounts the default listing leaves out, in batches of 50', async () => {
    const custom = pid('dsc');
    const many = Array.from({ length: 50 }, () => pid('dsc'));
    const { snap, calls, ctx } = await estimate({
      discounts: many.map((id) => discount(id, { type: 'percentage', amount: '10' })),
      customDiscounts: [discount(custom, { type: 'percentage', amount: '50', mode: 'custom' })],
      subs: [...many.map((id) => simple(1000, { discount: subDiscount(id) })), simple(1000, { discount: subDiscount(custom) })],
      budget: 10,
    });
    expect(snap.mrr).toEqual({ USD: 50 * 900 + 500 });
    const lookups = calls.filter((c) => pathOf(c) === '/discounts');
    expect(lookups.map((c) => [queryOf(c, 'id')!.split(',').length, queryOf(c, 'mode')])).toEqual([
      [50, null],
      [1, null],
      [1, 'custom'],
    ]);
    expect(estimateLog(ctx)).toMatchObject({ unresolvedDiscounts: 0 });
  });

  it('leaves out discounts it cannot apply and counts them', async () => {
    const eur = pid('dsc');
    const gone = pid('dsc');
    const { snap, ctx } = await estimate({
      discounts: [discount(eur, { type: 'flat', amount: '500', currency_code: 'EUR' })],
      subs: [simple(4000, { discount: subDiscount(eur) }), simple(4000, { discount: subDiscount(gone) })],
    });
    expect(snap.mrr).toEqual({ USD: 8000 });
    expect(estimateLog(ctx)).toMatchObject({ unresolvedDiscounts: 2 });
  });

  it('estimates before discounts (and logs it once) when the key lacks Discounts: Read', async () => {
    const a = pid('dsc');
    const b = pid('dsc');
    const { snap, calls, ctx } = await estimate({
      extra: [route('/discounts', { status: 403, json: errorForbiddenFx })],
      subs: [simple(4000, { discount: subDiscount(a) }), simple(5000, { discount: subDiscount(b) })],
    });
    expect(snap.mrr).toEqual({ USD: 9000 });
    expect(calls.filter((c) => pathOf(c) === '/discounts')).toHaveLength(1);
    expect(ctx.logs.filter((l) => l.event === 'paddle_discount_permission_missing')).toHaveLength(1);
    expect(estimateLog(ctx)).toMatchObject({ unresolvedDiscounts: 2 });
    expectNoSecretsInLogs(ctx, [SANDBOX_KEY, SANDBOX_KEY.slice(16)]);
  });

  it('pages through subscriptions with per_page=200 and after', async () => {
    const page1 = [simple(1000), simple(2000)];
    const page2 = [simple(3000)];
    const { snap, calls } = await estimate({
      extra: [
        route('/subscriptions', { json: list(page1, { hasMore: true, perPage: 200 }) }, {
          query: { status: 'active,past_due', per_page: '200' },
          absent: ['after'],
        }),
        route('/subscriptions', { json: list(page2, { perPage: 200 }) }, {
          query: { status: 'active,past_due', per_page: '200', after: page1[1]!['id'] },
        }),
      ],
    });
    expect(snap).toMatchObject({ mrr: { USD: 6000 }, activeSubscriptions: 3 });
    expect(calls.map((c) => queryOf(c, 'status'))).toEqual(['active,past_due', 'active,past_due', 'trialing']);
  });

  it('estimates for a live key whose metric is empty, forbidden or unavailable', async () => {
    for (const responder of [
      { json: metrics([], '2026-11-05T03:00:00Z') },
      { status: 403, json: errorForbiddenFx },
      { status: 404, json: errorNotInSandboxFx },
      { status: 400, json: { error: { type: 'request_error', code: 'invalid_field', detail: 'Request does not pass validation.' } } },
    ]) {
      const { snap, calls, ctx } = await estimate({
        key: LIVE_KEY,
        subs: [simple(4000)],
        extra: [route('/metrics/monthly-recurring-revenue', responder)],
      });
      expect(snap).toMatchObject({ mrr: { USD: 4000 }, activeSubscriptions: 1, activeTrials: 0 });
      expect(calls.map(pathOf)).toEqual(['/metrics/monthly-recurring-revenue', '/subscriptions', '/subscriptions']);
      expect(ctx.logs.some((l) => l.event === 'paddle_metrics_unavailable')).toBe(true);
    }
  });

  it('lets BudgetExhaustedError propagate instead of returning a partial MRR', async () => {
    const { fetch, calls } = fakeFetch([
      route('/subscriptions', { json: list([simple(1000)], { hasMore: true, perPage: 200 }) }, { query: { status: 'active,past_due' }, absent: ['after'] }),
    ]);
    const err = await catchErr(paddleAdapter.fetchSnapshot(input(SANDBOX_KEY), makeCtx(fetch, { pageBudget: 1 })));
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toHaveLength(1);
  });

  it(`stops after ${PADDLE_SNAPSHOT_PAGE_BUDGET} requests whatever the sync allows, so one sync stays under 240 a minute`, async () => {
    const { fetch, calls } = fakeFetch([
      route('/subscriptions', () => ({ json: list([simple(1000)], { hasMore: true, perPage: 200 }) }), { query: { status: 'active,past_due' } }),
    ]);
    const err = await catchErr(paddleAdapter.fetchSnapshot(input(SANDBOX_KEY), makeCtx(fetch, { pageBudget: SNAPSHOT_PAGE_BUDGET })));
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).reason).toBe('budget');
    expect(calls).toHaveLength(PADDLE_SNAPSHOT_PAGE_BUDGET);
    // With the revenue phase right after it, at most 3/4 of the per-IP limit other Workers share.
    expect(PADDLE_SNAPSHOT_PAGE_BUDGET + REVENUE_PAGE_BUDGET).toBeLessThanOrEqual(0.75 * 240);
  });

  it('refuses a malformed key without a network call', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await catchErr(paddleAdapter.fetchSnapshot(input(LEGACY_KEY), makeCtx(fetch)));
    expect(err.kind).toBe('invalid_input');
    expect(err.field).toBe('apiKey');
    expect(calls).toHaveLength(0);
  });

  it('keeps a subscription with a scheduled cancellation in MRR until it takes effect (SPEC §6)', async () => {
    const leaving = simple(4000);
    leaving['scheduled_change'] = { action: 'cancel', effective_at: iso(NOW + 10 * DAY), resume_at: null };
    const { snap } = await estimate({ subs: [leaving, simple(1000)] });
    expect(snap).toMatchObject({ mrr: { USD: 5000 }, activeSubscriptions: 2 });
  });

  it('fails the snapshot when the discount lookup hits a 5xx, instead of estimating before discounts', async () => {
    const d = pid('dsc');
    const { fetch } = fakeFetch(
      estimateRoutes({
        extra: [route('/discounts', { status: 500, json: { error: { type: 'api_error', code: 'internal_error', detail: 'oops' } } })],
        subs: [simple(4000, { discount: subDiscount(d) })],
      }),
    );
    const err = await catchErr(paddleAdapter.fetchSnapshot(input(SANDBOX_KEY), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.status).toBe(500);
  });

  it.each([
    ['a list without data', { json: { meta: clone(subscriptionsFx.meta) } }],
    ['a non-JSON body', { body: '<html>Bad Gateway</html>' }],
  ])('refuses %s as unreadable instead of estimating an MRR of 0', async (_label, responder) => {
    const { fetch } = fakeFetch([route('/subscriptions', responder)]);
    const err = await catchErr(paddleAdapter.fetchSnapshot(input(SANDBOX_KEY), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/couldn’t read/);
  });

  it('stops on an empty page that claims has_more, and refuses a malformed `after` id instead of re-reading page 1', async () => {
    const empty = await estimate({
      extra: [route('/subscriptions', { json: list([], { hasMore: true, perPage: 200 }) }, { query: { status: 'active,past_due' } })],
    });
    expect(empty.snap).toMatchObject({ mrr: {}, activeSubscriptions: 0 });
    expect(empty.calls.map((c) => queryOf(c, 'status'))).toEqual(['active,past_due', 'trialing']);

    const bad = simple(1000);
    bad['id'] = 'not-a-paddle-id';
    const { fetch, calls } = fakeFetch([
      route('/subscriptions', { json: list([bad], { hasMore: true, perPage: 200 }) }, { query: { status: 'active,past_due' } }),
    ]);
    const ctx = makeCtx(fetch);
    const err = await catchErr(paddleAdapter.fetchSnapshot(input(SANDBOX_KEY), ctx));
    expect(err.kind).toBe('upstream');
    expect(calls).toHaveLength(1);
    expect(ctx.logs.some((l) => l.event === 'paddle_bad_payload')).toBe(true);
  });
});

describe('paddle fetchSnapshot: warnings', () => {
  it('has no warnings when Paddle’s metric is there, nor for a clean sandbox estimate', async () => {
    const m = metrics([['2026-11-05T00:00:00Z', '5000']], '2026-11-05T03:00:00Z');
    const { fetch } = fakeFetch([route('/metrics/monthly-recurring-revenue', { json: m }), ...countRoutes(3, 1)]);
    expect((await paddleAdapter.fetchSnapshot(input(), makeCtx(fetch))).warnings).toBeUndefined();

    const d = pid('dsc');
    // Sandbox has no metric, so the estimate is the normal case there and isn't warned about.
    const { snap } = await estimate({ discounts: [discount(d, { type: 'percentage', amount: '10' })], subs: [simple(4000, { discount: subDiscount(d) })] });
    expect(snap.mrr).toEqual({ USD: 3600 });
    expect(snap.warnings).toBeUndefined();
  });

  it('says MRR is an estimate when a live key falls back, and asks for Metrics: Read when that is why', async () => {
    const cases: Array<[Json, string]> = [
      [{ json: metrics([], '2026-11-05T03:00:00Z') }, PADDLE_METRICS_UNAVAILABLE_WARNING],
      [{ status: 403, json: errorForbiddenFx }, PADDLE_METRICS_PERMISSION_WARNING],
      [{ status: 404, json: errorNotInSandboxFx }, PADDLE_METRICS_UNAVAILABLE_WARNING],
      [
        { status: 400, json: { error: { type: 'request_error', code: 'invalid_field', detail: 'Request does not pass validation.' } } },
        PADDLE_METRICS_UNAVAILABLE_WARNING,
      ],
    ];
    for (const [responder, warning] of cases) {
      const { snap, ctx } = await estimate({ key: LIVE_KEY, subs: [simple(4000)], extra: [route('/metrics/monthly-recurring-revenue', responder)] });
      expect(snap.warnings).toEqual([warning]);
      expectNoSecretsInLogs(ctx, [LIVE_KEY, LIVE_KEY.slice(16)]);
    }
  });

  it('says the estimate is before discounts when the key lacks Discounts: Read, without a count', async () => {
    const { snap, ctx } = await estimate({
      extra: [route('/discounts', { status: 403, json: errorForbiddenFx })],
      subs: [simple(4000, { discount: subDiscount(pid('dsc')) }), simple(5000, { discount: subDiscount(pid('dsc')) })],
    });
    expect(snap.warnings).toEqual([PADDLE_DISCOUNTS_WARNING]);
    expectNoSecretsInLogs(ctx, [SANDBOX_KEY, SANDBOX_KEY.slice(16)]);
  });

  it('counts discounts it couldn’t apply and items it couldn’t price', async () => {
    const eur = pid('dsc');
    const { snap } = await estimate({
      discounts: [discount(eur, { type: 'flat', amount: '500', currency_code: 'EUR' })],
      subs: [
        simple(4000, { discount: subDiscount(eur) }),
        simple(4000, { discount: subDiscount(pid('dsc')) }),
        sub([item({ amount: 500 })], { currency: 'CAD' }),
      ],
    });
    expect(snap.warnings).toEqual([paddleDiscountsUnresolvedWarning(2), paddleUnpricedItemsWarning(1)]);
    expect(snap.warnings).toEqual([
      '2 discounts couldn’t be read or applied, so MRR is shown before them.',
      '1 subscription item has no price in its subscription’s currency, so it counts as 0 in MRR.',
    ]);
  });

  it('says a subscription count above 100,000 is capped, once', async () => {
    const m = metrics([['2026-11-05T00:00:00Z', '5000']], '2026-11-05T03:00:00Z');
    const { fetch } = fakeFetch([route('/metrics/monthly-recurring-revenue', { json: m }), ...countRoutes(100_001, 100_001)]);
    const snap = await paddleAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.activeSubscriptions).toBe(100_001);
    expect(snap.warnings).toEqual([PADDLE_COUNT_CAPPED_WARNING]);
  });

  it('does not call a count of exactly 100,000 capped (Paddle counts exactly up to there)', async () => {
    const m = metrics([['2026-11-05T00:00:00Z', '5000']], '2026-11-05T03:00:00Z');
    const { fetch } = fakeFetch([route('/metrics/monthly-recurring-revenue', { json: m }), ...countRoutes(100_000, 100_000)]);
    const snap = await paddleAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap).toMatchObject({ activeSubscriptions: 100_000, activeTrials: 100_000 });
    expect(snap.warnings).toBeUndefined();
  });

  it('keeps every sentence short and free of IDs', () => {
    const all = [
      PADDLE_METRICS_PERMISSION_WARNING,
      PADDLE_METRICS_UNAVAILABLE_WARNING,
      PADDLE_DISCOUNTS_WARNING,
      PADDLE_COUNT_CAPPED_WARNING,
      ...[1, 2, 100_000].flatMap((n) => [paddleUnpricedItemsWarning(n), paddleDiscountsUnresolvedWarning(n)]),
    ];
    for (const w of all) {
      expect(w.length).toBeLessThanOrEqual(200);
      expect(w).toMatch(/\.$/);
      expect(w).not.toMatch(/https?:|pdl_|dsc_|sub_|pri_/);
    }
  });
});

// ---------- revenue ----------

const SINCE = NOW - 90 * DAY;
const rfc = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const txnQuery = (since = SINCE) => ({ status: 'completed', 'updated_at[GTE]': rfc(since), order_by: 'id[DESC]', per_page: '30' });
const ADJ_QUERY = { action: 'refund,chargeback,chargeback_reverse', status: 'approved,reversed', order_by: 'id[DESC]', per_page: '50' };

const BASE_TXN = transactionsFx.data[2]; // completed web checkout, USD 599.00 + 53.15 tax, fee 33.11

interface TxnOpts {
  id?: string;
  grand?: number;
  tax?: number;
  grandTax?: number;
  fee?: number | null;
  currency?: string;
  capturedAt?: number | null;
  billedAt?: number | null;
  createdAt?: number;
  products?: Array<[type: string, name: string]>;
}

function txn(o: TxnOpts = {}): Json {
  const t = clone(BASE_TXN);
  t.id = o.id ?? pid('txn');
  const grand = o.grand ?? 10000;
  const tax = o.tax ?? 2000;
  Object.assign(t.details.totals, {
    subtotal: String(grand - tax),
    tax: String(tax),
    total: String(grand),
    grand_total: String(grand),
    grand_total_tax: String(o.grandTax ?? tax),
    balance: '0',
    fee: o.fee === undefined ? '500' : o.fee === null ? null : String(o.fee),
    currency_code: o.currency ?? 'USD',
  });
  t.currency_code = o.currency ?? 'USD';
  const billed = o.billedAt === undefined ? NOW - 2 * HOUR : o.billedAt;
  t.billed_at = billed === null ? null : iso(billed);
  t.created_at = iso(o.createdAt ?? NOW - 3 * HOUR);
  t.updated_at = iso(NOW - HOUR);
  if (o.capturedAt === null) t.payments = [];
  else t.payments[0].captured_at = iso(o.capturedAt ?? NOW - 2 * HOUR);
  (o.products ?? []).forEach(([type, name], i) => {
    t.details.line_items[i].product.type = type;
    t.details.line_items[i].product.name = name;
  });
  return t;
}

const BASE_ADJ = adjustmentsFx.data[0]; // refund, partial, pending_approval, USD 0.92 + 0.08 tax

function adj(o: { id?: string; action?: string; status?: string; total?: number; tax?: number; currency?: string; createdAt?: number; updatedAt?: number } = {}): Json {
  const a = clone(BASE_ADJ);
  a.id = o.id ?? pid('adj');
  a.action = o.action ?? 'refund';
  a.status = o.status ?? 'approved';
  const total = o.total ?? 1200;
  const tax = o.tax ?? 200;
  Object.assign(a.totals, { subtotal: String(total - tax), tax: String(tax), total: String(total), currency_code: o.currency ?? 'USD' });
  a.currency_code = o.currency ?? 'USD';
  a.created_at = iso(o.createdAt ?? NOW - 2 * HOUR);
  a.updated_at = iso(o.updatedAt ?? o.createdAt ?? NOW - 2 * HOUR);
  return a;
}

const txnRoute = (data: Json[], o: { after?: string; hasMore?: boolean; since?: number } = {}) =>
  route('/transactions', { json: list(data, { hasMore: o.hasMore, perPage: 30, total: -1, path: '/transactions' }) }, {
    query: { ...txnQuery(o.since), ...(o.after ? { after: o.after } : {}) },
    absent: o.after ? [] : ['after'],
  });

const adjRoute = (data: Json[], o: { after?: string; hasMore?: boolean } = {}) =>
  route('/adjustments', { json: list(data, { hasMore: o.hasMore, perPage: 50, total: -1, path: '/adjustments' }) }, {
    query: { ...ADJ_QUERY, ...(o.after ? { after: o.after } : {}) },
    absent: o.after ? [] : ['after'],
  });

describe('paddle fetchRevenue', () => {
  it('turns the docs example lists into tax-free charges, with the filters, Skip-Count and no includes', async () => {
    const since = Date.parse('2024-04-01T00:00:00Z');
    const { fetch, calls } = fakeFetch([txnRoute(clone(transactionsFx).data, { since }), adjRoute(clone(adjustmentsFx).data)]);
    const ctx = makeCtx(fetch);
    const page = await paddleAdapter.fetchRevenue(input(), { since, cursor: null }, ctx);
    expect(page).toEqual({
      events: [
        {
          externalId: 'txn_01hv8wptq8987qeep44cyrewp9',
          occurredAt: Date.parse('2024-04-12T10:18:47.635628Z'), // the captured payment
          type: 'charge',
          amount: 65215 - 5315,
          currency: 'USD',
          fee: 3311,
          description: 'AeroEdit Pro',
        },
        {
          externalId: 'txn_01hv8wnvvtedwjrhfhpr9vkq9w',
          occurredAt: Date.parse('2024-04-12T10:12:04.496216Z'),
          type: 'charge',
          amount: 47600 - 7600,
          currency: 'USD',
          fee: 2430,
          description: 'Analytics addon',
        },
      ],
      daily: [],
      nextCursor: null,
      done: true,
    });
    // The example adjustments are a pending refund, credits and a credit reversal: none are revenue. The page
    // reaches back past since − 30 days, so the walk stops there.
    expect(calls.map(pathOf)).toEqual(['/transactions', '/adjustments']);
    expectPaddleHeaders(calls);
    for (const c of calls) expect(c.headers['skip-count']).toBe('true');
    const dump = JSON.stringify(page) + JSON.stringify(ctx.logs);
    expect(dump).not.toMatch(/Sam Miller|ctm_|add_|@/);
    expectNoSecretsInLogs(ctx, [LIVE_KEY, LIVE_KEY.slice(16)]);
  });

  it('dates a charge by its capture, nets out the tax inside grand_total, and skips zero or older ones', async () => {
    const recovered = txn({ grand: 4760, tax: 760, billedAt: NOW - 10 * DAY, capturedAt: NOW - 3 * HOUR }); // dunning
    const credited = txn({ grand: 6000, tax: 2000, grandTax: 1200, fee: null }); // total 80.00 − 20.00 credit
    const noCapture = txn({ grand: 2000, tax: 0, capturedAt: null, billedAt: NOW - 5 * HOUR, products: [['custom', 'Consulting for Jane Doe']] });
    const yen = txn({ grand: 1100, tax: 100, currency: 'JPY', fee: 54 });
    const free = txn({ grand: 0, tax: 0 }); // payment-method update
    const old = txn({ capturedAt: SINCE - DAY }); // updated in the window, paid before it
    const { fetch } = fakeFetch([txnRoute([recovered, credited, noCapture, yen, free, old]), adjRoute([])]);
    const ctx = makeCtx(fetch);
    const page = await paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page.events).toEqual([
      { externalId: recovered['id'], occurredAt: NOW - 3 * HOUR, type: 'charge', amount: 4000, currency: 'USD', fee: 500, description: 'AeroEdit Pro' },
      { externalId: credited['id'], occurredAt: NOW - 2 * HOUR, type: 'charge', amount: 4800, currency: 'USD', fee: null, description: 'AeroEdit Pro' },
      // a custom (non-catalog) product is named per sale: the next catalog product describes it instead
      { externalId: noCapture['id'], occurredAt: NOW - 5 * HOUR, type: 'charge', amount: 2000, currency: 'USD', fee: 500, description: 'Analytics addon' },
      { externalId: yen['id'], occurredAt: NOW - 2 * HOUR, type: 'charge', amount: 1000, currency: 'JPY', fee: 54, description: 'AeroEdit Pro' },
    ]);
    expect(ctx.logs.find((l) => l.event === 'paddle_revenue')?.data).toMatchObject({ zero: 1, beforeWindow: 1, unreadable: 0 });
    expect(JSON.stringify(page)).not.toContain('Jane Doe');
  });

  it('maps approved refunds and chargebacks without tax, and stops REFUND_LOOKBACK before since', async () => {
    const refund = adj({ total: 1200, tax: 200, createdAt: NOW - 3 * DAY, updatedAt: NOW - DAY }); // approved yesterday
    const lateApproved = adj({ total: 5000, tax: 0, createdAt: SINCE - 10 * DAY, updatedAt: SINCE + DAY });
    const chargeback = adj({ action: 'chargeback', total: 2400, tax: 400, currency: 'EUR', createdAt: NOW - 5 * DAY });
    // Won back later: Paddle marks the chargeback reversed and adds a reversal (negative totals).
    const reversed = adj({ action: 'chargeback', status: 'reversed', total: 1000, tax: 0, createdAt: NOW - 20 * DAY, updatedAt: NOW - 6 * DAY });
    const reversal = adj({ action: 'chargeback_reverse', total: -1000, tax: 0, createdAt: NOW - 6 * DAY });
    const taxOnly = adj({ total: 300, tax: 300, createdAt: NOW - 4 * DAY });
    const before = adj({ total: 700, tax: 0, createdAt: SINCE - 2 * DAY });
    const page1 = [refund, chargeback, reversal, taxOnly, reversed];
    const page2 = [before, lateApproved, adj({ createdAt: SINCE - REFUND_LOOKBACK_MS - DAY })];
    const { fetch, calls } = fakeFetch([
      txnRoute([]),
      adjRoute(page1, { hasMore: true }),
      adjRoute(page2, { hasMore: true, after: reversed['id'] }), // the walk must stop here
    ]);
    const ctx = makeCtx(fetch);
    const page = await paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(page.events).toEqual([
      { externalId: refund['id'], occurredAt: NOW - DAY, type: 'refund', amount: -1000, currency: 'USD', fee: null, description: null },
      { externalId: chargeback['id'], occurredAt: NOW - 5 * DAY, type: 'refund', amount: -2000, currency: 'EUR', fee: null, description: null },
      { externalId: reversal['id'], occurredAt: NOW - 6 * DAY, type: 'charge', amount: 1000, currency: 'USD', fee: null, description: null },
      { externalId: reversed['id'], occurredAt: NOW - 20 * DAY, type: 'refund', amount: -1000, currency: 'USD', fee: null, description: null },
      { externalId: lateApproved['id'], occurredAt: SINCE + DAY, type: 'refund', amount: -5000, currency: 'USD', fee: null, description: null },
    ]);
    expect(page.done).toBe(true);
    expect(calls.map(pathOf)).toEqual(['/transactions', '/adjustments', '/adjustments']);
    expect(ctx.logs.find((l) => l.event === 'paddle_revenue')?.data).toMatchObject({ zero: 1, beforeWindow: 2 });
  });

  it('resumes from its cursor when pageBudget runs out, keeping its window', async () => {
    const t1 = [txn({ capturedAt: NOW - 10 * HOUR }), txn({ capturedAt: NOW - 11 * HOUR })];
    const t2 = [txn({ capturedAt: NOW - 12 * HOUR })];
    const refund = adj({ createdAt: NOW - DAY });
    const routes = () => [txnRoute(t1, { hasMore: true }), txnRoute(t2, { after: t1[1]!['id'] }), adjRoute([refund])];

    const first = fakeFetch(routes());
    const r1 = await paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(first.fetch, { pageBudget: 1 }));
    expect(r1).toMatchObject({ daily: [], done: false });
    expect(r1.events.map((e) => e.externalId)).toEqual(t1.map((t) => t['id']));
    expect(first.calls).toHaveLength(1);

    // A day later the engine passes another `since`: the cursor's window wins.
    const second = fakeFetch(routes());
    const r2 = await paddleAdapter.fetchRevenue(input(), { since: SINCE + DAY, cursor: r1.nextCursor }, makeCtx(second.fetch, { pageBudget: 1, now: NOW + DAY }));
    expect(r2.events.map((e) => e.externalId)).toEqual([t2[0]!['id']]);
    expect(r2.done).toBe(false);

    const third = fakeFetch(routes());
    const r3 = await paddleAdapter.fetchRevenue(input(), { since: SINCE + DAY, cursor: r2.nextCursor }, makeCtx(third.fetch, { pageBudget: 5 }));
    expect(r3).toEqual({
      events: [{ externalId: refund['id'], occurredAt: NOW - DAY, type: 'refund', amount: -1000, currency: 'USD', fee: null, description: null }],
      daily: [],
      nextCursor: null,
      done: true,
    });
    expect(third.calls.map(pathOf)).toEqual(['/adjustments']);
    expectPaddleHeaders([...first.calls, ...second.calls, ...third.calls]);
  });

  it('returns what it read and its cursor when Paddle rate-limits mid-walk', async () => {
    const t1 = [txn(), txn()];
    const t2 = [txn()];
    const limited = fakeFetch([
      txnRoute(t1, { hasMore: true }),
      route('/transactions', { status: 429, json: errorTooManyRequestsFx, headers: { 'retry-after': '60' } }, { query: { after: t1[1]!['id'] } }),
    ]);
    const ctx = makeCtx(limited.fetch, { pageBudget: 20 });
    const r1 = await paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, ctx);
    expect(r1.done).toBe(false);
    expect(r1.events.map((e) => e.externalId)).toEqual(t1.map((t) => t['id']));
    expect(limited.calls).toHaveLength(2); // no retry: Paddle blocks the IP for 60 s
    expect(ctx.pageBudget).toBe(0);
    expect(ctx.logs.find((l) => l.event === 'paddle_revenue')?.data).toMatchObject({ reason: 'rate_limited' });

    const resumed = fakeFetch([txnRoute(t2, { after: t1[1]!['id'] }), adjRoute([])]);
    const r2 = await paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: r1.nextCursor }, makeCtx(resumed.fetch));
    expect(r2).toMatchObject({ done: true, nextCursor: null });
    expect(r2.events.map((e) => e.externalId)).toEqual([t2[0]!['id']]);
  });

  it('returns its cursor untouched without calling Paddle when no budget is left', async () => {
    const { fetch, calls } = fakeFetch([]);
    const r = await paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch, { pageBudget: 0 }));
    expect(r).toMatchObject({ events: [], daily: [], done: false, nextCursor: expect.any(String) });
    expect(calls).toHaveLength(0);

    const next = fakeFetch([txnRoute([]), adjRoute([])]);
    const r2 = await paddleAdapter.fetchRevenue(input(), { since: 0, cursor: r.nextCursor }, makeCtx(next.fetch));
    expect(r2).toEqual({ events: [], daily: [], nextCursor: null, done: true });
  });

  it('restarts from `since` when handed a cursor it did not write', async () => {
    const { fetch, calls } = fakeFetch([txnRoute([]), adjRoute([])]);
    const ctx = makeCtx(fetch);
    for (const cursor of [
      'not json',
      '{"v":2}',
      '{"v":1,"since":1,"phase":"transactions","after":"sub_01fake00000000000000000001"}',
      '{"v":1,"since":1,"phase":"refunds","after":null}',
    ]) {
      const r = await paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor }, ctx);
      expect(r.done).toBe(true);
    }
    expect(calls).toHaveLength(8);
    expect(ctx.logs.filter((l) => l.event === 'paddle_cursor_invalid')).toHaveLength(4);
  });

  it('moves on (and then finishes) when a page claims has_more but is empty', async () => {
    const { fetch, calls } = fakeFetch([
      route('/transactions', { json: list([], { hasMore: true, perPage: 30, total: -1, path: '/transactions' }) }),
      route('/adjustments', { json: list([], { hasMore: true, perPage: 50, total: -1, path: '/adjustments' }) }),
    ]);
    const page = await paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch));
    expect(page).toEqual({ events: [], daily: [], nextCursor: null, done: true });
    expect(calls.map(pathOf)).toEqual(['/transactions', '/adjustments']);
  });

  it('fails on a 5xx (after retries) instead of returning a partial page as if Paddle had rate-limited', async () => {
    const { fetch, calls } = fakeFetch([
      route('/transactions', { status: 502, json: { error: { type: 'api_error', code: 'bad_gateway', detail: 'Bad gateway' } } }),
    ]);
    const err = await catchErr(paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(calls).toHaveLength(3); // DEFAULT_MAX_ATTEMPTS
  });

  it('names the missing permission when a list is forbidden', async () => {
    const { fetch } = fakeFetch([txnRoute([]), route('/adjustments', { status: 403, json: errorForbiddenFx })]);
    const err = await catchErr(paddleAdapter.fetchRevenue(input(), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('permission');
    expect(err.message).toBe('The Paddle key is missing the “Adjustments: Read” permission (adjustment.read).');
  });

  it('refuses a malformed key without a network call', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await catchErr(paddleAdapter.fetchRevenue(input('pdl_live_apikey_short'), { since: SINCE, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});
