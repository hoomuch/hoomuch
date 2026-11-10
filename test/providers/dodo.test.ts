import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../../src/providers/http';
import {
  DODO_LIVE_BASE,
  DODO_SNAPSHOT_PAGE_BUDGET,
  DODO_TEST_BASE,
  LEGACY_KEY_WARNING,
  classifySubscription,
  decodeCursor,
  dodoAdapter,
} from '../../src/providers/dodo';
import { ProviderError } from '../../src/providers/types';
import { REVENUE_PAGE_BUDGET, SNAPSHOT_PAGE_BUDGET } from '../../src/sync/engine';
import { DAY } from '../../src/lib/time';
import { expectNoSecretsInLogs, expectSubscriptionsAddUp, fakeFetch, makeCtx, NOW, route, type RecordedCall } from '../fixtures/harness';
// Shapes from the OpenAPI schemas on https://docs.dodopayments.com/api-reference (SubscriptionListResponseItem,
// BalanceLedgerEntryResponse) and the documented error bodies ({code, message}, /api-reference/error-codes).
import subscriptionFx from '../fixtures/dodo/subscription.json';
import ledgerEntryFx from '../fixtures/dodo/ledger-entry.json';
import error401Fx from '../fixtures/dodo/error-401.json';
import error401WrongModeFx from '../fixtures/dodo/error-401-wrong-mode.json';
import error403PermissionFx from '../fixtures/dodo/error-403-permission.json';
import error403IpFx from '../fixtures/dodo/error-403-ip.json';
import error403NotLiveFx from '../fixtures/dodo/error-403-not-live.json';
import error500Fx from '../fixtures/dodo/error-500.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

const LIVE_KEY = 'dodo_live_FakeKeyForTestsOnly0000000000000000';
const TEST_KEY = 'dodo_test_FakeKeyForTestsOnly1111111111111111';
const LEGACY_KEY = 'FakeLegacyDodoKey.2222222222222222';
const PII = ['jane.fake@example.com', 'Jane Fake', 'Fake Street'];

const input = (apiKey = LIVE_KEY, config: Record<string, string> = {}) => ({ credentials: { apiKey }, config });
const iso = (ms: number) => new Date(ms).toISOString();
const list = (items: unknown[]) => ({ items });

let seq = 0;
const nextId = (prefix: string) => `${prefix}_Fake${(++seq).toString().padStart(5, '0')}`;

function sub(o: Json = {}): Json {
  return { ...clone(subscriptionFx), subscription_id: nextId('sub'), ...o };
}

const CREDIT: Record<string, boolean> = {
  payment: true,
  tax: false,
  tax_reversal: true,
  refund: false,
  refund_reversal: true,
  dispute: false,
  dispute_reversal: true,
  payment_fees: false,
  dispute_fees: false,
  payout: false,
  dodo_credits: true,
};

function entry(type: string, amount: number, at: string | number, o: Json = {}): Json {
  return {
    ...clone(ledgerEntryFx),
    id: nextId('led'),
    event_type: type,
    amount,
    is_credit: CREDIT[type] ?? true,
    created_at: typeof at === 'number' ? iso(at) : at,
    ...o,
  };
}

function expectDodoCalls(calls: RecordedCall[], key = LIVE_KEY, base = DODO_LIVE_BASE): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.method).toBe('GET');
    expect(c.url.startsWith(`${base}/`)).toBe(true);
    expect(c.headers['authorization']).toBe(`Bearer ${key}`);
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

