/**
 * App Store Connect adapter (Sales and Trends reports). Owner: Data Plane. SPEC.md §6.13.
 *
 * Endpoint — https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports
 *   GET /v1/salesReports   gzip TSV (application/a-gzip); 404 when there is no report for that day
 *     SALES        / SUMMARY / DAILY            revenue history (one request per day)
 *     SUBSCRIPTION / SUMMARY / DAILY / 1_3      snapshot: active subscriptions, trials, MRR
 * Auth — https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
 *   Bearer JWT, ES256, signed with a *team* key's .p8 file: header `kid`, payload `iss` (Issuer ID),
 *   `iat`, `exp` (≤ 20 minutes later), `aud: appstoreconnect-v1`. Individual keys can't read Sales and
 *   Finance, so they aren't accepted. Rate limit: a rolling hourly quota per key (`X-Rate-Limit`), 429 above it.
 *
 * Money: amounts are what the customer paid (Customer Price, tax included, before Apple's commission) in
 * the customer's currency, like RevenueCat, Adapty and Superwall. Prices are per unit and Units is
 * negative on refunds, so a row is `|units| × |price|`, a refund when either is negative.
 *
 * Days: Sales and Trends days are Pacific Time and a day's report appears the next morning (by 8 a.m. PT,
 * Apple says). Each sync re-reads the last few days, so a late report is picked up by a later sync.
 * The snapshot uses the newest subscription report of the last few days.
 *
 * Privacy: the reports carry the buyer's country and, in the subscription report, a free-text State field.
 * Only amounts, currencies, counts, durations and subscription names are read from them.
 */

import { addToMoney, normalizeCurrency, normalizeToMonthly, toMinor, type BillingInterval, type MoneyMap } from '../lib/money';
import { addDays, dayKey } from '../lib/time';
import { buildUrl, fetchBytes, hasBudget } from './http';
import { importSigningKey, pemToDer, signJwt, type PemProblem } from './jwt';
import { columnIndex, decodeText, field, gunzipStream, parseCount, parseDecimal, readRows, type Row } from './reports';
import {
  ProviderError,
  type ConnectionInput,
  type DailyRevenuePoint,
  type MetricsSnapshot,
  type ProductMrr,
  type ProviderAdapter,
  type ProviderContext,
  type RevenuePage,
  type VerifyResult,
} from './types';

const PROVIDER = 'App Store Connect';
export const ASC_API_BASE = 'https://api.appstoreconnect.apple.com/v1';
const AUDIENCE = 'appstoreconnect-v1';
/** Apple rejects tokens that live longer than 20 minutes; one sync needs far less. */
const TOKEN_LIFETIME_S = 10 * 60;
/** Issued a little in the past, so a server clock slightly behind ours doesn't see a future `iat`. */
const TOKEN_BACKDATE_S = 30;

/** Days re-read on every sync, newest last: Apple publishes a day's report the next morning, PT. */
export const RECHECK_DAYS = 3;
/** Daily reports are kept for one year (Sales and Trends reports availability). */
const MAX_HISTORY_DAYS = 364;
/** How far back the snapshot looks for the newest subscription report. */
export const SUBSCRIPTION_LOOKBACK_DAYS = 4;
/** The only version of the Subscription report Apple still serves. */
const SUBSCRIPTION_REPORT_VERSION = '1_3';

