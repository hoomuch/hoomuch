/**
 * Adapty adapter (Export Analytics API). Owner: Data Plane. SPEC.md §6.11.
 *
 * Endpoint — https://adapty.io/docs/api-export-analytics/operations/retrieveAnalyticsData
 *   POST https://api-admin.adapty.io/api/v1/client-api/metrics/analytics/   ("Retrieve analytics data")
 *   Authorization: Api-Key <secret key>   Adapty-Tz: UTC   body {chart_id, filters.date [from, to], period_unit, …}
 * A documented read-only export: it takes its query as a JSON body, so it goes through fetchJson's `readQuery`.
 * One chart per request. Rate limit: 2 requests/second per app, shared by all of the app's keys; Adapty also caps
 * global traffic, and its 429 has no Retry-After. fetchJson's backoff retries a 429; a persistent one pauses the
 * revenue backfill with a cursor (or fails the sync when nothing was read yet).
 *
 * Requests per method (each body also carries period_unit=day, date_type=purchase_date, format=json):
 *   verify         mrr [today] + revenue [today]                                              2 requests
 *   fetchSnapshot  mrr, subscriptions_active, trials_active [today] + revenue [today−29, today] 4 requests
 *   fetchSnapshotHistory (a connection's first sync) mrr, subscriptions_active, trials_active
 *                  [today−90, today−1], today being the owner's local day: one series each      3 requests
 *   fetchRevenue   revenue + refund_money per window of ≤ 92 days                             2 per window
 *                  (fallback when a window's per-day series can't be read: the same two charts one day at a
 *                  time, read from the documented `value` field: 2 requests per day)
 *
 * Definitions are Adapty's own (adapty.io/docs/revenue, /mrr, /refund-money, /active-subscriptions, /active-trials):
 *   MRR            `mrr`, gross metric: active paid subscriptions normalised to a month, before store commission.
 *                  Trials and one-time purchases are not in it.
 *   Subscriptions  `subscriptions_active`: paid, unexpired subscriptions. Adapty excludes trials AND subscriptions
 *                  whose auto-renew is off (SPEC §6 counts those until they end; Adapty's number is used as is).
 *   Trials         `trials_active`: unexpired free trials.
 *   Revenue        `revenue`, gross metric ("what users paid": before store commission, VAT included, like
 *                  RevenueCat's Revenue chart): paid transactions on their transaction day minus refunds on the
 *                  day they were processed, so a day can be negative. `refund_money` is the refunded amount,
 *                  before the store's fee, on the refund day. Per day: gross = revenue + refund_money,
 *                  refunds = refund_money, so gross − refunds is exactly Adapty's Revenue. count is always 0
 *                  (Adapty has no per-day transaction count).
 * Money: every monetary chart is USD, converted at the transaction-time rate (no other currency exists), in
 * decimal major units → `toMinor`. Days: requested in UTC (`Adapty-Tz: UTC`) so they match hoomuch's day keys.
 * Sandbox purchases are excluded from all Adapty charts, so there is no test mode.
 *
 * The documented response is `data: {<metric>: {value, data: [...], unit, default_aggregation, …}}`; money charts
 * answer with `revenue` (gross), `proceeds` and `net_revenue`. The items of the inner `data` array are not
 * documented. The adapter reads the total row as `{type: 'total', values: [{x: 'YYYY-MM-DD', y}]}` (the row
 * shape of Adapty's documented LTV/funnel answers and of the API's existing consumers) and only trusts it when
 * the days add up to the documented `value`; otherwise it falls back to one-day queries and `value`. Level charts
 * (mrr and the active counts, aggregated with `last`) read over a range for snapshot history are trusted when the
 * series' last day matches the documented `value_to`; there is no one-day fallback for them (90 days × 3 charts).
 */

import { normalizeCurrency, toMinor } from '../lib/money';
import { addDays, dayKey, dayRange } from '../lib/time';
import { BudgetExhaustedError, fetchJson, hasBudget, sanitizeErrorText } from './http';
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
  type SnapshotHistoryRequest,
  type VerifyResult,
} from './types';

const PROVIDER = 'Adapty';
export const ADAPTY_ANALYTICS_URL = 'https://api-admin.adapty.io/api/v1/client-api/metrics/analytics/';

