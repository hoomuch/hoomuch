/**
 * Pure helpers for the sync engine. Owner: Data Plane.
 *
 * No D1, no clock, no I/O, so everything here is unit-tested directly:
 *   - defensive validation of what adapters return (events, daily points, snapshots),
 *   - the revenue plan (`since` / cursor) and the backfill cursor envelope,
 *   - day ranges and `dailyFromEvents`, the reference version of the SQL aggregation
 *     in repo.ts (tests check that `daily_revenue` always equals it).
 */

import { normalizeCurrency, type MoneyMap } from '../lib/money';
import { DAY, addDays, dayKey, dayStart } from '../lib/time';
import type { DailyRevenuePoint, MetricsSnapshot, ProductMrr, RevenueEvent } from '../providers/types';

/**
 * The first sync covers this many UTC days INCLUDING today (SPEC F-07): exactly the dashboard's
 * longest range (`lastNDays(90)`), so that range's "previous period" is empty rather than one
 * stray day that would show a meaningless revenue delta.
 */
export const BACKFILL_DAYS = 90;
/** Incremental syncs re-read this much before the high-water mark (late-arriving events, refunds). */
export const REVENUE_OVERLAP_MS = 2 * DAY;
/** Anything earlier is almost certainly a seconds-vs-milliseconds bug in an adapter. */
export const MIN_PLAUSIBLE_TIME = Date.UTC(2000, 0, 1);
/** Clock skew we tolerate for events stamped "in the future". */
export const MAX_FUTURE_SKEW_MS = DAY;
export const MAX_EXTERNAL_ID_LENGTH = 255;
export const MAX_DESCRIPTION_LENGTH = 200;
/** Products kept per snapshot split; MRR beyond them shows as "No product name". */
export const MAX_SNAPSHOT_PRODUCTS = 500;

const CURRENCY_RE = /^[A-Z]{3}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- primitives ----------

/** ISO 4217-looking code, upper-cased ("usd" → "USD"), or null. */
export function cleanCurrency(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = normalizeCurrency(v);
  return CURRENCY_RE.test(c) ? c : null;
}

/** A real 'YYYY-MM-DD' calendar day (rejects 2026-02-30 and 2026-13-01). */
export function isDayKey(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const t = dayStart(v);
  return Number.isFinite(t) && dayKey(t) === v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonNegativeInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

export type SkipCounts = Record<string, number>;

function bump(counts: SkipCounts, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

// ---------- revenue events ----------

/**
 * Validates adapter events. Bad rows are skipped (never fatal) and counted by reason so the
 * engine can log them without logging the rows themselves. Later duplicates of an externalId win.
 */
export function cleanEvents(input: unknown, now: number): { events: RevenueEvent[]; skipped: SkipCounts } {
  const skipped: SkipCounts = {};
  const byId = new Map<string, RevenueEvent>();
  if (!Array.isArray(input)) {
    if (input !== undefined && input !== null) bump(skipped, 'not_an_array');
    return { events: [], skipped };
  }
  for (const raw of input) {
    if (!isRecord(raw)) {
      bump(skipped, 'shape');
      continue;
    }
    const id = raw['externalId'];
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_EXTERNAL_ID_LENGTH) {
      bump(skipped, 'external_id');
      continue;
    }
    const at = raw['occurredAt'];
    if (typeof at !== 'number' || !Number.isFinite(at) || at < MIN_PLAUSIBLE_TIME || at > now + MAX_FUTURE_SKEW_MS) {
      bump(skipped, 'occurred_at');
      continue;
    }
    const type = raw['type'];
    if (type !== 'charge' && type !== 'refund') {
      bump(skipped, 'type');
      continue;
    }
    const amount = raw['amount'];
    // Contract: integer minor units, charges > 0, refunds < 0. A float usually means major units.
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || (type === 'charge' ? amount <= 0 : amount >= 0)) {
      bump(skipped, 'amount');
      continue;
    }
    const currency = cleanCurrency(raw['currency']);
    if (!currency) {
      bump(skipped, 'currency');
      continue;
    }
    const fee = raw['fee'];
    const desc = raw['description'];
    const description = typeof desc === 'string' ? desc.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_LENGTH) : '';
    if (byId.has(id)) bump(skipped, 'duplicate');
    byId.set(id, {
      externalId: id,
      occurredAt: Math.floor(at),
      type,
      amount,
      currency,
      fee: typeof fee === 'number' && Number.isSafeInteger(fee) ? fee : null,
      description: description || null,
    });
  }
  return { events: [...byId.values()], skipped };
}

