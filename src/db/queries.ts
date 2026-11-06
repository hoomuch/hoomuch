/**
 * Base D1 queries for users, sessions and connections. Owner: Lead.
 * Every connection query is scoped by user_id — never fetch a connection by id alone
 * on a request path. Sync code (no user context) uses `getConnectionForSync`.
 */

import type { ProviderId } from '../providers/types';

// ---------- rows ----------

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  base_currency: string;
  /** When the address was confirmed through a mailed link (ms); null = never. */
  email_verified_at: number | null;
  created_at: number;
  updated_at: number;
}

export type ConnectionStatus = 'pending' | 'syncing' | 'ok' | 'error';

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: ProviderId;
  name: string;
  credentials_enc: string;
  key_hint: string | null;
  config: string; // JSON
  test_mode: number; // 0 | 1
  status: ConnectionStatus;
  last_synced_at: number | null;
  last_sync_started_at: number | null;
  last_error: string | null;
  revenue_cursor: string | null;
  revenue_synced_until: number | null;
  /** A sync is on the queue and hasn't started (migration 0007). */
  queued_at: number | null;
  created_at: number;
  updated_at: number;
}

// ---------- users ----------

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email.trim()).first<UserRow>();
}

export async function insertUser(
  db: D1Database,
  u: { id: string; email: string; passwordHash: string; baseCurrency?: string },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO users (id, email, password_hash, base_currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(u.id, u.email.trim(), u.passwordHash, u.baseCurrency ?? 'USD', now, now)
    .run();
}

/** The user picked a display currency in Settings: never infer it again. */
export async function updateUserCurrency(db: D1Database, userId: string, currency: string): Promise<void> {
  await db
    .prepare("UPDATE users SET base_currency = ?, currency_source = 'chosen', updated_at = ? WHERE id = ?")
    .bind(currency, Date.now(), userId)
    .run();
}

export type CurrencySource = 'default' | 'inferred' | 'chosen';

export async function getCurrencySource(db: D1Database, userId: string): Promise<CurrencySource> {
  const row = await db.prepare('SELECT currency_source FROM users WHERE id = ?').bind(userId).first<{ currency_source: string }>();
  const v = row?.currency_source;
  return v === 'inferred' || v === 'chosen' ? v : 'default';
}

/**
 * Sets the display currency picked from the user's numbers, once: only while it's still the
 * untouched default, so a choice made in Settings (even mid-request) always wins.
 */
export async function setInferredCurrency(db: D1Database, userId: string, currency: string): Promise<boolean> {
  const r = await db
    .prepare("UPDATE users SET base_currency = ?, currency_source = 'inferred', updated_at = ? WHERE id = ? AND currency_source = 'default'")
    .bind(currency, Date.now(), userId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function updateUserPassword(db: D1Database, userId: string, passwordHash: string): Promise<void> {
  await db
    .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(passwordHash, Date.now(), userId)
    .run();
}

const USER_PURGE_CHUNK = 5_000;
const USER_PURGE_MAX_ROUNDS = 400;

/**
 * Deletes the user and everything they own. The transactions table is the only one that can be
 * huge, so it is emptied in bounded chunks first; FK cascades then remove sessions, connections,
 * snapshots, daily_revenue and sync_runs in one small statement.
 */
export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  for (let i = 0; i < USER_PURGE_MAX_ROUNDS; i++) {
    const r = await db
      .prepare(
        `DELETE FROM transactions WHERE rowid IN (
           SELECT t.rowid FROM transactions t JOIN connections c ON c.id = t.connection_id
            WHERE c.user_id = ? LIMIT ?)`,
      )
      .bind(userId, USER_PURGE_CHUNK)
      .run();
    if ((r.meta.changes ?? 0) < USER_PURGE_CHUNK) break;
  }
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}

// ---------- sessions ----------

export interface SessionJoinRow {
  session_id: string;
  expires_at: number;
  user_id: string;
  email: string;
  base_currency: string;
  email_verified_at: number | null;
}

/** A live session: not expired, and created after `minCreatedAt` (absolute lifetime cap). */
export function getSessionWithUser(
  db: D1Database,
  sessionId: string,
  now: number,
  minCreatedAt: number,
): Promise<SessionJoinRow | null> {
  return db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.base_currency, u.email_verified_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND s.created_at > ?`,
    )
    .bind(sessionId, now, minCreatedAt)
    .first<SessionJoinRow>();
}

export async function insertSession(db: D1Database, sessionId: string, userId: string, expiresAt: number): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(sessionId, userId, expiresAt, Date.now())
    .run();
}

export async function extendSession(db: D1Database, sessionId: string, expiresAt: number): Promise<void> {
  await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(expiresAt, sessionId).run();
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

/** Signs the user out everywhere except (optionally) one session. */
export async function deleteOtherSessions(db: D1Database, userId: string, keepSessionId?: string): Promise<void> {
  await db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
    .bind(userId, keepSessionId ?? '')
    .run();
}

export async function deleteExpiredSessions(db: D1Database, now: number): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
}

/**
 * Throttle rows whose window has closed carry no information; the cron drops them. Keys starting
 * with `dailyPrefix` count over a day, every other key over the short window.
 */
export async function deleteStaleLoginAttempts(
  db: D1Database,
  now: number,
  windows: { shortMs: number; dailyMs: number; dailyPrefix: string },
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM login_attempts
        WHERE (substr(key, 1, ?) = ? AND window_start < ?)
           OR (substr(key, 1, ?) != ? AND window_start < ?)`,
    )
    .bind(
      windows.dailyPrefix.length, windows.dailyPrefix, now - windows.dailyMs,
      windows.dailyPrefix.length, windows.dailyPrefix, now - windows.shortMs,
    )
    .run();
}

// ---------- connections ----------

export async function listConnections(db: D1Database, userId: string): Promise<ConnectionRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at ASC')
    .bind(userId)
    .all<ConnectionRow>();
  return results;
}

