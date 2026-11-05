/**
 * Lemon Squeezy adapter (SPEC.md §6.2). Owner: Data Plane.
 *
 * JSON:API v1, https://docs.lemonsqueezy.com/api. Facts this file relies on (checked against the docs):
 *
 *  - Every list endpoint (subscriptions, orders, subscription-invoices, stores) is "ordered by created_at in
 *    descending order", pages with `page[number]` / `page[size]` (max 100) and reports `meta.page`
 *    {currentPage, lastPage, perPage, total}. There is NO created_at / updated_at filter, so revenue is read
 *    newest → oldest and paging stops once records are older than the window.
 *  - Filters used: subscriptions `filter[store_id]`, `filter[status]`; orders `filter[store_id]`;
 *    subscription-invoices `filter[store_id]`. Invoices accept `include=subscription` (JSON:API compound
 *    document; same relationship set as the official SDK) which gives product names without extra requests.
 *  - `GET /v1/users/me` returns `meta.test_mode`. Keys "only work in their respective sides of your store"
 *    (test vs live), and every order / invoice / subscription carries `test_mode`.
 *  - Prices (`GET /v1/prices/{id}`): `scheme` standard|package|graduated|volume, `unit_price` (int cents, null for
 *    tiered and usage-based), `unit_price_decimal`, `package_size`, `tiers[{last_unit|"inf", unit_price,
 *    unit_price_decimal, fixed_fee}]`, `usage_aggregation` (non-null ⇒ usage-based),
 *    `renewal_interval_unit` day|week|month|year, `renewal_interval_quantity`.
 *  - Subscription statuses: on_trial, active, paused, past_due, unpaid, cancelled, expired.
 *  - Money (`unit_price`, `total`, `refunded_amount`, …) is "a positive integer in cents" of the store or order
 *    currency. Neither the API reference nor the currencies page says what "cents" means for a currency
 *    without two decimals, so amounts are read as ISO 4217 minor units (`currencyExponent`): JPY and KRW whole,
 *    HUF and IDR in hundredths. Unverified for ISK, UGX and MGA, where Stripe's units differ from ISO.
 *  - Initial checkout fires `order_created` + `subscription_created` + `subscription_payment_success`
 *    (the latter carries the `initial` subscription invoice); renewals fire only `subscription_payment_success`
 *    (no order). So the `initial` invoice is the same money as the checkout order → not counted again.
 *    Exception: an `initial` invoice created > 1 h after its subscription (first charge after a free trial,
 *    whose checkout order was $0) is counted. Refunds on a checkout `initial` invoice are booked under the
 *    order's refund id, so the refund lands once whichever of the two records reports it.
 *
 * Decisions (SPEC §6.2 refines these):
 *  - MRR counts active, past_due and cancelled-with-ends_at-in-the-future (grace period). paused (no collection),
 *    unpaid (dunning failed) and expired are not paying. A cancelled subscription still inside its trial
 *    counts as a trial, never as MRR.
 *  - Test mode: a record is kept only when `record.test_mode === key's test mode`. A live key ignores test
 *    records; a test key sees its test data (and nothing else).
 *  - Revenue window: records created ≥ `since` produce charges + refunds; records created in the
 *    REFUND_LOOKBACK before `since` are scanned only for refunds that happened ≥ `since` (LS has no
 *    "refunds since" query, and refunds land on the original order/invoice).
 */

import { addToMoney, normalizeToMonthly, type BillingInterval, type MoneyMap } from '../lib/money';
import { buildUrl, fetchJson, hasBudget, type QueryValue, type RequestSpec } from './http';
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
/** An `initial` invoice created this long after its subscription is a real first charge (e.g. after a trial). */
export const INITIAL_INVOICE_CHECKOUT_WINDOW_MS = 60 * 60_000;
/** Subscription statuses listed for the snapshot (each is a separate filtered listing). */
const SNAPSHOT_STATUSES = ['active', 'past_due', 'cancelled', 'on_trial'] as const;
const CHARGEABLE_STATUSES = new Set(['paid', 'refunded', 'partial_refund']);
const INTERVALS = new Set<BillingInterval>(['day', 'week', 'month', 'year']);

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
}

/** `unit_price` (int cents) or, failing that, `unit_price_decimal` (decimal cents as a string). */
function unitPriceOf(a: Attrs): number | null {
  const u = num(a['unit_price']);
  if (u !== null) return u;
  return num(a['unit_price_decimal']);
}

