/**
 * RevenueCat adapter (REST API v2, "Charts & Metrics" domain). Owner: Data Plane. SPEC.md §6.3.
 *
 * Endpoints — https://www.revenuecat.com/docs/api-v2/charts-and-metrics
 *   GET /v2/projects/{project_id}/metrics/overview   scope charts_metrics:overview:read   verify + snapshot
 *   GET /v2/projects/{project_id}/charts/revenue     scope charts_metrics:charts:read     daily revenue + transactions
 *   GET /v2/projects/{project_id}/charts/refunds     scope charts_metrics:charts:read     daily refunded revenue
 * All three share one rate-limit domain: 25 requests/minute per key (429 carries Retry-After and `backoff_ms`,
 * both handled by fetchJson).
 *
 * Money: RevenueCat converts every purchase to USD at the purchase-date rate and reports decimal major units
 * ("Two-decimal precision"). We always request `currency=USD` and label amounts with the currency the response
 * reports (`currency` / `yaxis_currency`), converted to integer minor units with `toMinor`.
 *
 * Revenue history: the Revenue chart (Charts v3, the API default `realtime=true`) reports revenue *net of*
 * refunds and downward adjustments recorded that day, plus the count of paid transactions. The Refunds chart
 * reports exactly what Revenue subtracted, so per day:  gross = revenue + refunded,  refunds = refunded.
 * If the key can't read Charts, fetchRevenue degrades to an empty, finished page and the dashboard falls back
 * to the overview's trailing 28-day revenue.
 */

import { normalizeCurrency, toMinor, type MoneyMap } from '../lib/money';
import { addDays, dayKey, dayRange } from '../lib/time';
import { buildUrl, fetchJson, hasBudget, type QueryValue } from './http';
import {
  ProviderError,
  type ConnectionConfig,
  type ConnectionInput,
  type DailyRevenuePoint,
  type MetricsSnapshot,
  type ProviderAdapter,
  type ProviderContext,
  type RevenuePage,
  type VerifyResult,
} from './types';

const PROVIDER = 'RevenueCat';
const RC_API_BASE = 'https://api.revenuecat.com/v2';

/** Exact API v2 scope names (x-scopes in RevenueCat's OpenAPI spec). */
const RC_SCOPE_OVERVIEW = 'charts_metrics:overview:read';
const RC_SCOPE_CHARTS = 'charts_metrics:charts:read';

/** RevenueCat's own default; requested explicitly so the answer never depends on account settings. */
const REQUEST_CURRENCY = 'USD';
/** Resolution IDs come from GET /charts/{name}/options: "0" = day, "1" = week, "2" = month. */
const DAY_RESOLUTION = '0';
/** Days per chart request. A normal sync asks for a few days, the first backfill for ~91. */
const MAX_WINDOW_DAYS = 366;
/** The overview Revenue card window, used only if the payload's `period` can't be parsed. */
const DEFAULT_REVENUE_PERIOD_DAYS = 28;

const OVERVIEW_METRIC_IDS = ['mrr', 'active_subscriptions', 'active_trials', 'revenue', 'new_customers'] as const;

/** Public SDK key prefixes (Apple, Google, Amazon, Stripe, Web Billing, Test Store). They can't call API v2. */
const PUBLIC_KEY_PREFIX = /^(appl|goog|amzn|strp|rcb|test)_/i;
const SECRET_KEY_RE = /^sk_[A-Za-z0-9_-]{8,}$/;
/** API v2 IDs are 1–255 characters; project IDs look like "proj1ab2c3d4". */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CHARTS_PERMISSION_WARNING =
  "This key can’t read Charts, so hoomuch will show RevenueCat’s 28-day revenue total instead of a daily history. " +
  `To get daily revenue, give the key the ${RC_SCOPE_CHARTS} permission.`;
export const CHARTS_UNSUPPORTED_WARNING =
  "RevenueCat didn’t return a daily revenue chart for this project, so hoomuch will show RevenueCat’s 28-day revenue total instead of a daily history.";
const CHARTS_UNKNOWN_WARNING =
  "hoomuch couldn’t check RevenueCat Charts access just now. It will try again on the first sync.";