/** Days are grouped in this IANA zone (`Adapty-Tz`), not the app's reporting time zone, to match UTC day keys. */
const REPORT_TIMEZONE = 'UTC';
/** "Adapty displays all monetary charts in US dollars" — used when a chart's `unit` isn't a currency code. */
const DEFAULT_CURRENCY = 'USD';
/** Days per revenue request: the 90-day first backfill is one window. */
const MAX_WINDOW_DAYS = 92;
/** Trailing window of the snapshot's revenue total (the dashboard's fallback when there's no daily history). */
export const REVENUE_PERIOD_DAYS = 30;
/** Most past days snapshot history reads: the dashboard's longest range, one request per chart. */
export const HISTORY_MAX_DAYS = 90;

export type AdaptyChart = 'mrr' | 'subscriptions_active' | 'trials_active' | 'revenue' | 'refund_money';

const MONEY_CHARTS: ReadonlySet<AdaptyChart> = new Set(['mrr', 'revenue', 'refund_money']);
/** Never read by the single-metric fallback: they are after store commission (and taxes). */
const NOT_GROSS = new Set(['proceeds', 'net_revenue']);

const PUBLIC_KEY_RE = /^public_[a-z]+_/i;
/** Documented shape: `secret_live_Pj1P1xzM.2CvSvE1IalQRFjsWy6csBVNpH33atnod`. */
const SECRET_KEY_RE = /^secret_[a-z]+_[A-Za-z0-9._-]{16,}$/;
/** People sometimes paste the whole header value. */
const HEADER_PREFIX_RE = /^api-key\s+/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const HISTORY_UNAVAILABLE_WARNING =
  "Adapty didn’t return a daily revenue chart for this app, so hoomuch will show Adapty’s 30-day revenue total instead of a daily history.";
const HISTORY_UNKNOWN_WARNING = "hoomuch couldn’t check Adapty’s revenue chart just now. It will try again on the first sync.";

// Snapshot warnings (`MetricsSnapshot.warnings`). MRR and subscriptions are required (the snapshot fails
// without them); trials are optional and show as unknown when their chart can't be read.
export const ADAPTY_TRIALS_SKIPPED_WARNING =
  'Trials aren’t shown this time, because the sync ran out of requests; the next sync tries again.';
export const ADAPTY_TRIALS_UNAVAILABLE_WARNING =
  'Trials aren’t shown, because Adapty didn’t return its active trials chart for this app.';

const AUTH_MESSAGE =
  "Adapty rejected the API key. Use the Secret API key from App settings → General (it starts with “secret_live_”) and check that it hasn’t been deleted or regenerated.";
const KEY_HINT = 'Copy it from App settings → General → API keys in the Adapty dashboard.';

// ---------- input ----------

type InputCheck = { ok: true; apiKey: string } | { ok: false; error: string; field: 'apiKey' };

/** Validates the key's shape without any network call. Never echoes the value back. */
export function checkAdaptyInput(input: ConnectionInput): InputCheck {
  const apiKey = (input.credentials['apiKey'] ?? '').trim().replace(HEADER_PREFIX_RE, '').trim();
  const fail = (error: string): InputCheck => ({ ok: false, error, field: 'apiKey' });

  if (!apiKey) return fail(`Paste your Adapty Secret API key. ${KEY_HINT}`);
  if (PUBLIC_KEY_RE.test(apiKey)) {
    return fail(
      'That’s Adapty’s Public SDK key (public_…), which only works inside your app. hoomuch needs the Secret API key, which starts with “secret_live_”. ' +
        KEY_HINT,
    );
  }
  if (!apiKey.startsWith('secret_')) return fail(`Adapty Secret API keys start with “secret_live_”. ${KEY_HINT}`);
  if (!SECRET_KEY_RE.test(apiKey)) return fail(`That doesn’t look like a complete Adapty Secret API key. ${KEY_HINT}`);
  return { ok: true, apiKey };
}

function requireKey(input: ConnectionInput): string {
  const checked = checkAdaptyInput(input);
  if (!checked.ok) throw new ProviderError('invalid_input', checked.error, { field: checked.field });
  return checked.apiKey;
}

