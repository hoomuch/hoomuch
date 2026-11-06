/**
 * Dashboard read model. Owner: Data Plane. Signature is part of the contract (SPEC §9.1).
 *
 * One D1 round trip (a single `db.batch`), no provider calls (SPEC N-02). Every amount is
 * converted into the user's display currency with the newest FX table; currencies without a
 * rate are left out of totals and reported in `fx.missing` (SPEC §6 "Döviz").
 */

import type { Bindings, SessionUser } from '../env';
import type { ConnectionRow } from '../db/queries';
import { normalizeCurrency, parseMoneyMap } from '../lib/money';
import { addDays, DAY, dayKey, dayRange, dayStart } from '../lib/time';
import { getProviderMeta } from '../providers/registry';
import type { ProviderId } from '../providers/types';
import { STRIPE_PRODUCTS_WARNING } from '../providers/stripe';
import { BACKFILL_DAYS, cleanProductMrr, parseStoredWarnings } from '../sync/aggregate';
import { FxConverter, LATEST_FX_SQL, rowToFx } from '../sync/fx';
import { toSummary } from './connections';
import type {
  BreakdownRow,
  DashboardData,
  Kpi,
  MrrDay,
  ProductBreakdown,
  ProductMrrBreakdown,
  ProductMrrRow,
  ProductRow,
  RangeDays,
  RevenueDay,
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

export interface ProductSumRow {
  connection_id: string;
  /** Null when the transactions had no product name. */
  product: string | null;
  currency: string;
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
  const now = Date.now();
  const currency = normalizeCurrency(user.baseCurrency || 'USD');
  const today = dayKey(now);
  const start = addDays(today, -(rangeDays - 1));
  const prevStart = addDays(start, -rangeDays);
  const db = env.DB;

  const SNAP_COLS = 's.connection_id, s.day, s.mrr, s.active_subscriptions, s.active_trials';
  const [connsR, windowR, latestR, beforeR, revR, fxR, productR] = await db.batch([
    db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at ASC').bind(user.id),
    db
      .prepare(
        `SELECT ${SNAP_COLS} FROM snapshots s JOIN connections c ON c.id = s.connection_id
          WHERE c.user_id = ? AND s.day >= ? ORDER BY s.day ASC`,
      )
      .bind(user.id, start),
    db
      .prepare(
        `SELECT ${SNAP_COLS}, s.revenue_period, s.revenue_period_days, s.mrr_by_product, s.warnings FROM snapshots s
           JOIN connections c ON c.id = s.connection_id
          WHERE c.user_id = ? AND s.day = (SELECT MAX(day) FROM snapshots WHERE connection_id = s.connection_id)`,
      )
      .bind(user.id),
    db
      .prepare(
        `SELECT ${SNAP_COLS} FROM snapshots s JOIN connections c ON c.id = s.connection_id
          WHERE c.user_id = ?
            AND s.day = (SELECT MAX(day) FROM snapshots WHERE connection_id = s.connection_id AND day < ?)`,
      )
      .bind(user.id, start),
    db
      .prepare(
        `SELECT d.connection_id, d.day, d.currency, d.gross, d.refunds FROM daily_revenue d
           JOIN connections c ON c.id = d.connection_id
          WHERE c.user_id = ? AND d.day >= ? AND d.day <= ?`,
      )
      .bind(user.id, prevStart, today),
    db.prepare(LATEST_FX_SQL),
    // Same window as the revenue rows above (UTC days start..today), per product and currency.
    db
      .prepare(
        `SELECT t.connection_id, NULLIF(TRIM(t.description), '') AS product, t.currency,
                SUM(t.amount) AS net, SUM(CASE WHEN t.type = 'charge' THEN 1 ELSE 0 END) AS charges
           FROM transactions t JOIN connections c ON c.id = t.connection_id
          WHERE c.user_id = ? AND t.occurred_at >= ? AND t.occurred_at < ?
          GROUP BY t.connection_id, product, t.currency`,
      )
      .bind(user.id, dayStart(start), dayStart(today) + DAY),
  ]);

  const conns = (connsR!.results ?? []) as unknown as ConnectionRow[];
  const windowSnaps = (windowR!.results ?? []) as unknown as SnapRow[];
  const latestSnaps = (latestR!.results ?? []) as unknown as SnapRow[];
  const beforeSnaps = (beforeR!.results ?? []) as unknown as SnapRow[];
  const revRows = (revR!.results ?? []) as unknown as RevRow[];
  const fx = rowToFx((fxR!.results?.[0] ?? null) as { day: string; base: string; rates: string } | null);
  const cv = new FxConverter(currency, fx);

  const days = dayRange(start, today);
  const revenueSeries: RevenueDay[] = days.map((day) => ({ day, total: 0, byConnection: {} }));
  const seriesIndex = new Map(days.map((d, i) => [d, i]));

  // ---- revenue (current window → series, previous window → comparison) ----
  const revenueByConn = new Map<string, number>();
  const hasDailyRows = new Set<string>();
  let previousRevenue = 0;
  for (const r of revRows) {
    hasDailyRows.add(r.connection_id);
    const net = cv.amount(r.gross - r.refunds, r.currency);
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
        const historyStart = addDays(dayKey(row.created_at), -(BACKFILL_DAYS - 1));
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
    (productR!.results ?? []) as unknown as ProductSumRow[],
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
    revenueSeries,
    mrrSeries,
    fx: { asOf: cv.used && fx ? fx.day : null, missing },
    warnings,
  };
}

/**
 * Revenue in the window by product. Transaction providers are split by the name on each charge or
 * refund (per connection, so "Pro" in two stores is two rows); everything else in the revenue KPI
 * (daily totals, charges without a name) goes to `unnamed`, so the whole adds up to that KPI.
 */
export function productBreakdown(
  rows: readonly ProductSumRow[],
  conns: readonly ConnectionRow[],
  revenueByConn: ReadonlyMap<string, number>,
  cv: FxConverter,
): ProductBreakdown {
  const connById = new Map(conns.map((c) => [c.id, c]));
  const products = new Map<string, ProductRow>();
  const unnamedBy = new Map<string, number>();
  const addUnnamed = (connectionId: string, v: number) => unnamedBy.set(connectionId, (unnamedBy.get(connectionId) ?? 0) + v);

  for (const r of rows) {
    const conn = connById.get(r.connection_id);
    // Only providers whose daily revenue is built from these rows; anything else would count twice.
    if (!conn || getProviderMeta(conn.provider).revenueHistory !== 'transactions') continue;
    const net = cv.amount(r.net, r.currency);
    if (r.product === null) {
      addUnnamed(conn.id, net);
      continue;
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
export function productMrrBreakdown(
  latest: readonly SnapRow[],
  conns: readonly ConnectionRow[],
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