const AUTH_MESSAGE =
  "RevenueCat rejected the API key. Use a secret key created with API version v2 (v1 keys don’t work here) and check that it hasn’t been revoked.";
const PROJECT_NOT_FOUND_MESSAGE =
  "RevenueCat couldn’t find this project. Copy the Project ID from Project settings in RevenueCat (it looks like proj1ab2c3d4).";
const PROJECT_HINT = 'If it already has it, check that the key was created in this project.';
const MISSING_PREFIX_HINT = 'Project IDs start with “proj”: if you copied it from the dashboard’s address bar, add “proj” in front.';

// ---------- input ----------

interface RcInput {
  apiKey: string;
  projectId: string;
}

type InputCheck = { ok: true; value: RcInput } | { ok: false; error: string; field: 'apiKey' | 'projectId' };

/** Validates field shapes without any network call. Never echoes secret values back. */
function checkRevenueCatInput(input: ConnectionInput): InputCheck {
  const apiKey = (input.credentials['apiKey'] ?? '').trim();
  const projectId = (input.config['projectId'] ?? '').trim();
  const fail = (field: 'apiKey' | 'projectId', error: string): InputCheck => ({ ok: false, error, field });

  if (!apiKey) return fail('apiKey', 'Paste a RevenueCat secret API key (v2).');
  const pub = PUBLIC_KEY_PREFIX.exec(apiKey);
  if (pub) {
    return fail(
      'apiKey',
      `That’s a public SDK key (${pub[1]!.toLowerCase()}_…). hoomuch needs a secret API key, version v2, which starts with “sk_”.`,
    );
  }
  if (/^proj[A-Za-z0-9]+$/.test(apiKey)) {
    return fail('apiKey', 'That looks like a Project ID. Paste the secret API key here and the Project ID in its own field.');
  }
  if (!apiKey.startsWith('sk_')) {
    return fail('apiKey', 'RevenueCat secret API keys start with “sk_”. Create one under Project settings → API keys, with API version v2.');
  }
  if (!SECRET_KEY_RE.test(apiKey)) {
    return fail('apiKey', "That doesn’t look like a complete RevenueCat secret key. Copy it again from Project settings → API keys.");
  }

  if (!projectId) return fail('projectId', 'Enter your RevenueCat Project ID.');
  if (projectId.startsWith('sk_') || PUBLIC_KEY_PREFIX.test(projectId)) {
    return fail('projectId', 'This looks like an API key, not a Project ID. The Project ID is in Project settings and looks like proj1ab2c3d4.');
  }
  if (/[/:?#\s]/.test(projectId)) {
    return fail('projectId', 'Paste only the Project ID (it looks like proj1ab2c3d4), not a URL.');
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    return fail('projectId', "That doesn’t look like a RevenueCat Project ID. It’s in Project settings and looks like proj1ab2c3d4.");
  }
  return { ok: true, value: { apiKey, projectId } };
}

function requireInput(input: ConnectionInput): RcInput {
  const checked = checkRevenueCatInput(input);
  if (!checked.ok) throw new ProviderError('invalid_input', checked.error, { field: checked.field });
  return checked.value;
}

// ---------- HTTP ----------

/**
 * Every Charts & Metrics endpoint lists 423 Locked, undocumented beyond the name. Treat it as temporary:
 * no status on the error, so verify shows the generic "try again" and a resumed backfill keeps its cursor
 * (a 4xx status would read as a stale cursor and restart it).
 */
function mapLocked(status: number): ProviderError | null {
  return status === 423
    ? new ProviderError('upstream', `${PROVIDER} is busy with this project right now (HTTP 423). The next sync will retry.`)
    : null;
}

async function rcGet(
  ctx: ProviderContext,
  inp: RcInput,
  path: string,
  query: Record<string, QueryValue>,
  permission: string,
  notFoundMessage: string,
): Promise<unknown> {
  try {
    return await fetchJson<unknown>(ctx, {
      provider: PROVIDER,
      url: buildUrl(RC_API_BASE, `/projects/${encodeURIComponent(inp.projectId)}${path}`, query),
      headers: { Authorization: `Bearer ${inp.apiKey}` },
      permission,
      notFoundMessage,
      mapError: mapLocked,
    });
  } catch (err) {
    // A 404 on a project-scoped path means the Project ID is wrong; 403 stays on the key (fetchJson's default).
    if (err instanceof ProviderError && err.kind === 'not_found') {
      throw new ProviderError('not_found', err.message, { status: err.status, field: 'projectId' });
    }
    throw err;
  }
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

function currencyOf(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim()) ? normalizeCurrency(v) : null;
}

/** ISO 8601 durations as used by the overview (`P0D`, `P28D`); weeks are accepted too. Null if unparseable. */
export function isoPeriodDays(period: string | null | undefined): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?$/.exec(period ?? '');
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0);
}

