/**
 * Sync engine. Owner: Data Plane. Signatures are part of the contract (SPEC.md §9.1); flow per SPEC §4.1.
 *
 * One sync of one connection:
 *   1. lock      conditional UPDATE … RETURNING (fresh 'syncing' rows are skipped; a lock older than
 *                10 min is taken over) + open a `sync_runs` row.
 *   2. snapshot  fetchSnapshot → upsert today's row (+ the adapter's history while it has none)
 *                in its own batch, so it survives a later revenue failure.
 *                Both provider calls run against a wall-clock deadline (`ProviderContext.deadline`):
 *                once it passes no new request starts, so adapters checkpoint with a cursor, and a
 *                hard stop shortly after it aborts anything still in flight, so the final batch
 *                always gets to commit.
 *   3. revenue   fetchRevenue(since, cursor) → validate → ONE final batch that upserts transactions,
 *                rebuilds daily_revenue for the affected days, upserts provider daily points,
 *                moves the cursor / high-water mark, releases the lock and closes the run.
 *                Data, cursor and status therefore commit together or not at all, and every
 *                statement is replayable, so a crash at any point just means "run it again".
 *   4. failure   any error → status='error' + user-safe last_error; last_synced_at keeps meaning
 *                "last successful sync". `syncConnection` never throws.
 *
 * Secrets: credentials are decrypted in memory only; logs carry ids, counts and sanitised messages.
 */

import type { Bindings } from '../env';
import { parseConfig, type ConnectionRow } from '../db/queries';
import { decryptJson } from '../lib/crypto';
import { MINUTE, UTC, normalizeTimeZone, zonedDayKey } from '../lib/time';
import { createProviderContext } from '../providers/context';
import { BudgetExhaustedError } from '../providers/http';
import { getAdapter } from '../providers/adapters';
import { getProviderMeta } from '../providers/registry';
import {
  ProviderError,
  type ConnectionInput,
  type Credentials,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderMeta,
} from '../providers/types';
import {
  advanceRevenue,
  affectedDayRange,
  cleanDailyPoints,
  cleanEvents,
  cleanSnapshot,
  cleanSnapshotHistory,
  planRevenue,
  type RevenueAdvance,
  type RevenuePlan,
} from './aggregate';
import {
  DECRYPT_ERROR,
  SyncError,
  describeSyncError,
  errorLogFields,
  exhaustedMessage,
  genericSyncError,
  isStaleCursorError,
} from './errors';
import { ensureFx, ensureFxHistory, refreshFxIfStale } from './fx';
import { QUEUED_STALE_MS, enqueueSyncs } from './queue';
import {
  acquireSyncLock,
  closeSyncRun,
  connectionExists,
  finishConnection,
  insertSnapshotHistory,
  openSyncRun,
  pruneSyncRuns,
  recomputeDailyRevenue,
  selectDueConnections,
  storedSpanOf,
  upsertProviderDaily,
  upsertSnapshot,
  upsertTransactions,
  type ConnectionFinish,
  type LockedConnectionRow,
} from './repo';

export type SyncKind = 'cron' | 'manual' | 'initial' | 'webhook';

export interface SyncResult {
  ok: boolean;
  /** A snapshot row was written for today. */
  snapshot: boolean;
  /** Revenue events / daily points upserted. */
  events: number;
  /** Revenue backfill finished (no cursor left). */
  done: boolean;
  error: string | null;
  durationMs: number;
}

/**
 * Upstream requests per sync for the snapshot. Not resumable, so it must cover a whole account:
 * 400 Stripe pages of 100 are 35,000 to 40,000 subscriptions, depending on how many coupon, price
 * and product lookups share the budget, if Stripe answers fast enough to fit them in the snapshot's
 * deadline (about 2 pages a second). Providers whose per-minute rate limit is lower cap it in their
 * adapter (`capBudget` in providers/http.ts: Lemon Squeezy, Paddle, Dodo Payments, Chargebee).
 * Every sync runs in its own queue invocation, so one sync costs at most (400 + 20) logical requests
 * × 3 attempts (http.ts retries) ≈ 1,300 subrequests plus FX and D1, against Workers Paid's 10,000.
 */
