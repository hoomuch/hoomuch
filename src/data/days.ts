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
import { addDays, localDaySql, zoneSegments, zonedDayStart } from '../lib/time';

/** Providers whose revenue is grouped from `transactions`, as a JSON list for `json_each`. */
const TRANSACTION_PROVIDERS = JSON.stringify(PROVIDERS.filter((p) => p.revenueHistory === 'transactions').map((p) => p.id));

/** The instants local days `fromDay`..`toDay` cover in `tz` ([lo, hi)), and the SQL for a column's local day there. */
export function localDays(column: string, fromDay: string, toDay: string, tz: string): { lo: number; hi: number; day: { sql: string; binds: number[] } } {
  const lo = zonedDayStart(fromDay, tz);
  const hi = zonedDayStart(addDays(toDay, 1), tz);
  return { lo, hi, day: localDaySql(column, zoneSegments(lo, hi, tz)) };
}

/**
 * Revenue per connection, local day and currency for days `fromDay`..`toDay`: rows of
 * `{connection_id, day, currency, gross, refunds}`, exactly what `daily_revenue` holds for a UTC
 * user. Transactions are grouped like `recomputeDailyRevenue` does; provider totals come as stored.
 */
export function revenueRowsStatement(db: D1Database, userId: string, tz: string, fromDay: string, toDay: string): D1PreparedStatement {
  const { lo, hi, day } = localDays('t.occurred_at', fromDay, toDay, tz);
  return db
    .prepare(
      `SELECT t.connection_id, ${day.sql} AS day, t.currency,
              COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS gross,
              COALESCE(-SUM(CASE WHEN t.amount < 0 THEN t.amount END), 0) AS refunds
         FROM transactions t JOIN connections c ON c.id = t.connection_id
        WHERE c.user_id = ? AND c.provider IN (SELECT value FROM json_each(?)) AND t.occurred_at >= ? AND t.occurred_at < ?
        GROUP BY t.connection_id, day, t.currency
       UNION ALL
       SELECT d.connection_id, d.day, d.currency, d.gross, d.refunds
         FROM daily_revenue d JOIN connections c ON c.id = d.connection_id
        WHERE c.user_id = ? AND c.provider NOT IN (SELECT value FROM json_each(?)) AND d.day >= ? AND d.day <= ?`,
    )
    .bind(...day.binds, userId, TRANSACTION_PROVIDERS, lo, hi, userId, TRANSACTION_PROVIDERS, fromDay, toDay);
}
