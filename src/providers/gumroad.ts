/**
 * Gumroad adapter. Owner: Data Plane. SPEC.md §6.10.
 *
 * API v2, https://gumroad.com/api (read 2026-11-05). Gumroad is open source (https://github.com/antiwork/gumroad);
 * where the docs are silent or ambiguous, the behaviour below was read from main on 2026-11-05:
 * app/controllers/api/v2/{base,sales,subscribers,links,users}_controller.rb, app/models/{purchase,subscription}.rb,
 * app/models/concerns/product/as_json.rb, app/models/oauth_application.rb, config/initializers/doorkeeper.rb.
 *
 *  - Auth: `Authorization: Bearer <access token>` (Doorkeeper; the docs' cURL examples send `access_token=`
 *    as a parameter, the header keeps the token out of URLs). "Generate access token" on an application
 *    (Settings → Advanced → Applications) issues a token with the APPLICATION's scopes, and an application
 *    created in that form gets every public scope: account, edit_products, edit_sales (refunds),
 *    view_sales, view_payouts, … There is no way to narrow it there, so the token has full access (the
 *    registry warns). Tokens don't expire until revoked. 401 = invalid / revoked token, 403 = missing
 *    scope; both with an empty body.
 *  - Other failures: HTTP 200 with `{"success": false, "message": "…"}` (unknown product / sale), or 400 with
 *    `{"error": "…"}` (bad parameter, or a sales query that timed out on a huge account).
 *  - GET /v2/user → `user.name`, `user.url`: the seller's own profile, read for the account label only.
 *  - GET /v2/products → every non-deleted product, newest first. The source pages it 10 at a time with
 *    `next_page_key` (the docs don't mention paging; the loop also ends when no key comes back).
 *    Memberships: `is_tiered_membership: true` and, per tier option, `recurrence_prices.<recurrence>.price_cents`
 *    in the product's `currency` (minor units; the minimum price when `is_pay_what_you_want`). Legacy
 *    non-tiered subscriptions: `subscription_duration` + `price`. Deleting a product cancels its
 *    subscriptions, so this list covers every live subscription. Installment plans aren't memberships.
 *  - GET /v2/products/:id/subscribers?paginated=true → the product's ACTIVE subscriptions only ("terminated if
 *    any of failed_at, ended_at, or cancelled_at … are in the past"; test subscriptions excluded), 100 per
 *    page, newest first, `next_page_key`. Read: id, recurrence (monthly | quarterly | biannually | yearly |
 *    every_two_years), status (alive | pending_cancellation | pending_failure | payment_method_update_required
 *    | failed_payment | fixed_subscription_period_ended | cancelled), free_trial_ends_at, cancelled_at,
 *    ended_at, failed_at, purchase_ids. A subscriber has NO price: what it pays (tier, pay-what-you-want
 *    amount, offer code, purchasing-power-parity price, quantity, a price kept from before a price change)
 *    isn't in the API. See MRR below.
 *  - GET /v2/sales → successful sales plus $0 free-trial sign-ups, newest first (created_at, id desc), exactly
 *    10 per page, keyset `page_key` (new sales don't shift pages). `after=YYYY-MM-DD` keeps created_at ≥ that
 *    day, `product_id` filters. Test purchases are a separate state and never listed. GET /v2/sales/:id
 *    returns one. Money on a sale is canonical USD cents whatever `currency` says (`currency` is the
 *    listing currency of the formatted strings; the docs' `buyer_presentment` notes call the top-level
 *    fields "canonical USD amounts", and `amount_refundable_in_currency` is price converted out of USD):
 *      price        what the seller sells for, incl. tips and shipping, and incl. tax the SELLER collected
 *                   (legacy US sales tax). EXCLUDES the tax Gumroad collects as merchant of record, which
 *                   is added on top of what the buyer pays (Purchase: "total_transaction_cents … is
 *                   equivalent to price_cents + gumroad_tax_cents").
 *      tax_cents    Gumroad's MoR tax (not in `price`) or, on legacy sales, the seller's tax (in `price`).
 *                   `tax_included_in_price` is true only for tax that was inclusive in the price.
 *      gumroad_fee  Gumroad's fee.
 *      refunded (full), partially_refunded, chargedback (not reversed), amount_refundable_in_currency (a
 *      formatted amount like "8" or "1,234.5" in the listing currency). No refund date, no updated_at.
 *  - Rate limits for these reads aren't documented. The app's own throttle (Rack::Attack, 429 + Retry-After)
 *    only covers /v2/sales with the deprecated `page` parameter, which this file never sends. Revenue uses
 *    `rateLimit: 'yield'` and returns its cursor; snapshot and verify retry a short wait and otherwise fail
 *    (a partial snapshot would be wrong).
 *  - No sandbox: every token is live (testMode false).
 *
 * Metrics (SPEC §6):
 *   MRR          per paying subscriber (below) of a membership product: the amount of its most recent
 *                charge — USD, net of inclusive seller tax — normalized to a month by the subscriber's
 *                recurrence. That charge comes from the product's sales of the last 35 days (monthly
 *                renewals; up to 10 subscribers per request) or else GET /v2/sales/{newest purchase id}.
 *                When the charge can't be read within the budget, or it is an upgrade proration, a $0
 *                charge, or billed at another recurrence, the subscriber is priced at its tier's list
 *                price for its recurrence (product currency, before discounts); with the tier unknown and
 *                tiers priced differently, at the cheapest tier (a lower bound). Fallbacks are counted
 *                in the log. Trials and cancelled-and-ended subscriptions are left out.
 *   Active subs  paying subscribers whose amount is > 0. Paying = alive, pending_cancellation (still
 *                active until the period ends), pending_failure (renewal failed and is being retried, like
 *                past_due), payment_method_update_required (renewal paused for an Indian card mandate).
 *   Trials       subscribers whose free_trial_ends_at is in the future.
 *   Revenue      one `charge` per sale with price > 0 (USD, net of inclusive seller tax, fee = gumroad_fee,
 *                description = product name) and one `refund` per refunded / charged-back sale.
 *
 * Request plan:
 *   verify        2 requests: GET /user (label; any read scope), GET /sales?after=<today> (view_sales).
 *   fetchSnapshot GET /products (all pages) + GET /products/{id}/subscribers (all pages) per membership
 *                 product. Running out of budget there throws BudgetExhaustedError: counts would be wrong.
 *                 Then, while the budget lasts: GET /sales?product_id=…&after=<35 days ago> per product until
 *                 its paying subscribers are found, then GET /sales/{id} per subscriber still unknown
 *                 (subscribers whose list price is ambiguous first). Whatever is left uses list prices.
 *   fetchRevenue  GET /sales?after=<floor day> newest → oldest with page_key, resumable (cursor = window +
 *                 page_key).
 *
 * Known limitations:
 *   - Refunds have no date in the API. A refund is dated at the sale it reverses (stable id `<sale id>:refund`),
 *     so it lands on the sale's day, not the day it happened: net revenue per sale day is right, refunds per
 *     day aren't. Incremental syncs re-read sales from 30 days before the window to catch late refunds; the
 *     first backfill (a window over 45 days) doesn't, since nothing older is stored. Refunds issued more than
 *     ~32 days after the sale are missed.
 *   - A partial refund is exact for sales listed in USD (`amount_refundable_in_currency` is then USD). In
 *     another listing currency it can't be derived without parsing display strings: skipped (logged) until
 *     the sale is fully refunded. A chargeback reverses the full amount even after a partial refund.
 *   - Seller-collected tax that was added on top of the price (legacy US sales tax, before Gumroad became
 *     merchant of record for it) stays in `price`: `tax_cents` alone can't tell it from Gumroad's tax.
 *   - MRR from the last charge carries what that charge had: an offer code that won't renew, a tip on the
 *     first charge, or the old price after a price change that is pending. List-price fallbacks ignore
 *     discounts, purchasing-power-parity prices, quantity and pay-what-you-want amounts (minimum price).
 *   - The order of `purchase_ids` is undocumented; the last id is taken as the newest charge (the source
 *     loads them unordered, in practice by id). A wrong guess prices that subscriber at an older charge.
 *   - 10 sales per request: a 20-request revenue sync reads 200 sales, and each incremental pass re-reads ~32
 *     days of sales. Sellers with thousands of sales a month see new revenue a few syncs late, and their
 *     snapshot falls back to list prices for subscribers it can't look up.
 */