describe('dodo verify', () => {
  const okRoutes = () => [
    route('/subscriptions', { json: list([sub()]) }, { query: { page_size: '1' } }),
    route('/balances/ledger', { json: list([clone(ledgerEntryFx)]) }, { query: { page_size: '1' } }),
  ];

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['header prefix pasted', `Bearer ${LIVE_KEY}`],
    ['unknown mode', 'dodo_prod_FakeKey000000000000'],
    ['prefix only', 'dodo_live_'],
    ['inner whitespace', 'dodo_live_Fake Key0000'],
    ['Stripe key', 'sk_live_51FakeKeyForTestsOnly0000'],
    ['Creem key', 'creem_FakeKeyForTestsOnly0000000'],
    ['too short to be a key', 'abc123'],
  ])('rejects a %s key on the apiKey field without a network call', async (_label, key) => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await dodoAdapter.verify(input(key), makeCtx(fetch));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.field).toBe('apiKey');
    expect(res.error.length).toBeGreaterThan(10);
    expect(calls).toHaveLength(0);
  });

  it('accepts a live key with 2 authenticated reads on the live host', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const res = await dodoAdapter.verify(input(`  ${LIVE_KEY}  `), ctx);
    expect(res).toEqual({
      ok: true,
      accountLabel: 'Dodo Payments (live)',
      config: { testMode: 'false', revenueHistory: 'daily' },
      testMode: false,
      warnings: [],
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/subscriptions', '/balances/ledger']);
    expectDodoCalls(calls);
    expect(ctx.pageBudget).toBe(3);
    expectNoSecretsInLogs(ctx, [LIVE_KEY, ...PII]);
  });

  it('sends a dodo_test_ key to the test host and labels it test mode', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await dodoAdapter.verify(input(TEST_KEY), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, accountLabel: 'Dodo Payments (test mode)', testMode: true, config: { testMode: 'true' } });
    expectDodoCalls(calls, TEST_KEY, DODO_TEST_BASE);
  });

  it('finds the mode of an unprefixed (older) key: live 401, then test, and warns about its reach', async () => {
    const { fetch, calls } = fakeFetch([
      route('/subscriptions', (url) =>
        url.origin === DODO_LIVE_BASE ? { status: 401, json: error401Fx } : { json: list([sub()]) },
      ),
      route('/balances/ledger', { json: list([]) }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const res = await dodoAdapter.verify(input(LEGACY_KEY), ctx);
    expect(res).toEqual({
      ok: true,
      accountLabel: 'Dodo Payments (test mode)',
      config: { testMode: 'true', revenueHistory: 'daily' },
      testMode: true,
      warnings: [LEGACY_KEY_WARNING],
    });
    expect(calls.map((c) => `${new URL(c.url).origin}${new URL(c.url).pathname}`)).toEqual([
      `${DODO_LIVE_BASE}/subscriptions`,
      `${DODO_TEST_BASE}/subscriptions`,
      `${DODO_TEST_BASE}/balances/ledger`,
    ]);
    expectNoSecretsInLogs(ctx, [LEGACY_KEY]);
  });

  it('keeps an unprefixed key on the live host when live accepts it', async () => {
    const { fetch, calls } = fakeFetch(okRoutes());
    const res = await dodoAdapter.verify(input(LEGACY_KEY), makeCtx(fetch));
    expect(res).toMatchObject({ ok: true, testMode: false, config: { testMode: 'false' }, warnings: [LEGACY_KEY_WARNING] });
    expectDodoCalls(calls, LEGACY_KEY, DODO_LIVE_BASE);
    expect(calls).toHaveLength(2);
  });

  it('reports a rejected prefixed key (401) after one request, without trying the other host', async () => {
    const { fetch, calls } = fakeFetch([route('/subscriptions', { status: 401, json: error401WrongModeFx })]);
    const ctx = makeCtx(fetch);
    const res = await dodoAdapter.verify(input(LIVE_KEY), ctx);
    expect(res).toEqual({
      ok: false,
      field: 'apiKey',
      error: 'Dodo Payments rejected this key. Check that you copied all of it and that it hasn’t been deleted.',
    });
    expect(calls).toHaveLength(1);
    expectNoSecretsInLogs(ctx, [LIVE_KEY, LIVE_KEY.slice(10)]);
  });

  it('says both modes were tried when an unprefixed key is rejected everywhere', async () => {
    const { fetch, calls } = fakeFetch([route('/subscriptions', { status: 401, json: error401Fx })]);
    const res = await dodoAdapter.verify(input(LEGACY_KEY), makeCtx(fetch));
    expect(!res.ok && res.error).toMatch(/both live and test mode/);
    expect(calls).toHaveLength(2);
  });

  it('names the missing Balances permission with the scope from the 403 message', async () => {
    const { fetch } = fakeFetch([
      route('/subscriptions', { json: list([]) }),
      route('/balances/ledger', { status: 403, json: error403PermissionFx }),
    ]);
    const res = await dodoAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({
      ok: false,
      field: 'apiKey',
      error: 'The Dodo Payments key is missing the “Balances: Read” permission (balances:read).',
    });
  });

  it('names the missing Subscriptions permission when the 403 has no scope', async () => {
    const { fetch, calls } = fakeFetch([
      route('/subscriptions', { status: 403, json: { code: 'INSUFFICIENT_PERMISSION', message: 'Forbidden' } }),
    ]);
    const res = await dodoAdapter.verify(input(), makeCtx(fetch));
    expect(res).toEqual({ ok: false, field: 'apiKey', error: 'The Dodo Payments key is missing the “Subscriptions: Read” permission.' });
    expect(calls).toHaveLength(1);
  });

  it('explains an IP allowlist, and never echoes the IP from the message', async () => {
    const { fetch } = fakeFetch([route('/subscriptions', { status: 403, json: error403IpFx })]);
    const res = await dodoAdapter.verify(input(), makeCtx(fetch));
    expect(!res.ok && res.field).toBe('apiKey');
    expect(!res.ok && res.error).toMatch(/IP allowlist/);
    expect(!res.ok && res.error).not.toContain('203.0.113.7');
  });

  it('explains a live key on a business without live payments', async () => {
    const { fetch } = fakeFetch([route('/subscriptions', { status: 403, json: error403NotLiveFx })]);
    const res = await dodoAdapter.verify(input(), makeCtx(fetch));
    expect(!res.ok && res.error).toMatch(/Live payments aren’t enabled/);
  });

  it('throws transient upstream failures for the caller to describe', async () => {
    const { fetch, calls } = fakeFetch([route('/subscriptions', { status: 500, json: error500Fx })]);
    const err = await catchErr(dodoAdapter.verify(input(), makeCtx(fetch)));
    expect(err.kind).toBe('upstream');
    expect(calls).toHaveLength(3); // fetchJson's retries
  });
});

// ---------- fetchSnapshot ----------

/** Serves `subs` for status=active and `pastDue` for status=past_due, in pages of 100. */
function subscriptionRoutes(active: Json[], pastDue: Json[] = []) {
  const pageOf = (items: Json[]) => (url: URL) => {
    const n = Number(url.searchParams.get('page_number'));
    return { json: list(items.slice(n * 100, n * 100 + 100)) };
  };
  return [
    route('/subscriptions', pageOf(active), { query: { status: 'active', page_size: '100' } }),
    route('/subscriptions', pageOf(pastDue), { query: { status: 'past_due', page_size: '100' } }),
  ];
}

const daysAgo = (n: number) => iso(NOW - n * DAY);

describe('dodo fetchSnapshot', () => {
  it('reads the docs-shaped subscription as 29.00 USD MRR, listing active then past_due, without keeping PII', async () => {
    const { fetch, calls } = fakeFetch(subscriptionRoutes([sub()]));
    const ctx = makeCtx(fetch);
    const snap = await dodoAdapter.fetchSnapshot(input(), ctx);
    expect(snap).toEqual({
      mrr: { USD: 2900 },
      activeSubscriptions: 1,
      activeTrials: 0,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      subscriptions: [{ id: expect.any(String), currency: 'USD', mrr: 2900 }],
    });
    expectSubscriptionsAddUp(snap);
    expect(calls.map((c) => new URL(c.url).search)).toEqual([
      '?status=active&page_size=100&page_number=0',
      '?status=past_due&page_size=100&page_number=0',
    ]);
    expectDodoCalls(calls);
    expectNoSecretsInLogs(ctx, [LIVE_KEY, ...PII]);
  });

  it('normalizes payment_frequency_interval/count to a month and treats the amount as per payment (not × quantity)', async () => {
    const subs = [
      sub({ recurring_pre_tax_amount: 2900, payment_frequency_interval: 'Month', payment_frequency_count: 1 }),
      sub({ recurring_pre_tax_amount: 29000, payment_frequency_interval: 'Year', payment_frequency_count: 1 }),
      sub({ recurring_pre_tax_amount: 9000, payment_frequency_interval: 'Month', payment_frequency_count: 3 }),
      sub({ recurring_pre_tax_amount: 1000, payment_frequency_interval: 'Week', payment_frequency_count: 2 }),
      sub({ recurring_pre_tax_amount: 100, payment_frequency_interval: 'Day', payment_frequency_count: 1 }),
      sub({ recurring_pre_tax_amount: 5000, quantity: 5 }),
      sub({ recurring_pre_tax_amount: 1200, payment_frequency_count: 0 }), // invalid count → 1
      sub({ recurring_pre_tax_amount: 1500, currency: 'JPY' }),
      sub({ recurring_pre_tax_amount: 1900, currency: 'eur' }),
    ];
    const { fetch } = fakeFetch(subscriptionRoutes(subs));
    const snap = await dodoAdapter.fetchSnapshot(input(), makeCtx(fetch));
    // 2900 + round(29000/12)=2417 + 3000 + round(1000×52/12/2)=2167 + round(100×365/12)=3042 + 5000 + 1200
    expect(snap.mrr).toEqual({ USD: 2900 + 2417 + 3000 + 2167 + 3042 + 5000 + 1200, JPY: 1500, EUR: 1900 });
    expect(snap.activeSubscriptions).toBe(9);
  });

  it('infers trials from next_billing_date inside the trial window (free and paid), and counts converted ones as paying', async () => {
    const created = (n: number) => NOW - n * DAY;
    const subs = [
      // Free trial, day 3 of 14: next charge is the trial end.
      sub({ trial_period_days: 14, created_at: iso(created(3)), next_billing_date: iso(created(3) + 14 * DAY) }),
      // Paid trial (trial_amount charged upfront) is still a trial.
      sub({ trial_period_days: 7, trial_amount: 500, created_at: iso(created(1)), next_billing_date: iso(created(1) + 7 * DAY) }),
      // No next_billing_date: falls back to created_at + trial_period_days > now.
      sub({ trial_period_days: 14, created_at: iso(created(2)), next_billing_date: null }),
      // Converted: the first full charge moved next_billing_date a period past the trial end.
      sub({ trial_period_days: 14, created_at: iso(created(20)), next_billing_date: iso(created(20) + 44 * DAY) }),
      // Trial extended by the merchant (next_billing_date moved later): reads as paying (documented limitation).
      sub({ trial_period_days: 14, created_at: iso(created(3)), next_billing_date: iso(created(3) + 30 * DAY) }),
    ];
    const { fetch } = fakeFetch(subscriptionRoutes(subs));
    const snap = await dodoAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ USD: 5800 });
    expect(snap).toMatchObject({ activeSubscriptions: 2, activeTrials: 3 });
  });

  it('allows one hour of slack after the trial end, and not a second more', () => {
    const created = NOW - 3 * DAY;
    const trialEnd = created + 14 * DAY;
    const withNext = (next: number) => sub({ trial_period_days: 14, created_at: iso(created), next_billing_date: iso(next) });
    expect(classifySubscription(withNext(trialEnd + 60 * 60_000), NOW)).toEqual({ kind: 'trial' });
    expect(classifySubscription(withNext(trialEnd + 60 * 60_000 + 1000), NOW)).toMatchObject({ kind: 'paying', monthly: 2900 });
    // trial_period_days = 0 is "no trial", whatever next_billing_date says.
    expect(classifySubscription(sub({ trial_period_days: 0, created_at: iso(created), next_billing_date: iso(created) }), NOW)).toMatchObject({ kind: 'paying' });
  });

  it('counts past_due and cancel-at-period-end; leaves $0, on-demand and unreadable subscriptions out of MRR and the count', async () => {
    const subs = [
      sub({ cancel_at_next_billing_date: true }),
      sub({ tax_inclusive: true, recurring_pre_tax_amount: 1210 }),
      sub({ recurring_pre_tax_amount: 0 }),
      sub({ on_demand: true, recurring_pre_tax_amount: 2500 }),
      sub({ recurring_pre_tax_amount: 12.5 }),
      sub({ payment_frequency_interval: 'Fortnight' }),
      sub({ currency: null }),
      sub({ status: 'on_hold' }), // not asked for; ignored if the listing ever returns it
    ];
    const pastDue = [sub({ status: 'past_due', recurring_pre_tax_amount: 1000 })];
    const { fetch } = fakeFetch(subscriptionRoutes(subs, pastDue));
    const ctx = makeCtx(fetch);
    const snap = await dodoAdapter.fetchSnapshot(input(), ctx);
    expect(snap.mrr).toEqual({ USD: 2900 + 1210 + 1000 });
    expect(snap).toMatchObject({ activeSubscriptions: 3, activeTrials: 0 });
    expect(ctx.logs.find((l) => l.event === 'dodo_snapshot')?.data).toMatchObject({
      listed: 9,
      zero: 1,
      onDemand: 1,
      unpriced: 3,
      notActive: 1,
      taxInclusive: 1,
      cancelling: 1,
    });
  });

  it('pages each status listing until a short page, and counts a subscription seen in both listings once', async () => {
    const active = Array.from({ length: 103 }, () => sub({ recurring_pre_tax_amount: 100 }));
    const moved = active[5]!;
    const pastDue = [{ ...moved, status: 'past_due' }, sub({ status: 'past_due', recurring_pre_tax_amount: 100 })];
    const { fetch, calls } = fakeFetch(subscriptionRoutes(active, pastDue));
    const snap = await dodoAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ USD: 104 * 100 });
    expect(snap.activeSubscriptions).toBe(104);
    expect(calls.map((c) => new URL(c.url).searchParams.get('page_number'))).toEqual(['0', '1', '0']);
  });

  it('asks for one more page after an exactly full one, and stops on the empty page', async () => {
    const active = Array.from({ length: 100 }, () => sub({ recurring_pre_tax_amount: 100 }));
    const { fetch, calls } = fakeFetch(subscriptionRoutes(active));
    const snap = await dodoAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(snap.mrr).toEqual({ USD: 100 * 100 });
    expect(calls.map((c) => `${new URL(c.url).searchParams.get('status')}#${new URL(c.url).searchParams.get('page_number')}`)).toEqual([
      'active#0',
      'active#1',
      'past_due#0',
    ]);
  });

  it('throws a revoked key (401) as auth on apiKey, and an unreadable 200 as upstream', async () => {
    const revoked = fakeFetch([route('/subscriptions', { status: 401, json: error401Fx })]);
    expect(await catchErr(dodoAdapter.fetchSnapshot(input(), makeCtx(revoked.fetch)))).toMatchObject({ kind: 'auth', field: 'apiKey' });

    const odd = fakeFetch([route('/subscriptions', { json: { data: [sub()] } })]);
    const err = await catchErr(dodoAdapter.fetchSnapshot(input(), makeCtx(odd.fetch)));
    expect(err).toMatchObject({ kind: 'upstream', message: expect.stringMatching(/couldn’t read/) });
  });

  it('uses the mode stored by verify for an unprefixed key; a prefix always wins', async () => {
    const a = fakeFetch(subscriptionRoutes([sub()]));
    await dodoAdapter.fetchSnapshot(input(LEGACY_KEY, { testMode: 'true' }), makeCtx(a.fetch));
    expectDodoCalls(a.calls, LEGACY_KEY, DODO_TEST_BASE);

    const b = fakeFetch(subscriptionRoutes([sub()]));
    await dodoAdapter.fetchSnapshot(input(LIVE_KEY, { testMode: 'true' }), makeCtx(b.fetch));
    expectDodoCalls(b.calls, LIVE_KEY, DODO_LIVE_BASE);
  });

  it('lets BudgetExhaustedError propagate instead of returning a partial MRR', async () => {
    const active = Array.from({ length: 250 }, () => sub());
    const { fetch } = fakeFetch(subscriptionRoutes(active));
    await expect(dodoAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: 2 }))).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it(`stops after ${DODO_SNAPSHOT_PAGE_BUDGET} requests whatever the sync allows, so one sync stays under 240 a minute`, async () => {
    const full = list(Array.from({ length: 100 }, () => sub())); // every page full: the listing never ends
    const { fetch, calls } = fakeFetch([route('/subscriptions', { json: full }, { query: { status: 'active' } })]);
    const err = await catchErr(dodoAdapter.fetchSnapshot(input(), makeCtx(fetch, { pageBudget: SNAPSHOT_PAGE_BUDGET })));
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).reason).toBe('budget');
    expect(calls).toHaveLength(DODO_SNAPSHOT_PAGE_BUDGET);
    // With the revenue phase right after it, at most 3/4 of the limit every key of the business shares.
    expect(DODO_SNAPSHOT_PAGE_BUDGET + REVENUE_PAGE_BUDGET).toBeLessThanOrEqual(0.75 * 240);
  });

  it('refuses a malformed key without a network call', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await catchErr(dodoAdapter.fetchSnapshot(input('sk_live_FakeNotDodo000000'), makeCtx(fetch)));
    expect(err.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('classifySubscription: statuses other than active / past_due never count', () => {
    for (const status of ['pending', 'on_hold', 'paused', 'cancelled', 'failed', 'expired']) {
      expect(classifySubscription(sub({ status }), NOW)).toEqual({ kind: 'not_active' });
    }
  });
});