// ---------- provider daily points ----------

/** Validates pre-aggregated daily points; later duplicates of (day, currency) win. */
export function cleanDailyPoints(input: unknown): { points: DailyRevenuePoint[]; skipped: SkipCounts } {
  const skipped: SkipCounts = {};
  const byKey = new Map<string, DailyRevenuePoint>();
  if (!Array.isArray(input)) {
    if (input !== undefined && input !== null) bump(skipped, 'not_an_array');
    return { points: [], skipped };
  }
  for (const raw of input) {
    if (!isRecord(raw)) {
      bump(skipped, 'shape');
      continue;
    }
    const day = raw['day'];
    if (!isDayKey(day)) {
      bump(skipped, 'day');
      continue;
    }
    const currency = cleanCurrency(raw['currency']);
    if (!currency) {
      bump(skipped, 'currency');
      continue;
    }
    const { gross, refunds, count } = raw;
    if (![gross, refunds, count].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
      bump(skipped, 'amount');
      continue;
    }
    const key = `${day}|${currency}`;
    if (byKey.has(key)) bump(skipped, 'duplicate');
    byKey.set(key, { day, currency, gross: gross as number, refunds: refunds as number, count: count as number });
  }
  return { points: [...byKey.values()], skipped };
}

// ---------- snapshots ----------

/** Rounds amounts, upper-cases codes, drops entries that aren't money. Null if not an object. */
export function cleanMoneyMap(input: unknown): { map: MoneyMap; dropped: number } | null {
  if (!isRecord(input)) return null;
  const map: MoneyMap = {};
  let dropped = 0;
  for (const key of Object.keys(input).sort()) {
    const cur = cleanCurrency(key);
    const v = input[key];
    const sum = typeof v === 'number' ? (map[cur ?? ''] ?? 0) + Math.round(v) : NaN;
    // Safe integers only (like events and daily points): beyond 2^53 money math silently rounds.
    if (!cur || !Number.isSafeInteger(sum)) {
      dropped++;
      continue;
    }
    map[cur] = sum;
  }
  return { map, dropped };
}

/** A product or plan name as stored: one line, trimmed, capped; null when there's nothing left. */
export function cleanProductName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_LENGTH) || null;
}

/**
 * A snapshot's MRR split by product: entries with a money map and positive MRR, biggest first (minor
 * units summed across currencies, which is only for the order and the cap), at most MAX_SNAPSHOT_PRODUCTS. Null when the adapter sent none (or not a list). What's dropped stays out of
 * the split only: the dashboard shows a connection's MRR minus its named products as "No product name".
 */
export function cleanProductMrr(input: unknown): { products: ProductMrr[]; dropped: number } | null {
  if (!Array.isArray(input)) return null;
  const products: ProductMrr[] = [];
  let dropped = 0;
  for (const raw of input) {
    const mrr = isRecord(raw) ? cleanMoneyMap(raw['mrr']) : null;
    if (!isRecord(raw) || !mrr || Object.values(mrr.map).every((v) => v <= 0)) {
      dropped++;
      continue;
    }
    dropped += mrr.dropped;
    products.push({ name: cleanProductName(raw['name']), mrr: mrr.map, subscriptions: nonNegativeInt(raw['subscriptions']) ?? 0 });
  }
  const total = (p: ProductMrr) => Object.values(p.mrr).reduce((s, v) => s + v, 0);
  products.sort((a, b) => total(b) - total(a) || (a.name ?? '').localeCompare(b.name ?? ''));
  dropped += Math.max(0, products.length - MAX_SNAPSHOT_PRODUCTS);
  return { products: products.slice(0, MAX_SNAPSHOT_PRODUCTS), dropped };
}

/**
 * Normalises a snapshot for storage. Throws when it can't be stored at all (no MRR map,
 * no subscription count): writing a zero there would put a false dip in the MRR trend.
 */
