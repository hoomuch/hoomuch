/**
 * Chargebee adapter. Owner: Data Plane. SPEC.md §6.8.
 *
 * API v2, Product Catalog 2.0 (https://apidocs.chargebee.com/docs/api, checked 2026-11-05). Base URL
 * `https://{site}.chargebee.com/api/v2`, HTTP Basic auth with the API key as the username and an empty
 * password. Facts this file relies on:
 *   - List endpoints page with `limit` (1–100, default 10) and an opaque `offset`: pass back `next_offset`
 *     until it is absent (it is a keyset, e.g. `["1600622718000","266000001127"]`). Filters are ANDed;
 *     `status[in]` takes a JSON array. Lists are eventually consistent, so a listed object may already be in
 *     a newer state than the filter asked for.
 *   - Subscription.status: future | in_trial | active | non_renewing | paused | cancelled | transferred.
 *     There is no past_due: a subscription in dunning stays `active` (with due_invoices_count / total_dues)
 *     until dunning ends, and Chargebee's own MRR keeps counting it.
 *   - Subscription.mrr: Chargebee's MRR for that subscription in its `currency_code`, "updated
 *     asynchronously" (catches up within a minute). Chargebee's MRR covers active + non_renewing, excludes
 *     trials, future subscriptions, tax, setup fees and ad-hoc charges, and follows the site's MRR settings
 *     (recurring coupons applied; one-time coupons and non-recurring addons only if configured).
 *   - Money is an integer "in cents": 1/100 of the major unit, except Chargebee's zero-decimal currencies
 *     (CLP, ISK, JPY, KRW, MGA, PYG, VND, XAF, XOF, XPF: major units). hoomuch's minor unit is the ISO 4217
 *     one (`currencyExponent`), which differs from Chargebee's for MGA (ISO 2) and CLF (ISO 4), so every
 *     amount goes through `toMinorUnits`. Chargebee supports no three-decimal currency.
 *   - Transaction.type: authorization | payment | refund | payment_reversal. Transaction.status:
 *     in_progress | success | voided | failure | timeout | needs_attention | late_failure. A direct debit that
 *     fails after succeeding is recorded either as a separate payment_reversal (default) or, with "Enable
 *     Dunning for Late Payment Failures" on, by turning the payment itself into late_failure.
 *     Chargebacks are recorded as refunds when the merchant enables it.
 *   - Errors are JSON `{ message, api_error_code, type?, param? }`: 401 api_authentication_failed,
 *     403 api_authorization_failed (key lacks access), 403 request_blocked, 404 site_not_found,
 *     429 api_request_limit_exceeded (Retry-After optional). Limits: 150 requests/min on test sites and the
 *     Starter plan, shared with the merchant's own integration.
 *
 * Decisions (SPEC §6.8):
 *   - Chargebee is not a merchant of record: revenue is cash as charged by the merchant's gateways, tax
 *     included, in the charge currency, without gateway fees (Chargebee doesn't report them). Like Stripe's
 *     balance transactions.
 *   - MRR = Σ subscription.mrr over active + non_renewing subscriptions, so hoomuch shows the number the
 *     merchant sees in Chargebee. Only when a subscription has no `mrr` at all is it computed from its
 *     items (see `computedMrr`), before discounts. Dunning subscriptions are `active`, so they count, like
 *     Stripe's past_due.
 *   - Active subscriptions: active + non_renewing with MRR > 0 (no trials, no $0 subscriptions).
 *     Trials: status in_trial.
 *   - The `site` field is reduced to a bare DNS label before it becomes part of the URL (`parseSite`), so a
 *     pasted value can never send the key to another host. A `-test` suffix is Chargebee's test site.
 *   - Only `subscription` / `transaction` objects are read. List entries also embed `customer` and `card`
 *     (names, emails, card digits); those are never read, returned or logged.
 *
 * Request plan:
 *   verify        2 requests: GET /subscriptions?limit=1 and GET /transactions?limit=1. 401 → apiKey,
 *                 403 → apiKey (missing transactional-data access), 404 site_not_found → site.
 *   fetchSnapshot GET /subscriptions?status[in]=["active","non_renewing"]&limit=100, then
 *                 status[is]=in_trial (count only), paged with offset. 429 retries (Retry-After ≤ 10 s).
 *                 At most CHARGEBEE_SNAPSHOT_PAGE_BUDGET requests (~9,000 subscriptions and trials).
 *                 Running out of budget throws BudgetExhaustedError: a partial MRR would be wrong.
 *   fetchRevenue  GET /transactions?type[in]=["payment","refund","payment_reversal"]
 *                 &updated_at[between]=[from,to]&date[after]=from−30d&sort_by[asc]=updated_at&limit=100,
 *                 Chargebee's documented incremental-sync query. Filtering on updated_at (not date) picks up
 *                 direct debits that settle days after their date and payments that later fail. Resumable:
 *                 the window is frozen in the cursor; a 429 yields (keeps what was read, returns the cursor).
 */

