import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripeAdapter } from '../../src/providers/stripe';
import { HOUR, MINUTE } from '../../src/lib/time';
import { startSync } from '../../src/services/connections';
import { CRON_MAX_ROUNDS, CRON_QUEUE_DEADLINE_MS, CRON_QUEUE_LIMIT, runScheduledSync } from '../../src/sync/engine';
import { QUEUED_STALE_MS, SEND_BATCH_MAX, enqueueSyncs } from '../../src/sync/queue';
import { FX_BODY, NOW, SECRET, SNAP, conn, encryptedCreds, page, runs, setup, teardown, type Ctx } from './helpers';
import { seedConnection, seedUser } from '../fixtures/d1';
import { drainQueue, queueOf } from '../fixtures/queue';

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

/** One cron tick, then the queue consumer working through what it sent. */
async function tick(c: Ctx, at = NOW): Promise<void> {
  await runScheduledSync(c.env, at);
  await drainQueue(c.env);
}

function summary(c: Ctx): Record<string, unknown> {
  const lines = c.out.filter((l) => l.includes('"cron_sync"'));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** The console method the `cron_sync` summary went to. */
function summaryLevel(): string | undefined {
  return (['log', 'warn', 'error'] as const).find((level) =>
    vi.mocked(console[level]).mock.calls.some((args) => String(args[0]).includes('"cron_sync"')),
  );
}

/** The connections sent so far, in order (and forgets them). */
const sentIds = (c: Ctx) => queueOf(c.env).take().map((m) => (m.body as { connectionId: string }).connectionId);

/** Records the size of every `sendBatch` call from now on. */
function batchSizes(c: Ctx): number[] {
  const q = queueOf(c.env);
  const send = q.sendBatch.bind(q);
  const sizes: number[] = [];
  q.sendBatch = async (messages, options) => {
    const list = [...messages];
    sizes.push(list.length);
    return send(list, options);
  };
  return sizes;
}

const pad = (i: number, width = 4) => String(i).padStart(width, '0');

/** `n` of the default tenant's connections, all due, most overdue first: c0000, c0001, … */
async function seedDue(c: Ctx, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(`c${pad(i)}`);
    await seed(c, ids[i]!, { lastSyncedAt: NOW - 5 * HOUR + i * 1_000 });
  }
  return ids;
}

/** A D1 whose `prepare` runs `hook` on each statement's SQL first; `hook` may return a stand-in. */
function interceptDb(db: D1Database, hook: (sql: string) => unknown): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql: string) => hook(sql) ?? target.prepare(sql);
    },
  });
}

