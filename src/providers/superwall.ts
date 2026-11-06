/**
 * Superwall adapter. Owner: Data Plane. SPEC.md §6.12.
 *
 * Superwall stores every app-store / Play / Stripe subscription event it receives (store server notifications,
 * Google RTDN, Stripe, or a RevenueCat webhook) and exposes it two ways to an organization API key
 * (Settings → API Keys, `Authorization: Bearer sk_…`), both documented as read-only queries:
 *
 *   Charts API   POST /v2/charts/data          scope charts:read   "Queries chart data from ClickHouse"
 *                GET  /v2/charts/definitions   scope charts:read   chart / metric keys ("static configuration")
 *                https://api.superwall.com/docs (OpenAPI: https://api.superwall.com/openapi.json)
 *   Query API    GET  /v2/organizations/{organization_id}/query   scope data:read
 *                Read-only SQL proxied to ClickHouse, row-level-scoped to the organization's apps.
 *                https://superwall.com/docs/dashboard/guides/query-clickhouse
 *                Table schema: Superwall's official agent skill, references/data-analytics.md
 *                (https://github.com/superwall/skills), `open_revenue.attributed_events_by_ts_rep`.
 *
 * Metrics
 *   MRR           Superwall's own MRR chart ("monthly recurring revenue from subscriptions, normalized into a
 *                 monthly view"), organization-wide (every app in every project the key can access),
 *                 PRODUCTION environment only. Value of the latest day point.
 *   Active subs   Superwall's Active Subscriptions chart: "unexpired, paid subscriptions" (trials excluded).
 *   Trials        Not a Superwall chart. Derived with SQL (data:read) from the revenue events: subscriptions
 *                 (applicationId, originalTransactionId) whose latest store/integration event is in a TRIAL
 *                 period, isn't an expiration, and whose expiration is still in the future. A trial set to
 *                 cancel counts until it ends. Null when the key lacks data:read or no integration events exist.
 *   Revenue       Daily, from SQL (data:read). Superwall's `price` is the transaction price in USD, negative for
 *                 refunds (webhook docs: "summing price … represents total revenue net of refunds").
 *                   gross   = Σ positive prices: Superwall's "Sales" basis, so it INCLUDES VAT / sales tax and the
 *                             store's commission (both come off later, in "Proceeds").
 *                   refunds = |Σ negative prices|, on the day the refund event happened.
 *                   count   = number of charges.
 *                 Each store transaction counts once per sign: an app that sends the same purchase through both
 *                 the store and RevenueCat (and the SDK's transaction_complete) has one row per source sharing
 *                 the store's transactionId. Sandbox, Family Sharing rows and RevenueCat's copies of Stripe
 *                 purchases are left out (Superwall's documented dashboard rule).
 *   Currency      Superwall converts every amount to USD (`exchangeRate`: "used to convert to USD"); chart values
 *                 carry no currency code. Everything is reported as USD.
 *
 * Request plan
 *   verify        definitions + MRR chart (required, charts:read) + today's revenue query (data:read probe;
 *                 a 403 only adds a warning and records revenueHistory = 'none'). 3 requests.
 *   fetchSnapshot definitions + MRR chart + Active Subscriptions chart (+ the trials query unless the
 *                 connection is known to lack data:read). 3–4 requests.
 *   fetchSnapshotHistory  (a connection's first sync) definitions + the same two charts over `last_90_days`:
 *                 up to 89 past days of MRR and subscriptions, trials unknown. 3 requests, or none when the
 *                 budget can't cover all three.
 *   fetchRevenue  one revenue query per ≤31-day window, resumable via a 'YYYY-MM-DD' cursor.
 *
 * SQL is constant text: the only inputs are dates, passed as ClickHouse query parameters (`param_*`), never
 * spliced into the statement. Each statement is a single SELECT that returns per-day / per-organization
 * aggregates only: no user ids, transaction ids or other end-user data ever leave Superwall.
 */

import { toMinor } from '../lib/money';
import { addDays, dayKey, dayRange } from '../lib/time';
import {
  BudgetExhaustedError,
  RateLimitedError,
  buildUrl,
  fetchJson,
  hasBudget,
  sanitizeErrorText,
  type QueryValue,
} from './http';
import {
  ProviderError,
  type ConnectionConfig,
  type ConnectionInput,
  type DailyRevenuePoint,
  type MetricsSnapshot,
  type ProviderAdapter,
  type ProviderContext,
  type RevenuePage,
  type SnapshotHistoryPoint,
  type VerifyResult,
} from './types';

const PROVIDER = 'Superwall';
export const SW_API_BASE = 'https://api.superwall.com';

/** Exact scope names from the API reference ("Requires charts:read scope", "Requires data:read scope"). */
export const SW_SCOPE_CHARTS = 'charts:read';
export const SW_SCOPE_DATA = 'data:read';