function unreadable(ctx: ProviderContext, what: string): ProviderError {
  ctx.log('revenuecat_unreadable', { what });
  return new ProviderError('upstream', `${PROVIDER} returned ${what} hoomuch couldn’t read.`);
}

// ---------- overview ----------

interface OverviewMetricValue {
  value: number;
  period: string | null;
}

interface ParsedOverview {
  currency: string;
  metrics: Map<string, OverviewMetricValue>;
}

async function getOverview(ctx: ProviderContext, inp: RcInput): Promise<ParsedOverview> {
  const body = await rcGet(
    ctx,
    inp,
    '/metrics/overview',
    { currency: REQUEST_CURRENCY },
    RC_SCOPE_OVERVIEW,
    PROJECT_NOT_FOUND_MESSAGE,
  );
  if (!isRecord(body) || !Array.isArray(body['metrics'])) throw unreadable(ctx, 'overview metrics');
  const metrics = new Map<string, OverviewMetricValue>();
  for (const m of body['metrics']) {
    if (!isRecord(m) || typeof m['id'] !== 'string') continue;
    const value = num(m['value']);
    if (value === null) continue;
    metrics.set(m['id'], { value, period: typeof m['period'] === 'string' ? m['period'] : null });
  }
  return { currency: currencyOf(body['currency']) ?? REQUEST_CURRENCY, metrics };
}

/**
 * Snapshot warning (`MetricsSnapshot.warnings`). MRR and active subscriptions are required (the snapshot fails
 * without them); a missing revenue or new-customers card isn't one of the snapshot's figures, so only logged.
 */
export const RC_TRIALS_MISSING_WARNING = 'Trials aren’t shown, because RevenueCat’s overview didn’t include active trials.';

function toSnapshot(o: ParsedOverview, ctx: ProviderContext): MetricsSnapshot {
  const missing = OVERVIEW_METRIC_IDS.filter((id) => !o.metrics.has(id));
  if (missing.length > 0) ctx.log('revenuecat_overview_missing_metrics', { missing });
  // Without the two core metrics the payload is unusable: writing {} / 0 would overwrite a good
  // snapshot with a false dip. Fail the snapshot instead so the previous one stays.
  if (!o.metrics.has('mrr') || !o.metrics.has('active_subscriptions')) {
    throw unreadable(ctx, 'overview metrics without MRR or active subscriptions, which');
  }

  const money = (id: string): MoneyMap | null => {
    const m = o.metrics.get(id);
    return m ? { [o.currency]: toMinor(m.value, o.currency) } : null;
  };
  const count = (id: string): number | null => {
    const m = o.metrics.get(id);
    return m ? Math.max(0, Math.round(m.value)) : null;
  };

  const revenue = o.metrics.get('revenue');
  let revenueDays: number | null = null;
  if (revenue) {
    revenueDays = isoPeriodDays(revenue.period);
    if (revenueDays === null || revenueDays <= 0) {
      ctx.log('revenuecat_unexpected_period', { metric: 'revenue', period: revenue.period });
      revenueDays = DEFAULT_REVENUE_PERIOD_DAYS;
    }
  }

  return {
    mrr: money('mrr') ?? {},
    activeSubscriptions: count('active_subscriptions') ?? 0,
    activeTrials: count('active_trials'),
    revenuePeriod: money('revenue'),
    revenuePeriodDays: revenueDays,
    newCustomers: count('new_customers'),
    ...(o.metrics.has('active_trials') ? {} : { warnings: [RC_TRIALS_MISSING_WARNING] }),
  };
}

