/**
 * Dashboard read model. Owner: Data Plane. Signature is part of the contract (SPEC §9.1).
 *
 * One D1 round trip (a single `db.batch`), no provider calls (SPEC N-02). Every amount is
 * converted into the user's display currency with the newest FX table; currencies without a
 * rate are left out of totals and reported in `fx.missing` (SPEC §6 "Döviz").
 */

import type { Bindings, SessionUser } from '../env';
import type { ConnectionRow } from '../db/queries';
import { formatMoney, normalizeCurrency, parseMoneyMap } from '../lib/money';
import { addDays, dayKey, dayRange } from '../lib/time';
import { getProviderMeta } from '../providers/registry';
import { BACKFILL_DAYS } from '../sync/aggregate';
import { FxConverter, LATEST_FX_SQL, rowToFx } from '../sync/fx';
import { toSummary } from './connections';
import type { BreakdownRow, DashboardData, Kpi, MrrDay, RangeDays, RevenueDay } from './types';

interface SnapRow {
  connection_id: string;
  day: string;
  mrr: string;
  active_subscriptions: number;
  active_trials: number | null;
  revenue_period?: string | null;
  revenue_period_days?: number | null;
}

interface RevRow {
  connection_id: string;
  day: string;
  currency: string;
  gross: number;
  refunds: number;
}

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
  const [connsR, windowR, latestR, beforeR, revR, fxR] = await db.batch([
    db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at ASC').bind(user.id),
    db
      .prepare(
        `SELECT ${SNAP_COLS} FROM snapshots s JOIN connections c ON c.id = s.connection_id
          WHERE c.user_id = ? AND s.day >= ? ORDER BY s.day ASC`,
      )
      .bind(user.id, start),
    db
      .prepare(
        `SELECT ${SNAP_COLS}, s.revenue_period, s.revenue_period_days FROM snapshots s
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

  const warnings: string[] = [];
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
    if (meta.revenueHistory === 'daily' && !hasDailyRows.has(row.id)) {
      revenue = null;
      if (row.revenue_synced_until !== null) {
        const period = latest?.revenue_period ? parseMoneyMap(latest.revenue_period) : null;
        const periodDays = latest?.revenue_period_days ?? 28;
        warnings.push(
          period
            ? `${row.name} has no daily revenue history, so it’s left out of revenue totals; its last ${periodDays}-day revenue was ${formatMoney(cv.map(period), currency, { whole: true })}.`
            : `${row.name} has no daily revenue history, so it’s left out of revenue totals.`,
        );
      }
    } else {
      revenueTotal += revenue;
      if (row.revenue_synced_until !== null || hasDailyRows.has(row.id)) {
        revenueContributors++;
        const historyStart = addDays(dayKey(row.created_at), -(BACKFILL_DAYS - 1));
        if (historyStart > prevStart) previousCovered = false;
      }
    }

    if (row.status === 'error') {
      warnings.push(`${row.name} couldn’t sync${row.last_error ? `: ${row.last_error}` : '.'}`);
    } else if (!latest && (row.status === 'pending' || row.status === 'syncing')) {
      warnings.push(`${row.name} is still syncing; its numbers will appear shortly.`);
    }

    breakdown.push({
      ...toSummary(row),
      mrr: connMrr,
      activeSubscriptions: connSubs,
      activeTrials: connTrials,
      revenue,
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

  const missing = [...cv.missing].sort();
  if (missing.length > 0) {
    warnings.push(
      fx
        ? `No exchange rate for ${missing.join(', ')}; those amounts are left out of totals.`
        : `Exchange rates aren’t available yet, so ${missing.join(', ')} amounts are left out of totals.`,
    );
  }

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
    revenueSeries,
    mrrSeries,
    fx: { asOf: cv.used && fx ? fx.day : null, missing },
    warnings,
  };
}
