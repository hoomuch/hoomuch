/**
 * Google Play adapter (Play Console report exports + Android Publisher catalog). Owner: Data Plane. SPEC.md §6.14.
 *
 * Google Play has no revenue API. Play Console exports reports to a private Cloud Storage bucket per developer
 * account (https://support.google.com/googleplay/android-developer/answer/6135870), which a service account
 * invited in Play Console can read:
 *   sales/salesreport_YYYYMM.zip                            estimated sales: one line per order, refund, partial refund
 *   financial-stats/subscriptions/subscriptions_<package>_<product>_YYYYMM_country.csv
 *                                                           daily active subscriptions per country, base plan, offer
 * and the base plans' billing periods and prices come from the Android Publisher API:
 *   GET androidpublisher/v3/applications/{package}/subscriptions   (monetization.subscriptions.list)
 *
 * Auth — https://developers.google.com/identity/protocols/oauth2/service-account
 *   RS256 JWT assertion signed with the service account's key, traded at https://oauth2.googleapis.com/token for
 *   a one-hour access token. Scopes: devstorage.read_only for the bucket; androidpublisher (it has no read-only
 *   variant) only for the snapshot's catalog read. What the token can do is capped by the permissions the
 *   service account has in Play Console, so the form asks for view-only ones. The token is never stored.
 *
 * Revenue: transactions from the estimated sales report. Amount = Charged Amount (what the buyer paid, tax
 * included, before Google's fee), in the buyer's currency, like the other app-store providers. Refund lines are
 * negative. The monthly file is re-read on each sync; big months are delivered in pages via the cursor.
 *
 * Snapshot: Google's active-subscription count from the newest day in the subscription statistics, priced at each
 * base plan's current price in that country and normalised to a month by its billing period. Google doesn't say
 * which subscribers are in a free trial or on an offer price, so trials are unknown (null) and such subscribers
 * are counted at the base plan price; grandfathered prices are counted at today's price (SPEC §6.14).
 *
 * Privacy: the sales report carries the buyer's city, state, postcode and country, and a device model. None of
 * those are read: only order numbers, times, statuses, amounts, currencies and product ids.
 */

import { addToMoney, normalizeCurrency, normalizeToMonthly, toMinor, type BillingInterval, type MoneyMap } from '../lib/money';
import { DAY, dayKey, dayStart } from '../lib/time';
import { buildUrl, fetchBytes, fetchJson, hasBudget, sanitizeErrorText } from './http';
import { importSigningKey, pemToDer, signJwt } from './jwt';
import {
  columnIndex,
  decodeText,
  field,
  parseCount,
  parseDecimal,
  readRows,
  zipEntries,
  zipEntryStream,
  type Row,
} from './reports';
import {
  ProviderError,
  type ConnectionInput,
  type MetricsSnapshot,
  type ProductMrr,
  type ProviderAdapter,
  type ProviderContext,
  type RevenueEvent,
  type RevenuePage,
  type VerifyResult,
} from './types';

/** Where a report row with a date but no timestamp is placed within its UTC day. */
const DATE_ONLY_NOON_MS = 12 * 60 * 60 * 1000;
const PROVIDER = 'Google Play';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GCS_API_BASE = 'https://storage.googleapis.com/storage/v1';
const PUBLISHER_API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
export const SCOPE_STORAGE = 'https://www.googleapis.com/auth/devstorage.read_only';
export const SCOPE_PUBLISHER = 'https://www.googleapis.com/auth/androidpublisher';
/** Google accepts assertions that expire at most one hour after `iat`. */
const ASSERTION_LIFETIME_S = 30 * 60;

/** Most events returned by one fetchRevenue call; the rest of a month follows on the next sync. */
export const MAX_EVENTS_PER_PAGE = 5_000;
/** Pages of an object listing read before giving up (1,000 objects each). */
const MAX_LIST_PAGES = 5;
/** Pages of one app's subscription catalog read (100 products each). */
const MAX_CATALOG_PAGES = 5;
/** A product's statistics older than this many days behind the newest day are treated as stale. */
const STATS_STALE_DAYS = 3;

const BUCKET_RE = /pubsite_prod_[a-z0-9_]{4,63}/i;
const MONTH_RE = /^\d{6}$/;

// ---------- input ----------

interface GpInput {
  clientEmail: string;
  privateKeyId: string | null;
  der: Uint8Array;
  bucket: string;
}