import { addToMoney, currencyExponent, normalizeCurrency, normalizeToMonthly, type BillingInterval, type MoneyMap } from '../lib/money';
import { DAY } from '../lib/time';
import { buildUrl, capBudget, fetchJson, hasBudget, RateLimitedError, type QueryValue } from './http';
import {
  ProviderError,
  type ConnectionInput,
  type MetricsSnapshot,
  type ProviderAdapter,
  type ProviderContext,
  type RevenueEvent,
  type RevenuePage,
  type RevenueRequest,
  type VerifyResult,
} from './types';

const PROVIDER = 'Chargebee';
const PAGE_SIZE = 100;
/**
 * Most requests one snapshot makes (`capBudget`), below the sync's own budget. With the revenue phase's 20
 * right after it, a sync stays within 3/4 of the 150-a-minute limit of test sites and the Starter plan, which
 * the merchant's own integration shares. The plan can't be read through the API, so Performance and
 * Enterprise sites (1,000 and 3,500 a minute) get the same cap.
 */
export const CHARGEBEE_SNAPSHOT_PAGE_BUDGET = 90;

/** What a restricted read-only key must include. Chargebee grants it per group, not per resource. */
export const CHARGEBEE_PERMISSION = 'Allow read-only access to transactional data';

/**
 * How far before `since` a transaction may be dated and still be read, if it was updated inside the window:
 * direct debits settle 2–7 days after their date, and late failures typically arrive within 7–15 days.
 * The filter is on updated_at, so this costs requests only for transactions that actually changed.
 */
export const LATE_SETTLEMENT_WINDOW_MS = 30 * DAY;

/** Snapshot warning (`MetricsSnapshot.warnings`): items of subscriptions without `mrr` that couldn't be priced. */
export const chargebeeUnpricedItemsWarning = (items: number) =>
  items === 1
    ? '1 subscription item has no amount or billing period hoomuch can read, so it counts as 0 in MRR.'
    : `${items} subscription items have no amount or billing period hoomuch can read, so they count as 0 in MRR.`;

// ---------- site + key ----------

interface Connection {
  site: string;
  testMode: boolean;
  base: string;
  auth: string;
}

/** A single DNS label: it is placed before `.chargebee.com`, so nothing in it may change the host. */
const SITE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SITE_ERROR = 'Enter your Chargebee site name: the part before .chargebee.com, e.g. acme, or acme-test for a test site.';

