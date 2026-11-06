/** The sync queue's consumer (sync/consumer.ts): what it acks, retries and ignores. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import wranglerJsonc from '../../wrangler.jsonc?raw';
import worker from '../../src/index';
import type { Bindings } from '../../src/env';
import { MINUTE } from '../../src/lib/time';
import { stripeAdapter } from '../../src/providers/stripe';
import { receiveWebhook, setWebhook, webhookToken } from '../../src/services/webhooks';
import { QUEUED_STALE_MS, enqueueSync } from '../../src/sync/queue';
import { deliver, drainQueue, oneMessageBatch, queueOf } from '../fixtures/queue';
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

/** `env` with a DB whose statements containing `fragment` throw, as D1 does when it's down. */
function failingOn(env: Bindings, fragment: string): Bindings {
  return {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.includes(fragment)) throw new Error('D1_ERROR: down');
          return target.prepare(sql);
        };
      },
    }),
  };
}

/** wrangler.jsonc, without its `//` comments (skipped outside strings only). */
function wranglerConfig(): { queues: { producers: unknown[]; consumers: Array<Record<string, unknown>> } } {
  const text = wranglerJsonc;
  let json = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      json += ch;
      if (ch === '\\') json += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      json += '\n';
    } else {
      inString = ch === '"';
      json += ch;
    }
  }
  return JSON.parse(json);
}