type GpField = 'serviceAccountJson' | 'reportsBucket';
type InputCheck = { ok: true; value: GpInput } | { ok: false; error: string; field: GpField };

const PASTE_JSON =
  'Paste the whole JSON key file of the service account: open the downloaded .json file in a text editor and copy all of it.';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The bucket id inside whatever was pasted: gs://pubsite_prod_rev_…, a console URL, or the bare id. */
export function parseBucket(raw: string): string | null {
  return BUCKET_RE.exec(raw.trim())?.[0].toLowerCase() ?? null;
}

/** Validates field shapes without any network call. Never echoes the key back. */
export function checkGooglePlayInput(input: ConnectionInput): InputCheck {
  const fail = (f: GpField, error: string): InputCheck => ({ ok: false, error, field: f });
  const raw = (input.credentials['serviceAccountJson'] ?? '').trim();
  if (!raw) return fail('serviceAccountJson', PASTE_JSON);
  if (!raw.startsWith('{')) {
    return fail(
      'serviceAccountJson',
      raw.includes('PRIVATE KEY') ? `That’s only the private key. ${PASTE_JSON}` : PASTE_JSON,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('serviceAccountJson', `That JSON is incomplete. ${PASTE_JSON}`);
  }
  if (!isRecord(parsed)) return fail('serviceAccountJson', PASTE_JSON);
  if ('installed' in parsed || 'web' in parsed || parsed['type'] === 'authorized_user') {
    return fail('serviceAccountJson', 'That’s an OAuth client file, not a service account key. Create a key under the service account’s Keys tab (Add key → JSON).');
  }
  if (parsed['type'] !== 'service_account') return fail('serviceAccountJson', `That isn’t a service account key. ${PASTE_JSON}`);
  const clientEmail = typeof parsed['client_email'] === 'string' ? parsed['client_email'].trim() : '';
  const pem = typeof parsed['private_key'] === 'string' ? parsed['private_key'] : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(clientEmail) || !pem) {
    return fail('serviceAccountJson', `The key file is missing its client_email or private_key. ${PASTE_JSON}`);
  }
  const der = pemToDer(pem);
  if (!der.ok) return fail('serviceAccountJson', `The private key in that file is damaged. ${PASTE_JSON}`);
  const keyId = typeof parsed['private_key_id'] === 'string' && /^[A-Za-z0-9]{8,64}$/.test(parsed['private_key_id'])
    ? parsed['private_key_id']
    : null;

  const rawBucket = (input.config['reportsBucket'] ?? '').trim();
  if (!rawBucket) return fail('reportsBucket', 'Paste the Cloud Storage URI from Play Console → Download reports.');
  const bucket = parseBucket(rawBucket);
  if (!bucket) {
    return fail(
      'reportsBucket',
      'The Cloud Storage URI looks like gs://pubsite_prod_rev_01234567890987654321. Copy it from Play Console → Download reports → Copy Cloud Storage URI.',
    );
  }
  return { ok: true, value: { clientEmail, privateKeyId: keyId, der: der.der, bucket } };
}

function requireInput(input: ConnectionInput): GpInput {
  const checked = checkGooglePlayInput(input);
  if (!checked.ok) throw new ProviderError('invalid_input', checked.error, { field: checked.field });
  return checked.value;
}

// ---------- auth ----------

const KEY_REJECTED =
  'Google rejected the service account key: it was deleted or disabled, or the file was changed. Add a new JSON key to the service account and paste that file.';

function mapTokenError(status: number, body: unknown): ProviderError | null {
  const code = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : '';
  const description = isRecord(body) && typeof body['error_description'] === 'string' ? sanitizeErrorText(body['error_description']) : '';
  if (code === 'invalid_grant' && /signature|account not found|invalid email/i.test(description)) {
    return new ProviderError('auth', KEY_REJECTED, { status, field: 'serviceAccountJson' });
  }
  if (code === 'invalid_client' || code === 'deleted_client' || code === 'disabled_client' || code === 'unauthorized_client') {
    return new ProviderError('auth', 'Google says this service account or its key is disabled or deleted. Check it in Google Cloud → IAM & Admin → Service accounts.', {
      status,
      field: 'serviceAccountJson',
    });
  }
  if (status === 400 || status === 401) {
    return new ProviderError('auth', `Google didn’t accept the service account key${description ? `: ${description}` : '.'}`, {
      status,
      field: 'serviceAccountJson',
    });
  }
  return null;
}

