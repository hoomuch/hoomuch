/**
 * D1 statements of the sync engine. Owner: Data Plane.
 *
 * Rules every statement here follows:
 *   - replayable: upserts / ON CONFLICT, so a crashed or repeated sync converges to the same rows;
 *   - bulk rows travel as ONE bound JSON parameter expanded with `json_each`, chunked by rows and
 *     bytes, which keeps every statement far below D1's 100-bound-parameter and 100 KB limits;
 *   - builders return statements so the engine can commit data + cursor + status in one `db.batch`
 *     (a D1 batch is a single transaction).
 */

import type { ConnectionRow } from '../db/queries';
import type { DailyRevenuePoint, MetricsSnapshot, RevenueEvent } from '../providers/types';
import { rangeBounds, type DayRange } from './aggregate';

/** Rows per bulk statement. */
export const BULK_MAX_ROWS = 200;
/** JSON bytes per bulk statement (D1 caps a statement at 100 KB; stay well clear). */
export const BULK_MAX_BYTES = 50_000;
/** External ids per lookup statement. */
const LOOKUP_MAX_IDS = 500;

/** SQLite expression for the UTC day of an epoch-ms column (integer division floors, like dayKey). */
const DAY_OF = (col: string) => `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;

/** Splits rows into JSON arrays that respect both the row and the byte budget. */
export function jsonChunks(rows: readonly unknown[], maxRows = BULK_MAX_ROWS, maxBytes = BULK_MAX_BYTES): string[] {
  const out: string[] = [];
  let parts: string[] = [];
  let bytes = 2;
  for (const row of rows) {
    const s = JSON.stringify(row);
    if (parts.length > 0 && (parts.length >= maxRows || bytes + s.length + 1 > maxBytes)) {
      out.push(`[${parts.join(',')}]`);
      parts = [];
      bytes = 2;
    }
    parts.push(s);
    bytes += s.length + 1;
  }
  if (parts.length > 0) out.push(`[${parts.join(',')}]`);
  return out;
}

// ---------- lock & run bookkeeping ----------

/**
 * Takes the per-connection sync lock and returns the locked row, or null when the connection is
 * missing or another sync holds a fresh lock. A lock older than `staleBefore` is taken over.
 */
export function acquireSyncLock(db: D1Database, id: string, now: number, staleBefore: number): Promise<ConnectionRow | null> {
  return db
    .prepare(
      `UPDATE connections SET status = 'syncing', last_sync_started_at = ?2, queued_at = NULL
        WHERE id = ?1 AND NOT (status = 'syncing' AND COALESCE(last_sync_started_at, 0) > ?3)
       RETURNING *`,
    )
    .bind(id, now, staleBefore)
    .first<ConnectionRow>();
}

export async function connectionExists(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS x FROM connections WHERE id = ?').bind(id).first<{ x: number }>()) !== null;
}

export const INTERRUPTED_RUN_MESSAGE = 'Interrupted before it finished.';
/** Run history kept per connection (the detail page shows 10). */
export const SYNC_RUNS_KEPT = 100;

/**
 * Opens our run row. Holding the lock means no earlier run of this connection is legitimately
 * open any more (killed worker, stale lock taken over), so those are closed as interrupted in the
 * same round trip. A slow run that is in fact still alive overwrites this with its real outcome.
 */
export async function openSyncRun(db: D1Database, connectionId: string, kind: string, startedAt: number): Promise<number | null> {
  const [, inserted] = await db.batch<{ id: number }>([
    db
      .prepare(
        `UPDATE sync_runs SET finished_at = ?2, ok = 0, message = ?3
          WHERE connection_id = ?1 AND finished_at IS NULL AND started_at < ?2`,
      )
      .bind(connectionId, startedAt, INTERRUPTED_RUN_MESSAGE),
    db
      .prepare('INSERT INTO sync_runs (connection_id, kind, started_at) VALUES (?, ?, ?) RETURNING id')
      .bind(connectionId, kind, startedAt),
  ]);
  return inserted?.results?.[0]?.id ?? null;
}

/** Keeps the newest SYNC_RUNS_KEPT runs of a connection. */
export function pruneSyncRuns(db: D1Database, connectionId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM sync_runs
        WHERE connection_id = ?1
          AND id < (SELECT id FROM sync_runs WHERE connection_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)`,
    )
    .bind(connectionId, SYNC_RUNS_KEPT - 1);
}

