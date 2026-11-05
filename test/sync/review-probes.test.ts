/**
 * Adversarial review probes (security + SRE review of the Data Plane, 2026-11-05).
 *
 * Every test here reproduced a finding from the review report (originally as `it.fails`). All findings
 * are fixed, so each probe now asserts the correct behaviour as a regression test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptJson } from '../../src/lib/crypto';
import { DAY, HOUR, MINUTE, dayKey } from '../../src/lib/time';
import { lemonSqueezyAdapter } from '../../src/providers/lemonsqueezy';
import { rotateCredentials } from '../../src/services/connections';
import { runScheduledSync, syncConnection } from '../../src/sync/engine';
import { getLatestFx, refreshFx } from '../../src/sync/fx';
import { TEST_ENCRYPTION_KEY, createTestD1, seedConnection, seedUser } from '../fixtures/d1';
import { fakeFetch, makeCtx, route, type FakeResponse } from '../fixtures/harness';
import { FX_BODY, NOW, conn, runs, setCursorState, setup, teardown, txRows } from './helpers';

afterEach(() => {
  teardown();
});

const iso = (ms: number) => new Date(ms).toISOString();
const emptyStripeList = { object: 'list', data: [], has_more: false };

function execCtx(pending: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------------------------
// FINDING 1 (high): cron starvation. selectDueConnections orders by COALESCE(last_synced_at, 0), and a
// failing sync never advances last_synced_at, so permanently failing connections always sort first.
// With a 60-min interval on a 30-min cron, each failing connection is due every other tick, so 20 of
// them fill all 10 slots of every tick and healthy connections (of any tenant) are never synced.
// ---------------------------------------------------------------------------------------------

describe('probe: cron fairness', () => {
  it('20 dead connections of one tenant must not starve a healthy connection of another tenant', async () => {
    const c = setup();
    seedUser(c.t, { id: 'attacker' });
    for (let i = 0; i < 20; i++) {
      seedConnection(c.t, {
        id: `dead-${String(i).padStart(2, '0')}`,
        userId: 'attacker',
        provider: 'stripe',
        credentialsEnc: 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB', // undecryptable ≈ revoked key: fails fast, forever
        status: 'error',
        createdAt: i,
      });
    }
    seedConnection(c.t, {
      id: 'victim',
      userId: c.userId,
      provider: 'demo',
      config: { seed: 'victim', anchor: '2026-08-01' },
      status: 'ok',
      lastSyncedAt: NOW - 2 * HOUR,
      lastSyncStartedAt: NOW - 2 * HOUR,
      createdAt: 100,
    });

    // Three hours of cron ticks (*/30), each starting a couple of seconds after the tick.
    for (let tick = 0; tick <= 6; tick++) {
      const at = NOW + tick * 30 * MINUTE;
      vi.setSystemTime(at + 2_000);
      await runScheduledSync(c.env, at);
    }

    // Every dead connection is still retried (then backed off to 3 intervals, so far fewer than the
    // ~60 runs the old every-other-tick retry produced)…
    expect(new Set(runs(c.t).map((r) => r.connection_id)).size).toBe(21);
    // …and the healthy connection keeps its hourly cadence across the three hours.
    expect(runs(c.t, 'victim').length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------------------------
// FINDING 2 (medium): the snapshot has a hard 30-request budget and no cursor. A Stripe account with
// > ~2,900 active subscriptions (or ~30 distinct coupons / multi-currency prices) can never produce a
// snapshot; every sync fails with "…the next sync continues", which never happens.
// ---------------------------------------------------------------------------------------------

function stripeSub(i: number) {
  return {
    id: `sub_${i}`,
    currency: 'usd',
    discounts: [],
    items: {
      has_more: false,
      data: [
        {
          id: `si_${i}`,
          quantity: 1,
          discounts: [],
          price: {
            id: 'price_1',
            currency: 'usd',
            billing_scheme: 'per_unit',
            product: 'prod_1',
            recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
            unit_amount: 1000,
            unit_amount_decimal: '1000',
            transform_quantity: null,
          },
        },
      ],
    },
  };
}

describe('probe: snapshot budget', () => {
  it('a Stripe account with 3,000 active subscriptions eventually gets an MRR snapshot', async () => {
    const c = setup();
    const TOTAL = 3_000;
    const activePage = (url: URL): FakeResponse => {
      const after = url.searchParams.get('starting_after');
      const start = after ? Number(after.slice('sub_'.length)) + 1 : 0;
      const end = Math.min(TOTAL, start + 100);
      const data = [];
      for (let i = start; i < end; i++) data.push(stripeSub(i));
      return { json: { object: 'list', data, has_more: end < TOTAL } };
    };
    const { fetch } = fakeFetch([
      route('/v1/latest', { json: FX_BODY }),
      route('/v1/subscriptions', activePage, { query: { status: 'active' } }),
      route('/v1/subscriptions', { json: emptyStripeList }),
      route('/v1/balance_transactions', { json: emptyStripeList }),
    ]);
    vi.stubGlobal('fetch', fetch);
    seedConnection(c.t, {
      id: 'big',
      userId: c.userId,
      provider: 'stripe',
      credentialsEnc: await encryptJson(TEST_ENCRYPTION_KEY, { apiKey: 'rk_test_x' }),
      status: 'pending',
    });

    const first = await syncConnection(c.env, 'big', 'manual');
    vi.setSystemTime(NOW + 61 * MINUTE);
    const second = await syncConnection(c.env, 'big', 'cron');

    expect(conn(c.t, 'big').last_error ?? '').not.toContain('the next sync continues');
    expect(first.snapshot || second.snapshot).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// FINDING 3 (medium): Lemon Squeezy refunds made more than ~16 days after the purchase are never
// recorded. Incremental syncs only look at records created ≥ since − 14 d (since = high-water − 2 d),
// and LS lists have no "updated since" filter, so a refund on an older order is invisible.
// ---------------------------------------------------------------------------------------------

describe('probe: Lemon Squeezy late refunds', () => {
  it('an incremental sync records a refund issued yesterday on a 20-day-old order', async () => {
    const order = (id: string, created: number, attrs: Record<string, unknown> = {}) => ({
      type: 'orders',
      id,
      attributes: {
        store_id: 101,
        status: 'paid',
        currency: 'EUR',
        total: 1000,
        refunded_amount: 0,
        refunded_at: null,
        created_at: iso(created),
        updated_at: iso(created),
        test_mode: false,
        first_order_item: { product_name: 'Acme Pro', variant_name: 'Yearly' },
        ...attrs,
      },
    });
    const list = (data: unknown[]) => ({
      data,
      meta: { page: { currentPage: 1, lastPage: 1, perPage: 100, total: data.length } },
    });
    const { fetch } = fakeFetch([
      route(
        '/v1/orders',
        {
          json: list([
            order('9001', NOW - DAY),
            // 30-day money-back guarantee, used on day 19.
            order('9002', NOW - 20 * DAY, { status: 'refunded', total: 12000, refunded_amount: 12000, refunded_at: iso(NOW - DAY) }),
          ]),
        },
      ),
      route('/v1/subscription-invoices', { json: list([]) }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 20 });
    // Hourly incremental sync: high-water mark one hour ago → since = high-water − 2 days.
    const since = NOW - HOUR - 2 * DAY;
    const page = await lemonSqueezyAdapter.fetchRevenue(
      { credentials: { apiKey: 'eyJ.fake.key' }, config: { storeCurrencies: '{"101":"EUR"}', testMode: 'false' } },
      { since, cursor: null },
      ctx,
    );

    expect(page.done).toBe(true);
    expect(page.events.map((e) => e.externalId)).toContain('order:9002:refund');
  });
});

// ---------------------------------------------------------------------------------------------
// FINDING 4 (medium): rotating to a key of another mode/account keeps the old account's data and
// the high-water mark. Stripe test → live: test-mode revenue stays in the totals and the live
// account's 90-day history is never backfilled (since = old high-water − 2 days).
// ---------------------------------------------------------------------------------------------

describe('probe: key rotation across modes', () => {
  it('Stripe test → live rotation drops test-mode revenue and backfills the live account', async () => {
    const c = setup();
    const liveOld = { id: 'txn_live_old', object: 'balance_transaction', amount: 5000, created: Math.floor((NOW - 30 * DAY) / 1000), currency: 'usd', fee: 175, type: 'charge', reporting_category: 'charge' };
    const balance = (url: URL): FakeResponse => {
      const gte = Number(url.searchParams.get('created[gte]') ?? 0);
      return { json: { object: 'list', data: liveOld.created >= gte ? [liveOld] : [], has_more: false } };
    };
    const { fetch } = fakeFetch([
      route('/v1/latest', { json: FX_BODY }),
      route('/v1/subscriptions', { json: emptyStripeList }),
      route('/v1/prices', { json: emptyStripeList }),
      route('/v1/balance_transactions', balance),
      route('/v1/coupons', { json: emptyStripeList }),
    ]);
    vi.stubGlobal('fetch', fetch);

    seedConnection(c.t, {
      id: 'rot',
      userId: c.userId,
      provider: 'stripe',
      credentialsEnc: await encryptJson(TEST_ENCRYPTION_KEY, { apiKey: 'rk_test_x' }),
      status: 'ok',
      testMode: true,
      lastSyncedAt: NOW - HOUR,
      lastSyncStartedAt: NOW - 2 * HOUR,
    });
    setCursorState(c.t, 'rot', null, NOW - HOUR);
    c.t.exec(
      `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
       VALUES ('rot', 'txn_test_1', ?, 'charge', 999900, 'USD', NULL, NULL)`,
      NOW - 3 * DAY,
    );

    const pending: Promise<unknown>[] = [];
    const r = await rotateCredentials(c.env, execCtx(pending), c.userId, 'rot', { apiKey: 'rk_live_abc' });
    expect(r.ok).toBe(true);
    await Promise.all(pending);

    const ids = txRows(c.t, 'rot').map((x) => x.externalId);
    expect(ids).toContain('txn_live_old'); // live history within the 90-day window is fetched
    expect(ids).not.toContain('txn_test_1'); // test-mode revenue no longer counts
  });
});

// ---------------------------------------------------------------------------------------------
// FINDING 6 (medium/low): an empty/partial RevenueCat overview (HTTP 200, no metrics) overwrites a
// good snapshot for today with MRR {} and 0 subscriptions, and the sync reports success. The engine's
// cleanSnapshot guard against "false dips" is bypassed because the adapter turns "missing" into 0.
// ---------------------------------------------------------------------------------------------

describe('probe: RevenueCat garbage overview', () => {
  it('a 200 overview without metrics does not silently zero today’s MRR', async () => {
    const c = setup();
    const PROJECT = 'proj1ab2c3d4';
    const { fetch } = fakeFetch([
      route('/v1/latest', { json: FX_BODY }),
      route(`/v2/projects/${PROJECT}/metrics/overview`, { json: { object: 'overview_metrics', metrics: [], currency: 'USD' } }),
      route(new RegExp(`^/v2/projects/${PROJECT}/charts/`), { status: 403, json: { message: 'forbidden' } }),
    ]);
    vi.stubGlobal('fetch', fetch);
    seedConnection(c.t, {
      id: 'rc',
      userId: c.userId,
      provider: 'revenuecat',
      credentialsEnc: await encryptJson(TEST_ENCRYPTION_KEY, { apiKey: `sk_${'a'.repeat(32)}` }),
      config: { projectId: PROJECT },
      status: 'ok',
      lastSyncedAt: NOW - 2 * HOUR,
      lastSyncStartedAt: NOW - 2 * HOUR,
    });
    c.t.exec(
      `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, captured_at)
       VALUES ('rc', ?, '{"USD":500000}', 120, 4, ?)`,
      dayKey(NOW),
      NOW - 2 * HOUR,
    );

    await syncConnection(c.env, 'rc', 'manual');

    const snap = c.t.rows<{ mrr: string; active_subscriptions: number }>(
      'SELECT mrr, active_subscriptions FROM snapshots WHERE connection_id = ? AND day = ?',
      'rc',
      dayKey(NOW),
    )[0]!;
    const flagged = conn(c.t, 'rc').status === 'error';
    expect(flagged || snap.mrr === '{"USD":500000}').toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// FINDING 7 (low): one frankfurter response with a bogus future `date` pins the FX table forever:
// LATEST_FX_SQL orders by `day`, so later correct rows never become "latest".
// ---------------------------------------------------------------------------------------------

describe('probe: FX table pinning', () => {
  it('a bogus future-dated payload is rejected and a correct refresh becomes the latest table', async () => {
    const t = createTestD1();
    const bad = fakeFetch([route('/v1/latest', { json: { amount: 1, base: 'USD', date: '2099-12-31', rates: { EUR: 92 } } })]);
    await expect(refreshFx(t.db, bad.fetch, NOW)).rejects.toThrow(/future-dated/);
    const good = fakeFetch([route('/v1/latest', { json: FX_BODY })]);
    await refreshFx(t.db, good.fetch, NOW + DAY);

    const latest = await getLatestFx(t.db);
    expect(latest?.rates['EUR']).toBe(0.92);
  });
});
