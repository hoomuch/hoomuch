/**
 * READ-MODEL CONTRACT between Data Plane (producer) and Experience (consumer).
 * Owner: Lead — changes need Lead approval (SPEC.md §9.1).
 *
 * Conventions: money values are integer minor units in `currency` (the user's display
 * currency) unless a field says otherwise; timestamps are epoch ms; days are 'YYYY-MM-DD' in the
 * user's time zone (`SessionUser.timeZone`), except provider-reported daily totals (`ProviderMeta.dayZone`).
 */

import type { ConnectionStatus, ConnectionView } from '../db/queries';
import type { FxRow } from '../sync/fx';
import type { ProviderId } from '../providers/types';

/**
 * The dashboard's window in days, ending today. The year is 364 days, 52 whole weeks, so its
 * revenue rolls up into weeks that all end on today's weekday (`revenueStep`): no bar is a part week.
 */
export type RangeDays = 7 | 30 | 90 | 364;

/**
 * A read model as statements for a `db.batch` plus the function that builds it from their results,
 * so a page can put several read models in one D1 round trip. The connections
 * (`connectionsStatement`) and the latest rates (`LATEST_FX_SQL`) are read once for all of them and
 * passed to each `build`.
 */
export interface ReadModelQuery<T> {
  statements: D1PreparedStatement[];
  build(results: readonly D1Result[], conns: readonly ConnectionView[], fxRows: readonly FxRow[]): T;
}

/** A batch result's rows. */
export const rowsOf = <T,>(r: D1Result | undefined): T[] => (r?.results ?? []) as unknown as T[];
export const RANGE_OPTIONS: readonly RangeDays[] = [7, 30, 90, 364];

export function parseRange(v: string | undefined | null): RangeDays {
  const n = Number(v);
  return n === 7 || n === 90 || n === 364 ? n : 30;
}

/** The window in words: "30 days", or "52 weeks" for the year. */
export function rangeSpan(r: RangeDays): string {
  return r === 364 ? '52 weeks' : `${r} days`;
}

/** Days each `revenueSeries` entry adds up: a week in the year's window, a day otherwise. */
export function revenueStep(r: RangeDays): 1 | 7 {
  return r === 364 ? 7 : 1;
}

/**
 * Daily entries rolled up into `step`-day ones, oldest first. The window is whole steps, so the
 * last entry ends on the last day. Each entry keeps its first day and says its last in `to`.
 */
export function revenueInSteps(days: readonly RevenueDay[], step: number): RevenueDay[] {
  if (step <= 1) return days.slice();
  const out: RevenueDay[] = [];
  for (let i = 0; i < days.length; i += step) {
    const part = days.slice(i, i + step);
    const entry: RevenueDay = { day: part[0]!.day, to: part.at(-1)!.day, total: 0, byConnection: {} };
    for (const d of part) {
      entry.total += d.total;
      for (const [id, v] of Object.entries(d.byConnection)) entry.byConnection[id] = (entry.byConnection[id] ?? 0) + v;
    }
    for (const [id, v] of Object.entries(entry.byConnection)) if (v === 0) delete entry.byConnection[id];
    out.push(entry);
  }
  return out;
}

/** The window's last day (the user's today): the last entry's `to`, or its day. */
export function lastRevenueDay(series: readonly RevenueDay[]): string | undefined {
  const last = series.at(-1);
  return last ? (last.to ?? last.day) : undefined;
}

export interface Kpi {
  value: number;
  /** Comparable value at the start of the window (or previous window for revenue). */
  previous: number | null;
  /** (value − previous) / previous × 100; null when previous is null or 0. */
  deltaPct: number | null;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  provider: ProviderId;
  /** Brand hex (SVG attributes). */
  color: string;
  /** Literal Tailwind class for the dot. */
  dotClass: string;
  status: ConnectionStatus;
  lastSyncedAt: number | null;
  lastError: string | null;
  testMode: boolean;
}

