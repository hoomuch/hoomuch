/**
 * Sync error → user-safe text. Owner: Data Plane.
 *
 * What lands in `connections.last_error` / `sync_runs.message` is shown in the UI, so it must
 * never contain keys, ciphertext, raw provider bodies or customer data. Technical detail goes to
 * the logs only, and only after `sanitizeErrorText`.
 */

import { sanitizeErrorText } from '../providers/http';
import { ProviderError, type ProviderMeta } from '../providers/types';

export const MAX_SYNC_ERROR_LENGTH = 300;

export const DECRYPT_ERROR = 'The stored key couldn’t be decrypted. Replace the key to reconnect.';

/** An engine-side failure whose message is already written for the user. */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

/**
 * What to tell the user when a phase ran out of requests (`BudgetExhaustedError`) or out of time
 * (the sync deadline reads as an empty budget). Snapshots aren't resumable, so "the next sync
 * continues" would be untrue for a budget problem; a deadline problem may clear up on its own.
 */
export function exhaustedMessage(phase: 'snapshot' | 'revenue', providerName: string, deadline: boolean): string {
  if (phase === 'snapshot') {
    return deadline
      ? `${providerName} responded too slowly to read every subscription in one sync, so MRR wasn’t updated. The next sync will retry.`
      : `${providerName} has more subscriptions than one sync can read, so MRR wasn’t updated.`;
  }
  return deadline
    ? `${providerName} responded too slowly to finish reading revenue in one sync. The next sync will retry.`
    : `${providerName} has more revenue history than one sync can read, so revenue wasn’t updated.`;
}

export function genericSyncError(providerName?: string): string {
  return providerName
    ? `Something went wrong while syncing ${providerName}. The next sync will retry.`
    : 'Something went wrong while syncing. The next sync will retry.';
}

/** User-facing message for a failed sync, ≤ 300 chars. Pure: logging is the caller's job. */
export function describeSyncError(err: unknown, meta: Pick<ProviderMeta, 'name'>): string {
  let msg: string;
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case 'auth':
        msg = `${meta.name} rejected the key. If it was revoked, replace the key.`;
        break;
      case 'rate_limit':
        msg = `${meta.name} is rate-limiting requests; the next sync will retry.`;
        break;
      default:
        // permission / not_found / invalid_input / upstream: written for users by http.ts / adapters.
        msg = err.message.trim() || genericSyncError(meta.name);
    }
  } else if (err instanceof SyncError) {
    msg = err.message;
  } else {
    msg = genericSyncError(meta.name);
  }
  return sanitizeErrorText(msg, MAX_SYNC_ERROR_LENGTH);
}

/**
 * Log-safe fields describing an error: kind/status/name plus a sanitised message.
 * Never throws (even for hostile values whose toString throws).
 */
export function errorLogFields(err: unknown): Record<string, unknown> {
  try {
    if (err instanceof ProviderError) {
      return { errorKind: err.kind, status: err.status ?? null, message: sanitizeErrorText(err.message) };
    }
    if (err instanceof SyncError) return { errorKind: 'sync', message: sanitizeErrorText(err.message) };
    if (err instanceof Error) {
      return { errorKind: 'internal', errorName: err.name, message: sanitizeErrorText(err.message) };
    }
    return { errorKind: 'internal', message: sanitizeErrorText(String(err)) };
  } catch {
    return { errorKind: 'internal', message: 'unprintable error' };
  }
}

/**
 * True when a call that was resuming a cursor failed in a way that retrying the same cursor
 * can't fix (expired/invalid cursor, deleted object): the backfill should restart instead.
 */
export function isStaleCursorError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.kind === 'not_found' || err.kind === 'invalid_input') return true;
  return err.kind === 'upstream' && err.status !== undefined && err.status >= 400 && err.status < 500;
}