// ---------- parsing helpers ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Adapty's error bodies: `{errors: [{source, errors: [string]}], error_code, status_code}`, or DRF's `{detail}`. */
function adaptyErrorText(body: unknown): string {
  if (!isRecord(body)) return '';
  const parts: string[] = [];
  if (Array.isArray(body['errors'])) {
    for (const e of body['errors']) {
      if (typeof e === 'string') parts.push(e);
      else if (isRecord(e) && Array.isArray(e['errors'])) {
        for (const s of e['errors']) if (typeof s === 'string') parts.push(s);
      }
    }
  }
  if (parts.length === 0 && typeof body['detail'] === 'string') parts.push(body['detail']);
  if (parts.length === 0 && typeof body['error_code'] === 'string') parts.push(body['error_code']);
  return parts.join(' ');
}

// ---------- HTTP ----------

function mapAdaptyError(status: number, body: unknown, detail: string): ProviderError | null {
  const text = sanitizeErrorText(adaptyErrorText(body) || detail);
  if (status === 401) return new ProviderError('auth', AUTH_MESSAGE, { status, field: 'apiKey' });
  if (status === 403) {
    return new ProviderError('permission', `Adapty denied this key access to analytics${text ? `: ${text}` : '.'}`, {
      status,
      field: 'apiKey',
    });
  }
  if (status === 400 || status === 422) {
    return new ProviderError('upstream', `Adapty refused the analytics query (HTTP ${status})${text ? `: ${text}` : '.'}`, {
      status,
    });
  }
  return null; // 404 / 429 / 5xx: fetchJson's generic mapping
}

/** One "Retrieve analytics data" query. No segmentation: the answer holds only the total series. */
function queryChart(ctx: ProviderContext, apiKey: string, chart: AdaptyChart, from: string, to: string): Promise<unknown> {
  return fetchJson<unknown>(ctx, {
    provider: PROVIDER,
    url: ADAPTY_ANALYTICS_URL,
    headers: { Authorization: `Api-Key ${apiKey}`, 'Adapty-Tz': REPORT_TIMEZONE },
    readQuery: {
      chart_id: chart,
      filters: { date: [from, to] },
      period_unit: 'day',
      date_type: 'purchase_date',
      format: 'json',
    },
    mapError: mapAdaptyError,
  });
}

// ---------- reading a chart ----------

interface Metric {
  key: string;
  body: Record<string, unknown>;
  currency: string;
}

type ChartRead =
  | { ok: true; metric: Metric }
  | { ok: false; reason: 'permission' | 'not_found' | 'rejected' | 'unreadable'; error: ProviderError };

/** Log-safe description of an answer we couldn't read: key names, types and lengths, never values. */
function answerShape(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return { body: Array.isArray(body) ? 'array' : typeof body };
  const data = body['data'];
  if (!isRecord(data)) return { data: Array.isArray(data) ? 'array' : typeof data };
  const firstMetric = Object.values(data).find(isRecord);
  const rows = firstMetric?.['data'];
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  const values = isRecord(row) ? row['values'] : undefined;
  const point: unknown = Array.isArray(values) ? values[0] : undefined;
  return {
    metrics: Object.keys(data).sort().join(','),
    rows: Array.isArray(rows) ? rows.length : typeof rows,
    row: isRecord(row) ? Object.keys(row).sort().join(',') : typeof row,
    points: Array.isArray(values) ? values.length : typeof values,
    point: isRecord(point) ? Object.keys(point).sort().join(',') : typeof point,
  };
}

/**
 * Picks the metric to read from `data`. Money charts answer with gross `revenue` next to `proceeds` and
 * `net_revenue`; count charts with a single metric (`common` in practice). A lone metric is accepted under any
 * name except the after-commission ones.
 */
function pickMetric(body: unknown, chart: AdaptyChart): { key: string; body: Record<string, unknown> } | null {
  if (!isRecord(body) || !isRecord(body['data'])) return null;
  const data = body['data'];
  const preferred = MONEY_CHARTS.has(chart) ? ['revenue', 'common', chart] : ['common', chart];
  for (const key of preferred) {
    const m = data[key];
    if (isRecord(m)) return { key, body: m };
  }
  const lone = Object.keys(data).filter((k) => isRecord(data[k]) && !NOT_GROSS.has(k));
  return lone.length === 1 ? { key: lone[0]!, body: data[lone[0]!] as Record<string, unknown> } : null;
}