export interface BreakdownRow extends ConnectionSummary {
  mrr: number;
  activeSubscriptions: number;
  activeTrials: number | null;
  /** Revenue in the selected window; null when the provider has no history for it. */
  revenue: number | null;
  /**
   * Set when the provider has no daily revenue history (RevenueCat without Charts access) and a
   * revenue sync has run: its own trailing total in the display currency (`amount` null if it
   * reported none) over `days`. Null or absent otherwise.
   */
  periodRevenue?: { amount: number | null; days: number } | null;
  /** Share of total MRR, 0–100. */
  sharePct: number;
}

/** One product (or plan) sold through one connection, over the selected window. */
export interface ProductRow {
  /** As the provider names it, e.g. "Pro (yearly)". The same name in two connections is two rows. */
  name: string;
  connectionId: string;
  connectionName: string;
  /** Literal Tailwind class for the connection's dot. */
  dotClass: string;
  /** Net revenue (charges − refunds) in the window. */
  revenue: number;
  /** Charges in the window; refunds aren't counted. */
  charges: number;
  /**
   * Share of the window's revenue, 0–100, out of the rows that made money (so a refund-heavy row
   * can't push the others past 100). 0 for a row that lost money.
   */
  sharePct: number;
}

/** Revenue in the window by product (SPEC F-18). Adds up to the revenue KPI. */
export interface ProductBreakdown {
  /** Highest revenue first, at most PRODUCT_ROWS (one more rather than a "1 more product" row). */
  rows: ProductRow[];
  /** The products after `rows`, added up; null when there are none. */
  more: { count: number; revenue: number; charges: number; sharePct: number } | null;
  /**
   * Revenue that came without a product name: everything from providers that don't report one
   * (Stripe, Chargebee, daily totals), plus single charges or refunds that lack one. 0 when none.
   */
  unnamed: { revenue: number; sharePct: number };
  /**
   * Names of the providers that don't report product names and put revenue into `unnamed`
   * ("Stripe"), biggest first. Charges without a name from a provider that has them aren't listed.
   */
  unnamedProviders: string[];
  /** A connection's provider reports product names, so there is something to split. */
  named: boolean;
}

export interface ProductMrrRow {
  /** As the provider names it. The same name in two connections is two rows. */
  name: string;
  connectionId: string;
  connectionName: string;
  /** Literal Tailwind class for the connection's dot. */
  dotClass: string;
  /** MRR now (each connection's latest snapshot), in the display currency. */
  mrr: number;
  /** Active subscriptions that include the product; one subscription can count under several. */
  subscriptions: number;
  /** Share of the MRR KPI, 0–100. */
  sharePct: number;
}

/** MRR now by product (SPEC F-18), from the providers whose snapshots split it. Adds up to the MRR KPI. */
export interface ProductMrrBreakdown {
  /** Highest MRR first, at most PRODUCT_ROWS (one more rather than a "1 more product" row). */
  rows: ProductMrrRow[];
  /** The products after `rows`, added up; null when there are none. */
  more: { count: number; mrr: number; subscriptions: number; sharePct: number } | null;
  /** MRR not split by product: connections whose snapshot has no split, and products without a name. */
  unnamed: { mrr: number; sharePct: number };
  /**
   * Providers whose MRR is in `unnamed` because they don't split MRR by product ("Paddle"), biggest
   * first. Connections that could but didn't are in `needsPermission` instead.
   */
  unnamedProviders: string[];
  /**
   * Connections (by name) whose provider splits MRR by product but whose latest snapshot didn't, so
   * their key most likely can't read product names (Stripe: Products: Read). Only those with MRR.
   */
  needsPermission: string[];
  /** At least one connection's latest snapshot split its MRR by product. */
  split: boolean;
}

export interface RevenueDay {
  /** The entry's day, or its first day when it adds up a week. */
  day: string;
  /** Its last day when it adds up a week (the year's window, `revenueStep`); absent for one day. */
  to?: string;
  /** Net (gross − refunds) across connections. */
  total: number;
  /** connectionId → net amount. Connections with no revenue that day may be absent. */
  byConnection: Record<string, number>;
}

