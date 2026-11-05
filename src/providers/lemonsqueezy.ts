/**
 * Lemon Squeezy adapter (SPEC.md §6.2). Owner: Data Plane.
 *
 * JSON:API v1, https://docs.lemonsqueezy.com/api. Facts this file relies on (checked against the docs):
 *
 *  - Every list endpoint (subscriptions, orders, subscription-invoices, stores, discounts, discount-redemptions)
 *    is "ordered by created_at in descending order", pages with `page[number]` / `page[size]` (max 100) and
 *    reports `meta.page` {currentPage, lastPage, perPage, total}. There is NO created_at / updated_at filter,
 *    so revenue is read newest → oldest and paging stops once records are older than the window.
 *  - Filters used: subscriptions `filter[store_id]`, `filter[status]`; orders `filter[store_id]`;
 *    subscription-invoices `filter[store_id]`; discounts `filter[store_id]`; discount-redemptions
 *    `filter[discount_id]` (redemptions only filter by discount_id / order_id, not by store). Invoices accept
 *    `include=subscription` (JSON:API compound document; same relationship set as the official SDK), which
 *    gives product names and the checkout `order_id` without extra requests.
 *  - `GET /v1/users/me` returns `meta.test_mode`. Keys "only work in their respective sides of your store"
 *    (test vs live), and every order / invoice / subscription / discount carries `test_mode`.
 *  - Rate limit: 300 calls per minute, 429 when exceeded, no Retry-After (only X-Ratelimit-* headers on
 *    successful responses). A quick retry lands in the same minute, so every request uses
 *    `rateLimit: 'yield'`: revenue returns its cursor, a snapshot fails (a partial one would be wrong).
 *  - Prices (`GET /v1/prices/{id}`): `scheme` standard|package|graduated|volume, `unit_price` (int cents; "not
 *    used for volume and graduated pricing (tier data is used instead)", null for usage-based),
 *    `unit_price_decimal`, `package_size`, `tiers[{last_unit|"inf", unit_price, unit_price_decimal, fixed_fee}]`,
 *    `usage_aggregation` (non-null ⇒ usage-based), `renewal_interval_unit` day|week|month|year,
 *    `renewal_interval_quantity`, `trial_interval_unit` / `trial_interval_quantity` (null without a trial).
 *  - Subscriptions: status on_trial, active, paused, past_due, unpaid, cancelled, expired. `trial_ends_at` is
 *    set only while `status` is on_trial ("For all other status values, this will be null"), and
 *    `first_subscription_item` is null "if the subscription is currently in a free trial". So a trial that was
 *    cancelled (status cancelled) loses its trial_ends_at; see `classifySubscription`. `ends_at` is set for
 *    cancelled / expired. `order_id` is the subscription's checkout order.
 *  - Subscription invoices: `billing_reason` initial ("generated when the subscription is created") |
 *    renewal | updated. That the checkout order and the `initial` invoice are the same money is INFERRED from
 *    the webhook sequence of a checkout (order_created + subscription_created + subscription_payment_success),
 *    not documented. So the decision is made by money, not by timing: an `initial` invoice is skipped only when
 *    its subscription's checkout order had a total > 0; a $0 checkout (free trial) means the invoice is the
 *    first real charge.
 *  - Discounts: `amount` + `amount_type` percent|fixed (cents), `duration` once (initial payment only) |
 *    repeating (`duration_in_months`) | forever. A discount redemption is "a record of a discount being applied
 *    to an order" and carries `discount_amount` / `discount_amount_type` as redeemed.
 *  - Money: Lemon Squeezy "processes all transactions in US dollars"; orders and invoices report amounts in
 *    their own `currency` (the store currency, which sets what checkout and the dashboard show) with `*_usd`
 *    twins. We report that currency, as the merchant prices and sees it; the USD actually settled differs by
 *    the conversion at payment time.
 *  - Units: money (`unit_price`, `total`, `tax`, `refunded_amount`, …) is "a positive integer in cents" of that
 *    currency. Neither the API reference nor the currencies page says what "cents" means for a currency without
 *    two decimals, so amounts are read as ISO 4217 minor units (`currencyExponent`): JPY and KRW whole, HUF and
 *    IDR in hundredths. Unverified for ISK, UGX and MGA, where Stripe's units differ from ISO.
 *  - Refunds: orders and invoices carry `refunded_amount` (cumulative) and `refunded_at`, which the docs set only
 *    for a FULL refund (the partial-refund example keeps `refunded_at: null` and even `status: "paid"`).
 *
 * Decisions (SPEC §6.2 refines these):
 *  - MRR counts active, past_due and cancelled-with-ends_at-in-the-future (grace period). paused (no collection),
 *    unpaid (dunning failed) and expired are not paying. A cancelled subscription that never left its trial
 *    counts as a trial, never as MRR.
 *  - MRR applies recurring discounts: `forever`, and `repeating` until `duration_in_months` after the
 *    redemption; `once` doesn't change MRR. If the discount lookups don't fit in the page budget, MRR is
 *    reported before discounts (logged) rather than failing or applying only some.
 *  - Revenue is net of tax: Lemon Squeezy is the merchant of record, so VAT / sales tax isn't the seller's
 *    money (MRR is pre-tax too). Charge = `total − tax`; a refund is scaled by `(total − tax) / total`.
 *  - Test mode: a record is kept only when `record.test_mode === key's test mode`. A live key ignores test
 *    records; a test key sees its test data (and nothing else).
 *  - Revenue window: records created ≥ `since` produce charges + refunds; records created in the
 *    REFUND_LOOKBACK before `since` are scanned only for refunds that happened ≥ `since` (LS has no
 *    "refunds since" query, and refunds land on the original order/invoice).
 *  - Refunds: ONE refund event per order / invoice, stable id, amount = the cumulative refund, dated
 *    `refunded_at` (full refunds) or else `updated_at` (the only trace of a partial refund). Limitation: the
 *    API has no per-refund records, so several partial refunds on one record show as a single refund on the
 *    date of the latest change, and each new partial refund (or any later update of that record while it is
 *    still re-scanned) moves the whole cumulative refund to the new date. Totals stay right: the event is
 *    upserted by id and the engine rebuilds both the old and the new day.
 */

import { addToMoney, normalizeToMonthly, type BillingInterval, type MoneyMap } from '../lib/money';
import { BudgetExhaustedError, RateLimitedError, buildUrl, fetchJson, hasBudget, type QueryValue, type RequestSpec } from './http';
import {
  ProviderError,
  type ConnectionConfig,
  type ConnectionInput,
  type MetricsSnapshot,
  type ProviderAdapter,
  type ProviderContext,
  type RevenueEvent,
  type RevenuePage,
  type RevenueRequest,
  type VerifyResult,
} from './types';

