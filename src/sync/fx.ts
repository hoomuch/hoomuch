/**
 * FX rates from frankfurter.dev v2, USD base. Owner: Data Plane. See SPEC §6 "Döviz".
 *
 * Source: Frankfurter's blended rates (central banks and official sources, 181 currencies), with
 * the ECB's own reference rate on top wherever the ECB publishes one: each fetch stores the blended
 * rates first and the ECB's over them.
 *
 * Storage: one `fx_rates` row per day holding the quotes dated that day (Frankfurter dates each
 * quote by its source's publication, so one fetch can fill two days). Rows merge with `json_patch`.
 * A row with no rates (`{}`) only marks how far back history has been fetched.
 *
 * Use (SPEC §6): revenue converts at the rate of its own day (`FxConverter.amountOn`), the newest
 * rate on or before it; MRR and everything "now" converts at the latest rates (`amount`, `map`).
 */

import { readTextBounded } from '../providers/http';
import { convertMinor, normalizeCurrency, type FxTable, type MoneyMap } from '../lib/money';
import { DAY, HOUR, addDays, dayKey } from '../lib/time';
import { BACKFILL_DAYS } from './aggregate';

export const FX_BASE = 'USD';
const FX_API = 'https://api.frankfurter.dev/v2/rates';
export const FX_URL = `${FX_API}?base=${FX_BASE}`;
export const FX_ECB_URL = `${FX_API}?base=${FX_BASE}&providers=ecb`;
/** Sources publish once per working day; one fetch per ~day is plenty. */
export const FX_MAX_AGE_MS = 20 * HOUR;
/**
 * How far back history is kept filled: the first sync's backfill plus the 90-day range's
 * previous period, with a margin for weekends and holidays before it.
 */
export const FX_HISTORY_DAYS = 2 * BACKFILL_DAYS + 20;
/** Days the "latest" table looks back for each currency (some sources publish weekly). */
const LATEST_LOOKBACK_DAYS = 10;
const FX_TIMEOUT_MS = 10_000;
const FX_RATE_MIN = 1e-6;
const FX_RATE_MAX = 1e7;
const FX_MAX_BYTES = 256 * 1024;
const FX_RANGE_MAX_BYTES = 4 * 1024 * 1024;
const CODE_RE = /^[A-Z]{3}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface FxRow {
  day: string;
  base: string;
  rates: string;
}

function validRate(code: string, n: unknown): n is number {
  // Units of CUR per 1 USD span roughly 0.3 (KWD) to ~1e5 (IRR, VND); the bounds leave wide margin.
  return CODE_RE.test(code) && typeof n === 'number' && Number.isFinite(n) && n >= FX_RATE_MIN && n <= FX_RATE_MAX;
}