function currencyOfUnit(ctx: ProviderContext, chart: AdaptyChart, unit: unknown): string {
  if (typeof unit === 'string' && /^[A-Za-z]{3}$/.test(unit.trim())) return normalizeCurrency(unit);
  if (unit !== undefined && unit !== null) ctx.log('adapty_unexpected_unit', { chart, unit: typeof unit === 'string' ? unit.slice(0, 12) : typeof unit });
  return DEFAULT_CURRENCY;
}

/**
 * Runs one query. Permanent "this chart isn't usable" answers (403, 404, 400/422, a shape we don't know) come
 * back as `ok: false`; transient ones (401, 429, 5xx, network) are thrown so the caller retries later.
 */
async function readChart(
  ctx: ProviderContext,
  apiKey: string,
  chart: AdaptyChart,
  from: string,
  to: string,
): Promise<ChartRead> {
  let body: unknown;
  try {
    body = await queryChart(ctx, apiKey, chart, from, to);
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.kind === 'permission') return { ok: false, reason: 'permission', error: err };
      if (err.kind === 'not_found') return { ok: false, reason: 'not_found', error: err };
      if (err.kind === 'upstream' && (err.status === 400 || err.status === 422)) {
        return { ok: false, reason: 'rejected', error: err };
      }
    }
    throw err;
  }
  const picked = pickMetric(body, chart);
  if (!picked) {
    ctx.log('adapty_chart_unreadable', { chart, ...answerShape(body) });
    return {
      ok: false,
      reason: 'unreadable',
      error: new ProviderError('upstream', `${PROVIDER} returned a ${chart} chart hoomuch couldn’t read.`),
    };
  }
  // Count charts carry a non-currency unit; only money charts have a currency.
  const currency = MONEY_CHARTS.has(chart) ? currencyOfUnit(ctx, chart, picked.body['unit']) : DEFAULT_CURRENCY;
  return { ok: true, metric: { ...picked, currency } };
}

/** 'YYYY-MM-DD…' strings (dates or datetimes in the requested zone) and Unix seconds/milliseconds. */
function pointDay(v: unknown): string | null {
  if (typeof v === 'string') {
    const head = v.slice(0, 10);
    return DAY_RE.test(head) && !Number.isNaN(Date.parse(`${head}T00:00:00Z`)) ? head : null;
  }
  const n = num(v);
  if (n === null || n < 0) return null;
  return dayKey(n > 1e11 ? n : n * 1000);
}

/**
 * The points of a day-resolution answer's total series that fall in [from, to], in answer order (`value` null
 * where Adapty sent null), or null when the shape isn't one we know. An empty `data` array is Adapty's documented
 * "nothing in this range" answer.
 */
function seriesPoints(
  metric: Record<string, unknown>,
  from: string,
  to: string,
): Array<{ day: string; value: number | null }> | null {
  const rows = metric['data'];
  if (!Array.isArray(rows)) return null;
  if (rows.length === 0) return [];
  if (!rows.every(isRecord)) return null;
  const records = rows as Array<Record<string, unknown>>;
  const row =
    records.find((r) => typeof r['type'] === 'string' && r['type'].toLowerCase() === 'total') ??
    (records.length === 1 ? records[0] : undefined);
  if (!row || !Array.isArray(row['values'])) return null;
  const points: Array<{ day: string; value: number | null }> = [];
  for (const p of row['values']) {
    if (!isRecord(p)) return null;
    const day = pointDay(p['x'] ?? p['date']);
    const raw = p['y'] !== undefined ? p['y'] : p['value'];
    const value = raw === null ? null : num(raw);
    if (!day || (raw !== null && value === null)) return null;
    if (day < from || day > to) continue;
    points.push({ day, value });
  }
  return points;
}

/**
 * A flow chart's (revenue, refund_money) total series, per day (a null point is 0), or null when the shape isn't
 * one we know or its days don't add up to the documented `value` (the range total).
 */
function dailySeries(metric: Record<string, unknown>, from: string, to: string): Map<string, number> | null {
  const points = seriesPoints(metric, from, to);
  if (!points) return null;
  const byDay = new Map<string, number>();
  for (const p of points) byDay.set(p.day, (byDay.get(p.day) ?? 0) + (p.value ?? 0));
  const total = num(metric['value']);
  if (total !== null) {
    let sum = 0;
    for (const v of byDay.values()) sum += v;
    if (Math.abs(sum - total) > 0.01 + 0.005 * byDay.size) return null;
  }
  return byDay;
}