/** Accepts "acme", "acme-test", or a pasted "https://acme.chargebee.com/…" and reduces it to the site name. */
export function parseSite(raw: string | undefined): { site: string; testMode: boolean } | { error: string } {
  let s = (raw ?? '').trim().toLowerCase();
  if (!s) return { error: SITE_ERROR };
  s = s.replace(/^https?:\/\//, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  if (s.endsWith('.chargebee.com')) s = s.slice(0, -'.chargebee.com'.length);
  if (!SITE_RE.test(s)) return { error: SITE_ERROR };
  return { site: s, testMode: s.endsWith('-test') };
}

/** Basic-auth username: no colon, whitespace or non-ASCII (they would corrupt the header). */
const KEY_RE = /^[A-Za-z0-9_-]{10,200}$/;

function parseKey(raw: string | undefined): { key: string } | { error: string } {
  // `curl -u key:` habits: a trailing colon is the empty password, not part of the key.
  const key = (raw ?? '').trim().replace(/:$/, '');
  if (!key) return { error: 'Paste a Chargebee read-only API key.' };
  if (!KEY_RE.test(key)) {
    return { error: 'That doesn’t look like a Chargebee API key. Copy the whole key from Settings → Configure Chargebee → API Keys.' };
  }
  return { key };
}

function connect(site: string, testMode: boolean, key: string): Connection {
  return { site, testMode, base: `https://${site}.chargebee.com/api/v2`, auth: `Basic ${btoa(`${key}:`)}` };
}

function requireConnection(input: ConnectionInput): Connection {
  const s = parseSite(input.config['site']);
  if ('error' in s) throw new ProviderError('invalid_input', s.error, { field: 'site' });
  const k = parseKey(input.credentials['apiKey']);
  if ('error' in k) throw new ProviderError('invalid_input', k.error, { field: 'apiKey' });
  return connect(s.site, s.testMode, k.key);
}

// ---------- HTTP ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function unreadable(): ProviderError {
  return new ProviderError('upstream', 'Chargebee returned a response hoomuch couldn’t read.');
}

function siteNotFound(site: string, status: number): ProviderError {
  return new ProviderError(
    'not_found',
    `Chargebee has no site called “${site}”. Use the part before .chargebee.com; test sites end in -test.`,
    { status, field: 'site' },
  );
}

/** Chargebee error codes → ProviderError, before http.ts's generic status mapping. */
function mapChargebeeError(status: number, body: unknown, site: string, resource: string): ProviderError | null {
  const code = isObject(body) && typeof body['api_error_code'] === 'string' ? body['api_error_code'] : null;
  // An unknown site answers site_not_found; a bare 404 or a redirect means the host isn't a Chargebee API site.
  if (code === 'site_not_found' || (status === 404 && code === null) || (status >= 300 && status < 400)) {
    return siteNotFound(site, status);
  }
  if (code === 'api_authentication_failed' || code === 'basic_authentication_failed' || status === 401) {
    return new ProviderError('auth', 'Chargebee rejected the API key for this site.', { status, field: 'apiKey' });
  }
  if (code === 'request_blocked') {
    return new ProviderError('upstream', 'Chargebee is blocking API requests for this site. Chargebee support can say why.', { status });
  }
  if (code === 'api_authorization_failed' || status === 403) {
    return new ProviderError(
      'permission',
      `The Chargebee key can’t read ${resource}. Use a read-only key with access to all resources, or a restricted one with “${CHARGEBEE_PERMISSION}” ticked.`,
      { status, field: 'apiKey' },
    );
  }
  return null;
}

function cbGet<T>(
  ctx: ProviderContext,
  conn: Connection,
  path: string,
  query: Record<string, QueryValue>,
  resource: string,
  rateLimit: 'retry' | 'yield' = 'retry',
): Promise<T> {
  return fetchJson<T>(ctx, {
    provider: PROVIDER,
    url: buildUrl(conn.base, path, query),
    headers: { Authorization: conn.auth },
    permission: CHARGEBEE_PERMISSION,
    rateLimit,
    mapError: (status, body) => mapChargebeeError(status, body, conn.site, resource),
  });
}

interface Page {
  /** The `resourceKey` object of each list entry; anything else in the entry (customer, card) is dropped here. */
  items: unknown[];
  nextOffset: string | null;
}

function asPage(body: unknown, resourceKey: 'subscription' | 'transaction'): Page {
  if (!isObject(body) || !Array.isArray(body['list'])) throw unreadable();
  const next = body['next_offset'];
  if (next !== undefined && next !== null && (typeof next !== 'string' || next.length === 0)) throw unreadable();
  return {
    items: body['list'].map((entry) => (isObject(entry) ? entry[resourceKey] : undefined)),
    nextOffset: typeof next === 'string' ? next : null,
  };
}

