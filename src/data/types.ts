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
  /** Exactly `rangeDays` entries, oldest → newest, zero-filled. */
  revenueSeries: RevenueDay[];
  /** Days in the window that have snapshots, oldest → newest (may be sparse early on). */
  mrrSeries: MrrDay[];
  fx: {
    /** Day of the FX table used, null if none was needed / available. */
    asOf: string | null;
    /** Currencies that couldn't be converted and were left out of totals. */
    missing: string[];
  };
  /**
   * Human-readable notices the structured fields can't express (empty today). Not repeated here:
   * sync problems (breakdown status / lastError / lastSyncedAt), currencies without a rate
   * (fx.missing) and providers without daily revenue (BreakdownRow.periodRevenue). The dashboard
   * turns those into sentences next to the figure they affect.
   */
  warnings: string[];
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
  kind: 'cron' | 'manual' | 'initial';
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
}