export function cleanSnapshot(input: unknown): { snapshot: MetricsSnapshot; dropped: number } {
  if (!isRecord(input)) throw new Error('snapshot: not an object');
  const mrr = cleanMoneyMap(input['mrr']);
  if (!mrr) throw new Error('snapshot: mrr is not a money map');
  const subs = nonNegativeInt(input['activeSubscriptions']);
  if (subs === null) throw new Error('snapshot: activeSubscriptions is not a count');
  const period = input['revenuePeriod'] == null ? null : cleanMoneyMap(input['revenuePeriod']);
  const days = nonNegativeInt(input['revenuePeriodDays']);
  const byProduct = cleanProductMrr(input['mrrByProduct']);
  return {
    snapshot: {
      mrr: mrr.map,
      activeSubscriptions: subs,
      activeTrials: nonNegativeInt(input['activeTrials']),
      revenuePeriod: period ? period.map : null,
      revenuePeriodDays: period && days ? days : null,
      newCustomers: nonNegativeInt(input['newCustomers']),
      mrrByProduct: byProduct ? byProduct.products : null,
    },
    dropped: mrr.dropped + (period?.dropped ?? 0) + (byProduct?.dropped ?? 0),
  };
}

/**
 * Validates what `fetchSnapshotHistory` returned: real days before `today`, each a storable
 * snapshot, one row per day (the first wins), at most `maxDays` of them (the newest).
 */
export function cleanSnapshotHistory(
  input: unknown,
  today: string,
  maxDays: number,
): { rows: Array<{ day: string; snapshot: MetricsSnapshot }>; skipped: number } {
  if (!Array.isArray(input)) return { rows: [], skipped: input == null ? 0 : 1 };
  const byDay = new Map<string, MetricsSnapshot>();
  let skipped = 0;
  for (const raw of input) {
    const day = isRecord(raw) ? raw['day'] : null;
    if (!isRecord(raw) || !isDayKey(day) || day >= today || byDay.has(day)) {
      skipped++;
      continue;
    }
    try {
      byDay.set(day, cleanSnapshot(raw['snapshot']).snapshot);
    } catch {
      skipped++;
    }
  }
  const rows = [...byDay].map(([day, snapshot]) => ({ day, snapshot })).sort((a, b) => (a.day < b.day ? -1 : 1));
  skipped += Math.max(0, rows.length - maxDays);
  return { rows: rows.slice(Math.max(0, rows.length - maxDays)), skipped };
}

// ---------- day ranges & the reference aggregation ----------

export interface DayRange {
  /** Inclusive 'YYYY-MM-DD'. */
  from: string;
  /** Inclusive 'YYYY-MM-DD'. */
  to: string;
}

