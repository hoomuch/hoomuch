import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_EVENTS_PER_PAGE,
  SCOPE_PUBLISHER,
  SCOPE_STORAGE,
  checkGooglePlayInput,
  googlePlayAdapter,
  parseBucket,
  parseIsoPeriod,
} from '../../src/providers/googleplay';
import { ProviderError, type ConnectionInput } from '../../src/providers/types';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, route, type Route } from '../fixtures/harness';
import { decodeJwt, ecKeyPair, pkcs8Pem, rsaKeyPair, utf16, zip } from '../fixtures/reports';
import salesCsv from '../fixtures/googleplay/salesreport_202611.csv?raw';
import statsPro from '../fixtures/googleplay/subscriptions_acme_pro_202611.csv?raw';
import statsPass from '../fixtures/googleplay/subscriptions_acme_pass_202611.csv?raw';
import catalog from '../fixtures/googleplay/subscriptions-list.json';
import tokenBody from '../fixtures/googleplay/token.json';
import tokenInvalid from '../fixtures/googleplay/token-invalid-grant.json';
import gcs403 from '../fixtures/googleplay/gcs-403.json';
import gcs404 from '../fixtures/googleplay/gcs-404.json';
import publisher403Disabled from '../fixtures/googleplay/publisher-403-disabled.json';
import publisher403 from '../fixtures/googleplay/publisher-403.json';

// NOW = 2026-11-05T12:00:00Z
const BUCKET = 'pubsite_prod_rev_01234567890987654321';
const EMAIL = 'hoomuch@acme-123.iam.gserviceaccount.com';
const TOKEN = '/token';
const LIST = `/storage/v1/b/${BUCKET}/o`;
const object = (name: string) => `/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`;
const CATALOG = '/androidpublisher/v3/applications/com.acme.app/subscriptions';
const PRO = 'financial-stats/subscriptions/subscriptions_com.acme.app_acme_pro_202611_country.csv';
const PASS = 'financial-stats/subscriptions/subscriptions_com.acme.app_acme_pass_202611_country.csv';

let keys: CryptoKeyPair;
let SA_JSON: string;
let PRIVATE_KEY: string;
let salesZip: Uint8Array;