export function getConnection(db: D1Database, userId: string, id: string): Promise<ConnectionRow | null> {
  return db
    .prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<ConnectionRow>();
}

/** Sync-only: no user scope. Never call from a request handler with a user-supplied id. */
export function getConnectionForSync(db: D1Database, id: string): Promise<ConnectionRow | null> {
  return db.prepare('SELECT * FROM connections WHERE id = ?').bind(id).first<ConnectionRow>();
}

export async function insertConnection(
  db: D1Database,
  c: {
    id: string;
    userId: string;
    provider: ProviderId;
    name: string;
    credentialsEnc: string;
    keyHint: string | null;
    config: Record<string, string>;
    testMode: boolean;
  },
  /** When set, the insert only happens if the user has fewer connections than this (atomic). */
  maxPerUser?: number,
): Promise<boolean> {
  const now = Date.now();
  const r = await db
    .prepare(
      `INSERT INTO connections
         (id, user_id, provider, name, credentials_enc, key_hint, config, test_mode, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE (SELECT COUNT(*) FROM connections WHERE user_id = ?) < ?`,
    )
    .bind(
      c.id, c.userId, c.provider, c.name, c.credentialsEnc, c.keyHint, JSON.stringify(c.config), c.testMode ? 1 : 0,
      now, now, c.userId, maxPerUser ?? Number.MAX_SAFE_INTEGER,
    )
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function renameConnectionRow(db: D1Database, userId: string, id: string, name: string): Promise<boolean> {
  const r = await db
    .prepare('UPDATE connections SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(name, Date.now(), id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function updateConnectionCredentials(
  db: D1Database,
  userId: string,
  id: string,
  u: { credentialsEnc: string; keyHint: string | null; config: Record<string, string>; testMode: boolean },
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE connections
          SET credentials_enc = ?, key_hint = ?, config = ?, test_mode = ?, status = 'pending', last_error = NULL, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    )
    .bind(u.credentialsEnc, u.keyHint, JSON.stringify(u.config), u.testMode ? 1 : 0, Date.now(), id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Cascades to snapshots, transactions, daily_revenue and sync_runs. */
export async function deleteConnectionRow(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM connections WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return (r.meta.changes ?? 0) > 0;
}

export function parseConfig(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------- email verification ----------

export async function insertEmailVerification(
  db: D1Database,
  id: string,
  userId: string,
  expiresAt: number,
  now: number,
): Promise<void> {
  await db
    .prepare('INSERT INTO email_verifications (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, expiresAt, now)
    .run();
}

export function getEmailVerification(db: D1Database, id: string): Promise<{ user_id: string; expires_at: number } | null> {
  return db
    .prepare('SELECT user_id, expires_at FROM email_verifications WHERE id = ?')
    .bind(id)
    .first<{ user_id: string; expires_at: number }>();
}

/** Deletes a live link and returns its user, in one statement: a link can only be spent once. */
export async function consumeEmailVerification(db: D1Database, id: string, now: number): Promise<string | null> {
  const row = await db
    .prepare('DELETE FROM email_verifications WHERE id = ? AND expires_at > ? RETURNING user_id')
    .bind(id, now)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Marks the address confirmed (first time only) and drops every other link of that user. */
export async function markEmailVerified(db: D1Database, userId: string, now: number): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL')
      .bind(now, now, userId),
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').bind(userId),
  ]);
}

const ABANDONED_PURGE_LIMIT = 500;

/**
 * Removes accounts nobody confirmed: never verified, every link mailed to them has expired, and no
 * connections (so nothing is lost). It frees an address someone else typed in. An account that
 * was never sent a link (created while mail was off) has no rows here and is never touched.
 * Pass `userId` to check just one account (sign-up does, for the address being registered).
 * Returns how many accounts were removed; FK cascades take their sessions and links.
 */
export async function purgeAbandonedAccounts(db: D1Database, now: number, userId?: string): Promise<number> {
  const r = await db
    .prepare(
      `DELETE FROM users WHERE id IN (
         SELECT u.id FROM users u
          WHERE u.email_verified_at IS NULL
            AND (? IS NULL OR u.id = ?)
            AND EXISTS (SELECT 1 FROM email_verifications v WHERE v.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM email_verifications v WHERE v.user_id = u.id AND v.expires_at > ?)
            AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id)
          LIMIT ?)`,
    )
    .bind(userId ?? null, userId ?? null, now, ABANDONED_PURGE_LIMIT)
    .run();
  return r.meta.changes ?? 0;
}
