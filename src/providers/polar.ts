/**
 * Polar adapter (polar.sh). Owner: Data Plane. SPEC.md §6.6.
 *
 * Core API v1, https://polar.sh/docs/api-reference. Every request pins `Polar-Version: 2026-10`, the Current
 * version on 2026-11-05. Polar keeps three versions (Next, Current, Deprecated), ships a new one in the first
 * week of January, April, July and October, and removes the Deprecated one at each release: a removed version
 * answers 404. 2026-10 turns Deprecated in January 2027 and is removed in early April 2027, so
 * POLAR_API_VERSION has to move before then. Every field below is unchanged in 2027-01 (Next).
 *
 * Facts this file relies on (OpenAPI 2026-10 at polar.sh/docs/openapi/2026-10.openapi.json, plus Polar's
 * open-source server, github.com/polarsource/polar, for behaviour the reference doesn't spell out):
 *  - Hosts: https://api.polar.sh/v1 and https://sandbox-api.polar.sh/v1, fully isolated. Organization access
 *    tokens look like `polar_oat_…` in both, belong to ONE organization and only work on the host that issued
 *    them, so the token can't tell sandbox from production. verify asks production first, then the sandbox on a
 *    401, and stores the answer in config.environment.
 *  - Errors: 401 `invalid_token` (malformed, expired or revoked token); 403 `insufficient_scope` when the token
 *    lacks the endpoint's scope. Paths end with "/" (FastAPI); we never follow redirects.
 *  - Lists: `page` (from 1) + `limit` (≤ 100), `pagination: {total_count, max_page}`. Rate limit: 500
 *    requests/min per organization (sandbox 100); a 429 carries Retry-After.
 *  - Money: integer cents of the record's lowercase ISO currency.
 *  - Metrics (`GET /v1/metrics/`, metrics:read): `monthly_recurring_revenue` is Polar's dashboard MRR: each
 *    ongoing subscription's net amount (after discounts, net of tax-inclusive VAT), monthly-normalized, trials
 *    excluded, past_due, paused and cancel-at-period-end included, converted to USD (the settlement currency)
 *    at Polar's recorded exchange rates. Its `active_subscriptions` also counts trials and $0 subscriptions, so
 *    it isn't used. `metrics=<slug>` limits the work to the slugs asked for.
 *  - Subscriptions: `amount` is after discounts but INCLUDES tax for tax-inclusive prices, and Polar's default
 *    "location-based" tax behaviour makes prices tax-inclusive everywhere except the US, Canada and India. The
 *    net-of-tax amount isn't exposed, which is why MRR comes from metrics, not from this list.
 *    `status` (repeatable): incomplete, incomplete_expired, trialing, active, past_due, canceled, unpaid,
 *    paused. (`active=true` means trialing + active, so it isn't used.) Sortable by `amount`.
 *  - Orders: `created_after` / `created_before` (both exclusive), sortable by `created_at`. net_amount =
 *    subtotal − discount, before tax. applied_balance_amount is customer balance used on the order (negative
 *    when a credit paid part of it); Polar's own refundable base is net_amount + applied_balance_amount.
 *    status draft | pending | paid | refunded | partially_refunded | void. A renewal whose charge fails stays
 *    `pending` and is retried for up to 21 days, so an order can be paid long after its created_at.
 *  - Refunds: no date filter, sortable by `created_at`. `amount` is before tax (`tax_amount` is separate; a
 *    tax-only refund has amount 0). status pending | succeeded | failed | canceled. Lost disputes are refunds too.
 *
 * Decisions (SPEC §6.6 refines these):
 *  - Merchant of record: revenue EXCLUDES tax. A charge is net_amount + applied_balance_amount (before tax,
 *    minus any customer credit used: the base Polar refunds against, so a full refund nets to zero); a refund
 *    is `amount`.
 *  - MRR: Polar's metric, labelled USD (tax-exclusive, as SPEC §6 requires of every provider). It includes
 *    paused subscriptions (Polar's definition); they can't be taken out without their net amounts. Active
 *    subscriptions = active + past_due with amount > 0, as for Stripe: free, 100%-discounted and metered-only
 *    subscriptions don't count. Trials = trialing.
 *  - Revenue window: orders created in [since − 30 days, startedAt] (late-paid renewals, see dunning above) and
 *    refunds created ≥ since − 30 days (refunds that were still pending last time). Re-emitting a known
 *    event is a no-op upsert.
 *  - PII: subscriptions, orders and refunds embed the customer (email, name, billing address). Only ids,
 *    amounts, currencies, times and the product name are read; nothing else is kept or logged.
 *
 * Request plan:
 *   verify        subscriptions (limit=1) on production, then on the sandbox if production says 401; then
 *                 metrics (today), orders (limit=1) and refunds (limit=1) on that host: 4 requests, 5 for a
 *                 sandbox token. Each scope is touched once, so a 403 names the missing one.
 *   fetchSnapshot metrics (today, MRR only); subscriptions status=active+past_due sorted by amount, paging only
 *                 while pages hold $0 subscriptions; subscriptions status=trialing (limit=1, total_count only).
 *                 Usually 3 requests. Running out of budget throws BudgetExhaustedError: a partial count is wrong.
 *   fetchRevenue  orders in a window frozen at the first call, oldest first (stable pages), then refunds newest
 *                 first down to since − 30 days. Resumable: on budget exhaustion and on a 429 it returns what
 *                 it read plus a cursor.
 */