export const SNAPSHOT_PAGE_BUDGET = 400;
/** Days of past snapshots asked of `fetchSnapshotHistory` on a first sync (the longest dashboard range). */
const SNAPSHOT_HISTORY_DAYS = 90;
/** Upstream requests per sync for revenue paging (SPEC §4.1: 20 per connection). */
export const REVENUE_PAGE_BUDGET = 20;
/**
 * A 'syncing' lock older than this is considered abandoned (matches services/connections.ts). Well
 * past the longest a live sync can hold it (`SYNC_DEADLINE_MS` + `HARD_STOP_GRACE_MS` + its D1
 * writes), so a sync that is still running is never taken over.
 */
export const SYNC_LOCK_STALE_MS = 10 * MINUTE;
/**
 * Connections the cron queues per round (SPEC §4.1): one selection, one claim and one `sendBatch`,
 * whose limit is 100 messages. A tick runs rounds until nothing more is due, up to CRON_MAX_ROUNDS.
 * Due times only move forward and the order is per-tenant round robin, so anything a tick leaves
 * over goes first on the next.
 */
export const CRON_QUEUE_LIMIT = 100;
/**
 * Rounds per tick: at most 1,000 syncs a tick, 2,000 an hour on the 30-minute cron, enough for
 * about 2,000 healthy connections on the default hourly interval (each is due every other tick).
 * One round a tick capped the cron at 200 an hour, so past about 180 connections every one fell
 * behind. (A sync that starts more than MAX_SCHEDULE_GRACE_MS after its tick isn't due again by the
 * tick an hour later, so on a big instance the last syncs of a tick come round every 90 minutes.)
 *
 * The cap is what the consumer can drain (wrangler.jsonc: `max_concurrency` 10, one sync per
 * invocation). Ten slots over QUEUED_STALE_MS (15 min) are 9,000 slot-seconds, so all 1,000 syncs
 * start while their queued marks are still fresh if the average sync takes up to 9 s, and before
 * the next tick if it takes up to 18 s; a small account's sync takes a few seconds. Slower than
 * that, the consumer is the bottleneck, not the cron: a message still waiting at the next tick is
 * queued again (`requeued` in the log), at most once a tick, and the copy is acked as superseded
 * after one D1 read once the first has synced, so the copies stay at about what a tick queued minus
 * what the consumer drained, rather than growing tick after tick. When every sync runs into
 * SYNC_DEADLINE_MS the consumer drains about 73 a tick, below even one round.
 */
export const CRON_MAX_ROUNDS = 10;
/**
 * No round after the first starts later than this after the cron invocation began, FX included.
 * A Cron Trigger invocation may run for 15 minutes of wall time, with 30 s of CPU on Workers Paid
 * for a schedule under an hour (developers.cloudflare.com/workers/platform/limits/). FX takes at
 * most about 40 s (four requests with a 10-s timeout) and a round three round trips (select, claim,
 * sendBatch), normally well under a second, so this only cuts a tick short while D1 or Queues is
 * struggling, and even then the invocation ends minutes inside its limits. The first round always
 * runs, so a slow FX never stops syncs from being queued.
 */
export const CRON_QUEUE_DEADLINE_MS = 2 * MINUTE;
const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
/** A connection in 'error' is retried after this many intervals since its last attempt. */
const ERROR_BACKOFF_INTERVALS = 3;
/**
 * Wall-clock budget of one sync. Every sync runs in its own queue consumer invocation (15 min of
 * wall time), so this bounds how long a slow provider keeps one connection's sync open, not a
 * platform limit; a backfill that needs longer continues on the next sync from its cursor.
 */
export const SYNC_DEADLINE_MS = 4 * MINUTE;
/**
 * Share of the deadline the snapshot may use (3 minutes, time for its whole page budget at about
 * 2 requests a second); revenue (resumable) gets the remainder, at least a minute.
 */
