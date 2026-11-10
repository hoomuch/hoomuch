/**
 * Connection use-cases called by routes. Owner: Data Plane (initial version by Lead).
 * Signatures are part of the contract (SPEC.md §9.1).
 */

import type { Bindings } from '../env';
import { encryptJson, keyHint, randomId } from '../lib/crypto';
import {
  deleteConnectionRow,
  getConnection,
  insertConnection,
  listConnections,
  parseConfig,
  renameConnectionRow,
  updateConnectionCredentials,
  type ConnectionRow,
} from '../db/queries';
import { createProviderContext } from '../providers/context';
import { sanitizeErrorText } from '../providers/http';
import { getAdapter } from '../providers/adapters';
import { getProviderMeta, splitInput } from '../providers/registry';
import { ProviderError, type ProviderId, type ProviderMeta, type VerifyResult } from '../providers/types';
import { SYNC_LOCK_STALE_MS, syncConnection, type SyncResult } from '../sync/engine';
import { QUEUED_STALE_MS, enqueueSync } from '../sync/queue';
import { acquireSyncLock } from '../sync/repo';
import { productBeforeDelete, refreshProductStats, refreshStatsForConnection } from './public-pages';

export const MAX_CONNECTIONS_PER_USER = 25;
const MANUAL_SYNC_COOLDOWN_MS = 60_000;
/** The add / replace-key form waits for the live check: no new request starts after this long. */
const VERIFY_DEADLINE_MS = 20_000;

export type FormResult<T extends object = object> =
  | ({ ok: true; warnings: string[] } & T)
  | { ok: false; error: string; fieldErrors: Record<string, string> };

type RawInput = Record<string, string | undefined>;

/** Form-level message when the specific problem is shown next to a field. */
const SEE_FIELD = 'Nothing was saved. See the field below.';

/** Turns any thrown error from an adapter into a message that is safe to show the user. */
function describeProviderError(err: unknown, meta: ProviderMeta): string {
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case 'auth':
        return `${meta.name} rejected the key. Check that you pasted all of it and that it hasn’t been revoked.`;
      case 'rate_limit':
        return `${meta.name} is rate-limiting requests. Try again in a minute.`;
      case 'upstream':
        return `Couldn’t reach ${meta.name}. Try again in a few minutes.`;
      default:
        return err.message; // permission / invalid_input / not_found carry specific, user-facing text
    }
  }
  console.error(
    JSON.stringify({ event: 'provider_unexpected_error', provider: meta.id, message: sanitizeErrorText(String(err)) }),
  );
  return `Something went wrong while checking the key with ${meta.name}. Try again in a few minutes.`;
}

function cleanName(name: string | undefined, fallback: string): string {
  const n = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return n || fallback;
}

async function verifyInput(
  meta: ProviderMeta,
  raw: RawInput,
): Promise<
  | { ok: true; credentials: Record<string, string>; config: Record<string, string>; verified: Extract<VerifyResult, { ok: true }> }
  | { ok: false; error: string; fieldErrors: Record<string, string> }
> {
  const { credentials, config, errors } = splitInput(meta, raw);
  if (Object.keys(errors).length > 0) {
    return { ok: false, error: 'Fill in the required fields.', fieldErrors: errors };
  }
  let verified: VerifyResult;
  try {
    verified = await getAdapter(meta.id).verify(
      { credentials, config },
      createProviderContext({ pageBudget: 5, tag: `verify:${meta.id}`, deadline: Date.now() + VERIFY_DEADLINE_MS }),
    );
  } catch (err) {
    const message = describeProviderError(err, meta);
    const field = err instanceof ProviderError ? err.field : undefined;
    return field ? { ok: false, error: SEE_FIELD, fieldErrors: { [field]: message } } : { ok: false, error: message, fieldErrors: {} };
  }
  if (!verified.ok) {
    return verified.field
      ? { ok: false, error: SEE_FIELD, fieldErrors: { [verified.field]: verified.error } }
      : { ok: false, error: verified.error, fieldErrors: {} };
  }
  return { ok: true, credentials, config, verified };
}