/** A short-lived access token for `scopes`. One request; never logged, never stored. */
async function accessToken(ctx: ProviderContext, inp: GpInput, scopes: readonly string[]): Promise<string> {
  const key = await importSigningKey(inp.der, 'RS256');
  if (!key) {
    throw new ProviderError('invalid_input', `The private key in that file isn’t a Google service account key. ${PASTE_JSON}`, {
      field: 'serviceAccountJson',
    });
  }
  const iat = Math.floor(ctx.now() / 1000) - 30;
  const assertion = await signJwt(
    key,
    'RS256',
    inp.privateKeyId ? { kid: inp.privateKeyId } : {},
    { iss: inp.clientEmail, scope: scopes.join(' '), aud: GOOGLE_TOKEN_URL, iat, exp: iat + ASSERTION_LIFETIME_S },
  );
  const body = await fetchJson<unknown>(ctx, {
    provider: PROVIDER,
    url: GOOGLE_TOKEN_URL,
    tokenForm: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion },
    mapError: mapTokenError,
  });
  const token = isRecord(body) ? body['access_token'] : undefined;
  if (typeof token !== 'string' || token.length < 10) {
    ctx.log('googleplay_unreadable', { what: 'token response' });
    throw new ProviderError('upstream', `${PROVIDER} returned a token response hoomuch couldn’t read.`);
  }
  return token;
}

// ---------- Cloud Storage ----------

function bucketDenied(inp: GpInput): string {
  return (
    `The service account ${inp.clientEmail} can’t read gs://${inp.bucket}. In Play Console → Users and permissions, invite it with ` +
    '“View app information and download bulk reports” and “View financial data”, and check the Cloud Storage URI. ' +
    'Newly given access can take up to a day to reach the reports bucket.'
  );
}

function gcsErrors(inp: GpInput) {
  return (status: number): ProviderError | null => {
    if (status === 401) return new ProviderError('auth', 'Google rejected the access token. Try again.', { status, field: 'serviceAccountJson' });
    if (status === 403) return new ProviderError('permission', bucketDenied(inp), { status, field: 'reportsBucket' });
    return null;
  };
}

interface StorageObject {
  name: string;
  size: number;
}

/** Object names (and sizes) under `prefix`, optionally filtered by a Cloud Storage glob. */
async function listObjects(
  ctx: ProviderContext,
  inp: GpInput,
  token: string,
  prefix: string,
  opts: { matchGlob?: string; maxResults?: number; maxPages?: number } = {},
): Promise<StorageObject[]> {
  const out: StorageObject[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < (opts.maxPages ?? MAX_LIST_PAGES); page++) {
    const body: unknown = await fetchJson<unknown>(ctx, {
      provider: PROVIDER,
      url: buildUrl(GCS_API_BASE, `/b/${encodeURIComponent(inp.bucket)}/o`, {
        prefix,
        matchGlob: opts.matchGlob,
        maxResults: opts.maxResults ?? 1000,
        pageToken,
        fields: 'items(name,size),nextPageToken',
      }),
      headers: { Authorization: `Bearer ${token}` },
      notFoundMessage: `Google Cloud Storage has no bucket named ${inp.bucket}. Copy the Cloud Storage URI from Play Console → Download reports.`,
      field: 'reportsBucket',
      mapError: gcsErrors(inp),
    });
    if (!isRecord(body)) throw unreadableError(ctx, 'bucket listing');
    const items = Array.isArray(body['items']) ? body['items'] : [];
    for (const it of items) {
      if (isRecord(it) && typeof it['name'] === 'string') out.push({ name: it['name'], size: Number(it['size'] ?? 0) || 0 });
    }
    pageToken = typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null;
    if (!pageToken || (opts.maxResults !== undefined && out.length >= opts.maxResults)) break;
    if (!hasBudget(ctx)) break;
  }
  return out;
}

/** An object's bytes, or null if it doesn't exist. */
async function getObject(ctx: ProviderContext, inp: GpInput, token: string, name: string): Promise<Uint8Array | null> {
  try {
    return await fetchBytes(ctx, {
      provider: PROVIDER,
      url: buildUrl(GCS_API_BASE, `/b/${encodeURIComponent(inp.bucket)}/o/${encodeURIComponent(name)}`, { alt: 'media' }),
      headers: { Authorization: `Bearer ${token}` },
      notFoundMessage: `${PROVIDER} has no report named ${name}.`,
      mapError: gcsErrors(inp),
    });
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'not_found') return null;
    throw err;
  }
}