/** Superwall reports revenue converted to USD. */
const REPORTING_CURRENCY = 'USD';
/** Days per revenue query. A normal sync asks for a few days, the first backfill for ~91. */
const WINDOW_DAYS = 31;
/** ClickHouse may scan a month of events; give it longer than the default, and don't retry a slow query twice. */
const QUERY_TIMEOUT_MS = 25_000;
const QUERY_MAX_ATTEMPTS = 2;
/**
 * Snapshot history's chart window. It ends today, so it holds up to 89 past days: with today's snapshot, the
 * dashboard's 90-day range.
 */
const HISTORY_PRESET = 'last_90_days';
/** Definitions, then the MRR and Active Subscriptions charts. */
const HISTORY_REQUESTS = 3;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ORG_ID_RE = /^\d{1,12}$/;
/** The new dashboard's address starts with the organization ID: https://app.superwall.com/{organization_id}/… */
const DASHBOARD_URL_RE = /^(?:https?:\/\/)?app\.superwall\.com\/(\d{1,12})(?:[/?#]|$)/i;
const KEY_RE = /^[A-Za-z0-9_.-]{16,512}$/;

export const DATA_PERMISSION_WARNING =
  'This key can’t run Superwall’s query API, so hoomuch will show MRR and subscriptions but not daily revenue, ' +
  `refunds or trials. To get them, add the ${SW_SCOPE_DATA} scope to the key.`;
const DATA_UNKNOWN_WARNING =
  'hoomuch couldn’t check Superwall’s query API just now. It will try again on the first sync.';
export const RESTRICTED_PROJECTS_WARNING =
  'This key can only reach some of your Superwall projects, so MRR and subscriptions cover only those. ' +
  'Give it access to all projects so every number covers the same apps.';

// Snapshot warnings (`MetricsSnapshot.warnings`). Fixed text only: never Superwall's own chart names or reasons.
export const SW_RESTRICTED_PROJECTS_WARNING = RESTRICTED_PROJECTS_WARNING;
export const SW_MRR_CHART_PARTIAL_WARNING =
  'Superwall says its MRR chart isn’t fully available for this organization’s apps, so MRR may be incomplete.';
export const SW_SUBSCRIPTIONS_CHART_PARTIAL_WARNING =
  'Superwall says its Active Subscriptions chart isn’t fully available for this organization’s apps, so the count may be incomplete.';
export const SW_TRIALS_PERMISSION_WARNING =
  `Trials aren’t shown, because this key can’t run Superwall’s query API. Add the ${SW_SCOPE_DATA} scope, then replace the key on the connection page.`;
export const SW_TRIALS_SKIPPED_WARNING =
  'Trials aren’t shown this time, because Superwall’s query API couldn’t be read; the next sync tries again.';

const AUTH_MESSAGE =
  'Superwall rejected the API key. Use an organization API key from Settings → API Keys and check that it hasn’t been revoked.';
const ORG_NOT_FOUND_MESSAGE =
  'Superwall couldn’t find this organization. Your Organization ID is the number right after app.superwall.com/ in the dashboard’s address.';
const PERMISSION_HINT = 'If it already has it, check that the key belongs to this organization.';

// ---------- input ----------

interface SwInput {
  apiKey: string;
  organizationId: string;
}

type InputCheck = { ok: true; value: SwInput } | { ok: false; error: string; field: 'apiKey' | 'organizationId' };

/** Validates field shapes without any network call. Never echoes secret values back. */
export function checkSuperwallInput(input: ConnectionInput): InputCheck {
  const apiKey = (input.credentials['apiKey'] ?? '').trim();
  const rawOrg = (input.config['organizationId'] ?? '').trim();
  const fail = (field: 'apiKey' | 'organizationId', error: string): InputCheck => ({ ok: false, error, field });

  if (!apiKey) return fail('apiKey', 'Paste a Superwall organization API key.');
  if (/^pk_/i.test(apiKey)) {
    return fail(
      'apiKey',
      'That’s an app’s public API key (pk_…), which the SDK uses. hoomuch needs an organization API key from Settings → API Keys.',
    );
  }
  if (ORG_ID_RE.test(apiKey)) {
    return fail('apiKey', 'That looks like an Organization ID. Paste the API key here and the Organization ID in its own field.');
  }
  if (!KEY_RE.test(apiKey)) {
    return fail('apiKey', 'That doesn’t look like a complete Superwall API key. Copy it again when you create it in Settings → API Keys.');
  }

  if (!rawOrg) return fail('organizationId', 'Enter your Superwall Organization ID.');
  if (/^(sk|pk)_/i.test(rawOrg)) {
    return fail('organizationId', 'This looks like an API key, not an Organization ID. The Organization ID is a number, like 1234.');
  }
  const fromUrl = DASHBOARD_URL_RE.exec(rawOrg)?.[1];
  const organizationId = fromUrl ?? rawOrg;
  if (!ORG_ID_RE.test(organizationId)) {
    return fail(
      'organizationId',
      'Organization IDs are numbers, like 1234. It’s the number right after app.superwall.com/ in the dashboard’s address.',
    );
  }
  return { ok: true, value: { apiKey, organizationId } };
}

function requireInput(input: ConnectionInput): SwInput {
  const checked = checkSuperwallInput(input);
  if (!checked.ok) throw new ProviderError('invalid_input', checked.error, { field: checked.field });
  return checked.value;
}

// ---------- parsing helpers ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Numbers, and numeric strings (ClickHouse's JSON format quotes 64-bit integers). */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** "Active Subscriptions", "activeSubscriptions" and "active_subscriptions" all become "activesubscriptions". */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function unreadable(ctx: ProviderContext, what: string, data: Record<string, unknown> = {}): ProviderError {
  ctx.log('superwall_unreadable', { what, ...data });
  return new ProviderError('upstream', `${PROVIDER} returned ${what} hoomuch couldn’t read.`);
}

// ---------- HTTP ----------

/** Superwall's 403 names the scope it wanted (`required_scope`); prefer it over our guess. */
function mapSuperwallError(permission: string) {
  return (status: number, body: unknown): ProviderError | null => {
    if (status !== 403) return null;
    const scope = isRecord(body) ? str(body['required_scope']) : null;
    const name = scope && /^[a-z_]+:[a-z_]+$/.test(scope) ? scope : permission;
    return new ProviderError('permission', `The ${PROVIDER} key is missing the “${name}” permission.`, {
      status,
      field: 'apiKey',
    });
  };
}

interface SwRequest {
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON body for the Charts API's read-only query endpoint (sent as POST). */
  readQuery?: unknown;
  permission: string;
  timeoutMs?: number;
  maxAttempts?: number;
  rateLimit?: 'retry' | 'yield';
}

async function swFetch(ctx: ProviderContext, inp: SwInput, req: SwRequest): Promise<unknown> {
  try {
    return await fetchJson<unknown>(ctx, {
      provider: PROVIDER,
      url: buildUrl(SW_API_BASE, req.path, req.query ?? {}),
      headers: { Authorization: `Bearer ${inp.apiKey}` },
      permission: req.permission,
      notFoundMessage: ORG_NOT_FOUND_MESSAGE,
      mapError: mapSuperwallError(req.permission),
      ...(req.readQuery === undefined ? {} : { readQuery: req.readQuery }),
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
      ...(req.maxAttempts === undefined ? {} : { maxAttempts: req.maxAttempts }),
      ...(req.rateLimit === undefined ? {} : { rateLimit: req.rateLimit }),
    });
  } catch (err) {
    // Every call is scoped to the organization: a 404 means the Organization ID is wrong.
    if (err instanceof ProviderError && err.kind === 'not_found') {
      throw new ProviderError('not_found', ORG_NOT_FOUND_MESSAGE, { status: err.status, field: 'organizationId' });
    }
    throw err;
  }
}

// ---------- Charts API ----------

/** The organization's chart definitions don't include a chart hoomuch needs (permanent until Superwall adds it). */
class MissingChartError extends ProviderError {
  constructor(chart: string) {
    super('upstream', `${PROVIDER} didn’t list its ${chart} chart for this organization, so hoomuch can’t read it.`);
    this.name = 'MissingChartError';
  }
}

interface ChartSpec {
  /** Chart type key, for logs. */
  chart: string;
  /** Display name, for warnings. */
  name: string;
  yAxis: string;
  xAxis: string;
  dateDimension: string;
  /** From the y-axis metric definition: 'currency' | 'number' | 'percentage', when listed. */
  valueType: string | null;
  availability: { status: string; reason: string | null } | null;
}

interface Definitions {
  mrr: ChartSpec;
  activeSubscriptions: ChartSpec;
  /** False when the key's project access is restricted. Null when Superwall didn't say. */
  allProjects: boolean | null;
  projectNames: string[];
}

/** Chart names from https://superwall.com/docs/dashboard/charts ("MRR", "Active Subscriptions"). */
const MRR_NAMES = new Set(['mrr', 'monthlyrecurringrevenue']);
const ACTIVE_SUBS_NAMES = new Set(['activesubscriptions', 'activesubs']);

function findChart(types: unknown[], yMetrics: unknown[], names: Set<string>): ChartSpec | null {
  // An exact display-name match wins over a key match.
  const candidates = types.filter(isRecord);
  const hit =
    candidates.find((c) => names.has(norm(c['name']))) ?? candidates.find((c) => names.has(norm(c['key'])));
  if (!hit) return null;
  const yAxis = str(hit['y_axis']);
  const xAxis = str(hit['x_axis']);
  const dateDimension = str(hit['date_dimension']);
  if (!yAxis || !xAxis || !dateDimension) return null;
  const metric = yMetrics.filter(isRecord).find((m) => m['key'] === yAxis);
  const avail = isRecord(hit['availability']) ? hit['availability'] : null;
  return {
    chart: str(hit['key']) ?? yAxis,
    name: str(hit['name']) ?? yAxis,
    yAxis,
    xAxis,
    dateDimension,
    valueType: metric ? str(metric['value_type']) : null,
    availability: avail && str(avail['status']) ? { status: str(avail['status'])!, reason: str(avail['reason']) } : null,
  };
}

/** GET /v2/charts/definitions: the documented way to learn the exact metric keys `POST /v2/charts/data` takes. */
async function getDefinitions(ctx: ProviderContext, inp: SwInput): Promise<Definitions> {
  const body = await swFetch(ctx, inp, {
    path: '/v2/charts/definitions',
    query: { organization_id: inp.organizationId },
    permission: SW_SCOPE_CHARTS,
  });
  if (!isRecord(body) || !Array.isArray(body['chart_types'])) throw unreadable(ctx, 'chart definitions');
  const types = body['chart_types'];
  const yMetrics = Array.isArray(body['y_axis']) ? body['y_axis'] : [];
  const mrr = findChart(types, yMetrics, MRR_NAMES);
  const activeSubscriptions = findChart(types, yMetrics, ACTIVE_SUBS_NAMES);
  if (!mrr || !activeSubscriptions) {
    // Chart keys are dashboard configuration, not customer data.
    const keys = types.filter(isRecord).map((t) => str(t['key']) ?? '?').slice(0, 60);
    ctx.log('superwall_charts_missing', { mrr: Boolean(mrr), activeSubscriptions: Boolean(activeSubscriptions), keys });
    throw new MissingChartError(mrr ? 'Active Subscriptions' : 'MRR');
  }

  const scope = isRecord(body['scope']) ? body['scope'] : {};
  const projects = Array.isArray(scope['projects']) ? scope['projects'] : [];
  return {
    mrr,
    activeSubscriptions,
    allProjects: typeof scope['all_projects'] === 'boolean' ? scope['all_projects'] : null,
    projectNames: projects.filter(isRecord).flatMap((p) => (str(p['name']) ? [str(p['name'])!] : [])),
  };
}

interface ChartPoint {
  day: string;
  incomplete: boolean;
  /** Σ y over the point's series; null when the point carries no values at all. */
  value: number | null;
}

/** `x` is "typically a date string"; ISO datetimes and epoch seconds / ms are accepted too. */
function pointDay(x: unknown): string | null {
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0, 10);
  const n = num(x);
  if (n === null || n < 0) return null;
  return dayKey(n > 1e11 ? n : n * 1000);
}