/** Smallest day range covering every timestamp; null when there are none. */
export function affectedDayRange(timestamps: Iterable<number>): DayRange | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of timestamps) {
    if (!Number.isFinite(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return lo === Infinity ? null : { from: dayKey(lo), to: dayKey(hi) };
}

/** Epoch-ms bounds [start, end) of a day range, for indexed `occurred_at` predicates. */
export function rangeBounds(range: DayRange): { start: number; end: number } {
  return { start: dayStart(range.from), end: dayStart(range.to) + DAY };
}

/**
 * Daily revenue from transactions, grouped by UTC day and currency: gross = sum of positive
 * amounts, refunds = −sum of negative amounts, count = rows. Sorted by day, then currency.
 * This is the reference for the SQL in repo.ts `recomputeDailyRevenue`.
 */
export function dailyFromEvents(
  events: Iterable<Pick<RevenueEvent, 'occurredAt' | 'amount' | 'currency'>>,
): DailyRevenuePoint[] {
  const byKey = new Map<string, DailyRevenuePoint>();
  for (const e of events) {
    const day = dayKey(e.occurredAt);
    const key = `${day}|${e.currency}`;
    let p = byKey.get(key);
    if (!p) {
      p = { day, currency: e.currency, gross: 0, refunds: 0, count: 0 };
      byKey.set(key, p);
    }
    if (e.amount > 0) p.gross += e.amount;
    else p.refunds -= e.amount;
    p.count += 1;
  }
  return [...byKey.values()].sort((a, b) =>
    a.day === b.day ? (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0) : a.day < b.day ? -1 : 1,
  );
}

// ---------- revenue plan & backfill cursor ----------

/**
 * What the engine stores in `connections.revenue_cursor` while a backfill is in progress:
 * the adapter's opaque cursor plus the `since` and start time of the iteration, so a resumed
 * call asks for exactly the same window and the high-water mark can't skip events that
 * arrived while the backfill was running (newest-first APIs like Stripe never revisit them).
 */
export interface BackfillState {
  cursor: string;
  since: number;
  startedAt: number;
}

const ENVELOPE_VERSION = 1;

export function encodeBackfill(state: BackfillState): string {
  return JSON.stringify({ v: ENVELOPE_VERSION, cursor: state.cursor, since: state.since, startedAt: state.startedAt });
}

/** Null when `raw` isn't an envelope (e.g. a bare adapter cursor). */
export function decodeBackfill(raw: string): BackfillState | null {
  if (!raw.startsWith('{')) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (
      isRecord(v) &&
      v['v'] === ENVELOPE_VERSION &&
      typeof v['cursor'] === 'string' &&
      v['cursor'].length > 0 &&
      typeof v['since'] === 'number' &&
      Number.isFinite(v['since']) &&
      typeof v['startedAt'] === 'number' &&
      Number.isFinite(v['startedAt'])
    ) {
      return { cursor: v['cursor'], since: v['since'], startedAt: v['startedAt'] };
    }
  } catch {
    // not ours
  }
  return null;
}

export interface RevenuePlan {
  /** Passed to the adapter; stable across every call of one backfill. */
  since: number;
  /** Adapter cursor to resume from, or null for a fresh pass. */
  cursor: string | null;
  /** Start of this pass (the first run's start when resuming); the next high-water mark. */
  startedAt: number;
}

/**
 * Fresh pass: `since` = high-water − 2 days, or (first sync) midnight UTC at the start of the
 * 90-day window, so its oldest day is complete. Resumed pass: the stored envelope's values.
 */
export function planRevenue(
  state: { revenue_cursor: string | null; revenue_synced_until: number | null },
  now: number,
): RevenuePlan {
  const freshSince =
    state.revenue_synced_until !== null && Number.isFinite(state.revenue_synced_until)
      ? Math.min(state.revenue_synced_until - REVENUE_OVERLAP_MS, now)
      : dayStart(addDays(dayKey(now), -(BACKFILL_DAYS - 1)));
  const raw = state.revenue_cursor;
  if (!raw) return { since: freshSince, cursor: null, startedAt: now };
  const env = decodeBackfill(raw);
  if (env) return { since: env.since, cursor: env.cursor, startedAt: Math.min(env.startedAt, now) };
  // A bare cursor (not written by this engine version): resume it with the usual window.
  return { since: freshSince, cursor: raw, startedAt: now };
}

export interface RevenueAdvance {
  /** New value for `revenue_cursor`. */
  cursor: string | null;
  /** New value for `revenue_synced_until` (unchanged while a backfill continues). */
  syncedUntil: number | null;
  done: boolean;
  /** Set when the adapter broke the RevenuePage contract; the engine logs it. */
  contractIssue: 'cursor_and_done' | 'neither_cursor_nor_done' | null;
}

/**
 * Where the backfill stands after a page. A cursor always wins (continuing is safe, stopping
 * could drop data); no cursor means done, even if the adapter forgot to say so.
 */
export function advanceRevenue(
  plan: RevenuePlan,
  page: { nextCursor?: unknown; done?: unknown },
  currentSyncedUntil: number | null,
): RevenueAdvance {
  const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : null;
  if (next) {
    return {
      cursor: encodeBackfill({ cursor: next, since: plan.since, startedAt: plan.startedAt }),
      syncedUntil: currentSyncedUntil,
      done: false,
      contractIssue: page.done === true ? 'cursor_and_done' : null,
    };
  }
  return {
    cursor: null,
    syncedUntil: plan.startedAt,
    done: true,
    contractIssue: page.done === true ? null : 'neither_cursor_nor_done',
  };
}
