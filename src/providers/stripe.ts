/**
 * Stripe adapter. Owner: Data Plane. SPEC.md §6.1.
 *
 * Every request pins `Stripe-Version: 2026-10-28.endive` (latest GA version in the API reference on
 * 2026-11-05) so response shapes don't drift with each account's default version. Shapes this file
 * relies on in that version (https://docs.stripe.com/api):
 *   - Subscription.discounts and SubscriptionItem.discounts are arrays of discount IDs, expandable into
 *     Discount objects. The legacy singular `discount` field is gone.
 *   - Discount.source.coupon is a coupon ID (expandable). The legacy embedded `Discount.coupon` is gone.
 *   - Coupon.applies_to, Coupon.currency_options, Price.currency_options, Price.tiers and
 *     Price.currency_options.<currency>.tiers are "includable" (returned only when expanded).
 *   - Subscription.default_tax_rates and SubscriptionItem.tax_rates are embedded TaxRate objects (not
 *     expandable), so `inclusive` and `percentage` come with the subscription: no Tax Rates permission,
 *     no extra request.
 *   - current_period_start/end live on subscription items. MRR doesn't need them.
 *   - SubscriptionItem.current_trial marks an item-level trial (a trial offer).
 *
 * Metrics follow Stripe's Billing analytics definitions (https://docs.stripe.com/billing/subscriptions/analytics):
 *   MRR           active + past_due subscriptions, normalized to a month (SPEC §6), net of running recurring
 *                 discounts and of tax. Left out: metered (usage-based) items, items in a running trial
 *                 offer, one-time discounts. Licensed tiered prices count, priced from their tiers:
 *                   volume     the whole quantity at the unit amount of the tier it falls in, plus that
 *                              tier's flat amount;
 *                   graduated  each band of the quantity at its own tier's unit amount, plus the flat amount
 *                              of every tier reached. Quantity 0 bills the first tier's flat amount.
 *                 Tax: the item's manual tax rates (its own `tax_rates`, else the subscription's
 *                 `default_tax_rates`) marked `inclusive` are inside the amount. They come out after
 *                 discounts, as amount / (1 + Σ inclusive %), which is how Stripe discounts first and
 *                 then backs inclusive tax out of the rest. Exclusive rates are added on top of the price,
 *                 so there is nothing to remove.
 *   Active subs   active + past_due subscriptions whose MRR is > 0 ("Active subscribers only includes
 *                 subscribers with positive MRR"). Free plans, 100%-off coupons, and subscriptions that
 *                 are only metered items or only running trial offers don't count; Stripe's definition
 *                 leaves them out too. Stripe counts customers; this counts subscriptions (SPEC §6).
 *   Trials        every status=trialing subscription (a legacy `trial_end` trial counts once; a trialing
 *                 subscription made of free trial offers counts each of those items), plus every item of
 *                 an active / past_due subscription whose trial offer is still running. Stripe counts
 *                 trial offers per subscription item.
 *   By product    each subscription's MRR split over its items' products (`price.product`), after the same
 *                 discounts and tax, in whole minor units that add up to the subscription's MRR (largest
 *                 remainder). A subscription counts once under each product it pays for. Names come from
 *                 the products themselves (Products: Read, optional): without it the split is null and MRR
 *                 is unchanged. Product and plan names only, never customer data (SPEC N-04).
 *
 * Request plan:
 *   verify        5 requests, limit=1 each: subscriptions, prices, balance_transactions, coupons, products. A
 *                 403 on one of the first three names the missing registry permission and fails. A 403 on
 *                 coupons or products only adds a warning: MRR is then shown before discounts, or not split
 *                 by product.
 *   fetchSnapshot status=active and status=past_due (limit=100, expand[]=data.discounts and
 *                 data.items.data.discounts), then status=trialing (no expansion). Plus cached lookups,
 *                 one per distinct:
 *                   coupon in a running discount            GET /v1/coupons/{id} (Coupons: Read)
 *                   multi-currency price billed in another  GET /v1/prices/{id}?expand[]=currency_options
 *                   currency
 *                   tiered price                            GET /v1/prices/{id}?expand[]=tiers, or
 *                                                           expand[]=currency_options +
 *                                                           currency_options.<cur>.tiers in another currency
 *                 and /v1/subscription_items pages for a subscription with more items than the embedded list.
 *                 Running out of budget throws BudgetExhaustedError: a partial MRR would be wrong.
 *                 Then GET /v1/products?ids[]=… (limit=100) per 100 products in the MRR, for their names.
 *                 That lookup never fails the snapshot: a 403, a spent budget or an upstream error leaves
 *                 the split null (logged).
 *   fetchRevenue  balance_transactions newest to oldest between a fixed [since, startedAt] window, resumable.
 *
 * Amount units: Stripe's integers match ISO 4217 minor units (hoomuch's `currencyExponent`) except for MGA,
 * ISK and UGX, which `fromStripeAmount` converts. Every amount read from Stripe goes through it.
 *
 * Known limitations:
 *   - Customer-level discounts (a coupon on the Customer, applied to all of its invoices) aren't applied.
 *     Reading them needs Customers: Read, which exposes customer PII.
 *   - Stripe Tax (automatic_tax.enabled): the rate depends on the customer's location and isn't on the
 *     subscription, so a tax-inclusive price stays tax-inclusive in MRR (counted, logged once as
 *     stripe_inclusive_tax_unknown). A price with tax_behavior=unspecified follows the account's default
 *     tax behavior, which a restricted key can't read; it is treated as exclusive. Tax rates added to each
 *     invoice as it's created (invoice.created webhook) aren't visible on the subscription either.
 *   - A partially captured card payment is a `charge` for the full authorization plus a `refund`
 *     (reporting_category partial_capture_reversal) for the uncaptured part. Both are booked, so gross and
 *     refunds are each slightly high while net revenue is right.
 *   - Subscriptions on a test clock aren't returned by the list endpoint without a test_clock or customer
 *     filter, so they're not counted (test mode only).
 *   - A tiered price in a non-default currency needs expand[]=currency_options.<cur>.tiers. If Stripe
 *     rejects that expansion (400), the item is left out and logged instead of failing the snapshot.
 */

