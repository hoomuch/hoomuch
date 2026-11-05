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
import { getAdapter, getProviderMeta, splitInput } from '../providers/registry';
import { ProviderError, type ProviderId, type ProviderMeta, type VerifyResult } from '../providers/types';
import { SYNC_LOCK_STALE_MS, syncConnection, type SyncResult } from '../sync/engine';

export const MAX_CONNECTIONS_PER_USER = 25;
export const MANUAL_SYNC_COOLDOWN_MS = 60_000;

export type FormResult<T extends object = object> =
  | ({ ok: true; warnings: string[] } & T)
  | { ok: false; error: string; fieldErrors: Record<string, string> };

type RawInput = Record<string, string | undefined>;

/** Form-level message when the specific problem is shown next to a field. */
const SEE_FIELD = 'Nothing was saved. See the field below.';

/** Turns any thrown error from an adapter into a message that is safe to show the user. */
export function describeProviderError(err: unknown, meta: ProviderMeta): string {
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
  console.error(JSON.stringify({ event: 'provider_unexpected_error', provider: meta.id, message: String(err) }));
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
      createProviderContext({ pageBudget: 5, tag: `verify:${meta.id}` }),
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

/** Verifies the key live, stores it encrypted, and kicks off the initial sync in the background. */
export async function createConnection(
  env: Bindings,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
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
  ctx.waitUntil(syncConnection(env, id, 'initial'));
  return { ok: true, id, warnings: v.verified.warnings };
}

export async function renameConnection(env: Bindings, userId: string, id: string, name: string | undefined): Promise<boolean> {
  const n = cleanName(name, '');
  if (!n) return false;
  return renameConnectionRow(env.DB, userId, id, n);
}

/** Config keys that identify *which* account/project a connection reads. */
const SOURCE_KEYS = ['storeId', 'projectId'] as const;
/** Rows per DELETE statement when purging synced data (keeps each statement well under D1 limits). */
const PURGE_CHUNK = 5_000;
const PURGE_MAX_ROUNDS = 400;
const BUSY_ERROR = 'A sync is running for this connection. Try again in a minute.';

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
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  userId: string,
  id: string,
  raw: RawInput,
): Promise<FormResult> {
  const row = await getConnection(env.DB, userId, id);
  if (!row) return { ok: false, error: 'Connection not found.', fieldErrors: {} };
  // A running sync would still commit data fetched with the old key after the swap.
  if (isSyncing(row, Date.now())) return { ok: false, error: BUSY_ERROR, fieldErrors: {} };
  const meta = getProviderMeta(row.provider);

  const v = await verifyInput(meta, raw);
  if (!v.ok) return v;

  // Verification takes a few seconds; re-check that no sync started meanwhile.
  const fresh = await getConnection(env.DB, userId, id);
  if (!fresh) return { ok: false, error: 'Connection not found.', fieldErrors: {} };
  if (isSyncing(fresh, Date.now())) return { ok: false, error: BUSY_ERROR, fieldErrors: {} };

  const config = { ...v.config, ...v.verified.config };
  const oldConfig = parseConfig(fresh.config);
  const sameSource =
    (fresh.test_mode === 1) === v.verified.testMode &&
    SOURCE_KEYS.every((k) => (oldConfig[k] ?? '') === (config[k] ?? ''));

  const apiKey = v.credentials['apiKey'];
  await updateConnectionCredentials(env.DB, userId, id, {
    credentialsEnc: await encryptJson(env.ENCRYPTION_KEY, v.credentials),
    keyHint: apiKey ? keyHint(apiKey) : null,
    config,
    testMode: v.verified.testMode,
  });
  if (sameSource) {
    await env.DB.prepare('UPDATE connections SET revenue_cursor = NULL WHERE id = ? AND user_id = ?').bind(id, userId).run();
  } else {
    await purgeSyncedData(env.DB, userId, id);
  }
  ctx.waitUntil(syncConnection(env, id, 'manual'));
  const warnings = sameSource
    ? v.verified.warnings
    : [...v.verified.warnings, 'The new key reads a different account or mode, so previously synced data was cleared and history is being rebuilt.'];
  return { ok: true, warnings };
}

/** Deletes the connection and all its synced data (big tables first, in chunks). */
export async function deleteConnection(env: Bindings, userId: string, id: string): Promise<boolean> {
  const row = await getConnection(env.DB, userId, id);
  if (!row) return false;
  await purgeTransactions(env.DB, id);
  return deleteConnectionRow(env.DB, userId, id);
}

/** Runs a sync inside the request (the user is waiting for the result). Rate-limited per connection. */
export async function triggerSync(
  env: Bindings,
  userId: string,
  id: string,
  now: number = Date.now(),
): Promise<{ ok: true; result: SyncResult } | { ok: false; error: string }> {
  const row = await getConnection(env.DB, userId, id);
  if (!row) return { ok: false, error: 'Connection not found.' };
  const started = row.last_sync_started_at ?? 0;
  if (row.status === 'syncing' && now - started < SYNC_LOCK_STALE_MS) {
    return { ok: false, error: 'A sync is already running for this connection.' };
  }
  if (now - started < MANUAL_SYNC_COOLDOWN_MS) {
    return { ok: false, error: 'Synced moments ago. Try again in a minute.' };
  }
  return { ok: true, result: await syncConnection(env, id, 'manual') };
}