/**
 * Per-day amounts of a flow chart (revenue, refund_money) for [from, to]: the series when it checks out, the
 * documented `value` when the range is a single day, otherwise null (the caller re-reads one day at a time).
 */
function flowByDay(metric: Record<string, unknown>, from: string, to: string): Map<string, number> | null {
  const series = dailySeries(metric, from, to);
  if (series) return series;
  const total = num(metric['value']);
  return from === to && total !== null ? new Map([[from, total]]) : null;
}

/** A stock chart's level on `day` (one-day query): `value`, else `value_to`, else the series point. */
function levelOn(metric: Record<string, unknown>, day: string): number | null {
  return num(metric['value']) ?? num(metric['value_to']) ?? dailySeries(metric, day, day)?.get(day) ?? null;
}

/**
 * A stock chart's (mrr, subscriptions_active, trials_active) level per day over [from, to]. A day without a value
 * is left out, never read as zero. A day listed twice is a shape we don't know, and the series is only trusted
 * when its last day has a value that matches the documented level at the end of the range: `value_to`, or `value`
 * when Adapty aggregates the chart with `last`. Without the last day or that level, nothing checks the series.
 */
function levelSeries(metric: Record<string, unknown>, from: string, to: string): Map<string, number> | null {
  const points = seriesPoints(metric, from, to);
  if (!points) return null;
  const byDay = new Map<string, number>();
  const seen = new Set<string>();
  for (const p of points) {
    if (seen.has(p.day)) return null;
    seen.add(p.day);
    if (p.value !== null) byDay.set(p.day, p.value);
  }
  // No value on any day (Adapty's empty answer): nothing would be stored, so there is nothing to check.
  if (byDay.size === 0) return byDay;
  const end = num(metric['value_to']) ?? (metric['default_aggregation'] === 'last' ? num(metric['value']) : null);
  const last = byDay.get(to);
  if (end === null || last === undefined || Math.abs(end - last) > 0.01) return null;
  return byDay;
}

/** The day history counts back from: the engine's (the owner's local day) when it's within a day of UTC's. */
function historyToday(req: SnapshotHistoryRequest, ctx: ProviderContext): string {
  const utc = dayKey(ctx.now());
  const day = req.today;
  return day === addDays(utc, -1) || day === addDays(utc, 1) ? day : utc;
}

// ---------- snapshot ----------

/** A chart the snapshot can't do without: anything unusable fails the snapshot, so the previous one stays. */
async function requiredLevel(
  ctx: ProviderContext,
  apiKey: string,
  chart: AdaptyChart,
  day: string,
): Promise<{ value: number; currency: string }> {
  const read = await readChart(ctx, apiKey, chart, day, day);
  if (!read.ok) throw read.error;
  const value = levelOn(read.metric.body, day);
  if (value === null) {
    ctx.log('adapty_chart_unreadable', { chart, ...answerShape({ data: { [read.metric.key]: read.metric.body } }) });
    throw new ProviderError('upstream', `${PROVIDER} returned a ${chart} chart hoomuch couldn’t read.`);
  }
  return { value, currency: read.metric.currency };
}

/** Optional snapshot figures: a permanently unusable chart (or no budget left) becomes null and is logged. */
async function optionalRead(
  ctx: ProviderContext,
  apiKey: string,
  chart: AdaptyChart,
  from: string,
  to: string,
  onMissing?: (why: 'budget' | 'unavailable') => void,
): Promise<Metric | null> {
  if (!hasBudget(ctx)) {
    ctx.log('adapty_snapshot_skipped', { chart, reason: 'budget' });
    onMissing?.('budget');
    return null;
  }
  const read = await readChart(ctx, apiKey, chart, from, to);
  if (read.ok) return read.metric;
  ctx.log('adapty_snapshot_chart_unavailable', { chart, reason: read.reason, status: read.error.status ?? null });
  onMissing?.('unavailable');
  return null;
}

// ---------- snapshot history ----------