export interface MrrDay {
  day: string;
  total: number;
}

/** One bucket of the MRR movement: what it moved (positive, display currency) and how many subscriptions. */
interface MovementPart {
  amount: number;
  count: number;
}

/**
 * Why MRR moved in the window (SPEC F-26), over the connections whose provider lists subscriptions
 * one by one. Worked out by comparing each sync's list with the one before, so it starts on the day
 * a connection was first synced with it, and a change counts on the day a sync saw it.
 */
export interface MrrMovement {
  /** Subscriptions that started paying. */
  new: MovementPart;
  /** Subscriptions that pay more than before: the increase. */
  expansion: MovementPart;
  /** Subscriptions that pay less than before: the decrease. */
  contraction: MovementPart;
  /** Subscriptions that stopped counting: what they paid. */
  churned: MovementPart;
  /** new + expansion − contraction − churned. */
  net: number;
  /** Churned subscriptions as a share of those at the start of the window, 0–100; null when there were none. */
  subscriptionChurnPct: number | null;
  /** Churned and contraction MRR as a share of the MRR at the start of the window, 0–100; null when there was none. */
  mrrChurnPct: number | null;
  /** The day the count starts, when that's after the window's first day ('YYYY-MM-DD'); null when the whole window is covered. */
  since: string | null;
  /** Names of the user's providers that aren't in it, in breakdown order. */
  notIncluded: string[];
}

export interface DashboardData {
  currency: string;
  rangeDays: RangeDays;
  generatedAt: number;
  hasConnections: boolean;
  kpis: {
    mrr: Kpi;
    arr: Kpi;
    activeSubscriptions: Kpi;
    activeTrials: Kpi;
    /** Net revenue in the window. */
    revenue: Kpi;
  };
  /** Sorted by MRR, descending. */
  breakdown: BreakdownRow[];
  products: ProductBreakdown;
  productMrr: ProductMrrBreakdown;
  /** Null when no connection's provider lists subscriptions one by one, or none has synced with it yet. */
  movement: MrrMovement | null;
  /**
   * One entry per `revenueStep(rangeDays)` days, oldest → newest, zero-filled: `rangeDays` days, or
   * 52 weeks for the year. The last entry ends today.
   */
  revenueSeries: RevenueDay[];
  /** Days in the window that have snapshots, oldest → newest (may be sparse early on). */
  mrrSeries: MrrDay[];
  fx: {
    /** Day of the latest rates MRR was converted at, null if none was needed / available. */
    asOf: string | null;
    /** Some revenue was converted from another currency, at the rate of its own day. */
    daily: boolean;
    /** Currencies that couldn't be converted and were left out of totals. */
    missing: string[];
  };
  /**
   * The zone the user's days run in, and the providers whose daily totals keep their own days
   * because they can't be regrouped (`ProviderMeta.dayZone`), by zone, only where it differs.
   */
  days: { timeZone: string; otherZones: Array<{ label: string; providers: string[] }> };
  /**
   * What connections' latest syncs couldn't count, as "<connection name>: <sentence>"
   * (`MetricsSnapshot.warnings`), connections in breakdown order. Not repeated here:
   * sync problems (breakdown status / lastError / lastSyncedAt), currencies without a rate
   * (fx.missing) and providers without daily revenue (BreakdownRow.periodRevenue). The dashboard
   * turns those into sentences next to the figure they affect.
   */
  warnings: string[];
}

/** One day of the dashboard calendar. Days after `CalendarMonth.today` carry nulls and zeros. */
export interface CalendarDay {
  day: string;
  /**
   * Net revenue (gross − refunds) across connections with daily history. Null before that history
   * starts (`CalendarMonth.revenueFrom`) and after today; 0 is a real day without revenue.
   */
  net: number | null;
  gross: number;
  /** Positive amount refunded. */
  refunds: number;
  /** connectionId → net amount. Connections with nothing that day are absent. */
  byConnection: Record<string, number>;
  /** Charges and refunds listed one by one (not counted for providers that report daily totals only). */
  charges: number;
  refundCount: number;
  /**
   * End-of-day totals: each connection's latest snapshot on or before this day. Null before the
   * first snapshot and after today. `activeTrials` is also null when no connection reports trials.
   */
  mrr: number | null;
  activeSubscriptions: number | null;
  activeTrials: number | null;
  /** Change from the day before; null when either day has no value. */
  mrrChange: number | null;
  subscriptionsChange: number | null;
  trialsChange: number | null;
}