const SNAPSHOT_DEADLINE_SHARE = 0.75;
/**
 * Due-time slack for the cron. Syncs start a few seconds after each tick, so a strict
 * "older than the interval" check would always miss the tick exactly one interval later and
 * turn a 60-min interval into 90 min on a 30-min cron.
 */
const MAX_SCHEDULE_GRACE_MS = 5 * MINUTE;

export const SYNC_BUSY_MESSAGE = 'A sync is already running for this connection.';
const SYNC_NOT_FOUND_MESSAGE = 'Connection not found.';
/** D1 failed while taking the lock: nothing ran or changed, so the queue consumer retries. */
export const SYNC_NOT_STARTED_MESSAGE = 'Couldn’t start the sync. Try again in a minute.';
export const BACKFILL_CONTINUES_MESSAGE = 'Revenue backfill in progress; the next sync continues.';

// ---------- logging (never throws, never logs secrets) ----------

function emit(level: 'log' | 'warn' | 'error', event: string, data: Record<string, unknown>): void {
  try {
    // nosemgrep: unsafe-dynamic-method -- level is typed to three console methods
    console[level](JSON.stringify({ event, ...data }));
  } catch {
    // logging must never break a sync
  }
}

/** Resolved at call time so tests can stub the global; never handed out detached in Workers. */
const globalFetch: typeof fetch = (input, init) => fetch(input, init);

// ---------- deadlines ----------

/**
 * After a phase's deadline no new request starts (`ProviderContext.deadline`), so adapters
 * checkpoint with a cursor. A request already in flight may finish, but no later than this much
 * past the deadline: then the context's signal aborts it, so the final batch always gets to commit.
 */
export const HARD_STOP_GRACE_MS = 5_000;

/** A phase's provider context: its budget, its deadline and the hard stop just after it. */
function phaseContext(tag: string, pageBudget: number, deadline: number): ProviderContext {
  return createProviderContext({
    pageBudget,
    tag,
    deadline,
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now() + HARD_STOP_GRACE_MS)),
  });
}

/** Absolute deadlines for a sync that started at `startedAt`. */
export function syncDeadlines(startedAt: number): { snapshot: number; revenue: number } {
  return { snapshot: startedAt + Math.floor(SYNC_DEADLINE_MS * SNAPSHOT_DEADLINE_SHARE), revenue: startedAt + SYNC_DEADLINE_MS };
}

/** The zone the connection's owner counts days in; UTC when unknown. */
function ownerZone(row: LockedConnectionRow): string {
  return normalizeTimeZone(row.owner_timezone) ?? UTC;
}

// ---------- syncConnection ----------

/** Syncs one connection end to end. Never throws: failures are recorded on the connection. */
export async function syncConnection(env: Bindings, connectionId: string, kind: SyncKind): Promise<SyncResult> {
  const startedAt = Date.now();
  const failed = (error: string): SyncResult => ({
    ok: false,
    snapshot: false,
    events: 0,
    done: false,
    error,
    durationMs: Date.now() - startedAt,
  });

  let row: LockedConnectionRow | null;
  try {
    row = await acquireSyncLock(env.DB, connectionId, startedAt, startedAt - SYNC_LOCK_STALE_MS);
  } catch (err) {
    emit('error', 'sync_error', { phase: 'lock', connectionId, kind, ...errorLogFields(err) });
    return failed(SYNC_NOT_STARTED_MESSAGE);
  }
  if (!row) {
    let exists = true;
    try {
      exists = await connectionExists(env.DB, connectionId);
    } catch {
      // can't tell; "busy" is the harmless answer
    }
    return failed(exists ? SYNC_BUSY_MESSAGE : SYNC_NOT_FOUND_MESSAGE);
  }

  let runId: number | null = null;
  try {
    runId = await openSyncRun(env.DB, row.id, kind, startedAt);
  } catch (err) {
    // Keep going: the sync itself matters more than its history row.
    emit('error', 'sync_error', { phase: 'open_run', connectionId, kind, ...errorLogFields(err) });
  }

  try {
    return await runLocked(env, row, kind, startedAt, runId);
  } catch (err) {
    // runLocked handles its own failures; this backstop still releases the lock.
    emit('error', 'sync_error', { phase: 'engine', connectionId, kind, ...errorLogFields(err) });
    const error = genericSyncError();
    await release(env.DB, row, startedAt, runId, error, row.revenue_cursor);
    return failed(error);
  }
}

