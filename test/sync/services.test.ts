/** Connection services: key rotation semantics and deletion (Data Plane). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CONNECTIONS_PER_USER, createConnection, deleteConnection, rotateCredentials, triggerSync } from '../../src/services/connections';
import { DAY, HOUR } from '../../src/lib/time';
import { seedConnection } from '../fixtures/d1';
import { fakeFetch, route } from '../fixtures/harness';
import { FX_BODY, NOW, encryptedCreds, setup, teardown, type Ctx } from './helpers';

afterEach(() => teardown());

const emptyList = { object: 'list', data: [], has_more: false };

function execCtx(pending: Promise<unknown>[]): ExecutionContext {
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
}

function stubStripe(): void {
  const { fetch } = fakeFetch([
    route('/v1/latest', { json: FX_BODY }),
    route('/v1/subscriptions', { json: emptyList }),
    route('/v1/prices', { json: emptyList }),
    route('/v1/balance_transactions', { json: emptyList }),
    route('/v1/coupons', { json: emptyList }),
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
    await seedStripeWithHistory(c, 'k', { testMode: true });
    const pending: Promise<unknown>[] = [];
    const r = await rotateCredentials(c.env, execCtx(pending), c.userId, 'k', { apiKey: 'rk_test_new' });
    expect(r).toMatchObject({ ok: true });
    // Before the background sync runs: cursor cleared, high-water and history kept.
    const row = c.t.rows<{ revenue_cursor: string | null; revenue_synced_until: number | null }>(
      'SELECT revenue_cursor, revenue_synced_until FROM connections WHERE id = ?',
      'k',
    )[0]!;
    expect(row).toEqual({ revenue_cursor: null, revenue_synced_until: NOW - HOUR });
    expect(c.t.rows('SELECT * FROM transactions WHERE connection_id = ?', 'k')).toHaveLength(1);
    expect(c.t.rows('SELECT * FROM snapshots WHERE connection_id = ? AND day = ?', 'k', '2026-11-01')).toHaveLength(1);
    await Promise.all(pending);
  });

  it('purges synced data and restarts the backfill when switching test → live', async () => {
    const c = setup();
    stubStripe();
    await seedStripeWithHistory(c, 'k', { testMode: true });
    const r = await rotateCredentials(c.env, execCtx([]), c.userId, 'k', { apiKey: 'rk_live_new' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/previously synced data was cleared/);
    expect(c.t.rows('SELECT * FROM transactions WHERE connection_id = ?', 'k')).toEqual([]);
    expect(c.t.rows('SELECT * FROM snapshots WHERE connection_id = ?', 'k')).toEqual([]);
    expect(c.t.rows('SELECT revenue_cursor, revenue_synced_until, test_mode FROM connections WHERE id = ?', 'k')[0]).toEqual({
      revenue_cursor: null,
      revenue_synced_until: null,
      test_mode: 0,
    });
  });

  it('refuses to swap the key while a sync is running', async () => {
    const c = setup();
    stubStripe();
    await seedStripeWithHistory(c, 'k', { testMode: true, status: 'syncing', startedAt: NOW - 1000 });
    const r = await rotateCredentials(c.env, execCtx([]), c.userId, 'k', { apiKey: 'rk_test_new' });
    expect(r).toMatchObject({ ok: false, error: 'A sync is running for this connection. Try again in a minute.' });
    expect(c.t.rows('SELECT revenue_cursor FROM connections WHERE id = ?', 'k')[0]).toEqual({ revenue_cursor: 'old-cursor' });
  });

  it("doesn't touch someone else's connection", async () => {
    const c = setup();
    stubStripe();
    c.t.exec("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('other', 'o@example.com', 'x', 0, 0)");
    seedConnection(c.t, { id: 'theirs', userId: 'other', provider: 'stripe' });
    const r = await rotateCredentials(c.env, execCtx([]), c.userId, 'theirs', { apiKey: 'rk_test_new' });
    expect(r).toMatchObject({ ok: false, error: 'Connection not found.' });
  });
});

describe('deleteConnection', () => {
  it('removes the connection and all its synced data, scoped to the owner', async () => {
    const c = setup();
    await seedStripeWithHistory(c, 'k', { testMode: false });
    c.t.exec("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('other', 'o@example.com', 'x', 0, 0)");
    expect(await deleteConnection(c.env, 'other', 'k')).toBe(false);
    expect(c.t.rows('SELECT * FROM transactions')).toHaveLength(1);
    expect(await deleteConnection(c.env, c.userId, 'k')).toBe(true);
    expect(c.t.rows('SELECT * FROM connections')).toEqual([]);
    expect(c.t.rows('SELECT * FROM transactions')).toEqual([]);
    expect(c.t.rows('SELECT * FROM snapshots')).toEqual([]);
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
});

describe('createConnection form messages', () => {
  const ctx = { waitUntil: () => undefined };

  it('asks for required fields without calling the provider', async () => {
    const c = setup();
    const r = await createConnection(c.env, ctx, c.userId, 'stripe', undefined, {});
    expect(r).toMatchObject({ ok: false, error: 'Fill in the required fields.' });
    if (!r.ok) expect(Object.keys(r.fieldErrors)).toEqual(['apiKey']);
  });

  it('puts the specific problem on the field and a short note on the form', async () => {
    const c = setup();
    vi.stubGlobal('fetch', fakeFetch([route('/v1/subscriptions', { status: 401, json: { error: { message: 'Invalid API Key provided' } } })]).fetch);
    const r = await createConnection(c.env, ctx, c.userId, 'stripe', undefined, { apiKey: 'rk_test_wrong' });
    expect(r).toMatchObject({ ok: false, error: 'Nothing was saved. See the field below.' });
    if (!r.ok) expect(r.fieldErrors['apiKey']).toMatch(/^Stripe rejected this key\./);
  });

  it('explains an unreachable provider without a field', async () => {
    const c = setup();
    vi.stubGlobal('fetch', fakeFetch([route('/v1/subscriptions', { status: 503, json: {} })]).fetch);
    const r = await createConnection(c.env, ctx, c.userId, 'stripe', undefined, { apiKey: 'rk_test_x' });
    expect(r).toMatchObject({ ok: false, error: 'Couldn’t reach Stripe. Try again in a few minutes.', fieldErrors: {} });
  });

  it('states the connection limit', async () => {
    const c = setup();
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) seedConnection(c.t, { id: `c${i}`, userId: c.userId, provider: 'demo' });
    const r = await createConnection(c.env, ctx, c.userId, 'demo', undefined, {});
    expect(r).toMatchObject({
      ok: false,
      error: `You’ve reached the limit of ${MAX_CONNECTIONS_PER_USER} connections. Delete one to add another.`,
    });
  });
});
