/**
 * Realistic, deterministic read-model fixtures. Owner: Experience.
 * Used by view tests (test/views) and by the landing page's live demo (`fixtureDashboard` with
 * `now = Date.now()`). Everything else here is test-only.
 */

import {
  revenueInSteps,
  revenueStep,
  type BreakdownRow,
  type ConnectionDetail,
  type ConnectionSummary,
  type DashboardData,
  type MrrDay,
  type ProductBreakdown,
  type ProductMrrBreakdown,
  type RangeDays,
  type RevenueDay,
  type TransactionPage,
  type TransactionRow,
} from '../data/types';
import { addDays, dayKey, dayStart, DAY, HOUR, MINUTE } from '../lib/time';

/** Fixed "now" so fixtures (and their screenshots) are stable: 2026-11-05 10:30 UTC. */
export const FIXTURE_NOW = Date.UTC(2026, 10, 5, 10, 30);

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIXTURE_CONNECTIONS: ConnectionSummary[] = [
  {
    id: '6f1c2b8e-3a4d-4c5e-9f60-1a2b3c4d5e01',
    name: 'Acme Analytics',
    provider: 'stripe',
    color: '#635BFF',
    dotClass: 'bg-[#635BFF]',
    status: 'ok',
    lastSyncedAt: FIXTURE_NOW - 4 * MINUTE,
    lastError: null,
    testMode: false,
  },
  {
    id: '6f1c2b8e-3a4d-4c5e-9f60-1a2b3c4d5e02',
    name: 'Habit — iOS',
    provider: 'revenuecat',
    color: '#F2545B',
    dotClass: 'bg-[#F2545B]',
    status: 'ok',
    lastSyncedAt: FIXTURE_NOW - 27 * MINUTE,
    lastError: null,
    testMode: false,
  },
  {
    id: '6f1c2b8e-3a4d-4c5e-9f60-1a2b3c4d5e03',
    name: 'Pagekit',
    provider: 'lemonsqueezy',
    color: '#AD7D00',
    dotClass: 'bg-[#AD7D00]',
    status: 'error',
    lastSyncedAt: FIXTURE_NOW - 3 * HOUR,
    lastError: 'Lemon Squeezy rejected the key. Check that you pasted all of it and that it hasn’t been revoked.',
    testMode: false,
  },
  {
    id: '6f1c2b8e-3a4d-4c5e-9f60-1a2b3c4d5e04',
    name: 'Stripe sandbox',
    provider: 'stripe',
    color: '#635BFF',
    dotClass: 'bg-[#635BFF]',
    status: 'syncing',
    lastSyncedAt: null,
    lastError: null,
    testMode: true,
  },
];

/** Per-connection profile: today's MRR (USD cents), growth over 90 days (revenue grows with it), subs, trials, today's daily revenue. */
const PROFILES = [
  { mrr: 482_000, growth: 0.11, subs: 131, trials: 9, dailyAvg: 15_800, refundEvery: 9 },
  { mrr: 231_000, growth: 0.18, subs: 402, trials: 37, dailyAvg: 7_900, refundEvery: 14 },
  { mrr: 196_000, growth: 0.04, subs: 74, trials: 4, dailyAvg: 6_400, refundEvery: 11 },
] as const;

