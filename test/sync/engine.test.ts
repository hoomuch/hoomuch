import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoAdapter } from '../../src/providers/demo';
import { BudgetExhaustedError, fetchJson, hasBudget } from '../../src/providers/http';
import { revenueCatAdapter } from '../../src/providers/revenuecat';
import { stripeAdapter } from '../../src/providers/stripe';
import {
  ProviderError,
  type ProviderContext,
  type RevenueEvent,
  type RevenuePage,
  type RevenueRequest,
} from '../../src/providers/types';
import { DAY, HOUR, MINUTE, addDays, dayKey, dayStart } from '../../src/lib/time';
import { dailyFromEvents, decodeBackfill } from '../../src/sync/aggregate';
import {
  BACKFILL_CONTINUES_MESSAGE,
  CRON_SYNC_DEADLINE_MS,
  INTERACTIVE_SYNC_DEADLINE_MS,
  REVENUE_PAGE_BUDGET,
  SNAPSHOT_PAGE_BUDGET,
  SYNC_BUSY_MESSAGE,
  syncConnection,
  syncDeadlines,
  withDeadline,
} from '../../src/sync/engine';
import { INTERRUPTED_RUN_MESSAGE, SYNC_RUNS_KEPT } from '../../src/sync/repo';
import { DECRYPT_ERROR } from '../../src/sync/errors';
import { encryptJson } from '../../src/lib/crypto';
import { TEST_ENCRYPTION_KEY, seedConnection } from '../fixtures/d1';
import { fakeFetch, makeCtx, route } from '../fixtures/harness';
import {
  FX_BODY,
  NOW,
  SECRET,
  SNAP,
  charge,
  conn,
  dailyRows,
  daysAgo,
  encryptedCreds,
  page,
  refund,
  runs,
  seedStripe,
  setCursorState,
  setup,
  teardown,
  txRows,
  type Ctx,
} from './helpers';

const DEMO_CONFIG = { seed: 'sync-test', anchor: '2026-08-01' };
const FIRST_SINCE = dayStart(addDays(dayKey(NOW), -89)); // 90 days including today
const GENERIC_STRIPE = 'Something went wrong while syncing Stripe. The next sync will retry.';

let current: Ctx | null = null;
function ctx(opts?: Parameters<typeof setup>[0]): Ctx {
  current = setup(opts);
  return current;
}

afterEach(() => {
  // No test may ever print the API key, whatever path it took.
  const out = current?.out.join('\n') ?? '';
  current = null;
  teardown();
  expect(out).not.toContain(SECRET);
});

async function seedDemo(c: Ctx, id = 'demo-1'): Promise<void> {
  seedConnection(c.t, {
    id,
    userId: c.userId,
    provider: 'demo',
    credentialsEnc: await encryptedCreds({}),
    config: DEMO_CONFIG,
    status: 'pending',
  });
}

function expectDailyMatchesTransactions(c: Ctx, id: string): void {
  expect(dailyRows(c.t, id)).toEqual(dailyFromEvents(txRows(c.t, id)));
}

function stripeSnapshotOk() {
  return vi.spyOn(stripeAdapter, 'fetchSnapshot').mockResolvedValue(SNAP);
}

