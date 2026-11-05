/**
 * Paddle Billing adapter. Owner: Data Plane. SPEC.md §6.5.
 *
 * Paddle API v1, pinned with `Paddle-Version: 1` (the only version on 2026-11-05),
 * https://developer.paddle.com/api-reference. Facts this file relies on, checked against the docs that day:
 *   - Keys: `pdl_live_apikey_…` → https://api.paddle.com, `pdl_sdbx_apikey_…` → https://sandbox-api.paddle.com.
 *     69 characters, KEY_RE is the regex Paddle publishes. Keys created before 2025-05-06 ("legacy": 50 lowercase
 *     letters and digits) can't be limited by permissions and are rejected.
 *   - `GET /` needs no permission and returns `data.api.environment`, `data.caller.account {id, name}` (null for
 *     a key Paddle doesn't accept) and `data.caller.permissions` (e.g. `transaction.read`). `x.write` includes
 *     `x.read`.
 *   - Errors are `{ error: { type, code, detail } }`. An unknown or revoked key is a 403 `invalid_token` (not a
 *     401), a missing permission a 403 `forbidden`, and a Paddle Classic account a 403
 *     `paddle_billing_not_enabled`. See `mapPaddleError`.
 *   - Rate limit: 240 requests per minute per IP, and a 429 blocks the IP for 60 s, so every request uses
 *     `rateLimit: 'yield'`.
 *   - Lists are newest first (`id[DESC]`) and page with `after=<last id>`. Paddle IDs sort like their creation
 *     time. `meta.pagination.estimated_total` is exact up to 100,000, 100001 above that and −1 when the count
 *     was skipped (`Skip-Count: true`). Page size: 200 max (transactions 30, adjustments 50).
 *   - Money is a string of minor units. Transactions carry `details.totals {grand_total, grand_total_tax, fee,
 *     currency_code}` and `payments[] {status, captured_at}`, newest first. `details.line_items[].product` is
 *     nested, so it needs no product permission and no `include`.
 *   - `GET /metrics/monthly-recurring-revenue?from=…&to=…` (metrics.read) returns one point a day in the
 *     account's balance currency. Paddle refreshes it every 24 h (`data.updated_at`). Sandbox accounts have no
 *     subscription metrics.
 *
 * Decisions (SPEC §6.5):
 *   - Paddle is the merchant of record, so revenue excludes the tax it collects: a charge is
 *     grand_total − grand_total_tax (the tax actually inside grand_total once credits are applied), a refund or
 *     chargeback is total − tax.
 *   - Never ask Paddle for customer data: no `include`, and no customer, address or business reads. A
 *     description is a catalog product name, never free text.
 *   - MRR comes from Paddle's own metric when it can, because only Paddle knows each customer's localized price
 *     and the tax inside it. The figure is Paddle's definition: up to a day old, in the balance currency,
 *     without one-time payments. The docs don't say how it treats past_due subscriptions or tax; Paddle counts
 *     churn "when their paid period ends", which suggests subscriptions in dunning stay in (unverified).
 *   - Without the metric (sandbox, no metrics.read, no data yet), MRR is estimated from subscriptions; see
 *     `estimateFromSubscriptions` for the rules and the limits.
 *   - Revenue reads transactions by `updated_at`, not `billed_at`: a renewal that fails and is recovered in
 *     dunning keeps its old billed_at, but completing it bumps updated_at, so the next sync still sees it. It is
 *     dated at the capture (see `chargeEvent`). The default `id[DESC]` order is used because `after` is only
 *     documented as an ID cursor.
 *
 * Request plan:
 *   verify        1 request: GET /. Permissions come from the response, not from probing endpoints.
 *   fetchSnapshot live:    MRR metric, then active+past_due and trialing counts (per_page=1 → estimated_total),
 *                          3 requests.
 *                 sandbox, or no usable metric: every active+past_due subscription (per_page=200), the
 *                          discounts they use (≤ 50 IDs per request, plus one mode=custom request for IDs not
 *                          found) and the trialing count.
 *                 Running out of budget, or a 429, throws: a partial MRR would be wrong.
 *   fetchRevenue  phase 1: completed transactions updated since `since` (30 a page).
 *                 phase 2: approved refunds and chargebacks, newest first, until one was created more than
 *                          REFUND_LOOKBACK before `since` (adjustments have no date filter).
 *                 Resumable through its cursor. A 429 ends the call early and returns the cursor with the
 *                 events read so far.
 */

import { addToMoney, normalizeCurrency, normalizeToMonthly, type BillingInterval, type MoneyMap } from '../lib/money';
import { DAY, addDays, dayKey } from '../lib/time';
import { RateLimitedError, buildUrl, fetchJson, hasBudget, type QueryValue } from './http';
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

export const PADDLE_LIVE_BASE = 'https://api.paddle.com';
export const PADDLE_SANDBOX_BASE = 'https://sandbox-api.paddle.com';
export const PADDLE_API_VERSION = '1';

const PROVIDER = 'Paddle';
const SUBSCRIPTION_PAGE_SIZE = 200;
const TRANSACTION_PAGE_SIZE = 30;
const ADJUSTMENT_PAGE_SIZE = 50;
/** Discount IDs per `GET /discounts?id=…` request, which keeps the URL around 1.6 KB. */
const DISCOUNT_BATCH = 50;
/** Days of MRR points requested; the newest refreshed one wins. */
const METRICS_LOOKBACK_DAYS = 7;
/**
 * Adjustments have no date filter, so phase 2 reads newest first and stops at the first one created this long
 * before `since`. 30 days + the engine's 2-day overlap covers refunds Paddle approves late.
 */
