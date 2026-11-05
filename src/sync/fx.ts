/**
 * FX rates from frankfurter.dev (ECB reference rates), USD base. Owner: Data Plane.
 *
 * Stored one row per ECB day in `fx_rates`; refreshed at most once per FX_MAX_AGE_MS.
 * Read models call `getLatestFx` and convert at display time with today's rate (SPEC §6).
 */

import { convertMinor, normalizeCurrency, type FxTable, type MoneyMap } from '../lib/money';
import { HOUR } from '../lib/time';

export const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD';
export const FX_BASE = 'USD';
/** ECB publishes once per working day (~16:00 CET); one fetch per ~day is plenty. */
export const FX_MAX_AGE_MS = 20 * HOUR;
const FX_TIMEOUT_MS = 10_000;

interface FxRow {
  day: string;
  base: string;
  rates: string;
  fetched_at: number;
}

function parseRates(json: string): Record<string, number> {
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[normalizeCurrency(k)] = n;
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

/** SQL for the newest FX row — exported so read models can put it in their own `db.batch`. */
export const LATEST_FX_SQL = 'SELECT day, base, rates, fetched_at FROM fx_rates ORDER BY day DESC LIMIT 1';

export async function getLatestFx(db: D1Database): Promise<FxTable | null> {
  return rowToFx(await db.prepare(LATEST_FX_SQL).first<FxRow>());
}

/** Validates a frankfurter.dev `/latest` payload. A table dated after tomorrow (UTC) is rejected. */
export function parseFrankfurter(body: unknown, now: number = Date.now()): FxTable {
  if (!body || typeof body !== 'object') throw new Error('fx: unexpected payload');
  const b = body as Record<string, unknown>;
  const base = typeof b['base'] === 'string' ? normalizeCurrency(b['base']) : '';
  const day = typeof b['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b['date']) ? b['date'] : '';
  const rates = b['rates'] && typeof b['rates'] === 'object' ? parseRates(JSON.stringify(b['rates'])) : {};
  if (base !== FX_BASE || !day || Object.keys(rates).length === 0) throw new Error('fx: unexpected payload');
  if (day > new Date(now + 86_400_000).toISOString().slice(0, 10)) throw new Error('fx: future-dated payload');
  return { base, day, rates };
}

/** Fetches today's rates and upserts them. Throws on network / payload errors. */
export async function refreshFx(db: D1Database, fetchImpl: typeof fetch, now: number): Promise<FxTable> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetchImpl(FX_URL, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`fx: HTTP ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const fx = parseFrankfurter(body, now);
  await db
    .prepare(
      `INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET base = excluded.base, rates = excluded.rates, fetched_at = excluded.fetched_at`,
    )
    .bind(fx.day, fx.base, JSON.stringify(fx.rates), now)
    .run();
  return fx;
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
    const last = await db.prepare('SELECT MAX(fetched_at) AS t FROM fx_rates').first<{ t: number | null }>();
    if (last?.t != null && now - last.t < maxAgeMs) return 'fresh';
    await refreshFx(db, fetchImpl, now);
    return 'refreshed';
  } catch (err) {
    console.error(JSON.stringify({ event: 'fx_refresh_failed', message: err instanceof Error ? err.message : 'unknown' }));
    return 'failed';
  }
}

/** Fetches rates only if the table is empty (first sync on a fresh install). Never throws. */
export async function ensureFx(db: D1Database, fetchImpl: typeof fetch, now: number): Promise<FxRefreshOutcome> {
  return refreshFxIfStale(db, fetchImpl, now, Number.POSITIVE_INFINITY);
}

/**
 * Converts amounts into one display currency with a fixed FX table (read models).
 * Unconvertible currencies count as 0 and are collected in `missing`; `used` records whether
 * any cross-currency conversion actually happened (so `fx.asOf` is only shown when relevant).
 */
export class FxConverter {
  readonly missing = new Set<string>();
  used = false;
  readonly to: string;

  constructor(
    to: string,
    readonly fx: FxTable | null,
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

  /** Converts a single amount, or null when no rate exists (doesn't touch `missing`). */
  tryAmount(minor: number, currency: string): number | null {
    const from = normalizeCurrency(currency);
    if (from === this.to) return minor;
    return this.fx ? convertMinor(minor, from, this.to, this.fx) : null;
  }

  map(m: MoneyMap): number {
    let total = 0;
    for (const [cur, amt] of Object.entries(m)) total += this.amount(amt, cur);
    return total;
  }
}
