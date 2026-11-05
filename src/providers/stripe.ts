/**
 * Stripe adapter. Owner: Data Plane. SPEC.md §6.1.
 *
 * Every request pins `Stripe-Version: 2026-10-28.endive` (latest GA version in the API reference on
 * 2026-11-05) so response shapes don't drift with each account's default version. Shapes this file
 * relies on in that version (https://docs.stripe.com/api):
 *   - Subscription.discounts and SubscriptionItem.discounts are arrays of discount IDs, expandable into
 *     Discount objects. The legacy singular `discount` field is gone.
 *   - Discount.source.coupon is a coupon ID (expandable). The legacy embedded `Discount.coupon` is gone.
 *   - Coupon.applies_to and Coupon.currency_options, and Price.currency_options, are "includable"
 *     (returned only when expanded).
 *   - current_period_start/end live on subscription items. MRR doesn't need them.
 *   - SubscriptionItem.current_trial marks item-level trials (trial offers), which are excluded from MRR
 *     the way Stripe's own Billing analytics excludes them.
 *
 * Request plan:
 *   verify        3 requests: subscriptions, prices, balance_transactions (limit=1 each). 403s name the
 *                 missing registry permission.
 *   fetchSnapshot status=active and status=past_due (limit=100, expand[]=data.discounts and
 *                 data.items.data.discounts), then status=trialing (count only). It also makes one
 *                 cached lookup per distinct coupon in an active discount, and per multi-currency price
 *                 whose default currency differs from the subscription's.
 *                 Running out of budget throws BudgetExhaustedError: a partial MRR would be wrong.
 *   fetchRevenue  balance_transactions newest to oldest between a fixed [since, startedAt] window, resumable.
 *
 * Amount units: Stripe's integers match ISO 4217 minor units (hoomuch's `currencyExponent`) except for MGA,
 * ISK and UGX, which `fromStripeAmount` converts. Every amount read from Stripe goes through it.
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

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';
export const STRIPE_API_VERSION = '2026-10-28.endive';

const PROVIDER = 'Stripe';
const PAGE_SIZE = 100;

// Registry wording (registry.ts → permissions), used verbatim in 403 messages.
const PERM_SUBSCRIPTIONS = 'Subscriptions: Read';
const PERM_PRICES = 'Products & Prices: Read';
const PERM_BALANCE = 'Balance: Read';
// Not in the registry list (yet): coupon details sit behind their own RAK permission. Missing it
// degrades MRR to "before discounts" instead of failing the sync. See `CouponResolver`.
const PERM_COUPONS = 'Coupons: Read';

export const SECRET_KEY_WARNING =
  'This is a full-access secret key. A restricted key (rk_…) with read access is safer. You can replace the key on this page.';

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

interface StripeAmounts {
  unit_amount: number | null;
  unit_amount_decimal: string | null;
}

interface StripePrice extends StripeAmounts {
  id: string;
  currency: string;
  billing_scheme: string;
  product: string | { id: string } | null;
  recurring: StripeRecurring | null;
  transform_quantity: { divide_by: number; round: string } | null;
  currency_options?: Record<string, StripeAmounts> | null;
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
}

interface StripeSubscription {
  id: string;
  currency: string;
  discounts?: DiscountRef[] | null;
  items: { data: StripeSubscriptionItem[]; has_more: boolean };
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

/** One licensed subscription item, normalized to a monthly amount (minor units, fractional while discounting). */
interface Line {
  product: string | null;
  monthly: number;
  interval: BillingInterval;
  count: number;
}

interface SnapshotStats {
  tieredItems: number;
  unresolvedDiscounts: number;
  unpricedItems: number;
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
  private permissionMissing = false;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly key: string,
  ) {}

  async get(ref: string | StripeCoupon | null | undefined): Promise<StripeCoupon | null> {
    if (!ref) return null;
    if (typeof ref !== 'string') return ref;
    if (this.cache.has(ref)) return this.cache.get(ref) ?? null;
    if (this.permissionMissing) return null;
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
        this.permissionMissing = true;
        this.ctx.log('stripe_coupon_permission_missing', { effect: 'mrr_before_discounts' });
        return null;
      }
      if (err.kind !== 'not_found') throw err; // budget, rate limit, 5xx: fail the snapshot
      this.cache.set(ref, null); // deleted coupon: its discount still applies, but we can't read it
    }
    return this.cache.get(ref) ?? null;
  }
}

/** Per-run cache of prices re-read with currency_options (multi-currency prices). */
class PriceResolver {
  private readonly cache = new Map<string, StripePrice>();

  constructor(
    private readonly ctx: ProviderContext,
    private readonly key: string,
  ) {}

