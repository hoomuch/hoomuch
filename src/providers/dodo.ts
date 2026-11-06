/**
 * Dodo Payments adapter. Owner: Data Plane. SPEC.md §6.7.
 *
 * REST API, https://docs.dodopayments.com/api-reference (OpenAPI "public" 1.120.x, read on 2026-11-05).
 * Facts this file relies on:
 *   - Hosts: live https://live.dodopayments.com, test https://test.dodopayments.com; `Authorization: Bearer <key>`.
 *     Keys are prefixed dodo_live_ / dodo_test_, and a prefixed key sent to the other host gets 401. Keys made
 *     before prefixes existed have none and "keep working": verify finds their mode by trying live, then test,
 *     and stores it in config.
 *   - Every key has None / Read / Write per resource. A missing one answers 403 INSUFFICIENT_PERMISSION, whose
 *     message names it ("Required: `{resource}:{read|write}`"). Other 403s: IP_ADDRESS_NOT_ALLOWED (the key has
 *     an IP allowlist) and MERCHANT_NOT_LIVE (live key, live payments not enabled yet). Errors are {code, message}.
 *   - Lists page with `page_number` (0-based) and `page_size` (max 100) and return `{items}` only: no total, no
 *     has_more. A short page is the last one.
 *   - Rate limit: 40 requests/s burst and 240/min sustained per business, shared by all its keys; 429 carries
 *     X-RateLimit-Reset, not Retry-After.
 *   - Subscription list item: `status` ∈ pending | active | on_hold | paused | cancelled | failed | expired |
 *     past_due; `recurring_pre_tax_amount` (int, "amount charged before tax for each recurring payment in the
 *     currency's smallest unit"); `tax_inclusive` ("Indicates if the recurring_pre_tax_amount is tax inclusive");
 *     `payment_frequency_interval` Day | Week | Month | Year + `payment_frequency_count` (the billing cadence;
 *     `subscription_period_*` is the term after which it expires); `trial_period_days` (0 = no trial);
 *     `created_at`; `next_billing_date`; `cancel_at_next_billing_date`; `on_demand`; `currency`. It also embeds
 *     the customer's name, email and billing address, which this file never reads.
 *   - There is no trialing status. The docs: "The subscription object has no trial status field… check whether
 *     next_billing_date is still within the trial window."
 *   - Payment list items carry `total_amount` ("including tax") but not the tax; `tax` exists only on
 *     GET /payments/{id}. The balance ledger (GET /balances/ledger, `created_at_gte` / `created_at_lte`) books
 *     every movement of the business's wallets (USD, EUR, GBP) in the wallet's currency, with the tax as its own
 *     entry. Directions per the Balances page: payment (+), tax (−), tax_reversal (+, "when a payment is refunded
 *     or a dispute is reversed"), refund (−), refund_reversal (+), dispute (−, "deducted and held while the
 *     dispute is open"), dispute_reversal (+, won), plus fees, payouts, credits, adjustments, reserves.
 *     Dodo's own Reports page splits the same ledger into "Payments received", "Refunds issued", "Disputes lost",
 *     "Fees deducted" and "Tax deducted (tax, less any tax reversal)".
 *
 * Decisions (SPEC §6.7):
 *   - MRR and active subscriptions: status active or past_due. past_due only exists while a merchant-enabled grace
 *     period is open: the customer keeps access and retries continue, so they are still expected to pay.
 *     on_hold ("renewals stopped, access revoked"), paused, pending, cancelled, failed and expired are not
 *     paying. A subscription set to cancel at the next billing date stays active, and counts, until then.
 *   - Trials: an active / past_due subscription with trial_period_days > 0 whose next_billing_date is not later
 *     than created_at + trial_period_days (+1 h slack) has not been charged the recurring price yet → trial.
 *     Paid trials (trial_amount) are trials too. A trial extended by moving next_billing_date reads as paying.
 *   - Amount: recurring_pre_tax_amount as is, normalized by payment_frequency_interval / _count. It is the
 *     per-payment amount, so it is not multiplied by `quantity`. Subscriptions with a $0 amount (pure usage
 *     billing, 100 % discounts) and on-demand subscriptions (no scheduled charge) add no MRR and are not counted
 *     as active. tax_inclusive amounts contain the tax and are counted as they are (logged): the API gives no
 *     rate to back it out.
 *   - Revenue: the balance ledger, aggregated per UTC day and wallet currency (revenueHistory 'daily'):
 *       gross   = payment − tax                                                   (sales without tax)
 *       refunds = refund − refund_reversal + dispute − dispute_reversal − tax_reversal
 *     Lost (and still open) disputes count as refunds; a won dispute's reversal cancels it. Fees, payouts,
 *     credits, adjustments, currency conversion and reserves are ignored (SPEC §6: fees are not deducted).
 *     A read day without revenue entries is reported as 0 USD (every business has a USD wallet), so an idle
 *     account still shows history. The verify config sets revenueHistory=daily for the calendar.
 *     Per-payment events would need one GET /payments/{id} per payment for the tax, which no sync budget allows.
 *
 * Request plan:
 *   verify        2 requests: subscriptions and balances/ledger (page_size=1 each). An unprefixed key whose live
 *                 probe gets 401 is retried on the test host: 3. 403s name the missing permission.
 *   fetchSnapshot status=active, then status=past_due (page_size=100, page_number 0, 1, … until a short page),
 *                 at most DODO_SNAPSHOT_PAGE_BUDGET requests (~16,000 subscriptions).
 *                 Running out of budget throws BudgetExhaustedError: a partial MRR would be wrong.
 *   fetchRevenue  balance ledger over [midnight UTC of `since`, now], in 7-day slices newest → oldest, one request
 *                 per 100 entries. A slice's days are emitted once the whole slice is read; the cursor carries the
 *                 slice's partial sums. A 429 ends the call with the cursor ('yield').
 */

