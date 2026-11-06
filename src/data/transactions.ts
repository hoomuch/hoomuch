/**
 * Transactions read model. Owner: Data Plane. Signature is part of the contract (SPEC §9.1).
 * One D1 round trip: the page (+1 row to detect `hasMore`), the latest rates and the rate history
 * of the page's own days and currencies, in one batch.
 *
 * The page merges every connection's transactions newest first. Sorting all of them for 51 rows
 * costs as much as the account is old (580k rows: ~200 ms), so each connection first finds the
 * time of its own `offset + pageSize + 1`-th newest row with one seek in idx_transactions_cover.
 * Only rows from there on can be on the page, so the sort sees at most that many per connection.
 */

import type { Bindings, SessionUser } from '../env';
import { normalizeCurrency } from '../lib/money';
import { addDays, DAY, UTC, zonedDayKey, zonedDayStart } from '../lib/time';
import { getProviderMeta } from '../providers/registry';
import type { ProviderId } from '../providers/types';
import { FxConverter, FxHistory, LATEST_FX_SQL, LATEST_LOOKBACK_DAYS, latestFx, slimRatesSql, type FxRow } from '../sync/fx';
import { rowsOf, type TransactionPage, type TransactionRow } from './types';

export const TRANSACTIONS_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Deep OFFSETs get slow; nobody pages 2,000 pages into a list. */
const MAX_PAGE = 2_000;

interface Row {
  connection_id: string;
  connection_name: string;
  provider: ProviderId;
  external_id: string;
  occurred_at: number;
  type: 'charge' | 'refund';
  amount: number;
  currency: string;
  description: string | null;
}

/**
 * A place in the list: the row a page ends (or starts) on. "Next" links carry the last row's as
 * `?before=`, "Previous" links the first row's as `?after=`, so a page deep in the list costs what
 * the first one does (no OFFSET), and new transactions arriving between two clicks don't shift a
 * row onto two pages. A plain `?page=` still works, by offset.
 */
export interface TransactionCursor {
  at: number;
  connectionId: string;
  externalId: string;
}

/** `occurred_at~connection id~external id`: connection ids never contain `~`, external ids may. */
export function encodeCursor(c: TransactionCursor): string {
  return `${c.at}~${c.connectionId}~${c.externalId}`;
}

/** A cursor from a query string, or null for anything malformed (ignored, like other junk). */
export function parseCursor(v: string | undefined | null): TransactionCursor | null {
  const m = v ? /^(\d{1,16})~([^~]{1,64})~([\s\S]{1,512})$/.exec(v) : null;
  if (!m) return null;
  const at = Number(m[1]);
  return Number.isSafeInteger(at) ? { at, connectionId: m[2]!, externalId: m[3]! } : null;
}

