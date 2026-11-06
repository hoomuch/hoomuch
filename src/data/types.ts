/**
 * READ-MODEL CONTRACT between Data Plane (producer) and Experience (consumer).
 * Owner: Lead — changes need Lead approval (SPEC.md §9.1).
 *
 * Conventions: money values are integer minor units in `currency` (the user's display
 * currency) unless a field says otherwise; timestamps are epoch ms; days are 'YYYY-MM-DD' UTC.
 */

import type { ConnectionStatus } from '../db/queries';
import type { ProviderId } from '../providers/types';

export type RangeDays = 7 | 30 | 90;
export const RANGE_OPTIONS: readonly RangeDays[] = [7, 30, 90];

export function parseRange(v: string | undefined | null): RangeDays {
  const n = Number(v);
  return n === 7 || n === 90 ? n : 30;
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
  day: string;
  /** Net (gross − refunds) across connections. */
  total: number;
  /** connectionId → net amount. Connections with no revenue that day may be absent. */
  byConnection: Record<string, number>;
}

export interface MrrDay {
  day: string;
  total: number;
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
  /** Exactly `rangeDays` entries, oldest → newest, zero-filled. */
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
  /** 'YYYY-MM' (UTC). */
  month: string;
  /** Display currency. */
  currency: string;
  /** UTC day the month was read on. */
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
  description: string | null;
}

export interface TransactionPage {
  /** Display currency. */
  currency: string;
  provider: ProviderId | null;
  /** One UTC day ('YYYY-MM-DD') the list is narrowed to, or null for every day. */
  day?: string | null;
  items: TransactionRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
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