describe('syncConnection — demo end to end', () => {
  it('first sync writes today + 90 days of snapshots, transactions, daily_revenue, FX and a closed run', async () => {
    const c = ctx();
    await seedDemo(c);
    const tripsBefore = c.t.roundTrips();

    const r = await syncConnection(c.env, 'demo-1', 'initial');

    expect(r).toMatchObject({ ok: true, snapshot: true, done: true, error: null });
    expect(r.events).toBeGreaterThan(500);
    expect(c.t.roundTrips() - tripsBefore).toBeLessThanOrEqual(7);

    // Snapshots: today from fetchSnapshot, plus the 90 days before it.
    const snaps = c.t.rows<{ day: string; mrr: string; active_subscriptions: number; captured_at: number }>(
      'SELECT day, mrr, active_subscriptions, captured_at FROM snapshots WHERE connection_id = ? ORDER BY day',
      'demo-1',
    );
    expect(snaps).toHaveLength(91);
    expect(snaps[0]!.day).toBe(addDays(dayKey(NOW), -90));
    expect(snaps.at(-1)!.day).toBe(dayKey(NOW));
    const expected = await demoAdapter.fetchSnapshot({ credentials: {}, config: DEMO_CONFIG }, makeCtx(fetch, { now: NOW }));
    expect(JSON.parse(snaps.at(-1)!.mrr)).toEqual(expected.mrr);
    expect(snaps.at(-1)!.active_subscriptions).toBe(expected.activeSubscriptions);
    expect(Object.keys(JSON.parse(snaps[0]!.mrr)).sort()).toEqual(['EUR', 'GBP', 'USD']);

    // Transactions and the daily aggregate derived from them.
    const tx = txRows(c.t, 'demo-1');
    expect(tx).toHaveLength(r.events);
    expect(dayKey(Math.min(...tx.map((e) => e.occurredAt)))).toBe(addDays(dayKey(NOW), -89));
    expect(new Set(dailyRows(c.t, 'demo-1').map((d) => d.day)).size).toBe(90);
    expect(Math.max(...tx.map((e) => e.occurredAt))).toBeLessThanOrEqual(NOW);
    expect(c.t.rows('SELECT 1 FROM transactions WHERE type = ?', 'refund').length).toBeGreaterThan(0);
    expectDailyMatchesTransactions(c, 'demo-1');
    expect(dailyRows(c.t, 'demo-1', 'provider')).toEqual([]);

    // FX filled by ensureFx on a fresh install.
    expect(c.fxCalls).toHaveLength(1);
    expect(c.t.rows('SELECT day, base FROM fx_rates')).toEqual([{ day: '2026-11-04', base: 'USD' }]);

    expect(runs(c.t)).toEqual([
      { id: 1, connection_id: 'demo-1', kind: 'initial', started_at: NOW, finished_at: NOW, ok: 1, events: r.events, message: null },
    ]);
    expect(conn(c.t, 'demo-1')).toEqual({
      status: 'ok',
      last_error: null,
      last_synced_at: NOW,
      last_sync_started_at: NOW,
      revenue_cursor: null,
      revenue_synced_until: NOW,
    });
  });

  it('a second sync is idempotent and re-reads only from high-water − 2 days', async () => {
    const c = ctx();
    await seedDemo(c);
    const spy = vi.spyOn(demoAdapter, 'fetchRevenue');
    await syncConnection(c.env, 'demo-1', 'initial');

    const snapshotTable = () =>
      c.t.rows('SELECT day, mrr, active_subscriptions, active_trials, revenue_period, new_customers FROM snapshots ORDER BY day');
    const before = {
      tx: c.t.rows('SELECT * FROM transactions ORDER BY external_id'),
      daily: c.t.rows('SELECT * FROM daily_revenue ORDER BY day, currency'),
      snaps: snapshotTable(),
    };

    const r2 = await syncConnection(c.env, 'demo-1', 'manual');

    expect(r2).toMatchObject({ ok: true, done: true });
    expect(spy.mock.calls[1]![1]).toEqual({ since: NOW - 2 * DAY, cursor: null });
    expect(r2.events).toBe(c.t.rows('SELECT 1 FROM transactions WHERE occurred_at >= ?', NOW - 2 * DAY).length);
    expect(c.t.rows('SELECT * FROM transactions ORDER BY external_id')).toEqual(before.tx);
    expect(c.t.rows('SELECT * FROM daily_revenue ORDER BY day, currency')).toEqual(before.daily);
    expect(snapshotTable()).toEqual(before.snaps);
    expect(c.fxCalls).toHaveLength(1); // ensureFx only fetches into an empty table
    expect(runs(c.t).map((x) => [x.kind, x.ok])).toEqual([
      ['initial', 1],
      ['manual', 1],
    ]);

    // Later the same day: new events appear, the aggregate still matches exactly.
    vi.setSystemTime(NOW + 6 * HOUR);
    const r3 = await syncConnection(c.env, 'demo-1', 'cron');
    expect(r3.ok).toBe(true);
    expect(spy.mock.calls[2]![1]).toEqual({ since: NOW - 2 * DAY, cursor: null });
    expectDailyMatchesTransactions(c, 'demo-1');
    expect(conn(c.t, 'demo-1').revenue_synced_until).toBe(NOW + 6 * HOUR);
  });

  it('demo history never overwrites a day that already has a snapshot; today’s row is replaced', async () => {
    // The demo is deterministic, so the idempotency test above can't tell "insert or ignore" from
    // "upsert". Distinct values can.
    const c = ctx();
    await seedDemo(c);
    const yesterday = addDays(dayKey(NOW), -1);
    const insert = `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, captured_at)
                    VALUES ('demo-1', ?, '{"USD":1}', 1, 0, 0)`;
    c.t.exec(insert, yesterday);
    c.t.exec(insert, dayKey(NOW));

    await syncConnection(c.env, 'demo-1', 'initial');

    const row = (day: string) =>
      c.t.rows<{ mrr: string; active_subscriptions: number; captured_at: number }>(
        'SELECT mrr, active_subscriptions, captured_at FROM snapshots WHERE connection_id = ? AND day = ?',
        'demo-1',
        day,
      )[0]!;
    expect(row(yesterday)).toEqual({ mrr: '{"USD":1}', active_subscriptions: 1, captured_at: 0 });
    const expected = await demoAdapter.fetchSnapshot({ credentials: {}, config: DEMO_CONFIG }, makeCtx(fetch, { now: NOW }));
    const today = row(dayKey(NOW));
    expect(JSON.parse(today.mrr)).toEqual(expected.mrr);
    expect(today).toMatchObject({ active_subscriptions: expected.activeSubscriptions, captured_at: NOW });
    expect(c.t.rows('SELECT 1 FROM snapshots WHERE connection_id = ?', 'demo-1')).toHaveLength(91);
  });
});