/**
 * Starts a sync in the background (the queue consumer) for one the user asked for. A queue that
 * refuses the message is logged, not shown: the connection stays due, so the next cron tick (at
 * most 30 minutes away) picks it up.
 */
async function startInBackground(env: Bindings, id: string, kind: 'initial' | 'manual'): Promise<void> {
  try {
    await enqueueSync(env, id, kind);
  } catch (err) {
    console.error(JSON.stringify({ event: 'sync_enqueue_failed', connectionId: id, kind, message: sanitizeErrorText(String(err)) }));
  }
}

/** Verifies the key live, stores it encrypted, and queues the initial sync. */
export async function createConnection(
  env: Bindings,
  userId: string,
  provider: ProviderId,
  name: string | undefined,
  raw: RawInput,
): Promise<FormResult<{ id: string }>> {
  const meta = getProviderMeta(provider);
  const existing = await listConnections(env.DB, userId);
  if (existing.length >= MAX_CONNECTIONS_PER_USER) {
    return {
      ok: false,
      error: `You’ve reached the limit of ${MAX_CONNECTIONS_PER_USER} connections. Delete one to add another.`,
      fieldErrors: {},
    };
  }

  const v = await verifyInput(meta, raw);
  if (!v.ok) return v;

  const id = randomId();
  const apiKey = v.credentials['apiKey'];
  // The count above is a fast pre-check; this conditional insert is the real, race-free cap.
  const inserted = await insertConnection(
    env.DB,
    {
      id,
      userId,
      provider,
      name: cleanName(name, v.verified.accountLabel || meta.name),
      credentialsEnc: await encryptJson(env.ENCRYPTION_KEY, v.credentials),
      keyHint: apiKey ? keyHint(apiKey) : null,
      config: { ...v.config, ...v.verified.config },
      testMode: v.verified.testMode,
    },
    MAX_CONNECTIONS_PER_USER,
  );
  if (!inserted) {
    return {
      ok: false,
      error: `You’ve reached the limit of ${MAX_CONNECTIONS_PER_USER} connections. Delete one to add another.`,
      fieldErrors: {},
    };
  }
  await startInBackground(env, id, 'initial');
  return { ok: true, id, warnings: v.verified.warnings };
}

export async function renameConnection(env: Bindings, userId: string, id: string, name: string | undefined): Promise<boolean> {
  const n = cleanName(name, '');
  if (!n) return false;
  return renameConnectionRow(env.DB, userId, id, n);
}

/** Config keys that identify *which* account/project a connection reads. */
const SOURCE_KEYS = ['storeId', 'projectId', 'site', 'organizationId'] as const;
/** Rows per DELETE statement when purging synced data (keeps each statement well under D1 limits). */
const PURGE_CHUNK = 5_000;
const PURGE_MAX_ROUNDS = 400;
/** A big account's sync can run for a few minutes (SYNC_DEADLINE_MS), so "in a minute" would undersell it. */
const BUSY_ERROR = 'A sync is running for this connection. Try again in a few minutes.';

function isSyncing(row: ConnectionRow, now: number): boolean {
  return row.status === 'syncing' && now - (row.last_sync_started_at ?? 0) < SYNC_LOCK_STALE_MS;
}

/** Deletes a connection's transactions in bounded chunks (FK cascades over huge tables can exceed D1 limits). */
async function purgeTransactions(db: D1Database, connectionId: string): Promise<void> {
  for (let i = 0; i < PURGE_MAX_ROUNDS; i++) {
    const r = await db
      .prepare('DELETE FROM transactions WHERE rowid IN (SELECT rowid FROM transactions WHERE connection_id = ? LIMIT ?)')
      .bind(connectionId, PURGE_CHUNK)
      .run();
    if ((r.meta.changes ?? 0) < PURGE_CHUNK) return;
  }
}