function parseChartPoints(body: unknown): ChartPoint[] | null {
  if (!isRecord(body) || !Array.isArray(body['data'])) return null;
  const points: ChartPoint[] = [];
  for (const p of body['data']) {
    if (!isRecord(p)) return null;
    const day = pointDay(p['x']);
    if (!day || !isRecord(p['values'])) return null;
    let value: number | null = null;
    for (const series of Object.values(p['values'])) {
      // No breakdown is requested, so there is normally one series; several (a breakdown) add up.
      if (!isRecord(series)) return null;
      const y = series['y'] === null ? 0 : num(series['y']);
      if (y === null) return null;
      value = (value ?? 0) + y;
    }
    points.push({ day, incomplete: p['incomplete'] === true, value });
  }
  return points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * The chart's current value: its latest day point (today's, which Superwall marks incomplete). Falls back to the
 * latest complete point when today's has no values yet, or reads 0 while yesterday's didn't: a point that hasn't
 * been computed yet must not be stored as a drop to zero.
 */
function currentValue(points: ChartPoint[], today: string): { value: number; fellBack: boolean } {
  const past = points.filter((p) => p.day <= today);
  const latest = past[past.length - 1];
  if (!latest) return { value: 0, fellBack: false };
  const complete = [...past].reverse().find((p) => !p.incomplete && p.value !== null);
  const suspicious = latest.incomplete && (latest.value === null || (latest.value === 0 && (complete?.value ?? 0) > 0));
  if (suspicious && complete && complete !== latest) return { value: complete.value ?? 0, fellBack: true };
  return { value: latest.value ?? 0, fellBack: false };
}