function unreadableError(ctx: ProviderContext, what: string, data: Record<string, unknown> = {}): ProviderError {
  ctx.log('googleplay_unreadable', { what, ...data });
  return new ProviderError('upstream', `${PROVIDER} sent a ${what} hoomuch couldn’t read.`);
}

/** Streams a CSV (UTF-8 or UTF-16): `onHeader` once, then `onRow` for each data row. */
async function readCsv(
  stream: ReadableStream<Uint8Array>,
  onHeader: (header: Row) => void,
  onRow: (row: Row) => void,
): Promise<void> {
  let header: Row | null = null;
  await readRows(decodeText(stream), { delimiter: ',', quoted: true }, (row) => {
    if (header === null) {
      header = row;
      onHeader(row);
      return;
    }
    onRow(row);
  });
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

// ---------- months ----------

/** 'YYYYMM' of an epoch-ms instant (UTC). */
function monthOf(ms: number): string {
  return dayKey(ms).slice(0, 7).replace('-', '');
}

function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(4, 6)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------- sales report → revenue events ----------

interface SalesCursor {
  /** Month being read, 'YYYYMM'. */
  m: string;
  /** Last event returned from that month, as (occurredAt, externalId); absent at a month's start. */
  t?: number;
  id?: string;
}

function encodeCursor(c: SalesCursor): string {
  return JSON.stringify(c);
}

function decodeCursor(raw: string | null): SalesCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isRecord(v) || typeof v['m'] !== 'string' || !MONTH_RE.test(v['m'])) return null;
    const t = typeof v['t'] === 'number' && Number.isFinite(v['t']) ? v['t'] : undefined;
    const id = typeof v['id'] === 'string' ? v['id'] : undefined;
    return t !== undefined && id !== undefined ? { m: v['m'], t, id } : { m: v['m'] };
  } catch {
    return null;
  }
}

function eventType(status: string): 'charge' | 'refund' | null {
  const s = status.toLowerCase();
  if (s === 'charged') return 'charge';
  if (s.includes('refund') || s.includes('chargeback')) return 'refund';
  return null;
}

/**
 * Reads one month's estimated sales report (a zip holding one CSV) into contract events, keeping those at or
 * after `since`. Lines that aren't a charge or a refund (e.g. declined or cancelled orders) are skipped.
 */