/** A level series the history can't do without (MRR, subscriptions): anything unusable fails the call. */
async function requiredSeries(
  ctx: ProviderContext,
  apiKey: string,
  chart: AdaptyChart,
  from: string,
  to: string,
): Promise<{ byDay: Map<string, number>; currency: string }> {
  const read = await readChart(ctx, apiKey, chart, from, to);
  if (!read.ok) throw read.error;
  const byDay = levelSeries(read.metric.body, from, to);
  if (!byDay) {
    ctx.log('adapty_series_unreadable', { chart, ...answerShape({ data: { [read.metric.key]: read.metric.body } }) });
    throw new ProviderError('upstream', `${PROVIDER} returned a ${chart} chart hoomuch couldn’t read.`);
  }
  return { byDay, currency: read.metric.currency };
}

/**
 * Past days' trials: unknown (null) when the chart can't be read, nothing is left of the budget or the time, or
 * Adapty keeps answering 429 or 5xx. Today's snapshot still has its own trials.
 */
async function historyTrials(ctx: ProviderContext, apiKey: string, from: string, to: string): Promise<Map<string, number> | null> {
  const unavailable = (reason: string, status: number | null) => {
    ctx.log('adapty_history_trials_unavailable', { reason, status });
    return null;
  };
  if (!hasBudget(ctx)) return unavailable('budget', null);
  try {
    const read = await readChart(ctx, apiKey, 'trials_active', from, to);
    if (!read.ok) return unavailable(read.reason, read.error.status ?? null);
    return levelSeries(read.metric.body, from, to) ?? unavailable('unreadable', null);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    return unavailable(err instanceof BudgetExhaustedError ? err.reason : err.kind, err.status ?? null);
  }
}

// ---------- revenue ----------

function toDailyPoints(
  currency: string,
  net: Map<string, number>,
  refunds: Map<string, number> | null,
  from: string,
  to: string,
): DailyRevenuePoint[] {
  const points: DailyRevenuePoint[] = [];
  for (const day of dayRange(from, to)) {
    const n = toMinor(net.get(day) ?? 0, currency);
    let refunded = refunds ? toMinor(Math.abs(refunds.get(day) ?? 0), currency) : 0;
    let gross = n + refunded;
    if (gross < 0) {
      // Refunds we couldn't see (or rounding) exceed the day's sales: keep Adapty's net exact.
      gross = 0;
      refunded = -n;
    }
    points.push({ day, currency, gross, refunds: refunded, count: 0 });
  }
  return points;
}

function cursorDay(cursor: string | null): string | null {
  if (!cursor || !DAY_RE.test(cursor) || Number.isNaN(Date.parse(`${cursor}T00:00:00Z`))) return null;
  return cursor;
}

function isRateLimit(err: unknown): boolean {
  return err instanceof ProviderError && err.kind === 'rate_limit';
}

// ---------- adapter ----------

type VerifyFailure = Extract<VerifyResult, { ok: false }>;

function verifyFailure(err: unknown): VerifyFailure | null {
  if (!(err instanceof ProviderError)) return null;
  switch (err.kind) {
    case 'auth':
      return { ok: false, error: AUTH_MESSAGE, field: 'apiKey' };
    case 'permission':
      return { ok: false, error: err.message, field: 'apiKey' };
    case 'not_found':
      return { ok: false, error: err.message };
    case 'upstream':
      // 400/422: Adapty refused the query itself; its sanitised reason helps.
      return err.status !== undefined && err.status >= 400 && err.status < 500 ? { ok: false, error: err.message } : null;
    default:
      return null; // rate_limit / 5xx / network: the generic "try again" message is right
  }
}