/** Walks a list with `offset`/`next_offset`. Every page spends one unit of budget. */
async function* paginate(
  ctx: ProviderContext,
  conn: Connection,
  path: string,
  query: Record<string, QueryValue>,
  resourceKey: 'subscription' | 'transaction',
  resource: string,
): AsyncGenerator<unknown> {
  let offset: string | null = null;
  for (;;) {
    const page = asPage(await cbGet<unknown>(ctx, conn, path, { ...query, limit: PAGE_SIZE, offset }, resource), resourceKey);
    for (const item of page.items) yield item;
    if (!page.nextOffset) return;
    if (page.nextOffset === offset) throw unreadable(); // would re-read the same page forever
    offset = page.nextOffset;
  }
}

// ---------- money ----------

/** Chargebee's zero-decimal currencies (supported-currencies page): amounts are in major units. */
const ZERO_DECIMAL: ReadonlySet<string> = new Set(['CLP', 'ISK', 'JPY', 'KRW', 'MGA', 'PYG', 'VND', 'XAF', 'XOF', 'XPF']);

/** Chargebee "in cents" amount → hoomuch minor units (`currencyExponent` digits), rounded. */
export function toMinorUnits(amount: number, currency: string): number {
  const cur = normalizeCurrency(currency);
  const shift = currencyExponent(cur) - (ZERO_DECIMAL.has(cur) ? 0 : 2);
  return shift === 0 ? Math.round(amount) : Math.round(amount * 10 ** shift);
}

/** Chargebee `*_in_decimal` amount (major units, multi-decimal pricing) → hoomuch minor units. */
function decimalToMinor(value: unknown, currency: string): number | null {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;
  return Math.round(Number(value) * 10 ** currencyExponent(currency));
}

