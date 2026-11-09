/**
 * Dashboard read model. Owner: Data Plane. Signature is part of the contract (SPEC §9.1).
 *
 * One D1 round trip (a single `db.batch`), no provider calls (SPEC N-02). Every amount is
 * converted into the user's display currency: revenue at the rate of its own day, MRR at the
 * latest; currencies without a rate are left out of totals and reported in `fx.missing`
 * (SPEC §6 "Döviz").
 */

import type { Bindings, SessionUser } from '../env';
import { connectionsStatement, type ConnectionView } from '../db/queries';
import { normalizeCurrency, parseMoneyMap } from '../lib/money';
import { countsPublicly } from '../lib/public-pages';
import { addDays, dayNumberToKeySql, dayRange, UTC, zonedDayKey } from '../lib/time';
import { getProviderMeta } from '../providers/registry';
import type { ProviderId } from '../providers/types';
import { STRIPE_PRODUCTS_WARNING } from '../providers/warnings';
import { BACKFILL_DAYS, cleanProductMrr, parseStoredWarnings } from '../sync/aggregate';
import type { FxTable } from '../lib/money';
import { FxConverter, FxHistory, LATEST_FX_SQL, fxHistoryStatement, latestFx, type FxRow } from '../sync/fx';
import { calendarQuery } from './calendar';
import { toSummary } from './connections';
import { localDays, revenueRowsStatement } from './days';
import {
  rowsOf,
  type BreakdownRow,
  type CalendarMonth,
  type ConnectionSummary,
  type DashboardData,
  type Kpi,
  lastRevenueDay,
  type MrrDay,
  type ProductBreakdown,
  type ProductMrrBreakdown,
  type ProductMrrRow,
  type ProductRow,
  PUBLIC_SERIES_DAYS,
  type PublicProductStats,
  revenueInSteps,
  revenueStep,
  type RangeDays,
  type ReadModelQuery,
  type RevenueDay,
} from './types';

interface SnapRow {
  connection_id: string;
  day: string;
  mrr: string;
  active_subscriptions: number;
  active_trials: number | null;
  revenue_period?: string | null;
  revenue_period_days?: number | null;
  /** Latest snapshots only: ProductMrr[] JSON, or null. */
  mrr_by_product?: string | null;
  /** Latest snapshots only: string[] JSON, or null (`MetricsSnapshot.warnings`). */
  warnings?: string | null;
}

interface RevRow {
  connection_id: string;
  day: string;
  currency: string;
  gross: number;
  refunds: number;
}

/** A product row of the dashboard's window, with the gross and refunds its revenue rows are summed from. */
interface ProductDayRow extends ProductSumRow {
  gross: number;
  refunds: number;
}

interface ProductSumRow {
  connection_id: string;
  /** Null when the transactions had no product name. */
  product: string | null;
  currency: string;
  /** The user's local day the transactions occurred on (each day converts at its own rate). */
  day: string;
  net: number;
  charges: number;
}

/** Product rows the dashboard lists before rolling the rest into "N more products". */
export const PRODUCT_ROWS = 10;