function windowDays(range: number, now: number): string[] {
  const today = dayKey(now);
  const out: string[] = [];
  for (let i = range - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

function mrrOn(profileIdx: number, daysAgo: number): number {
  const p = PROFILES[profileIdx]!;
  const r = rng(1000 + profileIdx * 97 + daysAgo);
  const trend = p.mrr / (1 + p.growth * (daysAgo / 90));
  return Math.round(trend * (1 + (r() - 0.5) * 0.006));
}

function revenueOn(profileIdx: number, day: string, now: number): number {
  const p = PROFILES[profileIdx]!;
  const n = Math.round(dayStart(day) / DAY);
  const r = rng(n * 31 + profileIdx);
  const weekday = new Date(dayStart(day)).getUTCDay();
  const weekendDip = weekday === 0 || weekday === 6 ? 0.7 : 1;
  // Revenue grows along MRR's trend (mrrOn), so a year of demo revenue rises with it.
  const daysAgo = Math.round((dayStart(dayKey(now)) - dayStart(day)) / DAY);
  const avg = p.dailyAvg / (1 + p.growth * (daysAgo / 90));
  let v = avg * weekendDip * (0.55 + r() * 0.9);
  if (r() < 0.06) v *= 2.6; // annual renewals spike
  if (n % p.refundEvery === 0) v -= avg * (0.4 + r() * 0.5);
  return Math.round(v);
}

export type FixtureState = 'full' | 'empty' | 'sparse' | 'warnings' | 'single';

/** Pagekit's plans (Lemon Squeezy names them "Product — Variant"): share of its revenue, price in cents. */
const PAGEKIT_PLANS = [
  { name: 'Pagekit Pro — Monthly', weight: 0.52, price: 1_900 },
  { name: 'Pagekit Pro — Yearly', weight: 0.31, price: 19_000 },
  { name: 'Pagekit Team — Monthly', weight: 0.17, price: 4_900 },
] as const;

/**
 * The product split of a fixture breakdown: Lemon Squeezy rows by plan, the rest (Stripe and
 * RevenueCat don't report product names) under "No product name".
 */
function fixtureProducts(breakdown: BreakdownRow[]): ProductBreakdown {
  const rows: ProductBreakdown['rows'] = [];
  let unnamed = 0;
  const unnamedBy: Array<{ name: string; revenue: number }> = [];
  const PROVIDER_NAMES: Partial<Record<BreakdownRow['provider'], string>> = { stripe: 'Stripe', revenuecat: 'RevenueCat' };
  for (const b of breakdown) {
    if (b.revenue === null) continue;
    if (b.provider !== 'lemonsqueezy') {
      unnamed += b.revenue;
      if (b.revenue !== 0) unnamedBy.push({ name: PROVIDER_NAMES[b.provider] ?? b.provider, revenue: b.revenue });
      continue;
    }
    let left = b.revenue;
    PAGEKIT_PLANS.forEach((plan, i) => {
      const revenue = i === PAGEKIT_PLANS.length - 1 ? left : Math.round(b.revenue! * plan.weight);
      left -= revenue;
      rows.push({
        name: plan.name,
        connectionId: b.id,
        connectionName: b.name,
        dotClass: b.dotClass,
        revenue,
        charges: Math.max(1, Math.round(revenue / plan.price)),
        sharePct: 0,
      });
    });
  }
  rows.sort((a, b) => b.revenue - a.revenue);
  const earned = rows.reduce((s, r) => s + Math.max(0, r.revenue), 0) + Math.max(0, unnamed);
  const share = (v: number) => (v > 0 && earned > 0 ? Math.round((v / earned) * 1000) / 10 : 0);
  for (const r of rows) r.sharePct = share(r.revenue);
  return {
    rows,
    more: null,
    unnamed: { revenue: unnamed, sharePct: share(unnamed) },
    unnamedProviders: unnamedBy.sort((a, b) => b.revenue - a.revenue).map((u) => u.name),
    named: breakdown.some((b) => b.provider === 'lemonsqueezy'),
  };
}

/** Acme Analytics' Stripe products: share of its MRR, and its subscriptions on each (131 in all). */
const ACME_PLANS = [
  { name: 'Acme Pro', weight: 0.55, subs: 54 },
  { name: 'Acme Team', weight: 0.3, subs: 8 },
  { name: 'Acme Starter', weight: 0.15, subs: 69 },
] as const;

/**
 * The MRR split of a fixture breakdown: the Stripe connection with MRR (Acme Analytics) by product,
 * the rest (RevenueCat and Lemon Squeezy don't split MRR) under "No product name".
 */
function fixtureProductMrr(breakdown: BreakdownRow[]): ProductMrrBreakdown {
  const rows: ProductMrrBreakdown['rows'] = [];
  const unnamedBy: Array<{ name: string; mrr: number }> = [];
  const PROVIDER_NAMES: Partial<Record<BreakdownRow['provider'], string>> = { revenuecat: 'RevenueCat', lemonsqueezy: 'Lemon Squeezy' };
  let unnamed = 0;
  let total = 0;
  for (const b of breakdown) {
    total += b.mrr;
    if (b.provider !== 'stripe') {
      unnamed += b.mrr;
      if (b.mrr > 0) unnamedBy.push({ name: PROVIDER_NAMES[b.provider] ?? b.provider, mrr: b.mrr });
      continue;
    }
    let left = b.mrr;
    ACME_PLANS.forEach((plan, i) => {
      const mrr = i === ACME_PLANS.length - 1 ? left : Math.round(b.mrr * plan.weight);
      left -= mrr;
      rows.push({ name: plan.name, connectionId: b.id, connectionName: b.name, dotClass: b.dotClass, mrr, subscriptions: plan.subs, sharePct: 0 });
    });
  }
  rows.sort((a, b) => b.mrr - a.mrr);
  const share = (v: number) => (v > 0 && total > 0 ? Math.round((v / total) * 1000) / 10 : 0);
  for (const r of rows) r.sharePct = share(r.mrr);
  return {
    rows,
    more: null,
    unnamed: { mrr: unnamed, sharePct: share(unnamed) },
    unnamedProviders: unnamedBy.sort((a, b) => b.mrr - a.mrr).map((u) => u.name),
    needsPermission: [],
    split: rows.length > 0,
  };
}

const NO_PRODUCT_MRR: ProductMrrBreakdown = {
  rows: [],
  more: null,
  unnamed: { mrr: 0, sharePct: 0 },
  unnamedProviders: [],
  needsPermission: [],
  split: false,
};

const NO_PRODUCTS: ProductBreakdown = {
  rows: [],
  more: null,
  unnamed: { revenue: 0, sharePct: 0 },
  unnamedProviders: [],
  named: false,
};

/** A complete DashboardData, in USD, for the given window. */
export function fixtureDashboard(rangeDays: RangeDays = 30, state: FixtureState = 'full', now = FIXTURE_NOW): DashboardData {
  const days = windowDays(rangeDays, now);
  const conns = (state === 'single' ? FIXTURE_CONNECTIONS.slice(0, 1) : FIXTURE_CONNECTIONS.slice(0, 3)).slice();
  const zeroKpi = { value: 0, previous: null, deltaPct: null };

  if (state === 'empty') {
    return {
      currency: 'USD',
      rangeDays,
      generatedAt: now,
      hasConnections: false,
      kpis: { mrr: zeroKpi, arr: zeroKpi, activeSubscriptions: zeroKpi, activeTrials: zeroKpi, revenue: zeroKpi },
      breakdown: [],
      products: NO_PRODUCTS,
      productMrr: NO_PRODUCT_MRR,
      revenueSeries: revenueInSteps(
        days.map((day) => ({ day, total: 0, byConnection: {} })),
        revenueStep(rangeDays),
      ),
      mrrSeries: [],
      fx: { asOf: null, daily: false, missing: [] },
      days: { timeZone: 'UTC', otherZones: [] },
      warnings: [],
    };
  }

  // Sparse = a connection added 2 days ago: only the last 3 days have data.
  const firstDataIdx = state === 'sparse' ? days.length - 3 : 0;

  const revenueSeries: RevenueDay[] = days.map((day, i) => {
    const byConnection: Record<string, number> = {};
    let total = 0;
    if (i >= firstDataIdx) {
      conns.forEach((c, ci) => {
        const v = revenueOn(ci, day, now);
        byConnection[c.id] = v;
        total += v;
      });
    }
    return { day, total, byConnection };
  });

  const mrrSeries: MrrDay[] = days
    .map((day, i) => ({ day, i }))
    .filter(({ i }) => i >= firstDataIdx)
    .map(({ day, i }) => ({
      day,
      total: conns.reduce((s, _c, ci) => s + mrrOn(ci, days.length - 1 - i), 0),
    }));

  const kpiFrom = (value: number, previous: number | null) => ({
    value,
    previous,
    deltaPct: previous ? ((value - previous) / previous) * 100 : null,
  });

  const mrrNow = mrrSeries.at(-1)?.total ?? 0;
  const mrrStart = state === 'sparse' ? null : (mrrSeries[0]?.total ?? null);
  const subsNow = conns.reduce((s, _c, ci) => s + PROFILES[ci]!.subs, 0);
  const trialsNow = conns.reduce((s, _c, ci) => s + PROFILES[ci]!.trials, 0);
  const revenueNow = revenueSeries.reduce((s, d) => s + d.total, 0);
  const revenuePrev =
    state === 'sparse'
      ? null
      : windowDays(rangeDays, now - rangeDays * DAY).reduce((s, day) => s + conns.reduce((t, _c, ci) => t + revenueOn(ci, day, now), 0), 0);

  const breakdown: BreakdownRow[] = conns
    .map((c, ci) => {
      const mrr = mrrOn(ci, 0);
      // 'warnings': the RevenueCat connection has no daily history, only its own 28-day total.
      const periodOnly = state === 'warnings' && c.provider === 'revenuecat';
      return {
        ...c,
        mrr,
        activeSubscriptions: PROFILES[ci]!.subs,
        activeTrials: c.provider === 'lemonsqueezy' ? null : PROFILES[ci]!.trials,
        revenue: periodOnly ? null : revenueSeries.reduce((s, d) => s + (d.byConnection[c.id] ?? 0), 0),
        periodRevenue: periodOnly ? { amount: 221_400, days: 28 } : null,
        sharePct: mrrNow ? (mrr / mrrNow) * 100 : 0,
      };
    })
    .sort((a, b) => b.mrr - a.mrr);

  return {
    currency: 'USD',
    rangeDays,
    generatedAt: now,
    hasConnections: true,
    kpis: {
      mrr: kpiFrom(mrrNow, mrrStart),
      arr: kpiFrom(mrrNow * 12, mrrStart === null ? null : mrrStart * 12),
      activeSubscriptions: kpiFrom(subsNow, state === 'sparse' ? null : Math.round(subsNow * 0.94)),
      activeTrials: kpiFrom(trialsNow, state === 'sparse' ? null : trialsNow + 6),
      revenue: kpiFrom(revenueNow, revenuePrev),
    },
    breakdown,
    products: fixtureProducts(breakdown),
    productMrr: fixtureProductMrr(breakdown),
    revenueSeries: revenueInSteps(revenueSeries, revenueStep(rangeDays)),
    mrrSeries,
    fx: { asOf: '2026-11-04', daily: true, missing: state === 'warnings' ? ['ARS'] : [] },
    days: { timeZone: 'UTC', otherZones: [] },
    // Sync problems come from the connections (Pagekit is in error); FX from fx.missing.
    warnings: [],
  };
}

const PLANS = ['Pro monthly', 'Pro yearly', 'Team monthly', 'Starter monthly', 'Premium (iOS)', 'Lifetime'];

export function fixtureTransactions(page = 1, provider: TransactionPage['provider'] = null): TransactionPage {
  const pageSize = 50;
  const all: TransactionRow[] = [];
  const conns = FIXTURE_CONNECTIONS.slice(0, 3);
  const r = rng(42);
  let t = FIXTURE_NOW - 7 * MINUTE;
  for (let i = 0; i < 140; i++) {
    const c = conns[Math.floor(r() * conns.length)]!;
    const refund = r() < 0.07;
    const eur = c.provider === 'lemonsqueezy';
    const base = [900, 1200, 2900, 9900, 4900][Math.floor(r() * 5)]!;
    const amount = refund ? -base : base;
    all.push({
      connectionId: c.id,
      connectionName: c.name,
      provider: c.provider,
      color: c.color,
      dotClass: c.dotClass,
      externalId: `txn_${(i + 1).toString(36).padStart(6, '0')}`,
      occurredAt: t,
      type: refund ? 'refund' : 'charge',
      amount,
      originalCurrency: eur ? 'EUR' : 'USD',
      displayAmount: eur ? Math.round(amount * 1.08) : amount,
      description: PLANS[Math.floor(r() * PLANS.length)]!,
    });
    t -= Math.floor(r() * 5 * HOUR) + 3 * MINUTE;
  }
  const filtered = provider ? all.filter((x) => x.provider === provider) : all;
  const start = (page - 1) * pageSize;
  return {
    currency: 'USD',
    provider,
    items: filtered.slice(start, start + pageSize),
    page,
    pageSize,
    hasMore: filtered.length > start + pageSize,
    // Fixtures page by number; the cursors only matter against D1.
    nextCursor: null,
    prevCursor: null,
  };
}

export function fixtureConnectionDetail(idx = 0): ConnectionDetail {
  const c = FIXTURE_CONNECTIONS[idx] ?? FIXTURE_CONNECTIONS[0]!;
  const today = dayKey(FIXTURE_NOW);
  const profile = PROFILES[Math.min(idx, 2)]!;
  return {
    ...c,
    createdAt: FIXTURE_NOW - 41 * DAY,
    keyHint: c.provider === 'demo' ? null : '…a1b2',
    config: c.provider === 'lemonsqueezy' ? { storeId: '18234', storeCurrencies: '{"18234":"EUR"}', testMode: 'false' } : c.provider === 'revenuecat' ? { projectId: 'proj1a2b3c4d', reportingCurrency: 'USD', revenueHistory: 'daily' } : {},
    currency: 'USD',
    snapshots: Array.from({ length: 14 }, (_, i) => ({
      day: addDays(today, -i),
      mrr: mrrOn(Math.min(idx, 2), i),
      activeSubscriptions: profile.subs - Math.floor(i / 3),
      activeTrials: c.provider === 'lemonsqueezy' ? null : profile.trials - (i % 4),
    })),
    recentRuns: [
      { kind: 'cron', startedAt: FIXTURE_NOW - 4 * MINUTE, finishedAt: FIXTURE_NOW - 4 * MINUTE + 2_300, ok: true, events: 12, message: null },
      { kind: 'manual', startedAt: FIXTURE_NOW - 2 * HOUR, finishedAt: FIXTURE_NOW - 2 * HOUR + 1_900, ok: true, events: 3, message: null },
      {
        kind: 'cron',
        startedAt: FIXTURE_NOW - 5 * HOUR,
        finishedAt: FIXTURE_NOW - 5 * HOUR + 30_000,
        ok: false,
        events: 0,
        message: 'Stripe is rate-limiting requests. Try again in a minute.',
      },
      { kind: 'initial', startedAt: FIXTURE_NOW - 41 * DAY, finishedAt: FIXTURE_NOW - 41 * DAY + 48_000, ok: true, events: 1_204, message: null },
    ],
    warnings: [],
    webhook: c.provider === 'stripe' ? { path: null, lastCallAt: null } : null,
  };
}