beforeAll(async () => {
  keys = await rsaKeyPair();
  PRIVATE_KEY = await pkcs8Pem(keys.privateKey);
  // Like a downloaded key file: pretty-printed JSON whose private_key keeps its "\n" escapes.
  SA_JSON = JSON.stringify(
    {
      type: 'service_account',
      project_id: 'acme-123',
      private_key_id: 'abcdef0123456789abcdef0123456789abcdef01',
      private_key: PRIVATE_KEY,
      client_email: EMAIL,
      client_id: '100000000000000000001',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    null,
    2,
  );
  salesZip = await zip([{ name: 'salesreport_202611.csv', data: salesCsv }]);
});

const input = (json?: string, bucket = `gs://${BUCKET}`): ConnectionInput => ({
  credentials: { serviceAccountJson: json ?? SA_JSON },
  config: { reportsBucket: bucket },
});

const tokenRoute = () => route(TOKEN, { json: tokenBody }, { method: 'POST' });
const listing = (...names: string[]) => ({ json: { kind: 'storage#objects', items: names.map((name) => ({ name, size: '1024' })) } });

/** Bucket listing answered by prefix + glob, like Cloud Storage. */
function listRoute(objects: Record<string, string[]>): Route {
  return route(LIST, (url) => {
    const prefix = url.searchParams.get('prefix') ?? '';
    const glob = url.searchParams.get('matchGlob');
    const names = (objects[prefix] ?? []).filter((n) => !glob || new RegExp(`^${glob.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`).test(n));
    return listing(...names);
  });
}

describe('checkGooglePlayInput', () => {
  it('accepts a downloaded key file, with or without its line breaks', () => {
    expect(checkGooglePlayInput(input()).ok).toBe(true);
    expect(checkGooglePlayInput(input(SA_JSON.replace(/\n/g, ''))).ok).toBe(true);
  });

  it.each([
    ['gs://pubsite_prod_rev_01234567890987654321', BUCKET],
    ['gs://pubsite_prod_rev_01234567890987654321/sales/', BUCKET],
    ['https://console.cloud.google.com/storage/browser/pubsite_prod_rev_01234567890987654321', BUCKET],
    ['PUBSITE_PROD_REV_01234567890987654321', BUCKET],
    ['gs://my-bucket', null],
  ])('reads the bucket out of %s', (raw, want) => expect(parseBucket(raw)).toBe(want));

  it.each([
    ['only the private key', () => PRIVATE_KEY, /only the private key/],
    ['half the file', () => SA_JSON.slice(0, 200), /incomplete/],
    ['an OAuth client file', () => JSON.stringify({ installed: { client_id: 'x' } }), /OAuth client file/],
    ['another kind of JSON', () => JSON.stringify({ type: 'external_account' }), /isn’t a service account key/],
    ['a file without its email', () => JSON.stringify({ type: 'service_account', private_key: 'x' }), /client_email/],
  ])('rejects %s on the key field', (_label, make, message) => {
    const r = checkGooglePlayInput(input(make()));
    expect(r).toMatchObject({ ok: false, field: 'serviceAccountJson' });
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('rejects a URI that is not a Play reports bucket', () => {
    expect(checkGooglePlayInput(input(undefined, 'gs://my-bucket'))).toMatchObject({ ok: false, field: 'reportsBucket' });
  });
});

describe('parseIsoPeriod', () => {
  it.each([
    ['P1M', { interval: 'month', count: 1 }],
    ['P3M', { interval: 'month', count: 3 }],
    ['P1Y', { interval: 'year', count: 1 }],
    ['P1W', { interval: 'week', count: 1 }],
    ['P4W', { interval: 'week', count: 4 }],
    ['P30D', { interval: 'day', count: 30 }],
    ['P1Y6M', { interval: 'month', count: 18 }],
  ])('%s', (raw, want) => expect(parseIsoPeriod(raw)).toEqual(want));

  it('returns null for anything else', () => {
    expect(parseIsoPeriod('P')).toBeNull();
    expect(parseIsoPeriod('1M')).toBeNull();
    expect(parseIsoPeriod(undefined)).toBeNull();
  });
});

describe('access token', () => {
  it('trades an RS256 assertion for a token with a form POST', async () => {
    const { fetch, calls } = fakeFetch([tokenRoute(), route(object('sales/salesreport_202611.zip'), { status: 404, json: gcs404 })]);
    const ctx = makeCtx(fetch);
    await googlePlayAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-01T00:00:00Z'), cursor: null }, ctx);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://oauth2.googleapis.com/token');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = await decodeJwt(form.get('assertion')!, keys.publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'abcdef0123456789abcdef0123456789abcdef01' });
    // Revenue needs the bucket only: the Android Publisher scope is asked for by the snapshot alone.
    expect(jwt.payload).toMatchObject({ iss: EMAIL, scope: SCOPE_STORAGE, aud: 'https://oauth2.googleapis.com/token' });
    const { iat, exp } = jwt.payload as { iat: number; exp: number };
    expect(exp - iat).toBeLessThanOrEqual(3600);
    // The access token goes to Cloud Storage as a bearer token, and nowhere into the logs.
    expect(calls[1]!.headers['authorization']).toBe(`Bearer ${tokenBody.access_token}`);
    expectNoSecretsInLogs(ctx, [tokenBody.access_token, form.get('assertion')!, PRIVATE_KEY.slice(30, 90)]);
  });

  it('ignores token_uri in the file: the assertion only ever goes to Google', async () => {
    const tampered = JSON.stringify({ ...JSON.parse(SA_JSON), token_uri: 'https://evil.example/token' });
    const { fetch, calls } = fakeFetch([tokenRoute(), route(object('sales/salesreport_202611.zip'), { status: 404, json: gcs404 })]);
    await googlePlayAdapter.fetchRevenue(input(tampered), { since: Date.parse('2026-11-01T00:00:00Z'), cursor: null }, makeCtx(fetch));
    expect(calls.every((c) => new URL(c.url).hostname.endsWith('googleapis.com'))).toBe(true);
  });

  it('refuses a key that is not RSA before calling Google', async () => {
    const ec = await ecKeyPair();
    const json = JSON.stringify({ ...JSON.parse(SA_JSON), private_key: await pkcs8Pem(ec.privateKey) });
    const { fetch, calls } = fakeFetch([]);
    const r = await googlePlayAdapter.verify(input(json), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'serviceAccountJson' });
    expect(calls).toHaveLength(0);
  });
});