describe('runScheduledSync — selection', () => {
  it('queues every due connection, most overdue first, and the consumer syncs them', async () => {
    const c = ctx();
    stripeOk();
    await seed(c, 'never', { createdAt: 5 });
    for (let h = 12; h >= 2; h--) await seed(c, `h${String(h).padStart(2, '0')}`, { lastSyncedAt: NOW - h * HOUR });
    await seed(c, 'recent', { lastSyncedAt: NOW - 10 * MINUTE });

    await runScheduledSync(c.env, NOW);

    const due = ['never', 'h12', 'h11', 'h10', 'h09', 'h08', 'h07', 'h06', 'h05', 'h04', 'h03', 'h02'];
    expect(queueOf(c.env).sent.map((m) => m.body)).toEqual(due.map((connectionId) => ({ v: 1, connectionId, kind: 'cron', at: NOW })));
    expect(conn(c.t, 'h02')).toMatchObject({ status: 'ok', last_synced_at: NOW - 2 * HOUR }); // queued, not synced yet
    expect(c.t.rows<{ id: string }>('SELECT id FROM connections WHERE queued_at = ? ORDER BY id', NOW)).toHaveLength(12);
    expect(summary(c)).toMatchObject({
      event: 'cron_sync',
      due: 12,
      queued: 12,
      rounds: 1,
      stop: 'done',
      left: 0,
      requeued: 0,
      fx: 'refreshed',
      fxHistory: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(summaryLevel()).toBe('log');

    expect((await drainQueue(c.env)).every((d) => d.outcome === 'ack')).toBe(true);
    expect(syncedIds(c)).toEqual(due);
    expect(runs(c.t).every((r) => r.kind === 'cron' && r.ok === 1)).toBe(true);
    expect(c.t.rows('SELECT 1 FROM connections WHERE queued_at IS NOT NULL')).toEqual([]); // the lock cleared every mark
  });

  it('skips a connection that already has a sync on the queue, until that mark goes stale', async () => {
    const c = ctx();
    await seed(c, 'waiting', { lastSyncedAt: NOW - 3 * HOUR });
    c.t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW - 10 * MINUTE, 'waiting');

    await runScheduledSync(c.env, NOW);
    expect(queueOf(c.env).take()).toEqual([]);

    const later = NOW - 10 * MINUTE + QUEUED_STALE_MS + 1;
    vi.setSystemTime(later);
    await runScheduledSync(c.env, later);
    expect(queueOf(c.env).take()).toHaveLength(1);
  });

  it(`a mark exactly ${QUEUED_STALE_MS / MINUTE} minutes old is stale; one a millisecond younger is not`, async () => {
    const c = ctx();
    await seed(c, 'k', { lastSyncedAt: NOW - 3 * HOUR });
    c.t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW - QUEUED_STALE_MS + 1, 'k');
    await runScheduledSync(c.env, NOW);
    expect(queueOf(c.env).take()).toEqual([]);

    c.t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW - QUEUED_STALE_MS, 'k');
    await runScheduledSync(c.env, NOW);
    expect(queueOf(c.env).take().map((m) => m.body)).toEqual([{ v: 1, connectionId: 'k', kind: 'cron', at: NOW }]);
  });

  it('a Sync now that lands between the due query and the queueing is not queued twice', async () => {
    const c = ctx();
    await seed(c, 'k', { lastSyncedAt: NOW - 3 * HOUR });
    await seed(c, 'other', { lastSyncedAt: NOW - 2 * HOUR });
    // The cron has read 'k' as due; before it marks anything, the user clicks Sync now.
    const db = new Proxy(c.env.DB, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes('WITH candidates AS')) return stmt;
          return {
            bind: (...args: unknown[]) => ({
              all: async () => {
                const due = await stmt.bind(...args).all();
                expect(await startSync(c.env, c.userId, 'k', NOW)).toEqual({ ok: true, requestedAt: NOW });
                return due;
              },
            }),
          };
        };
      },
    });

    await runScheduledSync({ ...c.env, DB: db }, NOW);

    expect(queueOf(c.env).sent.map((m) => m.body)).toEqual([
      { v: 1, connectionId: 'k', kind: 'manual', at: NOW },
      { v: 1, connectionId: 'other', kind: 'cron', at: NOW },
    ]);
    expect(summary(c)).toMatchObject({ due: 2, queued: 1 });
  });

  it('marks a connection before its message is sent, with the message’s own time', async () => {
    const c = ctx();
    await seed(c, 'k', { lastSyncedAt: NOW - 3 * HOUR });
    const q = queueOf(c.env);
    const send = q.sendBatch.bind(q);
    const markedAtSend: unknown[] = [];
    q.sendBatch = async (messages, options) => {
      markedAtSend.push(c.t.rows<{ queued_at: number | null }>('SELECT queued_at FROM connections WHERE id = ?', 'k')[0]!.queued_at);
      return send(messages, options);
    };
    // The cron runs a few seconds after its scheduled time; the tick's time is what counts.
    vi.setSystemTime(NOW + 4_000);

    await runScheduledSync(c.env, NOW);

    expect(markedAtSend).toEqual([NOW]);
    expect(q.sent.map((m) => (m.body as { at: number }).at)).toEqual([NOW]);
    expect(c.t.rows('SELECT queued_at FROM connections WHERE id = ?', 'k')).toEqual([{ queued_at: NOW }]);
  });

  it(`sends more than ${SEND_BATCH_MAX} syncs in batches of at most ${SEND_BATCH_MAX}, and nothing at all for none`, async () => {
    const c = ctx();
    const ids: string[] = [];
    for (let i = 0; i < SEND_BATCH_MAX + 50; i++) {
      ids.push(`c${String(i).padStart(3, '0')}`);
      await seed(c, ids[i]!, { lastSyncedAt: NOW - 3 * HOUR });
    }
    await enqueueSyncs(c.env, ids, 'manual', NOW);
    expect(queueOf(c.env).take().map((m) => (m.body as { connectionId: string }).connectionId)).toEqual(ids);

    const trips = c.t.roundTrips();
    await enqueueSyncs(c.env, [], 'manual', NOW);
    expect(c.t.roundTrips()).toBe(trips);
    expect(queueOf(c.env).take()).toEqual([]);
  });

  it('a queue that refuses the batch clears the marks, so the next tick tries again', async () => {
    const c = ctx();
    await seed(c, 'a', { lastSyncedAt: NOW - 3 * HOUR });
    queueOf(c.env).failNext = true;

    await expect(runScheduledSync(c.env, NOW)).resolves.toBeUndefined();

    expect(conn(c.t, 'a')).toMatchObject({ status: 'ok' });
    expect(c.t.rows('SELECT queued_at FROM connections')).toEqual([{ queued_at: null }]);
    expect(summary(c)).toMatchObject({ due: 1, queued: 0, rounds: 1, stop: 'error', left: 1, error: { message: 'Queue send failed' } });
    expect(summaryLevel()).toBe('error');
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

    await tick(c);

    expect(syncedIds(c).sort()).toEqual(['fail-old', 'grace', 'stuck']);
    expect(conn(c.t, 'busy')).toMatchObject({ status: 'syncing', last_sync_started_at: NOW - MINUTE });
    expect(conn(c.t, 'fail-old')).toMatchObject({ status: 'ok', last_synced_at: NOW });
  });

  it('retries a never-synced connection as soon as its first sync is known to be dead', async () => {
    const c = ctx();
    stripeOk();
    await seed(c, 'new', { status: 'pending', lastSyncedAt: null, lastSyncStartedAt: null });
    // The initial sync's worker was killed 11 minutes ago: the lock is stale, retry now, not in an hour.
    await seed(c, 'killed-initial', { status: 'syncing', lastSyncedAt: null, lastSyncStartedAt: NOW - 11 * MINUTE });
    await seed(c, 'initial-running', { status: 'syncing', lastSyncedAt: null, lastSyncStartedAt: NOW - 2 * MINUTE });
    // Key just rotated (status back to pending) after a recent attempt: give its own sync a chance first.
    await seed(c, 'just-rotated', { status: 'pending', lastSyncedAt: null, lastSyncStartedAt: NOW - 3 * MINUTE });

    await tick(c);

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

    await tick(c);

    // Turn 1: each tenant's most overdue; turn 2: each tenant's second; then the big tenant's rest.
    expect(syncedIds(c)).toEqual([
      'big-00', 'small-1',
      'big-01', 'small-2',
      'big-02', 'big-03', 'big-04', 'big-05', 'big-06', 'big-07', 'big-08', 'big-09', 'big-10', 'big-11', 'big-12',
      'big-13', 'big-14', 'big-15', 'big-16', 'big-17', 'big-18', 'big-19', 'big-20', 'big-21', 'big-22', 'big-23',
      'big-24',
    ]);
  });

  it('falls back to a 60-minute interval when SYNC_INTERVAL_MINUTES is not a number', async () => {
    const c = ctx({ env: { SYNC_INTERVAL_MINUTES: 'often' } });
    stripeOk();
    await seed(c, 'a', { lastSyncedAt: NOW - 30 * MINUTE });
    await seed(c, 'b', { lastSyncedAt: NOW - 70 * MINUTE });
    await tick(c);
    expect(syncedIds(c)).toEqual(['b']);
  });

  it('honours a custom interval', async () => {
    const c = ctx({ env: { SYNC_INTERVAL_MINUTES: '240' } });
    stripeOk();
    await seed(c, 'a', { lastSyncedAt: NOW - 2 * HOUR });
    await seed(c, 'b', { lastSyncedAt: NOW - 5 * HOUR });
    await tick(c);
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
    const deliveries = await drainQueue(c.env);
    expect(conn(c.t, 'a').status).toBe('error');
    expect(conn(c.t, 'b').status).toBe('ok');
    expect(deliveries.map((d) => d.outcome)).toEqual(['ack', 'ack']); // recorded on the connection, not retried
    expect(summary(c)).toMatchObject({ due: 2, queued: 2 });
  });
});