import { addToMoney, normalizeCurrency, normalizeToMonthly, type BillingInterval, type MoneyMap } from '../lib/money';
import { DAY, dayKey } from '../lib/time';
import {
  BudgetExhaustedError,
  RateLimitedError,
  buildUrl,
  fetchJson,
  hasBudget,
  sanitizeErrorText,
  type QueryValue,
  type RequestSpec,
} from './http';
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

export const GUMROAD_API_BASE = 'https://api.gumroad.com/v2';

const PROVIDER = 'Gumroad';
/** OAuth scope for sales and subscribers, used verbatim in 403 messages (registry permissions). */
export const PERM_SALES = 'view_sales';
/** Fixed by Gumroad (Api::V2::SalesController::RESULTS_PER_PAGE). */
export const SALES_PER_PAGE = 10;
/** Incremental syncs re-read sales this far before the window for refunds of already-stored sales. */
export const REFUND_LOOKBACK_MS = 30 * DAY;
/** A window longer than this is the first backfill: no older sales are stored, so no refund lookback. */
export const FIRST_BACKFILL_MIN_MS = 45 * DAY;
/** How far back the snapshot reads each membership product's sales: covers every monthly renewal. */
export const RECENT_CHARGES_MS = 35 * DAY;

const MAX_DESCRIPTION = 120;
const CURRENCY_USD = 'USD';

// Snapshot warnings (`MetricsSnapshot.warnings`). MRR is always an estimate here (README); these name the
// subscribers it had to guess or leave out.
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const have = (n: number) => (n === 1 ? 'has' : 'have');
const are = (n: number) => (n === 1 ? 'is' : 'are');