export function closeSyncRun(
  db: D1Database,
  runId: number,
  r: { finishedAt: number; ok: boolean; events: number; message: string | null },
): D1PreparedStatement {
  return db
    .prepare('UPDATE sync_runs SET finished_at = ?, ok = ?, events = ?, message = ? WHERE id = ?')
    .bind(r.finishedAt, r.ok ? 1 : 0, r.events, r.message, runId);
}

export interface ConnectionFinish {
  id: string;
  /** `last_sync_started_at` written by our lock: the fencing token. */
  lockedAt: number;
  status: 'ok' | 'error';
  lastError: string | null;
  lastSyncedAt: number | null;
  revenueCursor: string | null;
  revenueSyncedUntil: number | null;
}

/**
 * Releases the lock with the run's outcome. Fenced on our lock timestamp: if the lock went stale
 * and another sync took over, this is a no-op and that sync's cursor/status win.
 */
export function finishConnection(db: D1Database, f: ConnectionFinish): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE connections
          SET status = ?, last_error = ?, last_synced_at = ?, revenue_cursor = ?, revenue_synced_until = ?
        WHERE id = ? AND status = 'syncing' AND last_sync_started_at = ?`,
    )
    .bind(f.status, f.lastError, f.lastSyncedAt, f.revenueCursor, f.revenueSyncedUntil, f.id, f.lockedAt);
}

// ---------- snapshots ----------

function snapshotColumns(s: MetricsSnapshot) {
  return {
    mrr: JSON.stringify(s.mrr),
    subs: s.activeSubscriptions,
    trials: s.activeTrials,
    period: s.revenuePeriod ? JSON.stringify(s.revenuePeriod) : null,
    periodDays: s.revenuePeriodDays,
    newCustomers: s.newCustomers,
    byProduct: s.mrrByProduct ? JSON.stringify(s.mrrByProduct) : null,
    warnings: s.warnings && s.warnings.length > 0 ? JSON.stringify(s.warnings) : null,
  };
}

/** Today's snapshot; re-syncs on the same day overwrite it. */
export function upsertSnapshot(
  db: D1Database,
  connectionId: string,
  day: string,
  s: MetricsSnapshot,
  capturedAt: number,
): D1PreparedStatement {
  const c = snapshotColumns(s);
  return db
    .prepare(
      `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period,
                              revenue_period_days, new_customers, mrr_by_product, warnings, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, day) DO UPDATE SET
         mrr = excluded.mrr, active_subscriptions = excluded.active_subscriptions,
         active_trials = excluded.active_trials, revenue_period = excluded.revenue_period,
         revenue_period_days = excluded.revenue_period_days, new_customers = excluded.new_customers,
         mrr_by_product = excluded.mrr_by_product, warnings = excluded.warnings, captured_at = excluded.captured_at`,
    )
    .bind(connectionId, day, c.mrr, c.subs, c.trials, c.period, c.periodDays, c.newCustomers, c.byProduct, c.warnings, capturedAt);
}

/** Past snapshots (`fetchSnapshotHistory`). Never overwrites a day that already has a row; no warnings. */
export function insertSnapshotHistory(
  db: D1Database,
  connectionId: string,
  rows: ReadonlyArray<{ day: string; snapshot: MetricsSnapshot }>,
  capturedAt: number,
): D1PreparedStatement[] {
  const payload = rows.map((r) => ({ day: r.day, ...snapshotColumns(r.snapshot) }));
  return jsonChunks(payload).map((json) =>
    db
      .prepare(
        `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period,
                                revenue_period_days, new_customers, mrr_by_product, captured_at)
         SELECT ?1, json_extract(value, '$.day'), json_extract(value, '$.mrr'), json_extract(value, '$.subs'),
                json_extract(value, '$.trials'), json_extract(value, '$.period'), json_extract(value, '$.periodDays'),
                json_extract(value, '$.newCustomers'), json_extract(value, '$.byProduct'), ?2
           FROM json_each(?3) WHERE true
         ON CONFLICT(connection_id, day) DO NOTHING`,
      )
      .bind(connectionId, capturedAt, json),
  );
}

// ---------- transactions & daily revenue ----------

/** Idempotent upsert: a re-delivered event overwrites every column of its row. */
export function upsertTransactions(db: D1Database, connectionId: string, events: readonly RevenueEvent[]): D1PreparedStatement[] {
  const payload = events.map((e) => ({
    id: e.externalId,
    at: e.occurredAt,
    type: e.type,
    amount: e.amount,
    currency: e.currency,
    fee: e.fee,
    description: e.description,
  }));
  return jsonChunks(payload).map((json) =>
    db
      .prepare(
        // `WHERE true` resolves SQLite's INSERT…SELECT…ON CONFLICT parsing ambiguity.
        `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
         SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.at'), json_extract(value, '$.type'),
                json_extract(value, '$.amount'), json_extract(value, '$.currency'), json_extract(value, '$.fee'),
                json_extract(value, '$.description')
           FROM json_each(?2) WHERE true
         ON CONFLICT(connection_id, external_id) DO UPDATE SET
           occurred_at = excluded.occurred_at, type = excluded.type, amount = excluded.amount,
           currency = excluded.currency, fee = excluded.fee, description = excluded.description`,
      )
      .bind(connectionId, json),
  );
}

/**
 * Time span currently stored for these external ids (null if none exist yet). An event that is
 * re-delivered with a different timestamp leaves its OLD day stale too, so the engine widens the
 * recompute range with this.
 */
export async function storedSpanOf(
  db: D1Database,
  connectionId: string,
  externalIds: readonly string[],
): Promise<{ lo: number; hi: number } | null> {
  if (externalIds.length === 0) return null;
  const stmts = jsonChunks(externalIds, LOOKUP_MAX_IDS).map((json) =>
    db
      .prepare(
        `SELECT MIN(occurred_at) AS lo, MAX(occurred_at) AS hi FROM transactions
          WHERE connection_id = ?1 AND external_id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(connectionId, json),
  );
  const results = await db.batch<{ lo: number | null; hi: number | null }>(stmts);
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of results) {
    const row = r.results?.[0];
    if (row?.lo != null && row.lo < lo) lo = row.lo;
    if (row?.hi != null && row.hi > hi) hi = row.hi;
  }
  return lo === Infinity ? null : { lo, hi };
}

