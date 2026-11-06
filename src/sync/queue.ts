/**
 * The sync queue (Cloudflare Queues, `SYNC_QUEUE` in wrangler.jsonc). Owner: Data Plane.
 *
 * Producer side; the consumer is sync/consumer.ts. Every sync runs on the queue, one message per
 * connection and one message per consumer invocation
 * (`max_batch_size: 1`), so each sync gets its own subrequest budget and 15 minutes of wall time
 * instead of sharing the cron's or a request's `waitUntil` (30 s). Producers:
 *   - the cron, for the connections that are due (`runScheduledSync`): up to 10 rounds of one
 *     `sendBatch` each a tick, 1,000 syncs, which the consumer's 10 slots start within
 *     QUEUED_STALE_MS while the average sync takes up to 9 s (CRON_MAX_ROUNDS in engine.ts),
 *   - creating a connection, replacing its key and "Sync now" (services/connections.ts),
 *   - provider webhooks, delayed a minute so a burst is one sync (services/webhooks.ts).
 *
 * `connections.queued_at` marks a connection with a message on its way, so the cron, "Sync now"
 * and a key swap don't stack a second one; a sync taking the lock clears it. Producers claim the
 * mark with one conditional UPDATE and send only for the rows it claimed, so two of them racing
 * for one connection send one message. Queues have no de-duplication of their own.
 */

import type { Bindings } from '../env';
import { MINUTE } from '../lib/time';
import type { SyncKind } from './engine';
import { claimQueued, clearQueued } from './repo';

export interface SyncMessage {
  v: 1;
  connectionId: string;
  kind: SyncKind;
  /** When it was queued: the `connections.queued_at` this message set. */
  at: number;
}

/**
 * A queued sync that hasn't started after this long is presumed lost, and may be queued again. A message
 * merely waiting its turn can outlive it too, behind a backlog of long syncs (up to SYNC_DEADLINE_MS each,
 * `max_concurrency` at a time); its copy is then superseded by the first one's sync, or retries a failed one.
 *
 * Kept below the cron's 30 minutes on purpose. It is also how long "Sync now" and a webhook say a sync
 * is already on its way, and how old a mark must be before a tick queues a lost message (one dropped
 * after `max_retries`) again, so a longer one would leave a lost sync, and those answers, wrong for
 * longer. What it would save is cheap: the cron queues a still-waiting connection again at most once a
 * tick (`requeued` in its log), and the copy is acked after one D1 read once the first has synced. The
 * cron's per-tick cap (CRON_MAX_ROUNDS) is what keeps a healthy instance's backlog inside it.
 */
export const QUEUED_STALE_MS = 15 * MINUTE;
/** Messages per `sendBatch` call (the Queues limit). */
export const SEND_BATCH_MAX = 100;
export const SYNC_KINDS: readonly SyncKind[] = ['cron', 'manual', 'initial', 'webhook'];

export function message(connectionId: string, kind: SyncKind, at: number): SyncMessage {
  return { v: 1, connectionId, kind, at };
}

/**
 * Puts syncs for `ids` on the queue, except those that already have one on its way, and returns the
 * ids it queued, in the order given. Throws when the queue refused them, after clearing the marks of
 * the ones not sent, so the caller can say so and the cron picks them up again.
 */
export async function enqueueSyncs(
  env: Bindings,
  ids: readonly string[],
  kind: SyncKind,
  now: number = Date.now(),
): Promise<string[]> {
  if (ids.length === 0) return [];
  const { results } = await claimQueued(env.DB, ids, now, now - QUEUED_STALE_MS).all<{ id: string }>();
  const claimed = new Set((results ?? []).map((r) => r.id));
  const queued = ids.filter((id) => claimed.delete(id)); // `delete` drops repeated ids too
  let sent = 0;
  try {
    for (; sent < queued.length; sent += SEND_BATCH_MAX) {
      await env.SYNC_QUEUE.sendBatch(queued.slice(sent, sent + SEND_BATCH_MAX).map((id) => ({ body: message(id, kind, now) })));
    }
  } catch (err) {
    await clearQueued(env.DB, queued.slice(sent), now)
      .run()
      .catch(() => {});
    throw err;
  }
  return queued;
}

/**
 * One connection's sync, e.g. after "Sync now": false when one was already on its way.
 * Throws like `enqueueSyncs`.
 */
export async function enqueueSync(env: Bindings, id: string, kind: SyncKind, now: number = Date.now()): Promise<boolean> {
  return (await enqueueSyncs(env, [id], kind, now)).length > 0;
}