/** Removes everything synced for a connection and restarts its revenue history from scratch. */
async function purgeSyncedData(db: D1Database, userId: string, connectionId: string): Promise<void> {
  await purgeTransactions(db, connectionId);
  await db.batch([
    db.prepare('DELETE FROM daily_revenue WHERE connection_id = ?').bind(connectionId),
    db.prepare('DELETE FROM snapshots WHERE connection_id = ?').bind(connectionId),
    // MRR movement and the list of subscriptions it's worked out from (migration 0019).
    db.prepare('DELETE FROM mrr_movements WHERE connection_id = ?').bind(connectionId),
    db.prepare('DELETE FROM subscription_states WHERE connection_id = ?').bind(connectionId),
    db
      .prepare('UPDATE connections SET revenue_cursor = NULL, revenue_synced_until = NULL WHERE id = ? AND user_id = ?')
      .bind(connectionId, userId),
  ]);
}

/**
 * Replaces the stored key after verifying the new one; triggers a fresh sync.
 * If the new key reads a different source (test ↔ live, another store or project), the old
 * source's synced data is purged and the 90-day backfill starts over; otherwise only an
 * in-flight cursor is reset (it may not resolve under the new key) and history is kept.
 */
export async function rotateCredentials(
  env: Bindings,
  userId: string,
  id: string,
  raw: RawInput,
): Promise<FormResult> {
  const row = await getConnection(env.DB, userId, id);
  if (!row) return { ok: false, error: 'Connection not found.', fieldErrors: {} };
  // A running sync would still commit data fetched with the old key after the swap.
  if (isSyncing(row, Date.now())) return { ok: false, error: BUSY_ERROR, fieldErrors: {} };
  // Every replacement verifies the key live and starts a sync: same cooldown as "Sync now", so a
  // resubmit loop can't turn one connection into a stream of provider requests.
  if (Date.now() - (row.last_sync_started_at ?? 0) < MANUAL_SYNC_COOLDOWN_MS) {
    return { ok: false, error: 'Synced moments ago. Try again in a minute.', fieldErrors: {} };
  }
  const meta = getProviderMeta(row.provider);

  const v = await verifyInput(meta, raw);
  if (!v.ok) return v;

  // Verification takes a few seconds. Take the sync lock for the swap itself: a sync that started
  // meanwhile (cron, Sync now in another tab) would otherwise commit the old key's data after the
  // purge below, or plan its backfill from the old high-water mark. Ownership was checked above.
  // The lock keeps the queued mark: a sync already on its way reads the key when it runs, so it
  // uses the new one, and startInBackground below doesn't queue a second.
  const fresh = await getConnection(env.DB, userId, id);
  if (!fresh) return { ok: false, error: 'Connection not found.', fieldErrors: {} };
  const lockAt = Date.now();
  const locked = await acquireSyncLock(env.DB, id, lockAt, lockAt - SYNC_LOCK_STALE_MS, { keepQueued: true });
  if (!locked) return { ok: false, error: BUSY_ERROR, fieldErrors: {} };

  let released = false;
  let sameSource: boolean;
  try {
    const config = { ...v.config, ...v.verified.config };
    const oldConfig = parseConfig(locked.config);
    sameSource =
      (locked.test_mode === 1) === v.verified.testMode &&
      SOURCE_KEYS.every((k) => (oldConfig[k] ?? '') === (config[k] ?? ''));

    // Clear first, swap the key last: the swap sets status 'pending', which releases the lock.
    if (sameSource) {
      await env.DB.prepare('UPDATE connections SET revenue_cursor = NULL WHERE id = ? AND user_id = ?').bind(id, userId).run();
    } else {
      await purgeSyncedData(env.DB, userId, id);
      // The old account's figures are gone: a public page stops showing them now, not at the next sync.
      await refreshStatsForConnection(env, id);
    }
    const apiKey = v.credentials['apiKey'];
    released = await updateConnectionCredentials(env.DB, userId, id, {
      credentialsEnc: await encryptJson(env.ENCRYPTION_KEY, v.credentials),
      keyHint: apiKey ? keyHint(apiKey) : null,
      config,
      testMode: v.verified.testMode,
    });
  } finally {
    if (!released) {
      // Something threw (or the row vanished): give the lock back as it was, so the connection
      // isn't stuck "syncing" for the stale-lock window.
      await env.DB.prepare(
        `UPDATE connections SET status = ?, last_sync_started_at = ?
          WHERE id = ? AND status = 'syncing' AND last_sync_started_at = ?`,
      )
        .bind(fresh.status === 'syncing' ? 'pending' : fresh.status, fresh.last_sync_started_at, id, lockAt)
        .run();
    }
  }
  if (!released) return { ok: false, error: 'Connection not found.', fieldErrors: {} };
  await startInBackground(env, id, 'manual');
  const warnings = sameSource
    ? v.verified.warnings
    : [...v.verified.warnings, 'The new key reads a different account or mode, so previously synced data was cleared and history is being rebuilt.'];
  return { ok: true, warnings };
}