describe('runScheduledSync — rounds', () => {
  it(`queues in rounds of ${CRON_QUEUE_LIMIT}, one sendBatch each, until nothing more is due`, async () => {
    const c = ctx();
    const ids = await seedDue(c, 2 * CRON_QUEUE_LIMIT + 50);
    const sizes = batchSizes(c);

    await runScheduledSync(c.env, NOW);

    expect(sizes).toEqual([CRON_QUEUE_LIMIT, CRON_QUEUE_LIMIT, 50]);
    const sent = queueOf(c.env).take().map((m) => m.body as { connectionId: string; kind: string; at: number });
    // Each connection once, most overdue first, every message with the tick's time.
    expect(sent.map((m) => m.connectionId)).toEqual(ids);
    expect(sent.every((m) => m.kind === 'cron' && m.at === NOW)).toBe(true);
    expect(c.t.rows('SELECT id FROM connections WHERE queued_at = ?', NOW)).toHaveLength(ids.length);
    expect(summary(c)).toMatchObject({ due: 250, queued: 250, rounds: 3, stop: 'done', left: 0, requeued: 0 });
    expect(summaryLevel()).toBe('log');
  });

  it('a full round that leaves nothing due ends the tick without selecting again', async () => {
    const c = ctx();
    await seedDue(c, 2 * CRON_QUEUE_LIMIT);
    let selections = 0;
    const db = interceptDb(c.env.DB, (sql) => {
      if (sql.includes('WITH candidates AS')) selections++;
    });

    await runScheduledSync({ ...c.env, DB: db }, NOW);

    expect(selections).toBe(2);
    expect(queueOf(c.env).take()).toHaveLength(2 * CRON_QUEUE_LIMIT);
    expect(summary(c)).toMatchObject({ due: 200, queued: 200, rounds: 2, stop: 'done', left: 0 });
  });

  it(`stops after ${CRON_MAX_ROUNDS} rounds and warns; the rest go first on the next tick`, async () => {
    const c = ctx();
    const cap = CRON_QUEUE_LIMIT * CRON_MAX_ROUNDS;
    const ids = await seedDue(c, cap + 3);
    const sizes = batchSizes(c);

    await runScheduledSync(c.env, NOW);

    expect(sizes).toEqual(Array.from({ length: CRON_MAX_ROUNDS }, () => CRON_QUEUE_LIMIT));
    expect(sentIds(c)).toEqual(ids.slice(0, cap));
    expect(summary(c)).toMatchObject({ due: cap + 3, queued: cap, rounds: CRON_MAX_ROUNDS, stop: 'cap', left: 3, requeued: 0 });
    expect(summaryLevel()).toBe('warn');

    // Ten minutes on, the first thousand are still waiting on the queue, so only the rest are sent.
    c.out.length = 0;
    vi.setSystemTime(NOW + 10 * MINUTE);
    await runScheduledSync(c.env, NOW + 10 * MINUTE);
    expect(sentIds(c)).toEqual(ids.slice(cap));
    expect(summary(c)).toMatchObject({ due: 3, queued: 3, rounds: 1, stop: 'done' });

    // Had the second tick not come early, they'd still go first: by the next tick the thousand have
    // synced, and a connection that fell due since sorts after them.
    c.t.exec('UPDATE connections SET queued_at = NULL WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids.slice(cap)));
    c.t.exec('UPDATE connections SET last_synced_at = ?1, last_sync_started_at = ?1, queued_at = NULL WHERE queued_at = ?2', NOW + MINUTE, NOW);
    await seed(c, 'since', { lastSyncedAt: NOW - 40 * MINUTE });
    c.out.length = 0;
    vi.setSystemTime(NOW + 30 * MINUTE);
    await runScheduledSync(c.env, NOW + 30 * MINUTE);
    expect(sentIds(c)).toEqual([...ids.slice(cap), 'since']);
  });

  it('round-robins tenants across rounds the way one selection would', async () => {
    const c = ctx();
    blob ||= await encryptedCreds();
    const row = (id: string, userId: string, lastSyncedAt: number) =>
      seedConnection(c.t, { id, userId, provider: 'stripe', credentialsEnc: blob, status: 'ok', lastSyncedAt, lastSyncStartedAt: lastSyncedAt });
    // One tenant with 100 connections, all far more overdue than anyone else's, and 150 tenants with
    // one each: the first turn alone is 151 connections, so it spans two rounds.
    seedUser(c.t, { id: 'big' });
    const big = Array.from({ length: 100 }, (_, i) => `big-${pad(i, 3)}`);
    big.forEach((id, i) => row(id, 'big', NOW - 20 * HOUR + i * MINUTE));
    const small = Array.from({ length: 150 }, (_, i) => `small-${pad(i, 3)}`);
    small.forEach((id, i) => {
      seedUser(c.t, { id: `tenant-${pad(i, 3)}` });
      row(id, `tenant-${pad(i, 3)}`, NOW - 2 * HOUR + i * 1_000);
    });

    await runScheduledSync(c.env, NOW);

    // Every tenant's first turn, then the big tenant's second, third, …. Round 2 doesn't start the
    // turns over, which would have put the big tenant's second connection before 51 tenants' first.
    expect(sentIds(c)).toEqual([big[0], ...small, ...big.slice(1)]);
    expect(summary(c)).toMatchObject({ due: 250, queued: 250, rounds: 3, stop: 'done' });
  });

  it('a due connection already on its way takes its tenant’s turn', async () => {
    const c = ctx();
    await seed(c, 'a1', { lastSyncedAt: NOW - 4 * HOUR });
    await seed(c, 'a2', { lastSyncedAt: NOW - 3 * HOUR });
    c.t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW - 5 * MINUTE, 'a1'); // a webhook queued it
    seedUser(c.t, { id: 'other' });
    for (const [id, ago] of [['b1', 2 * HOUR], ['b2', 90 * MINUTE]] as const) {
      seedConnection(c.t, { id, userId: 'other', provider: 'stripe', credentialsEnc: blob, status: 'ok', lastSyncedAt: NOW - ago, lastSyncStartedAt: NOW - ago });
    }

    await runScheduledSync(c.env, NOW);

    // a1 was the first tenant's first turn, so the other tenant's first goes before a2.
    expect(sentIds(c)).toEqual(['b1', 'a2', 'b2']);
    expect(summary(c)).toMatchObject({ due: 3, queued: 3 });
  });

  it('stops when a round queues nothing, instead of selecting the same connections again', async () => {
    const c = ctx();
    await seedDue(c, CRON_QUEUE_LIMIT + 50);
    let selections = 0;
    // Every claim comes back empty, as if another producer had marked each one first, yet nothing
    // marks them: without the guard, every round would select the same hundred.
    const db = interceptDb(c.env.DB, (sql) => {
      if (sql.includes('WITH candidates AS')) selections++;
      if (sql.includes('SET queued_at = ?1')) return { bind: () => ({ all: async () => ({ results: [], success: true, meta: {} }) }) };
      return undefined;
    });

    await runScheduledSync({ ...c.env, DB: db }, NOW);

    expect(selections).toBe(1);
    expect(queueOf(c.env).sent).toEqual([]);
    expect(summary(c)).toMatchObject({ due: 150, queued: 0, rounds: 1, stop: 'unclaimed', left: 50 });
    expect(summaryLevel()).toBe('log');
  });

  it(`starts no round once ${CRON_QUEUE_DEADLINE_MS / MINUTE} minutes have passed, and warns`, async () => {
    const c = ctx();
    await seedDue(c, 350);
    const q = queueOf(c.env);
    const send = q.sendBatch.bind(q);
    // A struggling queue: each send takes just over half the guard.
    q.sendBatch = async (messages, options) => {
      const r = await send(messages, options);
      vi.setSystemTime(Date.now() + CRON_QUEUE_DEADLINE_MS / 2 + 1_000);
      return r;
    };

    await runScheduledSync(c.env, NOW);

    expect(q.take()).toHaveLength(2 * CRON_QUEUE_LIMIT);
    const s = summary(c);
    expect(s).toMatchObject({ due: 350, queued: 200, rounds: 2, stop: 'deadline', left: 150 });
    expect(s['durationMs']).toBeGreaterThanOrEqual(CRON_QUEUE_DEADLINE_MS);
    expect(summaryLevel()).toBe('warn');
  });

  it('always runs the first round, however long FX took', async () => {
    const c = ctx();
    await seedDue(c, CRON_QUEUE_LIMIT + 50);
    // FX's first read: by the time it returns, the guard has passed.
    const db = interceptDb(c.env.DB, (sql) => {
      if (sql.includes('MAX(fetched_at)')) vi.setSystemTime(Date.now() + CRON_QUEUE_DEADLINE_MS + MINUTE);
    });

    await runScheduledSync({ ...c.env, DB: db }, NOW);

    expect(queueOf(c.env).take()).toHaveLength(CRON_QUEUE_LIMIT);
    expect(summary(c)).toMatchObject({ due: 150, queued: 100, rounds: 1, stop: 'deadline', left: 50, fx: 'refreshed' });
  });

  it('counts connections whose earlier message never started as requeued, and warns', async () => {
    const c = ctx();
    await seed(c, 'stuck', { lastSyncedAt: NOW - 3 * HOUR });
    // The last tick queued it; its message is still waiting behind a backlog, or was lost.
    c.t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW - 30 * MINUTE, 'stuck');
    await seed(c, 'normal', { lastSyncedAt: NOW - 2 * HOUR });

    await runScheduledSync(c.env, NOW);

    expect(sentIds(c)).toEqual(['stuck', 'normal']);
    expect(summary(c)).toMatchObject({ due: 2, queued: 2, rounds: 1, stop: 'done', left: 0, requeued: 1 });
    expect(summaryLevel()).toBe('warn');
  });
});

