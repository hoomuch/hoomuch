/**
 * The sync queue (Cloudflare Queues, `SYNC_QUEUE` in wrangler.jsonc). Owner: Data Plane.
 *
 * Producer side; the consumer is sync/consumer.ts. Every sync runs on the queue, one message per
 * connection and one message per consumer invocation
 * (`max_batch_size: 1`), so each sync gets its own subrequest budget and 15 minutes of wall time
 * instead of sharing the cron's or a request's `waitUntil` (30 s). Producers:
 *   - the cron, for the connections that are due (`runScheduledSync`),
 *   - creating a connection, replacing its key and "Sync now" (services/connections.ts).
 *
 * `connections.queued_at` marks a connection with a message on its way, so the cron and
 * "Sync now" don't stack a second one; taking the sync lock clears it. Queues have no
 * de-duplication of their own.
 */

import type { Bindings } from '../env';
import { MINUTE } from '../lib/time';
import type { SyncKind } from './engine';
import { clearQueued, markQueued } from './repo';

export interface SyncMessage {
  v: 1;
  connectionId: string;
  kind: SyncKind;
  /** When it was queued: the `connections.queued_at` this message set. */
  at: number;
}

/** A queued sync that hasn't started after this long is presumed lost, and may be queued again. */
export const QUEUED_STALE_MS = 15 * MINUTE;
/** Messages per `sendBatch` call (the Queues limit). */
export const SEND_BATCH_MAX = 100;
export const SYNC_KINDS: readonly SyncKind[] = ['cron', 'manual', 'initial'];

export function message(connectionId: string, kind: SyncKind, at: number): SyncMessage {
  return { v: 1, connectionId, kind, at };
}

/**
 * Puts syncs for `ids` on the queue and marks them queued. Throws when the queue refused them, after
 * clearing the marks, so the caller can say so and the cron picks them up again.
 */
export async function enqueueSyncs(
  env: Bindings,
  ids: readonly string[],
  kind: SyncKind,
  now: number = Date.now(),
): Promise<void> {
  if (ids.length === 0) return;
  await markQueued(env.DB, ids, now).run();
  try {
    for (let i = 0; i < ids.length; i += SEND_BATCH_MAX) {
      await env.SYNC_QUEUE.sendBatch(ids.slice(i, i + SEND_BATCH_MAX).map((id) => ({ body: message(id, kind, now) })));
    }
  } catch (err) {
    await clearQueued(env.DB, ids, now)
      .run()
      .catch(() => {});
    throw err;
  }
}

/** One connection's sync, e.g. after "Sync now". Throws like `enqueueSyncs`. */
export async function enqueueSync(env: Bindings, id: string, kind: SyncKind, now: number = Date.now()): Promise<void> {
  await enqueueSyncs(env, [id], kind, now);
}
