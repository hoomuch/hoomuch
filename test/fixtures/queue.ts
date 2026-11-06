/**
 * A recording stand-in for a Cloudflare Queue binding, and a helper that drains it through the
 * real consumer (`handleSyncBatch`), one message per batch like production (`max_batch_size: 1`).
 */

import type { Bindings } from '../../src/env';
import { handleSyncBatch } from '../../src/sync/consumer';

export interface SentMessage<T = unknown> {
  body: T;
  delaySeconds: number | undefined;
}

export class FakeQueue<T = unknown> implements Queue<T> {
  sent: SentMessage<T>[] = [];
  /** Throws on the next send / sendBatch, once. */
  failNext = false;

  private check(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Queue send failed');
    }
  }

  async metrics(): Promise<QueueMetrics> {
    return { backlogCount: this.sent.length, backlogBytes: 0 };
  }

  async send(body: T, options?: QueueSendOptions): Promise<QueueSendResponse> {
    this.check();
    this.sent.push({ body: structuredClone(body), delaySeconds: options?.delaySeconds });
    return { metadata: { metrics: { backlogCount: this.sent.length, backlogBytes: 0 } } };
  }

  async sendBatch(messages: Iterable<MessageSendRequest<T>>, options?: QueueSendBatchOptions): Promise<QueueSendBatchResponse> {
    this.check();
    for (const m of messages) this.sent.push({ body: structuredClone(m.body), delaySeconds: m.delaySeconds ?? options?.delaySeconds });
    return { metadata: { metrics: { backlogCount: this.sent.length, backlogBytes: 0 } } };
  }

  /** The messages sent so far, oldest first, and forgets them. */
  take(): SentMessage<T>[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
}

export interface Delivery {
  body: unknown;
  outcome: 'ack' | 'retry' | 'none';
  retryDelaySeconds?: number;
}

/** Delivers one message to the consumer and reports what it did with it. */
export async function deliver(env: Bindings, body: unknown, attempts = 1): Promise<Delivery> {
  const d: Delivery = { body, outcome: 'none' };
  const msg: Message<unknown> = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: () => {
      d.outcome = 'ack';
    },
    retry: (o?: QueueRetryOptions) => {
      d.outcome = 'retry';
      d.retryDelaySeconds = o?.delaySeconds;
    },
  };
  const batch: MessageBatch<unknown> = {
    messages: [msg],
    queue: 'hoomuch-sync',
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => msg.retry(),
    ackAll: () => msg.ack(),
  };
  await handleSyncBatch(batch, env);
  return d;
}

/**
 * Runs everything on `env.SYNC_QUEUE` through the consumer, in order (delays ignored), including
 * messages sent while draining, up to `max`. Retried messages are reported, not redelivered.
 */
export async function drainQueue(env: Bindings, max = 200): Promise<Delivery[]> {
  const q = env.SYNC_QUEUE as unknown as FakeQueue;
  const out: Delivery[] = [];
  while (out.length < max) {
    const next = q.sent.shift();
    if (!next) break;
    out.push(await deliver(env, next.body));
  }
  return out;
}

/** The recorded messages of an env built by `testEnv`. */
export function queueOf(env: Bindings): FakeQueue {
  return env.SYNC_QUEUE as unknown as FakeQueue;
}
