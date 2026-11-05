import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripeAdapter } from '../../src/providers/stripe';
import { HOUR, MINUTE } from '../../src/lib/time';
import { CRON_BATCH_SIZE, runScheduledSync } from '../../src/sync/engine';
import { FX_BODY, NOW, SECRET, SNAP, conn, encryptedCreds, page, runs, setup, teardown, type Ctx } from './helpers';
import { seedConnection, seedUser } from '../fixtures/d1';

let current: Ctx | null = null;
function ctx(opts?: Parameters<typeof setup>[0]): Ctx {
  current = setup(opts);
  return current;
}

afterEach(() => {
  const out = current?.out.join('\n') ?? '';
  current = null;
  teardown();
  expect(out).not.toContain(SECRET);
});

let blob = '';
async function seed(
  c: Ctx,
  id: string,
  s: { lastSyncedAt?: number | null; lastSyncStartedAt?: number | null; status?: 'pending' | 'syncing' | 'ok' | 'error'; createdAt?: number } = {},
): Promise<void> {
  blob ||= await encryptedCreds();
  seedConnection(c.t, {
    id,
    userId: c.userId,
    provider: 'stripe',
    credentialsEnc: blob,
    status: s.status ?? 'ok',
    lastSyncedAt: s.lastSyncedAt ?? null,
    lastSyncStartedAt: s.lastSyncStartedAt === undefined ? (s.lastSyncedAt ?? null) : s.lastSyncStartedAt,
    createdAt: s.createdAt ?? 0,
  });
}

function stripeOk() {
  const snap = vi.spyOn(stripeAdapter, 'fetchSnapshot').mockResolvedValue(SNAP);
  vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
  return snap;
}

const syncedIds = (c: Ctx) => runs(c.t).map((r) => r.connection_id);