describe('syncConnection — revenue cursor', () => {
  it('stores a cursor, resumes with the same since, then clears it and advances the high-water mark', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    const snap = stripeSnapshotOk();
    const rev = vi
      .spyOn(stripeAdapter, 'fetchRevenue')
      .mockResolvedValueOnce(page([charge('ch_1', daysAgo(10), 1000)], { nextCursor: 'c1', done: false }))
      .mockResolvedValueOnce(page([charge('ch_2', daysAgo(40), 2000, 'EUR')], { nextCursor: 'c2', done: false }))
      .mockResolvedValueOnce(page([charge('ch_3', daysAgo(80), 3000)]))
      .mockResolvedValue(page([]));

    const r1 = await syncConnection(c.env, 'st-1', 'initial');
    expect(r1).toMatchObject({ ok: true, snapshot: true, done: false, events: 1, error: null });
    expect(rev.mock.calls[0]![0]).toEqual({ credentials: { apiKey: SECRET }, config: {} });
    expect(rev.mock.calls[0]![1]).toEqual({ since: FIRST_SINCE, cursor: null });
    expect(rev.mock.calls[0]![2].pageBudget).toBe(REVENUE_PAGE_BUDGET);
    expect(snap.mock.calls[0]![1].pageBudget).toBe(SNAPSHOT_PAGE_BUDGET);
    let row = conn(c.t, 'st-1');
    expect(row).toMatchObject({ status: 'ok', last_synced_at: NOW, revenue_synced_until: null });
    expect(decodeBackfill(row.revenue_cursor!)).toEqual({ cursor: 'c1', since: FIRST_SINCE, startedAt: NOW });
    expect(runs(c.t, 'st-1').at(-1)).toMatchObject({ ok: 1, events: 1, message: BACKFILL_CONTINUES_MESSAGE });

    vi.setSystemTime(NOW + HOUR);
    const r2 = await syncConnection(c.env, 'st-1', 'cron');
    expect(r2).toMatchObject({ ok: true, done: false });
    expect(rev.mock.calls[1]![1]).toEqual({ since: FIRST_SINCE, cursor: 'c1' });
    expect(decodeBackfill(conn(c.t, 'st-1').revenue_cursor!)).toEqual({ cursor: 'c2', since: FIRST_SINCE, startedAt: NOW });

    vi.setSystemTime(NOW + 2 * HOUR);
    const r3 = await syncConnection(c.env, 'st-1', 'cron');
    expect(r3).toMatchObject({ ok: true, done: true });
    expect(rev.mock.calls[2]![1]).toEqual({ since: FIRST_SINCE, cursor: 'c2' });
    row = conn(c.t, 'st-1');
    // High-water = when the backfill STARTED: events that arrived during runs 1–3 are re-read next time.
    expect(row).toMatchObject({ status: 'ok', revenue_cursor: null, revenue_synced_until: NOW, last_synced_at: NOW + 2 * HOUR });
    expect(runs(c.t, 'st-1').at(-1)!.message).toBeNull();

    vi.setSystemTime(NOW + 3 * HOUR);
    await syncConnection(c.env, 'st-1', 'cron');
    expect(rev.mock.calls[3]![1]).toEqual({ since: NOW - 2 * DAY, cursor: null });

    expect(txRows(c.t, 'st-1').map((e) => e.externalId)).toEqual(['ch_1', 'ch_2', 'ch_3']);
    expectDailyMatchesTransactions(c, 'st-1');
  });

  it.each([
    ['upstream 400', new ProviderError('upstream', 'Stripe returned HTTP 400: No such balance transaction', { status: 400 }), true],
    ['not_found', new ProviderError('not_found', 'Stripe couldn’t find /v1/balance_transactions.', { status: 404 }), true],
    ['invalid_input', new ProviderError('invalid_input', 'The saved position is no longer valid.'), true],
    ['upstream 503', new ProviderError('upstream', 'Stripe is having problems right now (HTTP 503).', { status: 503 }), false],
    ['rate_limit', new ProviderError('rate_limit', 'slow down', { status: 429 }), false],
  ])('a resumed call failing with %s %s the cursor', async (_label, err, clears) => {
    const c = ctx();
    await seedStripe(c, 'st-1', { status: 'ok', lastSyncedAt: NOW - DAY });
    const stored = JSON.stringify({ v: 1, cursor: 'txn_old', since: NOW - 5 * DAY, startedAt: NOW - DAY });
    setCursorState(c.t, 'st-1', stored, NOW - 3 * DAY);
    stripeSnapshotOk();
    const rev = vi.spyOn(stripeAdapter, 'fetchRevenue').mockRejectedValueOnce(err).mockResolvedValue(page([]));

    const r = await syncConnection(c.env, 'st-1', 'cron');
    expect(r).toMatchObject({ ok: false, snapshot: true, done: false });
    expect(rev.mock.calls[0]![1]).toEqual({ since: NOW - 5 * DAY, cursor: 'txn_old' });
    const row = conn(c.t, 'st-1');
    expect(row).toMatchObject({ status: 'error', last_synced_at: NOW - DAY, revenue_synced_until: NOW - 3 * DAY });
    expect(row.revenue_cursor).toBe(clears ? null : stored);

    vi.setSystemTime(NOW + HOUR);
    await syncConnection(c.env, 'st-1', 'cron');
    expect(rev.mock.calls[1]![1]).toEqual(
      clears ? { since: NOW - 5 * DAY, cursor: null } : { since: NOW - 5 * DAY, cursor: 'txn_old' },
    );
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'ok', revenue_cursor: null, last_error: null });
  });
});