/** Log-safe description of a chart payload we couldn't read: types and lengths only, never values. */
function chartShape(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return { body: Array.isArray(body) ? 'array' : typeof body };
  const data = body['data'];
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  return {
    data: Array.isArray(data) ? data.length : typeof data,
    point: isRecord(first) ? Object.keys(first).sort().join(',') : typeof first,
  };
}

/** Documented `date_filter.preset` values hoomuch asks for. Both windows end today, today included. */
type ChartPreset = 'last_7_days' | 'last_90_days';

/** A chart's day points over a preset window, oldest first, once its unit is the expected one. */
async function getChartPoints(
  ctx: ProviderContext,
  inp: SwInput,
  spec: ChartSpec,
  expect: 'currency' | 'number',
  preset: ChartPreset,
): Promise<ChartPoint[]> {
  const body = await swFetch(ctx, inp, {
    path: '/v2/charts/data',
    readQuery: {
      organization_id: inp.organizationId,
      y_axis: spec.yAxis,
      x_axis: spec.xAxis,
      breakdown: null,
      date_filter: { dimension: spec.dateDimension, preset },
      date_interval: 'day',
      environment: ['PRODUCTION'],
    },
    permission: SW_SCOPE_CHARTS,
  });
  const yAxis = isRecord(body) && isRecord(body['y_axis']) ? body['y_axis'] : null;
  const valueType = (yAxis ? str(yAxis['value_type']) : null) ?? spec.valueType;
  if (valueType !== null && valueType !== expect) {
    throw unreadable(ctx, `a ${spec.name} chart in an unexpected unit, which`, { chart: spec.chart, valueType });
  }
  const points = parseChartPoints(body);
  if (!points) throw unreadable(ctx, `a ${spec.name} chart`, { chart: spec.chart, ...chartShape(body) });
  // Not a snapshot warning: an organization with no subscriptions yet has an empty chart.
  if (points.length === 0) ctx.log('superwall_chart_empty', { chart: spec.chart });
  return points;
}