describe('verify', () => {
  const happy = () => [
    tokenRoute(),
    listRoute({ 'sales/': ['sales/salesreport_202611.zip'], 'financial-stats/subscriptions/': [PRO] }),
    route(object(PRO), { bytes: utf16(statsPro) }, { query: { alt: 'media' } }),
    route(CATALOG, { json: catalog }),
  ];

  it('checks the token, both report folders and the catalog API', async () => {
    const { fetch, calls } = fakeFetch(happy());
    const ctx = makeCtx(fetch);
    const r = await googlePlayAdapter.verify(input(), ctx);
    expect(r).toEqual({
      ok: true,
      accountLabel: 'Google Play: com.acme.app',
      config: { reportsBucket: BUCKET },
      testMode: false,
      warnings: [],
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /token',
      `GET ${LIST}`,
      `GET ${LIST}`,
      `GET ${object(PRO)}`,
      `GET ${CATALOG}`,
    ]);
    const form = new URLSearchParams(calls[0]!.body);
    const jwt = await decodeJwt(form.get('assertion')!, keys.publicKey);
    expect(jwt.payload['scope']).toBe(`${SCOPE_STORAGE} ${SCOPE_PUBLISHER}`);
    expectNoSecretsInLogs(ctx, [tokenBody.access_token, PRIVATE_KEY.slice(30, 90)]);
  });

  it('connects with a note when the bucket has no subscription statistics yet', async () => {
    const { fetch } = fakeFetch([tokenRoute(), listRoute({ 'sales/': [] })]);
    const r = await googlePlayAdapter.verify(input(), makeCtx(fetch));
    expect(r).toMatchObject({ ok: true, accountLabel: 'Google Play reports …654321' });
    if (r.ok) expect(r.warnings[0]).toMatch(/no subscription statistics yet/);
  });

  it('maps a rejected assertion to the key field', async () => {
    const { fetch } = fakeFetch([route(TOKEN, { status: 400, json: tokenInvalid }, { method: 'POST' })]);
    const r = await googlePlayAdapter.verify(input(), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'serviceAccountJson' });
    if (!r.ok) expect(r.error).toMatch(/deleted or disabled/);
  });

  it('names the service account and the Play Console permissions when the bucket says 403', async () => {
    const { fetch } = fakeFetch([tokenRoute(), route(LIST, { status: 403, json: gcs403 })]);
    const r = await googlePlayAdapter.verify(input(), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'reportsBucket' });
    if (!r.ok) {
      expect(r.error).toContain(EMAIL);
      expect(r.error).toContain('View financial data');
      expect(r.error).toContain(`gs://${BUCKET}`);
    }
  });

  it('maps a missing bucket to the bucket field', async () => {
    const { fetch } = fakeFetch([tokenRoute(), route(LIST, { status: 404, json: gcs404 })]);
    const r = await googlePlayAdapter.verify(input(), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'reportsBucket' });
  });

  it('says to turn on the Android Publisher API when it is disabled', async () => {
    const routes = happy();
    routes[3] = route(CATALOG, { status: 403, json: publisher403Disabled });
    const { fetch } = fakeFetch(routes);
    const r = await googlePlayAdapter.verify(input(), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'serviceAccountJson' });
    if (!r.ok) expect(r.error).toMatch(/Turn on the Google Play Android Developer API/);
  });

  it('asks for the app-information permission on any other catalog 403', async () => {
    const routes = happy();
    routes[3] = route(CATALOG, { status: 403, json: publisher403 });
    const { fetch } = fakeFetch(routes);
    const r = await googlePlayAdapter.verify(input(), makeCtx(fetch));
    if (!r.ok) expect(r.error).toMatch(/View app information/);
    expect(r.ok).toBe(false);
  });
});