const PROVIDER = 'Lemon Squeezy';
export const LS_API_BASE = 'https://api.lemonsqueezy.com/v1';
/** JSON:API maximum. */
const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;
/**
 * How far before `since` orders / invoices are re-scanned for late refunds (LS has no
 * "updated since" filter). 30 days + the engine's 2-day overlap covers the common 30-day
 * money-back window; refunds issued later than that are missed (documented limitation).
 */
export const REFUND_LOOKBACK_MS = 30 * DAY_MS;
/**
 * A checkout order is created moments before its subscription. A subscription created at least this long
 * after the order scan's floor therefore has its checkout order inside the scanned range.
 */
export const CHECKOUT_ORDER_MARGIN_MS = 60 * 60_000;
/**
 * Most order totals a revenue cursor carries between calls (≈ 13 bytes each; the cursor is one D1 value).
 * Past this the cursor stops vouching for unseen orders and they are looked up one by one instead.
 */
export const MAX_CARRIED_ORDERS = 3000;
/** Subscription statuses listed for the snapshot (each is a separate filtered listing). */
const SNAPSHOT_STATUSES = ['active', 'past_due', 'cancelled', 'on_trial'] as const;
const CHARGEABLE_STATUSES = new Set(['paid', 'refunded', 'partial_refund']);
const INTERVALS = new Set<BillingInterval>(['day', 'week', 'month', 'year']);
/** `orders` value for a checkout order Lemon Squeezy no longer returns (treated as paid at checkout). */
const ORDER_NOT_FOUND = -1;

/** Config keys this adapter writes (all values are strings; shown on the connection page). */
export const CONFIG_STORE_CURRENCIES = 'storeCurrencies';
export const CONFIG_TEST_MODE = 'testMode';
export const CONFIG_STORE_ID = 'storeId';

// ---------------------------------------------------------------------------------------------
// JSON:API plumbing
// ---------------------------------------------------------------------------------------------

type Attrs = Record<string, unknown>;

interface Resource {
  type: string;
  id: string;
  attributes: Attrs;
}

interface ListPage {
  data: Resource[];
  included: Resource[];
  lastPage: number | null;
  perPage: number | null;
  total: number | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function badPayload(ctx: ProviderContext, path: string): ProviderError {
  ctx.log('ls_bad_payload', { path });
  return new ProviderError('upstream', `${PROVIDER} returned a response hoomuch couldn’t read.`);
}

function toResource(v: unknown): Resource | null {
  if (!isObject(v)) return null;
  const id = v['id'];
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof v['type'] !== 'string') return null;
  return { type: v['type'], id: String(id), attributes: isObject(v['attributes']) ? v['attributes'] : {} };
}

function parseList(ctx: ProviderContext, path: string, body: unknown): ListPage {
  if (!isObject(body) || !Array.isArray(body['data'])) throw badPayload(ctx, path);
  const data = body['data'].map(toResource).filter((r): r is Resource => r !== null);
  const included = Array.isArray(body['included'])
    ? body['included'].map(toResource).filter((r): r is Resource => r !== null)
    : [];
  const meta = isObject(body['meta']) && isObject(body['meta']['page']) ? body['meta']['page'] : {};
  return {
    data,
    included,
    lastPage: posInt(meta['lastPage']),
    perPage: posInt(meta['perPage']),
    total: nonNegInt(meta['total']),
  };
}

function parseSingle(ctx: ProviderContext, path: string, body: unknown): Resource {
  const r = isObject(body) ? toResource(body['data']) : null;
  if (!r) throw badPayload(ctx, path);
  return r;
}

/** Last page of a listing (falls back to "a short page is the last one" without meta). */
function lastPageOf(list: ListPage, page: number, perPage: number): number {
  return list.lastPage ?? (list.data.length < perPage ? page : page + 1);
}

// ---------- attribute readers (the API is untyped JSON; never trust shapes) ----------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function posInt(v: unknown): number | null {
  const n = int(v);
  return n !== null && n > 0 ? n : null;
}

function nonNegInt(v: unknown): number | null {
  const n = int(v);
  return n !== null && n >= 0 ? n : null;
}

function idOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return str(v);
}