export async function listTransactions(
  env: Bindings,
  user: SessionUser,
  /**
   * `day`: one of the user's local days ('YYYY-MM-DD', already validated), or null for every day.
   * `before` / `after`: read the page past this row, older / newer (`before` wins); `page` then only
   * labels it.
   */
  opts: {
    provider: ProviderId | null;
    page: number;
    pageSize?: number;
    day?: string | null;
    before?: TransactionCursor | null;
    after?: TransactionCursor | null;
  },
): Promise<TransactionPage> {
  const currency = normalizeCurrency(user.baseCurrency || 'USD');
  const tz = user.timeZone || UTC;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize ?? TRANSACTIONS_PAGE_SIZE)));
  const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number.isFinite(opts.page) ? opts.page : 1)));
  const cursor = opts.before ?? opts.after ?? null;
  // Newer rows than `after`, read oldest first and turned around; everything else reads older.
  const newer = !opts.before && !!opts.after;
  const offset = cursor ? 0 : (page - 1) * pageSize;
  const db = env.DB;

  const day = opts.day ?? null;
  // The user's local day (SPEC §6), or all of time.
  const span = day ? [zonedDayStart(day, tz), zonedDayStart(addDays(day, 1), tz)] : null;
  const inSpan = (col: string) => (span ? ` AND ${col} >= ? AND ${col} < ?` : '');
  const spanBinds = span ?? [];
  // Rows past the cursor in the list's order (occurred_at DESC, connection id ASC, external id
  // DESC), or its reverse. The bare bound on occurred_at is what lets the index seek.
  const pastCursor = (row: string, conn: string) =>
    !cursor
      ? ''
      : newer
        ? ` AND ${row}.occurred_at >= ? AND (${row}.occurred_at > ? OR ${conn} < ? OR (${conn} = ? AND ${row}.external_id > ?))`
        : ` AND ${row}.occurred_at <= ? AND (${row}.occurred_at < ? OR ${conn} > ? OR (${conn} = ? AND ${row}.external_id < ?))`;
  const cursorBinds = cursor ? [cursor.at, cursor.at, cursor.connectionId, cursor.connectionId, cursor.externalId] : [];
  const conns = opts.provider ? 'user_id = ? AND provider = ?' : 'user_id = ?';
  const connBinds = opts.provider ? [user.id, opts.provider] : [user.id];
  const dir = newer ? 'ASC' : 'DESC';
  // `since`: the time of the connection's (offset + pageSize + 1)-th row in reading order, or null
  // when it has fewer; its rows beyond that can't reach the page. Ties at `since` are all kept.
  const withConns = `WITH conns AS MATERIALIZED (
      SELECT id, name, provider,
             (SELECT x.occurred_at FROM transactions x
               WHERE x.connection_id = connections.id${inSpan('x.occurred_at')}${pastCursor('x', 'connections.id')}
               ORDER BY x.occurred_at ${dir} LIMIT 1 OFFSET ?) AS since
        FROM connections WHERE ${conns})`;
  const pageSql = `SELECT t.connection_id, c.name AS connection_name, c.provider, t.external_id, t.occurred_at,
                          t.type, t.amount, t.currency, t.description
                     FROM conns c JOIN transactions t ON t.connection_id = c.id
                          AND t.occurred_at ${newer ? '<=' : '>='} COALESCE(c.since, ?)${inSpan('t.occurred_at')}${pastCursor('t', 't.connection_id')}
                    ORDER BY ${newer ? 't.occurred_at ASC, t.connection_id DESC, t.external_id ASC' : 't.occurred_at DESC, t.connection_id, t.external_id DESC'}
                    LIMIT ? OFFSET ?`;
  const pageBinds = [
    ...spanBinds, ...cursorBinds, offset + pageSize, ...connBinds,
    // Without a `since`, the span's own edge (else the scan would seek from the very first row).
    newer ? (span ? span[1]! : Number.MAX_SAFE_INTEGER) : (span ? span[0]! : -Number.MAX_SAFE_INTEGER),
    ...spanBinds, ...cursorBinds, pageSize + 1, offset,
  ];
  const [pageR, fxR, histR] = await db.batch([
    db.prepare(`${withConns} ${pageSql}`).bind(...pageBinds),
    db.prepare(LATEST_FX_SQL),
    // The rates of the page's currencies on its days, the lookback before them, and the oldest
    // stored day: FxHistory.rateOn falls back to it for a day older than every stored rate.
    db
      .prepare(
        `${withConns},
         page AS MATERIALIZED (${pageSql}),
         need(cur) AS MATERIALIZED (SELECT currency FROM page UNION SELECT ?),
         days(day) AS (
           SELECT f.day FROM fx_rates f, (SELECT MIN(occurred_at) AS lo, MAX(occurred_at) AS hi FROM page) p
            WHERE f.day >= date(p.lo / 1000 - ?, 'unixepoch') AND f.day <= date(p.hi / 1000 + ?, 'unixepoch')
           UNION SELECT MIN(day) FROM fx_rates WHERE rates != '{}'
         )
         SELECT f.day, f.base, ${slimRatesSql('f.rates', 'need')} AS rates
           FROM days JOIN fx_rates f ON f.day = days.day
          WHERE f.rates != '{}'
          ORDER BY f.day`,
      )
      // A local day is within a day of the UTC one its instant falls on.
      .bind(...pageBinds, currency, ((LATEST_LOOKBACK_DAYS + 1) * DAY) / 1000, DAY / 1000),
  ]);

  const read = rowsOf<Row>(pageR);
  // Newer pages were read nearest-first: the rows next to the cursor, then turned the list's way.
  const rows = newer ? read.slice(0, pageSize).reverse() : read.slice(0, pageSize);
  const cv = new FxConverter(currency, latestFx(rowsOf<FxRow>(fxR)), new FxHistory(rowsOf<FxRow>(histR)));
  const items: TransactionRow[] = rows.map((r) => {
    const meta = getProviderMeta(r.provider);
    const original = normalizeCurrency(r.currency);
    return {
      connectionId: r.connection_id,
      connectionName: r.connection_name,
      provider: r.provider,
      color: meta.color,
      dotClass: meta.dotClass,
      externalId: r.external_id,
      occurredAt: r.occurred_at,
      type: r.type,
      amount: r.amount,
      originalCurrency: original,
      // At the rate of the day the money moved (SPEC §6).
      displayAmount: cv.tryAmountOn(r.amount, original, zonedDayKey(r.occurred_at, tz)),
      description: r.description,
    };
  });

  // A page read newer than a cursor has the cursor's own row after it.
  const hasMore = newer ? items.length > 0 : read.length > pageSize;
  const at = (i: TransactionRow) => encodeCursor({ at: i.occurredAt, connectionId: i.connectionId, externalId: i.externalId });
  const first = items[0];
  const last = items[items.length - 1];
  return {
    currency,
    provider: opts.provider,
    day,
    items,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && last ? at(last) : null,
    prevCursor: page > 1 && first ? at(first) : null,
  };
}