  async get(id: string): Promise<StripePrice> {
    let price = this.cache.get(id);
    if (!price) {
      price = await stripeGet<StripePrice>(
        this.ctx,
        this.key,
        `/prices/${encodeURIComponent(id)}`,
        { 'expand[]': ['currency_options'] },
        PERM_PRICES,
      );
      if (!isObject(price)) throw unreadable();
      this.cache.set(id, price);
    }
    return price;
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

function amountOf(a: StripeAmounts | null | undefined): number | null {
  if (!a) return null;
  if (typeof a.unit_amount === 'number' && Number.isFinite(a.unit_amount)) return a.unit_amount;
  if (typeof a.unit_amount_decimal === 'string') {
    const n = Number(a.unit_amount_decimal);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Unit amount in the subscription's currency (lowercase), in Stripe's units, or null if it can't be determined. */
async function unitAmountIn(price: StripePrice, currency: string, env: MrrEnv): Promise<number | null> {
  if (price.currency?.toLowerCase() === currency) return amountOf(price);
  // Multi-currency price: the embedded object carries the default currency only.
  const full = await env.prices.get(price.id);
  return amountOf(full.currency_options?.[currency]);
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

async function itemLine(item: StripeSubscriptionItem, currency: string, env: MrrEnv): Promise<Line | null> {
  const price = item.price;
  const rec = price?.recurring;
  if (!price || !rec) return null;
  if (rec.usage_type === 'metered') return null; // usage-based: not recurring revenue (SPEC §6.1)
  if (item.current_trial && item.current_trial.end_date * 1000 > env.now) return null; // item-level trial
  if (price.billing_scheme === 'tiered') {
    env.stats.tieredItems += 1; // tiers aren't in the list payload (5-level expand); counted as 0
    return null;
  }
  const interval = rec.interval as BillingInterval;
  if (!INTERVALS.includes(interval)) {
    env.stats.unpricedItems += 1;
    return null;
  }
  const unit = await unitAmountIn(price, currency, env);
  if (unit === null) {
    env.stats.unpricedItems += 1;
    return null;
  }
  const count = rec.interval_count > 0 ? rec.interval_count : 1;
  // Stripe bills round(unit × quantity) per period in its own units; convert that invoice line to
  // minor units (fractional for ISK/UGX until normalizeToMonthly rounds) and normalize it to a month.
  const billed = Math.round(unit * billedQuantity(item.quantity ?? 1, price.transform_quantity));
  const perPeriod = fromStripeAmount(billed, currency);
  return { product: productId(price.product), monthly: normalizeToMonthly(perPeriod, interval, count), interval, count };
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

/** Monthly recurring amount of one subscription (rounded minor units), item discounts first, then subscription discounts. */
async function subscriptionMrr(sub: StripeSubscription, currency: string, env: MrrEnv): Promise<number> {
  const lines: Line[] = [];
  for (const item of await subscriptionItems(sub, env)) {
    const line = await itemLine(item, currency, env);
    if (!line) continue;
    await applyDiscounts([line], item.discounts, currency, env);
    lines.push(line);
  }
  await applyDiscounts(lines, sub.discounts, currency, env);
  return Math.round(lines.reduce((s, l) => s + Math.max(0, l.monthly), 0));
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  const { key } = requireKey(input);
  const env: MrrEnv = {
    ctx,
    key,
    now: ctx.now(),
    coupons: new CouponResolver(ctx, key),
    prices: new PriceResolver(ctx, key),
    stats: { tieredItems: 0, unresolvedDiscounts: 0, unpricedItems: 0 },
  };

  const mrr: MoneyMap = {};
  // SPEC §6: active + past_due, regardless of their MRR (metered/tiered-only subscriptions still count).
  let activeSubscriptions = 0;
  for (const status of ['active', 'past_due'] as const) {
    for await (const sub of paginate<StripeSubscription>(
      ctx,
      key,
      '/subscriptions',
      { status, 'expand[]': ['data.discounts', 'data.items.data.discounts'] },
      PERM_SUBSCRIPTIONS,
    )) {
      activeSubscriptions += 1;
      if (typeof sub.currency !== 'string' || !sub.currency) continue;
      const currency = sub.currency.toLowerCase();
      const amount = await subscriptionMrr(sub, currency, env);
      if (amount !== 0) addToMoney(mrr, currency, amount);
    }
  }

  let activeTrials = 0;
  for await (const _ of paginate<StripeSubscription>(ctx, key, '/subscriptions', { status: 'trialing' }, PERM_SUBSCRIPTIONS)) {
    activeTrials += 1;
  }

  const { tieredItems, unresolvedDiscounts, unpricedItems } = env.stats;
  if (tieredItems > 0) ctx.log('stripe_tiered_prices_excluded', { items: tieredItems });
  if (unresolvedDiscounts > 0) ctx.log('stripe_discounts_unresolved', { discounts: unresolvedDiscounts });
  if (unpricedItems > 0) ctx.log('stripe_items_unpriced', { items: unpricedItems });
  ctx.log('stripe_snapshot', { subscriptions: activeSubscriptions, trials: activeTrials, currencies: Object.keys(mrr) });

  return {
    mrr,
    activeSubscriptions,
    activeTrials,
    revenuePeriod: null, // derived from daily_revenue by the sync engine; Stripe has no cheap trailing total
    revenuePeriodDays: null,
    newCustomers: null,
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
 * integration-set, often containing customer emails), and a product name is several expansions away
 * (source → invoice → lines → price → product) behind permissions we don't hold.
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
  try {
    // One cheap read per permission in the registry checklist; a 403 names the missing one.
    await stripeGet(ctx, key, '/subscriptions', { limit: 1 }, PERM_SUBSCRIPTIONS);
    await stripeGet(ctx, key, '/prices', { limit: 1 }, PERM_PRICES);
    await stripeGet(ctx, key, '/balance_transactions', { limit: 1 }, PERM_BALANCE);
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
    warnings: restricted ? [] : [SECRET_KEY_WARNING],
  };
}

export const stripeAdapter: ProviderAdapter = {
  id: 'stripe',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