export const gumroadUnpricedWarning = (subscribers: number) =>
  `${plural(subscribers, 'subscriber', 'subscribers')} ${have(subscribers)} no price hoomuch can find, so they’re left out of MRR and active subscriptions.`;
export const gumroadGuessedPriceWarning = (subscribers: number) =>
  `MRR may be low: ${plural(subscribers, 'subscriber', 'subscribers')} ${are(subscribers)} priced at the cheapest tier or the pay-what-you-want minimum, because their latest charge couldn’t be used.`;
export const gumroadListPriceWarning = (subscribers: number) =>
  `${plural(subscribers, 'subscriber', 'subscribers')} ${are(subscribers)} priced at list price, before discounts, because there were too many to look up in one sync.`;
export const gumroadUnknownStatusWarning = (subscribers: number) =>
  `${plural(subscribers, 'subscriber', 'subscribers')} ${have(subscribers)} a status hoomuch doesn’t know yet, so they aren’t counted.`;

/** Gumroad recurrences (BasePrice::Recurrence) as billing periods. */
const RECURRENCES: Readonly<Record<string, { interval: BillingInterval; count: number }>> = {
  monthly: { interval: 'month', count: 1 },
  quarterly: { interval: 'month', count: 3 },
  biannually: { interval: 'month', count: 6 },
  yearly: { interval: 'year', count: 1 },
  every_two_years: { interval: 'year', count: 2 },
};

/**
 * Own keys only: `recurrence` comes from Gumroad, and a plain lookup of "constructor" or
 * "__proto__" would return Object's own members (NaN MRR, then every USD amount dropped).
 */
function recurrenceOf(rec: string | null | undefined): { interval: BillingInterval; count: number } | undefined {
  return rec && Object.hasOwn(RECURRENCES, rec) ? RECURRENCES[rec] : undefined;
}

/** Statuses of a subscription that is still collecting (or about to collect) money. */
const PAYING_STATUSES: ReadonlySet<string> = new Set([
  'alive',
  'pending_cancellation',
  'pending_failure',
  'payment_method_update_required',
]);
/** Terminal statuses (the endpoint shouldn't return these; checked anyway). */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['failed_payment', 'fixed_subscription_period_ended', 'cancelled']);

// ---------- readers (the API is untyped JSON; never trust shapes) ----------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function int(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function time(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function describe(name: unknown): string | null {
  const s = str(name)?.replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > MAX_DESCRIPTION ? s.slice(0, MAX_DESCRIPTION - 1) + '…' : s;
}

/** "8", "8.5", "1,234.56" (Money#format, symbol off) → minor units of a 2-decimal currency. */
function parseFormattedAmount(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

// ---------- token ----------

/** Doorkeeper tokens are opaque; this only keeps stray characters out of the header. */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;

function parseToken(raw: string | undefined): { token: string } | { error: string } {
  const token = (raw ?? '').trim();
  if (!token) {
    return { error: 'Paste the access token of your Gumroad application (Settings → Advanced → Applications).' };
  }
  if (/^bearer\s/i.test(token)) return { error: 'Paste only the access token, without “Bearer”.' };
  if (!TOKEN_RE.test(token)) {
    return { error: 'That doesn’t look like a Gumroad access token. Copy the token shown after “Generate access token”.' };
  }
  return { token };
}

function requireToken(input: ConnectionInput): string {
  const parsed = parseToken(input.credentials['apiKey']);
  if ('error' in parsed) throw new ProviderError('invalid_input', parsed.error, { field: 'apiKey' });
  return parsed.token;
}

// ---------- HTTP ----------

function gumroadGet(
  ctx: ProviderContext,
  token: string,
  path: string,
  query: Record<string, QueryValue> = {},
  extra: Partial<RequestSpec> = {},
): Promise<unknown> {
  return fetchJson<unknown>(ctx, {
    provider: PROVIDER,
    url: buildUrl(GUMROAD_API_BASE, path, query),
    headers: { Authorization: `Bearer ${token}` },
    ...extra,
  });
}

/** True for Gumroad's in-band failure (`{"success": false, "message": …}` with HTTP 200). */
function isFailure(body: unknown): boolean {
  return isObject(body) && body['success'] === false;
}

function unreadable(ctx: ProviderContext, path: string, body: unknown): ProviderError {
  const message = isObject(body) ? str(body['message']) : null;
  ctx.log('gumroad_bad_payload', { path, ...(message ? { message: sanitizeErrorText(message, 120) } : {}) });
  return new ProviderError(
    'upstream',
    message ? `${PROVIDER} returned an error: ${sanitizeErrorText(message, 160)}` : `${PROVIDER} returned a response hoomuch couldn’t read.`,
  );
}

/** next_page_key is opaque ("20230119081040000000-123456"); this only keeps it URL- and log-safe. */
const PAGE_KEY_RE = /^[A-Za-z0-9._:+/=-]{1,200}$/;

interface Page {
  items: Json[];
  next: string | null;
}

/** A list response (`products`, `subscribers` or `sales` + optional `next_page_key`). */
function parsePage(ctx: ProviderContext, path: string, body: unknown, key: string, current: string | null): Page {
  if (!isObject(body) || body['success'] === false || !Array.isArray(body[key])) throw unreadable(ctx, path, body);
  const raw = body['next_page_key'];
  let next: string | null = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    // A bad or repeated key would re-read the same page forever.
    if (typeof raw !== 'string' || !PAGE_KEY_RE.test(raw) || raw === current) throw unreadable(ctx, path, null);
    next = raw;
  }
  return { items: body[key].filter(isObject), next };
}