export const REFUND_LOOKBACK_MS = 30 * DAY;

// ---------- permissions ----------

interface Permission {
  /** Wording used in the registry checklist and in messages. */
  label: string;
  /** Name in `caller.permissions`. */
  api: string;
}

export const PERM_SUBSCRIPTIONS: Permission = { label: 'Subscriptions: Read', api: 'subscription.read' };
export const PERM_TRANSACTIONS: Permission = { label: 'Transactions: Read', api: 'transaction.read' };
export const PERM_ADJUSTMENTS: Permission = { label: 'Adjustments: Read', api: 'adjustment.read' };
export const PERM_METRICS: Permission = { label: 'Metrics: Read', api: 'metrics.read' };
/** Optional: only the subscription-based MRR estimate uses it. */
export const PERM_DISCOUNTS: Permission = { label: 'Discounts: Read', api: 'discount.read' };

export const DISCOUNTS_WARNING =
  'This key can’t read discounts (Discounts: Read). When Paddle’s MRR metric isn’t available (sandbox accounts, brand-new accounts), hoomuch estimates MRR from subscriptions and will leave discounts out.';

export const REJECTED_KEY_MESSAGE =
  'Paddle rejected this key. Check that you copied all of it and that it hasn’t expired or been revoked.';

function writeWarning(writes: string[]): string {
  const shown = writes.slice(0, 3).join(', ') + (writes.length > 3 ? ` and ${writes.length - 3} more` : '');
  return `This key can also change data in Paddle (${shown}). hoomuch only reads, so a key with just the Read permissions listed is safer. You can replace the key on this page.`;
}

function granted(perms: ReadonlySet<string>, p: Permission): boolean {
  return perms.has(p.api) || perms.has(p.api.replace(/\.read$/, '.write'));
}

function missingMessage(missing: Permission[]): string {
  if (missing.length === 1) return `The Paddle key is missing the “${missing[0]!.label}” permission (${missing[0]!.api}).`;
  return `The Paddle key is missing these permissions: ${missing.map((p) => `${p.label} (${p.api})`).join(', ')}.`;
}

// ---------- key handling ----------

interface ParsedKey {
  key: string;
  base: string;
  testMode: boolean;
}