function parseRates(json: string): Record<string, number> {
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      const code = normalizeCurrency(k);
      if (validRate(code, n)) out[code] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function rowToFx(row: Pick<FxRow, 'day' | 'base' | 'rates'> | null | undefined): FxTable | null {
  if (!row) return null;
  return { base: normalizeCurrency(row.base), day: row.day, rates: parseRates(row.rates) };
}

// ---------- reading ----------

/**
 * SQL for the rows behind the latest table: the last LATEST_LOOKBACK_DAYS days of rates. Exported
 * so read models can put it in their own `db.batch`; pass its results to `latestFx`.
 */
export const LATEST_FX_SQL = `SELECT day, base, rates FROM fx_rates
  WHERE day >= date((SELECT MAX(day) FROM fx_rates WHERE rates != '{}'), '-${LATEST_LOOKBACK_DAYS} days') AND rates != '{}'
  ORDER BY day`;

/** Each currency at its newest rate in `rows` (LATEST_FX_SQL results); `day` is the newest row's. */
export function latestFx(rows: readonly FxRow[] | null | undefined): FxTable | null {
  if (!rows || rows.length === 0) return null;
  const rates: Record<string, number> = {};
  let day = '';
  for (const r of [...rows].sort((a, b) => (a.day < b.day ? -1 : 1))) {
    const t = rowToFx(r);
    if (!t || t.base !== FX_BASE || Object.keys(t.rates).length === 0) continue;
    Object.assign(rates, t.rates);
    day = t.day;
  }
  return day ? { base: FX_BASE, day, rates } : null;
}

export async function getLatestFx(db: D1Database): Promise<FxTable | null> {
  const { results } = await db.prepare(LATEST_FX_SQL).all<FxRow>();
  return latestFx(results);
}

/**
 * One user's rate history for days `from`..`to` (plus a lookback for the first days), slimmed in
 * SQL to the currencies their revenue is in and their display currency, so a dashboard never
 * parses every currency of every day. Pass its results to `new FxHistory`.
 */
export function fxHistoryStatement(db: D1Database, userId: string, displayCurrency: string, from: string | null, to: string): D1PreparedStatement {
  return db
    .prepare(
      `WITH need(cur) AS (
         SELECT DISTINCT d.currency FROM daily_revenue d JOIN connections c ON c.id = d.connection_id WHERE c.user_id = ?1
         UNION SELECT ?2
       )
       SELECT f.day, f.base,
              (SELECT json_group_object(j.key, j.value) FROM json_each(f.rates) j WHERE j.key IN (SELECT cur FROM need)) AS rates
         FROM fx_rates f
        WHERE f.rates != '{}' AND (?3 IS NULL OR f.day >= ?3) AND f.day <= ?4
        ORDER BY f.day`,
    )
    .bind(userId, normalizeCurrency(displayCurrency), from === null ? null : addDays(from, -LATEST_LOOKBACK_DAYS), to);
}

/** Rates by day, for converting each day's revenue at that day's rate. */
export class FxHistory {
  /** Per currency: days ascending, with the rate on each. */
  private readonly series = new Map<string, { days: string[]; rates: number[] }>();

  constructor(rows: readonly FxRow[] | null | undefined) {
    for (const r of [...(rows ?? [])].sort((a, b) => (a.day < b.day ? -1 : 1))) {
      const t = rowToFx(r);
      if (!t || t.base !== FX_BASE) continue;
      for (const [code, rate] of Object.entries(t.rates)) {
        let s = this.series.get(code);
        if (!s) this.series.set(code, (s = { days: [], rates: [] }));
        s.days.push(t.day);
        s.rates.push(rate);
      }
    }
  }

  /**
   * Units of `currency` per USD on `day`: the newest rate on or before it, else (a day before this
   * currency's history starts) its oldest rate. Null when there's no rate for it at all.
   */
  rateOn(currency: string, day: string): number | null {
    const code = normalizeCurrency(currency);
    if (code === FX_BASE) return 1;
    const s = this.series.get(code);
    if (!s) return null;
    let lo = 0;
    let hi = s.days.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.days[mid]! <= day) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return s.rates[found === -1 ? 0 : found]!;
  }
}

// ---------- fetching ----------

/**
 * Validates a frankfurter.dev v2 `/rates` payload (`[{date, base, quote, rate}]`) and groups it by
 * date. Quotes dated after tomorrow (UTC) are rejected, so one bogus date can't pin the "latest"
 * table; implausible rates are dropped.
 */
export function parseFrankfurter(body: unknown, now: number = Date.now()): FxTable[] {
  if (!Array.isArray(body)) throw new Error('fx: unexpected payload');
  const tomorrow = dayKey(now + DAY);
  const byDay = new Map<string, Record<string, number>>();
  for (const item of body) {
    if (!item || typeof item !== 'object') continue;
    const q = item as Record<string, unknown>;
    const date = typeof q['date'] === 'string' && DAY_RE.test(q['date']) ? q['date'] : '';
    const base = typeof q['base'] === 'string' ? normalizeCurrency(q['base']) : '';
    const quote = typeof q['quote'] === 'string' ? normalizeCurrency(q['quote']) : '';
    if (base !== FX_BASE || !date) throw new Error('fx: unexpected payload');
    if (date > tomorrow) throw new Error('fx: future-dated payload');
    if (!validRate(quote, q['rate'])) continue;
    let rates = byDay.get(date);
    if (!rates) byDay.set(date, (rates = {}));
    rates[quote] = q['rate'];
  }
  if (byDay.size === 0) throw new Error('fx: unexpected payload');
  return [...byDay].map(([day, rates]) => ({ base: FX_BASE, day, rates })).sort((a, b) => (a.day < b.day ? -1 : 1));
}