export function parsePrice(r: Resource): LsPrice {
  const a = r.attributes;
  const unit = str(a['renewal_interval_unit']);
  const tiers = Array.isArray(a['tiers'])
    ? a['tiers'].filter(isObject).map(
        (t): LsPriceTier => ({
          lastUnit: t['last_unit'] === 'inf' ? Infinity : (num(t['last_unit']) ?? Infinity),
          unitPrice: unitPriceOf(t),
          fixedFee: num(t['fixed_fee']) ?? 0,
        }),
      )
    : null;
  return {
    id: r.id,
    scheme: str(a['scheme']) ?? 'standard',
    usageBased: a['usage_aggregation'] !== null && a['usage_aggregation'] !== undefined,
    unitPrice: unitPriceOf(a),
    packageSize: posInt(a['package_size']) ?? 1,
    tiers: tiers && tiers.length > 0 ? tiers : null,
    interval: unit && INTERVALS.has(unit as BillingInterval) ? (unit as BillingInterval) : null,
    intervalCount: posInt(a['renewal_interval_quantity']) ?? 1,
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
 * units, or null when it can't be priced (usage-based, missing unit price, broken tiers).
 */
export function priceAmountMinor(price: LsPrice, quantity: number): number | null {
  if (price.usageBased) return null;
  const q = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  if ((price.scheme === 'volume' || price.scheme === 'graduated') && price.tiers) {
    return tieredAmount(price.tiers, q, price.scheme);
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

/** SPEC §6 + §6.2: who counts towards MRR / active subscriptions / trials. */
export function classifySubscription(a: Attrs, now: number): SubscriptionKind {
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
      return trialEnds !== null && trialEnds > now ? 'trial' : 'paying';
    }
    default:
      return 'none'; // paused, unpaid, expired, unknown
  }
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  const apiKey = apiKeyOf(input);
  const scope = storeScope(input.config);
  const keyTestMode = await resolveKeyTestMode(input, apiKey, ctx);
  const currencies = new StoreCurrencies(input.config, ctx, apiKey);
  const prices = new PriceCache(ctx, apiKey);
  const now = ctx.now();

  const mrr: MoneyMap = {};
  let active = 0;
  let trials = 0;
  const stats = { listed: 0, otherMode: 0, usageBased: 0, unpriced: 0 };
  const seen = new Set<string>();

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

        const kind = classifySubscription(a, now);
        if (kind === 'trial') trials += 1;
        if (kind !== 'paying') continue;
        active += 1;

        const item = isObject(a['first_subscription_item']) ? a['first_subscription_item'] : null;
        const priceId = item ? idOf(item['price_id']) : null;
        if (item && item['is_usage_based'] === true) {
          stats.usageBased += 1;
          continue;
        }
        const price = priceId ? await prices.get(priceId) : null;
        if (price?.usageBased) {
          stats.usageBased += 1;
          continue;
        }
        const amount = price ? priceAmountMinor(price, num(item?.['quantity']) ?? 1) : null;
        const currency = storeId ? await currencies.get(storeId) : null;
        if (!price || amount === null || !price.interval || !currency) {
          stats.unpriced += 1;
          ctx.log('ls_subscription_unpriced', {
            subscriptionId: sub.id,
            priceId,
            reason: !price ? 'price' : amount === null ? 'amount' : !price.interval ? 'interval' : 'currency',
          });
          continue;
        }
        addToMoney(mrr, currency, normalizeToMonthly(amount, price.interval, price.intervalCount));
      }

      const last = list.lastPage ?? (list.data.length < PAGE_SIZE ? page : page + 1);
      if (list.data.length === 0 || page >= last) break;
    }
  }

  ctx.log('ls_snapshot', { ...stats, active, trials, prices: prices.size, currencies: Object.keys(mrr).length });
  return {
    mrr,
    activeSubscriptions: active,
    activeTrials: trials,
    // stores expose thirty_day_revenue, but in USD, live-only and with undocumented refund handling;
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
  v: 1;
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
}

export function encodeCursor(c: RevenueCursor): string {
  return JSON.stringify(c);
}

export function decodeCursor(s: string | null): RevenueCursor | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (
      isObject(v) &&
      v['v'] === 1 &&
      typeof v['since'] === 'number' &&
      Number.isFinite(v['since']) &&
      (v['phase'] === 'orders' || v['phase'] === 'invoices') &&
      typeof v['page'] === 'number' &&
      Number.isInteger(v['page']) &&
      v['page'] >= 1 &&
      (v['total'] === null || (typeof v['total'] === 'number' && Number.isInteger(v['total']) && v['total'] >= 0))
    ) {
      return { v: 1, since: v['since'], phase: v['phase'], page: v['page'], total: v['total'] };
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
  stats: { otherMode: number; initialAsOrder: number; initialCharged: number; lateRefunds: number };
}

function addEvent(scan: RevenueScan, e: RevenueEvent): void {
  const prev = scan.events.get(e.externalId);
  // The same refund can be reported by an order and by its initial invoice: keep one, the larger.
  if (!prev || Math.abs(e.amount) > Math.abs(prev.amount)) scan.events.set(e.externalId, e);
}