import { normalizeCurrency, type MoneyMap } from '../lib/money';
import { DAY, dayKey } from '../lib/time';
import { buildUrl, fetchJson, hasBudget, RateLimitedError, type QueryValue, type RequestSpec } from './http';
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

const PROVIDER = 'Polar';
export const POLAR_API_BASE = 'https://api.polar.sh/v1';
export const POLAR_SANDBOX_API_BASE = 'https://sandbox-api.polar.sh/v1';
export const POLAR_API_VERSION = '2026-10';

/** List maximum. */
const PAGE_SIZE = 100;
/**
 * How far before `since` orders and refunds are re-read. Covers Polar's 21-day dunning (a renewal paid on its
 * last retry) plus slack, and refunds that were still pending on the previous sync.
 */
export const REVENUE_LOOKBACK_MS = 30 * DAY;

// Scope names exactly as Polar's token form lists them; the registry checklist and 403 messages use them too.
export const SCOPE_METRICS = 'metrics:read';
export const SCOPE_SUBSCRIPTIONS = 'subscriptions:read';
export const SCOPE_ORDERS = 'orders:read';
export const SCOPE_REFUNDS = 'refunds:read';

/** Config key written by verify: 'production' | 'sandbox'. */
export const CONFIG_ENVIRONMENT = 'environment';

const MRR_METRIC = 'monthly_recurring_revenue';
/** Polar's metrics are converted to the settlement currency, which is USD for every organization today. */
const METRICS_CURRENCY = 'USD';
const PAYING_STATUSES = ['active', 'past_due'] as const;
const CHARGED_ORDER_STATUSES = ['paid', 'refunded', 'partially_refunded'] as const;

const AUTH_MESSAGE =
  'Polar rejected the access token. It may have expired or been revoked: create a new organization access token and paste it here.';
const VERIFY_AUTH_MESSAGE =
  'Polar rejected this token in production and in the sandbox. Check that you copied all of it and that it hasn’t expired or been revoked.';
export const VERSION_GONE_MESSAGE =
  `Polar no longer accepts API version ${POLAR_API_VERSION}, which this version of hoomuch uses. Update hoomuch to keep syncing.`;

// ---------- token + environment ----------

export type PolarEnvironment = 'production' | 'sandbox';

const BASES: Record<PolarEnvironment, string> = { production: POLAR_API_BASE, sandbox: POLAR_SANDBOX_API_BASE };

/** Organization access tokens only. Rejecting anything else also keeps stray characters out of the header. */
const OAT_RE = /^polar_oat_[A-Za-z0-9_-]{20,200}$/;