/** Published by Paddle (Authentication → API key format). Rejecting anything else keeps stray characters out of the header. */
const KEY_RE = /^pdl_(live|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$/;
const LEGACY_KEY_RE = /^[a-z\d]{50}$/;
/** Paddle.js client-side tokens: `live_…` / `test_…`. */
const CLIENT_TOKEN_RE = /^(live|test)_[A-Za-z\d]+$/;

function parseKey(raw: string | undefined): ParsedKey | { error: string } {
  const key = (raw ?? '').trim();
  if (!key) return { error: 'Paste a Paddle API key (pdl_live_apikey_… or pdl_sdbx_apikey_…).' };
  const m = KEY_RE.exec(key);
  if (m) {
    const testMode = m[1] === 'sdbx';
    return { key, base: testMode ? PADDLE_SANDBOX_BASE : PADDLE_LIVE_BASE, testMode };
  }
  if (LEGACY_KEY_RE.test(key)) {
    return {
      error:
        'That is a legacy Paddle API key (created before May 6, 2025). Legacy keys can’t be limited to read access, so hoomuch doesn’t accept them. Create a new API key with the Read permissions listed below.',
    };
  }
  if (CLIENT_TOKEN_RE.test(key)) {
    return { error: 'That is a client-side token for Paddle.js. hoomuch needs an API key, which starts with pdl_live_apikey_.' };
  }
  if (key.startsWith('pdl_')) {
    return {
      error:
        'That doesn’t look like a complete Paddle API key. Keys are 69 characters long and start with pdl_live_apikey_ or pdl_sdbx_apikey_.',
    };
  }
  return { error: 'That doesn’t look like a Paddle API key. It should start with pdl_live_apikey_ (or pdl_sdbx_apikey_ for sandbox).' };
}

function requireKey(input: ConnectionInput): ParsedKey {
  const parsed = parseKey(input.credentials['apiKey']);
  if ('error' in parsed) throw new ProviderError('invalid_input', parsed.error, { field: 'apiKey' });
  return parsed;
}

// ---------- HTTP ----------

function errorCode(body: unknown): string | null {
  if (!isObject(body) || !isObject(body['error'])) return null;
  const code = body['error']['code'];
  return typeof code === 'string' ? code : null;
}

/** Paddle's error codes that the generic status mapping would get wrong (an invalid key is a 403). */
function mapPaddleError(perm: Permission | undefined) {
  return (status: number, body: unknown): ProviderError | null => {
    switch (errorCode(body)) {
      case 'invalid_token':
      case 'authentication_malformed':
      case 'authentication_missing':
        return new ProviderError('auth', 'Paddle rejected the API key. It may have expired or been revoked.', {
          status,
          field: 'apiKey',
        });
      case 'forbidden':
        return new ProviderError(
          'permission',
          perm
            ? `The Paddle key is missing the “${perm.label}” permission (${perm.api}).`
            : 'Paddle denied access to this request.',
          { status, field: 'apiKey' },
        );
      case 'paddle_billing_not_enabled':
        return new ProviderError(
          'permission',
          'Paddle Billing isn’t turned on for this Paddle account. hoomuch works with Paddle Billing, not Paddle Classic.',
          { status, field: 'apiKey' },
        );
      case 'not_available_in_sandbox':
        return new ProviderError('not_found', 'Paddle doesn’t offer this data for sandbox accounts.', { status });
      default:
        return null;
    }
  };
}

function paddleGet<T>(
  ctx: ProviderContext,
  key: ParsedKey,
  path: string,
  query: Record<string, QueryValue>,
  perm?: Permission,
  opts: { skipCount?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key.key}`, 'Paddle-Version': PADDLE_API_VERSION };
  if (opts.skipCount) headers['Skip-Count'] = 'true';
  return fetchJson<T>(ctx, {
    provider: PROVIDER,
    url: buildUrl(key.base, path, query),
    headers,
    permission: perm?.label,
    rateLimit: 'yield',
    mapError: mapPaddleError(perm),
  });
}

function unreadable(ctx: ProviderContext, path: string): ProviderError {
  ctx.log('paddle_bad_payload', { path });
  return new ProviderError('upstream', 'Paddle returned a response hoomuch couldn’t read.');
}

interface PaddleList {
  data: unknown[];
  hasMore: boolean;
  estimatedTotal: number | null;
}

function asList(ctx: ProviderContext, path: string, body: unknown): PaddleList {
  if (!isObject(body) || !Array.isArray(body['data'])) throw unreadable(ctx, path);
  const meta = isObject(body['meta']) && isObject(body['meta']['pagination']) ? body['meta']['pagination'] : {};
  const total = meta['estimated_total'];
  return {
    data: body['data'],
    hasMore: meta['has_more'] === true,
    estimatedTotal: typeof total === 'number' && Number.isInteger(total) ? total : null,
  };
}

const idPattern = (prefix: string) => new RegExp(`^${prefix}_[a-z\\d]{26}$`);
const SUB_ID = idPattern('sub');
const TXN_ID = idPattern('txn');
const ADJ_ID = idPattern('adj');
const DSC_ID = idPattern('dsc');

/** ID of the last entity on a page: the `after` cursor for the next one. Anything else would re-read page 1 forever. */
function lastId(ctx: ProviderContext, path: string, page: PaddleList, re: RegExp): string {
  const last = page.data[page.data.length - 1];
  const id = isObject(last) ? last['id'] : undefined;
  if (typeof id !== 'string' || !re.test(id)) throw unreadable(ctx, path);
  return id;
}

/** Walks a list newest first with `after`, skipping Paddle's count query. Every page spends one unit of budget. */
async function* paginate(
  ctx: ProviderContext,
  key: ParsedKey,
  path: string,
  query: Record<string, QueryValue>,
  perm: Permission,
  re: RegExp,
): AsyncGenerator<unknown> {
  let after: string | undefined;
  for (;;) {
    const page = asList(ctx, path, await paddleGet<unknown>(ctx, key, path, { ...query, after }, perm, { skipCount: true }));
    yield* page.data;
    if (!page.hasMore || page.data.length === 0) return;
    after = lastId(ctx, path, page, re);
  }
}

// ---------- value helpers ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Integer minor units from Paddle's string amounts ("4999", "-300"). */
function minor(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v !== 'string' || !/^-?\d{1,16}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Percentages are decimal strings, e.g. "10" or "12.5". */
function decimal(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{1,3}(\.\d+)?$/.test(v)) return null;
  return Number(v);
}

function time(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function currencyOf(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z]{3}$/.test(v) ? normalizeCurrency(v) : null;
}

/** RFC 3339 to the second, the format Paddle's own examples use for date filters. */
function rfc3339(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------- verify ----------

interface ApiRoot {
  environment: string | null;
  accountName: string | null;
  hasAccount: boolean;
  permissions: Set<string>;
}

function parseRoot(ctx: ProviderContext, body: unknown): ApiRoot {
  const data = isObject(body) ? body['data'] : undefined;
  if (!isObject(data) || !isObject(data['caller'])) throw unreadable(ctx, '/');
  const caller = data['caller'];
  const account = isObject(caller['account']) ? caller['account'] : null;
  const name = account && typeof account['name'] === 'string' ? account['name'].replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  const perms = Array.isArray(caller['permissions']) ? caller['permissions'].filter((p): p is string => typeof p === 'string') : [];
  const api = isObject(data['api']) ? data['api'] : {};
  return {
    environment: typeof api['environment'] === 'string' ? api['environment'] : null,
    accountName: name || null,
    hasAccount: account !== null,
    permissions: new Set(perms),
  };
}

async function verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult> {
  const parsed = parseKey(input.credentials['apiKey']);
  if ('error' in parsed) return { ok: false, error: parsed.error, field: 'apiKey' };

  let body: unknown;
  try {
    body = await paddleGet<unknown>(ctx, parsed, '/', {});
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') return { ok: false, error: REJECTED_KEY_MESSAGE, field: 'apiKey' };
    if (err instanceof ProviderError && err.kind === 'permission') return { ok: false, error: err.message, field: 'apiKey' };
    throw err; // rate limit / upstream: transient, described by the caller
  }
  const root = parseRoot(ctx, body);
  // GET / also answers unauthenticated requests; a null account means Paddle didn't accept the key.
  if (!root.hasAccount) return { ok: false, error: REJECTED_KEY_MESSAGE, field: 'apiKey' };
  const expected = parsed.testMode ? 'sandbox' : 'production';
  if (root.environment !== null && root.environment !== expected) {
    ctx.log('paddle_environment_mismatch', { expected, got: root.environment });
  }

  // Sandbox accounts have no subscription metrics, so the MRR estimate is used there and Metrics isn't needed.
  const required = parsed.testMode
    ? [PERM_SUBSCRIPTIONS, PERM_TRANSACTIONS, PERM_ADJUSTMENTS]
    : [PERM_SUBSCRIPTIONS, PERM_TRANSACTIONS, PERM_ADJUSTMENTS, PERM_METRICS];
  const missing = required.filter((p) => !granted(root.permissions, p));
  if (missing.length > 0) return { ok: false, error: missingMessage(missing), field: 'apiKey' };

  const warnings: string[] = [];
  if (!granted(root.permissions, PERM_DISCOUNTS)) warnings.push(DISCOUNTS_WARNING);
  const writes = [...root.permissions].filter((p) => p.endsWith('.write')).sort();
  if (writes.length > 0) warnings.push(writeWarning(writes));

  const name = root.accountName ?? 'Paddle';
  return {
    ok: true,
    // caller.account.name is the merchant's own account name (business data, not customer PII).
    accountLabel: parsed.testMode ? `${name} (sandbox)` : root.accountName ?? 'Paddle (live)',
    config: {},
    testMode: parsed.testMode,
    warnings,
  };
}

// ---------- snapshot: counts ----------

/** Subscriptions with `status` (comma-separated). Exact up to 100,000 (Paddle reports 100001 above that). */
async function countSubscriptions(ctx: ProviderContext, key: ParsedKey, status: string): Promise<number> {
  const page = asList(
    ctx,
    '/subscriptions',
    await paddleGet<unknown>(ctx, key, '/subscriptions', { status, per_page: 1 }, PERM_SUBSCRIPTIONS),
  );
  if (!page.hasMore) return page.data.length;
  if (page.estimatedTotal !== null && page.estimatedTotal >= 0) {
    if (page.estimatedTotal > 100_000) ctx.log('paddle_count_capped', { status });
    return page.estimatedTotal;
  }
  // −1: Paddle couldn't count this time. Count by paging rather than guess.
  let n = 0;
  for await (const _ of paginate(ctx, key, '/subscriptions', { status, per_page: SUBSCRIPTION_PAGE_SIZE }, PERM_SUBSCRIPTIONS, SUB_ID)) {
    n += 1;
  }
  return n;
}

// ---------- snapshot: MRR metric ----------

/**
 * Paddle's MRR for the newest day it has refreshed, or null when there is none to use. Points after
 * `data.updated_at` haven't been computed yet, so they are ignored rather than read as 0.
 */
async function metricsMrr(ctx: ProviderContext, key: ParsedKey): Promise<{ mrr: MoneyMap; day: string } | null> {
  const today = dayKey(ctx.now());
  let body: unknown;
  try {
    body = await paddleGet<unknown>(
      ctx,
      key,
      '/metrics/monthly-recurring-revenue',
      // `to` is exclusive, so tomorrow keeps today's point once Paddle has refreshed it.
      { from: addDays(today, -METRICS_LOOKBACK_DAYS), to: addDays(today, 1) },
      PERM_METRICS,
    );
  } catch (err) {
    if (err instanceof RateLimitedError || !(err instanceof ProviderError)) throw err;
    // forbidden (no metrics.read), not_available_in_sandbox, or a rejected date range: estimate instead.
    if (err.kind === 'permission' || err.kind === 'not_found' || err.status === 400) {
      ctx.log('paddle_metrics_unavailable', { reason: err.kind, status: err.status ?? null });
      return null;
    }
    throw err;
  }
  const data = isObject(body) ? body['data'] : undefined;
  if (!isObject(data) || !Array.isArray(data['timeseries'])) throw unreadable(ctx, '/metrics/monthly-recurring-revenue');
  const currency = currencyOf(data['currency_code']);
  const refreshed = time(data['updated_at']);

  let best: { at: number; amount: number } | null = null;
  for (const p of data['timeseries']) {
    if (!isObject(p)) continue;
    const at = time(p['timestamp']);
    const amount = minor(p['amount']);
    if (at === null || amount === null || amount < 0) continue;
    if (refreshed !== null && at > refreshed) continue;
    if (!best || at > best.at) best = { at, amount };
  }
  if (!best || !currency) {
    ctx.log('paddle_metrics_unavailable', { reason: 'empty' });
    return null;
  }
  const mrr: MoneyMap = {};
  if (best.amount > 0) addToMoney(mrr, currency, best.amount);
  return { mrr, day: dayKey(best.at) };
}

// ---------- snapshot: estimate from subscriptions ----------

const INTERVALS: ReadonlySet<string> = new Set<BillingInterval>(['day', 'week', 'month', 'year']);

interface Cycle {
  interval: BillingInterval;
  frequency: number;
}

function cycleOf(v: unknown): Cycle | null {
  if (!isObject(v) || typeof v['interval'] !== 'string' || !INTERVALS.has(v['interval'])) return null;
  const f = v['frequency'];
  return { interval: v['interval'] as BillingInterval, frequency: typeof f === 'number' && f >= 1 ? f : 1 };
}

/** One billable subscription item, normalized to a month (minor units; fractional once discounted). */
interface Line extends Cycle {
  priceId: string | null;
  productId: string | null;
  quantity: number;
  monthly: number;
}

interface EstimateStats {
  trialItems: number;
  unpricedItems: number;
  overridePrices: number;
  unresolvedDiscounts: number;
  zeroSubscriptions: number;
}

/**
 * Unit price in the subscription's currency. Paddle bills a customer the base `unit_price`, or the
 * `unit_price_overrides` entry for their country, and a subscription doesn't say which (the country is on the
 * customer's address, which hoomuch never reads). Base price in this currency → base. Otherwise, when every
 * override in this currency agrees on one amount → that amount. Otherwise unknown.
 */
function unitAmountIn(price: Record<string, unknown>, currency: string, stats: EstimateStats): number | null {
  const base = price['unit_price'];
  if (isObject(base) && currencyOf(base['currency_code']) === currency) return minor(base['amount']);
  const amounts = new Set<number>();
  const overrides = Array.isArray(price['unit_price_overrides']) ? price['unit_price_overrides'] : [];
  for (const o of overrides) {
    const up = isObject(o) ? o['unit_price'] : undefined;
    if (!isObject(up) || currencyOf(up['currency_code']) !== currency) continue;
    const amount = minor(up['amount']);
    if (amount !== null) amounts.add(amount);
  }
  if (amounts.size !== 1) return null;
  stats.overridePrices += 1;
  return [...amounts][0]!;
}

function itemLine(item: unknown, currency: string, fallback: Cycle | null, stats: EstimateStats): Line | null | 'unpriced' {
  if (!isObject(item)) return 'unpriced';
  if (item['recurring'] === false) return null; // one-time item: not recurring revenue
  if (item['status'] === 'trialing') {
    stats.trialItems += 1; // item-level trial: Paddle hasn't billed it
    return null;
  }
  if (item['status'] === 'inactive') return null; // paused item
  const price = item['price'];
  if (!isObject(price)) return 'unpriced';
  if (price['billing_cycle'] === null) return null; // one-time price
  const cycle = cycleOf(price['billing_cycle']) ?? fallback;
  if (!cycle) return 'unpriced';
  const unit = unitAmountIn(price, currency, stats);
  if (unit === null || unit < 0) return 'unpriced';
  const q = item['quantity'];
  const quantity = typeof q === 'number' && q > 0 ? q : 1;
  const product = isObject(item['product']) ? item['product']['id'] : undefined;
  const productId = typeof price['product_id'] === 'string' ? price['product_id'] : typeof product === 'string' ? product : null;
  return {
    priceId: typeof price['id'] === 'string' ? price['id'] : null,
    productId,
    quantity,
    monthly: normalizeToMonthly(unit * quantity, cycle.interval, cycle.frequency),
    ...cycle,
  };
}

interface PaddleDiscount {
  id: string;
  type: string;
  amount: unknown;
  currency_code: unknown;
  recur: unknown;
  restrict_to: unknown;
}

/**
 * Discounts by ID for one run. `GET /discounts` lists only `active` ones unless told otherwise (a subscription
 * keeps an archived discount), and the docs say non-catalog (`mode=custom`, e.g. checkout recovery) discounts
 * aren't listed by default, so IDs missing from the first answer are asked for again with mode=custom.
 * A key without discount.read is detected on the first 403; MRR is then estimated before discounts.
 */
class DiscountResolver {
  private readonly cache = new Map<string, PaddleDiscount | null>();
  private permissionMissing = false;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly key: ParsedKey,
  ) {}

  get(id: string): PaddleDiscount | null {
    return this.cache.get(id) ?? null;
  }

  async load(ids: Iterable<string>): Promise<void> {
    const todo = [...new Set(ids)].filter((id) => DSC_ID.test(id) && !this.cache.has(id));
    for (let i = 0; i < todo.length && !this.permissionMissing; i += DISCOUNT_BATCH) {
      const chunk = todo.slice(i, i + DISCOUNT_BATCH);
      const found = await this.fetch(chunk, null);
      const missing = chunk.filter((id) => !found.has(id));
      if (missing.length > 0 && !this.permissionMissing) {
        for (const [id, d] of await this.fetch(missing, 'custom')) found.set(id, d);
      }
      for (const id of chunk) this.cache.set(id, found.get(id) ?? null);
    }
  }

  private async fetch(ids: string[], mode: 'custom' | null): Promise<Map<string, PaddleDiscount>> {
    const out = new Map<string, PaddleDiscount>();
    let body: unknown;
    try {
      body = await paddleGet<unknown>(
        this.ctx,
        this.key,
        '/discounts',
        { id: ids.join(','), status: 'active,archived', mode: mode ?? undefined, per_page: SUBSCRIPTION_PAGE_SIZE },
        PERM_DISCOUNTS,
      );
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'permission') {
        this.permissionMissing = true;
        this.ctx.log('paddle_discount_permission_missing', { effect: 'mrr_before_discounts' });
        return out;
      }
      throw err; // budget, rate limit, 5xx: fail the snapshot
    }
    for (const d of asList(this.ctx, '/discounts', body).data) {
      if (isObject(d) && typeof d['id'] === 'string' && typeof d['type'] === 'string') {
        out.set(d['id'], d as unknown as PaddleDiscount);
      }
    }
    return out;
  }
}

/** The discount a subscription carries, if it still affects what each renewal bills. */
function activeDiscountId(sub: Record<string, unknown>, now: number): string | null {
  const d = sub['discount'];
  if (!isObject(d) || typeof d['id'] !== 'string') return null;
  // one-off: created in trial with a discount for the first billed period only; removed on renewal.
  if (d['type'] === 'one-off') return null;
  // ends_at: last billing period the discount applies to (maximum_recurring_intervals); null = forever.
  const ends = time(d['ends_at']);
  if (ends !== null && ends <= now) return null;
  return d['id'];
}

function scale(lines: Line[], factor: number): void {
  const f = Math.min(1, Math.max(0, factor));
  for (const l of lines) l.monthly *= f;
}

/**
 * Applies a Paddle discount to a subscription's lines:
 *   - recur=false: applies to one billing period only → not recurring revenue, ignored.
 *   - restrict_to: product or price IDs; null or empty means every item.
 *   - percentage: `amount` is a percentage ("10", "12.5") of the eligible items.
 *   - flat: `amount` off each renewal (minor units, `currency_code`), normalized to a month at the items'
 *     billing cycle, capped at their total and spread pro rata.
 *   - flat_per_seat: `amount` off per unit of quantity on each eligible item, capped at the item.
 *   A flat discount in another currency than the subscription's can't be applied and is counted unresolved.
 */
function applyDiscount(lines: Line[], d: PaddleDiscount, currency: string, stats: EstimateStats): void {
  if (d.recur !== true) return;
  const only = Array.isArray(d.restrict_to) && d.restrict_to.length > 0 ? (d.restrict_to as unknown[]) : null;
  const eligible = only
    ? lines.filter((l) => (l.priceId !== null && only.includes(l.priceId)) || (l.productId !== null && only.includes(l.productId)))
    : lines;
  const base = eligible.reduce((s, l) => s + l.monthly, 0);
  if (eligible.length === 0 || base <= 0) return;

  if (d.type === 'percentage') {
    const pct = decimal(d.amount);
    if (pct === null) stats.unresolvedDiscounts += 1;
    else scale(eligible, 1 - pct / 100);
    return;
  }
  const off = minor(d.amount);
  if ((d.type !== 'flat' && d.type !== 'flat_per_seat') || off === null || off < 0 || currencyOf(d.currency_code) !== currency) {
    stats.unresolvedDiscounts += 1;
    return;
  }
  if (d.type === 'flat') {
    const first = eligible[0]!;
    scale(eligible, 1 - normalizeToMonthly(off, first.interval, first.frequency) / base);
    return;
  }
  for (const l of eligible) l.monthly = Math.max(0, l.monthly - normalizeToMonthly(off * l.quantity, l.interval, l.frequency));
}

interface PendingSubscription {
  currency: string | null;
  lines: Line[];
  /** Items that couldn't be priced in the subscription's currency. */
  unpriced: number;
  discountId: string | null;
}

/**
 * MRR and active-subscription count from the subscriptions themselves (sandbox, no metrics.read, or no metric
 * data yet). Every active and past_due subscription is read; trialing ones never are.
 *   - Per item: skipped when one-time, in an item-level trial or paused; otherwise unit price × quantity,
 *     normalized by the price's billing_cycle {interval, frequency}.
 *   - Price: see `unitAmountIn`. An item whose price can't be found in the subscription's currency is left
 *     out and counted in the `paddle_mrr_estimate` log.
 *   - Discount: the subscription's `discount`, see `activeDiscountId` and `applyDiscount`.
 *   - Count (SPEC §6, as for Stripe): subscriptions whose MRR is above 0. Free plans, 100% discounts and
 *     subscriptions whose only items are in trial don't count; one with an item that couldn't be priced does
 *     (its MRR is unknown, not 0).
 * Limits: list prices include tax when the price is tax-inclusive (`tax_mode` internal, or location / account
 * setting resolving to inclusive), and a customer whose country has its own price in the subscription's
 * currency pays that one. Paddle's metric has neither problem, so it wins when present.
 */
async function estimateFromSubscriptions(
  ctx: ProviderContext,
  key: ParsedKey,
): Promise<{ mrr: MoneyMap; activeSubscriptions: number; stats: EstimateStats }> {
  const now = ctx.now();
  const stats: EstimateStats = { trialItems: 0, unpricedItems: 0, overridePrices: 0, unresolvedDiscounts: 0, zeroSubscriptions: 0 };
  const pending: PendingSubscription[] = [];

  for await (const raw of paginate(
    ctx,
    key,
    '/subscriptions',
    { status: 'active,past_due', per_page: SUBSCRIPTION_PAGE_SIZE },
    PERM_SUBSCRIPTIONS,
    SUB_ID,
  )) {
    if (!isObject(raw) || (raw['status'] !== 'active' && raw['status'] !== 'past_due')) continue;
    const currency = currencyOf(raw['currency_code']);
    const lines: Line[] = [];
    let unpriced = 0;
    for (const item of Array.isArray(raw['items']) ? raw['items'] : []) {
      const line = currency ? itemLine(item, currency, cycleOf(raw['billing_cycle']), stats) : 'unpriced';
      if (line === 'unpriced') unpriced += 1;
      else if (line) lines.push(line);
    }
    stats.unpricedItems += unpriced;
    pending.push({ currency, lines, unpriced, discountId: lines.length > 0 ? activeDiscountId(raw, now) : null });
  }

  const discounts = new DiscountResolver(ctx, key);
  await discounts.load(pending.flatMap((p) => (p.discountId ? [p.discountId] : [])));

  const mrr: MoneyMap = {};
  let activeSubscriptions = 0;
  for (const p of pending) {
    if (p.currency && p.discountId) {
      const d = discounts.get(p.discountId);
      if (d) applyDiscount(p.lines, d, p.currency, stats);
      else stats.unresolvedDiscounts += 1;
    }
    const amount = Math.round(p.lines.reduce((s, l) => s + Math.max(0, l.monthly), 0));
    if (p.currency && amount > 0) addToMoney(mrr, p.currency, amount);
    if (amount > 0 || p.unpriced > 0) activeSubscriptions += 1;
    else stats.zeroSubscriptions += 1;
  }
  return { mrr, activeSubscriptions, stats };
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  const key = requireKey(input);

  const metric = key.testMode ? null : await metricsMrr(ctx, key);
  if (metric) {
    // SPEC §6: active + past_due; trials are counted on their own.
    const activeSubscriptions = await countSubscriptions(ctx, key, 'active,past_due');
    const activeTrials = await countSubscriptions(ctx, key, 'trialing');
    ctx.log('paddle_snapshot', {
      source: 'metrics',
      day: metric.day,
      subscriptions: activeSubscriptions,
      trials: activeTrials,
      currencies: Object.keys(metric.mrr),
    });
    return snapshotOf(metric.mrr, activeSubscriptions, activeTrials);
  }

  const estimate = await estimateFromSubscriptions(ctx, key);
  const activeTrials = await countSubscriptions(ctx, key, 'trialing');
  ctx.log('paddle_mrr_estimate', { ...estimate.stats });
  ctx.log('paddle_snapshot', {
    source: 'subscriptions',
    subscriptions: estimate.activeSubscriptions,
    trials: activeTrials,
    currencies: Object.keys(estimate.mrr),
  });
  return snapshotOf(estimate.mrr, estimate.activeSubscriptions, activeTrials);
}

function snapshotOf(mrr: MoneyMap, activeSubscriptions: number, activeTrials: number): MetricsSnapshot {
  return {
    mrr,
    activeSubscriptions,
    activeTrials,
    revenuePeriod: null, // derived from daily_revenue by the sync engine
    revenuePeriodDays: null,
    newCustomers: null,
  };
}

// ---------- revenue ----------

/**
 * Resumable traversal state. `since` is the window start of the call that created the cursor; `after` is the
 * last ID of `phase` already read (both lists are newest first).
 */
interface RevenueCursor {
  v: 1;
  since: number;
  phase: 'transactions' | 'adjustments';
  after: string | null;
}

function encodeCursor(c: RevenueCursor): string {
  return JSON.stringify(c);
}

function decodeCursor(raw: string): RevenueCursor | null {
  try {
    const c = JSON.parse(raw) as unknown;
    if (!isObject(c) || c['v'] !== 1) return null;
    const { since, phase, after } = c;
    if (typeof since !== 'number' || !Number.isFinite(since)) return null;
    if (phase !== 'transactions' && phase !== 'adjustments') return null;
    const re = phase === 'transactions' ? TXN_ID : ADJ_ID;
    if (after !== null && (typeof after !== 'string' || !re.test(after))) return null;
    return { v: 1, since, phase, after };
  } catch {
    return null;
  }
}

interface RevenueStats {
  zero: number;
  beforeWindow: number;
  unreadable: number;
}

/** Moment the money moved: the newest captured payment (a renewal recovered in dunning, an invoice paid late). */
function capturedAt(payments: unknown): number | null {
  if (!Array.isArray(payments)) return null;
  for (const p of payments) {
    if (isObject(p) && p['status'] === 'captured') {
      const t = time(p['captured_at']);
      if (t !== null) return t;
    }
  }
  return null;
}

/** First catalog product on the transaction. Non-catalog (`custom`) items are named per sale, so they're left out. */
function productName(details: Record<string, unknown>): string | null {
  const items = Array.isArray(details['line_items']) ? details['line_items'] : [];
  for (const li of items) {
    const product = isObject(li) ? li['product'] : undefined;
    if (!isObject(product) || product['type'] !== 'standard') continue;
    const name = product['name'];
    if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 200);
  }
  return null;
}

/**
 * A completed transaction → a charge of grand_total − grand_total_tax (what the customer paid, without the
 * tax Paddle remits), dated when the payment was captured (billed_at, then created_at, if no capture is
 * listed). Transactions are listed by `updated_at` (completion bumps it), so a payment recovered days after
 * billing is still found; one captured before `since` was already counted and is skipped.
 */
function chargeEvent(raw: unknown, since: number, stats: RevenueStats): RevenueEvent | null {
  if (!isObject(raw) || typeof raw['id'] !== 'string' || !isObject(raw['details'])) {
    stats.unreadable += 1;
    return null;
  }
  if (raw['status'] !== 'completed') return null;
  const details = raw['details'];
  const totals = isObject(details['totals']) ? details['totals'] : {};
  const grand = minor(totals['grand_total']);
  const tax = minor(totals['grand_total_tax']) ?? minor(totals['tax']);
  const currency = currencyOf(totals['currency_code']) ?? currencyOf(raw['currency_code']);
  const at = capturedAt(raw['payments']) ?? time(raw['billed_at']) ?? time(raw['created_at']);
  if (grand === null || tax === null || !currency || at === null) {
    stats.unreadable += 1;
    return null;
  }
  const amount = grand - tax;
  if (amount <= 0) {
    stats.zero += 1; // fully credited, $0 payment-method updates, credit-producing changes
    return null;
  }
  if (at < since) {
    stats.beforeWindow += 1;
    return null;
  }
  return {
    externalId: raw['id'],
    occurredAt: at,
    type: 'charge',
    amount,
    currency,
    fee: minor(totals['fee']), // null until Paddle has processed the fee
    description: productName(details),
  };
}

const REVENUE_ACTIONS = new Set(['refund', 'chargeback', 'chargeback_reverse']);
const COUNTED_ADJUSTMENT_STATUSES = new Set(['approved', 'reversed']);

/**
 * An approved refund or chargeback → negative total − tax; a chargeback reversal → positive. A reversed
 * chargeback (status `reversed`) still counts: its reversal is a separate adjustment, so the two net out.
 * Tax-only refunds (total = tax) are skipped. `credit` adjustments are ignored: credit goes to the customer's
 * balance and lowers a later transaction's grand_total, which is where it shows up.
 * Dates: a refund at `updated_at` (Paddle approves most refunds after review, and approval is its last
 * change); chargebacks at `created_at` (a chargeback's `updated_at` moves when it is reversed).
 */
function adjustmentEvent(raw: unknown, since: number, stats: RevenueStats): RevenueEvent | null {
  if (!isObject(raw) || typeof raw['id'] !== 'string') {
    stats.unreadable += 1;
    return null;
  }
  const action = raw['action'];
  if (typeof action !== 'string' || !REVENUE_ACTIONS.has(action)) return null;
  if (typeof raw['status'] !== 'string' || !COUNTED_ADJUSTMENT_STATUSES.has(raw['status'])) return null;
  const totals = isObject(raw['totals']) ? raw['totals'] : {};
  const total = minor(totals['total']);
  const tax = minor(totals['tax']);
  const currency = currencyOf(totals['currency_code']) ?? currencyOf(raw['currency_code']);
  const created = time(raw['created_at']);
  const at = action === 'refund' ? time(raw['updated_at']) ?? created : created;
  if (total === null || tax === null || !currency || at === null) {
    stats.unreadable += 1;
    return null;
  }
  const net = Math.abs(total - tax);
  if (net === 0) {
    stats.zero += 1;
    return null;
  }
  if (at < since) {
    stats.beforeWindow += 1;
    return null;
  }
  const positive = action === 'chargeback_reverse';
  return {
    externalId: raw['id'],
    occurredAt: at,
    type: positive ? 'charge' : 'refund',
    amount: positive ? net : -net,
    currency,
    fee: null,
    description: null,
  };
}

async function fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage> {
  const key = requireKey(input);
  const resumed = req.cursor ? decodeCursor(req.cursor) : null;
  if (req.cursor && !resumed) ctx.log('paddle_cursor_invalid', { action: 'restart' }); // idempotent upserts make a restart safe
  if (!resumed && !Number.isFinite(req.since)) throw new ProviderError('invalid_input', 'Invalid revenue start time.');
  let cur: RevenueCursor = resumed ?? { v: 1, since: req.since, phase: 'transactions', after: null };

  const events = new Map<string, RevenueEvent>();
  const stats: RevenueStats = { zero: 0, beforeWindow: 0, unreadable: 0 };
  let pages = 0;
  const finish = (next: RevenueCursor | null, reason: string): RevenuePage => {
    ctx.log('paddle_revenue', { pages, events: events.size, phase: cur.phase, reason, ...stats });
    return { events: [...events.values()], daily: [], nextCursor: next ? encodeCursor(next) : null, done: next === null };
  };

  try {
    for (;;) {
      if (!hasBudget(ctx)) return finish(cur, 'budget');

      if (cur.phase === 'transactions') {
        const path = '/transactions';
        const page = asList(
          ctx,
          path,
          await paddleGet<unknown>(
            ctx,
            key,
            path,
            {
              status: 'completed',
              'updated_at[GTE]': rfc3339(cur.since),
              order_by: 'id[DESC]',
              per_page: TRANSACTION_PAGE_SIZE,
              after: cur.after ?? undefined,
            },
            PERM_TRANSACTIONS,
            { skipCount: true },
          ),
        );
        pages += 1;
        for (const t of page.data) {
          const ev = chargeEvent(t, cur.since, stats);
          if (ev) events.set(ev.externalId, ev);
        }
        cur =
          page.hasMore && page.data.length > 0
            ? { ...cur, after: lastId(ctx, path, page, TXN_ID) }
            : { ...cur, phase: 'adjustments', after: null };
        continue;
      }

      const path = '/adjustments';
      const page = asList(
        ctx,
        path,
        await paddleGet<unknown>(
          ctx,
          key,
          path,
          {
            action: 'refund,chargeback,chargeback_reverse',
            status: 'approved,reversed',
            order_by: 'id[DESC]',
            per_page: ADJUSTMENT_PAGE_SIZE,
            after: cur.after ?? undefined,
          },
          PERM_ADJUSTMENTS,
          { skipCount: true },
        ),
      );
      pages += 1;
      const floor = cur.since - REFUND_LOOKBACK_MS;
      let reachedFloor = false;
      for (const a of page.data) {
        const ev = adjustmentEvent(a, cur.since, stats);
        if (ev) events.set(ev.externalId, ev);
        const created = isObject(a) ? time(a['created_at']) : null;
        if (created !== null && created < floor) reachedFloor = true;
      }
      if (reachedFloor || !page.hasMore || page.data.length === 0) return finish(null, 'done');
      cur = { ...cur, after: lastId(ctx, path, page, ADJ_ID) };
    }
  } catch (err) {
    // Paddle blocks the IP for a minute: keep what was read and resume from the page that was refused.
    if (err instanceof RateLimitedError) return finish(cur, 'rate_limited');
    throw err;
  }
}

export const paddleAdapter: ProviderAdapter = {
  id: 'paddle',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