// ---------- Gumroad shapes (only the fields we read; never names, emails or addresses) ----------

interface TierOption {
  category: string;
  name: string;
  /** recurrence → price_cents (product currency). */
  prices: Map<string, number>;
  pwyw: boolean;
  priceDifference: number;
}

interface MembershipProduct {
  id: string;
  /** Uppercase ISO code of the list prices, null if Gumroad didn't send one. */
  currency: string | null;
  tiered: boolean;
  /** Legacy non-tiered subscription: its only recurrence and base price. */
  legacyRecurrence: string | null;
  basePrice: number | null;
  options: TierOption[];
}

interface Subscriber {
  id: string;
  recurrence: string | null;
  status: string | null;
  trialEndsAt: number | null;
  cancelledAt: number | null;
  endedAt: number | null;
  failedAt: number | null;
  lastPurchaseId: string | null;
}

interface Sale {
  id: string;
  createdAt: number | null;
  productName: string | null;
  subscriptionId: string | null;
  recurrence: string | null;
  /** USD cents, as Gumroad reports it (incl. seller-collected tax). */
  price: number;
  /** USD cents net of inclusive seller tax, ≥ 0. */
  net: number;
  fee: number | null;
  /** Listing currency of the formatted strings (lowercase ISO from Gumroad, uppercased here). */
  listingCurrency: string | null;
  refunded: boolean;
  partiallyRefunded: boolean;
  chargedback: boolean;
  refundable: unknown;
  upgrade: boolean;
  noMoney: boolean;
  /** Variant category title → selected option name (seller-defined, e.g. { Tier: "Premium" }). */
  variants: Record<string, string>;
}

function currencyOf(v: unknown): string | null {
  const c = str(v);
  return c && /^[A-Za-z]{3}$/.test(c) ? normalizeCurrency(c) : null;
}

function toMembership(p: Json): MembershipProduct | null {
  const id = str(p['id']);
  if (!id || p['deleted'] === true) return null;
  const tiered = p['is_tiered_membership'] === true;
  const legacy = str(p['subscription_duration']);
  const legacyRecurrence = !tiered && recurrenceOf(legacy) ? legacy : null;
  if (!tiered && !legacyRecurrence) return null;
  const options: TierOption[] = [];
  for (const cat of Array.isArray(p['variants']) ? p['variants'].filter(isObject) : []) {
    const category = str(cat['title']) ?? '';
    for (const o of Array.isArray(cat['options']) ? cat['options'].filter(isObject) : []) {
      const prices = new Map<string, number>();
      const rp = o['recurrence_prices'];
      if (isObject(rp)) {
        for (const [rec, v] of Object.entries(rp)) {
          const cents = isObject(v) ? int(v['price_cents']) : null;
          if (cents !== null && cents >= 0) prices.set(rec, cents);
        }
      }
      options.push({
        category,
        name: str(o['name']) ?? '',
        prices,
        pwyw: o['is_pay_what_you_want'] === true,
        priceDifference: int(o['price_difference']) ?? 0,
      });
    }
  }
  return {
    id,
    currency: currencyOf(p['currency']),
    tiered,
    legacyRecurrence,
    basePrice: int(p['price']),
    options,
  };
}

function toSubscriber(s: Json): Subscriber | null {
  const id = str(s['id']);
  if (!id) return null;
  const ids = Array.isArray(s['purchase_ids']) ? s['purchase_ids'].map(str).filter((x): x is string => x !== null) : [];
  return {
    id,
    recurrence: str(s['recurrence']),
    status: str(s['status']),
    trialEndsAt: time(s['free_trial_ends_at']),
    cancelledAt: time(s['cancelled_at']),
    endedAt: time(s['ended_at']),
    failedAt: time(s['failed_at']),
    lastPurchaseId: ids[ids.length - 1] ?? null,
  };
}