function parseToken(raw: string | undefined): { token: string } | { error: string } {
  const token = (raw ?? '').trim();
  if (!token) return { error: 'Paste a Polar organization access token (polar_oat_…).' };
  if (OAT_RE.test(token)) return { token };
  if (/^polar_pat_/.test(token)) {
    return {
      error:
        'That’s a personal access token (polar_pat_…). hoomuch needs an organization access token (polar_oat_…) from your organization’s Settings → Access Tokens.',
    };
  }
  if (/^polar_oat_/.test(token)) {
    return { error: 'That organization access token looks incomplete. Copy it again; it’s shown only once, so you may need a new one.' };
  }
  if (/^polar_/.test(token)) {
    return { error: 'That isn’t an organization access token. hoomuch needs one that starts with polar_oat_.' };
  }
  return { error: 'That doesn’t look like a Polar organization access token. It should start with polar_oat_.' };
}

function environmentOf(config: ConnectionConfig): PolarEnvironment {
  return (config[CONFIG_ENVIRONMENT] ?? '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
}

interface Conn {
  token: string;
  environment: PolarEnvironment;
}

function requireConn(input: ConnectionInput): Conn {
  const parsed = parseToken(input.credentials['apiKey']);
  if ('error' in parsed) throw new ProviderError('invalid_input', parsed.error, { field: 'apiKey' });
  return { token: parsed.token, environment: environmentOf(input.config) };
}

// ---------- HTTP ----------

function mapPolarError(status: number): ProviderError | null {
  if (status === 401) return new ProviderError('auth', AUTH_MESSAGE, { status, field: 'apiKey' });
  // Every endpoint used here is a list or a report, so a 404 means the pinned version is gone.
  if (status === 404) return new ProviderError('upstream', VERSION_GONE_MESSAGE, { status });
  return null;
}

function polarGet(
  ctx: ProviderContext,
  conn: Conn,
  path: string,
  query: Record<string, QueryValue>,
  permission: string,
  extra: Partial<RequestSpec> = {},
): Promise<unknown> {
  return fetchJson<unknown>(ctx, {
    provider: PROVIDER,
    url: buildUrl(BASES[conn.environment], path, query),
    headers: { Authorization: `Bearer ${conn.token}`, 'Polar-Version': POLAR_API_VERSION },
    permission,
    mapError: mapPolarError,
    ...extra,
  });
}

// ---------- payload readers (the API is untyped JSON; never trust shapes) ----------

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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

function nonNegInt(v: unknown): number | null {
  const n = int(v);
  return n !== null && n >= 0 ? n : null;
}

/** ISO 8601 with microseconds, e.g. "2026-11-02T15:04:05.123456Z" → epoch ms. */
function time(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function currencyOf(v: unknown): string | null {
  const c = typeof v === 'string' ? normalizeCurrency(v) : '';
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function badPayload(ctx: ProviderContext, path: string): ProviderError {
  ctx.log('polar_bad_payload', { path });
  return new ProviderError('upstream', `${PROVIDER} returned a response hoomuch couldn’t read.`);
}

interface ListPage {
  items: unknown[];
  totalCount: number | null;
  maxPage: number | null;
}

function parseList(ctx: ProviderContext, path: string, body: unknown): ListPage {
  if (!isObject(body) || !Array.isArray(body['items'])) throw badPayload(ctx, path);
  const p = isObject(body['pagination']) ? body['pagination'] : {};
  return { items: body['items'], totalCount: nonNegInt(p['total_count']), maxPage: nonNegInt(p['max_page']) };
}

function isLastPage(list: ListPage, page: number): boolean {
  return list.items.length < PAGE_SIZE || (list.maxPage !== null && page >= list.maxPage);
}

// ---------- snapshot ----------

function metricsQuery(day: string): Record<string, QueryValue> {
  return { start_date: day, end_date: day, interval: 'day', timezone: 'UTC', metrics: MRR_METRIC };
}

/** MRR in cents from a metrics response (the last period, else the totals), or null when it isn't there. */
export function readMrr(body: unknown): number | null {
  if (!isObject(body)) return null;
  const periods = Array.isArray(body['periods']) ? body['periods'] : [];
  const last: unknown = periods[periods.length - 1];
  let v = isObject(last) ? num(last[MRR_METRIC]) : null;
  if (v === null && isObject(body['totals'])) v = num(body['totals'][MRR_METRIC]);
  return v === null ? null : Math.max(0, Math.round(v));
}

/**
 * active + past_due subscriptions minus the $0 ones. The list is sorted by amount, so the $0 ones come first and
 * paging stops at the first page that reaches a paying one. `started_at` breaks ties so pages don't overlap.
 */
async function countPaying(ctx: ProviderContext, conn: Conn): Promise<{ active: number; free: number; pages: number }> {
  const path = '/subscriptions/';
  let total: number | null = null;
  let free = 0;
  let pages = 0;
  for (let page = 1; ; page++) {
    const list = parseList(
      ctx,
      path,
      await polarGet(
        ctx,
        conn,
        path,
        { status: [...PAYING_STATUSES], sorting: ['amount', 'started_at'], limit: PAGE_SIZE, page },
        SCOPE_SUBSCRIPTIONS,
      ),
    );
    pages += 1;
    if (total === null) total = list.totalCount;
    let reachedPaid = false;
    for (const raw of list.items) {
      const amount = isObject(raw) ? int(raw['amount']) : null;
      if (amount === null) continue; // unreadable: left in the count
      if (amount > 0) reachedPaid = true;
      else free += 1;
    }
    if (reachedPaid || isLastPage(list, page)) break;
  }
  if (total === null) throw badPayload(ctx, path);
  return { active: Math.max(0, total - free), free, pages };
}

async function fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot> {
  const conn = requireConn(input);

  const metrics = await polarGet(ctx, conn, '/metrics/', metricsQuery(dayKey(ctx.now())), SCOPE_METRICS);
  const mrrCents = readMrr(metrics);
  if (mrrCents === null) throw badPayload(ctx, '/metrics/'); // never write a zero MRR for a payload we can't read

  const paying = await countPaying(ctx, conn);

  const trialing = parseList(
    ctx,
    '/subscriptions/',
    await polarGet(ctx, conn, '/subscriptions/', { status: 'trialing', limit: 1 }, SCOPE_SUBSCRIPTIONS),
  );
  if (trialing.totalCount === null) throw badPayload(ctx, '/subscriptions/');

  const mrr: MoneyMap = mrrCents > 0 ? { [METRICS_CURRENCY]: mrrCents } : {};
  ctx.log('polar_snapshot', {
    environment: conn.environment,
    subscriptions: paying.active,
    free: paying.free,
    trials: trialing.totalCount,
    pages: paying.pages,
  });
  return {
    mrr,
    activeSubscriptions: paying.active,
    activeTrials: trialing.totalCount,
    revenuePeriod: null, // Polar's `revenue` metric is gross of refunds; the engine derives this from daily_revenue
    revenuePeriodDays: null,
    newCustomers: null,
  };
}

// ---------- revenue ----------

const CHARGED: ReadonlySet<string> = new Set(CHARGED_ORDER_STATUSES);

/** Product name (merchant-defined, never customer data), capped. */
function describe(order: Obj): string | null {
  const product = isObject(order['product']) ? str(order['product']['name']) : null;
  const name = (product ?? str(order['description']) ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.length > 120 ? name.slice(0, 119) + '…' : name;
}

/** A paid order → charge (pre-tax, net of discounts and of customer balance used), else null. */
export function orderToCharge(raw: unknown): RevenueEvent | null {
  if (!isObject(raw)) return null;
  const id = str(raw['id']);
  const created = time(raw['created_at']);
  const currency = currencyOf(raw['currency']);
  if (!id || created === null || !currency || !CHARGED.has(str(raw['status']) ?? '')) return null;
  const net = int(raw['net_amount']);
  if (net === null) return null;
  const amount = Math.max(0, net + (int(raw['applied_balance_amount']) ?? 0));
  if (amount <= 0) return null;
  const fee = nonNegInt(raw['platform_fee_amount']);
  return {
    externalId: `order:${id}`,
    occurredAt: created,
    type: 'charge',
    amount,
    currency,
    // The platform fee is reported in the settlement currency; keep it only when that is the order's.
    fee: fee !== null && currencyOf(raw['platform_fee_currency']) === currency ? fee : null,
    description: describe(raw),
  };
}

/** A succeeded refund → negative, pre-tax refund event, else null. */
export function refundToEvent(raw: unknown, descriptions: ReadonlyMap<string, string>): RevenueEvent | null {
  if (!isObject(raw) || str(raw['status']) !== 'succeeded') return null;
  const id = str(raw['id']);
  const created = time(raw['created_at']);
  const currency = currencyOf(raw['currency']);
  const amount = int(raw['amount']);
  if (!id || created === null || !currency || amount === null || amount <= 0) return null;
  const orderId = str(raw['order_id']);
  return {
    externalId: `refund:${id}`,
    occurredAt: created,
    type: 'refund',
    amount: -amount,
    currency,
    fee: null,
    description: (orderId && descriptions.get(orderId)) || null,
  };
}

type Phase = 'orders' | 'refunds';

/**
 * Resumable traversal state. `since` and `until` freeze the window at the first call, so orders created
 * mid-backfill don't shift the (oldest-first) order pages; the next sync's overlap picks them up. Refunds are
 * newest first with no date filter, so `total` (total_count when `page` was computed) re-anchors the page
 * when refunds arrive between two calls.
 */
interface RevenueCursor {
  v: 1;
  since: number;
  until: number;
  phase: Phase;
  page: number;
  total: number | null;
}

export function encodeCursor(c: RevenueCursor): string {
  return JSON.stringify(c);
}

export function decodeCursor(raw: string | null): RevenueCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as unknown;
    if (
      isObject(c) &&
      c['v'] === 1 &&
      typeof c['since'] === 'number' &&
      Number.isFinite(c['since']) &&
      typeof c['until'] === 'number' &&
      Number.isFinite(c['until']) &&
      c['until'] >= c['since'] &&
      (c['phase'] === 'orders' || c['phase'] === 'refunds') &&
      Number.isInteger(c['page']) &&
      (c['page'] as number) >= 1 &&
      (c['total'] === null || (Number.isInteger(c['total']) && (c['total'] as number) >= 0))
    ) {
      return {
        v: 1,
        since: c['since'],
        until: c['until'],
        phase: c['phase'],
        page: c['page'] as number,
        total: c['total'] as number | null,
      };
    }
  } catch {
    // invalid → restart
  }
  return null;
}

/**
 * Next refunds page after reading `page`, given that the newest-first list grew by `delta` since `page` was
 * computed. Growth only pushes unread refunds later (never skipped, at most re-read); a jump of ≥ one page
 * skips the re-reads. A shrink (not expected: refunds aren't deleted) steps back so nothing is skipped.
 */
export function nextRefundPage(page: number, delta: number): number {
  if (delta >= 0) return page + Math.max(1, Math.floor(delta / PAGE_SIZE));
  return Math.max(1, page + Math.floor(delta / PAGE_SIZE));
}

async function fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage> {
  const conn = requireConn(input);
  let cur = decodeCursor(req.cursor);
  if (req.cursor && !cur) ctx.log('polar_cursor_invalid', { action: 'restart' }); // idempotent upserts make a restart safe
  if (!cur) {
    if (!Number.isFinite(req.since)) throw new ProviderError('invalid_input', 'Invalid revenue start time.');
    cur = { v: 1, since: req.since, until: Math.max(req.since, ctx.now()), phase: 'orders', page: 1, total: null };
  }
  const floor = cur.since - REVENUE_LOOKBACK_MS;

  const events = new Map<string, RevenueEvent>();
  const descriptions = new Map<string, string>();
  const stats = { pages: 0, orders: 0, refunds: 0, lookback: 0 };
  const finish = (next: RevenueCursor | null, reason: string): RevenuePage => {
    ctx.log('polar_revenue', { ...stats, events: events.size, phase: cur!.phase, page: cur!.page, done: next === null, reason });
    return { events: [...events.values()], daily: [], nextCursor: next ? encodeCursor(next) : null, done: next === null };
  };
  const add = (e: RevenueEvent | null): void => {
    if (!e) return;
    events.set(e.externalId, e);
    if (e.occurredAt < cur!.since) stats.lookback += 1;
  };

  try {
    for (;;) {
      if (!hasBudget(ctx)) return finish(cur, 'budget');

      if (cur.phase === 'orders') {
        const path = '/orders/';
        const list = parseList(
          ctx,
          path,
          await polarGet(
            ctx,
            conn,
            path,
            {
              created_after: iso(floor - 1),
              created_before: iso(cur.until + 1),
              status: [...CHARGED_ORDER_STATUSES],
              sorting: 'created_at',
              limit: PAGE_SIZE,
              page: cur.page,
            },
            SCOPE_ORDERS,
            { rateLimit: 'yield' },
          ),
        );
        stats.pages += 1;
        for (const raw of list.items) {
          const charge = orderToCharge(raw);
          if (!charge) continue;
          stats.orders += 1;
          add(charge);
          if (charge.description) descriptions.set(charge.externalId.slice('order:'.length), charge.description);
        }
        cur = isLastPage(list, cur.page)
          ? { ...cur, phase: 'refunds', page: 1, total: null }
          : { ...cur, page: cur.page + 1, total: list.totalCount };
        continue;
      }

      const path = '/refunds/';
      const list = parseList(
        ctx,
        path,
        await polarGet(
          ctx,
          conn,
          path,
          { sorting: '-created_at', limit: PAGE_SIZE, page: cur.page },
          SCOPE_REFUNDS,
          { rateLimit: 'yield' },
        ),
      );
      stats.pages += 1;
      let reachedFloor = false;
      for (const raw of list.items) {
        const created = isObject(raw) ? time(raw['created_at']) : null;
        if (created !== null && created < floor) {
          reachedFloor = true; // newest first: everything after this is older still
          continue;
        }
        const refund = refundToEvent(raw, descriptions);
        if (refund) {
          stats.refunds += 1;
          add(refund);
        }
      }
      if (reachedFloor || isLastPage(list, cur.page)) return finish(null, 'done');
      const delta: number = cur.total !== null && list.totalCount !== null ? list.totalCount - cur.total : 0;
      if (delta !== 0) ctx.log('polar_refund_drift', { page: cur.page, delta });
      cur = { ...cur, page: nextRefundPage(cur.page, delta), total: list.totalCount };
    }
  } catch (err) {
    // A 429 empties the budget: keep what was read and resume from the page that was refused.
    if (err instanceof RateLimitedError) return finish(cur, 'rate_limited');
    throw err;
  }
}

// ---------- verify ----------

/** Which host issued the token: production, or the sandbox when production says 401. */
async function detectEnvironment(ctx: ProviderContext, token: string): Promise<PolarEnvironment> {
  for (const environment of ['production', 'sandbox'] as const) {
    try {
      await polarGet(ctx, { token, environment }, '/subscriptions/', { limit: 1 }, SCOPE_SUBSCRIPTIONS);
      return environment;
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== 'auth' || environment === 'sandbox') throw err;
    }
  }
  throw new ProviderError('auth', VERIFY_AUTH_MESSAGE); // unreachable: the sandbox attempt returns or throws
}

async function verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult> {
  const parsed = parseToken(input.credentials['apiKey']);
  if ('error' in parsed) return { ok: false, error: parsed.error, field: 'apiKey' };
  let environment: PolarEnvironment;
  try {
    // One cheap read per scope in the registry checklist; a 403 names the missing one.
    environment = await detectEnvironment(ctx, parsed.token);
    const conn: Conn = { token: parsed.token, environment };
    await polarGet(ctx, conn, '/metrics/', metricsQuery(dayKey(ctx.now())), SCOPE_METRICS);
    await polarGet(ctx, conn, '/orders/', { limit: 1 }, SCOPE_ORDERS);
    await polarGet(ctx, conn, '/refunds/', { limit: 1 }, SCOPE_REFUNDS);
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') return { ok: false, error: VERIFY_AUTH_MESSAGE, field: 'apiKey' };
    if (err instanceof ProviderError && err.kind === 'permission') return { ok: false, error: err.message, field: 'apiKey' };
    throw err; // rate limit / upstream: transient, described by the caller
  }
  const sandbox = environment === 'sandbox';
  return {
    ok: true,
    // The organization's name needs organizations:read, one more scope for a label; the environment is enough.
    accountLabel: sandbox ? 'Polar (sandbox)' : 'Polar',
    config: { [CONFIG_ENVIRONMENT]: environment },
    testMode: sandbox,
    warnings: [],
  };
}

export const polarAdapter: ProviderAdapter = {
  id: 'polar',
  verify,
  fetchSnapshot,
  fetchRevenue,
};