export const adaptyAdapter: ProviderAdapter = {
  id: 'adapty',

  async verify(input, ctx): Promise<VerifyResult> {
    const checked = checkAdaptyInput(input);
    if (!checked.ok) return { ok: false, error: checked.error, field: checked.field };
    const { apiKey } = checked;
    const today = dayKey(ctx.now());

    let mrr: { value: number; currency: string };
    try {
      mrr = await requiredLevel(ctx, apiKey, 'mrr', today);
    } catch (err) {
      const failure = verifyFailure(err);
      if (failure) return failure;
      throw err;
    }

    const config: ConnectionConfig = { reportingCurrency: mrr.currency };
    const warnings: string[] = [];

    // One revenue probe: today's revenue, the same query fetchRevenue starts with on a one-day range.
    let history: 'daily' | 'none' | 'unknown' = 'unknown';
    if (hasBudget(ctx)) {
      try {
        const probe = await readChart(ctx, apiKey, 'revenue', today, today);
        history = probe.ok && flowByDay(probe.metric.body, today, today) ? 'daily' : 'none';
        if (history === 'none') {
          ctx.log('adapty_revenue_unavailable', {
            reason: probe.ok ? 'unreadable' : probe.reason,
            status: probe.ok ? null : (probe.error.status ?? null),
          });
          warnings.push(HISTORY_UNAVAILABLE_WARNING);
        }
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        ctx.log('adapty_revenue_probe_failed', { kind: err.kind, status: err.status ?? null });
      }
    }
    if (history === 'unknown') warnings.push(HISTORY_UNKNOWN_WARNING);
    else config['revenueHistory'] = history;

    // Adapty keys belong to one app and the export API doesn't name it; sandbox purchases never reach analytics.
    return { ok: true, accountLabel: 'Adapty app', config, testMode: false, warnings };
  },

  async fetchSnapshot(input, ctx): Promise<MetricsSnapshot> {
    const apiKey = requireKey(input);
    const today = dayKey(ctx.now());

    const mrr = await requiredLevel(ctx, apiKey, 'mrr', today);
    const subs = await requiredLevel(ctx, apiKey, 'subscriptions_active', today);

    const warnings: string[] = [];
    const trialsMetric = await optionalRead(ctx, apiKey, 'trials_active', today, today, (why) =>
      warnings.push(why === 'budget' ? ADAPTY_TRIALS_SKIPPED_WARNING : ADAPTY_TRIALS_UNAVAILABLE_WARNING),
    );
    const trials = trialsMetric ? levelOn(trialsMetric.body, today) : null;
    if (trialsMetric && trials === null) {
      ctx.log('adapty_snapshot_chart_unavailable', { chart: 'trials_active', reason: 'unreadable', status: null });
      warnings.push(ADAPTY_TRIALS_UNAVAILABLE_WARNING);
    }

    // The 30-day revenue total is revenue, not one of the snapshot's figures: logged, never warned about.
    const periodMetric = await optionalRead(ctx, apiKey, 'revenue', addDays(today, -(REVENUE_PERIOD_DAYS - 1)), today);
    const periodTotal = periodMetric ? num(periodMetric.body['value']) : null;
    if (periodMetric && periodTotal === null) {
      ctx.log('adapty_snapshot_chart_unavailable', { chart: 'revenue', reason: 'unreadable', status: null });
    }

    return {
      mrr: { [mrr.currency]: Math.max(0, toMinor(mrr.value, mrr.currency)) },
      activeSubscriptions: Math.max(0, Math.round(subs.value)),
      activeTrials: trials === null ? null : Math.max(0, Math.round(trials)),
      revenuePeriod:
        periodMetric && periodTotal !== null ? { [periodMetric.currency]: toMinor(periodTotal, periodMetric.currency) } : null,
      revenuePeriodDays: periodMetric && periodTotal !== null ? REVENUE_PERIOD_DAYS : null,
      newCustomers: null,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async fetchRevenue(input, req, ctx): Promise<RevenuePage> {
    const apiKey = requireKey(input);
    const today = dayKey(ctx.now());
    let start = cursorDay(req.cursor) ?? dayKey(req.since);
    const daily: DailyRevenuePoint[] = [];
    const finished = (): RevenuePage => ({ events: [], daily, nextCursor: null, done: true });
    const paused = (reason: 'budget' | 'rate_limit'): RevenuePage => {
      ctx.log('adapty_revenue_paused', { reason, resumeFrom: start, days: daily.length });
      return { events: [], daily, nextCursor: start, done: false };
    };

    let perDay = false;
    let refundsUsable = true;
    let windows = 0;
    let refundWindows = 0;
    try {
      while (start <= today) {
        // Revenue and its refunds are read together, so a window never lands without its refunds.
        if (!hasBudget(ctx, refundsUsable ? 2 : 1)) return paused('budget');
        const endCandidate = addDays(start, (perDay ? 1 : MAX_WINDOW_DAYS) - 1);
        const end = endCandidate < today ? endCandidate : today;

        const revenue = await readChart(ctx, apiKey, 'revenue', start, end);
        if (!revenue.ok) {
          // Not usable for this app: finish quietly; the dashboard shows the snapshot's 30-day revenue instead.
          ctx.log('adapty_revenue_unavailable', { reason: revenue.reason, status: revenue.error.status ?? null });
          return finished();
        }
        const net = flowByDay(revenue.metric.body, start, end);
        if (!net) {
          ctx.log('adapty_series_unreadable', { chart: 'revenue', ...answerShape({ data: { revenue: revenue.metric.body } }) });
          if (start === end) {
            // Not even a one-day `value`: nothing to fall back to.
            ctx.log('adapty_revenue_unavailable', { reason: 'unreadable', status: null });
            return finished();
          }
          // The per-day series didn't check out: re-read this range one day at a time from `value`.
          perDay = true;
          continue;
        }

        let refunds: Map<string, number> | null = null;
        if (refundsUsable) {
          const r = await readChart(ctx, apiKey, 'refund_money', start, end);
          refunds = r.ok && r.metric.currency === revenue.metric.currency ? flowByDay(r.metric.body, start, end) : null;
          if (!refunds) {
            refundsUsable = false;
            ctx.log('adapty_refunds_unavailable', {
              reason: !r.ok ? r.reason : r.metric.currency !== revenue.metric.currency ? 'currency_mismatch' : 'unreadable',
              status: r.ok ? null : (r.error.status ?? null),
            });
          }
        }

        daily.push(...toDailyPoints(revenue.metric.currency, net, refunds, start, end));
        windows += 1;
        if (refunds) refundWindows += 1;
        start = addDays(end, 1);
      }
    } catch (err) {
      // Adapty's global cap answers 429 for up to a minute: keep what was read and resume from this window.
      if (isRateLimit(err) && daily.length > 0) return paused('rate_limit');
      throw err;
    }

    ctx.log('adapty_revenue_fetched', { windows, refundWindows, days: daily.length, perDay });
    return finished();
  },

  async fetchSnapshotHistory(input, req, ctx): Promise<SnapshotHistoryPoint[]> {
    const apiKey = requireKey(input);
    // Ahead of UTC, the owner's yesterday is Adapty's UTC today: its level so far, as fetchSnapshot reads it.
    const today = historyToday(req, ctx);
    const days = Number.isFinite(req.days) ? Math.min(HISTORY_MAX_DAYS, Math.max(0, Math.floor(req.days))) : 0;
    if (days === 0) return [];
    const from = addDays(today, -days);
    const to = addDays(today, -1);
    // Every day needs MRR and a subscription count, so don't start what the budget (or the clock) can't finish.
    if (!hasBudget(ctx, 2)) {
      ctx.log('adapty_history_skipped', { reason: 'budget' });
      return [];
    }

    let mrr: { byDay: Map<string, number>; currency: string };
    let subscriptions: { byDay: Map<string, number> };
    try {
      mrr = await requiredSeries(ctx, apiKey, 'mrr', from, to);
      subscriptions = await requiredSeries(ctx, apiKey, 'subscriptions_active', from, to);
    } catch (err) {
      // The deadline passed mid-way: MRR alone can't make a day.
      if (err instanceof BudgetExhaustedError) {
        ctx.log('adapty_history_skipped', { reason: err.reason });
        return [];
      }
      throw err;
    }
    const trials = await historyTrials(ctx, apiKey, from, to);

    const out: SnapshotHistoryPoint[] = [];
    let unmatched = 0;
    for (const day of dayRange(from, to)) {
      const value = mrr.byDay.get(day);
      const count = subscriptions.byDay.get(day);
      if (value === undefined || count === undefined) {
        // A day with only one of the two is left out: a subscription count is never made up.
        if (value !== undefined || count !== undefined) unmatched += 1;
        continue;
      }
      const t = trials?.get(day);
      out.push({
        day,
        snapshot: {
          mrr: { [mrr.currency]: Math.max(0, toMinor(value, mrr.currency)) },
          activeSubscriptions: Math.max(0, Math.round(count)),
          activeTrials: t === undefined ? null : Math.max(0, Math.round(t)),
          revenuePeriod: null,
          revenuePeriodDays: null,
          newCustomers: null,
        },
      });
    }
    ctx.log('adapty_history_fetched', { days: out.length, unmatched, trials: trials !== null });
    return out;
  },
};