import { addToMoney, normalizeCurrency, normalizeToMonthly, type BillingInterval, type MoneyMap } from '../lib/money';
import { DAY, HOUR, addDays, dayKey, dayStart } from '../lib/time';
import { RateLimitedError, buildUrl, capBudget, fetchJson, hasBudget, type QueryValue } from './http';
import {
  ProviderError,
  type ConnectionConfig,
  type ConnectionInput,
  type DailyRevenuePoint,
  type MetricsSnapshot,
  type ProviderAdapter,
  type ProviderContext,
  type RevenuePage,
  type RevenueRequest,
  type VerifyResult,
} from './types';

export const DODO_LIVE_BASE = 'https://live.dodopayments.com';
export const DODO_TEST_BASE = 'https://test.dodopayments.com';

const PROVIDER = 'Dodo Payments';
/** Documented maximum for every list endpoint. */
const PAGE_SIZE = 100;
/**
 * Most requests one snapshot makes (`capBudget`), below the sync's own budget. With the revenue phase's 20
 * right after it, a sync stays within 3/4 of the 240-a-minute limit that every key of the business shares,
 * leaving the merchant's own integration room, so a bigger account fails with "more subscriptions than one
 * sync can read" rather than with 429s for both.
 */
export const DODO_SNAPSHOT_PAGE_BUDGET = 160;
/** Ledger days read per slice; a slice's days are emitted together once it has been read in full. */
const SLICE_DAYS = 7;
/** next_billing_date may sit a little after created_at + trial_period_days. */
const TRIAL_SLACK_MS = HOUR;

// Registry wording (registry.ts → permissions), used verbatim in 403 messages.
const PERM_SUBSCRIPTIONS = 'Subscriptions: Read';
const PERM_BALANCES = 'Balances: Read';

/** Config keys this adapter writes. */
const CONFIG_TEST_MODE = 'testMode';
/** Read by the calendar for providers with revenueHistory 'daily' (same convention as RevenueCat). */
const CONFIG_REVENUE_HISTORY = 'revenueHistory';

export const LEGACY_KEY_WARNING =
  'This key was created before Dodo Payments added per-resource access, so it may be able to change data as well as read it. A new key with Read on Subscriptions and Balances only is safer. You can replace the key on this page.';