function toSale(s: unknown): Sale | null {
  if (!isObject(s)) return null;
  const id = str(s['id']);
  if (!id) return null;
  const price = Math.max(0, int(s['price']) ?? 0);
  // Inclusive tax sits inside `price`; Gumroad's merchant-of-record tax is never in it (see header).
  const inclusiveTax = s['tax_included_in_price'] === true ? Math.max(0, int(s['tax_cents']) ?? 0) : 0;
  const fee = int(s['gumroad_fee']);
  const variants: Record<string, string> = {};
  if (isObject(s['variants'])) {
    for (const [k, v] of Object.entries(s['variants'])) if (typeof v === 'string') variants[k] = v;
  }
  return {
    id,
    createdAt: time(s['created_at']),
    productName: describe(s['product_name']),
    subscriptionId: str(s['subscription_id']),
    recurrence: str(s['subscription_duration']),
    price,
    net: Math.max(0, price - Math.min(price, inclusiveTax)),
    fee: fee !== null && fee >= 0 ? fee : null,
    listingCurrency: currencyOf(s['currency']),
    refunded: s['refunded'] === true,
    partiallyRefunded: s['partially_refunded'] === true,
    chargedback: s['chargedback'] === true,
    refundable: s['amount_refundable_in_currency'],
    upgrade: s['is_upgrade_purchase'] === true,
    // A gift's money is on the giver's sale; `test` only appears on webhook test payloads.
    noMoney: s['is_gift_receiver_purchase'] === true || s['test'] === true,
    variants,
  };
}

/**
 * Net amount (USD cents, > 0) reversed by refunds and chargebacks, 0 when none, or null for a partial
 * refund that can't be priced (listing currency other than USD).
 */
function reversedNet(s: Sale): number | null {
  if (s.price <= 0 || s.net <= 0) return 0;
  if (s.refunded || s.chargedback) return s.net;
  if (!s.partiallyRefunded) return 0;
  if (s.listingCurrency !== CURRENCY_USD) return null;
  const refundable = parseFormattedAmount(s.refundable);
  if (refundable === null) return null;
  const refundedGross = Math.min(s.price, Math.max(0, s.price - refundable));
  return Math.round((refundedGross * s.net) / s.price);
}

// ---------- verify ----------

export const AUTH_ERROR =
  'Gumroad rejected this access token. Copy the token shown after “Generate access token” (not the application ID or secret), and check that the application wasn’t deleted.';

function accountLabel(body: unknown): string {
  const user = isObject(body) && isObject(body['user']) ? body['user'] : {};
  const name = str(user['name']);
  if (name) return name.length > 80 ? name.slice(0, 79) + '…' : name;
  const url = str(user['url']);
  if (url) {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/+|\/+$/g, '');
      return path ? `${u.host}/${path}` : u.host;
    } catch {
      // fall through
    }
  }
  return 'Gumroad';
}

async function verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult> {
  const parsed = parseToken(input.credentials['apiKey']);
  if ('error' in parsed) return { ok: false, error: parsed.error, field: 'apiKey' };
  const { token } = parsed;
  let label: string;
  try {
    const user = await gumroadGet(ctx, token, '/user');
    if (!isObject(user) || isFailure(user)) throw unreadable(ctx, '/user', user);
    label = accountLabel(user);
    // One sales page proves view_sales (subscribers need the same scope). Today only: cheap on any account.
    const sales = await gumroadGet(ctx, token, '/sales', { after: dayKey(ctx.now()) }, { permission: PERM_SALES });
    parsePage(ctx, '/sales', sales, 'sales', null);
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') return { ok: false, error: AUTH_ERROR, field: 'apiKey' };
    if (err instanceof ProviderError && err.kind === 'permission') {
      return {
        ok: false,
        error: `This Gumroad token can’t read sales (the “${PERM_SALES}” scope). Generate the token from an application in Settings → Advanced.`,
        field: 'apiKey',
      };
    }
    throw err; // rate limit / upstream: transient, described by the caller
  }
  ctx.log('gumroad_verified', {});
  return { ok: true, accountLabel: label, config: {}, testMode: false, warnings: [] };
}

// ---------- fetchSnapshot ----------

async function listProducts(ctx: ProviderContext, token: string): Promise<Json[]> {
  const out: Json[] = [];
  let key: string | null = null;
  for (;;) {
    const body = await gumroadGet(ctx, token, '/products', { page_key: key });
    const page = parsePage(ctx, '/products', body, 'products', key);
    out.push(...page.items);
    if (!page.next) return out;
    key = page.next;
  }
}

/** All active subscribers of a product, or null if the product vanished since it was listed. */
async function listSubscribers(ctx: ProviderContext, token: string, productId: string): Promise<Subscriber[] | null> {
  const path = `/products/${encodeURIComponent(productId)}/subscribers`;
  const out: Subscriber[] = [];
  let key: string | null = null;
  for (;;) {
    let body: unknown;
    try {
      body = await gumroadGet(ctx, token, path, { paginated: 'true', page_key: key }, { permission: PERM_SALES });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found' && key === null) return null;
      throw err;
    }
    if (isFailure(body) && key === null) return null; // "The product was not found."
    const page = parsePage(ctx, path, body, 'subscribers', key);
    for (const s of page.items) {
      const sub = toSubscriber(s);
      if (sub) out.push(sub);
    }
    if (!page.next) return out;
    key = page.next;
  }
}

type SubscriberKind = 'paying' | 'trial' | 'none' | 'unknown';