describe('syncConnection — daily_revenue stays equal to its transactions', () => {
  const D1 = Date.parse('2026-11-01T10:00:00.000Z');
  const D2 = Date.parse('2026-11-03T15:00:00.000Z');

  it('re-delivered events with a new amount, or moved to another day, rebuild every affected day', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    stripeSnapshotOk();
    const rev = vi.spyOn(stripeAdapter, 'fetchRevenue');

    rev.mockResolvedValueOnce(page([charge('ch_1', D1, 1000), charge('ch_2', D1 + HOUR, 500)]));
    await syncConnection(c.env, 'st-1', 'initial');
    expect(dailyRows(c.t, 'st-1')).toEqual([{ day: '2026-11-01', currency: 'USD', gross: 1500, refunds: 0, count: 2 }]);

    // Amount changed upstream (e.g. a partial capture settled).
    vi.setSystemTime(NOW + HOUR);
    rev.mockResolvedValueOnce(page([charge('ch_1', D1, 1500)]));
    await syncConnection(c.env, 'st-1', 'manual');
    expect(txRows(c.t, 'st-1').find((e) => e.externalId === 'ch_1')!.amount).toBe(1500);
    expect(dailyRows(c.t, 'st-1')).toEqual([{ day: '2026-11-01', currency: 'USD', gross: 2000, refunds: 0, count: 2 }]);

    // ch_2 re-delivered on another day: its OLD day must shrink even though this page never mentions it.
    vi.setSystemTime(NOW + 2 * HOUR);
    rev.mockResolvedValueOnce(page([charge('ch_2', D2, 500, 'EUR')]));
    await syncConnection(c.env, 'st-1', 'manual');
    expect(dailyRows(c.t, 'st-1')).toEqual([
      { day: '2026-11-01', currency: 'USD', gross: 1500, refunds: 0, count: 1 },
      { day: '2026-11-03', currency: 'EUR', gross: 500, refunds: 0, count: 1 },
    ]);
    expectDailyMatchesTransactions(c, 'st-1');
  });

  it('a refund on a later day lands on its own day and leaves the charge day alone', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    stripeSnapshotOk();
    const rev = vi.spyOn(stripeAdapter, 'fetchRevenue');

    rev.mockResolvedValueOnce(page([charge('ch_1', D1, 2000), charge('ch_x', D1, 700, 'GBP')]));
    await syncConnection(c.env, 'st-1', 'initial');
    vi.setSystemTime(NOW + HOUR);
    rev.mockResolvedValueOnce(page([refund('re_1', D2, 2000)]));
    const r = await syncConnection(c.env, 'st-1', 'manual');

    expect(r).toMatchObject({ ok: true, events: 1 });
    expect(dailyRows(c.t, 'st-1')).toEqual([
      { day: '2026-11-01', currency: 'GBP', gross: 700, refunds: 0, count: 1 },
      { day: '2026-11-01', currency: 'USD', gross: 2000, refunds: 0, count: 1 },
      { day: '2026-11-03', currency: 'USD', gross: 0, refunds: 2000, count: 1 },
    ]);
    expectDailyMatchesTransactions(c, 'st-1');
  });

  it('random overlapping pages always leave daily_revenue equal to the aggregate', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    stripeSnapshotOk();
    const rev = vi.spyOn(stripeAdapter, 'fetchRevenue');
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const currencies = ['USD', 'EUR', 'GBP', 'JPY'];
    const makeEvent = (i: number): RevenueEvent => {
      const at = NOW - Math.floor(rnd() * 20 * DAY);
      const amount = 100 + Math.floor(rnd() * 5000);
      const cur = currencies[Math.floor(rnd() * currencies.length)]!;
      return rnd() < 0.15 ? refund(`ev_${i}`, at, amount, cur) : charge(`ev_${i}`, at, amount, cur);
    };
    for (let run = 0; run < 5; run++) {
      // Each page re-delivers ~half of the ids with new values (new day, amount, currency, sign).
      const ids = Array.from({ length: 120 }, () => Math.floor(rnd() * 250));
      rev.mockResolvedValueOnce(page(ids.map(makeEvent)));
      vi.setSystemTime(NOW + run * HOUR);
      const r = await syncConnection(c.env, 'st-1', 'cron');
      expect(r.ok).toBe(true);
      expectDailyMatchesTransactions(c, 'st-1');
    }
  });
});

describe('syncConnection — provider daily points', () => {
  async function seedRevenueCat(c: Ctx): Promise<void> {
    seedConnection(c.t, {
      id: 'rc-1',
      userId: c.userId,
      provider: 'revenuecat',
      credentialsEnc: await encryptedCreds({ apiKey: 'sk_rcsecretvalue' }),
      config: { projectId: 'proj1' },
      status: 'pending',
    });
    vi.spyOn(revenueCatAdapter, 'fetchSnapshot').mockResolvedValue({ ...SNAP, revenuePeriodDays: 28 });
  }

  it('upserts points with source=provider, overwrites them later and skips invalid ones', async () => {
    const c = ctx();
    await seedRevenueCat(c);
    const rev = vi
      .spyOn(revenueCatAdapter, 'fetchRevenue')
      .mockResolvedValueOnce(
        page([], {
          daily: [
            { day: '2026-11-01', currency: 'USD', gross: 1000, refunds: 0, count: 3 },
            { day: '2026-11-02', currency: 'usd', gross: 500, refunds: 100, count: 2 },
            { day: '2026-02-30', currency: 'USD', gross: 1, refunds: 0, count: 1 },
            { day: '2026-11-03', currency: 'USD', gross: -5, refunds: 0, count: 1 },
          ],
        }),
      )
      .mockResolvedValueOnce(page([], { daily: [{ day: '2026-11-02', currency: 'USD', gross: 700, refunds: 0, count: 4 }] }));

    const r1 = await syncConnection(c.env, 'rc-1', 'initial');
    expect(r1).toMatchObject({ ok: true, events: 2 });
    expect(rev.mock.calls[0]![0]).toEqual({ credentials: { apiKey: 'sk_rcsecretvalue' }, config: { projectId: 'proj1' } });
    expect(dailyRows(c.t, 'rc-1', 'provider')).toEqual([
      { day: '2026-11-01', currency: 'USD', gross: 1000, refunds: 0, count: 3 },
      { day: '2026-11-02', currency: 'USD', gross: 500, refunds: 100, count: 2 },
    ]);
    expect(c.out.some((l) => l.includes('sync_daily_skipped'))).toBe(true);

    vi.setSystemTime(NOW + HOUR);
    await syncConnection(c.env, 'rc-1', 'cron');
    expect(dailyRows(c.t, 'rc-1', 'provider')).toEqual([
      { day: '2026-11-01', currency: 'USD', gross: 1000, refunds: 0, count: 3 },
      { day: '2026-11-02', currency: 'USD', gross: 700, refunds: 0, count: 4 },
    ]);
    expect(c.t.rows('SELECT revenue_period_days FROM snapshots')).toEqual([{ revenue_period_days: 28 }]);
  });

  it('provider points win over transaction-derived rows for the same day and currency', async () => {
    const c = ctx();
    await seedRevenueCat(c);
    const events = [charge('tx_1', Date.parse('2026-11-01T08:00:00Z'), 999), charge('tx_2', Date.parse('2026-11-01T09:00:00Z'), 50, 'EUR')];
    vi.spyOn(revenueCatAdapter, 'fetchRevenue')
      .mockResolvedValueOnce(page(events, { daily: [{ day: '2026-11-01', currency: 'USD', gross: 1200, refunds: 0, count: 2 }] }))
      // A later page with only events for that day must not demote the provider's figure.
      .mockResolvedValueOnce(page(events));
    const expected = [
      { day: '2026-11-01', currency: 'EUR', gross: 50, count: 1, source: 'transactions' },
      { day: '2026-11-01', currency: 'USD', gross: 1200, count: 2, source: 'provider' },
    ];
    const table = () => c.t.rows('SELECT day, currency, gross, count, source FROM daily_revenue ORDER BY currency');

    await syncConnection(c.env, 'rc-1', 'initial');
    expect(table()).toEqual(expected);
    await syncConnection(c.env, 'rc-1', 'manual');
    expect(table()).toEqual(expected);
  });
});