async function getChartValue(
  ctx: ProviderContext,
  inp: SwInput,
  spec: ChartSpec,
  expect: 'currency' | 'number',
  today: string,
): Promise<number> {
  const points = await getChartPoints(ctx, inp, spec, expect, 'last_7_days');
  const { value, fellBack } = currentValue(points, today);
  // Not a snapshot warning either: yesterday's point stands in until Superwall computes today's.
  if (fellBack) ctx.log('superwall_chart_used_last_complete_day', { chart: spec.chart });
  return value;
}

/**
 * Past days' values of a chart, for days in [from, today). Only today's point should be incomplete; a past one
 * that is (or that carries no values) may not be final, so it's left out rather than stored for good.
 */
function pastValues(points: ChartPoint[], from: string, today: string): { byDay: Map<string, number>; notFinal: number } {
  const byDay = new Map<string, number>();
  let notFinal = 0;
  for (const p of points) {
    if (p.day < from || p.day >= today) continue;
    if (p.incomplete || p.value === null) {
      notFinal += 1;
      continue;
    }
    byDay.set(p.day, p.value);
  }
  return { byDay, notFinal };
}

// ---------- Query API (SQL) ----------

/** Collapses whitespace so the statement travels compactly in the `query` URL parameter. */
function sql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Daily gross / refunds / charge count in USD minor units, for UTC days [{day_from}, {day_after}).
 * Dollars become cents with round() before the Int64 cast: toInt64 truncates a float toward zero, and
 * 19.99 * 100 is 1998.9999…, so a bare cast would lose a cent (round is exact for a Decimal too).
 * The scan starts a day early ({scan_from}) so a transaction reported by two sources either side of midnight is
 * dated by its first report, the same in every window, and then dropped if that day is before {day_from}.
 */
export const REVENUE_SQL = sql(`
  SELECT
    day,
    toInt64(round(sumIf(amount, isCharge) * 100)) AS gross_minor,
    toInt64(round(sumIf(amount, NOT isCharge) * -100)) AS refunds_minor,
    countIf(isCharge) AS charges
  FROM
  (
    SELECT
      applicationId,
      coalesce(nullIf(transactionId, ''), id) AS txKey,
      assumeNotNull(price) > 0 AS isCharge,
      toDate(min(ts), 'UTC') AS day,
      if(isCharge, max(assumeNotNull(price)), min(assumeNotNull(price))) AS amount
    FROM open_revenue.attributed_events_by_ts_rep FINAL
    WHERE isSandbox = 0
      AND ts >= toDateTime64({scan_from:Date}, 6, 'UTC')
      AND ts < toDateTime64({day_after:Date}, 6, 'UTC')
      AND price IS NOT NULL
      AND price != 0
      AND isFamilyShare = 0
      AND NOT (coalesce(integration, '') = 'revenue_cat' AND coalesce(store, '') = 'STRIPE')
    GROUP BY applicationId, txKey, isCharge
  )
  WHERE day >= {day_from:Date}
  GROUP BY day
  ORDER BY day
`);

/**
 * Active trials across the organization, from integration (store / RevenueCat / Stripe) events of the last
 * 400 days, one row per subscription. `subscriptions` tells "no trials" apart from "no integration data".
 */