export interface CalendarMonth {
  /** 'YYYY-MM' (the user's zone). */
  month: string;
  /** Display currency. */
  currency: string;
  /** The user's local day the month was read on. */
  today: string;
  /** Every day of the month, 1st → last. */
  days: CalendarDay[];
  /** First day revenue history covers, or null when no connection has any yet. */
  revenueFrom: string | null;
  /** Day of the first MRR snapshot, or null when there's none yet. */
  mrrFrom: string | null;
  /** The month before, when there's data that far back; otherwise null. */
  prevMonth: string | null;
  /** The month after, up to the current one; otherwise null. */
  nextMonth: string | null;
}

export interface TransactionRow {
  connectionId: string;
  connectionName: string;
  provider: ProviderId;
  color: string;
  dotClass: string;
  externalId: string;
  occurredAt: number;
  type: 'charge' | 'refund';
  /** Original amount (signed minor units) in `originalCurrency`. */
  amount: number;
  originalCurrency: string;
  /** Converted to the page currency; null if no FX rate. */
  displayAmount: number | null;
  /** What the provider kept of a charge, in `originalCurrency` (positive minor units); null when it doesn't say. */
  fee: number | null;
  /** `fee` in the page currency, at the same day's rate; null without a fee or a rate. */
  displayFee: number | null;
  description: string | null;
}

/** Most rows one CSV export holds (`exportTransactions`). A longer period is exported in parts. */
export const EXPORT_MAX_ROWS = 10_000;

export interface TransactionPage {
  /** Display currency. */
  currency: string;
  provider: ProviderId | null;
  /** One local day ('YYYY-MM-DD') the list is narrowed to, or null for every day. */
  day?: string | null;
  items: TransactionRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Where the next (older) page starts: `?before=` (data/transactions.ts). Null without one. */
  nextCursor: string | null;
  /** Where the previous (newer) page ends: `?after=`. Null on page 1. */
  prevCursor: string | null;
}

export interface SnapshotRow {
  day: string;
  /** In display currency. */
  mrr: number;
  activeSubscriptions: number;
  activeTrials: number | null;
}

export interface SyncRunRow {
  kind: 'cron' | 'manual' | 'initial' | 'webhook';
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  events: number;
  message: string | null;
}

export interface ConnectionDetail extends ConnectionSummary {
  createdAt: number;
  keyHint: string | null;
  /** Non-secret config only (safe to render). */
  config: Record<string, string>;
  /** Display currency used for `snapshots`. */
  currency: string;
  /** Latest first, up to 30. */
  snapshots: SnapshotRow[];
  /** Latest first, up to 10. */
  recentRuns: SyncRunRow[];
  /** What the latest snapshot couldn't count (`MetricsSnapshot.warnings`); [] when nothing. */
  warnings: string[];
  /**
   * Real-time updates (SPEC F-17), for providers with webhook setup (`ProviderMeta.webhook`); null
   * for the others. `path` is the webhook URL without its origin (the page adds the one it was
   * served from), null while webhooks are off.
   */
  webhook: { path: string | null; lastCallAt: number | null } | null;
}

// ---------- public pages (SPEC F-21) ----------

/**
 * The days a public product's daily revenue series spans, ending on the owner's today: 52 weeks,
 * for the year's calendar image (views/components/share-cards).
 */
export const PUBLIC_SERIES_DAYS = 364;

/** What a public chart can show (SPEC F-21). */
export const PUBLIC_METRICS = ['revenue', 'mrr'] as const;
export type PublicMetric = (typeof PUBLIC_METRICS)[number];
export const PUBLIC_RANGES = ['7d', '30d', '90d', '1y', 'all'] as const;
export type PublicRange = (typeof PUBLIC_RANGES)[number];