/** SPEC §6: paying, trial, or not counted. `unknown` = a status this file doesn't know (not counted, logged). */
export function classifySubscriber(s: Pick<Subscriber, 'status' | 'trialEndsAt' | 'cancelledAt' | 'endedAt' | 'failedAt'>, now: number): SubscriberKind {
  const status = s.status ?? '';
  if (ENDED_STATUSES.has(status)) return 'none';
  if ((s.endedAt !== null && s.endedAt <= now) || (s.failedAt !== null && s.failedAt <= now)) return 'none';
  if (s.cancelledAt !== null && s.cancelledAt <= now) return 'none';
  if (!PAYING_STATUSES.has(status)) return 'unknown';
  if (s.trialEndsAt !== null && s.trialEndsAt > now) return 'trial';
  return 'paying';
}

interface Member {
  sub: Subscriber;
  product: MembershipProduct;
  /** Newest sale of the subscription we found, once looked up. */
  latest: Sale | null;
  looked: boolean;
}

interface Priced {
  /** Per billing period, minor units. */
  amount: number;
  currency: string;
  source: 'charge' | 'list' | 'list_estimated';
}

/** The product's tier option named by a sale's variants ({ "Tier": "Premium" }), if any. */
function optionOf(product: MembershipProduct, variants: Record<string, string>): TierOption | null {
  for (const [category, name] of Object.entries(variants)) {
    const hit =
      product.options.find((o) => o.category === category && o.name === name) ??
      product.options.find((o) => o.category.toLowerCase() === category.toLowerCase() && o.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * List price for one billing period at `recurrence` (product currency). A known tier prices itself; an
 * unknown one is exact only when every tier costs the same, else the cheapest tier (estimated).
 */
function listPrice(product: MembershipProduct, recurrence: string, option: TierOption | null): Priced | null {
  if (!product.currency) return null;
  if (!product.tiered) {
    if (product.legacyRecurrence !== recurrence || product.basePrice === null) return null;
    const amount = product.basePrice + (option?.priceDifference ?? 0);
    return amount >= 0 ? { amount, currency: product.currency, source: option?.pwyw ? 'list_estimated' : 'list' } : null;
  }
  if (option) {
    const amount = option.prices.get(recurrence);
    if (amount !== undefined) return { amount, currency: product.currency, source: option.pwyw ? 'list_estimated' : 'list' };
  }
  const offered = product.options.filter((o) => o.prices.has(recurrence));
  if (offered.length === 0) return null;
  const amounts = offered.map((o) => o.prices.get(recurrence)!);
  const distinct = new Set(amounts);
  const positive = amounts.filter((a) => a > 0);
  const amount = distinct.size === 1 ? amounts[0]! : positive.length > 0 ? Math.min(...positive) : 0;
  // A known tier that no longer offers this recurrence is a guess too.
  const exact = distinct.size === 1 && !offered.some((o) => o.pwyw) && !option;
  return { amount, currency: product.currency, source: exact ? 'list' : 'list_estimated' };
}

/** What a paying subscriber is billed per period: its newest charge if usable, else a list price. */
function priceMember(m: Member): Priced | null {
  const rec = m.sub.recurrence;
  if (!rec || !recurrenceOf(rec)) return null;
  const s = m.latest;
  if (s && !s.upgrade && !s.noMoney && s.net > 0 && (s.recurrence === null || s.recurrence === rec)) {
    return { amount: s.net, currency: CURRENCY_USD, source: 'charge' };
  }
  return listPrice(m.product, rec, s ? optionOf(m.product, s.variants) : null);
}

/** True when the list-price fallback for this subscriber would be a guess (looked up first). */
function fallbackIsGuess(m: Member): boolean {
  const p = m.sub.recurrence ? listPrice(m.product, m.sub.recurrence, null) : null;
  return p === null || p.source !== 'list';
}

interface ResolveStats {
  productPages: number;
  saleLookups: number;
  stoppedForBudget: boolean;
}

/** Newest sales of each product's subscriptions from the last RECENT_CHARGES_MS (10 per request). */
async function resolveRecentCharges(
  ctx: ProviderContext,
  token: string,
  members: Member[],
  now: number,
  stats: ResolveStats,
): Promise<void> {
  const byProduct = new Map<string, Map<string, Member>>();
  for (const m of members) {
    const open = byProduct.get(m.product.id) ?? new Map<string, Member>();
    open.set(m.sub.id, m);
    byProduct.set(m.product.id, open);
  }
  const after = dayKey(now - RECENT_CHARGES_MS);
  for (const [productId, open] of byProduct) {
    let key: string | null = null;
    while (open.size > 0) {
      if (!hasBudget(ctx)) {
        stats.stoppedForBudget = true;
        return;
      }
      const body = await gumroadGet(ctx, token, '/sales', { product_id: productId, after, page_key: key }, { permission: PERM_SALES });
      const page = parsePage(ctx, '/sales', body, 'sales', key);
      stats.productPages += 1;
      for (const raw of page.items) {
        const sale = toSale(raw);
        const m = sale?.subscriptionId ? open.get(sale.subscriptionId) : undefined;
        if (!sale || !m) continue;
        m.latest = sale; // newest first: the first one seen is the newest
        m.looked = true;
        open.delete(m.sub.id);
      }
      if (!page.next) break;
      key = page.next;
    }
  }
}

/** GET /sales/{newest purchase id} for each subscriber not found yet, ambiguous list prices first. */
async function resolveByPurchase(ctx: ProviderContext, token: string, members: Member[], stats: ResolveStats): Promise<void> {
  const todo = members.filter((m) => !m.looked);
  todo.sort((a, b) => Number(fallbackIsGuess(b)) - Number(fallbackIsGuess(a))); // stable: keeps API order within a group
  for (const m of todo) {
    const id = m.sub.lastPurchaseId;
    if (!id) {
      m.looked = true;
      continue;
    }
    if (!hasBudget(ctx)) {
      stats.stoppedForBudget = true;
      return;
    }
    let body: unknown = null;
    try {
      body = await gumroadGet(ctx, token, `/sales/${encodeURIComponent(id)}`, {}, { permission: PERM_SALES });
    } catch (err) {
      if (!(err instanceof ProviderError && err.kind === 'not_found')) throw err;
    }
    stats.saleLookups += 1;
    const sale = isObject(body) && !isFailure(body) ? toSale(body['sale']) : null;
    m.latest = sale && sale.subscriptionId === m.sub.id ? sale : null;
    m.looked = true;
  }
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  const token = requireToken(input);
  const now = ctx.now();

  // Required reads: without every product and subscriber the counts would be wrong (BudgetExhaustedError).
  const products = (await listProducts(ctx, token)).map(toMembership).filter((p): p is MembershipProduct => p !== null);
  const members: Member[] = [];
  const seen = new Set<string>();
  let trials = 0;
  let unknownStatus = 0;
  let vanished = 0;
  for (const product of products) {
    const subs = await listSubscribers(ctx, token, product.id);
    if (subs === null) {
      vanished += 1;
      continue;
    }
    for (const sub of subs) {
      if (seen.has(sub.id)) continue;
      seen.add(sub.id);
      const kind = classifySubscriber(sub, now);
      if (kind === 'trial') trials += 1;
      else if (kind === 'unknown') unknownStatus += 1;
      else if (kind === 'paying') members.push({ sub, product, latest: null, looked: false });
    }
  }

  // Optional reads: each one makes a price exact; whatever doesn't fit falls back to list prices.
  const stats: ResolveStats = { productPages: 0, saleLookups: 0, stoppedForBudget: false };
  try {
    await resolveRecentCharges(ctx, token, members, now, stats);
    if (!stats.stoppedForBudget) await resolveByPurchase(ctx, token, members, stats);
  } catch (err) {
    if (!(err instanceof BudgetExhaustedError)) throw err; // the deadline can empty the budget mid-call
    stats.stoppedForBudget = true;
  }

  const mrr: MoneyMap = {};
  let active = 0;
  const priced = { charge: 0, list: 0, list_estimated: 0, unpriced: 0, zero: 0 };
  let listForBudget = 0; // list-priced (exactly) only because the budget ran out before their lookup
  for (const m of members) {
    const p = priceMember(m);
    const rec = recurrenceOf(m.sub.recurrence);
    if (!p || !rec) {
      priced.unpriced += 1;
      continue;
    }
    if (p.amount <= 0) {
      priced.zero += 1; // free tier or 100%-off: not a paying subscription (SPEC §6)
      continue;
    }
    priced[p.source] += 1;
    if (p.source === 'list' && !m.looked) listForBudget += 1;
    active += 1;
    addToMoney(mrr, p.currency, normalizeToMonthly(p.amount, rec.interval, rec.count));
  }

  if (unknownStatus > 0) ctx.log('gumroad_unknown_status', { subscribers: unknownStatus });
  if (priced.unpriced > 0) ctx.log('gumroad_subscribers_unpriced', { subscribers: priced.unpriced });
  if (priced.list_estimated > 0 || stats.stoppedForBudget) {
    ctx.log('gumroad_mrr_estimated', { estimated: priced.list_estimated, budget: stats.stoppedForBudget });
  }
  const warnings: string[] = [];
  if (priced.unpriced > 0) warnings.push(gumroadUnpricedWarning(priced.unpriced));
  if (priced.list_estimated > 0) warnings.push(gumroadGuessedPriceWarning(priced.list_estimated));
  if (listForBudget > 0) warnings.push(gumroadListPriceWarning(listForBudget));
  if (unknownStatus > 0) warnings.push(gumroadUnknownStatusWarning(unknownStatus));
  ctx.log('gumroad_snapshot', {
    memberships: products.length,
    vanished,
    paying: members.length,
    active,
    trials,
    priced,
    productPages: stats.productPages,
    saleLookups: stats.saleLookups,
    currencies: Object.keys(mrr),
  });
  return {
    mrr,
    activeSubscriptions: active,
    activeTrials: trials,
    revenuePeriod: null, // derived from daily_revenue by the sync engine
    revenuePeriodDays: null,
    newCustomers: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ---------- fetchRevenue ----------

/**
 * Resumable traversal of GET /sales (newest first). `since` / `floor` are frozen when a traversal starts:
 * sales created ≥ since give charges, sales created ≥ floor give refunds. `pageKey` is the next page to read
 * (null = the first). Keyset paging means sales made mid-traversal don't shift pages; the next sync's
 * overlap reads them.
 */
interface RevenueCursor {
  v: 1;
  since: number;
  floor: number;
  pageKey: string | null;
}

export function encodeCursor(c: RevenueCursor): string {
  return JSON.stringify(c);
}

export function decodeCursor(raw: string | null): RevenueCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as unknown;
    if (!isObject(c) || c['v'] !== 1) return null;
    const { since, floor, pageKey } = c;
    if (typeof since !== 'number' || !Number.isFinite(since) || typeof floor !== 'number' || !Number.isFinite(floor)) return null;
    if (floor > since) return null;
    if (pageKey !== null && (typeof pageKey !== 'string' || !PAGE_KEY_RE.test(pageKey))) return null;
    return { v: 1, since, floor, pageKey: pageKey as string | null };
  } catch {
    return null;
  }
}

/** Refunds are re-checked this far back; not on a first backfill, where nothing older is stored. */
export function refundFloor(since: number, now: number): number {
  return now - since > FIRST_BACKFILL_MIN_MS ? since : since - REFUND_LOOKBACK_MS;
}

interface RevenueStats {
  pages: number;
  charges: number;
  refunds: number;
  lateRefunds: number;
  partialUnpriced: number;
  skipped: number;
  rateLimited: boolean;
}

function addSale(events: Map<string, RevenueEvent>, s: Sale, since: number, floor: number, stats: RevenueStats): void {
  const at = s.createdAt;
  if (at === null || at < floor) return;
  if (s.noMoney || s.price <= 0 || s.net <= 0) {
    stats.skipped += 1; // free products, $0 trial sign-ups, bundle items, gift copies
    return;
  }
  if (at >= since) {
    events.set(s.id, {
      externalId: s.id,
      occurredAt: at,
      type: 'charge',
      amount: s.net,
      currency: CURRENCY_USD,
      fee: s.fee,
      description: s.productName,
    });
    stats.charges += 1;
  }
  const reversed = reversedNet(s);
  if (reversed === null) {
    stats.partialUnpriced += 1;
    return;
  }
  if (reversed > 0) {
    // No refund date in the API: dated at the sale, under a stable id so a later full refund replaces it.
    events.set(`${s.id}:refund`, {
      externalId: `${s.id}:refund`,
      occurredAt: at,
      type: 'refund',
      amount: -reversed,
      currency: CURRENCY_USD,
      fee: null,
      description: s.productName,
    });
    stats.refunds += 1;
    if (at < since) stats.lateRefunds += 1;
  }
}

async function fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage> {
  const token = requireToken(input);
  let state = decodeCursor(req.cursor);
  if (req.cursor && !state) ctx.log('gumroad_cursor_invalid', { action: 'restart' }); // idempotent upserts make a restart safe
  if (!state) {
    if (!Number.isFinite(req.since)) throw new ProviderError('invalid_input', 'Invalid revenue start time.');
    state = { v: 1, since: req.since, floor: refundFloor(req.since, ctx.now()), pageKey: null };
  }

  const events = new Map<string, RevenueEvent>();
  const stats: RevenueStats = { pages: 0, charges: 0, refunds: 0, lateRefunds: 0, partialUnpriced: 0, skipped: 0, rateLimited: false };
  const finish = (next: RevenueCursor | null): RevenuePage => {
    ctx.log('gumroad_revenue', { ...stats, events: events.size, done: next === null });
    return { events: [...events.values()], daily: [], nextCursor: next ? encodeCursor(next) : null, done: next === null };
  };

  try {
    for (;;) {
      if (!hasBudget(ctx)) return finish(state);
      const body = await gumroadGet(
        ctx,
        token,
        '/sales',
        { after: dayKey(state.floor), page_key: state.pageKey },
        { permission: PERM_SALES, rateLimit: 'yield' },
      );
      const page = parsePage(ctx, '/sales', body, 'sales', state.pageKey);
      stats.pages += 1;
      let reachedFloor = false;
      for (const raw of page.items) {
        const sale = toSale(raw);
        if (!sale) continue;
        if (sale.createdAt !== null && sale.createdAt < state.floor) reachedFloor = true; // newest first: the rest is older
        addSale(events, sale, state.since, state.floor, stats);
      }
      if (reachedFloor || !page.next) return finish(null);
      state = { ...state, pageKey: page.next };
    }
  } catch (err) {
    if (!(err instanceof RateLimitedError)) throw err;
    // Undocumented limits: keep what was read and continue from the unread page next sync.
    stats.rateLimited = true;
    return finish(state);
  }
}

export const gumroadAdapter: ProviderAdapter = {
  id: 'gumroad',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