function summary(c: Ctx): Record<string, unknown> {
  const lines = c.out.filter((l) => l.includes('"cron_sync"'));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('runScheduledSync — selection', () => {
  it('syncs at most 10 due connections, most overdue first', async () => {
    const c = ctx();
    stripeOk();
    await seed(c, 'never', { createdAt: 5 });
    for (let h = 12; h >= 2; h--) await seed(c, `h${String(h).padStart(2, '0')}`, { lastSyncedAt: NOW - h * HOUR });
    await seed(c, 'recent', { lastSyncedAt: NOW - 10 * MINUTE });

    await runScheduledSync(c.env, NOW);

    expect(CRON_BATCH_SIZE).toBe(10);
    expect(syncedIds(c)).toEqual(['never', 'h12', 'h11', 'h10', 'h09', 'h08', 'h07', 'h06', 'h05', 'h04']);
    expect(runs(c.t).every((r) => r.kind === 'cron' && r.ok === 1)).toBe(true);
    expect(conn(c.t, 'h03').last_synced_at).toBe(NOW - 3 * HOUR);
    expect(summary(c)).toMatchObject({ event: 'cron_sync', due: 10, started: 10, ok: 10, failed: 0, stoppedEarly: false, fx: 'refreshed' });
  });

  it('backs off failing keys to 3 intervals, skips fresh locks and takes over stale ones', async () => {
    const c = ctx();
    stripeOk();
    await seed(c, 'fail-recent', { status: 'error', lastSyncedAt: null, lastSyncStartedAt: NOW - 61 * MINUTE });
    await seed(c, 'fail-old', { status: 'error', lastSyncedAt: null, lastSyncStartedAt: NOW - 3 * HOUR });
    // Failing since a while: the old SUCCESS must not make it due, only the last ATTEMPT counts.
    await seed(c, 'ok-but-failing-since', { status: 'error', lastSyncedAt: NOW - 9 * HOUR, lastSyncStartedAt: NOW - 2 * HOUR });
    await seed(c, 'busy', { status: 'syncing', lastSyncedAt: NOW - 5 * HOUR, lastSyncStartedAt: NOW - MINUTE });
    await seed(c, 'stuck', { status: 'syncing', lastSyncedAt: NOW - 5 * HOUR, lastSyncStartedAt: NOW - 2 * HOUR });
    await seed(c, 'not-yet', { lastSyncedAt: NOW - 50 * MINUTE });
    // Syncs start seconds after each tick; a small grace keeps a 60-min interval from slipping to 90.
    await seed(c, 'grace', { lastSyncedAt: NOW - 58 * MINUTE });

    await runScheduledSync(c.env, NOW);

    expect(syncedIds(c).sort()).toEqual(['fail-old', 'grace', 'stuck']);
    expect(conn(c.t, 'busy')).toMatchObject({ status: 'syncing', last_sync_started_at: NOW - MINUTE });
    expect(conn(c.t, 'fail-old')).toMatchObject({ status: 'ok', last_synced_at: NOW });
  });

  it('retries a never-synced connection as soon as its first sync is known to be dead', async () => {
    const c = ctx();
    stripeOk();
    await seed(c, 'new', { status: 'pending', lastSyncedAt: null, lastSyncStartedAt: null });
    // The initial sync's worker was killed 6 minutes ago: the lock is stale, retry now, not in an hour.
    await seed(c, 'killed-initial', { status: 'syncing', lastSyncedAt: null, lastSyncStartedAt: NOW - 6 * MINUTE });
    await seed(c, 'initial-running', { status: 'syncing', lastSyncedAt: null, lastSyncStartedAt: NOW - 2 * MINUTE });
    // Key just rotated (status back to pending) after a recent attempt: give its own sync a chance first.
    await seed(c, 'just-rotated', { status: 'pending', lastSyncedAt: null, lastSyncStartedAt: NOW - 3 * MINUTE });

    await runScheduledSync(c.env, NOW);

    expect(syncedIds(c).sort()).toEqual(['killed-initial', 'new']);
    expect(conn(c.t, 'killed-initial')).toMatchObject({ status: 'ok', last_synced_at: NOW });
  });

  it('round-robins between tenants so one tenant cannot fill the batch', async () => {
    const c = ctx();
    stripeOk();
    seedUser(c.t, { id: 'big' });
    for (let i = 0; i < 25; i++) {
      seedConnection(c.t, {
        id: `big-${String(i).padStart(2, '0')}`,
        userId: 'big',
        provider: 'stripe',
        credentialsEnc: await encryptedCreds(),
        status: 'ok',
        lastSyncedAt: NOW - 20 * HOUR + i * MINUTE, // all far more overdue than the small tenant
        lastSyncStartedAt: NOW - 20 * HOUR + i * MINUTE,
      });
    }
    await seed(c, 'small-1', { lastSyncedAt: NOW - 2 * HOUR });
    await seed(c, 'small-2', { lastSyncedAt: NOW - 90 * MINUTE });

    await runScheduledSync(c.env, NOW);

    // Turn 1: each tenant's most overdue; turn 2: each tenant's second; then the big tenant's rest.
    expect(syncedIds(c)).toEqual(['big-00', 'small-1', 'big-01', 'small-2', 'big-02', 'big-03', 'big-04', 'big-05', 'big-06', 'big-07']);
  });

  it('falls back to a 60-minute interval when SYNC_INTERVAL_MINUTES is not a number', async () => {
    const c = ctx({ env: { SYNC_INTERVAL_MINUTES: 'often' } });
    stripeOk();
    await seed(c, 'a', { lastSyncedAt: NOW - 30 * MINUTE });
    await seed(c, 'b', { lastSyncedAt: NOW - 70 * MINUTE });
    await runScheduledSync(c.env, NOW);
    expect(syncedIds(c)).toEqual(['b']);
  });

  it('honours a custom interval', async () => {
    const c = ctx({ env: { SYNC_INTERVAL_MINUTES: '240' } });
    stripeOk();
    await seed(c, 'a', { lastSyncedAt: NOW - 2 * HOUR });
    await seed(c, 'b', { lastSyncedAt: NOW - 5 * HOUR });
    await runScheduledSync(c.env, NOW);
    expect(syncedIds(c)).toEqual(['b']);
  });

  it('a failing connection is recorded and does not stop the others', async () => {
    const c = ctx();
    vi.spyOn(stripeAdapter, 'fetchSnapshot')
      .mockRejectedValueOnce(new Error('kaboom'))
      .mockResolvedValue(SNAP);
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
    await seed(c, 'a', { lastSyncedAt: NOW - 3 * HOUR });
    await seed(c, 'b', { lastSyncedAt: NOW - 2 * HOUR });
    await runScheduledSync(c.env, NOW);
    expect(conn(c.t, 'a').status).toBe('error');
    expect(conn(c.t, 'b').status).toBe('ok');
    expect(summary(c)).toMatchObject({ due: 2, started: 2, ok: 1, failed: 1 });
  });
});

describe('runScheduledSync — FX and limits', () => {
  it('refreshes FX at most once per ~day, and cron syncs never call ensureFx themselves', async () => {
    const c = ctx();
    stripeOk();
    await seed(c, 'a', { lastSyncedAt: NOW - 3 * HOUR });
    await seed(c, 'b', { lastSyncedAt: NOW - 2 * HOUR });

    await runScheduledSync(c.env, NOW);
    expect(c.fxCalls).toHaveLength(1);
    expect(c.t.rows('SELECT day FROM fx_rates')).toEqual([{ day: FX_BODY.date }]);

    vi.setSystemTime(NOW + 30 * MINUTE);
    await runScheduledSync(c.env, NOW + 30 * MINUTE);
    vi.setSystemTime(NOW + 12 * HOUR);
    await runScheduledSync(c.env, NOW + 12 * HOUR);
    expect(c.fxCalls).toHaveLength(1);

    vi.setSystemTime(NOW + 21 * HOUR);
    await runScheduledSync(c.env, NOW + 21 * HOUR);
    expect(c.fxCalls).toHaveLength(2);
  });

  it('an FX outage does not block syncing', async () => {
    const c = ctx({ fx: { status: 503, body: 'down' } });
    stripeOk();
    await seed(c, 'a', { lastSyncedAt: NOW - 3 * HOUR });
    await seed(c, 'b', { lastSyncedAt: null });

    await expect(runScheduledSync(c.env, NOW)).resolves.toBeUndefined();

    expect(syncedIds(c).sort()).toEqual(['a', 'b']);
    expect(conn(c.t, 'a').status).toBe('ok');
    expect(c.t.rows('SELECT 1 FROM fx_rates')).toEqual([]);
    expect(c.fxCalls).toHaveLength(1); // one attempt per tick, not one per connection
    expect(summary(c)).toMatchObject({ fx: 'failed', ok: 2 });
  });

  it('stops starting new syncs after ~10 minutes of wall time', async () => {
    const c = ctx();
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 6 * MINUTE); // a slow provider
      return SNAP;
    });
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
    for (let i = 1; i <= 5; i++) await seed(c, `c${i}`, { lastSyncedAt: NOW - (10 - i) * HOUR });

    await runScheduledSync(c.env, NOW);

    expect(syncedIds(c)).toEqual(['c1', 'c2']);
    expect(conn(c.t, 'c3').last_synced_at).toBe(NOW - 7 * HOUR);
    expect(summary(c)).toMatchObject({ due: 5, started: 2, stoppedEarly: true });
  });

  it('never throws, even when D1 is down', async () => {
    const c = ctx();
    const broken = { ...c.env, DB: { prepare: () => { throw new Error('D1_ERROR: down'); } } as unknown as D1Database };
    await expect(runScheduledSync(broken, NOW)).resolves.toBeUndefined();
    expect(summary(c)).toMatchObject({ error: { errorKind: 'internal', message: 'D1_ERROR: down' }, started: 0 });
  });
});