/**
 * The one chart anyone sees: revenue over the last 30 days. Every other view needs a free account,
 * which is what brings a visitor in (GET /api/p/<slug>/history).
 */
export function isOpenView(metric: PublicMetric, range: PublicRange): boolean {
  return metric === 'revenue' && range === '30d';
}

/** One point of a public revenue series; `to` is its last day when it adds up more than one day. */
export interface RevenuePoint {
  day: string;
  to?: string;
  total: number;
}

/**
 * The series behind every view of a public chart, stored with the figures and served only to
 * signed-in visitors. Amounts in USD minor units, days in the owner's zone (revenue months in UTC
 * days, like the stored daily revenue).
 */
export interface PublicHistory {
  /** The owner's today, the last day of every series. */
  today: string;
  /** Every one of the last PUBLIC_SERIES_DAYS days, oldest first. */
  revenueDaily: RevenuePoint[];
  /** The last 52 weeks, each ending on today's weekday. */
  revenueWeekly: RevenuePoint[];
  /** Calendar months from the first day of revenue history to today. */
  revenueMonthly: RevenuePoint[];
  /** Days with snapshots in the last 364, the latest rates. */
  mrrDaily: MrrDay[];
  /** Each month's last snapshot (the total of every connection's latest by then), oldest first. */
  mrrMonthly: MrrDay[];
}

/**
 * What a published product's page and badge show: worked out when one of its connections finishes
 * a sync (or the product changes) and stored as JSON in `public_products.stats`, so a public
 * request reads one row. Like the dashboard narrowed to the product's connections, in USD, over 30
 * days, without demo or test-mode connections. Owner-typed text is not in here.
 */
export interface PublicProductStats {
  /** Shape version; a page that can't read it treats the product as not computed yet. */
  v: 1;
  currency: 'USD';
  /** Against the nearest snapshot to 30 days ago, like the dashboard. */
  mrr: Kpi;
  activeSubscriptions: Kpi;
  /** Net revenue over the last 30 days, against the 30 before. */
  revenue: Kpi;
  /** The chart's series; never sent to a visitor who isn't signed in, apart from the open view. */
  history: PublicHistory;
  /**
   * Net revenue over all the history hoomuch holds for these connections, each day at its own rate:
   * from `revenueSince`, not the business's whole life (the first sync reads 90 days back).
   */
  revenueTotal: number;
  /** The first day of that revenue history; null when there's none. */
  revenueSince: string | null;
  /** Providers behind the figures, biggest MRR first, each once. */
  providers: ProviderId[];
  /** The earliest snapshot day among the connections: how far back the figures are verified. */
  since: string | null;
  /** The oldest of the connections' last successful syncs (epoch ms); null before any. */
  syncedAt: number | null;
  /** A connection's latest sync reported an estimated or incomplete figure (`MetricsSnapshot.warnings`). */
  estimated: boolean;
  /** A connection has no daily revenue history (RevenueCat without Charts access), so revenue leaves it out. */
  revenuePartial: boolean;
  /** Currencies without a rate, left out of the totals. */
  missingFx: string[];
  computedAt: number;
}

/** The stored stats when they're the shape this build reads, else null. */
export function parsePublicStats(json: string | null | undefined): PublicProductStats | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<PublicProductStats> | null;
    return v && v.v === 1 && v.currency === 'USD' && v.mrr && v.revenue && v.activeSubscriptions && v.history?.revenueDaily
      ? (v as PublicProductStats)
      : null;
  } catch {
    return null;
  }
}

/** What the page sends to everyone: the figures, and the open view's series instead of the history. */
export type PublicFigures = Omit<PublicProductStats, 'history'> & { openSeries: RevenuePoint[] };

export function publicFigures(stats: PublicProductStats): PublicFigures {
  const { history, ...figures } = stats;
  return { ...figures, openSeries: history.revenueDaily.slice(-30) };
}