async function parseSalesZip(ctx: ProviderContext, zip: Uint8Array, since: number): Promise<RevenueEvent[]> {
  const entries = zipEntries(zip);
  const entry = entries?.find((e) => /\.csv$/i.test(e.name)) ?? entries?.[0];
  if (!entry) throw unreadableError(ctx, 'sales report', { reason: 'zip' });

  const events: RevenueEvent[] = [];
  const seen = new Map<string, number>();
  let c: Record<string, number> = {};
  let skipped = 0;
  let ignored = 0;
  await readCsv(
    zipEntryStream(PROVIDER, zip, entry),
    (header) => {
      const col = columnIndex(header);
      c = {
        order: col(['Order Number']),
        date: col(['Order Charged Date']),
        ts: col(['Order Charged Timestamp']),
        status: col(['Financial Status']),
        sku: col(['SKU ID', 'Product ID']),
        plan: col(['Base Plan or Purchase Option ID', 'Base Plan ID']),
        currency: col(['Currency of Sale']),
        charged: col(['Charged Amount']),
      };
      if ([c['order'], c['status'], c['currency'], c['charged']].some((i) => i! < 0) || (c['ts']! < 0 && c['date']! < 0)) {
        throw unreadableError(ctx, 'sales report', { columns: header.length });
      }
    },
    (row) => {
      const order = field(row, c['order']!);
      const type = eventType(field(row, c['status']!));
      if (!type) {
        ignored += 1;
        return;
      }
      const secs = parseDecimal(field(row, c['ts']!));
      const dateText = field(row, c['date']!);
      // A row with only a date sits at noon UTC, so it stays on that date in every zone within ±12 h
      // of UTC rather than sliding to the day before west of Greenwich.
      const at = secs !== null && secs > 0 ? Math.round(secs * 1000) : /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dayStart(dateText) + DATE_ONLY_NOON_MS : NaN;
      const currencyRaw = field(row, c['currency']!);
      const value = parseDecimal(field(row, c['charged']!));
      if (!order || !Number.isFinite(at) || !/^[A-Za-z]{3}$/.test(currencyRaw) || value === null) {
        skipped += 1;
        return;
      }
      if (at < since) return;
      const currency = normalizeCurrency(currencyRaw);
      const amount = toMinor(Math.abs(value), currency);
      if (amount === 0) return;
      const base = `${order}:${type === 'charge' ? 'c' : 'r'}:${Math.floor(at / 1000)}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const sku = field(row, c['sku']!);
      const plan = field(row, c['plan']!);
      events.push({
        externalId: n === 0 ? base : `${base}:${n}`,
        occurredAt: at,
        type,
        amount: type === 'charge' ? amount : -amount,
        currency,
        fee: null,
        description: sku ? (plan ? `${sku} (${plan})` : sku) : null,
      });
    },
  );
  if (skipped > 0 || ignored > 0) ctx.log('googleplay_sales_rows_skipped', { skipped, ignored });
  return events;
}

function byTimeThenId(a: RevenueEvent, b: RevenueEvent): number {
  return a.occurredAt - b.occurredAt || (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0);
}

// ---------- subscription statistics → snapshot ----------

interface StatRow {
  packageName: string;
  productId: string;
  country: string;
  basePlanId: string;
  active: number;
}

interface StatFile {
  day: string;
  rows: StatRow[];
}

/** One statistics CSV: the rows of its newest day. Null when it has no rows. */
async function parseStatsCsv(ctx: ProviderContext, bytes: Uint8Array): Promise<StatFile | null> {
  let day = '';
  let rows: StatRow[] = [];
  let c: Record<string, number> = {};
  let skipped = 0;
  await readCsv(
    bytesStream(bytes),
    (header) => {
      const col = columnIndex(header);
      c = {
        date: col(['Date']),
        pkg: col(['Package Name']),
        product: col(['Product ID']),
        country: col(['Country']),
        active: col(['Active Subscriptions']),
        plan: col(['Base Plan ID']),
      };
      if ([c['date'], c['pkg'], c['product'], c['active']].some((i) => i! < 0)) {
        throw unreadableError(ctx, 'subscription statistics file', { columns: header.length });
      }
    },
    (row) => {
      const d = field(row, c['date']!);
      const active = parseCount(field(row, c['active']!));
      const packageName = field(row, c['pkg']!);
      const productId = field(row, c['product']!);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || active === null || !packageName || !productId) {
        skipped += 1;
        return;
      }
      if (d < day) return;
      if (d > day) {
        day = d;
        rows = [];
      }
      rows.push({
        packageName,
        productId,
        country: field(row, c['country']!).toUpperCase(),
        basePlanId: field(row, c['plan']!),
        active,
      });
    },
  );
  if (skipped > 0) ctx.log('googleplay_stats_rows_skipped', { skipped });
  return day ? { day, rows } : null;
}

interface StatsResult {
  day: string;
  rows: StatRow[];
  files: number;
}

/**
 * The newest subscription statistics: this month's files, or last month's early in a month before Google has
 * written any. Null when the bucket has none (no subscription products).
 */
async function readSubscriptionStats(ctx: ProviderContext, inp: GpInput, token: string): Promise<StatsResult | null> {
  const thisMonth = monthOf(ctx.now());
  for (const month of [thisMonth, addMonths(thisMonth, -1)]) {
    const suffix = `_${month}_country.csv`;
    const objects = (
      await listObjects(ctx, inp, token, 'financial-stats/subscriptions/subscriptions_', {
        matchGlob: `financial-stats/subscriptions/subscriptions_*${suffix}`,
      })
    ).filter((o) => o.name.endsWith(suffix));
    if (objects.length === 0) continue;

    const files: StatFile[] = [];
    for (const o of objects) {
      const bytes = await getObject(ctx, inp, token, o.name);
      const parsed = bytes ? await parseStatsCsv(ctx, bytes) : null;
      if (parsed) files.push(parsed);
    }
    if (files.length === 0) continue;
    const newest = files.reduce((d, f) => (f.day > d ? f.day : d), '');
    const cutoff = dayKey(dayStart(newest) - STATS_STALE_DAYS * DAY);
    const fresh = files.filter((f) => f.day >= cutoff);
    ctx.log('googleplay_stats_read', { month, files: files.length, stale: files.length - fresh.length, day: newest });
    return { day: newest, rows: fresh.flatMap((f) => f.rows), files: fresh.length };
  }
  return null;
}

interface PlanInfo {
  /** Null for prepaid plans, which don't renew and so aren't recurring revenue. */
  period: { interval: BillingInterval; count: number } | null;
  /** Region code → price in that region's currency, minor units. */
  prices: Map<string, { currency: string; amount: number }>;
}

interface ProductInfo {
  title: string | null;
  plans: Map<string, PlanInfo>;
}

/** ISO 8601 billing period ("P1M", "P1Y", "P1W", "P3M", "P6M") → interval. Null if unsupported. */
export function parseIsoPeriod(raw: unknown): { interval: BillingInterval; count: number } | null {
  if (typeof raw !== 'string') return null;
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(raw);
  if (!m || m.slice(1).every((x) => x === undefined)) return null;
  const [y, mo, w, d] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number];
  if (y + mo + w + d <= 0) return null;
  if ((y || mo) && !w && !d) return y && !mo ? { interval: 'year', count: y } : { interval: 'month', count: y * 12 + mo };
  if (!y && !mo) {
    const days = w * 7 + d;
    return days % 7 === 0 ? { interval: 'week', count: days / 7 } : { interval: 'day', count: days };
  }
  return null;
}

function moneyMinor(raw: unknown): { currency: string; amount: number } | null {
  if (!isRecord(raw) || typeof raw['currencyCode'] !== 'string' || !/^[A-Za-z]{3}$/.test(raw['currencyCode'])) return null;
  const units = Number(raw['units'] ?? 0);
  const nanos = Number(raw['nanos'] ?? 0);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
  const currency = normalizeCurrency(raw['currencyCode']);
  const amount = toMinor(units + nanos / 1e9, currency);
  return amount >= 0 ? { currency, amount } : null;
}

function listingTitle(listings: unknown): string | null {
  if (!Array.isArray(listings)) return null;
  const all = listings.filter(isRecord).filter((l) => typeof l['title'] === 'string' && l['title'].trim() !== '');
  const pick =
    all.find((l) => l['languageCode'] === 'en-US') ?? all.find((l) => String(l['languageCode']).startsWith('en')) ?? all[0];
  return pick ? String(pick['title']).trim().slice(0, 120) : null;
}

/** Parses one page of monetization.subscriptions.list into the catalog. */
function addCatalogPage(catalog: Map<string, ProductInfo>, body: unknown): void {
  if (!isRecord(body) || !Array.isArray(body['subscriptions'])) return;
  for (const sub of body['subscriptions']) {
    if (!isRecord(sub) || typeof sub['productId'] !== 'string') continue;
    const plans = new Map<string, PlanInfo>();
    for (const bp of Array.isArray(sub['basePlans']) ? sub['basePlans'] : []) {
      if (!isRecord(bp) || typeof bp['basePlanId'] !== 'string') continue;
      const renewing = isRecord(bp['autoRenewingBasePlanType'])
        ? bp['autoRenewingBasePlanType']
        : isRecord(bp['installmentsBasePlanType'])
          ? bp['installmentsBasePlanType']
          : null;
      const prices = new Map<string, { currency: string; amount: number }>();
      for (const rc of Array.isArray(bp['regionalConfigs']) ? bp['regionalConfigs'] : []) {
        if (!isRecord(rc) || typeof rc['regionCode'] !== 'string') continue;
        const price = moneyMinor(rc['price']);
        if (price) prices.set(rc['regionCode'].toUpperCase(), price);
      }
      plans.set(bp['basePlanId'], { period: renewing ? parseIsoPeriod(renewing['billingPeriodDuration']) : null, prices });
    }
    catalog.set(sub['productId'], { title: listingTitle(sub['listings']), plans });
  }
}

function publisherErrors(packageName: string) {
  return (status: number, _body: unknown, detail: string): ProviderError | null => {
    if (status === 401) return new ProviderError('auth', 'Google rejected the access token. Try again.', { status, field: 'serviceAccountJson' });
    if (status === 403) {
      if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(detail)) {
        return new ProviderError(
          'permission',
          'Turn on the Google Play Android Developer API in the service account’s Google Cloud project (APIs & Services → Library), then try again.',
          { status, field: 'serviceAccountJson' },
        );
      }
      return new ProviderError(
        'permission',
        `The service account can’t read the subscriptions of ${packageName}. In Play Console → Users and permissions, give it “View app information and download bulk reports”.`,
        { status, field: 'serviceAccountJson' },
      );
    }
    return null;
  };
}

/** One app's subscription catalog. Null if the app is gone (404). */
async function readCatalog(
  ctx: ProviderContext,
  token: string,
  packageName: string,
  maxPages = MAX_CATALOG_PAGES,
): Promise<Map<string, ProductInfo> | null> {
  const catalog = new Map<string, ProductInfo>();
  let pageToken: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    let body: unknown;
    try {
      body = await fetchJson<unknown>(ctx, {
        provider: PROVIDER,
        url: buildUrl(PUBLISHER_API_BASE, `/applications/${encodeURIComponent(packageName)}/subscriptions`, {
          pageSize: 100,
          pageToken,
        }),
        headers: { Authorization: `Bearer ${token}` },
        mapError: publisherErrors(packageName),
      });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return null;
      throw err;
    }
    addCatalogPage(catalog, body);
    pageToken = isRecord(body) && typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null;
    if (!pageToken || !hasBudget(ctx)) break;
  }
  return catalog;
}

interface StatsTotals {
  mrr: MoneyMap;
  activeSubscriptions: number;
  byProduct: ProductMrr[];
  unpriced: number;
}

/** Prices statistics rows with the catalog. Exported for tests. */
function priceStats(rows: readonly StatRow[], catalogs: ReadonlyMap<string, ReadonlyMap<string, ProductInfo> | null>): StatsTotals {
  const totals: StatsTotals = { mrr: {}, activeSubscriptions: 0, byProduct: [], unpriced: 0 };
  const products = new Map<string, ProductMrr>();
  for (const r of rows) {
    if (r.active <= 0) continue;
    totals.activeSubscriptions += r.active;
    const info = catalogs.get(r.packageName)?.get(r.productId) ?? null;
    const key = `${r.packageName}\u0000${r.productId}`;
    const product = products.get(key) ?? { name: info?.title ?? r.productId, mrr: {}, subscriptions: 0 };
    product.subscriptions += r.active;
    products.set(key, product);

    let plan = info?.plans.get(r.basePlanId) ?? null;
    if (!plan && info && !r.basePlanId) {
      // Older rows can lack a base plan id; that's unambiguous only when the product has one renewing plan.
      const renewing = [...info.plans.values()].filter((p) => p.period);
      if (renewing.length === 1) plan = renewing[0]!;
    }
    if (plan && !plan.period) continue; // prepaid: active, but not recurring revenue
    const price = plan?.prices.get(r.country) ?? null;
    if (!plan?.period || !price) {
      totals.unpriced += r.active;
      continue;
    }
    const monthly = normalizeToMonthly(price.amount * r.active, plan.period.interval, plan.period.count);
    if (monthly === 0) continue;
    addToMoney(totals.mrr, price.currency, monthly);
    addToMoney(product.mrr, price.currency, monthly);
  }
  totals.byProduct = [...products.values()].sort((a, b) => b.subscriptions - a.subscriptions);
  return totals;
}

// ---------- adapter ----------

type VerifyFailure = Extract<VerifyResult, { ok: false }>;

function verifyFailure(err: unknown): VerifyFailure | null {
  if (!(err instanceof ProviderError)) return null;
  if (err.kind === 'auth' || err.kind === 'permission' || err.kind === 'invalid_input' || err.kind === 'not_found') {
    return { ok: false, error: err.message, field: err.field };
  }
  if (err.kind === 'upstream' && err.status !== undefined && err.status >= 400 && err.status < 500) {
    return { ok: false, error: err.message };
  }
  return null;
}

function zeroSnapshot(): MetricsSnapshot {
  return {
    mrr: {},
    activeSubscriptions: 0,
    activeTrials: null,
    revenuePeriod: null,
    revenuePeriodDays: null,
    newCustomers: null,
    mrrByProduct: [],
  };
}

export const googlePlayAdapter: ProviderAdapter = {
  id: 'googleplay',

  async verify(input, ctx): Promise<VerifyResult> {
    const checked = checkGooglePlayInput(input);
    if (!checked.ok) return { ok: false, error: checked.error, field: checked.field };
    const inp = checked.value;
    const warnings: string[] = [];
    let packageName: string | null = null;

    try {
      const token = await accessToken(ctx, inp, [SCOPE_STORAGE, SCOPE_PUBLISHER]);
      // The financial reports folder: proves the bucket and the "View financial data" permission.
      await listObjects(ctx, inp, token, 'sales/', { maxResults: 1, maxPages: 1 });
      const stats = await listObjects(ctx, inp, token, 'financial-stats/subscriptions/', { maxResults: 1, maxPages: 1 });
      if (stats.length === 0) {
        warnings.push('This bucket has no subscription statistics yet, so MRR shows 0 until Google exports some (a few days after the first subscription).');
      } else if (stats[0] && hasBudget(ctx, 2)) {
        // One statistics file names an app; reading its catalog checks the Android Publisher API is reachable.
        const bytes = await getObject(ctx, inp, token, stats[0].name);
        const parsed = bytes ? await parseStatsCsv(ctx, bytes) : null;
        packageName = parsed?.rows[0]?.packageName ?? null;
        if (packageName) await readCatalog(ctx, token, packageName, 1);
      }
    } catch (err) {
      const failure = verifyFailure(err);
      if (failure) return failure;
      throw err;
    }

    return {
      ok: true,
      accountLabel: packageName ? `Google Play: ${packageName}` : `Google Play reports …${inp.bucket.slice(-6)}`,
      config: { reportsBucket: inp.bucket },
      testMode: false, // license-tester purchases aren't in the financial reports
      warnings,
    };
  },

  async fetchSnapshot(input, ctx): Promise<MetricsSnapshot> {
    const inp = requireInput(input);
    const token = await accessToken(ctx, inp, [SCOPE_STORAGE, SCOPE_PUBLISHER]);
    const stats = await readSubscriptionStats(ctx, inp, token);
    if (!stats) {
      ctx.log('googleplay_snapshot', { day: null, subscriptions: 0 });
      return zeroSnapshot();
    }
    const catalogs = new Map<string, Map<string, ProductInfo> | null>();
    for (const pkg of new Set(stats.rows.map((r) => r.packageName))) {
      catalogs.set(pkg, await readCatalog(ctx, token, pkg));
    }
    const t = priceStats(stats.rows, catalogs);
    ctx.log('googleplay_snapshot', {
      day: stats.day,
      files: stats.files,
      apps: catalogs.size,
      subscriptions: t.activeSubscriptions,
      unpriced: t.unpriced,
    });
    return {
      mrr: t.mrr,
      activeSubscriptions: t.activeSubscriptions,
      activeTrials: null,
      revenuePeriod: null,
      revenuePeriodDays: null,
      newCustomers: null,
      mrrByProduct: t.byProduct,
    };
  },

  async fetchRevenue(input, req, ctx): Promise<RevenuePage> {
    const inp = requireInput(input);
    const lastMonth = monthOf(ctx.now());
    const cursor = decodeCursor(req.cursor);
    let month = cursor?.m ?? monthOf(req.since);
    if (month > lastMonth) month = lastMonth;
    const events: RevenueEvent[] = [];
    let token: string | null = null;
    let files = 0;

    while (month <= lastMonth) {
      if (!hasBudget(ctx, token ? 1 : 2)) {
        ctx.log('googleplay_revenue_paused', { resumeFrom: month, events: events.length });
        return { events, daily: [], nextCursor: encodeCursor({ m: month }), done: false };
      }
      token ??= await accessToken(ctx, inp, [SCOPE_STORAGE]);
      const zip = await getObject(ctx, inp, token, `sales/salesreport_${month}.zip`);
      let monthEvents = zip ? await parseSalesZip(ctx, zip, req.since) : [];
      if (zip) files += 1;
      if (cursor?.m === month && cursor.t !== undefined && cursor.id !== undefined) {
        const after = { occurredAt: cursor.t, externalId: cursor.id } as RevenueEvent;
        monthEvents = monthEvents.filter((e) => byTimeThenId(e, after) > 0);
      }
      monthEvents.sort(byTimeThenId);
      const room = MAX_EVENTS_PER_PAGE - events.length;
      if (monthEvents.length > room) {
        const page = monthEvents.slice(0, room);
        events.push(...page);
        const last = page[page.length - 1];
        ctx.log('googleplay_revenue_paused', { resumeFrom: month, events: events.length, reason: 'page_full' });
        return {
          events,
          daily: [],
          nextCursor: encodeCursor(last ? { m: month, t: last.occurredAt, id: last.externalId } : { m: month }),
          done: false,
        };
      }
      events.push(...monthEvents);
      month = addMonths(month, 1);
    }
    ctx.log('googleplay_revenue_fetched', { files, events: events.length });
    return { events, daily: [], nextCursor: null, done: true };
  },
};