/**
 * Charge (record created in the window) and refund (refunded_amount > 0, refund in the window) events for one
 * order or invoice. A null id suppresses that event.
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
  const inWindow = rec.created >= scan.since;

  if (rec.chargeId && inWindow && total > 0) {
    addEvent(scan, {
      externalId: rec.chargeId,
      occurredAt: rec.created,
      type: 'charge',
      amount: total,
      currency,
      fee: null,
      description: rec.description,
    });
  }

  let refunded = Math.max(0, int(a['refunded_amount']) ?? 0);
  if (refunded === 0 && str(a['status']) === 'refunded') refunded = total;
  if (total > 0) refunded = Math.min(refunded, total);
  if (rec.refundId && refunded > 0) {
    // refunded_at is only documented for full refunds; a partial refund last touched the record.
    const at = time(a['refunded_at']) ?? time(a['updated_at']) ?? rec.created;
    if (inWindow || at >= scan.since) {
      if (!inWindow) scan.stats.lateRefunds += 1;
      addEvent(scan, {
        externalId: rec.refundId,
        occurredAt: at,
        type: 'refund',
        amount: -refunded,
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
  const item = isObject(r.attributes['first_order_item']) ? r.attributes['first_order_item'] : {};
  emitPayment(scan, {
    created,
    attrs: r.attributes,
    chargeId: `order:${r.id}`,
    refundId: `order:${r.id}:refund`,
    description: describe(item['product_name'], item['variant_name']),
  });
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

  const subCreated = sub ? time(sub['created_at']) : null;
  if (subCreated !== null && created - subCreated > INITIAL_INVOICE_CHECKOUT_WINDOW_MS) {
    // Not paid at checkout (e.g. first charge after a free trial): no order carries this money.
    if (created >= scan.since) scan.stats.initialCharged += 1;
    emitPayment(scan, { created, attrs: a, chargeId: `invoice:${r.id}`, refundId: `invoice:${r.id}:refund`, description });
    return;
  }
  // Paid at checkout: the order already counts this money. A refund on it is the order's refund — share
  // the order's externalId so it lands once whichever record reports it.
  if (created >= scan.since) scan.stats.initialAsOrder += 1;
  const orderId = sub ? idOf(sub['order_id']) : null;
  emitPayment(scan, { created, attrs: a, chargeId: null, refundId: orderId ? `order:${orderId}:refund` : null, description });
}

async function fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage> {
  const apiKey = apiKeyOf(input);
  const scope = storeScope(input.config);

  const resumed = decodeCursor(req.cursor);
  if (req.cursor && !resumed) ctx.log('ls_cursor_invalid', {});
  let cur: RevenueCursor = resumed ?? { v: 1, since: req.since, phase: 'orders', page: 1, total: null };

  const scan: RevenueScan = {
    since: cur.since,
    floor: cur.since - REFUND_LOOKBACK_MS,
    keyTestMode: false,
    scope,
    events: new Map(),
    stats: { otherMode: 0, initialAsOrder: 0, initialCharged: 0, lateRefunds: 0 },
  };
  let pages = 0;
  const finish = (next: RevenueCursor | null): RevenuePage => {
    ctx.log('ls_revenue', { ...scan.stats, pages, events: scan.events.size, phase: cur.phase, page: cur.page, done: next === null });
    return { events: [...scan.events.values()], daily: [], nextCursor: next ? encodeCursor(next) : null, done: next === null };
  };

  if (!hasBudget(ctx)) return finish(cur);
  scan.keyTestMode = await resolveKeyTestMode(input, apiKey, ctx);

  for (;;) {
    if (!hasBudget(ctx)) return finish(cur);

    const path = cur.phase === 'orders' ? '/orders' : '/subscription-invoices';
    const list = parseList(
      ctx,
      path,
      await lsGet(ctx, apiKey, path, {
        'filter[store_id]': scope,
        include: cur.phase === 'invoices' ? 'subscription' : undefined,
        'page[number]': cur.page,
        'page[size]': PAGE_SIZE,
      }),
    );
    pages += 1;
    const perPage = list.perPage ?? PAGE_SIZE;

    if (cur.total !== null && list.total !== null && list.total !== cur.total) {
      const shift = pageShift(list.total - cur.total, perPage);
      if (shift !== 0) {
        ctx.log('ls_page_drift', { phase: cur.phase, page: cur.page, shift });
        cur = { ...cur, page: Math.max(1, cur.page + shift), total: list.total };
        continue; // this page holds only records already read (or skipped ones): read the re-anchored page
      }
    }

    let reachedFloor = false;
    if (cur.phase === 'orders') {
      for (const r of list.data) {
        processOrder(scan, r);
        const t = time(r.attributes['created_at']);
        if (t !== null && t < scan.floor) reachedFloor = true;
      }
    } else {
      const subs = new Map<string, Attrs>();
      for (const inc of list.included) if (inc.type === 'subscriptions') subs.set(inc.id, inc.attributes);
      for (const r of list.data) {
        processInvoice(scan, r, subs);
        const t = time(r.attributes['created_at']);
        if (t !== null && t < scan.floor) reachedFloor = true;
      }
    }

    const last = list.lastPage ?? (list.data.length < perPage ? cur.page : cur.page + 1);
    if (reachedFloor || list.data.length === 0 || cur.page >= last) {
      if (cur.phase === 'invoices') return finish(null);
      cur = { v: 1, since: cur.since, phase: 'invoices', page: 1, total: null };
    } else {
      cur = { ...cur, page: cur.page + 1, total: list.total };
    }
  }
}

// ---------------------------------------------------------------------------------------------

export const lemonSqueezyAdapter: ProviderAdapter = {
  id: 'lemonsqueezy',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