describe('syncConnection — failures', () => {
  it('auth on the snapshot: error status, revenue skipped, last_synced_at kept', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1', { status: 'ok', lastSyncedAt: NOW - 3 * HOUR });
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockRejectedValue(
      new ProviderError('auth', 'Stripe rejected the API key.', { status: 401, field: 'apiKey' }),
    );
    const rev = vi.spyOn(stripeAdapter, 'fetchRevenue');

    const r = await syncConnection(c.env, 'st-1', 'cron');

    const msg = "Stripe rejected the key. If it was revoked, replace the key.";
    expect(r).toEqual({ ok: false, snapshot: false, events: 0, done: false, error: msg, durationMs: expect.any(Number) });
    expect(rev).not.toHaveBeenCalled();
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'error', last_error: msg, last_synced_at: NOW - 3 * HOUR, last_sync_started_at: NOW });
    expect(runs(c.t, 'st-1')).toEqual([
      { id: 1, connection_id: 'st-1', kind: 'cron', started_at: NOW, finished_at: NOW, ok: 0, events: 0, message: msg },
    ]);
    expect(c.t.rows('SELECT 1 FROM snapshots')).toHaveLength(0);
  });

  it('permission on the snapshot: provider message, revenue skipped', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    const msg = 'The Stripe key is missing the “Subscriptions: Read” permission (rak_subscription_read).';
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockRejectedValue(new ProviderError('permission', msg, { status: 403 }));
    const rev = vi.spyOn(stripeAdapter, 'fetchRevenue');
    const r = await syncConnection(c.env, 'st-1', 'manual');
    expect(r).toMatchObject({ ok: false, error: msg });
    expect(rev).not.toHaveBeenCalled();
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'error', last_error: msg, last_synced_at: null });
  });

  it('a key revoked between the snapshot and revenue: snapshot kept, cursor and high-water untouched', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1', { status: 'ok', lastSyncedAt: NOW - HOUR });
    const stored = JSON.stringify({ v: 1, cursor: 'txn_old', since: NOW - 5 * DAY, startedAt: NOW - DAY });
    setCursorState(c.t, 'st-1', stored, NOW - 3 * DAY);
    stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockRejectedValue(
      new ProviderError('auth', 'Stripe rejected the API key.', { status: 401, field: 'apiKey' }),
    );

    const r = await syncConnection(c.env, 'st-1', 'cron');

    const msg = 'Stripe rejected the key. If it was revoked, replace the key.';
    expect(r).toMatchObject({ ok: false, snapshot: true, events: 0, done: false, error: msg });
    expect(c.t.rows('SELECT day FROM snapshots')).toEqual([{ day: dayKey(NOW) }]);
    // An auth error is not a stale cursor: resuming with a fixed key must continue where it was.
    expect(conn(c.t, 'st-1')).toEqual({
      status: 'error',
      last_error: msg,
      last_synced_at: NOW - HOUR,
      last_sync_started_at: NOW,
      revenue_cursor: stored,
      revenue_synced_until: NOW - 3 * DAY,
    });
  });

  it('a rate-limited snapshot still lets revenue sync, but the run is an error', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockRejectedValue(new ProviderError('rate_limit', 'x', { status: 429 }));
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([charge('ch_1', daysAgo(1), 1000)]));
    const r = await syncConnection(c.env, 'st-1', 'manual');
    expect(r).toMatchObject({
      ok: false,
      snapshot: false,
      events: 1,
      done: true,
      error: 'Stripe is rate-limiting requests; the next sync will retry.',
    });
    expect(txRows(c.t, 'st-1')).toHaveLength(1);
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'error', revenue_synced_until: NOW, last_synced_at: null });
  });

  it('budget exhausted in revenue: the snapshot still counts, the cursor stays put', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1', { status: 'ok', lastSyncedAt: NOW - HOUR });
    setCursorState(c.t, 'st-1', null, NOW - 2 * HOUR);
    stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockRejectedValue(new BudgetExhaustedError('Stripe'));

    const r = await syncConnection(c.env, 'st-1', 'cron');

    expect(r).toMatchObject({ ok: false, snapshot: true, events: 0, done: false });
    // Engine-owned wording: never "the next sync continues" when nothing was checkpointed.
    expect(r.error).toBe("Stripe has more revenue history than one sync can read, so revenue wasn’t updated.");
    expect(c.t.rows('SELECT day FROM snapshots')).toEqual([{ day: dayKey(NOW) }]);
    expect(conn(c.t, 'st-1')).toMatchObject({
      status: 'error',
      last_error: r.error,
      last_synced_at: NOW - HOUR,
      revenue_cursor: null,
      revenue_synced_until: NOW - 2 * HOUR,
    });
    expect(runs(c.t, 'st-1')[0]).toMatchObject({ ok: 0, message: r.error });
  });

  it('undecryptable credentials: clear message, adapter never called, blob never logged', async () => {
    const c = ctx();
    const otherKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => 7)));
    const foreign = await encryptJson(otherKey, { apiKey: SECRET });
    await seedStripe(c, 'st-1', { credentialsEnc: foreign });
    await seedStripe(c, 'st-2', { credentialsEnc: 'v1.not-base64!.garbage' });
    const snap = vi.spyOn(stripeAdapter, 'fetchSnapshot');

    for (const id of ['st-1', 'st-2']) {
      const r = await syncConnection(c.env, id, 'manual');
      expect(r).toMatchObject({ ok: false, snapshot: false, error: DECRYPT_ERROR });
      expect(conn(c.t, id)).toMatchObject({ status: 'error', last_error: DECRYPT_ERROR });
      expect(runs(c.t, id)[0]).toMatchObject({ ok: 0, message: DECRYPT_ERROR });
    }
    expect(snap).not.toHaveBeenCalled();
    const out = c.out.join('\n');
    expect(out).not.toContain(foreign.split('.')[2]!.slice(0, 16));
    expect(out).not.toContain('garbage');
  });

  it('a decrypted value that is not an object is treated as undecryptable', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1', { credentialsEnc: await encryptJson(TEST_ENCRYPTION_KEY, 'just-a-string') });
    const r = await syncConnection(c.env, 'st-1', 'manual');
    expect(r.error).toBe(DECRYPT_ERROR);
  });

  it('an unexpected exception carrying the key: generic message, sanitised log, no throw', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockRejectedValue(new TypeError(`Cannot read properties of undefined (key ${SECRET})`));
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockImplementation(() => {
      throw Object.create(null); // not even an Error, and String() of it throws
    });

    const r = await syncConnection(c.env, 'st-1', 'manual');

    expect(r).toMatchObject({ ok: false, snapshot: false, error: GENERIC_STRIPE });
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'error', last_error: GENERIC_STRIPE });
    expect(runs(c.t, 'st-1')[0]).toMatchObject({ ok: 0, message: GENERIC_STRIPE });
    expect(c.out.join('\n')).toContain('rk_test_***');
  });

  it('an adapter that returns garbage is a generic error, not a crash', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockResolvedValue({ mrr: 'lots' } as never);
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(null as never);
    const r = await syncConnection(c.env, 'st-1', 'manual');
    expect(r).toMatchObject({ ok: false, snapshot: false, events: 0, error: GENERIC_STRIPE });
  });

  it('logs and skips invalid events but keeps the valid ones', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(
      page([
        charge('ch_ok', daysAgo(1), 1000, 'usd'),
        { ...charge('ch_float', daysAgo(1), 1), amount: 12.99 },
        { ...charge('ch_secs', daysAgo(1), 1000), occurredAt: Math.floor(daysAgo(1) / 1000) },
        { ...charge('ch_cur', daysAgo(1), 1000), currency: 'dollars' },
      ]),
    );
    const r = await syncConnection(c.env, 'st-1', 'manual');
    expect(r).toMatchObject({ ok: true, events: 1 });
    expect(txRows(c.t, 'st-1')).toEqual([{ externalId: 'ch_ok', occurredAt: daysAgo(1), amount: 1000, currency: 'USD' }]);
    const line = c.out.find((l) => l.includes('sync_events_skipped'))!;
    expect(JSON.parse(line)).toMatchObject({ skipped: { amount: 1, occurred_at: 1, currency: 1 }, connectionId: 'st-1' });
  });

  it('never throws when D1 fails, and a later sync takes over the stale lock', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([charge('ch_1', daysAgo(1), 1000)]));
    const brokenBatch = { ...c.env, DB: Object.assign(Object.create(c.env.DB), { batch: () => Promise.reject(new Error('D1_ERROR: overloaded')) }) };

    const r = await syncConnection(brokenBatch, 'st-1', 'manual');
    expect(r).toMatchObject({ ok: false, snapshot: false, events: 0, error: GENERIC_STRIPE });
    expect(conn(c.t, 'st-1').status).toBe('syncing'); // couldn’t even release; the lock will go stale

    const brokenPrepare = { ...c.env, DB: { prepare: () => { throw new Error('D1_ERROR: down'); } } as unknown as D1Database };
    await expect(syncConnection(brokenPrepare, 'st-1', 'manual')).resolves.toMatchObject({ ok: false });

    vi.setSystemTime(NOW + 6 * MINUTE);
    const ok = await syncConnection(c.env, 'st-1', 'manual');
    expect(ok).toMatchObject({ ok: true, events: 1 });
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'ok', last_synced_at: NOW + 6 * MINUTE });
  });

  it('a failed final write leaves no partial data and does not move the cursor', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([charge('ch_1', daysAgo(1), 1000)], { nextCursor: 'c1', done: false }));
    const realBatch = c.env.DB.batch.bind(c.env.DB);
    let calls = 0;
    const db = Object.assign(Object.create(c.env.DB), {
      batch: (stmts: D1PreparedStatement[]) => (++calls === 4 ? Promise.reject(new Error('D1_ERROR: too big')) : realBatch(stmts)),
    });
    const r = await syncConnection({ ...c.env, DB: db }, 'st-1', 'manual');
    expect(r).toMatchObject({ ok: false, snapshot: true, events: 0, done: false, error: GENERIC_STRIPE });
    expect(txRows(c.t, 'st-1')).toEqual([]);
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'error', revenue_cursor: null, last_error: GENERIC_STRIPE });
    expect(runs(c.t, 'st-1')[0]).toMatchObject({ ok: 0, events: 0, message: GENERIC_STRIPE });
  });
});