// ---------- charts ----------

type ChartName = 'revenue' | 'refunds';

interface DayValues {
  /** Money measure, major units (may be negative for Revenue on refund-heavy days). */
  money: number;
  /** Count measure (transactions / refunded transactions). */
  count: number;
  incomplete: boolean;
}

interface ParsedChart {
  currency: string;
  byDay: Map<string, DayValues>;
}

type ChartResult =
  | { ok: true; chart: ParsedChart }
  | { ok: false; reason: 'permission' | 'not_found' | 'rejected' | 'unreadable'; status?: number };

/** `cohort` is the period start: Unix seconds in practice; milliseconds and ISO dates are accepted too. */
function cohortDay(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const n = num(v);
  if (n === null || n < 0) return null;
  return dayKey(n > 1e11 ? n : n * 1000);
}

function measureIndex(measures: unknown[], test: (unit: string, name: string) => boolean): number | null {
  for (let i = 0; i < measures.length; i++) {
    const m = measures[i];
    if (!isRecord(m)) continue;
    const unit = typeof m['unit'] === 'string' ? m['unit'] : '';
    const name = typeof m['display_name'] === 'string' ? m['display_name'] : '';
    if (test(unit, name)) return i;
  }
  return null;
}

/** Log-safe description of a chart payload we couldn't read: types and lengths only, never values. */
function chartShape(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return { body: Array.isArray(body) ? 'array' : typeof body };
  const values = body['values'];
  const first: unknown = Array.isArray(values) ? values[0] : undefined;
  return {
    resolution: typeof body['resolution'] === 'string' ? body['resolution'] : null,
    values: Array.isArray(values) ? values.length : typeof values,
    row: Array.isArray(first) ? `array(${first.length})` : isRecord(first) ? Object.keys(first).sort().join(',') : typeof first,
  };
}

/**
 * Parses a non-segmented, day-resolution chart into per-day values. Null when the shape isn't one we know.
 * Rows are read as objects `{cohort, measure, value, incomplete}`: the shape the realtime (v3) Revenue and
 * Refunds charts return (RevenueCat's own API tooling reads them this way). The API reference only says
 * `values` items "vary by chart type" and may be arrays of numbers, with no positional schema, so array rows
 * are NOT guessed at: the chart is reported unreadable and its shape is logged.
 */
function parseDailyChart(body: unknown, from: string, to: string): ParsedChart | null {
  if (!isRecord(body) || !Array.isArray(body['values'])) return null;
  if (body['resolution'] !== undefined && body['resolution'] !== 'day') return null;

  const measures = Array.isArray(body['measures']) ? body['measures'] : [];
  const countIdx = measureIndex(measures, (unit, name) => unit === '#' || /transaction/i.test(name)) ?? 1;
  const moneyIdx =
    measureIndex(measures, (unit, name) => unit !== '#' && /revenue|proceeds/i.test(name)) ??
    measureIndex(measures, (unit) => unit !== '#') ??
    0;
  if (moneyIdx === countIdx) return null;

  const byDay = new Map<string, DayValues>();
  for (const row of body['values']) {
    if (!isRecord(row)) return null;
    const day = cohortDay(row['cohort']);
    if (!day) return null;
    const measure = row['measure'] === undefined || row['measure'] === null ? 0 : num(row['measure']);
    const value = row['value'] === null ? 0 : num(row['value']);
    if (measure === null || value === null) return null;
    if (day < from || day > to) continue;
    const entry = byDay.get(day) ?? { money: 0, count: 0, incomplete: false };
    if (measure === moneyIdx) entry.money = value;
    else if (measure === countIdx) entry.count = value;
    if (row['incomplete'] === true) entry.incomplete = true;
    byDay.set(day, entry);
  }
  return { currency: currencyOf(body['yaxis_currency']) ?? REQUEST_CURRENCY, byDay };
}

/**
 * Fetches one chart for [from, to]. Permanent "this chart isn't usable" answers (403, 404, 400/422, odd shape)
 * come back as `ok: false`; transient ones (401, 429, 5xx, network) are thrown so the sync retries later.
 */