async function fetchTables(fetchImpl: typeof fetch, url: string, maxBytes: number, now: number): Promise<FxTable[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`fx: HTTP ${res.status}`);
    // A third party's body: never buffer it unbounded.
    body = JSON.parse(await readTextBounded(res, maxBytes)) as unknown;
  } finally {
    clearTimeout(timer);
  }
  return parseFrankfurter(body, now);
}

/** Merges tables into `fx_rates`: a day's existing quotes are kept, the new ones win. */
function storeStatements(db: D1Database, tables: readonly FxTable[], now: number): D1PreparedStatement[] {
  return tables.map((t) =>
    db
      .prepare(
        `INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET base = excluded.base, rates = json_patch(fx_rates.rates, excluded.rates),
                                        fetched_at = excluded.fetched_at`,
      )
      .bind(t.day, t.base, JSON.stringify(t.rates), now),
  );
}

function logFailure(event: string, err: unknown): void {
  console.error(JSON.stringify({ event, message: err instanceof Error ? err.message : 'unknown' }));
}

/**
 * Fetches the latest rates (blended, then the ECB's over them) and stores them. Throws when the
 * blended rates can't be had; the ECB's are best effort.
 */
export async function refreshFx(db: D1Database, fetchImpl: typeof fetch, now: number): Promise<FxTable> {
  const blended = await fetchTables(fetchImpl, FX_URL, FX_MAX_BYTES, now);
  let ecb: FxTable[] = [];
  try {
    ecb = await fetchTables(fetchImpl, FX_ECB_URL, FX_MAX_BYTES, now);
  } catch (err) {
    logFailure('fx_ecb_failed', err);
  }
  await db.batch([...storeStatements(db, blended, now), ...storeStatements(db, ecb, now)]);
  return latestFx([...blended, ...ecb].map((t) => ({ day: t.day, base: t.base, rates: JSON.stringify(t.rates) })))!;
}

export type FxRefreshOutcome = 'fresh' | 'refreshed' | 'failed';

/**
 * Refreshes when the newest row was fetched more than `maxAgeMs` ago (or there is none).
 * Never throws: FX trouble must not block syncing.
 */
export async function refreshFxIfStale(
  db: D1Database,
  fetchImpl: typeof fetch,
  now: number,
  maxAgeMs: number = FX_MAX_AGE_MS,
): Promise<FxRefreshOutcome> {
  try {
    const last = await db.prepare(`SELECT MAX(fetched_at) AS t FROM fx_rates WHERE rates != '{}'`).first<{ t: number | null }>();
    if (last?.t != null && now - last.t < maxAgeMs) return 'fresh';
    await refreshFx(db, fetchImpl, now);
    return 'refreshed';
  } catch (err) {
    logFailure('fx_refresh_failed', err);
    return 'failed';
  }
}

/** Fetches rates only if the table is empty (first sync on a fresh install). Never throws. */
export async function ensureFx(db: D1Database, fetchImpl: typeof fetch, now: number): Promise<FxRefreshOutcome> {
  return refreshFxIfStale(db, fetchImpl, now, Number.POSITIVE_INFINITY);
}

export type FxHistoryOutcome = 'covered' | 'filled' | 'nothing_to_fill' | 'failed';

/**
 * Makes sure rates reach back FX_HISTORY_DAYS, for the currencies revenue is stored in and the
 * display currencies: once, after an install or an upgrade (one ranged request, plus the ECB's).
 * Afterwards the daily refresh keeps every day filled. Never throws. A currency that first appears
 * later converts its earlier days at its oldest stored rate (FxHistory.rateOn).
 */