import {
  addToMoney,
  currencyExponent,
  normalizeCurrency,
  normalizeToMonthly,
  type BillingInterval,
  type MoneyMap,
} from '../lib/money';
import { buildUrl, fetchJson, hasBudget, type QueryValue } from './http';
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
import { STRIPE_PRODUCTS_WARNING } from './warnings';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
export const STRIPE_API_VERSION = '2026-10-28.endive';

const PROVIDER = 'Stripe';
const PAGE_SIZE = 100;

// Registry wording (registry.ts → permissions), used verbatim in 403 messages. These are the Dashboard's
// resource names; the API scopes are subscription_read, plan_read, balance_read and coupon_read.
const PERM_SUBSCRIPTIONS = 'Subscriptions: Read';
const PERM_PRICES = 'Prices: Read';
const PERM_BALANCE = 'Balance: Read';
// Listed in the registry, but optional: without it MRR degrades to "before discounts" instead of failing
// the sync (see `CouponResolver`), and verify only warns.
const PERM_COUPONS = 'Coupons: Read';
// Optional too: without it the snapshot's MRR isn't split by product (see `productNames`), and verify only warns.
const PERM_PRODUCTS = 'Products: Read';

export const SECRET_KEY_WARNING =
  'This is a full-access secret key. A restricted key (rk_…) with read access is safer. You can replace the key on this page.';

// Snapshot warnings (`MetricsSnapshot.warnings`). The permission ones are verify's warnings too, word for
// word; STRIPE_PRODUCTS_WARNING is in ./warnings.ts, because the dashboard matches it.
export const STRIPE_COUPONS_WARNING =
  'This key can’t read coupons, so MRR is shown before discounts. Add Coupons: Read to fix it.';
export const STRIPE_PRODUCT_SPLIT_SKIPPED_WARNING =
  'MRR isn’t split by product this time, because Stripe didn’t return the product names; the next sync tries again.';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const stripeUnpricedItemsWarning = (items: number) =>
  `${plural(items, 'subscription item has a price', 'subscription items have prices')} hoomuch can’t read, so ${items === 1 ? 'it counts' : 'they count'} as 0 in MRR.`;
export const stripeDiscountsUnresolvedWarning = (discounts: number) =>
  `${plural(discounts, 'discount', 'discounts')} couldn’t be read or applied, so MRR is shown before ${discounts === 1 ? 'it' : 'them'}.`;
export const stripeInclusiveTaxWarning = (items: number) =>
  `MRR includes tax on ${plural(items, 'subscription item', 'subscription items')}: ${items === 1 ? 'its price is' : 'their prices are'} tax-inclusive under Stripe Tax, which doesn’t say the rate.`;

// ---------- key handling ----------

interface ParsedKey {
  key: string;
  restricted: boolean;
  testMode: boolean;
}

/** Secret/restricted keys only. Rejecting anything else also keeps stray characters out of the header. */
const KEY_RE = /^(rk|sk)_(live|test)_[A-Za-z0-9_]+$/;

function parseKey(raw: string | undefined): ParsedKey | { error: string } {
  const key = (raw ?? '').trim();
  if (!key) return { error: 'Paste a Stripe restricted key (rk_live_… or rk_test_…).' };
  if (/^pk_(live|test)_/.test(key)) {
    return { error: 'That is a publishable key (pk_…). hoomuch needs a restricted key (rk_…) with read access.' };
  }
  const m = KEY_RE.exec(key);
  if (!m) {
    return {
      error: 'That doesn’t look like a Stripe API key. It should start with rk_live_, rk_test_, sk_live_ or sk_test_.',
    };
  }
  return { key, restricted: m[1] === 'rk', testMode: m[2] === 'test' };
}

function requireKey(input: ConnectionInput): ParsedKey {
  const parsed = parseKey(input.credentials['apiKey']);
  if ('error' in parsed) throw new ProviderError('invalid_input', parsed.error, { field: 'apiKey' });
  return parsed;
}

// ---------- HTTP ----------

function stripeGet<T>(
  ctx: ProviderContext,
  key: string,
  path: string,
  query: Record<string, QueryValue>,
  permission: string,
): Promise<T> {
  return fetchJson<T>(ctx, {
    provider: PROVIDER,
    url: buildUrl(STRIPE_API_BASE, path, query),
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_API_VERSION },
    permission,
  });
}

function unreadable(): ProviderError {
  return new ProviderError('upstream', 'Stripe returned a response hoomuch couldn’t read.');
}

function asList<T>(body: unknown): StripeList<T> {
  if (!isObject(body) || !Array.isArray(body['data'])) throw unreadable();
  return { data: body['data'] as T[], has_more: body['has_more'] === true };
}

/** Walks a Stripe list (newest first) with `starting_after`. Every page spends one unit of budget. */
async function* paginate<T extends { id: string }>(
  ctx: ProviderContext,
  key: string,
  path: string,
  query: Record<string, QueryValue>,
  permission: string,
  startAfter?: string,
): AsyncGenerator<T> {
  let after = startAfter;
  for (;;) {
    const page = asList<T>(await stripeGet(ctx, key, path, { ...query, limit: PAGE_SIZE, starting_after: after }, permission));
    for (const obj of page.data) yield obj;
    const last = page.data[page.data.length - 1];
    if (!page.has_more || !last) return;
    if (typeof last.id !== 'string') throw unreadable(); // would otherwise re-read page 1 forever
    after = last.id;
  }
}

// ---------- Stripe shapes (only the fields we read; pinned version) ----------

interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

interface StripeRecurring {
  interval: string;
  interval_count: number;
  usage_type: string;
}

interface StripeTier {
  flat_amount: number | null;
  flat_amount_decimal: string | null;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  /** null = inf (the last tier). */
  up_to: number | null;
}

interface StripeAmounts {
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  /** Includable: only present when expanded. */
  tiers?: StripeTier[] | null;
}

interface StripePrice extends StripeAmounts {
  id: string;
  currency: string;
  billing_scheme: string;
  tiers_mode?: string | null;
  tax_behavior?: string | null;
  product: string | { id: string } | null;
  recurring: StripeRecurring | null;
  transform_quantity: { divide_by: number; round: string } | null;
  currency_options?: Record<string, StripeAmounts> | null;
}

interface StripeTaxRate {
  id: string;
  inclusive: boolean;
  percentage: number;
  /** Only set on rates created by Stripe Tax. */
  rate_type?: string | null;
}

