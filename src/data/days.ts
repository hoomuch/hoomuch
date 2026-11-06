/**
 * Local days for read models (SPEC §6). Owner: Data Plane.
 *
 * Days run midnight to midnight in the user's zone. `daily_revenue` is stored per UTC day, so
 * revenue from providers that report transactions is grouped here, at read time, from
 * `transactions` by local day. Providers that report daily totals (RevenueCat, Dodo Payments,
 * Adapty, Superwall, App Store Connect) can't be regrouped: their days are their own
 * (`ProviderMeta.dayZone`).
 */

import { PROVIDERS } from '../providers/registry';
import { addDays, dayNumberToKeySql, localDayNumberSql, localDaySql, zoneSegments, zonedDayStart } from '../lib/time';

/** Providers whose revenue is grouped from `transactions`, as a JSON list for `json_each`. */
const TRANSACTION_PROVIDERS = JSON.stringify(PROVIDERS.filter((p) => p.revenueHistory === 'transactions').map((p) => p.id));

type Sql = { sql: string; binds: number[] };

/**
 * The instants local days `fromDay`..`toDay` cover in `tz` ([lo, hi)), and the SQL for a column's
 * local day there: `day` as a 'YYYY-MM-DD' key, `dayNumber` as days since 1970 (group on this when
 * aggregating many rows, then format each group with `dayNumberToKeySql`).
 */
export function localDays(column: string, fromDay: string, toDay: string, tz: string): { lo: number; hi: number; day: Sql; dayNumber: Sql } {
  const lo = zonedDayStart(fromDay, tz);
  const hi = zonedDayStart(addDays(toDay, 1), tz);
  const segments = zoneSegments(lo, hi, tz);
  return { lo, hi, day: localDaySql(column, segments), dayNumber: localDayNumberSql(column, segments) };
}

/**
 * Revenue per connection, local day and currency for days `fromDay`..`toDay`: rows of
 * `{connection_id, day, currency, gross, refunds}`, exactly what `daily_revenue` holds for a UTC
 * user. Transactions are grouped like `recomputeDailyRevenue` does; provider totals come as stored.
 * `transactionsTo` ends the transaction providers' rows earlier, for a caller that reads the rest of
 * those days' transactions in a query of its own (the dashboard's products).
 */
export function revenueRowsStatement(
  db: D1Database,
  userId: string,
  tz: string,
  fromDay: string,
  toDay: string,
  transactionsTo: string = toDay,
): D1PreparedStatement {
  const { lo, hi, dayNumber } = localDays('t.occurred_at', fromDay, transactionsTo, tz);
  // Grouped on the day number and formatted once per group: a 'YYYY-MM-DD' per row costs more
  // than the whole range scan (the covering idx_transactions_cover serves the scan).
  return db
    .prepare(
      `SELECT connection_id, ${dayNumberToKeySql('dn')} AS day, currency, gross, refunds FROM (
         SELECT t.connection_id, ${dayNumber.sql} AS dn, t.currency,
                COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS gross,
                COALESCE(-SUM(CASE WHEN t.amount < 0 THEN t.amount END), 0) AS refunds
           FROM transactions t JOIN connections c ON c.id = t.connection_id
          WHERE c.user_id = ? AND c.provider IN (SELECT value FROM json_each(?)) AND t.occurred_at >= ? AND t.occurred_at < ?
          GROUP BY t.connection_id, dn, t.currency)
       UNION ALL
       SELECT d.connection_id, d.day, d.currency, d.gross, d.refunds
         FROM daily_revenue d JOIN connections c ON c.id = d.connection_id
        WHERE c.user_id = ? AND c.provider NOT IN (SELECT value FROM json_each(?)) AND d.day >= ? AND d.day <= ?`,
    )
    .bind(...dayNumber.binds, userId, TRANSACTION_PROVIDERS, lo, hi, userId, TRANSACTION_PROVIDERS, fromDay, toDay);
}