function cleanCurrency(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = normalizeCurrency(v);
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// ---------- snapshot ----------

/** Only the fields read. List entries carry more (customer, card): never read. */
interface CbSubscriptionItem {
  item_type?: string;
  quantity?: number;
  unit_price?: number;
  amount?: number;
  amount_in_decimal?: string;
  billing_period?: number;
  billing_period_unit?: string;
  trial_end?: number;
}

interface CbAddon {
  quantity?: number;
  unit_price?: number;
  amount?: number;
}

interface CbSubscription {
  status?: string;
  deleted?: boolean;
  currency_code?: string;
  mrr?: number;
  billing_period?: number;
  billing_period_unit?: string;
  subscription_items?: CbSubscriptionItem[];
  // Product Catalog 1.0 sites (legacy, not in the current reference): read defensively.
  plan_amount?: number;
  plan_unit_price?: number;
  plan_quantity?: number;
  addons?: CbAddon[];
}

const PAYING_STATUSES: ReadonlySet<string> = new Set(['active', 'non_renewing']);
const INTERVALS: readonly BillingInterval[] = ['day', 'week', 'month', 'year'];

interface Stats {
  computed: number;
  unpriced: number;
}

/** One recurring line normalized to a month, or null when its amount or period can't be read. */
function monthly(amount: number | null, unit: unknown, period: unknown): number | null {
  if (amount === null || !INTERVALS.includes(unit as BillingInterval)) return null;
  const count = typeof period === 'number' && period > 0 ? period : 1;
  return normalizeToMonthly(amount, unit as BillingInterval, count);
}

function itemAmount(item: CbSubscriptionItem | CbAddon, currency: string): number | null {
  if (isAmount(item.amount)) return toMinorUnits(item.amount, currency);
  const dec = 'amount_in_decimal' in item ? decimalToMinor(item.amount_in_decimal, currency) : null;
  if (dec !== null) return dec;
  if (isAmount(item.unit_price)) return toMinorUnits(item.unit_price * (isAmount(item.quantity) ? item.quantity : 1), currency);
  return null;
}

/**
 * MRR of a subscription that has no `mrr` attribute, from its items, before discounts:
 *   - Product Catalog 2.0: plan and addon items (`amount` = unit price × quantity after free quantity and
 *     tiers, per billing period), each normalized by its own billing period (multi-frequency billing) or
 *     the subscription's. Charge items are one-time and left out, as are items still in an item trial.
 *   - Product Catalog 1.0: plan_amount (or plan_unit_price × plan_quantity) plus addons, at the
 *     subscription's billing period.
 */
function computedMrr(sub: CbSubscription, currency: string, now: number, stats: Stats): number {
  let total = 0;
  const add = (amount: number | null, unit: unknown, period: unknown) => {
    const m = monthly(amount, unit, period);
    if (m === null) stats.unpriced += 1;
    else total += m;
  };
  if (Array.isArray(sub.subscription_items) && sub.subscription_items.length > 0) {
    for (const item of sub.subscription_items) {
      if (!isObject(item) || (item.item_type !== 'plan' && item.item_type !== 'addon')) continue;
      if (typeof item.trial_end === 'number' && item.trial_end * 1000 > now) continue;
      const unit = item.billing_period_unit ?? sub.billing_period_unit;
      const period = item.billing_period_unit ? item.billing_period : sub.billing_period;
      add(itemAmount(item, currency), unit, period);
    }
    return total;
  }
  const plan = isAmount(sub.plan_amount)
    ? toMinorUnits(sub.plan_amount, currency)
    : isAmount(sub.plan_unit_price)
      ? toMinorUnits(sub.plan_unit_price * (isAmount(sub.plan_quantity) ? sub.plan_quantity : 1), currency)
      : null;
  if (plan !== null) add(plan, sub.billing_period_unit, sub.billing_period);
  for (const addon of Array.isArray(sub.addons) ? sub.addons : []) {
    if (isObject(addon)) add(itemAmount(addon, currency), sub.billing_period_unit, sub.billing_period);
  }
  return total;
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  capBudget(ctx, CHARGEBEE_SNAPSHOT_PAGE_BUDGET);
  const conn = requireConnection(input);
  const now = ctx.now();
  const stats: Stats = { computed: 0, unpriced: 0 };
  const mrr: MoneyMap = {};
  let activeSubscriptions = 0;
  let zeroMrr = 0;
  let skipped = 0;

  for await (const raw of paginate(ctx, conn, '/subscriptions', { 'status[in]': '["active","non_renewing"]' }, 'subscription', 'subscriptions')) {
    if (!isObject(raw)) {
      skipped += 1;
      continue;
    }
    const sub = raw as CbSubscription;
    // Lists are eventually consistent: trust the object over the filter.
    if (sub.deleted === true || !PAYING_STATUSES.has(sub.status ?? '')) {
      skipped += 1;
      continue;
    }
    const currency = cleanCurrency(sub.currency_code);
    if (!currency) {
      skipped += 1;
      continue;
    }
    let amount: number;
    if (isAmount(sub.mrr)) {
      amount = toMinorUnits(sub.mrr, currency);
    } else {
      stats.computed += 1;
      amount = computedMrr(sub, currency, now, stats);
    }
    if (amount <= 0) {
      zeroMrr += 1; // free plan, 100% discount, metered-only: not a paying subscription
      continue;
    }
    activeSubscriptions += 1;
    addToMoney(mrr, currency, amount);
  }

  let activeTrials = 0;
  for await (const raw of paginate(ctx, conn, '/subscriptions', { 'status[is]': 'in_trial' }, 'subscription', 'subscriptions')) {
    if (isObject(raw) && raw['status'] === 'in_trial' && raw['deleted'] !== true) activeTrials += 1;
  }

  if (stats.computed > 0) ctx.log('chargebee_mrr_computed', { subscriptions: stats.computed });
  if (stats.unpriced > 0) ctx.log('chargebee_items_unpriced', { items: stats.unpriced });
  ctx.log('chargebee_snapshot', {
    subscriptions: activeSubscriptions,
    trials: activeTrials,
    zeroMrr,
    skipped,
    currencies: Object.keys(mrr),
  });

  return {
    mrr,
    activeSubscriptions,
    activeTrials,
    revenuePeriod: null, // derived from daily_revenue by the sync engine
    revenuePeriodDays: null,
    newCustomers: null,
    ...(stats.unpriced > 0 ? { warnings: [chargebeeUnpricedItemsWarning(stats.unpriced)] } : {}),
  };
}

// ---------- revenue ----------

/**
 * Transaction → events. Only `success` counts, plus `late_failure` payments:
 *   payment           success → charge (+amount, at `date`)
 *                     late_failure → the charge, plus a reversal (−amount, at `updated_at`, id `<txn>:late_failure`).
 *                     Emitting both nets to zero whether or not the charge was stored while it still read
 *                     success.
 *   refund            success → refund (−amount, at `date`). Also chargebacks recorded as refunds.
 *   payment_reversal  success → refund (−amount, at `date`). Direct-debit returns, bounced checks.
 * Ignored: authorization (not captured), in_progress (read again once it settles: updated_at moves), failure,
 * timeout, voided, needs_attention, deleted, zero amounts. Refunds are only ever transactions: credit notes
 * aren't read, so a refunded credit note isn't counted twice, and credits applied to invoices (no cash)
 * aren't revenue.
 *
 * `description` is null: a transaction carries no plan or item name (it is several requests away, through
 * linked invoices). `fee` is null: Chargebee doesn't report gateway fees.
 */
const REVENUE_TYPES = ['payment', 'refund', 'payment_reversal'] as const;

function toRevenueEvents(raw: unknown): RevenueEvent[] | null {
  if (!isObject(raw)) return null;
  const { id, type, status, amount, date } = raw;
  if (typeof id !== 'string' || id.length === 0 || raw['deleted'] === true) return null;
  if (typeof type !== 'string' || typeof status !== 'string') return null;
  if (!isAmount(amount) || typeof date !== 'number' || !Number.isFinite(date)) return null;
  const currency = cleanCurrency(raw['currency_code']);
  if (!currency) return null;
  const minor = toMinorUnits(amount, currency);
  if (minor <= 0) return null;
  const event = (externalId: string, at: number, kind: 'charge' | 'refund'): RevenueEvent => ({
    externalId,
    occurredAt: at * 1000,
    type: kind,
    amount: kind === 'charge' ? minor : -minor,
    currency,
    fee: null,
    description: null,
  });

  if (type === 'payment' && status === 'success') return [event(id, date, 'charge')];
  if (type === 'payment' && status === 'late_failure') {
    const updated = raw['updated_at'];
    const failedAt = typeof updated === 'number' && Number.isFinite(updated) && updated >= date ? updated : date;
    return [event(id, date, 'charge'), event(`${id}:late_failure`, failedAt, 'refund')];
  }
  if ((type === 'refund' || type === 'payment_reversal') && status === 'success') return [event(id, date, 'refund')];
  return null;
}

/**
 * Resumable traversal state (epoch seconds). `from`/`to` bound updated_at and `dateFrom` bounds date; all
 * three are frozen when the traversal starts, so pages don't shift. `offset` is Chargebee's `next_offset`.
 */
interface RevenueCursor {
  v: 1;
  from: number;
  to: number;
  dateFrom: number;
  offset: string | null;
}

function encodeCursor(c: RevenueCursor): string {
  return JSON.stringify(c);
}

function decodeCursor(raw: string): RevenueCursor | null {
  try {
    const c = JSON.parse(raw) as unknown;
    if (!isObject(c) || c['v'] !== 1) return null;
    const { from, to, dateFrom, offset } = c;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isSafeInteger(dateFrom)) return null;
    if ((from as number) > (to as number) || (dateFrom as number) > (from as number)) return null;
    if (offset !== null && (typeof offset !== 'string' || offset.length === 0 || offset.length > 1000)) return null;
    return { v: 1, from: from as number, to: to as number, dateFrom: dateFrom as number, offset: offset as string | null };
  } catch {
    return null;
  }
}