export const TRIALS_SQL = sql(`
  SELECT
    countIf(lastPeriod = 'trial' AND lastName != 'expiration' AND ifNull(expiresAt > now(), 0)) AS active_trials,
    count() AS subscriptions
  FROM
  (
    SELECT
      applicationId,
      originalTransactionId,
      argMax(lower(coalesce(periodType, '')), ts) AS lastPeriod,
      argMax(name, ts) AS lastName,
      max(expirationAt) AS expiresAt
    FROM open_revenue.attributed_events_by_ts_rep FINAL
    WHERE isSandbox = 0
      AND source = 'integration'
      AND isFamilyShare = 0
      AND originalTransactionId != ''
      AND NOT (coalesce(integration, '') = 'revenue_cat' AND coalesce(store, '') = 'STRIPE')
      AND ts >= now() - INTERVAL 400 DAY
      AND ts < now() + INTERVAL 1 DAY
    GROUP BY applicationId, originalTransactionId
  )
`);

/** Runs one constant SELECT. `params` become ClickHouse `param_<name>` values, never part of the SQL text. */
async function runQuery(
  ctx: ProviderContext,
  inp: SwInput,
  statement: string,
  params: Record<string, string>,
  rateLimit: 'retry' | 'yield',
): Promise<Record<string, unknown>[] | null> {
  const query: Record<string, QueryValue> = {
    query: statement,
    default_format: 'JSON',
    // Buffer the result so a failing query answers with an HTTP error, not a 200 cut off mid-JSON.
    wait_end_of_query: 1,
  };
  for (const [k, v] of Object.entries(params)) query[`param_${k}`] = v;
  const body = await swFetch(ctx, inp, {
    path: `/v2/organizations/${encodeURIComponent(inp.organizationId)}/query`,
    query,
    permission: SW_SCOPE_DATA,
    timeoutMs: QUERY_TIMEOUT_MS,
    maxAttempts: QUERY_MAX_ATTEMPTS,
    rateLimit,
  });
  if (!isRecord(body) || !Array.isArray(body['data'])) return null;
  const rows = body['data'];
  return rows.every(isRecord) ? (rows as Record<string, unknown>[]) : null;
}

interface DayTotals {
  gross: number;
  refunds: number;
  count: number;
}

async function queryRevenue(
  ctx: ProviderContext,
  inp: SwInput,
  from: string,
  to: string,
  rateLimit: 'retry' | 'yield',
): Promise<Map<string, DayTotals>> {
  const rows = await runQuery(
    ctx,
    inp,
    REVENUE_SQL,
    { scan_from: addDays(from, -1), day_from: from, day_after: addDays(to, 1) },
    rateLimit,
  );
  if (!rows) throw unreadable(ctx, 'a revenue query result');
  const byDay = new Map<string, DayTotals>();
  for (const r of rows) {
    const day = typeof r['day'] === 'string' ? r['day'].slice(0, 10) : '';
    const gross = num(r['gross_minor']);
    const refunds = num(r['refunds_minor']);
    const count = num(r['charges']);
    if (!DAY_RE.test(day) || gross === null || refunds === null || count === null) {
      throw unreadable(ctx, 'a revenue query result', { columns: Object.keys(r).sort().join(',') });
    }
    if (day < from || day > to) continue;
    byDay.set(day, {
      gross: Math.max(0, Math.round(gross)),
      refunds: Math.max(0, Math.round(refunds)),
      count: Math.max(0, Math.round(count)),
    });
  }
  return byDay;
}

/** One point per day of [from, to], zeros included, so a day whose sales were all refunded away is rewritten. */
function toDailyPoints(byDay: Map<string, DayTotals>, from: string, to: string): DailyRevenuePoint[] {
  return dayRange(from, to).map((day) => {
    const t = byDay.get(day);
    return { day, currency: REPORTING_CURRENCY, gross: t?.gross ?? 0, refunds: t?.refunds ?? 0, count: t?.count ?? 0 };
  });
}

async function queryActiveTrials(ctx: ProviderContext, inp: SwInput): Promise<number | null> {
  const rows = await runQuery(ctx, inp, TRIALS_SQL, {}, 'retry');
  const row = rows?.[0];
  const trials = row ? num(row['active_trials']) : null;
  const subscriptions = row ? num(row['subscriptions']) : null;
  if (trials === null || subscriptions === null) throw unreadable(ctx, 'a trials query result');
  // No store / RevenueCat / Stripe events at all: trials are unknown, not zero.
  return subscriptions > 0 ? Math.max(0, Math.round(trials)) : null;
}

function cursorDay(cursor: string | null): string | null {
  if (!cursor || !DAY_RE.test(cursor) || Number.isNaN(Date.parse(`${cursor}T00:00:00Z`))) return null;
  return cursor;
}