describe('fetchSnapshot', () => {
  const statsRoutes = (files: Record<string, Uint8Array>) => [
    tokenRoute(),
    listRoute({ 'financial-stats/subscriptions/subscriptions_': Object.keys(files) }),
    ...Object.entries(files).map(([name, bytes]) => route(object(name), { bytes })),
    route(CATALOG, { json: catalog }),
  ];

  it('prices the newest day of Google’s active subscriptions with each base plan’s regional price', async () => {
    const { fetch, calls } = fakeFetch(statsRoutes({ [PRO]: utf16(statsPro), [PASS]: utf16(statsPass, { bigEndian: true }) }));
    const ctx = makeCtx(fetch);
    const s = await googlePlayAdapter.fetchSnapshot(input(), ctx);
    // US monthly (50 + 10 on an offer) × 9.99 USD; DE yearly 20 × 59.99 EUR ÷ 12; JP monthly 5 × 1,200 JPY.
    // BR has no regional price (3 unpriced); the prepaid pass is active but not recurring.
    expect(s.mrr).toEqual({ USD: 59_940, EUR: 9_998, JPY: 6_000 });
    expect(s.activeSubscriptions).toBe(50 + 10 + 20 + 5 + 3 + 4);
    expect(s.activeTrials).toBeNull();
    expect(s.mrrByProduct).toEqual([
      { name: 'Acme Pro', mrr: { USD: 59_940, EUR: 9_998, JPY: 6_000 }, subscriptions: 88 },
      { name: 'Acme Pass', mrr: {}, subscriptions: 4 },
    ]);
    const list = new URL(calls[1]!.url).searchParams;
    expect(list.get('matchGlob')).toBe('financial-stats/subscriptions/subscriptions_*_202611_country.csv');
    expect(ctx.logs.find((l) => l.event === 'googleplay_snapshot')?.data).toMatchObject({ day: '2026-11-04', unpriced: 3 });
  });

  it('falls back to last month’s statistics early in a month', async () => {
    const october = PRO.replace('202611', '202610');
    const { fetch, calls } = fakeFetch([
      tokenRoute(),
      listRoute({ 'financial-stats/subscriptions/subscriptions_': [october] }),
      route(object(october), { bytes: utf16(statsPro.replace(/2026-11-0/g, '2026-10-2')) }),
      route(CATALOG, { json: catalog }),
    ]);
    const s = await googlePlayAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(s.activeSubscriptions).toBe(88);
    const globs = calls.filter((c) => new URL(c.url).pathname === LIST).map((c) => new URL(c.url).searchParams.get('matchGlob'));
    expect(globs).toEqual([
      'financial-stats/subscriptions/subscriptions_*_202611_country.csv',
      'financial-stats/subscriptions/subscriptions_*_202610_country.csv',
    ]);
  });

  it('leaves out a product whose statistics stopped days before the others', async () => {
    const legacy = PRO.replace('acme_pro', 'legacy');
    const stale = 'Date,Package Name,Product ID,Country,Active Subscriptions,Base Plan ID\n2026-11-01,com.acme.app,legacy,US,7,monthly\n';
    const fresh = statsPro.replace(/2026-11-04/g, '2026-11-05');
    const { fetch } = fakeFetch(statsRoutes({ [PRO]: utf16(fresh), [legacy]: new TextEncoder().encode(stale) }));
    const s = await googlePlayAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(s.activeSubscriptions).toBe(88);
  });

  it('reports zero when the bucket has no subscription statistics', async () => {
    const { fetch } = fakeFetch([tokenRoute(), listRoute({})]);
    const s = await googlePlayAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(s).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: null, mrrByProduct: [] });
  });
});