async function fetchDailyChart(
  ctx: ProviderContext,
  inp: RcInput,
  chart: ChartName,
  from: string,
  to: string,
): Promise<ChartResult> {
  let body: unknown;
  try {
    body = await rcGet(
      ctx,
      inp,
      `/charts/${chart}`,
      // realtime=true is the API default; sent explicitly because Refunds is a realtime-only chart and the
      // v2 Revenue chart dates refunds differently, so gross = revenue + refunded only holds on v3.
      { resolution: DAY_RESOLUTION, start_date: from, end_date: to, currency: REQUEST_CURRENCY, realtime: true },
      RC_SCOPE_CHARTS,
      `${PROVIDER} has no ${chart} chart for this project.`,
    );
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.kind === 'permission') return { ok: false, reason: 'permission', status: err.status };
      if (err.kind === 'not_found') return { ok: false, reason: 'not_found', status: err.status };
      if (err.kind === 'upstream' && (err.status === 400 || err.status === 422)) {
        return { ok: false, reason: 'rejected', status: err.status };
      }
    }
    throw err;
  }
  const parsed = parseDailyChart(body, from, to);
  if (!parsed) ctx.log('revenuecat_chart_unreadable', { chart, ...chartShape(body) });
  return parsed ? { ok: true, chart: parsed } : { ok: false, reason: 'unreadable' };
}

/** Combines Revenue (net) and Refunds into contract points: gross − refunds always equals RevenueCat's revenue. */
function toDailyPoints(revenue: ParsedChart, refunds: ParsedChart | null, from: string, to: string): DailyRevenuePoint[] {
  const cur = revenue.currency;
  const points: DailyRevenuePoint[] = [];
  for (const day of dayRange(from, to)) {
    const r = revenue.byDay.get(day);
    const net = toMinor(r?.money ?? 0, cur);
    let refunded = refunds ? toMinor(Math.abs(refunds.byDay.get(day)?.money ?? 0), cur) : 0;
    let gross = net + refunded;
    if (gross < 0) {
      // Refunds/adjustments we couldn't see (or rounding) exceed the day's sales: keep the net exact.
      gross = 0;
      refunded = -net;
    }
    points.push({ day, currency: cur, gross, refunds: refunded, count: Math.max(0, Math.round(r?.count ?? 0)) });
  }
  return points;
}

function cursorDay(cursor: string | null): string | null {
  if (!cursor || !DAY_RE.test(cursor) || Number.isNaN(Date.parse(`${cursor}T00:00:00Z`))) return null;
  return cursor;
}

// ---------- adapter ----------

type VerifyFailure = Extract<VerifyResult, { ok: false }>;

/** Turns expected verify failures into form errors with RevenueCat-specific guidance; null = rethrow. */
function verifyFailure(err: unknown, projectId: string): VerifyFailure | null {
  if (!(err instanceof ProviderError)) return null;
  switch (err.kind) {
    case 'auth':
      return { ok: false, error: AUTH_MESSAGE, field: 'apiKey' };
    case 'permission':
      return { ok: false, error: `${err.message} ${PROJECT_HINT}`, field: 'apiKey' };
    case 'not_found':
      // Dashboard URLs show the ID without its "proj" prefix (e.g. /projects/1a2b3c4d/…).
      return {
        ok: false,
        error: projectId.startsWith('proj') ? PROJECT_NOT_FOUND_MESSAGE : `${PROJECT_NOT_FOUND_MESSAGE} ${MISSING_PREFIX_HINT}`,
        field: 'projectId',
      };
    case 'upstream':
      // 400/422: RevenueCat refused the request itself (e.g. a malformed Project ID); its sanitised reason helps.
      return err.status !== undefined && err.status >= 400 && err.status < 500 ? { ok: false, error: err.message } : null;
    default:
      return null; // rate_limit / 5xx / network: the generic "try again" message is right
  }
}

function accountLabel(projectId: string): string {
  const id = projectId.length > 24 ? `${projectId.slice(0, 23)}…` : projectId;
  return `RevenueCat project ${id}`;
}