// ---------- adapter ----------

type VerifyFailure = Extract<VerifyResult, { ok: false }>;

/** Turns expected verify failures into form errors with Superwall-specific guidance; null = rethrow. */
function verifyFailure(err: unknown): VerifyFailure | null {
  if (!(err instanceof ProviderError)) return null;
  switch (err.kind) {
    case 'auth':
      return { ok: false, error: AUTH_MESSAGE, field: 'apiKey' };
    case 'permission':
      return { ok: false, error: `${err.message} ${PERMISSION_HINT}`, field: 'apiKey' };
    case 'not_found':
      return { ok: false, error: ORG_NOT_FOUND_MESSAGE, field: 'organizationId' };
    case 'upstream':
      // A chart the organization doesn't list, or a 400 (Superwall refused the request; its sanitised reason helps).
      if (err instanceof MissingChartError) return { ok: false, error: err.message };
      return err.status !== undefined && err.status >= 400 && err.status < 500 ? { ok: false, error: err.message } : null;
    default:
      return null; // rate_limit / 5xx / network: the generic "try again" message is right
  }
}

function accountLabel(organizationId: string, projectNames: string[]): string {
  if (projectNames.length === 1) {
    const name = projectNames[0]!.replace(/\s+/g, ' ');
    return `Superwall: ${name.length > 40 ? `${name.slice(0, 39)}…` : name}`;
  }
  return `Superwall organization ${organizationId}`;
}

function availabilityWarnings(defs: Definitions): string[] {
  const out: string[] = [];
  for (const spec of [defs.mrr, defs.activeSubscriptions]) {
    const a = spec.availability;
    if (!a || a.status === 'available') continue;
    const reason = a.reason ? `: ${sanitizeErrorText(a.reason, 160)}` : '.';
    out.push(
      a.status === 'unavailable'
        ? `Superwall’s ${spec.name} chart isn’t available for this organization’s apps${reason}`
        : `Superwall’s ${spec.name} chart covers only some of this organization’s apps${reason}`,
    );
  }
  if (defs.allProjects === false) out.push(RESTRICTED_PROJECTS_WARNING);
  return out;
}