export async function ensureFxHistory(db: D1Database, fetchImpl: typeof fetch, now: number): Promise<FxHistoryOutcome> {
  try {
    const target = addDays(dayKey(now), -FX_HISTORY_DAYS);
    const oldest = await db.prepare('SELECT MIN(day) AS d FROM fx_rates').first<{ d: string | null }>();
    if (oldest?.d && oldest.d <= target) return 'covered';
    const latest = await getLatestFx(db);
    if (!latest) return 'failed'; // the daily refresh hasn't landed yet; try on the next tick
    const { results } = await db
      .prepare(
        `SELECT DISTINCT currency AS c FROM daily_revenue
         UNION SELECT DISTINCT base_currency FROM users`,
      )
      .all<{ c: string }>();
    // Only currencies Frankfurter knows: one unknown quote fails the whole request (422).
    const quotes = [...new Set((results ?? []).map((r) => normalizeCurrency(r.c)))].filter((c) => c !== FX_BASE && c in latest.rates).sort();
    if (quotes.length === 0) return 'nothing_to_fill';
    const to = oldest?.d ? addDays(oldest.d, -1) : dayKey(now);
    const range = `&from=${target}&to=${to}&quotes=${quotes.join(',')}`;
    const blended = await fetchTables(fetchImpl, FX_URL + range, FX_RANGE_MAX_BYTES, now);
    let ecb: FxTable[] = [];
    try {
      ecb = await fetchTables(fetchImpl, FX_ECB_URL + range, FX_RANGE_MAX_BYTES, now);
    } catch (err) {
      logFailure('fx_ecb_history_failed', err);
    }
    // The empty row at `target` records that history was fetched back to there, even when no
    // source had a rate that early, so this runs once.
    const marker = { base: FX_BASE, day: target, rates: {} };
    await db.batch([...storeStatements(db, [marker, ...blended], now), ...storeStatements(db, ecb, now)]);
    return 'filled';
  } catch (err) {
    logFailure('fx_history_failed', err);
    return 'failed';
  }
}

// ---------- converting ----------

/**
 * Converts amounts into one display currency (read models). `amount` and `map` use the latest
 * rates (MRR, anything "now"); `amountOn` uses the rate of a given day (revenue), falling back to
 * the latest when there's no history for a currency. Unconvertible currencies count as 0 and are
 * collected in `missing`; `used` records whether a latest-rate conversion happened (so the latest
 * table's date is only shown when relevant).
 */
export class FxConverter {
  readonly missing = new Set<string>();
  used = false;
  /** Whether a day's-rate conversion (`amountOn`) between two currencies happened. */
  usedDaily = false;
  readonly to: string;

  constructor(
    to: string,
    readonly fx: FxTable | null,
    readonly history: FxHistory | null = null,
  ) {
    this.to = normalizeCurrency(to);
  }

  amount(minor: number, currency: string): number {
    if (minor === 0) return 0;
    const from = normalizeCurrency(currency);
    if (from === this.to) return minor;
    const v = this.fx ? convertMinor(minor, from, this.to, this.fx) : null;
    if (v === null) {
      this.missing.add(from);
      return 0;
    }
    this.used = true;
    return v;
  }

  /** `minor` of `currency` received on `day` ('YYYY-MM-DD'), at that day's rate. */
  amountOn(minor: number, currency: string, day: string): number {
    if (minor === 0) return 0;
    const from = normalizeCurrency(currency);
    if (from === this.to) return minor;
    const v = this.tryAmountOn(minor, from, day);
    if (v === null) {
      this.missing.add(from);
      return 0;
    }
    this.usedDaily = true;
    return v;
  }

  /** Converts a single amount, or null when no rate exists (doesn't touch `missing`). */
  tryAmount(minor: number, currency: string): number | null {
    const from = normalizeCurrency(currency);
    if (from === this.to) return minor;
    return this.fx ? convertMinor(minor, from, this.to, this.fx) : null;
  }

  /** `tryAmount` at the rate of `day`. */
  tryAmountOn(minor: number, currency: string, day: string): number | null {
    const from = normalizeCurrency(currency);
    if (from === this.to) return minor;
    const rf = this.history?.rateOn(from, day) ?? this.fx?.rates[from] ?? (from === FX_BASE ? 1 : null);
    const rt = this.history?.rateOn(this.to, day) ?? this.fx?.rates[this.to] ?? (this.to === FX_BASE ? 1 : null);
    if (rf == null || rt == null) return null;
    return convertMinor(minor, from, this.to, { base: FX_BASE, day, rates: { [from]: rf, [this.to]: rt } });
  }

  map(m: MoneyMap): number {
    let total = 0;
    for (const [cur, amt] of Object.entries(m)) total += this.amount(amt, cur);
    return total;
  }
}