describe('syncConnection — lock', () => {
  it('skips a connection that is already syncing, without a run row', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1', { status: 'syncing', lastSyncStartedAt: NOW - MINUTE });
    const snap = vi.spyOn(stripeAdapter, 'fetchSnapshot');
    const r = await syncConnection(c.env, 'st-1', 'manual');
    expect(r).toEqual({ ok: false, snapshot: false, events: 0, done: false, error: SYNC_BUSY_MESSAGE, durationMs: expect.any(Number) });
    expect(snap).not.toHaveBeenCalled();
    expect(runs(c.t)).toEqual([]);
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'syncing', last_sync_started_at: NOW - MINUTE });
  });

  it('takes over a lock older than 5 minutes', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1', { status: 'syncing', lastSyncStartedAt: NOW - 6 * MINUTE });
    stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
    const r = await syncConnection(c.env, 'st-1', 'cron');
    expect(r.ok).toBe(true);
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'ok', last_sync_started_at: NOW });
  });

  it('a missing connection is a quiet failure', async () => {
    const c = ctx();
    const r = await syncConnection(c.env, 'nope', 'manual');
    expect(r).toMatchObject({ ok: false, error: 'Connection not found.' });
    expect(runs(c.t)).toEqual([]);
  });

  it('two concurrent syncs: exactly one runs', async () => {
    const c = ctx();
    await seedDemo(c);
    const [a, b] = await Promise.all([syncConnection(c.env, 'demo-1', 'manual'), syncConnection(c.env, 'demo-1', 'manual')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a.error, b.error]).toContain(SYNC_BUSY_MESSAGE);
    expect(runs(c.t)).toHaveLength(1);
  });

  it('a run whose lock was taken over cannot overwrite the new owner’s cursor or status', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockImplementation(async () => {
      // Simulates a second sync taking over a stale lock while this one is still paging.
      c.t.exec("UPDATE connections SET status = 'syncing', last_sync_started_at = ? WHERE id = 'st-1'", NOW + 7 * MINUTE);
      return page([charge('ch_1', daysAgo(1), 1000)], { nextCursor: 'mine', done: false });
    });
    const r = await syncConnection(c.env, 'st-1', 'cron');
    expect(r.ok).toBe(true);
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'syncing', last_sync_started_at: NOW + 7 * MINUTE, revenue_cursor: null });
    expect(runs(c.t, 'st-1')[0]).toMatchObject({ ok: 1 }); // our own run row is still closed
    expect(c.out.some((l) => l.includes('sync_lock_lost'))).toBe(true);
    expectDailyMatchesTransactions(c, 'st-1'); // idempotent data writes are harmless
  });
});