// ---------- small readers (the API is untyped JSON; never trust shapes) ----------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

function time(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function currencyOf(v: unknown): string | null {
  const c = typeof v === 'string' ? normalizeCurrency(v) : '';
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

function unreadable(): ProviderError {
  return new ProviderError('upstream', `${PROVIDER} returned a response hoomuch couldn’t read.`);
}

// ---------- key handling ----------

interface ParsedKey {
  key: string;
  /** From the prefix; null for keys made before prefixes existed. */
  testMode: boolean | null;
}

const PREFIXED_RE = /^dodo_(live|test)_[A-Za-z0-9_.-]+$/;
/** Unprefixed (older) keys: their format isn't documented. Printable ASCII only keeps the header safe. */
const LEGACY_RE = /^[\x21-\x7e]{16,512}$/;
const OTHER_PROVIDER_RE = /^((sk|rk|pk)_(live|test)_|pdl_|polar_|creem_|whsec_|eyJ)/;

function parseKey(raw: string | undefined): ParsedKey | { error: string } {
  const key = (raw ?? '').trim();
  if (!key) return { error: 'Paste a Dodo Payments API key (dodo_live_… or dodo_test_…).' };
  if (/^bearer\s/i.test(key)) return { error: 'Paste only the key itself, without “Bearer”.' };
  const m = PREFIXED_RE.exec(key);
  if (m) return { key, testMode: m[1] === 'test' };
  if (/^dodo_/i.test(key) || OTHER_PROVIDER_RE.test(key) || !LEGACY_RE.test(key)) {
    return { error: 'That doesn’t look like a Dodo Payments API key. It should start with dodo_live_ or dodo_test_.' };
  }
  return { key, testMode: null };
}

interface Auth {
  key: string;
  testMode: boolean;
}

/** Key + mode for sync calls. Unprefixed keys use the mode verify stored (live when missing). */
function requireAuth(input: ConnectionInput): Auth {
  const parsed = parseKey(input.credentials['apiKey']);
  if ('error' in parsed) throw new ProviderError('invalid_input', parsed.error, { field: 'apiKey' });
  return { key: parsed.key, testMode: parsed.testMode ?? input.config[CONFIG_TEST_MODE] === 'true' };
}

// ---------- HTTP ----------

function baseFor(testMode: boolean): string {
  return testMode ? DODO_TEST_BASE : DODO_LIVE_BASE;
}

/** Dodo-specific 403s; everything else falls through to the shared status mapping. */
function mapDodoError(status: number, body: unknown, detail: string, permission: string): ProviderError | null {
  if (status !== 403) return null;
  const code = isObject(body) ? str(body['code']) : null;
  if (code === 'IP_ADDRESS_NOT_ALLOWED') {
    return new ProviderError(
      'permission',
      'This Dodo Payments key only accepts requests from the IP addresses on its allowlist. hoomuch runs on Cloudflare and has no fixed IP address, so use a key with an empty IP allowlist.',
      { status, field: 'apiKey' },
    );
  }
  if (code === 'MERCHANT_NOT_LIVE') {
    return new ProviderError(
      'permission',
      'Live payments aren’t enabled for this Dodo Payments business yet, so its live data can’t be read. Finish verification in Dodo Payments, or connect a test mode key (dodo_test_…).',
      { status, field: 'apiKey' },
    );
  }
  if (code === 'INSUFFICIENT_PERMISSION' || code === null) {
    const scope = /Required:\s*`?([a-z_]+:(?:read|write))`?/i.exec(detail)?.[1];
    return new ProviderError(
      'permission',
      `The ${PROVIDER} key is missing the “${permission}” permission${scope ? ` (${scope})` : ''}.`,
      { status, field: 'apiKey' },
    );
  }
  return null;
}

function dodoGet(
  ctx: ProviderContext,
  auth: Auth,
  path: string,
  query: Record<string, QueryValue>,
  permission: string,
  rateLimit: 'retry' | 'yield' = 'retry',
): Promise<unknown> {
  return fetchJson<unknown>(ctx, {
    provider: PROVIDER,
    url: buildUrl(baseFor(auth.testMode), path, query),
    headers: { Authorization: `Bearer ${auth.key}` },
    permission,
    rateLimit,
    mapError: (status, body, detail) => mapDodoError(status, body, detail, permission),
  });
}

function itemsOf(body: unknown): unknown[] {
  if (!isObject(body) || !Array.isArray(body['items'])) throw unreadable();
  return body['items'];
}

// ---------- MRR ----------

const INTERVALS: ReadonlySet<string> = new Set<BillingInterval>(['day', 'week', 'month', 'year']);
const SNAPSHOT_STATUSES = ['active', 'past_due'] as const;

export type SubscriptionClass =
  | { kind: 'paying'; currency: string; monthly: number; taxInclusive: boolean }
  | { kind: 'trial' }
  | { kind: 'zero' }
  | { kind: 'on_demand' }
  | { kind: 'unpriced' }
  | { kind: 'not_active' };

/** True while the recurring price hasn't been charged yet (see the header: no trialing status exists). */
function isInTrial(sub: Json, now: number): boolean {
  const days = int(sub['trial_period_days']);
  const created = time(sub['created_at']);
  if (days === null || days <= 0 || created === null) return false;
  const trialEnd = created + days * DAY;
  const next = time(sub['next_billing_date']);
  return next !== null ? next <= trialEnd + TRIAL_SLACK_MS : now < trialEnd;
}

/** SPEC §6 + §6.7: who counts towards MRR / active subscriptions / trials, and for how much. */
export function classifySubscription(sub: Json, now: number): SubscriptionClass {
  const status = str(sub['status']);
  if (status !== 'active' && status !== 'past_due') return { kind: 'not_active' };
  if (sub['on_demand'] === true) return { kind: 'on_demand' };
  if (isInTrial(sub, now)) return { kind: 'trial' };
  const amount = int(sub['recurring_pre_tax_amount']);
  const interval = str(sub['payment_frequency_interval'])?.toLowerCase() ?? '';
  const count = int(sub['payment_frequency_count']);
  const currency = currencyOf(sub['currency']);
  if (amount === null || amount < 0 || !INTERVALS.has(interval) || !currency) return { kind: 'unpriced' };
  if (amount === 0) return { kind: 'zero' };
  const monthly = normalizeToMonthly(amount, interval as BillingInterval, count !== null && count > 0 ? count : 1);
  if (monthly <= 0) return { kind: 'zero' };
  return { kind: 'paying', currency, monthly, taxInclusive: sub['tax_inclusive'] === true };
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  capBudget(ctx, DODO_SNAPSHOT_PAGE_BUDGET);
  const auth = requireAuth(input);
  const now = ctx.now();
  const mrr: MoneyMap = {};
  let activeSubscriptions = 0;
  let activeTrials = 0;
  const stats = { listed: 0, pages: 0, zero: 0, onDemand: 0, unpriced: 0, notActive: 0, taxInclusive: 0, cancelling: 0 };
  const seen = new Set<string>();

  for (const status of SNAPSHOT_STATUSES) {
    for (let page = 0; ; page++) {
      const items = itemsOf(
        await dodoGet(ctx, auth, '/subscriptions', { status, page_size: PAGE_SIZE, page_number: page }, PERM_SUBSCRIPTIONS),
      );
      stats.pages += 1;
      for (const raw of items) {
        if (!isObject(raw)) continue;
        const id = str(raw['subscription_id']);
        if (id) {
          if (seen.has(id)) continue; // moved between the two listings
          seen.add(id);
        }
        stats.listed += 1;
        const c = classifySubscription(raw, now);
        switch (c.kind) {
          case 'paying':
            activeSubscriptions += 1;
            addToMoney(mrr, c.currency, c.monthly);
            if (c.taxInclusive) stats.taxInclusive += 1;
            if (raw['cancel_at_next_billing_date'] === true) stats.cancelling += 1;
            break;
          case 'trial':
            activeTrials += 1;
            break;
          case 'zero':
            stats.zero += 1;
            break;
          case 'on_demand':
            stats.onDemand += 1;
            break;
          case 'unpriced':
            stats.unpriced += 1;
            break;
          case 'not_active':
            stats.notActive += 1;
            break;
        }
      }
      if (items.length < PAGE_SIZE) break;
    }
  }

  ctx.log('dodo_snapshot', {
    ...stats,
    testMode: auth.testMode,
    active: activeSubscriptions,
    trials: activeTrials,
    currencies: Object.keys(mrr),
  });
  return {
    mrr,
    activeSubscriptions,
    activeTrials,
    revenuePeriod: null, // derived from daily_revenue by the sync engine
    revenuePeriodDays: null,
    newCustomers: null,
  };
}

// ---------- revenue (balance ledger → daily points) ----------

/** Sum slots per (day, currency), all ≥ 0 magnitudes except `count`. */
const S_PAYMENT = 0;
const S_TAX = 1;
const S_TAX_REVERSAL = 2;
const S_REFUND = 3;
const S_REFUND_REVERSAL = 4;
const S_DISPUTE = 5;
const S_DISPUTE_REVERSAL = 6;
const S_COUNT = 7;
const SLOTS = 8;

/** Ledger event types that move revenue, with their documented direction (Balances page). */
const COUNTED: Readonly<Record<string, { slot: number; credit: boolean; transaction: boolean }>> = {
  payment: { slot: S_PAYMENT, credit: true, transaction: true },
  tax: { slot: S_TAX, credit: false, transaction: false },
  tax_reversal: { slot: S_TAX_REVERSAL, credit: true, transaction: false },
  refund: { slot: S_REFUND, credit: false, transaction: true },
  refund_reversal: { slot: S_REFUND_REVERSAL, credit: true, transaction: false },
  dispute: { slot: S_DISPUTE, credit: false, transaction: true },
  dispute_reversal: { slot: S_DISPUTE_REVERSAL, credit: true, transaction: false },
};

type Sums = Record<string, number[]>;

/**
 * Resumable traversal state. `first`..`end` is frozen when the pass starts, so entries booked mid-backfill
 * can't shift pages (the next sync's overlap picks them up). `to` is the newest day of the slice being read,
 * `page` its next page, `acc` the sums of its pages read so far.
 */
interface RevenueCursor {
  v: 1;
  first: string;
  end: number;
  to: string;
  page: number;
  acc: Sums;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACC_KEY_RE = /^\d{4}-\d{2}-\d{2}\|[A-Z]{3}$/;

function encodeCursor(c: RevenueCursor): string {
  return JSON.stringify(c);
}

export function decodeCursor(raw: string | null): RevenueCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as unknown;
    if (!isObject(c) || c['v'] !== 1) return null;
    const { first, end, to, page, acc } = c;
    if (typeof first !== 'string' || !DAY_KEY_RE.test(first) || typeof to !== 'string' || !DAY_KEY_RE.test(to)) return null;
    if (to < first || typeof end !== 'number' || !Number.isFinite(end) || dayKey(end) < to) return null;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || !isObject(acc)) return null;
    const sums: Sums = {};
    for (const [k, v] of Object.entries(acc)) {
      if (!ACC_KEY_RE.test(k) || !Array.isArray(v) || v.length !== SLOTS) return null;
      if (!v.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return null;
      sums[k] = v as number[];
    }
    return { v: 1, first, end, to, page, acc: sums };
  } catch {
    return null;
  }
}

interface Slice {
  from: string;
  gte: number;
  lte: number;
}

function sliceOf(c: RevenueCursor): Slice {
  const earliest = addDays(c.to, -(SLICE_DAYS - 1));
  const from = earliest > c.first ? earliest : c.first;
  return { from, gte: dayStart(from), lte: Math.min(c.end, dayStart(addDays(c.to, 1))) };
}

interface LedgerStats {
  pages: number;
  entries: number;
  ignored: Record<string, number>;
  outside: number;
  malformed: number;
  directionMismatch: number;
}

/** Adds one ledger entry to `acc` when it moves revenue and belongs to the slice. */
function addEntry(acc: Sums, raw: unknown, slice: Slice, to: string, end: number, stats: LedgerStats): void {
  stats.entries += 1;
  if (!isObject(raw)) {
    stats.malformed += 1;
    return;
  }
  const type = str(raw['event_type']) ?? 'unknown';
  const rule = Object.hasOwn(COUNTED, type) ? COUNTED[type] : undefined; // own keys only: `type` is Dodo's
  if (!rule) {
    stats.ignored[type] = (stats.ignored[type] ?? 0) + 1;
    return;
  }
  const at = time(raw['created_at']);
  const amount = int(raw['amount']);
  const currency = currencyOf(raw['currency']);
  if (at === null || amount === null || currency === null) {
    stats.malformed += 1;
    return;
  }
  const day = dayKey(at);
  // Slices overlap by the boundary instant (lte = next midnight) and the API's bounds may be inclusive.
  if (day < slice.from || day > to || at > end) {
    stats.outside += 1;
    return;
  }
  if (typeof raw['is_credit'] === 'boolean' && raw['is_credit'] !== rule.credit) stats.directionMismatch += 1;
  const key = `${day}|${currency}`;
  const sums = acc[key] ?? (acc[key] = new Array<number>(SLOTS).fill(0));
  sums[rule.slot] += Math.abs(amount);
  if (rule.transaction) sums[S_COUNT] += 1;
}

/** Every business has a USD wallet; a read day without revenue entries is reported as 0 in it. */
const EMPTY_DAY_CURRENCY = 'USD';

/**
 * A finished slice's days → DailyRevenuePoint, gross − refunds being each day's net movement without tax and fees.
 * Days of the slice with no revenue entry get a 0 USD point, so "read, nothing sold" is stored as such (the
 * dashboard treats a 'daily' provider without any rows as one that can't report history).
 */
function pointsOf(acc: Sums, from: string, to: string): DailyRevenuePoint[] {
  const out: DailyRevenuePoint[] = [];
  const daysWithEntries = new Set<string>();
  for (const [key, s] of Object.entries(acc)) {
    const [day, currency] = key.split('|') as [string, string];
    daysWithEntries.add(day);
    let gross = s[S_PAYMENT]! - s[S_TAX]!;
    let refunds = s[S_REFUND]! - s[S_REFUND_REVERSAL]! + s[S_DISPUTE]! - s[S_DISPUTE_REVERSAL]! - s[S_TAX_REVERSAL]!;
    // Reversals can outweigh the day's refunds, and a tax entry can land a day after its payment: keep both
    // fields ≥ 0 without changing gross − refunds.
    if (refunds < 0) {
      gross -= refunds;
      refunds = 0;
    }
    if (gross < 0) {
      refunds -= gross;
      gross = 0;
    }
    out.push({ day, currency, gross, refunds, count: s[S_COUNT]! });
  }
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (!daysWithEntries.has(day)) out.push({ day, currency: EMPTY_DAY_CURRENCY, gross: 0, refunds: 0, count: 0 });
  }
  return out.sort((a, b) => (a.day === b.day ? a.currency.localeCompare(b.currency) : a.day < b.day ? -1 : 1));
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

async function fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage> {
  const auth = requireAuth(input);
  let cur = decodeCursor(req.cursor);
  if (req.cursor && !cur) ctx.log('dodo_cursor_invalid', { action: 'restart' }); // daily upserts make a restart safe
  if (!cur) {
    if (!Number.isFinite(req.since)) throw new ProviderError('invalid_input', 'Invalid revenue start time.');
    const end = ctx.now();
    // Whole UTC days: a day's point replaces the stored one, so the oldest day must be read from midnight.
    cur = { v: 1, first: dayKey(Math.min(req.since, end)), end, to: dayKey(end), page: 0, acc: {} };
  }

  const daily: DailyRevenuePoint[] = [];
  const stats: LedgerStats = { pages: 0, entries: 0, ignored: {}, outside: 0, malformed: 0, directionMismatch: 0 };
  const finish = (next: RevenueCursor | null, reason: string): RevenuePage => {
    ctx.log('dodo_revenue', { ...stats, reason, days: daily.length, testMode: auth.testMode, done: next === null });
    return { events: [], daily, nextCursor: next ? encodeCursor(next) : null, done: next === null };
  };

  for (;;) {
    if (!hasBudget(ctx)) return finish(cur, 'budget');
    const slice = sliceOf(cur);
    let items: unknown[];
    try {
      items = itemsOf(
        await dodoGet(
          ctx,
          auth,
          '/balances/ledger',
          {
            created_at_gte: isoOf(slice.gte),
            created_at_lte: isoOf(slice.lte),
            page_size: PAGE_SIZE,
            page_number: cur.page,
          },
          PERM_BALANCES,
          'yield',
        ),
      );
    } catch (err) {
      if (err instanceof RateLimitedError) return finish(cur, 'rate_limited');
      throw err;
    }
    stats.pages += 1;

    const acc: Sums = {};
    for (const [k, v] of Object.entries(cur.acc)) acc[k] = [...v];
    for (const raw of items) addEntry(acc, raw, slice, cur.to, cur.end, stats);

    if (items.length < PAGE_SIZE) {
      daily.push(...pointsOf(acc, slice.from, cur.to));
      if (slice.from <= cur.first) return finish(null, 'done');
      cur = { ...cur, to: addDays(slice.from, -1), page: 0, acc: {} };
    } else {
      cur = { ...cur, page: cur.page + 1, acc };
    }
  }
}

// ---------- verify ----------

async function verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult> {
  const parsed = parseKey(input.credentials['apiKey']);
  if ('error' in parsed) return { ok: false, error: parsed.error, field: 'apiKey' };
  const legacy = parsed.testMode === null;
  const modes = legacy ? [false, true] : [parsed.testMode as boolean];
  let auth: Auth | null = null;
  try {
    for (const testMode of modes) {
      const candidate: Auth = { key: parsed.key, testMode };
      try {
        itemsOf(await dodoGet(ctx, candidate, '/subscriptions', { page_size: 1 }, PERM_SUBSCRIPTIONS));
        auth = candidate;
        break;
      } catch (err) {
        // An unprefixed key belongs to one mode; the other host answers 401.
        if (err instanceof ProviderError && err.kind === 'auth' && testMode !== modes[modes.length - 1]) continue;
        throw err;
      }
    }
    if (!auth) throw unreadable(); // unreachable: the last mode either succeeded or threw
    itemsOf(await dodoGet(ctx, auth, '/balances/ledger', { page_size: 1 }, PERM_BALANCES));
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') {
      return {
        ok: false,
        error: legacy
          ? 'Dodo Payments rejected this key in both live and test mode. Check that you copied all of it and that it hasn’t been deleted.'
          : 'Dodo Payments rejected this key. Check that you copied all of it and that it hasn’t been deleted.',
        field: 'apiKey',
      };
    }
    if (err instanceof ProviderError && err.kind === 'permission') {
      return { ok: false, error: err.message, field: 'apiKey' };
    }
    throw err; // rate limit / upstream: transient, described by the caller
  }

  const config: ConnectionConfig = { [CONFIG_TEST_MODE]: String(auth.testMode), [CONFIG_REVENUE_HISTORY]: 'daily' };
  ctx.log('dodo_verified', { testMode: auth.testMode, legacyKey: legacy });
  return {
    ok: true,
    // No business-name endpoint is readable with these two permissions; the mode tells keys apart.
    accountLabel: auth.testMode ? 'Dodo Payments (test mode)' : 'Dodo Payments (live)',
    config,
    testMode: auth.testMode,
    warnings: legacy ? [LEGACY_KEY_WARNING] : [],
  };
}

export const dodoAdapter: ProviderAdapter = {
  id: 'dodo',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