const queuedAt = (c: Ctx) => c.t.rows('SELECT queued_at FROM connections');

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

  it('a connection deleted since it was queued is a quiet ack, even for a webhook nudge', async () => {
    const c = (current = setup());
    // A webhook nudge that found the connection busy would be retried: 'gone' must not read as busy.
    expect(await deliver(c.env, { v: 1, connectionId: 'gone', kind: 'webhook', at: NOW })).toMatchObject({ outcome: 'ack' });
    expect(c.out.filter((l) => l.includes('"event":"queue_'))).toEqual([]);
    expect(runs(c.t)).toEqual([]);
  });

  it('a webhook nudge that finds a sync running comes back in a minute and keeps its mark', async () => {
    const c = (current = setup());
    await seedStripe(c, 'k', { status: 'syncing', lastSyncStartedAt: NOW - MINUTE });
    c.t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW, 'k');

    expect(await deliver(c.env, { v: 1, connectionId: 'k', kind: 'webhook', at: NOW })).toMatchObject({
      outcome: 'retry',
      retryDelaySeconds: 60,
    });
    expect(queuedAt(c)).toEqual([{ queued_at: NOW }]);
    expect(runs(c.t)).toEqual([]);
  });

  it('a webhook nudge outlasts a dead sync’s lock within max_retries', async () => {
    const c = (current = setup());
    stripeOk();
    // A sync took the lock at NOW and its worker died; the webhook's message arrives right then.
    await seedStripe(c, 'k', { status: 'syncing', lastSyncStartedAt: NOW });
    c.t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW, 'k');
    const body = { v: 1, connectionId: 'k', kind: 'webhook', at: NOW };
    const maxRetries = wranglerConfig().queues.consumers[0]!['max_retries'] as number;

    const seen: Array<[number, string, number | undefined]> = [];
    let at = NOW;
    for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
      vi.setSystemTime(at);
      const d = await deliver(c.env, body, attempt);
      seen.push([(at - NOW) / 1000, d.outcome, d.retryDelaySeconds]);
      if (d.outcome !== 'retry') break;
      at += d.retryDelaySeconds! * 1000;
    }

    // Seconds after NOW: busy, busy, then the lock is 11 minutes old and is taken over.
    expect(seen).toEqual([
      [0, 'retry', 60],
      [60, 'retry', 600],
      [660, 'ack', undefined],
    ]);
    expect(runs(c.t).map((r) => [r.kind, r.ok, r.started_at])).toEqual([['webhook', 1, NOW + 660_000]]);
    // …while its queued mark still stands, so no other producer queued a second message meanwhile.
    expect(at - NOW).toBeLessThan(QUEUED_STALE_MS);
  });

  it('a redelivered message that finds the lock held waits for it to go stale, then syncs', async () => {
    const c = (current = setup());
    stripeOk();
    // Its first attempt took the lock (clearing the mark) and died holding it.
    await seedStripe(c, 'k', { status: 'syncing', lastSyncStartedAt: NOW - MINUTE });
    const body = { v: 1, connectionId: 'k', kind: 'initial', at: NOW - 2 * MINUTE };

    expect(await deliver(c.env, body, 2)).toMatchObject({ outcome: 'retry', retryDelaySeconds: 600 });
    expect(runs(c.t)).toEqual([]);

    vi.setSystemTime(NOW + 600_000);
    expect(await deliver(c.env, body, 3)).toMatchObject({ outcome: 'ack' });
    expect(runs(c.t).map((r) => [r.kind, r.ok, r.started_at])).toEqual([['initial', 1, NOW + 600_000]]);
  });

  it('a D1 error while taking the lock retries the message, and its mark still leads to a sync', async () => {
    const c = (current = setup());
    stripeOk();
    await seedStripe(c, 'k');
    await enqueueSync(c.env, 'k', 'manual', NOW);
    const [sent] = queueOf(c.env).take();

    const d = await deliver(failingOn(c.env, "SET status = 'syncing'"), sent!.body);
    expect(d).toMatchObject({ outcome: 'retry', retryDelaySeconds: 60 });
    expect(queuedAt(c)).toEqual([{ queued_at: NOW }]);
    expect(conn(c.t, 'k')).toMatchObject({ status: 'pending', last_sync_started_at: null });
    expect(runs(c.t)).toEqual([]);

    // Queues brings it back a minute later: this time the sync runs, and its lock clears the mark.
    vi.setSystemTime(NOW + MINUTE);
    expect(await deliver(c.env, sent!.body, 2)).toMatchObject({ outcome: 'ack' });
    expect(runs(c.t).map((r) => [r.kind, r.ok])).toEqual([['manual', 1]]);
    expect(queuedAt(c)).toEqual([{ queued_at: null }]);
  });

  it('a message delivered again after its sync succeeded is acked without a second sync', async () => {
    const c = (current = setup());
    stripeOk();
    await seedStripe(c, 'k');
    await enqueueSync(c.env, 'k', 'cron', NOW);
    const [sent] = queueOf(c.env).take();

    vi.setSystemTime(NOW + 2_000);
    expect(await deliver(c.env, sent!.body)).toMatchObject({ outcome: 'ack' });
    // At-least-once delivery: the same message once more.
    vi.setSystemTime(NOW + 2 * MINUTE);
    expect(await deliver(c.env, sent!.body, 2)).toMatchObject({ outcome: 'ack' });

    expect(runs(c.t).map((r) => [r.kind, r.ok, r.started_at])).toEqual([['cron', 1, NOW + 2_000]]);
    expect(c.out.filter((l) => l.includes('"event":"queue_sync_superseded"'))).toHaveLength(1);
  });

  it('…but runs it while no successful sync is known to have started after it', async () => {
    const c = (current = setup());
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockRejectedValueOnce(new Error('kaboom')).mockResolvedValue(SNAP);
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
    await seedStripe(c, 'k');
    const body = (at: number) => ({ v: 1, connectionId: 'k', kind: 'cron', at });

    // The sync after it failed: the message still stands.
    vi.setSystemTime(NOW + 2_000);
    await deliver(c.env, body(NOW));
    vi.setSystemTime(NOW + 2 * MINUTE);
    await deliver(c.env, body(NOW), 2);
    // Queued in the very millisecond a successful sync started: which came first is unknown, so it runs.
    vi.setSystemTime(NOW + 3 * MINUTE);
    await deliver(c.env, body(NOW + 2 * MINUTE));

    expect(runs(c.t).map((r) => [r.ok, r.started_at])).toEqual([
      [0, NOW + 2_000],
      [1, NOW + 2 * MINUTE],
      [1, NOW + 3 * MINUTE],
    ]);
  });

  it('taking the lock clears the mark, so a webhook during the sync queues the next one', async () => {
    const c = (current = setup());
    await seedStripe(c, 'k');
    expect(await setWebhook(c.env, c.userId, 'k', 'on')).toBe(true);
    const nonce = c.t.rows<{ webhook_nonce: string }>('SELECT webhook_nonce FROM connections WHERE id = ?', 'k')[0]!.webhook_nonce;
    const token = await webhookToken(c.env, 'k', nonce);
    let receipt: unknown = null;
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockImplementation(async () => {
      // The provider calls while this sync reads it: the change may come after what it read.
      receipt = await receiveWebhook(c.env, 'k', token, NOW + 1_000);
      return SNAP;
    });
    vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
    await enqueueSync(c.env, 'k', 'cron', NOW);

    expect(await drainQueue(c.env, 1)).toMatchObject([{ body: { kind: 'cron' }, outcome: 'ack' }]);
    expect(receipt).toEqual({ scheduled: true });
    expect(queueOf(c.env).sent.map((m) => (m.body as { kind: string }).kind)).toEqual(['webhook']);
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
    const d = await deliver(failingOn(c.env, 'queued_at = NULL WHERE id IN'), { v: 1, connectionId: 'k', kind: 'cron', at: NOW });
    expect(d).toMatchObject({ outcome: 'retry', retryDelaySeconds: 60 });
    expect(c.out.some((l) => l.includes('"queue_sync_crashed"'))).toBe(true);
    expect(queueOf(c.env).sent).toEqual([]);
  });
});

describe('the Worker’s queue handler', () => {
  it('hands each batch to the consumer', async () => {
    const c = (current = setup());
    stripeOk();
    await seedStripe(c, 'k');
    await enqueueSync(c.env, 'k', 'manual', NOW);
    const [sent] = queueOf(c.env).take();
    const { batch, delivery } = oneMessageBatch(sent!.body);

    await worker.queue(batch, c.env);

    expect(delivery.outcome).toBe('ack');
    expect(runs(c.t).map((r) => [r.connection_id, r.kind, r.ok])).toEqual([['k', 'manual', 1]]);
  });

  it('reads one message per invocation from hoomuch-sync, retried 3 times', () => {
    expect(wranglerConfig().queues).toEqual({
      producers: [{ binding: 'SYNC_QUEUE', queue: 'hoomuch-sync' }],
      consumers: [{ queue: 'hoomuch-sync', max_batch_size: 1, max_retries: 3, retry_delay: 60, max_concurrency: 10 }],
    });
  });
});