async function fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage> {
  const conn = requireConnection(input);
  let state: RevenueCursor | null = req.cursor ? decodeCursor(req.cursor) : null;
  if (req.cursor && !state) ctx.log('chargebee_cursor_invalid', { action: 'restart' }); // idempotent upserts make a restart safe
  if (!state) {
    if (!Number.isFinite(req.since)) throw new ProviderError('invalid_input', 'Invalid revenue start time.');
    const from = Math.floor(req.since / 1000);
    const to = Math.max(from, Math.floor(ctx.now() / 1000));
    state = { v: 1, from, to, dateFrom: from - Math.floor(LATE_SETTLEMENT_WINDOW_MS / 1000), offset: null };
  }

  const events: RevenueEvent[] = [];
  const ignored: Record<string, number> = {};
  let pages = 0;
  const pause = (reason: 'budget' | 'rate_limit'): RevenuePage => {
    ctx.log('chargebee_revenue_paused', { reason, pages, events: events.length });
    return { events, daily: [], nextCursor: encodeCursor(state!), done: false };
  };

  for (;;) {
    if (!hasBudget(ctx)) return pause('budget');
    let body: unknown;
    try {
      body = await cbGet<unknown>(
        ctx,
        conn,
        '/transactions',
        {
          'type[in]': JSON.stringify(REVENUE_TYPES),
          'updated_at[between]': JSON.stringify([state.from, state.to]),
          'date[after]': state.dateFrom - 1,
          'sort_by[asc]': 'updated_at',
          limit: PAGE_SIZE,
          offset: state.offset,
        },
        'transactions',
        'yield', // per-minute limit shared with the merchant's app: stop, keep what was read, resume next sync
      );
    } catch (err) {
      if (err instanceof RateLimitedError) return pause('rate_limit');
      throw err;
    }
    const page = asPage(body, 'transaction');
    pages += 1;
    for (const txn of page.items) {
      const evs = toRevenueEvents(txn);
      if (evs) events.push(...evs);
      else {
        const key = isObject(txn) ? `${String(txn['type'])}:${String(txn['status'])}` : 'unreadable';
        ignored[key] = (ignored[key] ?? 0) + 1;
      }
    }
    if (!page.nextOffset) break;
    if (page.nextOffset === state.offset) throw unreadable(); // would re-read the same page forever
    state = { ...state, offset: page.nextOffset };
  }
  ctx.log('chargebee_revenue_done', { pages, events: events.length, ignored });
  return { events, daily: [], nextCursor: null, done: true };
}

