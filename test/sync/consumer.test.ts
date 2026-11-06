/** The sync queue's consumer (sync/consumer.ts): what it acks, retries and ignores. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripeAdapter } from '../../src/providers/stripe';
import { MINUTE } from '../../src/lib/time';
import { enqueueSync } from '../../src/sync/queue';
import { deliver, drainQueue, queueOf } from '../fixtures/queue';
import { NOW, SECRET, SNAP, conn, page, runs, seedStripe, setup, teardown, type Ctx } from './helpers';

let current: Ctx | null = null;
afterEach(() => {
  const out = current?.out.join('\n') ?? '';
  current = null;
  teardown();
  expect(out).not.toContain(SECRET);
});

function stripeOk(): void {
  vi.spyOn(stripeAdapter, 'fetchSnapshot').mockResolvedValue(SNAP);
  vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
}

describe('handleSyncBatch', () => {
  it('runs the sync a message names and acks it, success or failure', async () => {
    const c = (current = setup());
    await seedStripe(c, 'ok-1');
    await seedStripe(c, 'bad-1');
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockImplementation(async () => {
      if (vi.mocked(stripeAdapter.fetchSnapshot).mock.calls.length === 2) throw new Error('kaboom');
      return SNAP;
    });
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
    await enqueueSync(c.env, 'ok-1', 'manual', NOW);
    await enqueueSync(c.env, 'bad-1', 'cron', NOW);

    expect((await drainQueue(c.env)).map((d) => d.outcome)).toEqual(['ack', 'ack']);
    expect(runs(c.t).map((r) => [r.connection_id, r.kind, r.ok])).toEqual([
      ['ok-1', 'manual', 1],
      ['bad-1', 'cron', 0],
    ]);
    expect(conn(c.t, 'bad-1').status).toBe('error');
  });

  it('acks and logs a message it can’t read, without touching anything', async () => {
    const c = (current = setup());
    for (const body of [null, 'sync', { v: 2, connectionId: 'x', kind: 'cron' }, { v: 1, connectionId: 'x', kind: 'nightly' }]) {
      expect((await deliver(c.env, body)).outcome).toBe('ack');
    }
    expect(c.out.filter((l) => l.includes('"queue_message_ignored"'))).toHaveLength(4);
    expect(runs(c.t)).toEqual([]);
  });

  it('a connection deleted since it was queued is a quiet ack', async () => {
    const c = (current = setup());
    expect((await deliver(c.env, { v: 1, connectionId: 'gone', kind: 'manual', at: NOW })).outcome).toBe('ack');
  });

  it('when another sync holds the lock: ack, and drop this message’s queued mark', async () => {
    const c = (current = setup());
    stripeOk();
    await seedStripe(c, 'k', { status: 'syncing', lastSyncStartedAt: NOW - MINUTE });
    await enqueueSync(c.env, 'k', 'manual', NOW);
    expect(c.t.rows('SELECT queued_at FROM connections')).toEqual([{ queued_at: NOW }]);

    expect(await drainQueue(c.env)).toMatchObject([{ outcome: 'ack' }]);
    expect(c.t.rows('SELECT queued_at FROM connections')).toEqual([{ queued_at: null }]);
    expect(runs(c.t)).toEqual([]);
  });

  it('a newer queued mark survives an older message finding the connection busy', async () => {
    const c = (current = setup());
    await seedStripe(c, 'k', { status: 'syncing', lastSyncStartedAt: NOW - MINUTE });
    c.t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW + 5_000, 'k');
    await deliver(c.env, { v: 1, connectionId: 'k', kind: 'cron', at: NOW });
    expect(c.t.rows('SELECT queued_at FROM connections')).toEqual([{ queued_at: NOW + 5_000 }]);
  });

  it('retries a message whose handling crashed outside the sync', async () => {
    const c = (current = setup());
    await seedStripe(c, 'k', { status: 'syncing', lastSyncStartedAt: NOW - MINUTE });
    const broken = {
      ...c.env,
      DB: new Proxy(c.env.DB, {
        get(target, prop, receiver) {
          if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
          return (sql: string) => {
            if (sql.includes('queued_at = NULL WHERE id IN')) throw new Error('D1_ERROR: down');
            return target.prepare(sql);
          };
        },
      }),
    };
    const d = await deliver(broken, { v: 1, connectionId: 'k', kind: 'cron', at: NOW });
    expect(d).toMatchObject({ outcome: 'retry', retryDelaySeconds: 60 });
    expect(c.out.some((l) => l.includes('"queue_sync_crashed"'))).toBe(true);
    expect(queueOf(c.env).sent).toEqual([]);
  });
});