/**
 * Rebuilds `daily_revenue` (source='transactions') for every day in `range` from `transactions`:
 * gross = sum of positive amounts, refunds = −sum of negative amounts, count = rows.
 * Provider-reported rows (source='provider') are authoritative and never touched here.
 * Must run after the transaction upserts, in the same batch.
 */
export function recomputeDailyRevenue(db: D1Database, connectionId: string, range: DayRange): D1PreparedStatement[] {
  const { start, end } = rangeBounds(range);
  return [
    db
      .prepare(
        `DELETE FROM daily_revenue
          WHERE connection_id = ? AND source = 'transactions' AND day >= ? AND day <= ?`,
      )
      .bind(connectionId, range.from, range.to),
    db
      .prepare(
        `INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source)
         SELECT ?1, ${DAY_OF('occurred_at')} AS d, currency,
                COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0),
                COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0),
                COUNT(*), 'transactions'
           FROM transactions
          WHERE connection_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
          GROUP BY d, currency
         ON CONFLICT(connection_id, day, currency) DO NOTHING`,
      )
      .bind(connectionId, start, end),
  ];
}

/** Provider-aggregated points (RevenueCat): upsert, overwriting whatever the day held. */
export function upsertProviderDaily(
  db: D1Database,
  connectionId: string,
  points: readonly DailyRevenuePoint[],
): D1PreparedStatement[] {
  return jsonChunks(points).map((json) =>
    db
      .prepare(
        `INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source)
         SELECT ?1, json_extract(value, '$.day'), json_extract(value, '$.currency'), json_extract(value, '$.gross'),
                json_extract(value, '$.refunds'), json_extract(value, '$.count'), 'provider'
           FROM json_each(?2) WHERE true
         ON CONFLICT(connection_id, day, currency) DO UPDATE SET
           gross = excluded.gross, refunds = excluded.refunds, count = excluded.count, source = 'provider'`,
      )
      .bind(connectionId, json),
  );
}