/** Marks the run failed without touching data or the cursor. Never throws. */
async function release(
  db: D1Database,
  row: ConnectionRow,
  lockedAt: number,
  runId: number | null,
  error: string,
  revenueCursor: string | null,
): Promise<void> {
  try {
    const stmts = [
      finishConnection(db, {
        id: row.id,
        lockedAt,
        status: 'error',
        lastError: error,
        lastSyncedAt: row.last_synced_at,
        revenueCursor,
        revenueSyncedUntil: row.revenue_synced_until,
      }),
    ];
    if (runId !== null) stmts.push(closeSyncRun(db, runId, { finishedAt: Date.now(), ok: false, events: 0, message: error }));
    stmts.push(pruneSyncRuns(db, row.id));
    await db.batch(stmts);
  } catch (err) {
    // The lock goes stale after SYNC_LOCK_STALE_MS and the next sync takes over.
    emit('error', 'sync_error', { phase: 'release', connectionId: row.id, ...errorLogFields(err) });
  }
}

interface RevenueOutcome {
  writes: D1PreparedStatement[];
  /** Validated events + daily points in `writes`. */
  count: number;
  advance: RevenueAdvance;
}

async function runLocked(
  env: Bindings,
  row: LockedConnectionRow,
  kind: SyncKind,
  now: number,
  runId: number | null,
): Promise<SyncResult> {
  const db = env.DB;
  const meta = getProviderMeta(row.provider);
  const adapter = getAdapter(row.provider);
  const logCtx = { connectionId: row.id, provider: row.provider, kind };

  // A brand-new install has no FX table yet; fetch it alongside the provider calls so the first
  // dashboard is already converted. The cron refreshes FX itself before syncing.
  const fx: Promise<string> =
    kind === 'cron' ? Promise.resolve('cron') : ensureFx(db, globalFetch, now).catch(() => 'failed');

  let firstError: unknown = null;
  /** Logs `err`; the first failure (or its user-facing replacement) becomes last_error. */
  const fail = (phase: string, err: unknown, shown: unknown = err) => {
    emit('error', 'sync_error', { phase, ...logCtx, ...errorLogFields(err) });
    if (firstError === null) firstError = shown;
  };
  /** Engine-owned wording for running out of requests or time (never "the next sync continues" for a snapshot). */
  const exhausted = (phase: 'snapshot' | 'revenue', err: unknown): unknown =>
    err instanceof BudgetExhaustedError ? new SyncError(exhaustedMessage(phase, meta.name, err.reason === 'deadline')) : err;
  const deadlines = syncDeadlines(now);

  let snapshot = false;
  let revenue: RevenueOutcome | null = null;
  /** Cursor to keep when revenue doesn't advance (cleared if it proved stale). */
  let keptCursor = row.revenue_cursor;

  let input: ConnectionInput | null = null;
  try {
    input = { credentials: await loadCredentials(env, row, meta), config: parseConfig(row.config) };
  } catch (err) {
    fail('credentials', err);
  }

  if (input) {
    let skipRevenue = false;
    const snapCtx = phaseContext(`sync:${row.id}:snapshot`, SNAPSHOT_PAGE_BUDGET, deadlines.snapshot);
    try {
      await syncSnapshot(db, adapter, row, input, now, snapCtx, logCtx, fx);
      snapshot = true;
    } catch (err) {
      fail('snapshot', err, exhausted('snapshot', err));
      // The same key would fail the same way on the revenue endpoints.
      skipRevenue = err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'permission');
    }

    if (!skipRevenue) {
      const plan = planRevenue(row, now, ownerZone(row));
      const revCtx = phaseContext(`sync:${row.id}:revenue`, REVENUE_PAGE_BUDGET, deadlines.revenue);
      try {
        revenue = await prepareRevenue(db, adapter, row, input, plan, now, revCtx, logCtx);
      } catch (err) {
        fail('revenue', err, exhausted('revenue', err));
        if (plan.cursor !== null && isStaleCursorError(err)) {
          keptCursor = null; // restart the backfill next time instead of failing on this cursor forever
          emit('warn', 'sync_cursor_reset', logCtx);
        }
      }
    }
  }

  await fx;

  const ok = firstError === null;
  const error = ok ? null : describeSyncError(firstError, meta);
  const advance = revenue?.advance ?? null;
  const done = advance?.done ?? false;
  const events = revenue?.count ?? 0;
  const finish: ConnectionFinish = {
    id: row.id,
    lockedAt: now,
    status: ok ? 'ok' : 'error',
    lastError: error,
    lastSyncedAt: ok ? now : row.last_synced_at,
    revenueCursor: advance ? advance.cursor : keptCursor,
    revenueSyncedUntil: advance ? advance.syncedUntil : row.revenue_synced_until,
  };
  const message = error ?? (done ? null : BACKFILL_CONTINUES_MESSAGE);

  try {
    const writes = revenue?.writes ?? [];
    const stmts = [...writes, finishConnection(db, finish)];
    if (runId !== null) stmts.push(closeSyncRun(db, runId, { finishedAt: Date.now(), ok, events, message }));
    stmts.push(pruneSyncRuns(db, row.id));
    const results = await db.batch(stmts);
    if (results[writes.length]?.meta?.changes === 0) {
      // Our lock went stale and another sync owns the row now; its cursor/status win (data writes are idempotent).
      emit('warn', 'sync_lock_lost', logCtx);
    }
  } catch (err) {
    // Nothing in the batch committed: report the failure and leave the cursor where it was.
    fail('write', err);
    const writeError = describeSyncError(firstError, meta);
    await release(db, row, now, runId, writeError, keptCursor);
    emit('log', 'sync_finished', { ...logCtx, ok: false, snapshot, events: 0, done: false, durationMs: Date.now() - now });
    return { ok: false, snapshot, events: 0, done: false, error: writeError, durationMs: Date.now() - now };
  }

  const durationMs = Date.now() - now;
  emit('log', 'sync_finished', { ...logCtx, ok, snapshot, events, done, durationMs });
  return { ok, snapshot, events, done, error, durationMs };
}