const ISSUER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_RE = /^[A-Z0-9]{10}$/;
const VENDOR_RE = /^\d{5,12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const AUTH_MESSAGE =
  'App Store Connect rejected the key. Check that the Issuer ID, Key ID and .p8 file belong together, that it’s a team key (not an individual key), and that it hasn’t been revoked.';
const ROLE_MESSAGE =
  'This API key can’t read Sales and Trends. In Users and Access → Integrations, create a team key with the Sales or Finance role and paste that one.';
const VENDOR_MESSAGE =
  'App Store Connect doesn’t recognise this vendor number for this key. Copy it from Payments and Financial Reports (top left, under your name).';

// ---------- input ----------

interface AscInput {
  issuerId: string;
  keyId: string;
  vendorNumber: string;
  der: Uint8Array;
}

type AscField = 'issuerId' | 'keyId' | 'privateKey' | 'vendorNumber';
type InputCheck = { ok: true; value: AscInput } | { ok: false; error: string; field: AscField };

const PEM_MESSAGES: Record<PemProblem, string> = {
  missing:
    'Paste the whole .p8 file: open AuthKey_….p8 in a text editor and copy everything, including the BEGIN PRIVATE KEY and END PRIVATE KEY lines.',
  encrypted: 'That key is encrypted. App Store Connect .p8 files aren’t: paste the file exactly as Apple downloaded it.',
  not_pkcs8: 'That isn’t an App Store Connect .p8 key. Its first line should read -----BEGIN PRIVATE KEY-----.',
  bad_base64: 'Part of the key is missing or changed. Copy the .p8 file again, all of it.',
};

/** Validates field shapes without any network call. Never echoes the key back. */
export function checkAppStoreInput(input: ConnectionInput): InputCheck {
  const fail = (f: AscField, error: string): InputCheck => ({ ok: false, error, field: f });
  const issuerId = (input.config['issuerId'] ?? '').trim().toLowerCase();
  const rawKeyId = (input.config['keyId'] ?? '').trim();
  const pem = (input.credentials['privateKey'] ?? '').trim();
  const vendorNumber = (input.config['vendorNumber'] ?? '').replace(/\s+/g, '');

  if (!issuerId) return fail('issuerId', 'Enter the Issuer ID shown at the top of Users and Access → Integrations.');
  if (!ISSUER_RE.test(issuerId)) {
    return fail('issuerId', 'The Issuer ID looks like 57246542-96fe-1a63-e053-0824d011072a. Copy it from the top of Users and Access → Integrations.');
  }
  // A pasted file name ("AuthKey_2X9R4HXF34.p8") carries the key ID too.
  const keyId = (/AuthKey_([A-Za-z0-9]{10})(?:\.p8)?$/.exec(rawKeyId)?.[1] ?? rawKeyId).toUpperCase();
  if (!keyId) return fail('keyId', 'Enter the Key ID of the API key (10 letters and digits, e.g. 2X9R4HXF34).');
  if (ISSUER_RE.test(keyId)) return fail('keyId', 'That’s the Issuer ID. The Key ID is the 10-character code in the key’s row.');
  if (!KEY_ID_RE.test(keyId)) return fail('keyId', 'The Key ID is 10 letters and digits, e.g. 2X9R4HXF34. It’s also in the file name: AuthKey_2X9R4HXF34.p8.');

  if (!pem) return fail('privateKey', PEM_MESSAGES.missing);
  const parsed = pemToDer(pem);
  if (!parsed.ok) return fail('privateKey', PEM_MESSAGES[parsed.problem]);

  if (!vendorNumber) return fail('vendorNumber', 'Enter your vendor number from Payments and Financial Reports.');
  if (!VENDOR_RE.test(vendorNumber)) {
    return fail('vendorNumber', 'The vendor number is digits only, e.g. 81234567. It’s in Payments and Financial Reports, top left.');
  }
  return { ok: true, value: { issuerId, keyId, vendorNumber, der: parsed.der } };
}

function requireInput(input: ConnectionInput): AscInput {
  const checked = checkAppStoreInput(input);
  if (!checked.ok) throw new ProviderError('invalid_input', checked.error, { field: checked.field });
  return checked.value;
}

// ---------- auth ----------

async function bearerToken(inp: AscInput, ctx: ProviderContext): Promise<string> {
  const key = await importSigningKey(inp.der, 'ES256');
  if (!key) {
    throw new ProviderError(
      'invalid_input',
      'That key isn’t an App Store Connect API key. Download the .p8 file of a team key from Users and Access → Integrations.',
      { field: 'privateKey' },
    );
  }
  const iat = Math.floor(ctx.now() / 1000) - TOKEN_BACKDATE_S;
  return signJwt(key, 'ES256', { kid: inp.keyId }, { iss: inp.issuerId, iat, exp: iat + TOKEN_LIFETIME_S, aud: AUDIENCE });
}

// ---------- HTTP ----------

type ReportType = 'SALES' | 'SUBSCRIPTION';

/** Apple's error code for the first error in the body, e.g. "PARAMETER_ERROR.INVALID". */
function errorCode(body: unknown): string {
  const errors = (body as { errors?: unknown } | null)?.errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const code = (first as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : '';
}

function mapAppleError(status: number, body: unknown, detail: string): ProviderError | null {
  if (status === 401) return new ProviderError('auth', AUTH_MESSAGE, { status, field: 'privateKey' });
  if (status === 403) {
    if (/vendor/i.test(detail)) return new ProviderError('permission', VENDOR_MESSAGE, { status, field: 'vendorNumber' });
    return new ProviderError('permission', ROLE_MESSAGE, { status, field: 'privateKey' });
  }
  if (status === 400 && /vendor/i.test(`${detail} ${errorCode(body)}`)) {
    return new ProviderError('invalid_input', VENDOR_MESSAGE, { status, field: 'vendorNumber' });
  }
  return null;
}

/**
 * One day's report as gzip bytes, or null when Apple has none (404: nothing sold that day, or not
 * published yet). Every other failure throws.
 */
async function getReport(
  ctx: ProviderContext,
  inp: AscInput,
  token: string,
  type: ReportType,
  day: string,
): Promise<Uint8Array | null> {
  const query: Record<string, string> = {
    'filter[frequency]': 'DAILY',
    'filter[reportType]': type,
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': inp.vendorNumber,
    'filter[reportDate]': day,
  };
  // SALES is left unversioned: Apple serves its current version, and a pinned one has been refused before.
  if (type === 'SUBSCRIPTION') query['filter[version]'] = SUBSCRIPTION_REPORT_VERSION;
  try {
    return await fetchBytes(ctx, {
      provider: PROVIDER,
      url: buildUrl(ASC_API_BASE, '/salesReports', query),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/a-gzip, application/json' },
      notFoundMessage: `${PROVIDER} has no ${type === 'SALES' ? 'sales' : 'subscription'} report for ${day}.`,
      mapError: mapAppleError,
    });
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'not_found') return null;
    throw err;
  }
}

function unreadable(ctx: ProviderContext, what: string, data: Record<string, unknown> = {}): ProviderError {
  ctx.log('appstore_unreadable', { what, ...data });
  return new ProviderError('upstream', `${PROVIDER} sent a ${what} hoomuch couldn’t read.`);
}

/** Streams a gzip TSV report: `onHeader` once, then `onRow` for every data row. */
async function readReport(bytes: Uint8Array, onHeader: (header: Row) => void, onRow: (row: Row) => void): Promise<void> {
  let header: Row | null = null;
  await readRows(decodeText(gunzipStream(PROVIDER, bytes)), { delimiter: '\t', quoted: false }, (row) => {
    if (header === null) {
      header = row;
      onHeader(row);
      return;
    }
    onRow(row);
  });
}

// ---------- sales → daily revenue ----------

function cleanCurrency(raw: string): string | null {
  return /^[A-Za-z]{3}$/.test(raw) ? normalizeCurrency(raw) : null;
}

/** Turns one day's Summary Sales Report into contract points, one per customer currency. */
export async function parseSalesReport(ctx: ProviderContext, bytes: Uint8Array, day: string): Promise<DailyRevenuePoint[]> {
  const byCurrency = new Map<string, DailyRevenuePoint>();
  let iUnits = -1;
  let iPrice = -1;
  let iCurrency = -1;
  let skipped = 0;
  await readReport(
    bytes,
    (header) => {
      const col = columnIndex(header);
      iUnits = col(['Units']);
      iPrice = col(['Customer Price']);
      iCurrency = col(['Customer Currency']);
      if (iUnits < 0 || iPrice < 0 || iCurrency < 0) throw unreadable(ctx, 'sales report', { columns: header.length });
    },
    (row) => {
      const units = parseDecimal(field(row, iUnits));
      const price = parseDecimal(field(row, iPrice));
      const currency = cleanCurrency(field(row, iCurrency));
      if (units === null || price === null || !currency) {
        skipped += 1;
        return;
      }
      if (units === 0 || price === 0) return; // free downloads, updates, and zero-unit partial-refund lines
      const amount = Math.round(Math.abs(units) * toMinor(Math.abs(price), currency));
      const point = byCurrency.get(currency) ?? { day, currency, gross: 0, refunds: 0, count: 0 };
      if (units < 0 || price < 0) point.refunds += amount;
      else {
        point.gross += amount;
        point.count += Math.round(units);
      }
      byCurrency.set(currency, point);
    },
  );
  if (skipped > 0) ctx.log('appstore_sales_rows_skipped', { day, skipped });
  return [...byCurrency.values()];
}

// ---------- subscriptions → snapshot ----------

/** "7 Days", "1 Month", "3 Months", "1 Year" → billing interval. Null if it isn't one of those shapes. */
export function parseDuration(raw: string): { interval: BillingInterval; count: number } | null {
  const m = /^(\d+)\s*(day|week|month|year)s?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase() as BillingInterval;
  if (unit === 'day' && n % 7 === 0) return { interval: 'week', count: n / 7 };
  return { interval: unit, count: n };
}

const PAID_OFFER_COLUMNS = [
  ['Active Pay Up Front Introductory Offer Subscriptions'],
  ['Active Pay as You Go Introductory Offer Subscriptions'],
  ['Pay Up Front Promotional Offer Subscriptions'],
  ['Pay As You Go Promotional Offer Subscriptions'],
  ['Pay Up Front Offer Code Subscriptions'],
  ['Pay As You Go Offer Code Subscriptions'],
  ['Pay Up Front Win-Back Offers'],
  ['Pay As You Go Win-Back Offers'],
] as const;

const TRIAL_COLUMNS = [
  ['Active Free Trial Introductory Offer Subscriptions'],
  ['Free Trial Promotional Offer Subscriptions'],
  ['Free Trial Offer Code Subscriptions'],
  ['Free Trial Win-Back Offers'],
] as const;

export interface SubscriptionTotals {
  mrr: MoneyMap;
  activeSubscriptions: number;
  activeTrials: number;
  byProduct: ProductMrr[];
}

/**
 * Totals of one day's Subscription report. MRR counts standard-price subscriptions at their customer price,
 * normalised to a month by Standard Subscription Duration. Subscriptions on a paid introductory, promotional,
 * offer-code or win-back price are active but left out of MRR: the report doesn't say what they pay per
 * period. Free trials are counted as trials only.
 */
export async function parseSubscriptionReport(ctx: ProviderContext, bytes: Uint8Array): Promise<SubscriptionTotals> {
  const totals: SubscriptionTotals = { mrr: {}, activeSubscriptions: 0, activeTrials: 0, byProduct: [] };
  const products = new Map<string, ProductMrr>();
  let iName = -1;
  let iDuration = -1;
  let iPrice = -1;
  let iCurrency = -1;
  let iStandard = -1;
  let paidOffer: number[] = [];
  let trial: number[] = [];
  let skipped = 0;
  let unpriced = 0;

  await readReport(
    bytes,
    (header) => {
      const col = columnIndex(header);
      iName = col(['Subscription Name']);
      iDuration = col(['Standard Subscription Duration']);
      iPrice = col(['Customer Price']);
      iCurrency = col(['Customer Currency']);
      iStandard = col(['Active Standard Price Subscriptions']);
      paidOffer = PAID_OFFER_COLUMNS.map((names) => col(names)).filter((i) => i >= 0);
      trial = TRIAL_COLUMNS.map((names) => col(names)).filter((i) => i >= 0);
      if ([iDuration, iPrice, iCurrency, iStandard].some((i) => i < 0)) {
        throw unreadable(ctx, 'subscription report', { columns: header.length });
      }
    },
    (row) => {
      const standard = parseCount(field(row, iStandard));
      const offers = paidOffer.map((i) => parseCount(field(row, i)));
      const trials = trial.map((i) => parseCount(field(row, i)));
      if (standard === null || offers.includes(null) || trials.includes(null)) {
        skipped += 1;
        return;
      }
      const paid = standard + (offers as number[]).reduce((a, b) => a + b, 0);
      totals.activeSubscriptions += paid;
      totals.activeTrials += (trials as number[]).reduce((a, b) => a + b, 0);

      const name = field(row, iName) || null;
      const product = products.get(name ?? '') ?? { name, mrr: {}, subscriptions: 0 };
      product.subscriptions += paid;
      products.set(name ?? '', product);
      if (standard === 0) return;

      const price = parseDecimal(field(row, iPrice));
      const currency = cleanCurrency(field(row, iCurrency));
      const duration = parseDuration(field(row, iDuration));
      if (price === null || price < 0 || !currency || !duration) {
        unpriced += standard;
        return;
      }
      const monthly = normalizeToMonthly(toMinor(price, currency) * standard, duration.interval, duration.count);
      if (monthly === 0) return;
      addToMoney(totals.mrr, currency, monthly);
      addToMoney(product.mrr, currency, monthly);
    },
  );
  if (skipped > 0 || unpriced > 0) ctx.log('appstore_subscription_rows_skipped', { skipped, unpriced });
  totals.byProduct = [...products.values()]
    .filter((p) => p.subscriptions > 0 || Object.keys(p.mrr).length > 0)
    .sort((a, b) => b.subscriptions - a.subscriptions);
  return totals;
}

// ---------- adapter ----------

type VerifyFailure = Extract<VerifyResult, { ok: false }>;

function verifyFailure(err: unknown): VerifyFailure | null {
  if (!(err instanceof ProviderError)) return null;
  if (err.kind === 'auth' || err.kind === 'permission' || err.kind === 'invalid_input') {
    return { ok: false, error: err.message, field: err.field };
  }
  if (err.kind === 'upstream' && err.status !== undefined && err.status >= 400 && err.status < 500) {
    return { ok: false, error: err.message };
  }
  return null; // rate limits, 5xx and network: the generic "try again" message is right
}

function cursorDay(cursor: string | null): string | null {
  if (!cursor || !DAY_RE.test(cursor) || Number.isNaN(Date.parse(`${cursor}T00:00:00Z`))) return null;
  return cursor;
}

export const appStoreAdapter: ProviderAdapter = {
  id: 'appstore',

  async verify(input, ctx): Promise<VerifyResult> {
    const checked = checkAppStoreInput(input);
    if (!checked.ok) return { ok: false, error: checked.error, field: checked.field };
    const inp = checked.value;

    // Two days back: a report Apple has certainly published by now, if there were sales that day.
    const day = addDays(dayKey(ctx.now()), -2);
    let report: Uint8Array | null;
    try {
      report = await getReport(ctx, inp, await bearerToken(inp, ctx), 'SALES', day);
    } catch (err) {
      const failure = verifyFailure(err);
      if (failure) return failure;
      throw err;
    }

    const warnings: string[] = [];
    if (!report) {
      warnings.push(
        `Apple has no sales report for ${day}. That’s normal if nothing sold that day; if something did, check the vendor number.`,
      );
    }
    return {
      ok: true,
      accountLabel: `App Store vendor ${inp.vendorNumber}`,
      config: { issuerId: inp.issuerId, keyId: inp.keyId, vendorNumber: inp.vendorNumber },
      testMode: false, // Sales and Trends never includes sandbox purchases
      warnings,
    };
  },

  async fetchSnapshot(input, ctx): Promise<MetricsSnapshot> {
    const inp = requireInput(input);
    const token = await bearerToken(inp, ctx);
    const today = dayKey(ctx.now());
    for (let back = 1; back <= SUBSCRIPTION_LOOKBACK_DAYS; back++) {
      const day = addDays(today, -back);
      const report = await getReport(ctx, inp, token, 'SUBSCRIPTION', day);
      if (!report) continue; // not published yet: try the day before
      const t = await parseSubscriptionReport(ctx, report);
      ctx.log('appstore_snapshot', { day, subscriptions: t.activeSubscriptions, products: t.byProduct.length });
      return {
        mrr: t.mrr,
        activeSubscriptions: t.activeSubscriptions,
        activeTrials: t.activeTrials,
        revenuePeriod: null,
        revenuePeriodDays: null,
        newCustomers: null,
        mrrByProduct: t.byProduct,
      };
    }
    // Apple publishes a subscription report every day while any subscription is active, so several days
    // without one means there are none (or the vendor sells no subscriptions).
    ctx.log('appstore_snapshot', { day: null, subscriptions: 0, products: 0 });
    return {
      mrr: {},
      activeSubscriptions: 0,
      activeTrials: 0,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      mrrByProduct: [],
    };
  },

  async fetchRevenue(input, req, ctx): Promise<RevenuePage> {
    const inp = requireInput(input);
    const today = dayKey(ctx.now());
    const last = addDays(today, -1);
    const oldest = addDays(today, -MAX_HISTORY_DAYS);
    const recheck = addDays(today, -RECHECK_DAYS);
    const since = dayKey(req.since);
    let day = cursorDay(req.cursor) ?? (since < recheck ? since : recheck);
    if (day < oldest) day = oldest;

    const daily: DailyRevenuePoint[] = [];
    let token: string | null = null;
    let reports = 0;
    let missing = 0;
    while (day <= last) {
      if (!hasBudget(ctx)) {
        ctx.log('appstore_revenue_paused', { resumeFrom: day, reports, missing });
        return { events: [], daily, nextCursor: day, done: false };
      }
      token ??= await bearerToken(inp, ctx);
      let report: Uint8Array | null;
      try {
        report = await getReport(ctx, inp, token, 'SALES', day);
      } catch (err) {
        // Out of hourly quota mid-backfill: keep what was read and resume from this day next sync.
        if (err instanceof ProviderError && err.kind === 'rate_limit') {
          ctx.log('appstore_revenue_paused', { resumeFrom: day, reports, missing, reason: 'rate_limit' });
          return { events: [], daily, nextCursor: day, done: false };
        }
        throw err;
      }
      if (report) {
        daily.push(...(await parseSalesReport(ctx, report, day)));
        reports += 1;
      } else {
        missing += 1;
      }
      day = addDays(day, 1);
    }
    ctx.log('appstore_revenue_fetched', { reports, missing, points: daily.length });
    return { events: [], daily, nextCursor: null, done: true };
  },
};