/** ISO 8601 (LS uses microseconds, e.g. "2026-11-01T09:00:00.000000Z") → epoch ms. */
function time(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function currencyOf(v: unknown): string | null {
  const c = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

function intervalOf(v: unknown): BillingInterval | null {
  const u = str(v);
  return u && INTERVALS.has(u as BillingInterval) ? (u as BillingInterval) : null;
}

/** `t` plus `count` calendar `unit`s, in UTC. */
function addInterval(t: number, unit: BillingInterval, count: number): number {
  if (unit === 'day') return t + count * DAY_MS;
  if (unit === 'week') return t + count * 7 * DAY_MS;
  const d = new Date(t);
  if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + count);
  else d.setUTCFullYear(d.getUTCFullYear() + count);
  return d.getTime();
}

/** "Pro · Yearly"; LS names single-variant products "Default", which adds nothing. Never customer data. */
function describe(product: unknown, variant: unknown): string | null {
  const p = str(product)?.trim() ?? '';
  const v = str(variant)?.trim() ?? '';
  const parts = [p, v && v.toLowerCase() !== 'default' ? v : ''].filter(Boolean);
  if (parts.length === 0) return null;
  const s = parts.join(' · ');
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}

// ---------- requests ----------

function apiKeyOf(input: ConnectionInput): string {
  const key = (input.credentials['apiKey'] ?? '').trim();
  if (!key) throw new ProviderError('invalid_input', 'The Lemon Squeezy API key is missing.', { field: 'apiKey' });
  return key;
}

function lsGet(
  ctx: ProviderContext,
  apiKey: string,
  path: string,
  query: Record<string, QueryValue> = {},
  extra: Partial<RequestSpec> = {},
): Promise<unknown> {
  return fetchJson<unknown>(ctx, {
    provider: PROVIDER,
    url: buildUrl(LS_API_BASE, path, query),
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey}`,
    },
    // 300 calls per minute and no Retry-After: a retry would land in the same minute (see header).
    rateLimit: 'yield',
    ...extra,
  });
}

/** Store ID as typed by the user ("12345" or "#12345") → digits, or null when empty. Throws on garbage. */
function storeScope(config: ConnectionConfig): string | null {
  const raw = (config[CONFIG_STORE_ID] ?? '').trim();
  if (!raw) return null;
  const m = /^#?(\d{1,12})$/.exec(raw);
  if (!m) {
    throw new ProviderError('invalid_input', 'Store ID should be a number, like 12345 (Settings → Stores).', {
      field: CONFIG_STORE_ID,
    });
  }
  return m[1]!;
}

function storeNotFoundMessage(storeId: string): string {
  return `This API key can’t see a store with ID ${storeId}. Check the Store ID, or leave it empty to include every store.`;
}

/** `meta.test_mode` of /users/me; null if Lemon Squeezy ever stops sending it. */
function readTestMode(body: unknown): boolean | null {
  if (!isObject(body) || !isObject(body['meta'])) return null;
  const t = body['meta']['test_mode'];
  return typeof t === 'boolean' ? t : null;
}

async function fetchKeyTestMode(ctx: ProviderContext, apiKey: string): Promise<boolean> {
  const t = readTestMode(await lsGet(ctx, apiKey, '/users/me'));
  if (t === null) ctx.log('ls_test_mode_unknown', {});
  return t ?? false;
}

/** Key mode from config (written by verify); one /users/me call for connections created before it existed. */
async function resolveKeyTestMode(input: ConnectionInput, apiKey: string, ctx: ProviderContext): Promise<boolean> {
  const v = input.config[CONFIG_TEST_MODE];
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fetchKeyTestMode(ctx, apiKey);
}

interface StoreInfo {
  id: string;
  name: string | null;
  currency: string | null;
}

function toStore(r: Resource): StoreInfo {
  return { id: r.id, name: str(r.attributes['name']), currency: currencyOf(r.attributes['currency']) };
}

function parseStoreCurrencies(json: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!json) return out;
  try {
    const v = JSON.parse(json) as unknown;
    if (isObject(v)) {
      for (const [id, c] of Object.entries(v)) {
        const cur = currencyOf(c);
        if (cur) out.set(id, cur);
      }
    }
  } catch {
    // fall through: unknown stores are looked up lazily
  }
  return out;
}

/** store_id → ISO currency, from config first, else one GET /stores/{id} per unknown store (cached). */
class StoreCurrencies {
  private readonly known: Map<string, string>;
  private readonly looked = new Set<string>();

  constructor(
    config: ConnectionConfig,
    private readonly ctx: ProviderContext,
    private readonly apiKey: string,
  ) {
    this.known = parseStoreCurrencies(config[CONFIG_STORE_CURRENCIES]);
  }

  async get(storeId: string): Promise<string | null> {
    const hit = this.known.get(storeId);
    if (hit) return hit;
    if (this.looked.has(storeId)) return null;
    this.looked.add(storeId);
    try {
      const path = `/stores/${encodeURIComponent(storeId)}`;
      const store = toStore(parseSingle(this.ctx, path, await lsGet(this.ctx, this.apiKey, path)));
      if (store.currency) this.known.set(storeId, store.currency);
      return store.currency;
    } catch (err) {
      if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'permission')) {
        this.ctx.log('ls_store_unavailable', { storeId });
        return null;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------

export interface LsPriceTier {
  /** Infinity for the "inf" tier. */
  lastUnit: number;
  unitPrice: number | null;
  fixedFee: number;
}

export interface LsPrice {
  id: string;
  scheme: string;
  usageBased: boolean;
  unitPrice: number | null;
  packageSize: number;
  tiers: LsPriceTier[] | null;
  interval: BillingInterval | null;
  intervalCount: number;
  /** Free trial of this price, null without one. */
  trial: { interval: BillingInterval; count: number } | null;
}

/** `unit_price` (int cents) or, failing that, `unit_price_decimal` (decimal cents as a string). */
function unitPriceOf(a: Attrs): number | null {
  const u = num(a['unit_price']);
  if (u !== null) return u;
  return num(a['unit_price_decimal']);
}

export function parsePrice(r: Resource): LsPrice {
  const a = r.attributes;
  const tiers = Array.isArray(a['tiers'])
    ? a['tiers'].filter(isObject).map(
        (t): LsPriceTier => ({
          lastUnit: t['last_unit'] === 'inf' ? Infinity : (num(t['last_unit']) ?? Infinity),
          unitPrice: unitPriceOf(t),
          fixedFee: num(t['fixed_fee']) ?? 0,
        }),
      )
    : null;
  const trialUnit = intervalOf(a['trial_interval_unit']);
  const trialCount = posInt(a['trial_interval_quantity']);
  return {
    id: r.id,
    scheme: str(a['scheme']) ?? 'standard',
    usageBased: a['usage_aggregation'] !== null && a['usage_aggregation'] !== undefined,
    unitPrice: unitPriceOf(a),
    packageSize: posInt(a['package_size']) ?? 1,
    tiers: tiers && tiers.length > 0 ? tiers : null,
    interval: intervalOf(a['renewal_interval_unit']),
    intervalCount: posInt(a['renewal_interval_quantity']) ?? 1,
    trial: trialUnit && trialCount ? { interval: trialUnit, count: trialCount } : null,
  };
}

function tieredAmount(tiers: LsPriceTier[], quantity: number, mode: 'volume' | 'graduated'): number | null {
  if (mode === 'volume') {
    // Every unit is priced at the tier the total quantity falls into.
    const tier = tiers.find((t) => quantity <= t.lastUnit);
    if (!tier || tier.unitPrice === null) return null;
    return quantity * tier.unitPrice + tier.fixedFee;
  }
  // Graduated: each tier prices only the units that fall inside it (+ its flat fee if any unit does).
  let total = 0;
  let prev = 0;
  for (const t of tiers) {
    const units = Math.min(quantity, t.lastUnit) - prev;
    if (units > 0) {
      if (t.unitPrice === null) return null;
      total += units * t.unitPrice + t.fixedFee;
    }
    if (quantity <= t.lastUnit) return total;
    prev = t.lastUnit;
  }
  return null; // quantity beyond the last (non-"inf") tier: not priceable
}

/**
 * Recurring amount (cents, possibly fractional for decimal prices) for one billing period of `quantity`
 * units, or null when it can't be priced (usage-based, missing unit price, missing or broken tiers).
 */
export function priceAmountMinor(price: LsPrice, quantity: number): number | null {
  if (price.usageBased) return null;
  const q = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  if (price.scheme === 'volume' || price.scheme === 'graduated') {
    // unit_price is "not used for volume and graduated pricing (tier data is used instead)": no tiers, no price.
    return price.tiers ? tieredAmount(price.tiers, q, price.scheme) : null;
  }
  if (price.unitPrice === null) return null;
  if (price.scheme === 'package') return Math.ceil(q / price.packageSize) * price.unitPrice;
  return price.unitPrice * q;
}

/** One GET /prices/{id} per distinct price per adapter call. */
class PriceCache {
  private readonly cache = new Map<string, LsPrice | null>();

  constructor(
    private readonly ctx: ProviderContext,
    private readonly apiKey: string,
  ) {}

  get size(): number {
    return this.cache.size;
  }

  async get(priceId: string): Promise<LsPrice | null> {
    if (this.cache.has(priceId)) return this.cache.get(priceId) ?? null;
    let price: LsPrice | null = null;
    try {
      const path = `/prices/${encodeURIComponent(priceId)}`;
      price = parsePrice(parseSingle(this.ctx, path, await lsGet(this.ctx, this.apiKey, path)));
    } catch (err) {
      if (!(err instanceof ProviderError && err.kind === 'not_found')) throw err;
      this.ctx.log('ls_price_missing', { priceId });
    }
    this.cache.set(priceId, price);
    return price;
  }
}

// ---------------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------------

async function listStores(ctx: ProviderContext, apiKey: string, maxPages: number): Promise<StoreInfo[]> {
  const stores: StoreInfo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const list = parseList(ctx, '/stores', await lsGet(ctx, apiKey, '/stores', { 'page[number]': page, 'page[size]': PAGE_SIZE }));
    stores.push(...list.data.map(toStore));
    const last = list.lastPage ?? page;
    if (list.data.length === 0 || page >= last) break;
    if (page === maxPages) ctx.log('ls_store_list_truncated', { read: stores.length, total: list.total });
  }
  return stores;
}

async function verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult> {
  try {
    const apiKey = apiKeyOf(input);
    const storeId = storeScope(input.config);

    const testMode = await fetchKeyTestMode(ctx, apiKey);

    let stores: StoreInfo[];
    if (storeId) {
      const path = `/stores/${storeId}`;
      const body = await lsGet(ctx, apiKey, path, {}, { notFoundMessage: storeNotFoundMessage(storeId), field: CONFIG_STORE_ID });
      stores = [toStore(parseSingle(ctx, path, body))];
    } else {
      stores = await listStores(ctx, apiKey, 2); // ≤ 3 requests in total with /users/me
    }

    const currencies: Record<string, string> = {};
    for (const s of stores) if (s.currency) currencies[s.id] = s.currency;

    const warnings: string[] = [];
    if (stores.length === 0) {
      warnings.push(
        testMode
          ? 'This test-mode key can’t see any stores yet. Create a store in Lemon Squeezy; the next sync picks it up.'
          : 'This API key can’t see any stores yet. Create a store in Lemon Squeezy; the next sync picks it up.',
      );
    }
    const noCurrency = stores.filter((s) => !s.currency).length;
    if (noCurrency > 0) {
      warnings.push(
        noCurrency === 1
          ? '1 store has no currency set; its MRR can’t be counted.'
          : `${noCurrency} stores have no currency set; their MRR can’t be counted.`,
      );
    }

    const only = stores.length === 1 ? stores[0]! : null;
    const accountLabel = only
      ? `Store: ${only.name ?? `#${only.id}`}${only.currency ? ` (${only.currency})` : ''}`
      : stores.length === 0
        ? 'Lemon Squeezy (no stores)'
        : `${stores.length} stores`;

    const config: ConnectionConfig = {
      [CONFIG_STORE_CURRENCIES]: JSON.stringify(currencies),
      [CONFIG_TEST_MODE]: String(testMode),
    };
    if (storeId) config[CONFIG_STORE_ID] = storeId;

    ctx.log('ls_verified', { stores: stores.length, testMode, scoped: storeId !== null });
    return { ok: true, accountLabel, config, testMode, warnings };
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.field === CONFIG_STORE_ID && (err.kind === 'not_found' || err.kind === 'permission')) {
      const id = (input.config[CONFIG_STORE_ID] ?? '').replace(/^#/, '').trim();
      return { ok: false, error: storeNotFoundMessage(id), field: CONFIG_STORE_ID };
    }
    if (err.kind === 'auth') {
      return {
        ok: false,
        error:
          'Lemon Squeezy rejected the API key. Check that you copied all of it and that it hasn’t been deleted or expired (keys are valid for a year).',
        field: 'apiKey',
      };
    }
    if (err.kind === 'invalid_input' || err.kind === 'not_found' || err.kind === 'permission') {
      return { ok: false, error: err.message, ...(err.field ? { field: err.field } : {}) };
    }
    throw err; // upstream / rate_limit: the caller shows a generic "try again" message
  }
}

// ---------------------------------------------------------------------------------------------
// fetchSnapshot
// ---------------------------------------------------------------------------------------------

type SubscriptionKind = 'paying' | 'trial' | 'none';

/**
 * True when a cancelled subscription ends where its free trial would have ended, i.e. it was cancelled
 * before the first payment. A converted subscription ends at least one billing period after the trial.
 */
function endsWithTrial(a: Attrs, price: LsPrice, ends: number): boolean {
  if (!price.trial) return false;
  const created = time(a['created_at']);
  if (created === null) return false;
  const trialEnd = addInterval(created, price.trial.interval, price.trial.count);
  const period = price.interval ? addInterval(trialEnd, price.interval, price.intervalCount) - trialEnd : 2 * DAY_MS;
  return ends <= trialEnd + Math.min(DAY_MS, period / 2);
}

/**
 * SPEC §6 + §6.2: who counts towards MRR / active subscriptions / trials. `price` (the subscription's
 * first item's price) is only consulted for cancelled subscriptions: Lemon Squeezy clears `trial_ends_at`
 * once the status leaves on_trial, so a cancelled trial is recognised by a null `first_subscription_item`
 * (documented for subscriptions in a free trial) or by ending exactly when its price's trial ends.
 */
export function classifySubscription(a: Attrs, now: number, price: LsPrice | null = null): SubscriptionKind {
  switch (str(a['status'])) {
    case 'active':
    case 'past_due':
      return 'paying';
    case 'on_trial':
      return 'trial';
    case 'cancelled': {
      const ends = time(a['ends_at']);
      if (ends === null || ends <= now) return 'none';
      const trialEnds = time(a['trial_ends_at']);
      if (trialEnds !== null && trialEnds > now) return 'trial'; // not documented for cancelled; harmless
      if (!isObject(a['first_subscription_item'])) return 'trial';
      if (price && endsWithTrial(a, price, ends)) return 'trial';
      return 'paying';
    }
    default:
      return 'none'; // paused, unpaid, expired, unknown
  }
}

export interface LsRedemption {
  type: 'percent' | 'fixed';
  /** Percent (0–100) or cents of the store currency. */
  amount: number;
}

/** One billing period's amount after a redeemed discount. Fixed discounts come off every payment. */
export function applyDiscount(amount: number, r: LsRedemption): number {
  if (r.type === 'percent') return amount * (1 - Math.min(100, Math.max(0, r.amount)) / 100);
  return Math.max(0, amount - r.amount);
}

interface RecurringDiscount {
  id: string;
  /** null = forever. */
  months: number | null;
  fallback: LsRedemption | null;
}

function redemptionOf(type: unknown, amount: unknown): LsRedemption | null {
  const t = str(type);
  const n = num(amount);
  return (t === 'percent' || t === 'fixed') && n !== null && n > 0 ? { type: t, amount: n } : null;
}

/**
 * Recurring discounts redeemed on the given checkout orders: order id → redemptions still in effect.
 * `forever` discounts always, `repeating` ones until `duration_in_months` after the redemption; `once`
 * discounts never touch MRR, so their redemptions aren't read at all. Returns null when the lookups
 * don't fit in the page budget (or the endpoints are unavailable): MRR is then reported before discounts.
 */
async function recurringDiscounts(
  ctx: ProviderContext,
  apiKey: string,
  scope: string | null,
  keyTestMode: boolean,
  orders: ReadonlySet<string>,
  now: number,
): Promise<Map<string, LsRedemption[]> | null> {
  const out = new Map<string, LsRedemption[]>();
  if (orders.size === 0) return out;
  let requests = 0;
  const skip = (reason: string): null => {
    ctx.log('ls_discounts_skipped', { reason, requests });
    return null;
  };
  try {
    const recurring: RecurringDiscount[] = [];
    for (let page = 1; ; page++) {
      if (!hasBudget(ctx)) return skip('budget');
      requests += 1;
      const list = parseList(
        ctx,
        '/discounts',
        await lsGet(ctx, apiKey, '/discounts', { 'filter[store_id]': scope, 'page[number]': page, 'page[size]': PAGE_SIZE }),
      );
      for (const d of list.data) {
        const a = d.attributes;
        if ((a['test_mode'] === true) !== keyTestMode) continue;
        if (scope && idOf(a['store_id']) !== scope) continue;
        const fallback = redemptionOf(a['amount_type'], a['amount']);
        const duration = str(a['duration']);
        if (duration === 'forever') recurring.push({ id: d.id, months: null, fallback });
        else if (duration === 'repeating') {
          const months = posInt(a['duration_in_months']);
          if (months) recurring.push({ id: d.id, months, fallback });
        }
      }
      if (list.data.length === 0 || page >= lastPageOf(list, page, list.perPage ?? PAGE_SIZE)) break;
    }

    for (const d of recurring) {
      for (let page = 1; ; page++) {
        if (!hasBudget(ctx)) return skip('budget');
        requests += 1;
        const list = parseList(
          ctx,
          '/discount-redemptions',
          await lsGet(ctx, apiKey, '/discount-redemptions', {
            'filter[discount_id]': d.id,
            'page[number]': page,
            'page[size]': PAGE_SIZE,
          }),
        );
        let elapsed = false;
        for (const r of list.data) {
          const a = r.attributes;
          if (d.months !== null) {
            const at = time(a['created_at']);
            // Newest first: once one redemption's months are over, every later one's are too.
            if (at === null || addInterval(at, 'month', d.months) <= now) {
              elapsed = true;
              continue;
            }
          }
          const orderId = idOf(a['order_id']);
          if (!orderId || !orders.has(orderId)) continue;
          // As redeemed (the discount itself may have been edited since); the discount's own terms otherwise.
          const terms = redemptionOf(a['discount_amount_type'], a['discount_amount']) ?? d.fallback;
          if (terms) out.set(orderId, [...(out.get(orderId) ?? []), terms]);
        }
        if (elapsed || list.data.length === 0 || page >= lastPageOf(list, page, list.perPage ?? PAGE_SIZE)) break;
      }
    }
  } catch (err) {
    // The deadline can empty the budget between hasBudget and the request.
    if (err instanceof BudgetExhaustedError) return skip('budget');
    if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'permission')) return skip(err.kind);
    throw err; // rate limit / upstream: the snapshot fails rather than being written wrong
  }
  return out;
}

interface PricedSubscription {
  orderId: string | null;
  currency: string;
  /** One billing period, before discounts. */
  amount: number;
  interval: BillingInterval;
  intervalCount: number;
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  const apiKey = apiKeyOf(input);
  const scope = storeScope(input.config);
  const keyTestMode = await resolveKeyTestMode(input, apiKey, ctx);
  const currencies = new StoreCurrencies(input.config, ctx, apiKey);
  const prices = new PriceCache(ctx, apiKey);
  const now = ctx.now();

  let active = 0;
  let trials = 0;
  const stats = { listed: 0, otherMode: 0, usageBased: 0, unpriced: 0, cancelledTrials: 0, discounted: 0, zeroMrr: 0 };
  const seen = new Set<string>();
  const priced: PricedSubscription[] = [];

  for (const status of SNAPSHOT_STATUSES) {
    for (let page = 1; ; page++) {
      const list = parseList(
        ctx,
        '/subscriptions',
        await lsGet(ctx, apiKey, '/subscriptions', {
          'filter[store_id]': scope,
          'filter[status]': status,
          'page[number]': page,
          'page[size]': PAGE_SIZE,
        }),
      );

      for (const sub of list.data) {
        if (seen.has(sub.id)) continue; // status changed between two listings
        seen.add(sub.id);
        stats.listed += 1;
        const a = sub.attributes;
        if ((a['test_mode'] === true) !== keyTestMode) {
          stats.otherMode += 1;
          continue;
        }
        const storeId = idOf(a['store_id']);
        if (scope && storeId !== scope) continue;

        let kind = classifySubscription(a, now);
        if (kind === 'none') continue;
        if (kind === 'trial') {
          trials += 1;
          if (str(a['status']) === 'cancelled') stats.cancelledTrials += 1;
          continue;
        }

        const item = isObject(a['first_subscription_item']) ? a['first_subscription_item'] : null;
        const priceId = item ? idOf(item['price_id']) : null;
        const usageItem = item?.['is_usage_based'] === true;
        const cancelled = str(a['status']) === 'cancelled';
        // A cancelled subscription's price also tells a cancelled trial from a paying one.
        const price = priceId && (!usageItem || cancelled) ? await prices.get(priceId) : null;
        if (cancelled) kind = classifySubscription(a, now, price);
        if (kind === 'trial') {
          trials += 1;
          stats.cancelledTrials += 1;
          continue;
        }
        // Active means MRR above 0 (SPEC §6, Stripe's definition). Usage-based and unpriceable
        // subscriptions count here, since their MRR is unknown rather than zero; priced ones are
        // counted below, once discounts are applied, so $0 plans and 100%-off codes don't.
        if (usageItem || price?.usageBased) {
          active += 1;
          stats.usageBased += 1;
          continue;
        }
        const amount = price ? priceAmountMinor(price, num(item?.['quantity']) ?? 1) : null;
        const currency = storeId ? await currencies.get(storeId) : null;
        if (!price || amount === null || !price.interval || !currency) {
          active += 1;
          stats.unpriced += 1;
          ctx.log('ls_subscription_unpriced', {
            subscriptionId: sub.id,
            priceId,
            reason: !price ? 'price' : amount === null ? 'amount' : !price.interval ? 'interval' : 'currency',
          });
          continue;
        }
        priced.push({ orderId: idOf(a['order_id']), currency, amount, interval: price.interval, intervalCount: price.intervalCount });
      }

      const last = lastPageOf(list, page, PAGE_SIZE);
      if (list.data.length === 0 || page >= last) break;
    }
  }

  const orderIds = new Set(priced.map((p) => p.orderId).filter((id): id is string => id !== null));
  const discounts = await recurringDiscounts(ctx, apiKey, scope, keyTestMode, orderIds, now);
  const mrr: MoneyMap = {};
  for (const p of priced) {
    let amount = p.amount;
    const redeemed = (p.orderId ? discounts?.get(p.orderId) : undefined) ?? [];
    for (const r of redeemed) amount = applyDiscount(amount, r);
    if (redeemed.length > 0) stats.discounted += 1;
    if (amount <= 0) {
      stats.zeroMrr += 1; // a $0 price, or discounted 100% for good: not a paying subscription
      continue;
    }
    active += 1;
    addToMoney(mrr, p.currency, normalizeToMonthly(amount, p.interval, p.intervalCount));
  }

  ctx.log('ls_snapshot', {
    ...stats,
    active,
    trials,
    prices: prices.size,
    currencies: Object.keys(mrr).length,
    discounts: discounts === null ? 'skipped' : 'applied',
  });
  return {
    mrr,
    activeSubscriptions: active,
    activeTrials: trials,
    // stores expose thirty_day_revenue, but in USD and with undocumented tax and refund handling;
    // period revenue comes from our own transactions instead.
    revenuePeriod: null,
    revenuePeriodDays: null,
    newCustomers: null,
  };
}

// ---------------------------------------------------------------------------------------------
// fetchRevenue
// ---------------------------------------------------------------------------------------------

type Phase = 'orders' | 'invoices';

interface RevenueCursor {
  v: 2;
  /** Window start of the run that created the cursor (resumed runs keep it). */
  since: number;
  phase: Phase;
  /** Next page to read in `phase`. */
  page: number;
  /**
   * meta.page.total when `page` was computed. Lists are newest-first, so new records push older ones to
   * later pages; comparing totals on resume re-anchors the page number instead of re-reading or skipping.
   */
  total: number | null;
  /** Checkout orders to look up before (re-)reading `page` (invoice phase). */
  pending: string[];
  /**
   * Order totals the invoice phase needs across calls: every $0 order the order scan saw (free-trial
   * checkouts), plus orders looked up one by one. −1 = not found. Paid orders from the scan aren't carried:
   * see `checkoutPaid`.
   */
  orders: Record<string, number>;
  /** False once `orders` was truncated: an order missing from it can no longer be assumed paid. */
  complete: boolean;
}

type CursorPosition = Pick<RevenueCursor, 'since' | 'phase' | 'page' | 'total' | 'pending'>;

export function encodeCursor(c: RevenueCursor): string {
  return JSON.stringify(c);
}

export function decodeCursor(s: string | null): RevenueCursor | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (
      isObject(v) &&
      v['v'] === 2 &&
      typeof v['since'] === 'number' &&
      Number.isFinite(v['since']) &&
      (v['phase'] === 'orders' || v['phase'] === 'invoices') &&
      typeof v['page'] === 'number' &&
      Number.isInteger(v['page']) &&
      v['page'] >= 1 &&
      (v['total'] === null || (typeof v['total'] === 'number' && Number.isInteger(v['total']) && v['total'] >= 0)) &&
      Array.isArray(v['pending']) &&
      v['pending'].length <= PAGE_SIZE &&
      v['pending'].every((id) => typeof id === 'string' && id.length > 0) &&
      isObject(v['orders']) &&
      Object.values(v['orders']).every((t) => typeof t === 'number' && Number.isInteger(t) && t >= ORDER_NOT_FOUND) &&
      typeof v['complete'] === 'boolean'
    ) {
      return {
        v: 2,
        since: v['since'],
        phase: v['phase'],
        page: v['page'],
        total: v['total'],
        pending: v['pending'] as string[],
        orders: v['orders'] as Record<string, number>,
        complete: v['complete'],
      };
    }
  } catch {
    // invalid → restart
  }
  return null;
}

/** Pages to move when the list grew (+) or shrank (−) by `delta` records since `page` was computed. */
export function pageShift(delta: number, pageSize: number): number {
  if (delta > 0) return Math.floor(delta / pageSize);
  if (delta < 0) return -Math.ceil(-delta / pageSize);
  return 0;
}

interface RevenueScan {
  since: number;
  floor: number;
  keyTestMode: boolean;
  scope: string | null;
  events: Map<string, RevenueEvent>;
  /** order id → total (minor units; −1 = not found): orders read by the scan, carried in, or looked up. */
  orders: Map<string, number>;
  /** Orders looked up one by one (always carried in the cursor). */
  fetched: Set<string>;
  /** Every $0 order created ≥ floor is in `orders` (nothing was dropped from a cursor). */
  complete: boolean;
  stats: {
    otherMode: number;
    initialAsOrder: number;
    initialCharged: number;
    lateRefunds: number;
    orderLookups: number;
    rateLimited: boolean;
  };
}

/** What the cursor carries of `scan.orders` (looked-up orders first, then the scan's $0 orders). */
function carriedOrders(scan: RevenueScan): Pick<RevenueCursor, 'orders' | 'complete'> {
  const orders: Record<string, number> = {};
  let n = 0;
  let complete = scan.complete;
  const put = (id: string, total: number): void => {
    if (n < MAX_CARRIED_ORDERS) {
      orders[id] = total;
      n += 1;
    } else {
      complete = false;
    }
  };
  for (const id of scan.fetched) put(id, scan.orders.get(id) ?? ORDER_NOT_FOUND);
  for (const [id, total] of scan.orders) if (total <= 0 && !scan.fetched.has(id)) put(id, total);
  return { orders, complete };
}

function addEvent(scan: RevenueScan, e: RevenueEvent): void {
  const prev = scan.events.get(e.externalId);
  // The same refund can be reported by an order and by its initial invoice: keep one, the larger.
  if (!prev || Math.abs(e.amount) > Math.abs(prev.amount)) scan.events.set(e.externalId, e);
}

/** Cumulative refund of an order / invoice (gross, ≤ total). `refunded_amount` is cumulative. */
function grossRefunded(a: Attrs, total: number): number {
  let refunded = Math.max(0, int(a['refunded_amount']) ?? 0);
  if (refunded === 0 && str(a['status']) === 'refunded') refunded = total;
  return total > 0 ? Math.min(refunded, total) : 0;
}

/**
 * Charge (record created in the window) and refund (refund in the window) events for one order or invoice,
 * net of tax. A null id suppresses that event.
 */
function emitPayment(
  scan: RevenueScan,
  rec: {
    created: number;
    attrs: Attrs;
    chargeId: string | null;
    refundId: string | null;
    description: string | null;
  },
): void {
  const a = rec.attrs;
  if (!CHARGEABLE_STATUSES.has(str(a['status']) ?? '')) return;
  const currency = currencyOf(a['currency']);
  if (!currency) return;
  const total = Math.max(0, int(a['total']) ?? 0);
  // Merchant of record: the tax in `total` is collected and remitted by Lemon Squeezy, not the seller's money.
  const net = total - Math.min(total, Math.max(0, int(a['tax']) ?? 0));
  const inWindow = rec.created >= scan.since;

  if (rec.chargeId && inWindow && net > 0) {
    addEvent(scan, {
      externalId: rec.chargeId,
      occurredAt: rec.created,
      type: 'charge',
      amount: net,
      currency,
      fee: null,
      description: rec.description,
    });
  }

  const refunded = grossRefunded(a, total);
  const refundNet = total > 0 ? Math.round((refunded * net) / total) : 0;
  if (rec.refundId && refundNet > 0) {
    // refunded_at is only documented for full refunds; a partial refund last touched the record.
    const at = Math.max(rec.created, time(a['refunded_at']) ?? time(a['updated_at']) ?? rec.created);
    if (inWindow || at >= scan.since) {
      if (!inWindow) scan.stats.lateRefunds += 1;
      addEvent(scan, {
        externalId: rec.refundId,
        occurredAt: at,
        type: 'refund',
        amount: -refundNet,
        currency,
        fee: null,
        description: rec.description,
      });
    }
  }
}

/** Common filters; returns the record's created_at, or null when it must be ignored. */
function admit(scan: RevenueScan, r: Resource): number | null {
  const created = time(r.attributes['created_at']);
  if (created === null) return null;
  if ((r.attributes['test_mode'] === true) !== scan.keyTestMode) {
    scan.stats.otherMode += 1;
    return null;
  }
  if (scan.scope && idOf(r.attributes['store_id']) !== scan.scope) return null;
  return created;
}

function processOrder(scan: RevenueScan, r: Resource): void {
  const created = admit(scan, r);
  if (created === null || created < scan.floor) return;
  scan.orders.set(r.id, Math.max(0, int(r.attributes['total']) ?? 0));
  const item = isObject(r.attributes['first_order_item']) ? r.attributes['first_order_item'] : {};
  emitPayment(scan, {
    created,
    attrs: r.attributes,
    chargeId: `order:${r.id}`,
    refundId: `order:${r.id}:refund`,
    description: describe(item['product_name'], item['variant_name']),
  });
}

/**
 * Did the subscription's checkout order charge money? null = unknown until the order is looked up.
 * Known orders answer directly. Otherwise, a checkout inside the order scan's range that isn't among the
 * $0 orders the scan kept charged money. A missing order id or a vanished order counts as paid at checkout,
 * the common case, which never double counts.
 */
function checkoutPaid(scan: RevenueScan, sub: Attrs): boolean | null {
  const orderId = idOf(sub['order_id']);
  if (!orderId) return true;
  const total = scan.orders.get(orderId);
  if (total !== undefined) return total !== 0;
  const subCreated = time(sub['created_at']);
  if (scan.complete && subCreated !== null && subCreated - CHECKOUT_ORDER_MARGIN_MS >= scan.floor) return true;
  return null;
}

function includedSubscriptions(list: ListPage): Map<string, Attrs> {
  const subs = new Map<string, Attrs>();
  for (const inc of list.included) if (inc.type === 'subscriptions') subs.set(inc.id, inc.attributes);
  return subs;
}

/** Checkout orders that must be looked up before this invoice page can be classified. */
function ordersToLookUp(scan: RevenueScan, list: ListPage, subs: Map<string, Attrs>): string[] {
  const out = new Set<string>();
  for (const r of list.data) {
    const a = r.attributes;
    if (str(a['billing_reason']) !== 'initial') continue;
    const created = time(a['created_at']);
    if (created === null || created < scan.floor) continue;
    if ((a['test_mode'] === true) !== scan.keyTestMode) continue;
    if (scan.scope && idOf(a['store_id']) !== scan.scope) continue;
    if (!CHARGEABLE_STATUSES.has(str(a['status']) ?? '')) continue;
    // Before the window only a refund could come out of it.
    if (created < scan.since && grossRefunded(a, Math.max(0, int(a['total']) ?? 0)) === 0) continue;
    const sub = subs.get(idOf(a['subscription_id']) ?? '');
    if (!sub || checkoutPaid(scan, sub) !== null) continue;
    out.add(idOf(sub['order_id'])!);
  }
  return [...out];
}

/** GET /orders/{id} for each id while the budget lasts; returns the ids still unknown. */
async function lookUpOrders(ctx: ProviderContext, apiKey: string, scan: RevenueScan, ids: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  for (const id of ids) {
    if (scan.orders.has(id)) continue;
    if (!hasBudget(ctx)) {
      left.push(id);
      continue;
    }
    const path = `/orders/${encodeURIComponent(id)}`;
    let total: number;
    try {
      total = Math.max(0, int(parseSingle(ctx, path, await lsGet(ctx, apiKey, path)).attributes['total']) ?? 0);
    } catch (err) {
      if (!(err instanceof ProviderError && err.kind === 'not_found')) throw err;
      ctx.log('ls_order_missing', { orderId: id });
      total = ORDER_NOT_FOUND;
    }
    scan.orders.set(id, total);
    scan.fetched.add(id);
    scan.stats.orderLookups += 1;
  }
  return left;
}

function processInvoice(scan: RevenueScan, r: Resource, subs: Map<string, Attrs>): void {
  const created = admit(scan, r);
  if (created === null || created < scan.floor) return;
  const a = r.attributes;
  const subId = idOf(a['subscription_id']);
  const sub = subId ? subs.get(subId) : undefined;
  const description = sub ? describe(sub['product_name'], sub['variant_name']) : null;
  const reason = str(a['billing_reason']);

  if (reason === 'renewal' || reason === 'updated') {
    emitPayment(scan, { created, attrs: a, chargeId: `invoice:${r.id}`, refundId: `invoice:${r.id}:refund`, description });
    return;
  }
  if (reason !== 'initial') return; // unknown reason: don't guess

  if (sub && checkoutPaid(scan, sub) === false) {
    // $0 checkout (free trial): no order carries this money, so this invoice is the first real charge.
    if (created >= scan.since) scan.stats.initialCharged += 1;
    emitPayment(scan, { created, attrs: a, chargeId: `invoice:${r.id}`, refundId: `invoice:${r.id}:refund`, description });
    return;
  }
  // Paid at checkout (or unknown: no subscription included): the order already counts this money. A refund
  // on it is the order's refund — share the order's externalId so it lands once whichever record reports it.
  if (created >= scan.since) scan.stats.initialAsOrder += 1;
  const orderId = sub ? idOf(sub['order_id']) : null;
  emitPayment(scan, { created, attrs: a, chargeId: null, refundId: orderId ? `order:${orderId}:refund` : null, description });
}

async function fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage> {
  const apiKey = apiKeyOf(input);
  const scope = storeScope(input.config);

  const resumed = decodeCursor(req.cursor);
  if (req.cursor && !resumed) ctx.log('ls_cursor_invalid', {});
  let pos: CursorPosition = resumed
    ? { since: resumed.since, phase: resumed.phase, page: resumed.page, total: resumed.total, pending: resumed.pending }
    : { since: req.since, phase: 'orders', page: 1, total: null, pending: [] };
  const carried = Object.entries(resumed?.orders ?? {});

  const scan: RevenueScan = {
    since: pos.since,
    floor: pos.since - REFUND_LOOKBACK_MS,
    keyTestMode: false,
    scope,
    events: new Map(),
    orders: new Map(carried),
    // Paid orders are carried only when they were looked up; keep carrying them.
    fetched: new Set(carried.filter(([, total]) => total > 0).map(([id]) => id)),
    complete: resumed?.complete ?? true,
    stats: { otherMode: 0, initialAsOrder: 0, initialCharged: 0, lateRefunds: 0, orderLookups: 0, rateLimited: false },
  };
  let pages = 0;
  const finish = (next: CursorPosition | null): RevenuePage => {
    ctx.log('ls_revenue', { ...scan.stats, pages, events: scan.events.size, phase: pos.phase, page: pos.page, done: next === null });
    return {
      events: [...scan.events.values()],
      daily: [],
      nextCursor: next ? encodeCursor({ v: 2, ...next, ...carriedOrders(scan) }) : null,
      done: next === null,
    };
  };

  if (!hasBudget(ctx)) return finish(pos);
  try {
    scan.keyTestMode = await resolveKeyTestMode(input, apiKey, ctx);

    for (;;) {
      if (pos.pending.length > 0) {
        pos = { ...pos, pending: await lookUpOrders(ctx, apiKey, scan, pos.pending) };
        if (pos.pending.length > 0) return finish(pos);
      }
      if (!hasBudget(ctx)) return finish(pos);

      const path = pos.phase === 'orders' ? '/orders' : '/subscription-invoices';
      const list = parseList(
        ctx,
        path,
        await lsGet(ctx, apiKey, path, {
          'filter[store_id]': scope,
          include: pos.phase === 'invoices' ? 'subscription' : undefined,
          'page[number]': pos.page,
          'page[size]': PAGE_SIZE,
        }),
      );
      pages += 1;
      const perPage = list.perPage ?? PAGE_SIZE;

      if (pos.total !== null && list.total !== null && list.total !== pos.total) {
        const shift = pageShift(list.total - pos.total, perPage);
        if (shift !== 0) {
          ctx.log('ls_page_drift', { phase: pos.phase, page: pos.page, shift });
          pos = { ...pos, page: Math.max(1, pos.page + shift), total: list.total };
          continue; // this page holds only records already read (or skipped ones): read the re-anchored page
        }
      }

      let reachedFloor = false;
      if (pos.phase === 'orders') {
        for (const r of list.data) {
          processOrder(scan, r);
          const t = time(r.attributes['created_at']);
          if (t !== null && t < scan.floor) reachedFloor = true;
        }
      } else {
        const subs = includedSubscriptions(list);
        const left = await lookUpOrders(ctx, apiKey, scan, ordersToLookUp(scan, list, subs));
        // Out of budget: look the rest up first next time, then re-read this page (same `total`).
        if (left.length > 0) return finish({ ...pos, pending: left });
        for (const r of list.data) {
          processInvoice(scan, r, subs);
          const t = time(r.attributes['created_at']);
          if (t !== null && t < scan.floor) reachedFloor = true;
        }
      }

      if (reachedFloor || list.data.length === 0 || pos.page >= lastPageOf(list, pos.page, perPage)) {
        if (pos.phase === 'invoices') return finish(null);
        pos = { since: pos.since, phase: 'invoices', page: 1, total: null, pending: [] };
      } else {
        pos = { ...pos, page: pos.page + 1, total: list.total, pending: [] };
      }
    }
  } catch (err) {
    if (!(err instanceof RateLimitedError)) throw err;
    // 300/min with no Retry-After: keep what was read and continue from the unread page next sync.
    scan.stats.rateLimited = true;
    return finish(pos);
  }
}

// ---------------------------------------------------------------------------------------------

export const lemonSqueezyAdapter: ProviderAdapter = {
  id: 'lemonsqueezy',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