describe('runScheduledSync — FX and limits', () => {
  it('refreshes FX at most once per ~day, and cron syncs never call ensureFx themselves', async () => {
    const c = ctx();
    stripeOk();
    await seed(c, 'a', { lastSyncedAt: NOW - 3 * HOUR });
    await seed(c, 'b', { lastSyncedAt: NOW - 2 * HOUR });

    await tick(c);
    expect(c.fxCalls).toHaveLength(2); // the blended rates, then the ECB's
    expect(c.t.rows('SELECT day FROM fx_rates')).toEqual([{ day: FX_BODY.date }]);

    vi.setSystemTime(NOW + 30 * MINUTE);
    await tick(c, NOW + 30 * MINUTE);
    vi.setSystemTime(NOW + 12 * HOUR);
    await tick(c, NOW + 12 * HOUR);
    expect(c.fxCalls).toHaveLength(2);

    vi.setSystemTime(NOW + 21 * HOUR);
    await tick(c, NOW + 21 * HOUR);
    expect(c.fxCalls).toHaveLength(4);
  });

  it('an FX outage does not block syncing', async () => {
    const c = ctx({ fx: { status: 503, body: 'down' } });
    stripeOk();
    await seed(c, 'a', { lastSyncedAt: NOW - 3 * HOUR });
    await seed(c, 'b', { lastSyncedAt: null });

    await expect(runScheduledSync(c.env, NOW)).resolves.toBeUndefined();
    await drainQueue(c.env);

    expect(syncedIds(c).sort()).toEqual(['a', 'b']);
    expect(conn(c.t, 'a').status).toBe('ok');
    expect(c.t.rows('SELECT 1 FROM fx_rates')).toEqual([]);
    expect(c.fxCalls).toHaveLength(1); // one attempt per tick, not one per connection (the ECB's isn't tried without the blended)
    expect(summary(c)).toMatchObject({ fx: 'failed', queued: 2 });
  });

  it('never throws, even when D1 is down', async () => {
    const c = ctx();
    const broken = { ...c.env, DB: { prepare: () => { throw new Error('D1_ERROR: down'); } } as unknown as D1Database };
    await expect(runScheduledSync(broken, NOW)).resolves.toBeUndefined();
    expect(summary(c)).toMatchObject({ error: { errorKind: 'internal', message: 'D1_ERROR: down' }, queued: 0, rounds: 0, stop: 'error' });
  });
});