// ---------- cron ----------

export interface DueQuery {
  now: number;
  /** Wait after the last attempt for healthy connections (interval − grace). */
  okWaitMs: number;
  /** Wait after the last attempt for connections in 'error' (back-off). */
  errorWaitMs: number;
  /** Wait after the last attempt for never-synced 'pending' / stale 'syncing' rows (killed first sync). */
  retryWaitMs: number;
  /** A 'syncing' row started after this holds a fresh lock and is skipped. */
  staleBefore: number;
  /** A row queued after this already has a sync on its way and is skipped. */
  queuedBefore: number;
  limit: number;
}

/**
 * Connections due for a scheduled sync. Each one is due at `last attempt + wait`, where the wait
 * depends on its state (healthy / failing / never synced). Ordering is per-tenant round robin
 * (every user's most overdue connection first, then every user's second, …), then by due time.
 * Failing connections therefore never sort ahead just because their last SUCCESS is old, one tenant
 * can't fill the batch while another tenant has due work, and because due times only move forward,
 * every due connection is eventually served even when the cron is over capacity.
 */
export async function selectDueConnections(db: D1Database, q: DueQuery): Promise<string[]> {
  const { results } = await db
    .prepare(
      `WITH candidates AS (
         SELECT id, user_id, created_at,
                MAX(COALESCE(last_synced_at, 0), COALESCE(last_sync_started_at, 0)) +
                CASE
                  WHEN status = 'error' THEN ?3
                  WHEN last_synced_at IS NULL AND status IN ('pending', 'syncing') THEN ?4
                  ELSE ?2
                END AS due_at
           FROM connections
          WHERE NOT (status = 'syncing' AND COALESCE(last_sync_started_at, 0) > ?5)
            AND COALESCE(queued_at, 0) <= ?7
       ),
       ranked AS (
         SELECT id, created_at, due_at,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY due_at, created_at, id) AS turn
           FROM candidates
          WHERE due_at <= ?1
       )
       SELECT id FROM ranked ORDER BY turn, due_at, created_at, id LIMIT ?6`,
    )
    .bind(q.now, q.okWaitMs, q.errorWaitMs, q.retryWaitMs, q.staleBefore, q.limit, q.queuedBefore)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

/** Marks connections as having a sync on the queue (`connections.queued_at`). */
export function markQueued(db: D1Database, ids: readonly string[], at: number): D1PreparedStatement {
  return db
    .prepare('UPDATE connections SET queued_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))')
    .bind(at, JSON.stringify(ids));
}

/** Undoes `markQueued` when the send failed, unless something queued them again since. */
export function clearQueued(db: D1Database, ids: readonly string[], at: number): D1PreparedStatement {
  return db
    .prepare('UPDATE connections SET queued_at = NULL WHERE id IN (SELECT value FROM json_each(?2)) AND queued_at = ?1')
    .bind(at, JSON.stringify(ids));
}