// ---------------------------------------------------------------------------------------------
// Deadlines, budgets, run history (security/SRE review follow-up)
// ---------------------------------------------------------------------------------------------

/** A provider endpoint where every request takes `stepMs` of wall-clock time. */
function slowApi(stepMs: number): void {
  const { fetch } = fakeFetch([
    route('/v1/latest', { json: FX_BODY }),
    route('/v1/slow', (url) => {
      vi.setSystemTime(Date.now() + stepMs);
      return { json: { n: Number(url.searchParams.get('after') ?? 0) + 1 } };
    }),
  ]);
  vi.stubGlobal('fetch', fetch);
}

const slowGet = (ctx: ProviderContext, after: number) =>
  fetchJson<{ n: number }>(ctx, { provider: 'Stripe', url: `https://api.stripe.com/v1/slow?after=${after}` });

/** A well-behaved adapter loop: checks the budget before every page, returns a cursor when it runs out. */
async function pagedRevenue(req: RevenueRequest, ctx: ProviderContext, total = 100): Promise<RevenuePage> {
  const events: RevenueEvent[] = [];
  let after = req.cursor ? Number(req.cursor) : 0;
  while (after < total) {
    if (!hasBudget(ctx)) return page(events, { nextCursor: String(after), done: false });
    after = (await slowGet(ctx, after)).n;
    events.push(charge(`txn_${after}`, daysAgo(1), 100));
  }
  return page(events);
}

