/** Queue consumer for `SYNC_QUEUE` (see sync/queue.ts). Owner: Data Plane. */

import type { Bindings } from '../env';
import { SYNC_BUSY_MESSAGE, SYNC_LOCK_STALE_MS, SYNC_NOT_STARTED_MESSAGE, syncConnection, type SyncKind } from './engine';
import { errorLogFields } from './errors';
import { SYNC_KINDS, message, type SyncMessage } from './queue';
import { clearQueued, lastSyncedAt } from './repo';

/** Wait before a message whose handling crashed, or whose sync couldn't start, is tried again. */
const CRASH_RETRY_DELAY_SECONDS = 60;
/**
 * Wait before a webhook nudge that found the connection busy tries again. Most syncs are done by
 * then; one still running (a big account's can take up to SYNC_DEADLINE_MS) sends the nudge to the
 * stale-lock wait below, after which that sync is long finished.
 */
const BUSY_RETRY_DELAY_SECONDS = 60;
/**
 * Wait before a redelivered message that found the connection busy tries again. Its earlier attempt
 * may have died holding the lock; by then that lock is stale and the retry takes it over. Within
 * `max_retries: 3` (wrangler.jsonc) a webhook nudge waits 60 + 600 s, past any stale lock. Sent with
 * its usual minute's delay, its queued mark (QUEUED_STALE_MS) still stands by then; one held back
 * for WEBHOOK_MIN_GAP_MS may outlive it, which at worst lets a second message be queued: whichever
 * of the two runs later finds a newer successful sync and is acked as superseded.
 */
const STALE_LOCK_RETRY_DELAY_SECONDS = SYNC_LOCK_STALE_MS / 1000;

function emit(level: 'log' | 'warn' | 'error', event: string, data: Record<string, unknown>): void {
  try {
    // nosemgrep: unsafe-dynamic-method -- level is typed to three console methods
    console[level](JSON.stringify({ event, ...data }));
  } catch {
    // logging must never break the queue
  }
}

function parseMessage(body: unknown): SyncMessage | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b['v'] !== 1 || typeof b['connectionId'] !== 'string' || !SYNC_KINDS.includes(b['kind'] as SyncKind)) return null;
  return message(b['connectionId'], b['kind'] as SyncKind, typeof b['at'] === 'number' ? b['at'] : 0);
}

/**
 * Queue consumer. `syncConnection` records its own failures on the connection, so a finished sync
 * is acked whatever its outcome; a sync that couldn't start and a crash outside it are retried
 * (Queues' `max_retries`).
 */
export async function handleSyncBatch(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  for (const msg of batch.messages) {
    const m = parseMessage(msg.body);
    if (!m) {
      emit('warn', 'queue_message_ignored', { queue: batch.queue });
      msg.ack();
      continue;
    }
    try {
      // Delivery is at least once. A successful sync that started after this message was queued
      // already did what it asks for, so a second copy (or a late one) is a no-op.
      const synced = m.at > 0 ? await lastSyncedAt(env.DB, m.connectionId) : null;
      if (synced !== null && synced > m.at) {
        emit('log', 'queue_sync_superseded', { connectionId: m.connectionId, kind: m.kind });
        msg.ack();
        continue;
      }
      const r = await syncConnection(env, m.connectionId, m.kind);
      if (!r.ok && r.error === SYNC_NOT_STARTED_MESSAGE) {
        // Nothing ran and the mark is still set: this message is the sync it promises.
        emit('warn', 'queue_sync_not_started', { connectionId: m.connectionId, kind: m.kind });
        msg.retry({ delaySeconds: CRASH_RETRY_DELAY_SECONDS });
        continue;
      }
      if (!r.ok && r.error === SYNC_BUSY_MESSAGE) {
        emit('log', 'queue_sync_busy', { connectionId: m.connectionId, kind: m.kind, attempts: msg.attempts });
        if (msg.attempts > 1 || m.kind === 'webhook') {
          // A redelivered message may be finding its own earlier attempt's lock: come back once it's
          // stale. A webhook's sync running now may have read the provider before the change: come
          // back once it's done. Either way the mark stays, so further calls don't stack.
          msg.retry({ delaySeconds: msg.attempts > 1 ? STALE_LOCK_RETRY_DELAY_SECONDS : BUSY_RETRY_DELAY_SECONDS });
          continue;
        }
        // Another sync holds the lock and is doing the work. Drop our mark so the connection
        // doesn't read as "queued" until QUEUED_STALE_MS (unless a newer message set it).
        await clearQueued(env.DB, [m.connectionId], m.at).run();
      }
      msg.ack();
    } catch (err) {
      emit('error', 'queue_sync_crashed', { connectionId: m.connectionId, kind: m.kind, ...errorLogFields(err) });
      msg.retry({ delaySeconds: CRASH_RETRY_DELAY_SECONDS });
    }
  }
}