export const superwallAdapter: ProviderAdapter = {
  id: 'superwall',

  async verify(input, ctx): Promise<VerifyResult> {
    const checked = checkSuperwallInput(input);
    if (!checked.ok) return { ok: false, error: checked.error, field: checked.field };
    const inp = checked.value;
    const today = dayKey(ctx.now());

    let defs: Definitions;
    try {
      defs = await getDefinitions(ctx, inp);
      await getChartValue(ctx, inp, defs.mrr, 'currency', today);
    } catch (err) {
      const failure = verifyFailure(err);
      if (failure) return failure;
      throw err;
    }

    const config: ConnectionConfig = { organizationId: inp.organizationId, reportingCurrency: REPORTING_CURRENCY };
    const warnings = availabilityWarnings(defs);

    // One cheap query-API probe: today's revenue, exactly the query fetchRevenue runs.
    let history: 'daily' | 'none' | 'unknown' = 'unknown';
    if (hasBudget(ctx)) {
      try {
        await queryRevenue(ctx, inp, today, today, 'retry');
        history = 'daily';
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        ctx.log('superwall_query_probe_failed', { kind: err.kind, status: err.status ?? null });
        if (err.kind === 'permission') history = 'none';
      }
    }
    if (history === 'none') warnings.push(DATA_PERMISSION_WARNING);
    if (history === 'unknown') warnings.push(DATA_UNKNOWN_WARNING);
    else config['revenueHistory'] = history;

    return { ok: true, accountLabel: accountLabel(inp.organizationId, defs.projectNames), config, testMode: false, warnings };
  },

  async fetchSnapshot(input, ctx): Promise<MetricsSnapshot> {
    const inp = requireInput(input);
    const today = dayKey(ctx.now());
    const defs = await getDefinitions(ctx, inp);
    const warnings = new Set<string>();
    if (defs.allProjects === false) warnings.add(SW_RESTRICTED_PROJECTS_WARNING);
    const partial = (spec: ChartSpec) => spec.availability !== null && spec.availability.status !== 'available';
    if (partial(defs.mrr)) warnings.add(SW_MRR_CHART_PARTIAL_WARNING);
    if (partial(defs.activeSubscriptions)) warnings.add(SW_SUBSCRIPTIONS_CHART_PARTIAL_WARNING);
    const mrr = await getChartValue(ctx, inp, defs.mrr, 'currency', today);
    const subscriptions = await getChartValue(ctx, inp, defs.activeSubscriptions, 'number', today);

    // Trials need the query API; skip it for a key verify found without data:read. A connection without any
    // store events (trials unknown, not 0) isn't warned about: nothing in hoomuch changes it.
    let activeTrials: number | null = null;
    if (input.config['revenueHistory'] === 'none') {
      warnings.add(SW_TRIALS_PERMISSION_WARNING);
    } else if (!hasBudget(ctx)) {
      warnings.add(SW_TRIALS_SKIPPED_WARNING);
    } else {
      try {
        activeTrials = await queryActiveTrials(ctx, inp);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        ctx.log('superwall_trials_unavailable', { kind: err.kind, status: err.status ?? null });
        warnings.add(err.kind === 'permission' ? SW_TRIALS_PERMISSION_WARNING : SW_TRIALS_SKIPPED_WARNING);
      }
    }

    return {
      mrr: { [REPORTING_CURRENCY]: toMinor(mrr, REPORTING_CURRENCY) },
      activeSubscriptions: Math.max(0, Math.round(subscriptions)),
      activeTrials,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
    };
  },

  async fetchRevenue(input, req, ctx): Promise<RevenuePage> {
    const inp = requireInput(input);
    const today = dayKey(ctx.now());
    let start = cursorDay(req.cursor) ?? dayKey(req.since);
    const daily: DailyRevenuePoint[] = [];
    const finished = (): RevenuePage => ({ events: [], daily, nextCursor: null, done: true });
    const paused = (reason: string): RevenuePage => {
      ctx.log('superwall_revenue_paused', { reason, resumeFrom: start, days: daily.length });
      return { events: [], daily, nextCursor: start, done: false };
    };

    let windows = 0;
    while (start <= today) {
      if (!hasBudget(ctx)) return paused('budget');
      const endCandidate = addDays(start, WINDOW_DAYS - 1);
      const end = endCandidate < today ? endCandidate : today;

      let byDay: Map<string, DayTotals>;
      try {
        byDay = await queryRevenue(ctx, inp, start, end, 'yield');
      } catch (err) {
        if (err instanceof RateLimitedError) return paused('rate_limit');
        if (err instanceof BudgetExhaustedError) return paused('budget');
        if (err instanceof ProviderError && err.kind === 'permission') {
          // No data:read: finish quietly; the connection shows MRR and subscriptions only (verify warned).
          ctx.log('superwall_query_unavailable', { status: err.status ?? null });
          return finished();
        }
        throw err;
      }
      daily.push(...toDailyPoints(byDay, start, end));
      windows += 1;
      start = addDays(end, 1);
    }

    ctx.log('superwall_revenue_fetched', { windows, days: daily.length });
    return finished();
  },

  async fetchSnapshotHistory(input, req, ctx): Promise<SnapshotHistoryPoint[]> {
    const inp = requireInput(input);
    const today = dayKey(ctx.now());
    const days = Number.isFinite(req.days) ? Math.max(0, Math.floor(req.days)) : 0;
    if (days === 0) return [];
    // Every day needs both charts, so don't start what the budget (or the clock) can't finish.
    if (!hasBudget(ctx, HISTORY_REQUESTS)) {
      ctx.log('superwall_history_skipped', { reason: 'budget' });
      return [];
    }

    let mrr: ChartPoint[];
    let subscriptions: ChartPoint[];
    try {
      const defs = await getDefinitions(ctx, inp);
      mrr = await getChartPoints(ctx, inp, defs.mrr, 'currency', HISTORY_PRESET);
      subscriptions = await getChartPoints(ctx, inp, defs.activeSubscriptions, 'number', HISTORY_PRESET);
    } catch (err) {
      // The deadline passed mid-way: one chart alone can't make a day.
      if (err instanceof BudgetExhaustedError) {
        ctx.log('superwall_history_skipped', { reason: err.reason });
        return [];
      }
      throw err;
    }

    const from = addDays(today, -days);
    const m = pastValues(mrr, from, today);
    const s = pastValues(subscriptions, from, today);
    const out: SnapshotHistoryPoint[] = [];
    let unmatched = 0;
    for (const day of dayRange(from, addDays(today, -1))) {
      const value = m.byDay.get(day);
      const count = s.byDay.get(day);
      if (value === undefined || count === undefined) {
        // A day with only one of the two is left out: a subscription count is never made up.
        if (value !== undefined || count !== undefined) unmatched += 1;
        continue;
      }
      out.push({
        day,
        snapshot: {
          mrr: { [REPORTING_CURRENCY]: toMinor(value, REPORTING_CURRENCY) },
          activeSubscriptions: Math.max(0, Math.round(count)),
          // Trials come from SQL as of now; Superwall has no trials series to read past days from.
          activeTrials: null,
          revenuePeriod: null,
          revenuePeriodDays: null,
          newCustomers: null,
        },
      });
    }
    ctx.log('superwall_history_fetched', { days: out.length, unmatched, notFinal: m.notFinal + s.notFinal });
    return out;
  },
};