export const revenueCatAdapter: ProviderAdapter = {
  id: 'revenuecat',

  async verify(input, ctx): Promise<VerifyResult> {
    const checked = checkRevenueCatInput(input);
    if (!checked.ok) return { ok: false, error: checked.error, field: checked.field };
    const inp = checked.value;

    let overview: ParsedOverview;
    try {
      overview = await getOverview(ctx, inp);
    } catch (err) {
      const failure = verifyFailure(err, inp.projectId);
      if (failure) return failure;
      throw err;
    }

    const config: ConnectionConfig = { projectId: inp.projectId, reportingCurrency: overview.currency };
    const warnings: string[] = [];

    // One cheap Charts probe: today's revenue, exactly the request fetchRevenue makes.
    let charts: 'daily' | 'none' | 'unknown' = 'unknown';
    if (hasBudget(ctx)) {
      const today = dayKey(ctx.now());
      try {
        const probe = await fetchDailyChart(ctx, inp, 'revenue', today, today);
        charts = probe.ok ? 'daily' : 'none';
        if (!probe.ok) {
          ctx.log('revenuecat_charts_unavailable', { chart: 'revenue', reason: probe.reason, status: probe.status ?? null });
          warnings.push(probe.reason === 'permission' ? CHARTS_PERMISSION_WARNING : CHARTS_UNSUPPORTED_WARNING);
        }
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        ctx.log('revenuecat_charts_probe_failed', { kind: err.kind, status: err.status ?? null });
      }
    }
    if (charts === 'unknown') warnings.push(CHARTS_UNKNOWN_WARNING);
    else config['revenueHistory'] = charts;

    return { ok: true, accountLabel: accountLabel(inp.projectId), config, testMode: false, warnings };
  },

  async fetchSnapshot(input, ctx): Promise<MetricsSnapshot> {
    const inp = requireInput(input);
    return toSnapshot(await getOverview(ctx, inp), ctx);
  },

  async fetchRevenue(input, req, ctx): Promise<RevenuePage> {
    const inp = requireInput(input);
    const today = dayKey(ctx.now());
    let start = cursorDay(req.cursor) ?? dayKey(req.since);
    const daily: DailyRevenuePoint[] = [];
    const finished = (): RevenuePage => ({ events: [], daily, nextCursor: null, done: true });

    let refundsUsable = true;
    let windows = 0;
    let refundWindows = 0;
    let incompleteDays = 0;
    while (start <= today) {
      if (!hasBudget(ctx)) {
        ctx.log('revenuecat_revenue_paused', { resumeFrom: start, days: daily.length });
        return { events: [], daily, nextCursor: start, done: false };
      }
      const endCandidate = addDays(start, MAX_WINDOW_DAYS - 1);
      const end = endCandidate < today ? endCandidate : today;

      const revenue = await fetchDailyChart(ctx, inp, 'revenue', start, end);
      if (!revenue.ok) {
        // Not usable with this key/project: finish quietly; the dashboard shows the 28-day snapshot revenue instead.
        ctx.log('revenuecat_charts_unavailable', { chart: 'revenue', reason: revenue.reason, status: revenue.status ?? null });
        return finished();
      }

      let refunds: ParsedChart | null = null;
      if (refundsUsable && hasBudget(ctx)) {
        const r = await fetchDailyChart(ctx, inp, 'refunds', start, end);
        if (r.ok && r.chart.currency === revenue.chart.currency) {
          refunds = r.chart;
        } else {
          refundsUsable = false;
          ctx.log('revenuecat_refunds_unavailable', {
            reason: r.ok ? 'currency_mismatch' : r.reason,
            status: r.ok ? null : (r.status ?? null),
          });
        }
      } else if (refundsUsable) {
        ctx.log('revenuecat_refunds_skipped', { reason: 'budget' });
      }

      daily.push(...toDailyPoints(revenue.chart, refunds, start, end));
      windows += 1;
      if (refunds) refundWindows += 1;
      // The current day is flagged incomplete (still arriving); it's kept and overwritten by later syncs.
      for (const v of revenue.chart.byDay.values()) if (v.incomplete) incompleteDays += 1;
      start = addDays(end, 1);
    }

    ctx.log('revenuecat_revenue_fetched', { windows, refundWindows, days: daily.length, incompleteDays });
    return finished();
  },
};
