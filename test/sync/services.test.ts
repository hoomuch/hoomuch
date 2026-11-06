/** Connection services: key rotation semantics and deletion (Data Plane). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripeAdapter } from '../../src/providers/stripe';
import {
  MAX_CONNECTIONS_PER_USER,
  SYNC_QUEUED_MESSAGE,
  createConnection,
  deleteConnection,
  rotateCredentials,
  startSync,
  triggerSync,
} from '../../src/services/connections';
import { DAY, HOUR, addDays, dayKey, dayStart } from '../../src/lib/time';
import { seedConnection } from '../fixtures/d1';
import { fakeFetch, route } from '../fixtures/harness';
import { drainQueue, queueOf } from '../fixtures/queue';
import { FX_BODY, NOW, encryptedCreds, setup, teardown, type Ctx } from './helpers';

afterEach(() => teardown());

const emptyList = { object: 'list', data: [], has_more: false };

function stubStripe(): void {
  const { fetch } = fakeFetch([
    route('/v1/latest', { json: FX_BODY }),
    route('/v1/subscriptions', { json: emptyList }),
    route('/v1/prices', { json: emptyList }),
    route('/v1/balance_transactions', { json: emptyList }),
    route('/v1/coupons', { json: emptyList }),
    route('/v1/products', { json: emptyList }),
  ]);
  vi.stubGlobal('fetch', fetch);
}

async function seedStripeWithHistory(c: Ctx, id: string, opts: { testMode: boolean; status?: 'ok' | 'syncing'; startedAt?: number }) {
  seedConnection(c.t, {
    id,
    userId: c.userId,
    provider: 'stripe',
    credentialsEnc: await encryptedCreds({ apiKey: opts.testMode ? 'rk_test_old' : 'rk_live_old' }),
    testMode: opts.testMode,
    status: opts.status ?? 'ok',
    lastSyncedAt: NOW - HOUR,
    lastSyncStartedAt: opts.startedAt ?? NOW - HOUR,
  });
  c.t.exec("UPDATE connections SET revenue_cursor = 'old-cursor', revenue_synced_until = ? WHERE id = ?", NOW - HOUR, id);
  c.t.exec(
    "INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description) VALUES (?, 'txn_old', ?, 'charge', 1000, 'USD', NULL, NULL)",
    id,
    NOW - 3 * DAY,
  );
  c.t.exec(
    "INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, captured_at) VALUES (?, '2026-11-01', '{\"USD\":1000}', 1, 0)",
    id,
  );
}

describe('rotateCredentials', () => {
  it('keeps history but drops the in-flight cursor when the key reads the same source', async () => {
    const c = setup();
    stubStripe();
    const revenue = vi.spyOn(stripeAdapter, 'fetchRevenue');
    await seedStripeWithHistory(c, 'k', { testMode: true });
    const r = await rotateCredentials(c.env, c.userId, 'k', { apiKey: 'rk_test_new' });
    expect(r).toMatchObject({ ok: true });
    // Before the background sync runs: cursor cleared, high-water and history kept.
    const row = c.t.rows<{ revenue_cursor: string | null; revenue_synced_until: number | null }>(
      'SELECT revenue_cursor, revenue_synced_until FROM connections WHERE id = ?',
      'k',
    )[0]!;
    expect(row).toEqual({ revenue_cursor: null, revenue_synced_until: NOW - HOUR });
    expect(c.t.rows('SELECT * FROM transactions WHERE connection_id = ?', 'k')).toHaveLength(1);
    expect(c.t.rows('SELECT * FROM snapshots WHERE connection_id = ? AND day = ?', 'k', '2026-11-01')).toHaveLength(1);

    // The background sync it started is incremental from the kept high-water mark, not a fresh
    // 90-day backfill, and leaves the old history in place.
    expect(queueOf(c.env).sent.map((m) => m.body)).toEqual([{ v: 1, connectionId: 'k', kind: 'manual', at: NOW }]);
    expect(await drainQueue(c.env)).toMatchObject([{ outcome: 'ack' }]);
    expect(revenue.mock.calls).toHaveLength(1);
    expect(revenue.mock.calls[0]![1]).toEqual({ since: NOW - HOUR - 2 * DAY, cursor: null });
    expect(c.t.rows('SELECT external_id FROM transactions WHERE connection_id = ?', 'k')).toEqual([{ external_id: 'txn_old' }]);
    expect(c.t.rows('SELECT status, revenue_synced_until FROM connections WHERE id = ?', 'k')[0]).toEqual({
      status: 'ok',
      revenue_synced_until: NOW,
    });
  });

  it('purges synced data and restarts the backfill when switching test → live', async () => {
    const c = setup();
    stubStripe();
    const revenue = vi.spyOn(stripeAdapter, 'fetchRevenue');
    await seedStripeWithHistory(c, 'k', { testMode: true });
    c.t.exec("INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES ('k', '2026-11-02', 'USD', 1000, 0, 1, 'transactions')");
    const r = await rotateCredentials(c.env, c.userId, 'k', { apiKey: 'rk_live_new' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/previously synced data was cleared/);
    expect(c.t.rows('SELECT * FROM transactions WHERE connection_id = ?', 'k')).toEqual([]);
    expect(c.t.rows('SELECT * FROM snapshots WHERE connection_id = ?', 'k')).toEqual([]);
    expect(c.t.rows('SELECT * FROM daily_revenue WHERE connection_id = ?', 'k')).toEqual([]);
    expect(c.t.rows('SELECT revenue_cursor, revenue_synced_until, test_mode FROM connections WHERE id = ?', 'k')[0]).toEqual({
      revenue_cursor: null,
      revenue_synced_until: null,
      test_mode: 0,
    });

    // …and the sync it started is a fresh 90-day backfill (from midnight, 89 days before today).
    expect(await drainQueue(c.env)).toMatchObject([{ body: { kind: 'manual' }, outcome: 'ack' }]);
    expect(c.t.rows('SELECT ok FROM sync_runs WHERE connection_id = ?', 'k')).toEqual([{ ok: 1 }]);
    expect(revenue.mock.calls).toHaveLength(1);
    expect(revenue.mock.calls[0]![1]).toEqual({ since: dayStart(addDays(dayKey(NOW), -89)), cursor: null });
  });

  it('refuses to swap the key while a sync is running', async () => {
    const c = setup();
    stubStripe();
    await seedStripeWithHistory(c, 'k', { testMode: true, status: 'syncing', startedAt: NOW - 1000 });
    const r = await rotateCredentials(c.env, c.userId, 'k', { apiKey: 'rk_test_new' });
    expect(r).toMatchObject({ ok: false, error: 'A sync is running for this connection. Try again in a minute.' });
    expect(c.t.rows('SELECT revenue_cursor FROM connections WHERE id = ?', 'k')[0]).toEqual({ revenue_cursor: 'old-cursor' });
  });

  it("doesn't touch someone else's connection", async () => {
    const c = setup();
    stubStripe();
    c.t.exec("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('other', 'o@example.com', 'x', 0, 0)");
    seedConnection(c.t, { id: 'theirs', userId: 'other', provider: 'stripe' });
    const r = await rotateCredentials(c.env, c.userId, 'theirs', { apiKey: 'rk_test_new' });
    expect(r).toMatchObject({ ok: false, error: 'Connection not found.' });
  });
});

describe('deleteConnection', () => {
  it('removes the connection and all its synced data, scoped to the owner', async () => {
    const c = setup();
    await seedStripeWithHistory(c, 'k', { testMode: false });
    c.t.exec("INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES ('k', '2026-11-02', 'USD', 1000, 0, 1, 'transactions')");
    c.t.exec("INSERT INTO sync_runs (connection_id, kind, started_at, finished_at, ok, events) VALUES ('k', 'cron', 1, 2, 1, 1)");
    c.t.exec("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('other', 'o@example.com', 'x', 0, 0)");
    expect(await deleteConnection(c.env, 'other', 'k')).toBe(false);
    for (const table of ['connections', 'transactions', 'snapshots', 'daily_revenue', 'sync_runs']) {
      expect(c.t.rows(`SELECT * FROM ${table}`), table).toHaveLength(1);
    }
    expect(await deleteConnection(c.env, c.userId, 'k')).toBe(true);
    for (const table of ['connections', 'transactions', 'snapshots', 'daily_revenue', 'sync_runs']) {
      expect(c.t.rows(`SELECT * FROM ${table}`), table).toEqual([]);
    }
  });
});

describe('triggerSync', () => {
  it('enforces the manual cooldown and the running-sync guard', async () => {
    const c = setup();
    await seedStripeWithHistory(c, 'k', { testMode: true, startedAt: NOW - 30_000 });
    expect(await triggerSync(c.env, c.userId, 'k', NOW)).toEqual({ ok: false, error: 'Synced moments ago. Try again in a minute.' });
    c.t.exec("UPDATE connections SET status = 'syncing' WHERE id = 'k'");
    expect(await triggerSync(c.env, c.userId, 'k', NOW)).toEqual({ ok: false, error: 'A sync is already running for this connection.' });
    expect(await triggerSync(c.env, c.userId, 'missing', NOW)).toEqual({ ok: false, error: 'Connection not found.' });
  });

  it('runs once the cooldown has passed, and a stale "syncing" lock does not block it', async () => {
    const c = setup();
    stubStripe();
    await seedStripeWithHistory(c, 'k', { testMode: true, status: 'syncing', startedAt: NOW - 6 * 60_000 });
    const r = await triggerSync(c.env, c.userId, 'k', NOW);
    expect(r).toMatchObject({ ok: true, result: { ok: true, snapshot: true } });
    expect(c.t.rows('SELECT status, last_sync_started_at FROM connections WHERE id = ?', 'k')[0]).toEqual({
      status: 'ok',
      last_sync_started_at: NOW,
    });
  });
});

describe('startSync', () => {
  it('queues a manual sync once; a second click is told one is on its way', async () => {
    const c = setup();
    stubStripe();
    await seedStripeWithHistory(c, 'k', { testMode: true, startedAt: NOW - 2 * HOUR });

    expect(await startSync(c.env, c.userId, 'k', NOW)).toEqual({ ok: true, requestedAt: NOW });
    expect(await startSync(c.env, c.userId, 'k', NOW + 1_000)).toEqual({ ok: false, error: SYNC_QUEUED_MESSAGE });
    expect(queueOf(c.env).sent).toHaveLength(1);

    // The consumer takes the lock, which clears the mark; the run is the one the page waits for.
    await drainQueue(c.env);
    expect(c.t.rows('SELECT queued_at, status FROM connections WHERE id = ?', 'k')).toEqual([{ queued_at: null, status: 'ok' }]);
    expect(c.t.rows('SELECT kind, ok FROM sync_runs WHERE connection_id = ?', 'k')).toEqual([{ kind: 'manual', ok: 1 }]);
  });

  it('says so when the queue refuses, and leaves nothing marked', async () => {
    const c = setup();
    await seedStripeWithHistory(c, 'k', { testMode: true, startedAt: NOW - 2 * HOUR });
    queueOf(c.env).failNext = true;
    expect(await startSync(c.env, c.userId, 'k', NOW)).toEqual({ ok: false, error: 'Couldn’t start a sync right now. Try again in a minute.' });
    expect(c.t.rows('SELECT queued_at FROM connections WHERE id = ?', 'k')).toEqual([{ queued_at: null }]);
  });
});

describe('createConnection queues the first sync', () => {
  it('a demo connection is saved, queued as initial, and filled by the consumer', async () => {
    const c = setup();
    const r = await createConnection(c.env, c.userId, 'demo', undefined, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(queueOf(c.env).sent.map((m) => m.body)).toEqual([{ v: 1, connectionId: r.id, kind: 'initial', at: NOW }]);
    await drainQueue(c.env);
    expect(c.t.rows('SELECT kind, ok FROM sync_runs WHERE connection_id = ?', r.id)).toEqual([{ kind: 'initial', ok: 1 }]);
  });

  it('a queue outage still saves the connection; the cron picks it up', async () => {
    const c = setup();
    queueOf(c.env).failNext = true;
    const r = await createConnection(c.env, c.userId, 'demo', undefined, {});
    expect(r.ok).toBe(true);
    expect(c.t.rows('SELECT status, queued_at FROM connections')).toEqual([{ status: 'pending', queued_at: null }]);
  });
});

describe('createConnection form messages', () => {
  it('asks for required fields without calling the provider', async () => {
    const c = setup();
    const r = await createConnection(c.env, c.userId, 'stripe', undefined, {});
    expect(r).toMatchObject({ ok: false, error: 'Fill in the required fields.' });
    if (!r.ok) expect(Object.keys(r.fieldErrors)).toEqual(['apiKey']);
  });

  it('puts the specific problem on the field and a short note on the form', async () => {
    const c = setup();
    vi.stubGlobal('fetch', fakeFetch([route('/v1/subscriptions', { status: 401, json: { error: { message: 'Invalid API Key provided' } } })]).fetch);
    const r = await createConnection(c.env, c.userId, 'stripe', undefined, { apiKey: 'rk_test_wrong' });
    expect(r).toMatchObject({ ok: false, error: 'Nothing was saved. See the field below.' });
    if (!r.ok) expect(r.fieldErrors['apiKey']).toMatch(/^Stripe rejected this key\./);
  });

  it('explains an unreachable provider without a field', async () => {
    const c = setup();
    vi.stubGlobal('fetch', fakeFetch([route('/v1/subscriptions', { status: 503, json: {} })]).fetch);
    const r = await createConnection(c.env, c.userId, 'stripe', undefined, { apiKey: 'rk_test_x' });
    // toEqual, not toMatchObject: inside toMatchObject `fieldErrors: {}` matches any object.
    expect(r).toEqual({ ok: false, error: 'Couldn’t reach Stripe. Try again in a few minutes.', fieldErrors: {} });
  });

  it('states the connection limit', async () => {
    const c = setup();
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) seedConnection(c.t, { id: `c${i}`, userId: c.userId, provider: 'demo' });
    const r = await createConnection(c.env, c.userId, 'demo', undefined, {});
    expect(r).toMatchObject({
      ok: false,
      error: `You’ve reached the limit of ${MAX_CONNECTIONS_PER_USER} connections. Delete one to add another.`,
    });
  });
});