interface StripeCoupon {
  id: string;
  amount_off: number | null;
  currency: string | null;
  percent_off: number | null;
  duration: string;
  applies_to?: { products: string[] } | null;
  currency_options?: Record<string, { amount_off: number }> | null;
}

interface StripeDiscount {
  id: string;
  end: number | null;
  source?: { type: string; coupon: string | StripeCoupon | null } | null;
}

type DiscountRef = string | StripeDiscount;

interface StripeSubscriptionItem {
  id: string;
  price: StripePrice | null;
  quantity: number | null;
  discounts?: DiscountRef[] | null;
  current_trial?: { end_date: number } | null;
  /** When non-empty, replaces the subscription's default_tax_rates for this item. */
  tax_rates?: StripeTaxRate[] | null;
}

interface StripeSubscription {
  id: string;
  currency: string;
  discounts?: DiscountRef[] | null;
  automatic_tax?: { enabled: boolean } | null;
  default_tax_rates?: StripeTaxRate[] | null;
  items: { data: StripeSubscriptionItem[]; has_more: boolean };
}

interface StripeProduct {
  id: string;
  name: string;
}

interface StripeBalanceTransaction {
  id: string;
  amount: number;
  created: number;
  currency: string;
  fee: number;
  type: string;
  reporting_category: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// ---------- amount units ----------

/**
 * Currencies whose Stripe amount digits differ from ISO 4217 (https://docs.stripe.com/currencies):
 *   - MGA is in Stripe's zero-decimal list (BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF);
 *     ISO 4217 gives it 2. The rest of that list is 0 in ISO too.
 *   - ISK and UGX "transitioned to a zero-decimal currency, but backward compatibility requires you to
 *     represent it as a two-decimal value" (500 = 5 ISK); ISO gives both 0. UGX also still appears in the
 *     zero-decimal list; the special case wins, matching Stripe's own client (stripe-android
 *     CurrencyFormatter.SERVER_DECIMAL_DIGITS lists UGX and ISK as 2).
 * Everything else is two-decimal unless ISO says otherwise: HUF and TWD charge in hundredths (they're
 * zero-decimal for payouts only), and so do IDR, COP and PKR; BHD, JOD, KWD, OMR and TND use 3 digits.
 */
const STRIPE_DIGITS: Readonly<Record<string, number>> = { MGA: 0, ISK: 2, UGX: 2 };

/** Digits Stripe uses for `currency` in API amounts. */
export function stripeDigits(currency: string): number {
  const cur = normalizeCurrency(currency);
  return STRIPE_DIGITS[cur] ?? currencyExponent(cur);
}

/** A Stripe API amount → hoomuch minor units (ISO 4217 digits). Not rounded: callers round once, at the end. */
export function fromStripeAmount(amount: number, currency: string): number {
  const shift = currencyExponent(currency) - stripeDigits(currency);
  return shift === 0 ? amount : amount * 10 ** shift;
}

/** A Stripe integer amount → integer hoomuch minor units (ISK 500 → 5, MGA 5000 → 500000). */
function stripeMinor(amount: number, currency: string): number {
  return Math.round(fromStripeAmount(amount, currency)) || 0; // no -0
}

// ---------- MRR ----------

const INTERVALS: readonly BillingInterval[] = ['day', 'week', 'month', 'year'];
const INTERVAL_DAYS: Record<BillingInterval, number> = { day: 1, week: 7, month: 365 / 12, year: 365 };

/**
 * One licensed subscription item, normalized to a monthly amount (minor units, fractional while
 * discounting). `monthly` still includes inclusive tax; `taxDivisor` takes it out at the end.
 */
interface Line {
  product: string | null;
  monthly: number;
  interval: BillingInterval;
  count: number;
  /** 1 + the item's inclusive tax rates / 100; 1 when its amount holds no tax we know of. */
  taxDivisor: number;
}

interface SnapshotStats {
  /** Tiered items whose tiers couldn't be read or used. */
  tieredUnpriced: number;
  unresolvedDiscounts: number;
  unpricedItems: number;
  /** Tax-inclusive items under Stripe Tax: the rate isn't on the subscription, so tax stays in. */
  inclusiveTaxUnknown: number;
  /** active / past_due subscriptions left out of the active count because their MRR is 0. */
  zeroMrrSubscriptions: number;
}

/**
 * Per-run coupon cache. Coupons are fetched by ID with applies_to + currency_options rather than
 * expanded from the subscription list, for three reasons:
 *   - data.discounts.source.coupon already uses all 4 expand levels, so the includable fields stay
 *     out of reach.
 *   - Item-level coupons (data.items.data.discounts.source.coupon) would need 6.
 *   - An expansion the key lacks a permission for fails the whole page with a 403.
 * A key without Coupons: Read is detected on the first 403. Discounts are then left unapplied (and
 * logged) instead of failing the whole snapshot.
 */
class CouponResolver {
  private readonly cache = new Map<string, StripeCoupon | null>();
  private missing = false;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly key: string,
  ) {}

  /** True once a coupon lookup answered 403: every discount after it is left unapplied. */
  get permissionMissing(): boolean {
    return this.missing;
  }

  async get(ref: string | StripeCoupon | null | undefined): Promise<StripeCoupon | null> {
    if (!ref) return null;
    if (typeof ref !== 'string') return ref;
    if (this.cache.has(ref)) return this.cache.get(ref) ?? null;
    if (this.missing) return null;
    try {
      const coupon = await stripeGet<StripeCoupon>(
        this.ctx,
        this.key,
        `/coupons/${encodeURIComponent(ref)}`,
        { 'expand[]': ['applies_to', 'currency_options'] },
        PERM_COUPONS,
      );
      this.cache.set(ref, isObject(coupon) ? coupon : null);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === 'permission') {
        this.missing = true;
        this.ctx.log('stripe_coupon_permission_missing', { effect: 'mrr_before_discounts' });
        return null;
      }
      if (err.kind !== 'not_found') throw err; // budget, rate limit, 5xx: fail the snapshot
      this.cache.set(ref, null); // deleted coupon: its discount still applies, but we can't read it
    }
    return this.cache.get(ref) ?? null;
  }
}

