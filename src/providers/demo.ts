/**
 * Demo adapter. Owner: Data Plane. SPEC §6.4.
 *
 * No key, no network. Everything is a pure function of (config.seed, config.anchor, day), so
 * repeated syncs are idempotent: the same day always yields the same subscribers, the same
 * charges with the same external ids, and the same refunds. USD + EUR + GBP, slow growth,
 * an occasional refund. Data flows through the real pipeline (snapshots, transactions,
 * daily_revenue) like any other provider.
 */

import { addToMoney, normalizeToMonthly, type BillingInterval, type MoneyMap } from '../lib/money';
import { DAY, addDays, dayKey, dayStart } from '../lib/time';
import type {
  ConnectionConfig,
  MetricsSnapshot,
  ProviderAdapter,
  RevenueEvent,
  RevenuePage,
} from './types';

interface DemoPlan {
  key: string;
  name: string;
  currency: string;
  /** Minor units per billing period. */
  price: number;
  interval: Extract<BillingInterval, 'month' | 'year'>;
  /** Subscribers on the anchor day. */
  base: number;
  /** Daily compound growth. */
  growth: number;
}

export const DEMO_PLANS: readonly DemoPlan[] = [
  { key: 'pro-m', name: 'Pro (monthly)', currency: 'USD', price: 1200, interval: 'month', base: 180, growth: 0.0016 },
  { key: 'pro-y', name: 'Pro (yearly)', currency: 'USD', price: 12000, interval: 'year', base: 64, growth: 0.0022 },
  { key: 'team-m', name: 'Team (monthly)', currency: 'EUR', price: 2900, interval: 'month', base: 36, growth: 0.0019 },
  { key: 'starter-m', name: 'Starter (monthly)', currency: 'GBP', price: 700, interval: 'month', base: 92, growth: 0.0009 },
  { key: 'starter-y', name: 'Starter (yearly)', currency: 'GBP', price: 7000, interval: 'year', base: 21, growth: 0.0012 },
];

/** Days of history the demo exposes (SPEC F-05 / F-07). */
export const DEMO_HISTORY_DAYS = 90;
const DEFAULT_ANCHOR = '2026-01-01';
const REFUND_PROBABILITY = 0.08;

// ---------- deterministic randomness ----------

/** cyrb53-style string hash → [0, 1). Stateless, so any (seed, day, key) tuple is reproducible. */
function rand(...parts: Array<string | number>): number {
  const str = parts.join('|');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0) * 2 ** 21 + (h1 >>> 11)) / 2 ** 53;
}

interface DemoParams {
  seed: string;
  anchor: string;
  /** Per-seed size multiplier, 0.8–1.25, so two demo connections don't look identical. */
  scale: number;
}

function params(config: ConnectionConfig): DemoParams {
  const seed = config['seed'] || 'demo';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(config['anchor'] ?? '') ? config['anchor']! : DEFAULT_ANCHOR;
  return { seed, anchor, scale: 0.8 + rand(seed, 'scale') * 0.45 };
}

// ---------- the model ----------

function subscribers(p: DemoParams, plan: DemoPlan, day: string): number {
  const t = (dayStart(day) - dayStart(p.anchor)) / DAY;
  const trend = plan.base * p.scale * (1 + plan.growth) ** t;
  const jitter = (rand(p.seed, 'subs', plan.key, day) - 0.5) * 3; // ±1.5 subscribers
  return Math.max(0, Math.round(trend + jitter));
}

function snapshotFor(p: DemoParams, day: string): MetricsSnapshot {
  const mrr: MoneyMap = {};
  let subs = 0;
  for (const plan of DEMO_PLANS) {
    const n = subscribers(p, plan, day);
    subs += n;
    addToMoney(mrr, plan.currency, normalizeToMonthly(plan.price * n, plan.interval));
  }
  const revenue: MoneyMap = {};
  for (let i = 0; i < 30; i++) {
    for (const e of eventsForDay(p, addDays(day, -i))) addToMoney(revenue, e.currency, e.amount);
  }
  return {
    mrr,
    activeSubscriptions: subs,
    activeTrials: Math.round(subs * (0.05 + rand(p.seed, 'trials', day) * 0.03)),
    revenuePeriod: revenue,
    revenuePeriodDays: 30,
    newCustomers: Math.round(subs * (0.07 + rand(p.seed, 'new', day) * 0.03)),
  };
}

function feeFor(amount: number): number {
  return Math.round(amount * 0.029) + 30;
}

/** Every event of one UTC day, regardless of the current time (callers filter by `now`). */
function eventsForDay(p: DemoParams, day: string): RevenueEvent[] {
  const start = dayStart(day);
  const out: RevenueEvent[] = [];
  for (const plan of DEMO_PLANS) {
    const periodDays = plan.interval === 'month' ? 30 : 365;
    const expected = subscribers(p, plan, day) / periodDays;
    const count = Math.floor(expected) + (rand(p.seed, 'extra', plan.key, day) < expected % 1 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      out.push({
        externalId: `demo:${day}:${plan.key}:${i}`,
        occurredAt: start + Math.floor(rand(p.seed, 'at', plan.key, day, i) * DAY),
        type: 'charge',
        amount: plan.price,
        currency: plan.currency,
        fee: feeFor(plan.price),
        description: plan.name,
      });
    }
  }
  if (rand(p.seed, 'refund?', day) < REFUND_PROBABILITY) {
    const plan = DEMO_PLANS[Math.floor(rand(p.seed, 'refund-plan', day) * DEMO_PLANS.length)]!;
    out.push({
      externalId: `demo:${day}:refund:0`,
      occurredAt: start + Math.floor(rand(p.seed, 'refund-at', day) * DAY),
      type: 'refund',
      amount: -plan.price,
      currency: plan.currency,
      fee: null,
      description: plan.name,
    });
  }
  return out;
}

/**
 * Snapshots for the `days` days before `now`'s day (oldest first, today excluded), so the
 * sync engine can give a fresh demo connection a full MRR trend on its first run.
 */
export function demoSnapshotHistory(
  config: ConnectionConfig,
  now: number,
  days: number = DEMO_HISTORY_DAYS,
): Array<{ day: string; snapshot: MetricsSnapshot }> {
  const p = params(config);
  const today = dayKey(now);
  const out: Array<{ day: string; snapshot: MetricsSnapshot }> = [];
  for (let i = days; i >= 1; i--) {
    const day = addDays(today, -i);
    out.push({ day, snapshot: snapshotFor(p, day) });
  }
  return out;
}

function randomSeed(): string {
  return crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(36), '');
}

export const demoAdapter: ProviderAdapter = {
  id: 'demo',

  async verify(_input, ctx) {
    return {
      ok: true,
      accountLabel: 'Demo data',
      config: { seed: randomSeed(), anchor: dayKey(ctx.now()) },
      testMode: false,
      warnings: [],
    };
  },

  async fetchSnapshot(input, ctx) {
    return snapshotFor(params(input.config), dayKey(ctx.now()));
  },

  async fetchRevenue(input, req, ctx): Promise<RevenuePage> {
    const p = params(input.config);
    const now = ctx.now();
    const today = dayKey(now);
    // Never older than the demo's history window, whatever `since` says.
    const since = Math.max(req.since, dayStart(addDays(today, -DEMO_HISTORY_DAYS)));
    const events: RevenueEvent[] = [];
    for (let day = dayKey(since); day <= today; day = addDays(day, 1)) {
      for (const e of eventsForDay(p, day)) {
        if (e.occurredAt >= since && e.occurredAt <= now) events.push(e);
      }
    }
    return { events, daily: [], nextCursor: null, done: true };
  },
};