/** Decrypts the secret fields. Providers without secret fields (demo) skip decryption entirely. */
async function loadCredentials(env: Bindings, row: ConnectionRow, meta: ProviderMeta): Promise<Credentials> {
  if (!meta.fields.some((f) => f.secret)) return {};
  let value: unknown;
  try {
    value = await decryptJson<unknown>(env.ENCRYPTION_KEY, row.credentials_enc);
  } catch {
    // Deliberately drop the cause: JSON.parse errors quote the plaintext.
    throw new SyncError(DECRYPT_ERROR);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SyncError(DECRYPT_ERROR);
  const out: Credentials = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

async function syncSnapshot(
  db: D1Database,
  adapter: ProviderAdapter,
  row: LockedConnectionRow,
  input: ConnectionInput,
  now: number,
  ctx: ProviderContext,
  logCtx: Record<string, unknown>,
  /** Settles once FX rates are loaded (or failed to load); awaited before the first visible write. */
  fxReady: Promise<unknown>,
): Promise<void> {
  const raw = await adapter.fetchSnapshot(input, ctx);
  const { snapshot, dropped } = cleanSnapshot(raw);
  if (dropped > 0) emit('warn', 'sync_snapshot_dropped', { ...logCtx, dropped });
  // The owner's local day: the dashboard's "today" (SPEC §6).
  const today = zonedDayKey(now, ownerZone(row));
  const stmts = [upsertSnapshot(db, row.id, today, snapshot, now)];
  if (adapter.fetchSnapshotHistory && !row.has_snapshots) {
    // A connection without snapshots (new, or its key now reads another account) can start its MRR
    // trend with the provider's history. Asked once: today's row, written below, closes the gate
    // whatever the revenue phase does next. Optional data: a failure is logged, and today's
    // snapshot is still written.
    try {
      const history = await adapter.fetchSnapshotHistory(input, { days: SNAPSHOT_HISTORY_DAYS, today }, ctx);
      const { rows, skipped } = cleanSnapshotHistory(history, today, SNAPSHOT_HISTORY_DAYS);
      if (skipped > 0) emit('warn', 'sync_history_skipped', { ...logCtx, skipped });
      stmts.push(...insertSnapshotHistory(db, row.id, rows, now));
    } catch (err) {
      emit('warn', 'sync_history_failed', { ...logCtx, ...errorLogFields(err) });
    }
  }
  // The snapshot is the first row the dashboard can see. On a fresh install the FX table is still
  // being fetched (in parallel with the provider calls); writing before it lands made the first
  // render count only the display currency (e.g. a demo showing $2,240 MRR, then $4,044).
  await fxReady;
  await db.batch(stmts);
}

/** Fetches one revenue page and turns it into statements for the final batch (nothing is written here). */
async function prepareRevenue(
  db: D1Database,
  adapter: ProviderAdapter,
  row: ConnectionRow,
  input: ConnectionInput,
  plan: RevenuePlan,
  now: number,
  ctx: ProviderContext,
  logCtx: Record<string, unknown>,
): Promise<RevenueOutcome> {
  const page: unknown = await adapter.fetchRevenue(input, { since: plan.since, cursor: plan.cursor }, ctx);
  if (typeof page !== 'object' || page === null) throw new Error('fetchRevenue returned no page');
  const p = page as Record<string, unknown>;

  const { events, skipped } = cleanEvents(p['events'], now);
  const { points, skipped: skippedDaily } = cleanDailyPoints(p['daily']);
  if (Object.keys(skipped).length > 0) emit('warn', 'sync_events_skipped', { ...logCtx, skipped });
  if (Object.keys(skippedDaily).length > 0) emit('warn', 'sync_daily_skipped', { ...logCtx, skipped: skippedDaily });

  const advance = advanceRevenue(plan, p, row.revenue_synced_until);
  if (advance.contractIssue) emit('warn', 'sync_adapter_contract', { ...logCtx, issue: advance.contractIssue });

  const writes: D1PreparedStatement[] = [];
  if (events.length > 0) {
    // Days to rebuild: every day an event lands on now, plus where re-delivered events used to be.
    const stored = await storedSpanOf(
      db,
      row.id,
      events.map((e) => e.externalId),
    );
    const times = events.map((e) => e.occurredAt);
    if (stored) times.push(stored.lo, stored.hi);
    const range = affectedDayRange(times)!;
    writes.push(...upsertTransactions(db, row.id, events), ...recomputeDailyRevenue(db, row.id, range));
  }
  // After the recompute: provider aggregates win over anything derived for the same day + currency.
  if (points.length > 0) writes.push(...upsertProviderDaily(db, row.id, points));

  return { writes, count: events.length + points.length, advance };
}

// ---------- cron ----------

function syncIntervalMs(env: Bindings): number {
  const n = Number(env.SYNC_INTERVAL_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_SYNC_INTERVAL_MINUTES) * MINUTE;
}

/**
 * Why a tick stopped queueing (`stop` in the `cron_sync` log):
 *   done       nothing more is due (a round found fewer than CRON_QUEUE_LIMIT, or all that were);
 *   cap        CRON_MAX_ROUNDS ran and more are due: the instance has more due than a tick queues;
 *   deadline   CRON_QUEUE_DEADLINE_MS passed with more due;
 *   unclaimed  a round queued nothing, every claim lost to another producer: stop rather than spin;
 *   error      D1 or the queue failed.
 */
type CronStop = 'done' | 'cap' | 'deadline' | 'unclaimed' | 'error';

/**
 * Cron entry point (SPEC §4.1): refresh FX daily, then put the due connections on the sync queue,
 * most overdue first, in rounds of CRON_QUEUE_LIMIT. The syncs themselves run in the queue consumer
 * (sync/consumer.ts), one per invocation.
 *
 * Each round's claim marks the connections it queued, so the next round's selection skips them
 * (`queuedBefore`) while still counting them in their tenant's turns. The `cron_sync` summary says
 * how far behind the instance is: `due` when the tick began, `left` still due when it stopped,
 * `rounds`, `stop`, and `requeued`, the connections whose previous message hadn't started after
 * QUEUED_STALE_MS. A tick the cap or the deadline cut short, or that requeued any, logs a warning.
 */
export async function runScheduledSync(env: Bindings, now: number = Date.now()): Promise<void> {
  const wallStart = Date.now();
  const summary: Record<string, unknown> = { due: 0, queued: 0, rounds: 0 };

  // Settled before any sync is queued, so a dashboard never renders a fresh install's numbers
  // without rates (cron syncs skip ensureFx). refreshFxIfStale never throws (catch is belt and braces).
  const fx = await refreshFxIfStale(env.DB, globalFetch, now).catch(() => 'failed');
  // Past days' rates, fetched once after an install or upgrade (usually one D1 read and done).
  summary['fxHistory'] = await ensureFxHistory(env.DB, globalFetch, now).catch(() => 'failed');

  let stop: CronStop = 'done';
  let rounds = 0;
  let queued = 0;
  let requeued = 0;
  let left = 0;
  try {
    const intervalMs = syncIntervalMs(env);
    const grace = Math.min(MAX_SCHEDULE_GRACE_MS, Math.floor(intervalMs / 10));
    const query = {
      now,
      okWaitMs: intervalMs - grace,
      errorWaitMs: ERROR_BACKOFF_INTERVALS * intervalMs - grace,
      // A never-synced connection whose first sync was killed is retried as soon as its lock is stale.
      retryWaitMs: SYNC_LOCK_STALE_MS,
      staleBefore: now - SYNC_LOCK_STALE_MS,
      queuedBefore: now - QUEUED_STALE_MS,
      limit: CRON_QUEUE_LIMIT,
    };
    for (;;) {
      if (rounds === CRON_MAX_ROUNDS) {
        stop = 'cap';
        break;
      }
      if (rounds > 0 && Date.now() - wallStart >= CRON_QUEUE_DEADLINE_MS) {
        stop = 'deadline';
        break;
      }
      const { rows, due } = await selectDueConnections(env.DB, query);
      rounds++;
      if (rounds === 1) summary['due'] = due;
      left = due; // until they're on the queue
      const sent = await enqueueSyncs(env, rows.map((r) => r.id), 'cron', now);
      // Fewer than selected when a Sync now or a webhook queued some of them since the selection.
      queued += sent.length;
      const stale = new Set(rows.filter((r) => r.requeued).map((r) => r.id));
      requeued += sent.filter((id) => stale.has(id)).length;
      left = due - rows.length;
      if (rows.length < CRON_QUEUE_LIMIT || left <= 0) break; // 'done'
      if (sent.length === 0) {
        stop = 'unclaimed';
        break;
      }
    }
  } catch (err) {
    stop = 'error';
    summary['error'] = errorLogFields(err);
  }

  Object.assign(summary, { queued, rounds, stop, left: Math.max(0, left), requeued, fx, durationMs: Date.now() - wallStart });
  const behind = stop === 'cap' || stop === 'deadline' || requeued > 0;
  emit(summary['error'] ? 'error' : behind ? 'warn' : 'log', 'cron_sync', summary);
}