/**
 * Per-run cache of prices re-read with includable fields, keyed by price ID + expand list:
 *   - currency_options, for a multi-currency price billed in a currency other than its default;
 *   - tiers (or currency_options.<cur>.tiers), for a tiered price. The subscription list can't include
 *     them: data.items.data.price.tiers is 5 expand levels, and Stripe allows 4.
 * Same permission as the verify probe (Prices: Read). Prices can be archived but not deleted, so the
 * price of a live subscription always resolves.
 */
class PriceResolver {
  private readonly cache = new Map<string, StripePrice | null>();

  constructor(
    private readonly ctx: ProviderContext,
    private readonly key: string,
  ) {}

  /** null only when `tolerateBadRequest` and Stripe rejected the expand list (400). */
  private async fetch(id: string, expand: string[], tolerateBadRequest = false): Promise<StripePrice | null> {
    const cacheKey = `${id}|${expand.join(',')}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
    let price: StripePrice | null;
    try {
      const body = await stripeGet<unknown>(
        this.ctx,
        this.key,
        `/prices/${encodeURIComponent(id)}`,
        { 'expand[]': expand },
        PERM_PRICES,
      );
      if (!isObject(body)) throw unreadable();
      price = body as unknown as StripePrice;
    } catch (err) {
      if (!(tolerateBadRequest && err instanceof ProviderError && err.status === 400)) throw err;
      price = null;
    }
    this.cache.set(cacheKey, price);
    return price;
  }

  async withCurrencyOptions(id: string): Promise<StripePrice | null> {
    return this.fetch(id, ['currency_options']);
  }

  /** The price's tiers in `currency` (lowercase), or null if Stripe doesn't return them. */
  async tiersIn(price: StripePrice, currency: string): Promise<StripeTier[] | null> {
    if (price.currency?.toLowerCase() === currency) {
      const full = await this.fetch(price.id, ['tiers']);
      return Array.isArray(full?.tiers) ? full.tiers : null;
    }
    // The docs mark currency_options.<cur>.tiers includable but show no expand example, so a 400 here
    // leaves this one item out (logged) instead of failing the snapshot.
    const full = await this.fetch(price.id, ['currency_options', `currency_options.${currency}.tiers`], true);
    const tiers = full?.currency_options?.[currency]?.tiers;
    return Array.isArray(tiers) ? tiers : null;
  }
}

interface MrrEnv {
  ctx: ProviderContext;
  key: string;
  now: number;
  coupons: CouponResolver;
  prices: PriceResolver;
  stats: SnapshotStats;
}

/** An integer amount, else its `_decimal` twin (a decimal string), else null. */
function amountOrDecimal(n: number | null | undefined, decimal: string | null | undefined): number | null {
  if (typeof n === 'number' && Number.isFinite(n)) return n;
  if (typeof decimal === 'string') {
    const v = Number(decimal);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function amountOf(a: StripeAmounts | null | undefined): number | null {
  return a ? amountOrDecimal(a.unit_amount, a.unit_amount_decimal) : null;
}

/** Unit amount in the subscription's currency (lowercase), in Stripe's units, or null if it can't be determined. */
async function unitAmountIn(price: StripePrice, currency: string, env: MrrEnv): Promise<number | null> {
  if (price.currency?.toLowerCase() === currency) return amountOf(price);
  // Multi-currency price: the embedded object carries the default currency only.
  const full = await env.prices.withCurrencyOptions(price.id);
  return amountOf(full?.currency_options?.[currency]);
}

/**
 * What Stripe bills per period for `quantity` units of a tiered price (minor units, unrounded), or null
 * if the tiers or mode can't be used. https://docs.stripe.com/subscriptions/pricing-models/tiered-pricing
 *   volume     quantity × unit amount of the first tier whose up_to ≥ quantity, + that tier's flat amount.
 *   graduated  Σ per tier: (units of the quantity inside the tier) × its unit amount, + its flat amount
 *              for every tier the quantity reaches.
 * Both bill the first tier's flat amount at quantity 0 ("Stripe always bills the first flat rate tier
 * when quantity=0"). A tier has a unit amount, a flat amount or both; a missing one is 0.
 */
function tieredAmount(tiers: StripeTier[], mode: string | null | undefined, quantity: number): number | null {
  const sorted = tiers
    .filter((t): t is StripeTier => isObject(t))
    .map((t) => ({
      upTo: typeof t.up_to === 'number' && Number.isFinite(t.up_to) ? t.up_to : Infinity,
      unit: amountOrDecimal(t.unit_amount, t.unit_amount_decimal) ?? 0,
      flat: amountOrDecimal(t.flat_amount, t.flat_amount_decimal) ?? 0,
    }))
    .sort((a, b) => a.upTo - b.upTo);
  const last = sorted[sorted.length - 1];
  if (!last || !(quantity >= 0)) return null;
  if (mode === 'volume') {
    const tier = sorted.find((t) => quantity <= t.upTo) ?? last;
    return quantity * tier.unit + tier.flat;
  }
  if (mode === 'graduated') {
    let total = 0;
    let below = 0; // units already billed by lower tiers
    for (const [i, t] of sorted.entries()) {
      const units = Math.min(quantity, t.upTo) - below;
      if (units > 0 || i === 0) total += Math.max(0, units) * t.unit + t.flat;
      if (quantity <= t.upTo) break;
      below = t.upTo;
    }
    return total;
  }
  return null;
}

function billedQuantity(quantity: number, t: StripePrice['transform_quantity']): number {
  if (!t || !(t.divide_by > 0)) return quantity;
  const q = quantity / t.divide_by;
  return t.round === 'up' ? Math.ceil(q) : Math.floor(q);
}

function productId(p: StripePrice['product']): string | null {
  if (!p) return null;
  return typeof p === 'string' ? p : p.id;
}

/** True while the item's trial offer runs. Stripe drops `current_trial` once the trial ends. */
function inTrialOffer(item: StripeSubscriptionItem, now: number): boolean {
  const end = item.current_trial?.end_date;
  return typeof end === 'number' && end * 1000 > now;
}

/** One invoice line's amount per billing period (rounded minor units), or null if it can't be priced (counted in stats). */
async function periodAmount(price: StripePrice, quantity: number, currency: string, env: MrrEnv): Promise<number | null> {
  if (price.billing_scheme === 'tiered') {
    const tiers = await env.prices.tiersIn(price, currency);
    const amount = tiers ? tieredAmount(tiers, price.tiers_mode, quantity) : null; // tiers can't take transform_quantity
    if (amount === null) {
      env.stats.tieredUnpriced += 1;
      return null;
    }
    return Math.round(amount);
  }
  const unit = await unitAmountIn(price, currency, env);
  if (unit === null) {
    env.stats.unpricedItems += 1;
    return null;
  }
  // Stripe bills round(unit × quantity) per period.
  return Math.round(unit * billedQuantity(quantity, price.transform_quantity));
}

/**
 * 1 + Σ(inclusive manual tax rates) / 100 for one item: dividing by it backs inclusive tax out of the
 * amount, as Stripe does (tax = amount − amount / (1 + rate)). https://docs.stripe.com/billing/taxes/tax-rates
 *   - The item's own tax_rates replace the subscription's default_tax_rates when set.
 *   - A TaxRate's `inclusive` flag decides whether its percentage is inside the amount ("The inclusive
 *     property determines whether the tax percentage is added to, or included in, the overall amount"),
 *     whatever the price's tax_behavior says (that field is for Stripe Tax).
 *   - Stripe Tax (automatic_tax) can't be combined with tax rates and keeps its rate off the subscription:
 *     a tax-inclusive price is left as is and counted.
 */
function inclusiveTaxDivisor(item: StripeSubscriptionItem, price: StripePrice, sub: StripeSubscription, env: MrrEnv): number {
  if (sub.automatic_tax?.enabled === true) {
    if (price.tax_behavior === 'inclusive') env.stats.inclusiveTaxUnknown += 1;
    return 1;
  }
  const rates = Array.isArray(item.tax_rates) && item.tax_rates.length > 0 ? item.tax_rates : sub.default_tax_rates;
  let percent = 0;
  for (const r of Array.isArray(rates) ? rates : []) {
    if (typeof r !== 'object' || r === null || r.inclusive !== true || r.rate_type === 'flat_amount') continue;
    if (typeof r.percentage === 'number' && Number.isFinite(r.percentage) && r.percentage > 0) percent += r.percentage;
  }
  return 1 + percent / 100;
}

async function itemLine(item: StripeSubscriptionItem, sub: StripeSubscription, currency: string, env: MrrEnv): Promise<Line | null> {
  const price = item.price;
  const rec = price?.recurring;
  if (!price || !rec) return null;
  if (rec.usage_type === 'metered') return null; // usage-based: not recurring revenue (SPEC §6.1)
  if (inTrialOffer(item, env.now)) return null; // counted as a trial instead
  const interval = rec.interval as BillingInterval;
  if (!INTERVALS.includes(interval)) {
    env.stats.unpricedItems += 1;
    return null;
  }
  const perPeriod = await periodAmount(price, item.quantity ?? 1, currency, env);
  if (perPeriod === null) return null;
  const count = rec.interval_count > 0 ? rec.interval_count : 1;
  // periodAmount is what Stripe bills per period (unit × quantity, or the tiers), in Stripe's units; convert
  // that invoice line to minor units (fractional for ISK/UGX until normalizeToMonthly rounds).
  const minor = fromStripeAmount(perPeriod, currency);
  return {
    product: productId(price.product),
    monthly: normalizeToMonthly(minor, interval, count),
    interval,
    count,
    taxDivisor: inclusiveTaxDivisor(item, price, sub, env),
  };
}

/** The coupon's amount_off in `currency`, in hoomuch minor units. */
function amountOffIn(coupon: StripeCoupon, currency: string): number | null {
  if (typeof coupon.amount_off !== 'number') return null;
  if (coupon.currency?.toLowerCase() === currency) return fromStripeAmount(coupon.amount_off, currency);
  const opt = coupon.currency_options?.[currency]?.amount_off;
  return typeof opt === 'number' ? fromStripeAmount(opt, currency) : null;
}

/** Shortest billing period among the lines = how often an invoice (and so an amount_off) occurs. */
function invoiceCadence(lines: Line[]): { interval: BillingInterval; count: number } {
  let best = lines[0]!;
  for (const l of lines) {
    if (INTERVAL_DAYS[l.interval] * l.count < INTERVAL_DAYS[best.interval] * best.count) best = l;
  }
  return { interval: best.interval, count: best.count };
}

/**
 * Applies `discounts` in array order to `lines`. Stripe applies stacked discounts sequentially, so
 * "20% then 5 USD off" differs from "5 USD then 20% off".
 *   - expired (discount.end ≤ now): ignored.
 *   - duration=once: ignored. A one-time discount is not recurring revenue, and Stripe removes it from
 *     `discounts` once the invoice that used it finalizes.
 *   - forever / repeating (still running): applied.
 *   - percent_off: scales eligible lines.
 *   - amount_off: per invoice, in the coupon's currency (or its currency_options entry for ours),
 *     normalized to a month at the eligible lines' invoice cadence, capped at their amount, and spread
 *     pro rata.
 *   - coupon.applies_to.products limits the eligible lines. Metered and trialing items are never lines.
 */
async function applyDiscounts(
  lines: Line[],
  discounts: DiscountRef[] | null | undefined,
  currency: string,
  env: MrrEnv,
): Promise<void> {
  for (const d of discounts ?? []) {
    if (typeof d === 'string' || !isObject(d)) {
      env.stats.unresolvedDiscounts += 1; // not expanded (shouldn't happen with our expand[])
      continue;
    }
    if (typeof d.end === 'number' && d.end * 1000 <= env.now) continue;
    const coupon = await env.coupons.get(d.source?.coupon);
    if (!coupon) {
      env.stats.unresolvedDiscounts += 1;
      continue;
    }
    if (coupon.duration === 'once') continue;

    const only = coupon.applies_to?.products;
    const eligible = only && only.length > 0 ? lines.filter((l) => l.product !== null && only.includes(l.product)) : lines;
    const base = eligible.reduce((s, l) => s + l.monthly, 0);
    if (eligible.length === 0 || base <= 0) continue;

    let factor: number;
    if (typeof coupon.percent_off === 'number') {
      factor = 1 - coupon.percent_off / 100;
    } else {
      const off = amountOffIn(coupon, currency);
      if (off === null) {
        env.stats.unresolvedDiscounts += 1;
        continue;
      }
      const { interval, count } = invoiceCadence(eligible);
      factor = 1 - normalizeToMonthly(off, interval, count) / base;
    }
    factor = Math.min(1, Math.max(0, factor));
    for (const l of eligible) l.monthly *= factor;
  }
}

/** All items of a subscription. The embedded list can be truncated (flexible billing mode allows 100 items). */
async function subscriptionItems(sub: StripeSubscription, env: MrrEnv): Promise<StripeSubscriptionItem[]> {
  const items = [...(sub.items?.data ?? [])];
  const last = items[items.length - 1];
  if (sub.items?.has_more && last) {
    for await (const item of paginate<StripeSubscriptionItem>(
      env.ctx,
      env.key,
      '/subscription_items',
      { subscription: sub.id, 'expand[]': ['data.discounts'] },
      PERM_SUBSCRIPTIONS,
      last.id,
    )) {
      items.push(item);
    }
  }
  return items;
}

/**
 * Whole numbers that add up to `total`, each as close to its share in `parts` as rounding allows
 * (largest remainder). `total` is the rounded sum of `parts`.
 */
export function splitRounded(parts: ReadonlyMap<string, number>, total: number): Map<string, number> {
  const out = new Map<string, number>();
  const rest: Array<{ key: string; frac: number }> = [];
  let left = total;
  for (const [key, v] of parts) {
    const whole = Math.floor(v);
    out.set(key, whole);
    left -= whole;
    rest.push({ key, frac: v - whole });
  }
  // Biggest remainders first; ties in insertion order (sort is stable).
  rest.sort((a, b) => b.frac - a.frac);
  for (let i = 0; left > 0 && rest.length > 0; i = (i + 1) % rest.length, left--) {
    const k = rest[i]!.key;
    out.set(k, out.get(k)! + 1);
  }
  return out;
}

interface SubscriptionMrr {
  /** Rounded minor units. */
  amount: number;
  /** `amount` by product ID ('' for a price without one), whole minor units adding up to `amount`. */
  byProduct: Map<string, number>;
}

/**
 * Monthly recurring amount of one subscription (rounded minor units): item discounts first, then
 * subscription discounts, then inclusive tax backed out of what's left. Also split by product.
 */
async function subscriptionMrr(
  sub: StripeSubscription,
  items: StripeSubscriptionItem[],
  currency: string,
  env: MrrEnv,
): Promise<SubscriptionMrr> {
  const lines: Line[] = [];
  for (const item of items) {
    const line = await itemLine(item, sub, currency, env);
    if (!line) continue;
    await applyDiscounts([line], item.discounts, currency, env);
    lines.push(line);
  }
  await applyDiscounts(lines, sub.discounts, currency, env);
  const net = (l: Line) => Math.max(0, l.monthly) / l.taxDivisor;
  const amount = Math.round(lines.reduce((s, l) => s + net(l), 0));
  const parts = new Map<string, number>();
  for (const l of lines) parts.set(l.product ?? '', (parts.get(l.product ?? '') ?? 0) + net(l));
  return { amount, byProduct: splitRounded(parts, amount) };
}

/** Product IDs per `GET /v1/products?ids[]=…` request (the list's maximum `limit`). */
const PRODUCT_IDS_PER_REQUEST = 100;

/**
 * Names of the products in the MRR, by ID. Null when they can't all be read: the key lacks Products:
 * Read (a 403), the snapshot's budget is spent, or Stripe fails after its retries. Each is logged and
 * leaves MRR as it is: the split by product is extra, so it never fails the snapshot. A product the
 * list doesn't return (or one without a name) is simply missing from the map.
 */
async function productNames(
  ids: readonly string[],
  ctx: ProviderContext,
  key: string,
  warnings: Set<string>,
): Promise<Map<string, string> | null> {
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += PRODUCT_IDS_PER_REQUEST) {
    if (!hasBudget(ctx)) {
      ctx.log('stripe_product_names_skipped', { reason: 'budget', products: ids.length });
      warnings.add(STRIPE_PRODUCT_SPLIT_SKIPPED_WARNING);
      return null;
    }
    const chunk = ids.slice(i, i + PRODUCT_IDS_PER_REQUEST);
    let page: StripeList<unknown>;
    try {
      page = asList<unknown>(
        await stripeGet<unknown>(ctx, key, '/products', { 'ids[]': chunk, limit: PRODUCT_IDS_PER_REQUEST }, PERM_PRODUCTS),
      );
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      ctx.log(err.kind === 'permission' ? 'stripe_product_permission_missing' : 'stripe_product_names_skipped', {
        reason: err.kind,
        effect: 'mrr_not_split_by_product',
      });
      warnings.add(err.kind === 'permission' ? STRIPE_PRODUCTS_WARNING : STRIPE_PRODUCT_SPLIT_SKIPPED_WARNING);
      return null;
    }
    for (const raw of page.data) {
      if (!isObject(raw)) continue;
      const p = raw as Partial<StripeProduct>;
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (typeof p.id === 'string' && name) names.set(p.id, name);
    }
  }
  return names;
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  const { key } = requireKey(input);
  const env: MrrEnv = {
    ctx,
    key,
    now: ctx.now(),
    coupons: new CouponResolver(ctx, key),
    prices: new PriceResolver(ctx, key),
    stats: { tieredUnpriced: 0, unresolvedDiscounts: 0, unpricedItems: 0, inclusiveTaxUnknown: 0, zeroMrrSubscriptions: 0 },
  };

  const mrr: MoneyMap = {};
  const byProduct = new Map<string, { mrr: MoneyMap; subscriptions: number }>();
  let activeSubscriptions = 0;
  let activeTrials = 0;
  for (const status of ['active', 'past_due'] as const) {
    for await (const sub of paginate<StripeSubscription>(
      ctx,
      key,
      '/subscriptions',
      { status, 'expand[]': ['data.discounts', 'data.items.data.discounts'] },
      PERM_SUBSCRIPTIONS,
    )) {
      const items = await subscriptionItems(sub, env);
      activeTrials += items.filter((i) => inTrialOffer(i, env.now)).length; // trial offers count per item
      const currency = typeof sub.currency === 'string' ? sub.currency.toLowerCase() : '';
      const { amount, byProduct: split } = currency
        ? await subscriptionMrr(sub, items, currency, env)
        : { amount: 0, byProduct: new Map<string, number>() };
      // Stripe: "Active subscribers only includes subscribers with positive MRR".
      if (amount > 0) {
        activeSubscriptions += 1;
        addToMoney(mrr, currency, amount);
        for (const [product, part] of split) {
          if (part <= 0) continue;
          const entry = byProduct.get(product) ?? { mrr: {}, subscriptions: 0 };
          addToMoney(entry.mrr, currency, part);
          entry.subscriptions += 1;
          byProduct.set(product, entry);
        }
      } else {
        env.stats.zeroMrrSubscriptions += 1;
      }
    }
  }

  // Legacy trials (trial_end) count once per subscription. A trialing subscription made of free trial
  // offers counts each of them, like Stripe does. The embedded items list is enough for a count.
  for await (const sub of paginate<StripeSubscription>(ctx, key, '/subscriptions', { status: 'trialing' }, PERM_SUBSCRIPTIONS)) {
    activeTrials += Math.max(1, (sub.items?.data ?? []).filter((i) => inTrialOffer(i, env.now)).length);
  }

  const { tieredUnpriced, unresolvedDiscounts, unpricedItems, inclusiveTaxUnknown, zeroMrrSubscriptions } = env.stats;
  if (tieredUnpriced > 0) ctx.log('stripe_tiered_prices_unpriced', { items: tieredUnpriced });
  if (unresolvedDiscounts > 0) ctx.log('stripe_discounts_unresolved', { discounts: unresolvedDiscounts });
  if (unpricedItems > 0) ctx.log('stripe_items_unpriced', { items: unpricedItems });
  if (inclusiveTaxUnknown > 0) ctx.log('stripe_inclusive_tax_unknown', { items: inclusiveTaxUnknown });
  const warnings = new Set<string>();
  // Without Coupons: Read every discount is unresolved; the permission warning says it all.
  if (env.coupons.permissionMissing) warnings.add(STRIPE_COUPONS_WARNING);
  else if (unresolvedDiscounts > 0) warnings.add(stripeDiscountsUnresolvedWarning(unresolvedDiscounts));
  if (tieredUnpriced + unpricedItems > 0) warnings.add(stripeUnpricedItemsWarning(tieredUnpriced + unpricedItems));
  if (inclusiveTaxUnknown > 0) warnings.add(stripeInclusiveTaxWarning(inclusiveTaxUnknown));
  // Names last, so a missing permission or a spent budget can only cost the split, never the MRR.
  const ids = [...byProduct.keys()].filter((id) => id !== '');
  const names = ids.length > 0 ? await productNames(ids, ctx, key, warnings) : new Map<string, string>();
  const mrrByProduct =
    names === null
      ? null
      : [...byProduct].map(([id, p]) => ({ name: names.get(id) ?? null, mrr: p.mrr, subscriptions: p.subscriptions }));

  ctx.log('stripe_snapshot', {
    subscriptions: activeSubscriptions,
    zeroMrr: zeroMrrSubscriptions,
    trials: activeTrials,
    currencies: Object.keys(mrr),
    products: mrrByProduct?.length ?? null,
  });

  return {
    mrr,
    activeSubscriptions,
    activeTrials,
    revenuePeriod: null, // derived from daily_revenue by the sync engine; Stripe has no cheap trailing total
    revenuePeriodDays: null,
    newCustomers: null,
    mrrByProduct,
    ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
  };
}

// ---------- revenue ----------

/**
 * Balance transaction → RevenueEvent. Full `type` list (Balance Transaction object, pinned version):
 * https://docs.stripe.com/api/balance_transactions/object and https://docs.stripe.com/reports/balance-transaction-types
 *
 * Counted. The event type follows the sign of `amount` (money in → 'charge', money out → 'refund'), so
 * gross − refunds nets correctly and the contract's sign rule always holds:
 *   charge, payment                   card / local-method payment (+)
 *   refund, payment_refund            refund (−). Also partial-capture reversals, and a returned
 *                                     payment_refund (+) that undoes a failed refund
 *   payment_failure_refund            delayed-notification payment (ACH, SEPA…) that later failed (−)
 *   payment_reversal                  bank-side reversal of an earlier payment (−)
 *   refund_failure                    card refund failed, funds came back (+)
 *   adjustment, reporting_category ∈ {dispute (−), dispute_reversal (+), refund_failure (+)}
 *                                     chargebacks lost and won, legacy refund failures
 *
 * Ignored (not customer revenue, or not this merchant's):
 *   adjustment (any other category)   Stripe-side corrections, legacy fees
 *   payout, payout_cancel, payout_failure, payout_minimum_balance_hold, payout_minimum_balance_release
 *   transfer, transfer_cancel, transfer_failure, transfer_refund, connect_collection_transfer,
 *   application_fee, application_fee_refund, reserve_transaction     Connect platform flows
 *   stripe_fee, stripe_fx_fee, tax_fee   fees aren't deducted from revenue in v1 (SPEC §6). The per-payment
 *                                        processing fee is still reported on the charge's `fee`.
 *   reserve_hold, reserve_release, reserved_funds, payment_network_reserve_hold,
 *   payment_network_reserve_release, advance, advance_funding, anticipation_repayment,
 *   topup, topup_reversal, inbound_transfer, inbound_transfer_reversal, tax_fund, fee_credit_funding,
 *   stripe_balance_payment_debit, stripe_balance_payment_debit_reversal, obligation_outbound,
 *   obligation_reversal_inbound, payment_unreconciled, climate_order_purchase, climate_order_refund,
 *   contribution, issuing_* (authorization_hold/release, dispute, dispute_provisional_credit(_reversal),
 *   transaction), and any type Stripe adds later.
 *
 * `description` is always null. The balance transaction's description is free text (merchant- or
 * integration-set, often containing customer emails). Since API version 2025-03-31.basil neither a
 * Charge nor a PaymentIntent points to its invoice: the only way from a payment to its products is an
 * Invoice Payment lookup, per payment or by date, which needs Invoices: Read and Charges (balance
 * transaction sources) Read. Both open customer personal data to the key, and a lookup per payment
 * doesn't fit the revenue budget. Stripe's product split is the snapshot's `mrrByProduct` instead.
 */
const REVENUE_TYPES: ReadonlySet<string> = new Set([
  'charge',
  'payment',
  'refund',
  'payment_refund',
  'payment_failure_refund',
  'payment_reversal',
  'refund_failure',
]);
const REVENUE_ADJUSTMENT_CATEGORIES: ReadonlySet<string> = new Set(['dispute', 'dispute_reversal', 'refund_failure']);

function toRevenueEvent(raw: unknown): RevenueEvent | null {
  if (!isObject(raw)) return null;
  const bt = raw as Partial<StripeBalanceTransaction>;
  if (typeof bt.type !== 'string') return null;
  const counted =
    REVENUE_TYPES.has(bt.type) ||
    (bt.type === 'adjustment' && REVENUE_ADJUSTMENT_CATEGORIES.has(bt.reporting_category ?? ''));
  if (!counted) return null;
  const { id, amount: stripeAmount, created, currency } = bt;
  if (typeof id !== 'string' || typeof stripeAmount !== 'number' || !Number.isInteger(stripeAmount)) return null;
  if (typeof created !== 'number' || !Number.isFinite(created) || typeof currency !== 'string') return null;
  const amount = stripeMinor(stripeAmount, currency);
  if (amount === 0) return null;
  return {
    externalId: id,
    occurredAt: created * 1000,
    type: amount > 0 ? 'charge' : 'refund',
    amount,
    currency: normalizeCurrency(currency),
    fee: typeof bt.fee === 'number' && Number.isInteger(bt.fee) ? stripeMinor(bt.fee, currency) : null,
    description: null,
  };
}

/**
 * Resumable traversal state. `gte`/`lte` (epoch seconds) freeze the window when the traversal starts, so
 * transactions created mid-backfill don't shift pages. The next sync's overlap window picks them up.
 * `after` is the last transaction already returned.
 */
interface RevenueCursor {
  v: 1;
  gte: number;
  lte: number;
  after: string | null;
}

function encodeCursor(c: RevenueCursor): string {
  return JSON.stringify(c);
}

function decodeCursor(raw: string): RevenueCursor | null {
  try {
    const c = JSON.parse(raw) as unknown;
    if (!isObject(c) || c['v'] !== 1) return null;
    const { gte, lte, after } = c;
    if (!Number.isInteger(gte) || !Number.isInteger(lte)) return null;
    if (after !== null && (typeof after !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(after))) return null;
    return { v: 1, gte: gte as number, lte: lte as number, after: after as string | null };
  } catch {
    return null;
  }
}

async function fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage> {
  const { key } = requireKey(input);
  let state: RevenueCursor | null = req.cursor ? decodeCursor(req.cursor) : null;
  if (req.cursor && !state) ctx.log('stripe_cursor_invalid', { action: 'restart' }); // idempotent upserts make a restart safe
  if (!state) {
    if (!Number.isFinite(req.since)) throw new ProviderError('invalid_input', 'Invalid revenue start time.');
    state = { v: 1, gte: Math.floor(req.since / 1000), lte: Math.floor(ctx.now() / 1000), after: null };
  }

  const events: RevenueEvent[] = [];
  const ignored: Record<string, number> = {};
  let pages = 0;
  for (;;) {
    if (!hasBudget(ctx)) {
      ctx.log('stripe_revenue_paused', { pages, events: events.length });
      return { events, daily: [], nextCursor: encodeCursor(state), done: false };
    }
    const body: unknown = await stripeGet<unknown>(
      ctx,
      key,
      '/balance_transactions',
      { 'created[gte]': state.gte, 'created[lte]': state.lte, limit: PAGE_SIZE, starting_after: state.after },
      PERM_BALANCE,
    );
    const page: StripeList<unknown> = asList<unknown>(body);
    pages += 1;
    for (const bt of page.data) {
      const ev = toRevenueEvent(bt);
      if (ev) events.push(ev);
      else {
        const t = isObject(bt) && typeof bt['type'] === 'string' ? bt['type'] : 'unknown';
        ignored[t] = (ignored[t] ?? 0) + 1;
      }
    }
    const last: unknown = page.data[page.data.length - 1];
    if (!page.has_more || last === undefined) break;
    if (!isObject(last) || typeof last['id'] !== 'string') throw unreadable(); // would re-read page 1 forever
    state = { ...state, after: last['id'] };
  }
  ctx.log('stripe_revenue_done', { pages, events: events.length, ignored });
  return { events, daily: [], nextCursor: null, done: true };
}

// ---------- verify ----------

async function verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult> {
  const parsed = parseKey(input.credentials['apiKey']);
  if ('error' in parsed) return { ok: false, error: parsed.error, field: 'apiKey' };
  const { key, restricted, testMode } = parsed;
  const warnings = restricted ? [] : [SECRET_KEY_WARNING];
  try {
    // One cheap read per permission in the registry checklist; a 403 names the missing one.
    await stripeGet(ctx, key, '/subscriptions', { limit: 1 }, PERM_SUBSCRIPTIONS);
    await stripeGet(ctx, key, '/prices', { limit: 1 }, PERM_PRICES);
    await stripeGet(ctx, key, '/balance_transactions', { limit: 1 }, PERM_BALANCE);
    // Coupons and products are optional (SPEC §6.1): without them MRR is shown before discounts, or
    // isn't split by product, so only warn.
    try {
      await stripeGet(ctx, key, '/coupons', { limit: 1 }, PERM_COUPONS);
    } catch (err) {
      if (!(err instanceof ProviderError && err.kind === 'permission')) throw err;
      warnings.push(STRIPE_COUPONS_WARNING);
    }
    try {
      await stripeGet(ctx, key, '/products', { limit: 1 }, PERM_PRODUCTS);
    } catch (err) {
      if (!(err instanceof ProviderError && err.kind === 'permission')) throw err;
      warnings.push(STRIPE_PRODUCTS_WARNING);
    }
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') {
      return {
        ok: false,
        error: 'Stripe rejected this key. Check that you copied all of it and that it hasn’t been deleted or expired.',
        field: 'apiKey',
      };
    }
    if (err instanceof ProviderError && err.kind === 'permission') {
      return { ok: false, error: err.message, field: 'apiKey' };
    }
    throw err; // rate limit / upstream: transient, described by the caller
  }
  return {
    ok: true,
    // The account name needs GET /v1/account (an extra permission). The mode is enough to tell keys apart.
    accountLabel: testMode ? 'Stripe (test mode)' : 'Stripe (live)',
    config: {},
    testMode,
    warnings,
  };
}

export const stripeAdapter: ProviderAdapter = {
  id: 'stripe',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