describe('fetchRevenue', () => {
  const SALES = object('sales/salesreport_202611.zip');
  const since = Date.parse('2026-11-01T00:00:00Z');

  it('turns the monthly estimated sales report into charge and refund events', async () => {
    const { fetch } = fakeFetch([tokenRoute(), route(SALES, { bytes: salesZip }, { query: { alt: 'media' } })]);
    const ctx = makeCtx(fetch);
    const page = await googlePlayAdapter.fetchRevenue(input(), { since, cursor: null }, ctx);
    expect(page).toMatchObject({ done: true, nextCursor: null, daily: [] });
    expect(page.events).toEqual([
      {
        externalId: 'GPA.3301-1111-2222-33333:c:1793527200',
        occurredAt: Date.parse('2026-11-01T10:00:00Z'),
        type: 'charge',
        amount: 1_079,
        currency: 'USD',
        fee: null,
        description: 'acme_pro (monthly)',
      },
      {
        externalId: 'GPA.3302-1111-2222-44444..3:c:1793608200',
        occurredAt: Date.parse('2026-11-02T08:30:00Z'),
        type: 'charge',
        amount: 119_900,
        currency: 'EUR',
        fee: null,
        description: 'acme_pro (yearly)',
      },
      expect.objectContaining({ externalId: 'GPA.3301-1111-2222-33333:r:1793697300', type: 'refund', amount: -1_079, currency: 'USD' }),
      expect.objectContaining({ type: 'charge', amount: 1_200, currency: 'JPY', description: 'coins_100' }),
      expect.objectContaining({ externalId: 'GPA.3303-1111-2222-55555:r:1793775600', type: 'refund', amount: -200 }),
      expect.objectContaining({ externalId: 'GPA.3303-1111-2222-55555:r:1793775600:1', type: 'refund', amount: -300 }),
    ]);
    // Buyer location columns are never read into events or logs.
    const dump = JSON.stringify([page, ctx.logs]);
    for (const pii of ['Boston', '02140', 'Berlin', 'Osaka', 'M5B', 'Toronto', 'shiba']) expect(dump).not.toContain(pii);
    expect(ctx.logs.find((l) => l.event === 'googleplay_sales_rows_skipped')?.data).toMatchObject({ ignored: 1 });
  });

  it('keeps only events at or after since', async () => {
    const { fetch } = fakeFetch([tokenRoute(), route(SALES, { bytes: salesZip })]);
    const page = await googlePlayAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-03T10:00:00Z'), cursor: null }, makeCtx(fetch));
    expect(page.events.map((e) => e.occurredAt >= Date.parse('2026-11-03T10:00:00Z'))).toEqual([true, true, true]);
  });

  it('walks every month since `since`, treating a missing month as empty', async () => {
    const { fetch, calls } = fakeFetch([
      tokenRoute(),
      route(object('sales/salesreport_202609.zip'), { status: 404, json: gcs404 }),
      route(object('sales/salesreport_202610.zip'), { status: 404, json: gcs404 }),
      route(SALES, { bytes: salesZip }),
    ]);
    const page = await googlePlayAdapter.fetchRevenue(input(), { since: Date.parse('2026-09-15T00:00:00Z'), cursor: null }, makeCtx(fetch));
    expect(page.done).toBe(true);
    expect(page.events).toHaveLength(6);
    expect(calls.map((c) => decodeURIComponent(new URL(c.url).pathname).split('/').pop())).toEqual([
      'token',
      'salesreport_202609.zip',
      'salesreport_202610.zip',
      'salesreport_202611.zip',
    ]);
  });

  it('returns a month cursor when the budget runs out, and resumes there', async () => {
    const routes = [tokenRoute(), route(object('sales/salesreport_202610.zip'), { status: 404, json: gcs404 }), route(SALES, { bytes: salesZip })];
    const { fetch } = fakeFetch(routes);
    const since0 = Date.parse('2026-10-01T00:00:00Z');
    const first = await googlePlayAdapter.fetchRevenue(input(), { since: since0, cursor: null }, makeCtx(fetch, { pageBudget: 2 }));
    expect(first).toMatchObject({ done: false, events: [] });
    expect(JSON.parse(first.nextCursor!)).toEqual({ m: '202611' });
    const second = await googlePlayAdapter.fetchRevenue(input(), { since: since0, cursor: first.nextCursor }, makeCtx(fetch));
    expect(second.done).toBe(true);
    expect(second.events).toHaveLength(6);
  });

  it(`pages a month with more than ${MAX_EVENTS_PER_PAGE} events in time order`, async () => {
    const header = salesCsv.split(/\r?\n/)[0]!;
    const cols = header.split(',');
    const rows: string[] = [];
    const total = MAX_EVENTS_PER_PAGE + 7;
    for (let i = 0; i < total; i++) {
      const d: Record<string, string> = Object.fromEntries(cols.map((c) => [c, '']));
      // Written newest first: the cursor must not depend on row order.
      const ts = Math.floor(Date.parse('2026-11-02T00:00:00Z') / 1000) + (total - i) * 10;
      Object.assign(d, {
        'Order Number': `GPA.0000-0000-0000-${String(i).padStart(5, '0')}`,
        'Order Charged Timestamp': String(ts),
        'Financial Status': 'Charged',
        'SKU ID': 'acme_pro',
        'Currency of Sale': 'USD',
        'Charged Amount': '1.00',
      });
      rows.push(cols.map((c) => d[c]).join(','));
    }
    const big = await zip([{ name: 'salesreport_202611.csv', data: `${header}\n${rows.join('\n')}\n` }]);
    const { fetch } = fakeFetch([tokenRoute(), route(SALES, { bytes: big })]);
    const first = await googlePlayAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch));
    expect(first.done).toBe(false);
    expect(first.events).toHaveLength(MAX_EVENTS_PER_PAGE);
    const times = first.events.map((e) => e.occurredAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const second = await googlePlayAdapter.fetchRevenue(input(), { since, cursor: first.nextCursor }, makeCtx(fetch));
    expect(second.done).toBe(true);
    expect(second.events).toHaveLength(7);
    const ids = new Set([...first.events, ...second.events].map((e) => e.externalId));
    expect(ids.size).toBe(total);
  });

  it('fails on a file that is not a zip', async () => {
    const { fetch } = fakeFetch([tokenRoute(), route(SALES, { bytes: new TextEncoder().encode('not a zip') })]);
    const err = await googlePlayAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'upstream' });
  });

  it('reads a stored (uncompressed) zip entry too', async () => {
    const stored = await zip([{ name: 'salesreport_202611.csv', data: salesCsv, method: 0 }]);
    const { fetch } = fakeFetch([tokenRoute(), route(SALES, { bytes: stored })]);
    const page = await googlePlayAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch));
    expect(page.events).toHaveLength(6);
  });
});