// ---------- fetchRevenue ----------

/** Ledger route answering by slice (created_at_gte) and page. `slices` maps a gte ISO string to its entries. */
function ledgerRoute(slices: Record<string, Json[]>, seen: string[] = []) {
  return route('/balances/ledger', (url) => {
    const gte = url.searchParams.get('created_at_gte') ?? '';
    const page = Number(url.searchParams.get('page_number'));
    seen.push(`${gte}..${url.searchParams.get('created_at_lte')}#${page}`);
    const items = slices[gte] ?? [];
    return { json: list(items.slice(page * 100, page * 100 + 100)) };
  }, { query: { page_size: '100' } });
}

const at = (day: string, hhmm = '09:00') => `${day}T${hhmm}:00Z`;
/** Drops the 0 USD points of days without revenue entries. */
const withRevenue = (daily: Array<{ gross: number; refunds: number; count: number }>) =>
  daily.filter((p) => p.gross !== 0 || p.refunds !== 0 || p.count !== 0);

describe('dodo fetchRevenue', () => {
  it('aggregates ledger entries per UTC day and wallet currency, without tax, fees or payouts', async () => {
    const since = Date.parse('2026-11-03T15:30:00Z'); // read from that day's midnight
    const entries = [
      entry('payment', 12000, at('2026-11-05'), { description: 'Payment from jane.fake@example.com' }),
      entry('tax', 2000, at('2026-11-05')),
      entry('payment_fees', 600, at('2026-11-05')),
      entry('payment', 5000, at('2026-11-05', '10:00'), { currency: 'EUR' }), // no tax (e.g. reverse charge)
      entry('payment', 6000, at('2026-11-04')),
      entry('tax', 1000, at('2026-11-04')),
      entry('refund', 3000, at('2026-11-04', '12:00')),
      entry('tax_reversal', 500, at('2026-11-04', '12:00')),
      entry('dispute', 2400, at('2026-11-04', '13:00')),
      entry('dispute_fees', 1500, at('2026-11-04', '13:00')),
      entry('dispute_reversal', 2400, at('2026-11-03')), // won: money back
      entry('refund_reversal', 1000, at('2026-11-03')),
      entry('payout', 100000, at('2026-11-03')),
      entry('dodo_credits', 700, at('2026-11-03')),
      entry('adjustment', 50, at('2026-11-03')),
      entry('payment', 9999, '2026-11-02T23:59:59Z'), // before the window's first day
      entry('payment', 1, at('2026-11-05'), { amount: 12.5 }), // not minor units → skipped
    ];
    const seen: string[] = [];
    const { fetch, calls } = fakeFetch([ledgerRoute({ '2026-11-03T00:00:00.000Z': entries }, seen)]);
    const ctx = makeCtx(fetch, { pageBudget: 20 });
    const page = await dodoAdapter.fetchRevenue(input(), { since, cursor: null }, ctx);

    expect(page).toEqual({
      events: [],
      daily: [
        // −1000 refund reversal − 2400 dispute reversal: money back, booked as gross.
        { day: '2026-11-03', currency: 'USD', gross: 3400, refunds: 0, count: 0 },
        // 6000 − 1000 tax; 3000 refund − 500 tax back + 2400 dispute.
        { day: '2026-11-04', currency: 'USD', gross: 5000, refunds: 4900, count: 3 },
        { day: '2026-11-05', currency: 'EUR', gross: 5000, refunds: 0, count: 1 },
        { day: '2026-11-05', currency: 'USD', gross: 10000, refunds: 0, count: 1 },
      ],
      nextCursor: null,
      done: true,
    });
    expect(seen).toEqual([`2026-11-03T00:00:00.000Z..${iso(NOW)}#0`]);
    expectDodoCalls(calls);
    expect(JSON.stringify(page)).not.toContain('example.com');
    expectNoSecretsInLogs(ctx, [LIVE_KEY, ...PII]);
    expect(ctx.logs.find((l) => l.event === 'dodo_revenue')?.data).toMatchObject({
      pages: 1,
      entries: 17,
      ignored: { payment_fees: 1, dispute_fees: 1, payout: 1, dodo_credits: 1, adjustment: 1 },
      outside: 1,
      malformed: 1,
      directionMismatch: 0,
      done: true,
    });
  });

  it('keeps a day’s net exact when a tax entry lands on the next day', async () => {
    const entries = [entry('payment', 1200, '2026-11-04T23:59:59Z'), entry('tax', 200, '2026-11-05T00:00:01Z')];
    const { fetch } = fakeFetch([ledgerRoute({ '2026-11-04T00:00:00.000Z': entries })]);
    const page = await dodoAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-04T00:00:00Z'), cursor: null }, makeCtx(fetch));
    expect(page.daily).toEqual([
      { day: '2026-11-04', currency: 'USD', gross: 1200, refunds: 0, count: 1 },
      { day: '2026-11-05', currency: 'USD', gross: 0, refunds: 200, count: 0 },
    ]);
  });

  it('reports each read day without revenue entries as 0 USD, so an idle account still has history', async () => {
    const { fetch } = fakeFetch([ledgerRoute({ '2026-11-03T00:00:00.000Z': [entry('payout', 5000, at('2026-11-04'))] })]);
    const page = await dodoAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-03T08:00:00Z'), cursor: null }, makeCtx(fetch));
    expect(page.daily).toEqual(
      ['2026-11-03', '2026-11-04', '2026-11-05'].map((day) => ({ day, currency: 'USD', gross: 0, refunds: 0, count: 0 })),
    );
  });

  it('walks a 90-day backfill in 7-day slices, newest first, each bounded by midnights', async () => {
    const since = Date.parse('2026-08-08T00:00:00Z'); // 90 days ending 2026-11-05
    const seen: string[] = [];
    const { fetch } = fakeFetch([
      ledgerRoute(
        {
          '2026-10-30T00:00:00.000Z': [entry('payment', 100, at('2026-11-01'))],
          '2026-08-08T00:00:00.000Z': [entry('payment', 300, at('2026-08-08')), entry('payment', 400, at('2026-08-15'))],
        },
        seen,
      ),
    ]);
    const page = await dodoAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch, { pageBudget: 20 }));
    expect(seen).toHaveLength(13);
    expect(seen[0]).toBe(`2026-10-30T00:00:00.000Z..${iso(NOW)}#0`);
    expect(seen[1]).toBe('2026-10-23T00:00:00.000Z..2026-10-30T00:00:00.000Z#0');
    expect(seen[12]).toBe('2026-08-08T00:00:00.000Z..2026-08-14T00:00:00.000Z#0');
    // 2026-08-15 belongs to the next slice, so the oldest slice drops it as outside its days.
    expect(page.daily).toHaveLength(90); // every day of the window, empty ones as 0 USD
    expect(withRevenue(page.daily)).toEqual([
      { day: '2026-11-01', currency: 'USD', gross: 100, refunds: 0, count: 1 },
      { day: '2026-08-08', currency: 'USD', gross: 300, refunds: 0, count: 1 },
    ]);
    expect(page.done).toBe(true);
  });

  it('resumes mid-slice from its cursor with the partial sums, in the window frozen by the first call', async () => {
    const since = Date.parse('2026-11-01T00:00:00Z');
    const full = Array.from({ length: 100 }, (_, i) => entry('payment', 10, NOW - (i + 1) * 60_000));
    const rest = [entry('payment', 1000, at('2026-11-02')), entry('tax', 100, at('2026-11-02'))];
    const routes = () => [ledgerRoute({ '2026-11-01T00:00:00.000Z': [...full, ...rest] })];

    const first = fakeFetch(routes());
    const ctx1 = makeCtx(first.fetch, { pageBudget: 1 });
    const r1 = await dodoAdapter.fetchRevenue(input(), { since, cursor: null }, ctx1);
    expect(r1).toMatchObject({ events: [], daily: [], done: false });
    expect(first.calls).toHaveLength(1);
    expect(decodeCursor(r1.nextCursor)).toMatchObject({ first: '2026-11-01', to: '2026-11-05', page: 1, end: NOW });

    // Later, with another `since` from the engine: the cursor's window wins.
    const second = fakeFetch(routes());
    const r2 = await dodoAdapter.fetchRevenue(input(), { since: since + 3 * DAY, cursor: r1.nextCursor }, makeCtx(second.fetch, { now: NOW + 3_600_000 }));
    expect(r2).toMatchObject({ events: [], nextCursor: null, done: true });
    expect(r2.daily).toHaveLength(5);
    expect(withRevenue(r2.daily)).toEqual([
      { day: '2026-11-02', currency: 'USD', gross: 900, refunds: 0, count: 1 },
      { day: '2026-11-05', currency: 'USD', gross: 1000, refunds: 0, count: 100 },
    ]);
    const url = new URL(second.calls[0]!.url);
    expect(url.searchParams.get('page_number')).toBe('1');
    expect(url.searchParams.get('created_at_lte')).toBe(iso(NOW));
  });

  it('on 429 keeps the finished slices, returns its cursor and stops spending budget', async () => {
    const since = Date.parse('2026-10-20T00:00:00Z');
    let hits = 0;
    const { fetch, calls } = fakeFetch([
      route('/balances/ledger', (url) => {
        hits += 1;
        if (url.searchParams.get('created_at_gte') === '2026-10-30T00:00:00.000Z') {
          return { json: list([entry('payment', 500, at('2026-11-04'))]) };
        }
        return { status: 429, json: { code: 'TOO_MANY_REQUESTS', message: null }, headers: { 'x-ratelimit-reset': '42' } };
      }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 20 });
    const r = await dodoAdapter.fetchRevenue(input(), { since, cursor: null }, ctx);
    expect(r.daily).toHaveLength(7);
    expect(withRevenue(r.daily)).toEqual([{ day: '2026-11-04', currency: 'USD', gross: 500, refunds: 0, count: 1 }]);
    expect(r.done).toBe(false);
    expect(decodeCursor(r.nextCursor)).toMatchObject({ first: '2026-10-20', to: '2026-10-29', page: 0, acc: {} });
    expect(ctx.pageBudget).toBe(0);
    expect(hits).toBe(2);
    expect(calls).toHaveLength(2);
    expect(ctx.logs.find((l) => l.event === 'dodo_revenue')?.data).toMatchObject({ reason: 'rate_limited' });
  });

  it('returns a fresh cursor without calling Dodo when no budget is left, and resumes from it', async () => {
    const { fetch, calls } = fakeFetch([]);
    const r = await dodoAdapter.fetchRevenue(input(), { since: NOW - DAY, cursor: null }, makeCtx(fetch, { pageBudget: 0 }));
    expect(r).toMatchObject({ events: [], daily: [], done: false });
    expect(calls).toHaveLength(0);

    const second = fakeFetch([ledgerRoute({ '2026-11-04T00:00:00.000Z': [entry('payment', 700, at('2026-11-05'))] })]);
    const r2 = await dodoAdapter.fetchRevenue(input(), { since: 0, cursor: r.nextCursor }, makeCtx(second.fetch, { now: NOW + 999_000 }));
    expect(r2).toEqual({
      events: [],
      daily: [
        { day: '2026-11-04', currency: 'USD', gross: 0, refunds: 0, count: 0 },
        { day: '2026-11-05', currency: 'USD', gross: 700, refunds: 0, count: 1 },
      ],
      nextCursor: null,
      done: true,
    });
  });

  it('restarts from `since` when handed a cursor it did not write', async () => {
    const { fetch, calls } = fakeFetch([ledgerRoute({})]);
    const ctx = makeCtx(fetch);
    const bad = [
      'not json',
      '{"v":2}',
      JSON.stringify({ v: 1, first: '2026-11-04', end: NOW, to: '2026-11-03', page: 0, acc: {} }), // to < first
      JSON.stringify({ v: 1, first: '2026-11-04', end: NOW, to: '2026-11-05', page: -1, acc: {} }),
      JSON.stringify({ v: 1, first: '2026-11-04', end: NOW, to: '2026-11-05', page: 0, acc: { 'x|USD': [0, 0, 0, 0, 0, 0, 0, 0] } }),
      JSON.stringify({ v: 1, first: '2026-11-04', end: NOW, to: '2026-11-05', page: 0, acc: { '2026-11-05|USD': [1, 2] } }),
    ];
    for (const cursor of bad) {
      const r = await dodoAdapter.fetchRevenue(input(), { since: NOW - DAY, cursor }, ctx);
      expect(r.done).toBe(true);
    }
    expect(calls).toHaveLength(bad.length);
    expect(ctx.logs.filter((l) => l.event === 'dodo_cursor_invalid')).toHaveLength(bad.length);
  });

  it('counts entries whose is_credit contradicts the documented direction, using the documented one', async () => {
    const { fetch } = fakeFetch([ledgerRoute({ '2026-11-05T00:00:00.000Z': [entry('payment', -800, at('2026-11-05'), { is_credit: false })] })]);
    const ctx = makeCtx(fetch);
    const r = await dodoAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-05T01:00:00Z'), cursor: null }, ctx);
    expect(r.daily).toEqual([{ day: '2026-11-05', currency: 'USD', gross: 800, refunds: 0, count: 1 }]);
    expect(ctx.logs.find((l) => l.event === 'dodo_revenue')?.data).toMatchObject({ directionMismatch: 1 });
  });

  it('reads one more (empty) page after an exactly full one, without counting anything twice', async () => {
    const full = Array.from({ length: 100 }, (_, i) => entry('payment', 10, NOW - (i + 1) * 60_000));
    const seen: string[] = [];
    const { fetch } = fakeFetch([ledgerRoute({ '2026-11-05T00:00:00.000Z': full }, seen)]);
    const page = await dodoAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-05T00:00:00Z'), cursor: null }, makeCtx(fetch));
    expect(page).toEqual({ events: [], daily: [{ day: '2026-11-05', currency: 'USD', gross: 1000, refunds: 0, count: 100 }], nextCursor: null, done: true });
    expect(seen.map((s) => s.split('#')[1])).toEqual(['0', '1']);
  });

  it('throws a persistent 5xx (after retries) instead of returning a cursor or a finished page', async () => {
    const { fetch, calls } = fakeFetch([route('/balances/ledger', { status: 500, json: error500Fx })]);
    const err = await catchErr(dodoAdapter.fetchRevenue(input(), { since: NOW - DAY, cursor: null }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'upstream', status: 500 });
    expect(calls).toHaveLength(3);
  });

  it('refuses a 200 ledger page without `items` instead of writing 0 USD days', async () => {
    const { fetch } = fakeFetch([route('/balances/ledger', { json: { entries: [] } })]);
    const err = await catchErr(dodoAdapter.fetchRevenue(input(), { since: NOW - DAY, cursor: null }, makeCtx(fetch)));
    expect(err).toMatchObject({ kind: 'upstream', message: expect.stringMatching(/couldn’t read/) });
  });

  it('reads a test mode key’s ledger on the test host', async () => {
    const { fetch, calls } = fakeFetch([ledgerRoute({})]);
    await dodoAdapter.fetchRevenue(input(TEST_KEY), { since: NOW - DAY, cursor: null }, makeCtx(fetch));
    expectDodoCalls(calls, TEST_KEY, DODO_TEST_BASE);
  });

  it('refuses a malformed key without a network call', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await catchErr(dodoAdapter.fetchRevenue(input(''), { since: NOW - DAY, cursor: null }, makeCtx(fetch)));
    expect(err.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});