/** Deletes the connection and all its synced data (big tables first, in chunks). */
export async function deleteConnection(env: Bindings, userId: string, id: string): Promise<boolean> {
  const row = await getConnection(env.DB, userId, id);
  if (!row) return false;
  const product = await productBeforeDelete(env, id);
  await purgeTransactions(env.DB, id);
  const deleted = await deleteConnectionRow(env.DB, userId, id);
  // Its public product, if any, now adds up one connection fewer.
  if (deleted && product) await refreshProductStats(env, product);
  return deleted;
}

export const SYNC_QUEUED_MESSAGE = 'A sync is already on its way for this connection.';

/** Why a manual sync can't start right now, or null when it can. */
async function manualSyncBlocker(env: Bindings, userId: string, id: string, now: number): Promise<string | null> {
  const row = await getConnection(env.DB, userId, id);
  if (!row) return 'Connection not found.';
  const started = row.last_sync_started_at ?? 0;
  if (row.status === 'syncing' && now - started < SYNC_LOCK_STALE_MS) {
    return 'A sync is already running for this connection.';
  }
  if (now - started < MANUAL_SYNC_COOLDOWN_MS) return 'Synced moments ago. Try again in a minute.';
  if (row.queued_at !== null && now - row.queued_at < QUEUED_STALE_MS) return SYNC_QUEUED_MESSAGE;
  return null;
}

/** Runs a sync inside the request (the user is waiting for the result). Rate-limited per connection. */
export async function triggerSync(
  env: Bindings,
  userId: string,
  id: string,
  now: number = Date.now(),
): Promise<{ ok: true; result: SyncResult } | { ok: false; error: string }> {
  const blocked = await manualSyncBlocker(env, userId, id, now);
  if (blocked) return { ok: false, error: blocked };
  return { ok: true, result: await syncConnection(env, id, 'manual') };
}

/**
 * "Sync now" without holding the request: queues the sync and returns at once, with the same rate
 * limits as triggerSync. `requestedAt` is what the page compares sync runs against: it refreshes
 * until a run that started at or after it has finished.
 */
export async function startSync(
  env: Bindings,
  userId: string,
  id: string,
  now: number = Date.now(),
): Promise<{ ok: true; requestedAt: number } | { ok: false; error: string }> {
  const blocked = await manualSyncBlocker(env, userId, id, now);
  if (blocked) return { ok: false, error: blocked };
  let queued: boolean;
  try {
    queued = await enqueueSync(env, id, 'manual', now);
  } catch (err) {
    console.error(JSON.stringify({ event: 'sync_enqueue_failed', connectionId: id, kind: 'manual', message: sanitizeErrorText(String(err)) }));
    return { ok: false, error: 'Couldn’t start a sync right now. Try again in a minute.' };
  }
  // The check above read the mark; the claim is what decides when two clicks (or the cron) race.
  if (!queued) return { ok: false, error: SYNC_QUEUED_MESSAGE };
  return { ok: true, requestedAt: now };
}