export function kpi(value: number, previous: number | null): Kpi {
  const deltaPct = previous === null || previous === 0 ? null : ((value - previous) / Math.abs(previous)) * 100;
  return { value, previous, deltaPct };
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

export async function getDashboardData(env: Bindings, user: SessionUser, rangeDays: RangeDays): Promise<DashboardData> {
  const db = env.DB;
  const q = dashboardQuery(db, user, rangeDays, Date.now());
  const [connsR, fxR, ...results] = await db.batch([connectionsStatement(db, user.id), db.prepare(LATEST_FX_SQL), ...q.statements]);
  return q.build(results, rowsOf<ConnectionView>(connsR), rowsOf<FxRow>(fxR));
}

/**
 * Everything GET /dashboard shows, in one D1 round trip: the dashboard, the calendar month and the
 * connection list, reading the connections and the latest rates once for all three.
 */
export async function getDashboardPage(
  env: Bindings,
  user: SessionUser,
  rangeDays: RangeDays,
  month: string,
): Promise<{ data: DashboardData; calendar: CalendarMonth; connections: ConnectionSummary[] }> {
  const db = env.DB;
  const now = Date.now();
  const dashboard = dashboardQuery(db, user, rangeDays, now);
  const calendar = calendarQuery(db, user, month, now);
  const [connsR, fxR, ...results] = await db.batch([
    connectionsStatement(db, user.id),
    db.prepare(LATEST_FX_SQL),
    ...dashboard.statements,
    ...calendar.statements,
  ]);
  const conns = rowsOf<ConnectionView>(connsR);
  const fxRows = rowsOf<FxRow>(fxR);
  const split = dashboard.statements.length;
  return {
    data: dashboard.build(results.slice(0, split), conns, fxRows),
    calendar: calendar.build(results.slice(split), conns, fxRows),
    connections: conns.map(toSummary),
  };
}

/**
 * The dashboard as statements for a page's batch (ReadModelQuery); getDashboardData runs it alone.
 * `include` narrows it to some of the user's connections (a public product, productStatsQuery):
 * the statements stay the dashboard's, and `build` drops the other connections' rows.
 * `dailyRevenue` keeps the revenue series a day per entry over the year too (productStatsQuery
 * stores both); the page's own year is in weeks.
 */
function dashboardQuery(
  db: D1Database,
  user: Pick<SessionUser, 'id' | 'baseCurrency' | 'timeZone'>,
  rangeDays: RangeDays,
  now: number,
  include?: (c: ConnectionView) => boolean,
  opts: { dailyRevenue?: boolean } = {},
): ReadModelQuery<DashboardData> {
  const currency = normalizeCurrency(user.baseCurrency || 'USD');
  // Days run midnight to midnight in the user's zone (SPEC §6).
  const tz = user.timeZone || UTC;
  const today = zonedDayKey(now, tz);
  const start = addDays(today, -(rangeDays - 1));
  const prevStart = addDays(start, -rangeDays);

  const SNAP_COLS = 's.connection_id, s.day, s.mrr, s.active_subscriptions, s.active_trials';
  const productDays = localDays('t.occurred_at', start, today, tz);
  return {
    // Snapshots are keyed by the owner's local day, so after a move west the last zone's "tomorrow"
    // can be on file: every snapshot read stops at today. "Latest" and "before" find each
    // connection's day once (correlated on the connection, a seek in the primary key), so they cost
    // the same with two years of history as with two days.
    statements: [
      db
        .prepare(
          `SELECT ${SNAP_COLS} FROM snapshots s JOIN connections c ON c.id = s.connection_id
            WHERE c.user_id = ? AND s.day >= ? AND s.day <= ? ORDER BY s.day ASC`,
        )
        .bind(user.id, start, today),
      db
        .prepare(
          `SELECT ${SNAP_COLS}, s.revenue_period, s.revenue_period_days, s.mrr_by_product, s.warnings FROM connections c
             JOIN snapshots s ON s.connection_id = c.id
                             AND s.day = (SELECT MAX(x.day) FROM snapshots x WHERE x.connection_id = c.id AND x.day <= ?2)
            WHERE c.user_id = ?1`,
        )
        .bind(user.id, today),
      db
        .prepare(
          `SELECT ${SNAP_COLS} FROM connections c
             JOIN snapshots s ON s.connection_id = c.id
                             AND s.day = (SELECT MAX(x.day) FROM snapshots x WHERE x.connection_id = c.id AND x.day < ?2)
            WHERE c.user_id = ?1`,
        )
        .bind(user.id, start),
      // Revenue for the comparison window, and the daily-total providers' revenue for both. The
      // transaction providers' revenue in this window comes from the product rows below: those
      // days' transactions are read once, not once for revenue and again for products.
      revenueRowsStatement(db, user.id, tz, prevStart, today, addDays(start, -1)),
      // This window (local days start..today), per product, currency and day: each day converts at
      // its own rate, like the revenue KPI. Grouped on the day number and formatted once per group,
      // like revenueRowsStatement.
      db
        .prepare(
          `SELECT connection_id, product, currency, ${dayNumberToKeySql('dn')} AS day, net, charges, gross, refunds FROM (
             SELECT t.connection_id, NULLIF(TRIM(t.description), '') AS product, t.currency,
                    ${productDays.dayNumber.sql} AS dn,
                    SUM(t.amount) AS net, SUM(CASE WHEN t.type = 'charge' THEN 1 ELSE 0 END) AS charges,
                    COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS gross,
                    COALESCE(-SUM(CASE WHEN t.amount < 0 THEN t.amount END), 0) AS refunds
               FROM transactions t JOIN connections c ON c.id = t.connection_id
              WHERE c.user_id = ? AND t.occurred_at >= ? AND t.occurred_at < ?
              GROUP BY t.connection_id, product, t.currency, dn)`,
        )
        .bind(...productDays.dayNumber.binds, user.id, productDays.lo, productDays.hi),
      fxHistoryStatement(db, user.id, currency, prevStart, today),
    ],
    build: ([windowR, latestR, beforeR, revR, productR, histR], allConns, fxRows) => {
      const conns = include ? allConns.filter(include) : allConns;
      const ids = include ? new Set(conns.map((c) => c.id)) : null;
      const own = <T extends { connection_id: string }>(rows: T[]): T[] => (ids ? rows.filter((r) => ids.has(r.connection_id)) : rows);
      const productRows = own(rowsOf<ProductDayRow>(productR));
      const fx = latestFx(fxRows);
      return buildDashboard({
        now,
        currency,
        tz,
        today,
        start,
        prevStart,
        rangeDays,
        revenueStepDays: opts.dailyRevenue ? 1 : revenueStep(rangeDays),
        conns,
        windowSnaps: own(rowsOf<SnapRow>(windowR)),
        latestSnaps: own(rowsOf<SnapRow>(latestR)),
        beforeSnaps: own(rowsOf<SnapRow>(beforeR)),
        revRows: [...own(rowsOf<RevRow>(revR)), ...revenueFromProducts(productRows, conns)],
        productRows,
        fx,
        // Revenue at each day's rate (amountOn), MRR at the latest (amount / map): SPEC §6.
        cv: new FxConverter(currency, fx, new FxHistory(rowsOf<FxRow>(histR))),
      });
    },
  };
}

/**
 * A published product's figures (SPEC F-21): the dashboard narrowed to the product's connections
 * that count publicly, in USD, over 30 days, plus the chart history over PUBLIC_SERIES_DAYS. Null when
 * no connection counts or none has a snapshot yet. Run when a sync finishes, not per request: the
 * public page reads the stored result. One D1 round trip.
 */
export async function getProductStats(
  db: D1Database,
  owner: { id: string; timeZone: string },
  connectionIds: ReadonlySet<string>,
  now: number = Date.now(),
): Promise<PublicProductStats | null> {
  const q = productStatsQuery(db, owner, connectionIds, now);
  const [connsR, fxR, ...results] = await db.batch([connectionsStatement(db, owner.id), db.prepare(LATEST_FX_SQL), ...q.statements]);
  return q.build(results, rowsOf<ConnectionView>(connsR), rowsOf<FxRow>(fxR));
}

/** How far back the rates for a product's total revenue are read; older days take the oldest of them. */
const TOTAL_FX_DAYS = 800;

function productStatsQuery(
  db: D1Database,
  owner: { id: string; timeZone: string },
  connectionIds: ReadonlySet<string>,
  now: number,
): ReadModelQuery<PublicProductStats | null> {
  const user = { id: owner.id, baseCurrency: 'USD', timeZone: owner.timeZone };
  const include = (c: ConnectionView) => connectionIds.has(c.id) && countsPublicly(c.provider, c.test_mode === 1);
  // The figures over 30 days, and the year: daily revenue (weeks are summed from it) and daily MRR.
  const month = dashboardQuery(db, user, 30, now, include);
  const year = dashboardQuery(db, user, PUBLIC_SERIES_DAYS, now, include, { dailyRevenue: true });
  const n = month.statements.length;
  const today = zonedDayKey(now, owner.timeZone || UTC);
  // Each connection's first snapshot: a seek on the primary key per connection.
  const firstDays = db
    .prepare(
      `SELECT c.id AS connection_id, (SELECT MIN(x.day) FROM snapshots x WHERE x.connection_id = c.id) AS first_day
         FROM connections c WHERE c.user_id = ?`,
    )
    .bind(owner.id);
  // All the revenue history held, for the total and the months: one row per connection, day and
  // currency. Its days are UTC (or the provider's own); totals and months don't regroup them.
  const allRevenue = db
    .prepare(
      `SELECT d.connection_id, d.day, d.currency, d.gross - d.refunds AS net
         FROM daily_revenue d JOIN connections c ON c.id = d.connection_id
        WHERE c.user_id = ?`,
    )
    .bind(owner.id);
  // Rates for those days: a day before the stored history takes the oldest rate (SPEC §6 "Döviz").
  const totalFx = fxHistoryStatement(db, owner.id, 'USD', addDays(today, -TOTAL_FX_DAYS), today);
  // Each connection's last snapshot of every month: a range seek on the primary key per row.
  const monthEnds = db
    .prepare(
      `SELECT s.connection_id, s.day, s.mrr FROM snapshots s JOIN connections c ON c.id = s.connection_id
        WHERE c.user_id = ?1 AND s.day <= ?2
          AND s.day = (SELECT MAX(x.day) FROM snapshots x WHERE x.connection_id = s.connection_id
                         AND x.day >= substr(s.day, 1, 7) || '-01' AND x.day <= substr(s.day, 1, 7) || '-31' AND x.day <= ?2)`,
    )
    .bind(owner.id, today);
  return {
    statements: [...month.statements, ...year.statements, firstDays, allRevenue, totalFx, monthEnds],
    build: (results, allConns, fxRows) => {
      const conns = allConns.filter(include);
      const ids = new Set(conns.map((c) => c.id));
      const [firstR, revenueR, fxR, monthEndR] = results.slice(n * 2);
      const since =
        rowsOf<{ connection_id: string; first_day: string | null }>(firstR)
          .filter((r) => ids.has(r.connection_id) && r.first_day)
          .map((r) => r.first_day!)
          .sort()[0] ?? null;
      if (conns.length === 0 || since === null) return null;
      const m = month.build(results.slice(0, n), allConns, fxRows);
      const y = year.build(results.slice(n, n * 2), allConns, fxRows);
      const synced = conns.map((x) => x.last_synced_at).filter((t): t is number => t !== null);

      // Revenue: the total held, and by calendar month, each day at its own rate.
      const cv = new FxConverter('USD', latestFx(fxRows), new FxHistory(rowsOf<FxRow>(fxR)));
      let revenueTotal = 0;
      let revenueSince: string | null = null;
      const byMonth = new Map<string, number>();
      for (const r of rowsOf<{ connection_id: string; day: string; currency: string; net: number }>(revenueR)) {
        if (!ids.has(r.connection_id) || r.day > today) continue;
        const net = cv.amountOn(r.net, r.currency, r.day);
        revenueTotal += net;
        byMonth.set(r.day.slice(0, 7), (byMonth.get(r.day.slice(0, 7)) ?? 0) + net);
        if (revenueSince === null || r.day < revenueSince) revenueSince = r.day;
      }
      const revenueMonthly = revenueSince ? monthsOf(revenueSince, today).map((mo) => ({ ...mo, total: byMonth.get(mo.day.slice(0, 7)) ?? 0 })) : [];

      // MRR at each month's end: every connection's latest snapshot by then, at the latest rates.
      const ends = rowsOf<{ connection_id: string; day: string; mrr: string }>(monthEndR)
        .filter((r) => ids.has(r.connection_id))
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      const latest = new Map<string, number>();
      const mrrMonthly: MrrDay[] = [];
      for (const r of ends) {
        latest.set(r.connection_id, cv.map(parseMoneyMap(r.mrr)));
        const total = [...latest.values()].reduce((a, b) => a + b, 0);
        const last = mrrMonthly.at(-1);
        if (last && last.day.slice(0, 7) === r.day.slice(0, 7)) {
          last.day = r.day;
          last.total = total;
        } else mrrMonthly.push({ day: r.day, total });
      }

      return {
        v: 1,
        currency: 'USD',
        mrr: m.kpis.mrr,
        activeSubscriptions: m.kpis.activeSubscriptions,
        revenue: m.kpis.revenue,
        history: {
          today,
          revenueDaily: y.revenueSeries.map((d) => ({ day: d.day, total: d.total })),
          revenueWeekly: revenueInSteps(y.revenueSeries, 7).map((d) => ({ day: d.day, ...(d.to ? { to: d.to } : {}), total: d.total })),
          revenueMonthly,
          mrrDaily: y.mrrSeries,
          mrrMonthly,
        },
        revenueTotal,
        revenueSince,
        providers: [...new Set(m.breakdown.map((b) => b.provider))],
        since,
        syncedAt: synced.length > 0 ? Math.min(...synced) : null,
        estimated: m.warnings.length > 0,
        revenuePartial: m.breakdown.some((b) => b.revenue === null),
        missingFx: [...new Set([...m.fx.missing, ...y.fx.missing, ...cv.missing])].sort(),
        computedAt: now,
      };
    },
  };
}

/** Calendar months from `from`'s to `to`'s, each as its first and last day (clipped to the two). */
function monthsOf(from: string, to: string): Array<{ day: string; to: string }> {
  const out: Array<{ day: string; to: string }> = [];
  let cur = `${from.slice(0, 7)}-01`;
  while (cur <= to) {
    const next = addMonthsToDay(cur, 1);
    const last = addDays(next, -1);
    out.push({ day: cur < from ? from : cur, to: last > to ? to : last });
    cur = next;
  }
  return out;
}

/** 'YYYY-MM-01' plus `n` months. */
function addMonthsToDay(firstOfMonth: string, n: number): string {
  const d = new Date(`${firstOfMonth}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The transaction providers' revenue rows for the window, summed from its product rows (the same
 * transactions, grouped by product too): what revenueRowsStatement would return for those days.
 */
function revenueFromProducts(rows: readonly ProductDayRow[], conns: readonly ConnectionView[]): RevRow[] {
  const fromTransactions = new Set(conns.filter((c) => getProviderMeta(c.provider).revenueHistory === 'transactions').map((c) => c.id));
  const out = new Map<string, RevRow>();
  for (const r of rows) {
    if (!fromTransactions.has(r.connection_id)) continue;
    const key = `${r.connection_id}\u0000${r.day}\u0000${r.currency}`;
    const row = out.get(key);
    if (row) {
      row.gross += r.gross;
      row.refunds += r.refunds;
    } else {
      out.set(key, { connection_id: r.connection_id, day: r.day, currency: r.currency, gross: r.gross, refunds: r.refunds });
    }
  }
  return [...out.values()];
}

function buildDashboard(p: {
  now: number;
  currency: string;
  tz: string;
  today: string;
  start: string;
  prevStart: string;
  rangeDays: RangeDays;
  /** Days per revenue entry: 1, or 7 for the dashboard's year. */
  revenueStepDays: number;
  conns: readonly ConnectionView[];
  windowSnaps: SnapRow[];
  latestSnaps: SnapRow[];
  beforeSnaps: SnapRow[];
  revRows: RevRow[];
  productRows: ProductDayRow[];
  fx: FxTable | null;
  cv: FxConverter;
}): DashboardData {
  const { now, currency, tz, today, start, prevStart, rangeDays, revenueStepDays, conns, windowSnaps, latestSnaps, beforeSnaps, revRows, productRows, fx, cv } =
    p;

  const days = dayRange(start, today);
  const revenueSeries: RevenueDay[] = days.map((day) => ({ day, total: 0, byConnection: {} }));
  const seriesIndex = new Map(days.map((d, i) => [d, i]));

  // ---- revenue (current window → series, previous window → comparison) ----
  const revenueByConn = new Map<string, number>();
  const hasDailyRows = new Set<string>();
  let previousRevenue = 0;
  for (const r of revRows) {
    hasDailyRows.add(r.connection_id);
    const net = cv.amountOn(r.gross - r.refunds, r.currency, r.day);
    if (r.day < start) {
      previousRevenue += net;
      continue;
    }
    const i = seriesIndex.get(r.day);
    if (i === undefined) continue;
    const slot = revenueSeries[i]!;
    slot.total += net;
    slot.byConnection[r.connection_id] = (slot.byConnection[r.connection_id] ?? 0) + net;
    revenueByConn.set(r.connection_id, (revenueByConn.get(r.connection_id) ?? 0) + net);
  }
  for (const slot of revenueSeries) {
    for (const [id, v] of Object.entries(slot.byConnection)) if (v === 0) delete slot.byConnection[id];
  }

  // ---- snapshots ----
  const latestBy = new Map(latestSnaps.map((s) => [s.connection_id, s]));
  const beforeBy = new Map(beforeSnaps.map((s) => [s.connection_id, s]));
  const firstInWindowBy = new Map<string, SnapRow>();
  const timeline = new Map<string, Array<{ day: string; mrr: number }>>();
  for (const s of beforeSnaps) timeline.set(s.connection_id, [{ day: s.day, mrr: cv.map(parseMoneyMap(s.mrr)) }]);
  for (const s of windowSnaps) {
    if (!firstInWindowBy.has(s.connection_id)) firstInWindowBy.set(s.connection_id, s);
    const list = timeline.get(s.connection_id) ?? [];
    list.push({ day: s.day, mrr: cv.map(parseMoneyMap(s.mrr)) });
    timeline.set(s.connection_id, list);
  }

  /**
   * What each connection's latest sync couldn't count, named by connection. The Products: Read
   * warning is left to the By product card, which already names those connections.
   */
  const warnings: string[] = [];
  for (const c of conns) {
    for (const w of parseStoredWarnings(latestBy.get(c.id)?.warnings)) {
      if (w !== STRIPE_PRODUCTS_WARNING) warnings.push(`${c.name}: ${w}`);
    }
  }
  const breakdown: BreakdownRow[] = [];
  let mrr = 0;
  let subs = 0;
  let trials = 0;
  let prevMrr = 0;
  let prevSubs = 0;
  let prevTrials = 0;
  let anyComparable = false;
  let revenueTotal = 0;
  // The previous revenue window is only comparable when every contributing connection's history
  // reaches back over all of it (the first sync backfills BACKFILL_DAYS from its creation day).
  let revenueContributors = 0;
  let previousCovered = true;

  for (const row of conns) {
    const meta = getProviderMeta(row.provider);
    const latest = latestBy.get(row.id);
    const connMrr = latest ? cv.map(parseMoneyMap(latest.mrr)) : 0;
    const connSubs = latest?.active_subscriptions ?? 0;
    const connTrials = latest?.active_trials ?? null;
    mrr += connMrr;
    subs += connSubs;
    trials += connTrials ?? 0;

    // "Nearest snapshot to the start of the window" (SPEC §6): the latest one before it or the
    // first one inside it, whichever is closer. A connection whose only snapshot is its latest
    // contributes its current value, i.e. no growth, rather than inventing a jump from zero.
    if (latest) {
      const before = beforeBy.get(row.id);
      const after = firstInWindowBy.get(row.id);
      let ref: SnapRow | undefined = before ?? after;
      if (before && after && daysBetween(after.day, start) < daysBetween(before.day, start)) ref = after;
      if (ref && ref.day !== latest.day) anyComparable = true;
      const base = ref ?? latest;
      prevMrr += cv.map(parseMoneyMap(base.mrr));
      prevSubs += base.active_subscriptions;
      prevTrials += base.active_trials ?? 0;
    }

    let revenue: number | null = revenueByConn.get(row.id) ?? 0;
    let periodRevenue: BreakdownRow['periodRevenue'] = null;
    if (meta.revenueHistory === 'daily' && !hasDailyRows.has(row.id)) {
      revenue = null;
      // Only once a revenue sync has run: before that, "no history" just means "not yet".
      if (row.revenue_synced_until !== null) {
        const period = latest?.revenue_period ? parseMoneyMap(latest.revenue_period) : null;
        periodRevenue = { amount: period ? cv.map(period) : null, days: latest?.revenue_period_days ?? 28 };
      }
    } else {
      revenueTotal += revenue;
      if (row.revenue_synced_until !== null || hasDailyRows.has(row.id)) {
        revenueContributors++;
        const historyStart = addDays(zonedDayKey(row.created_at, tz), -(BACKFILL_DAYS - 1));
        if (historyStart > prevStart) previousCovered = false;
      }
    }

    // Sync problems aren't turned into sentences here: the row carries status, lastError and
    // lastSyncedAt, and the dashboard explains each one next to the figure it affects.
    breakdown.push({
      ...toSummary(row),
      mrr: connMrr,
      activeSubscriptions: connSubs,
      activeTrials: connTrials,
      revenue,
      periodRevenue,
      sharePct: 0,
    });
  }

  for (const b of breakdown) b.sharePct = mrr > 0 ? Math.round((b.mrr / mrr) * 1000) / 10 : 0;
  breakdown.sort((a, b) => b.mrr - a.mrr || a.name.localeCompare(b.name));

  // ---- MRR trend: days with any snapshot, carrying each connection's last value forward ----
  const seriesDays = [...new Set(windowSnaps.map((s) => s.day))].sort();
  const mrrSeries: MrrDay[] = seriesDays.map((day) => {
    let total = 0;
    for (const list of timeline.values()) {
      let v: number | null = null;
      for (const p of list) {
        if (p.day > day) break;
        v = p.mrr;
      }
      total += v ?? 0;
    }
    return { day, total };
  });

  const products = productBreakdown(
    productRows,
    conns,
    revenueByConn,
    cv,
  );

  const productMrr = productMrrBreakdown(latestSnaps, conns, cv);

  // Reported through fx.missing; the dashboard says it next to the MRR it leaves out.
  const missing = [...cv.missing].sort();

  const previous = anyComparable;
  return {
    currency,
    rangeDays,
    generatedAt: now,
    hasConnections: conns.length > 0,
    kpis: {
      mrr: kpi(mrr, previous ? prevMrr : null),
      arr: kpi(mrr * 12, previous ? prevMrr * 12 : null),
      activeSubscriptions: kpi(subs, previous ? prevSubs : null),
      activeTrials: kpi(trials, previous ? prevTrials : null),
      revenue: kpi(revenueTotal, revenueContributors > 0 && previousCovered ? previousRevenue : null),
    },
    breakdown,
    products,
    productMrr,
    // The year's bars are weeks: summed here, so the page carries 52 entries rather than 364.
    revenueSeries: revenueInSteps(revenueSeries, revenueStepDays),
    mrrSeries,
    fx: { asOf: cv.used && fx ? fx.day : null, daily: cv.usedDaily, missing },
    days: { timeZone: tz, otherZones: otherDayZones(conns, tz) },
    warnings,
  };
}

/** Providers among `conns` whose days aren't the user's, grouped by the zone they're in. */
function otherDayZones(conns: readonly ConnectionView[], tz: string): Array<{ label: string; providers: string[] }> {
  const byZone = new Map<string, { label: string; providers: string[] }>();
  for (const c of conns) {
    const meta = getProviderMeta(c.provider);
    if (!meta.dayZone || meta.dayZone.tz === tz) continue;
    const z = byZone.get(meta.dayZone.tz) ?? { label: meta.dayZone.label, providers: [] };
    if (!z.providers.includes(meta.name)) z.providers.push(meta.name);
    byZone.set(meta.dayZone.tz, z);
  }
  return [...byZone.values()];
}

/**
 * Revenue in the window by product. Transaction providers are split by the name on each charge or
 * refund (per connection, so "Pro" in two stores is two rows); everything else in the revenue KPI
 * (daily totals, charges without a name) goes to `unnamed`, so the whole adds up to that KPI.
 */
function productBreakdown(
  rows: readonly ProductSumRow[],
  conns: readonly ConnectionView[],
  revenueByConn: ReadonlyMap<string, number>,
  cv: FxConverter,
): ProductBreakdown {
  const connById = new Map(conns.map((c) => [c.id, c]));
  const products = new Map<string, ProductRow>();
  const unnamedBy = new Map<string, number>();
  const addUnnamed = (connectionId: string, v: number) => unnamedBy.set(connectionId, (unnamedBy.get(connectionId) ?? 0) + v);

  // The KPI converts each connection's day and currency as one sum; its products split that
  // converted sum (FxConverter.amountsOn) rather than each rounding on its own.
  const groups = new Map<string, ProductSumRow[]>();
  for (const r of rows) {
    const conn = connById.get(r.connection_id);
    // Only providers whose daily revenue is built from these rows; anything else would count twice.
    if (!conn || getProviderMeta(conn.provider).revenueHistory !== 'transactions') continue;
    const key = `${conn.id}\u0000${r.day}\u0000${r.currency}`;
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  for (const group of groups.values()) {
    // By name (no name first), so a leftover minor unit lands the same way on every render.
    group.sort((a, b) => (a.product ?? '').localeCompare(b.product ?? ''));
    const { connection_id, currency, day } = group[0]!;
    const conn = connById.get(connection_id)!;
    const nets = cv.amountsOn(group.map((r) => r.net), currency, day);
    group.forEach((r, i) => {
      const net = nets[i]!;
      if (r.product === null) {
        addUnnamed(conn.id, net);
        return;
      }
      const key = `${conn.id}\u0000${r.product}`;
      let p = products.get(key);
      if (!p) {
        const { dotClass } = getProviderMeta(conn.provider);
        p = { name: r.product, connectionId: conn.id, connectionName: conn.name, dotClass, revenue: 0, charges: 0, sharePct: 0 };
        products.set(key, p);
      }
      p.revenue += net;
      p.charges += r.charges;
    });
  }
  // Providers that report daily totals: their whole window has no product name.
  for (const c of conns) {
    if (getProviderMeta(c.provider).revenueHistory === 'transactions') continue;
    const v = revenueByConn.get(c.id) ?? 0;
    if (v !== 0) addUnnamed(c.id, v);
  }

  const all = [...products.values()].sort(
    (a, b) =>
      b.revenue - a.revenue ||
      b.charges - a.charges ||
      a.name.localeCompare(b.name) ||
      a.connectionName.localeCompare(b.connectionName),
  );
  let unnamed = 0;
  const byProvider = new Map<ProviderId, number>();
  for (const [id, v] of unnamedBy) {
    unnamed += v;
    const provider = connById.get(id)!.provider;
    if (v !== 0 && !getProviderMeta(provider).productNames) byProvider.set(provider, (byProvider.get(provider) ?? 0) + v);
  }

  const earned = all.reduce((s, p) => s + Math.max(0, p.revenue), 0) + Math.max(0, unnamed);
  const share = (v: number) => (v > 0 && earned > 0 ? Math.round((v / earned) * 1000) / 10 : 0);
  for (const p of all) p.sharePct = share(p.revenue);

  // An 11th row reads better than "1 more product".
  const shown = all.length <= PRODUCT_ROWS + 1 ? all : all.slice(0, PRODUCT_ROWS);
  const rest = all.slice(shown.length);
  const moreRevenue = rest.reduce((s, p) => s + p.revenue, 0);

  return {
    rows: shown,
    more:
      rest.length > 0
        ? { count: rest.length, revenue: moreRevenue, charges: rest.reduce((s, p) => s + p.charges, 0), sharePct: share(moreRevenue) }
        : null,
    unnamed: { revenue: unnamed, sharePct: share(unnamed) },
    unnamedProviders: [...byProvider.entries()]
      .map(([id, v]) => ({ name: getProviderMeta(id).name, v }))
      .sort((a, b) => b.v - a.v || a.name.localeCompare(b.name))
      .map((p) => p.name),
    named: conns.some((c) => getProviderMeta(c.provider).productNames),
  };
}

/** The split stored with a snapshot, or null when there is none (or it can't be read). */
function parseProductMrr(raw: string | null | undefined): ReturnType<typeof cleanProductMrr> {
  if (!raw) return null;
  try {
    return cleanProductMrr(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Below half a minor unit, a remainder is FX rounding, not MRR. */
const ROUNDING = 0.5;

/**
 * MRR now by product, from each connection's latest snapshot (the same one the MRR KPI uses). A
 * connection whose snapshot has no split, and products without a name, go to `unnamed`: each
 * connection adds its MRR minus its named products, so the whole adds up to the MRR KPI.
 */
function productMrrBreakdown(
  latest: readonly SnapRow[],
  conns: readonly ConnectionView[],
  cv: FxConverter,
): ProductMrrBreakdown {
  const latestBy = new Map(latest.map((s) => [s.connection_id, s]));
  const products = new Map<string, ProductMrrRow>();
  const byProvider = new Map<ProviderId, number>();
  const needsPermission: string[] = [];
  let unnamed = 0;
  let total = 0;
  let split = false;

  for (const conn of conns) {
    const snap = latestBy.get(conn.id);
    if (!snap) continue;
    const meta = getProviderMeta(conn.provider);
    const connMrr = cv.map(parseMoneyMap(snap.mrr));
    total += connMrr;
    const parts = parseProductMrr(snap.mrr_by_product);
    if (!parts) {
      unnamed += connMrr;
      // Named only when the sync said why (its key can't read products); a split that's missing
      // for another reason (a budget skip, a report without products) is just unnamed MRR.
      if (connMrr > 0 && parseStoredWarnings(snap.warnings).includes(STRIPE_PRODUCTS_WARNING)) needsPermission.push(conn.name);
      else if (connMrr > 0) byProvider.set(conn.provider, (byProvider.get(conn.provider) ?? 0) + connMrr);
      continue;
    }
    split = true;
    let named = 0;
    for (const p of parts.products) {
      if (p.name === null) continue;
      const v = cv.map(p.mrr);
      named += v;
      const key = `${conn.id}\u0000${p.name}`;
      let row = products.get(key);
      if (!row) {
        row = { name: p.name, connectionId: conn.id, connectionName: conn.name, dotClass: meta.dotClass, mrr: 0, subscriptions: 0, sharePct: 0 };
        products.set(key, row);
      }
      row.mrr += v;
      row.subscriptions += p.subscriptions;
    }
    const rest = connMrr - named;
    if (Math.abs(rest) >= ROUNDING) unnamed += rest;
  }

  const all = [...products.values()].sort(
    (a, b) =>
      b.mrr - a.mrr ||
      b.subscriptions - a.subscriptions ||
      a.name.localeCompare(b.name) ||
      a.connectionName.localeCompare(b.connectionName),
  );
  const share = (v: number) => (v > 0 && total > 0 ? Math.round((v / total) * 1000) / 10 : 0);
  for (const p of all) p.sharePct = share(p.mrr);

  // An 11th row reads better than "1 more product".
  const shown = all.length <= PRODUCT_ROWS + 1 ? all : all.slice(0, PRODUCT_ROWS);
  const rest = all.slice(shown.length);
  const moreMrr = rest.reduce((s, p) => s + p.mrr, 0);

  return {
    rows: shown,
    more:
      rest.length > 0
        ? { count: rest.length, mrr: moreMrr, subscriptions: rest.reduce((s, p) => s + p.subscriptions, 0), sharePct: share(moreMrr) }
        : null,
    unnamed: { mrr: Math.abs(unnamed) < ROUNDING ? 0 : unnamed, sharePct: share(unnamed) },
    unnamedProviders: [...byProvider.entries()]
      .map(([id, v]) => ({ name: getProviderMeta(id).name, v }))
      .sort((a, b) => b.v - a.v || a.name.localeCompare(b.name))
      .map((p) => p.name),
    needsPermission,
    split,
  };
}