// ---------- verify ----------

async function verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult> {
  const s = parseSite(input.config['site']);
  if ('error' in s) return { ok: false, error: s.error, field: 'site' };
  const k = parseKey(input.credentials['apiKey']);
  if ('error' in k) return { ok: false, error: k.error, field: 'apiKey' };
  const conn = connect(s.site, s.testMode, k.key);
  try {
    // One cheap read per resource the adapter lists; both sit in the "transactional data" group.
    await cbGet(ctx, conn, '/subscriptions', { limit: 1 }, 'subscriptions');
    await cbGet(ctx, conn, '/transactions', { limit: 1 }, 'transactions');
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === 'not_found' && err.field === 'site') return { ok: false, error: err.message, field: 'site' };
    if (err.kind === 'auth') {
      return {
        ok: false,
        error: `Chargebee rejected this key for the site “${s.site}”. Check that you copied all of it, that it hasn’t been deleted, and that it was created on this site (test and live sites have different keys).`,
        field: 'apiKey',
      };
    }
    if (err.kind === 'permission') return { ok: false, error: err.message, field: 'apiKey' };
    throw err; // rate limit / upstream: transient, described by the caller
  }
  const name = s.testMode ? s.site.slice(0, -'-test'.length) : s.site;
  return {
    ok: true,
    // A read-only key can't tell us the business name without another resource; the site name identifies it.
    accountLabel: `Chargebee: ${name}${s.testMode ? ' (test)' : ''}`,
    config: { site: s.site },
    testMode: s.testMode,
    // GET-only, so a full-access key can't be told apart from a read-only one: the form asks for read-only.
    warnings: [],
  };
}

export const chargebeeAdapter: ProviderAdapter = {
  id: 'chargebee',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