describe('withDeadline / syncDeadlines', () => {
  it('reads the real budget until the deadline, then 0, and logs it once', () => {
    ctx();
    const logs: unknown[] = [];
    const dctx = withDeadline({ fetch, now: () => Date.now(), log: (e, d) => logs.push([e, d]), pageBudget: 5 }, NOW + 1_000);
    expect(hasBudget(dctx)).toBe(true);
    dctx.pageBudget -= 1;
    expect(dctx.pageBudget).toBe(4);
    expect(dctx.deadlineHit).toBe(false);

    vi.setSystemTime(NOW + 1_000);
    expect(dctx.pageBudget).toBe(0);
    expect(hasBudget(dctx)).toBe(false);
    expect(dctx.pageBudget).toBe(0);
    expect(dctx.deadlineHit).toBe(true);
    expect(logs).toEqual([['sync_deadline_reached', { unusedBudget: 4 }]]);
  });

  it('fetchJson refuses to start a request once the deadline has passed', async () => {
    ctx();
    slowApi(1);
    const dctx = withDeadline(makeCtx(fetch, { pageBudget: 10 }), NOW - 1);
    await expect(slowGet(dctx, 0)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('interactive syncs get ~20 s (snapshot first, revenue the rest), cron syncs ~60 s', () => {
    expect(INTERACTIVE_SYNC_DEADLINE_MS).toBe(20_000);
    expect(CRON_SYNC_DEADLINE_MS).toBe(60_000);
    expect(syncDeadlines('initial', NOW)).toEqual({ snapshot: NOW + 12_000, revenue: NOW + 20_000 });
    expect(syncDeadlines('manual', NOW)).toEqual({ snapshot: NOW + 12_000, revenue: NOW + 20_000 });
    expect(syncDeadlines('cron', NOW)).toEqual({ snapshot: NOW + 36_000, revenue: NOW + 60_000 });
  });
});

describe('syncConnection — deadlines and budgets', () => {
  it('a slow initial sync checkpoints its cursor at the deadline and commits well inside waitUntil’s 30 s', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    stripeSnapshotOk();
    slowApi(3_000);
    const rev = vi.spyOn(stripeAdapter, 'fetchRevenue').mockImplementation((_input, req, pctx) => pagedRevenue(req, pctx));

    const r = await syncConnection(c.env, 'st-1', 'initial');

    // Pages at t = 0, 3, …, 18 s; at 21 s the budget reads 0, the adapter returns a cursor, the batch commits.
    expect(r).toMatchObject({ ok: true, snapshot: true, done: false, events: 7, error: null });
    expect(Date.now() - NOW).toBe(21_000);
    expect(decodeBackfill(conn(c.t, 'st-1').revenue_cursor!)).toMatchObject({ cursor: '7', since: FIRST_SINCE });
    expect(txRows(c.t, 'st-1')).toHaveLength(7);
    expect(runs(c.t, 'st-1')[0]).toMatchObject({ ok: 1, events: 7, message: BACKFILL_CONTINUES_MESSAGE });
    expect(c.out.some((l) => l.includes('sync_deadline_reached'))).toBe(true);

    // The next (cron) run resumes from the checkpoint.
    vi.setSystemTime(NOW + HOUR);
    const r2 = await syncConnection(c.env, 'st-1', 'cron');
    expect(rev.mock.calls[1]![1]).toEqual({ since: FIRST_SINCE, cursor: '7' });
    expect(r2).toMatchObject({ ok: true, events: REVENUE_PAGE_BUDGET });
    expectDailyMatchesTransactions(c, 'st-1');
  });

  it('a snapshot that runs out of time fails honestly; revenue still gets the rest of the deadline', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    slowApi(3_000);
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockImplementation(async (_input, pctx) => {
      // Like Stripe: a partial MRR would be wrong, so it lists everything or throws.
      for (let after = 0; after < 10; ) after = (await slowGet(pctx, after)).n;
      return SNAP;
    });
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockImplementation((_input, req, pctx) => pagedRevenue(req, pctx, 2));

    const r = await syncConnection(c.env, 'st-1', 'initial');

    const msg = "Stripe responded too slowly to read every subscription in one sync, so MRR wasn’t updated. The next sync will retry.";
    expect(r).toMatchObject({ ok: false, snapshot: false, events: 2, done: true, error: msg });
    expect(conn(c.t, 'st-1')).toMatchObject({ status: 'error', last_error: msg, revenue_synced_until: NOW });
    expect(c.t.rows('SELECT 1 FROM snapshots')).toEqual([]);
  });

  it('a snapshot larger than its page budget says so instead of promising a continuation', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    expect(SNAPSHOT_PAGE_BUDGET).toBe(80);
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockRejectedValue(new BudgetExhaustedError('Stripe'));
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([charge('ch_1', daysAgo(1), 1000)]));

    const r = await syncConnection(c.env, 'st-1', 'manual');

    expect(r).toMatchObject({
      ok: false,
      snapshot: false,
      events: 1,
      error: "Stripe has more subscriptions than one sync can read, so MRR wasn’t updated.",
    });
    expect(conn(c.t, 'st-1').last_error).not.toMatch(/continues/);
  });
});

describe('syncConnection — run history', () => {
  it('taking over a stale lock closes the interrupted run; other connections are untouched', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1', { status: 'syncing', lastSyncStartedAt: NOW - 10 * MINUTE });
    await seedStripe(c, 'st-2', { status: 'syncing', lastSyncStartedAt: NOW - MINUTE });
    const insertRun = "INSERT INTO sync_runs (connection_id, kind, started_at, finished_at, ok, events) VALUES (?, ?, ?, ?, ?, 0)";
    c.t.exec(insertRun, 'st-1', 'cron', NOW - 2 * HOUR, NOW - 2 * HOUR + 1_000, 1);
    c.t.exec(insertRun, 'st-1', 'initial', NOW - 10 * MINUTE, null, null); // its worker was killed
    c.t.exec(insertRun, 'st-2', 'manual', NOW - MINUTE, null, null); // genuinely still running
    stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));

    const r = await syncConnection(c.env, 'st-1', 'cron');

    expect(r.ok).toBe(true);
    expect(runs(c.t, 'st-1').map((x) => [x.kind, x.ok, x.finished_at, x.message])).toEqual([
      ['cron', 1, NOW - 2 * HOUR + 1_000, null],
      ['initial', 0, NOW, INTERRUPTED_RUN_MESSAGE],
      ['cron', 1, NOW, null],
    ]);
    expect(runs(c.t, 'st-2')[0]).toMatchObject({ finished_at: null, ok: null });
  });

  it('keeps the newest 100 runs per connection, after successful and failed syncs', async () => {
    const c = ctx();
    await seedStripe(c, 'st-1');
    await seedStripe(c, 'st-2');
    const insertRun = "INSERT INTO sync_runs (connection_id, kind, started_at, finished_at, ok, events) VALUES (?, 'cron', ?, ?, 1, 0)";
    for (let i = 0; i < 120; i++) c.t.exec(insertRun, 'st-1', NOW - (200 - i) * MINUTE, NOW - (200 - i) * MINUTE + 1);
    for (let i = 0; i < 5; i++) c.t.exec(insertRun, 'st-2', NOW - (10 - i) * MINUTE, NOW - (10 - i) * MINUTE + 1);
    const snap = stripeSnapshotOk();
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));

    await syncConnection(c.env, 'st-1', 'manual');

    let kept = runs(c.t, 'st-1');
    expect(kept).toHaveLength(SYNC_RUNS_KEPT);
    expect(kept[0]!.started_at).toBe(NOW - 179 * MINUTE); // 120 + 1 − 100 = the 21 oldest are gone
    expect(kept.at(-1)).toMatchObject({ kind: 'manual', started_at: NOW, ok: 1 });
    expect(runs(c.t, 'st-2')).toHaveLength(5);

    snap.mockRejectedValue(new ProviderError('auth', 'no', { status: 401 }));
    vi.setSystemTime(NOW + MINUTE);
    await syncConnection(c.env, 'st-1', 'manual');
    kept = runs(c.t, 'st-1');
    expect(kept).toHaveLength(SYNC_RUNS_KEPT);
    expect(kept.at(-1)).toMatchObject({ started_at: NOW + MINUTE, ok: 0 });
  });
});
