/** Queue consumer for `SYNC_QUEUE` (see sync/queue.ts). Owner: Data Plane. */

import type { Bindings } from '../env';
import { SYNC_BUSY_MESSAGE, syncConnection, type SyncKind } from './engine';
import { errorLogFields } from './errors';
import { SYNC_KINDS, message, type SyncMessage } from './queue';
import { clearQueued } from './repo';

/** Wait before a message whose handling crashed is tried again. */
export const CRASH_RETRY_DELAY_SECONDS = 60;
/** Wait before a webhook nudge that found the connection busy tries again. */
export const BUSY_RETRY_DELAY_SECONDS = 60;

function emit(level: 'log' | 'warn' | 'error', event: string, data: Record<string, unknown>): void {
  try {
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
 * is acked whatever its outcome; only a crash outside it is retried (Queues' `max_retries`).
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
      const r = await syncConnection(env, m.connectionId, m.kind);
      if (!r.ok && r.error === SYNC_BUSY_MESSAGE) {
        emit('log', 'queue_sync_busy', { connectionId: m.connectionId, kind: m.kind });
        if (m.kind === 'webhook') {
          // The sync running now may have read the provider before the change the webhook is
          // about: come back once it's done. The mark stays, so further calls don't stack.
          msg.retry({ delaySeconds: BUSY_RETRY_DELAY_SECONDS });
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
