import { beforeAll, describe, expect, it } from 'vitest';
import {
  RECHECK_DAYS,
  SUBSCRIPTION_LOOKBACK_DAYS,
  appStoreAdapter,
  checkAppStoreInput,
  parseDuration,
} from '../../src/providers/appstore';
import { ProviderError, type ConnectionInput } from '../../src/providers/types';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, route, type RecordedCall } from '../fixtures/harness';
import { decodeJwt, ecKeyPair, gzip, pkcs8Pem, rsaKeyPair } from '../fixtures/reports';
import salesTsv from '../fixtures/appstore/sales-summary.tsv?raw';
import subscriptionTsv from '../fixtures/appstore/subscription.tsv?raw';
import err400Vendor from '../fixtures/appstore/error-400-vendor.json';
import err401 from '../fixtures/appstore/error-401.json';
import err403 from '../fixtures/appstore/error-403.json';
import err404 from '../fixtures/appstore/error-404.json';
import err429 from '../fixtures/appstore/error-429.json';

const PATH = '/v1/salesReports';
const ISSUER = '57246542-96fe-1a63-e053-0824d011072a';
const KEY_ID = '2X9R4HXF34';
const VENDOR = '81234567';
// NOW = 2026-11-05T12:00:00Z

let keys: CryptoKeyPair;
let PEM: string;
let salesGz: Uint8Array;
let subscriptionGz: Uint8Array;

beforeAll(async () => {
  keys = await ecKeyPair();
  PEM = await pkcs8Pem(keys.privateKey);
  salesGz = await gzip(salesTsv);
  subscriptionGz = await gzip(subscriptionTsv);
});

const input = (overrides: Partial<Record<'issuerId' | 'keyId' | 'privateKey' | 'vendorNumber', string>> = {}): ConnectionInput => ({
  credentials: { privateKey: overrides.privateKey ?? PEM },
  config: {
    issuerId: overrides.issuerId ?? ISSUER,
    keyId: overrides.keyId ?? KEY_ID,
    vendorNumber: overrides.vendorNumber ?? VENDOR,
  },
});

const report = (type: 'SALES' | 'SUBSCRIPTION', day?: string) => ({
  'filter[frequency]': 'DAILY',
  'filter[reportType]': type,
  'filter[reportSubType]': 'SUMMARY',
  'filter[vendorNumber]': VENDOR,
  ...(day ? { 'filter[reportDate]': day } : {}),
});

const daysOf = (calls: RecordedCall[]) => calls.map((c) => new URL(c.url).searchParams.get('filter[reportDate]'));

describe('checkAppStoreInput', () => {
  it('accepts a well-formed team key and normalises the fields', () => {
    const r = checkAppStoreInput(input({ issuerId: ISSUER.toUpperCase(), keyId: 'AuthKey_2x9r4hxf34.p8', vendorNumber: '8123 4567' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ issuerId: ISSUER, keyId: KEY_ID, vendorNumber: VENDOR });
  });

  it('accepts a .p8 whose line breaks an <input> removed, or with \\n escapes', () => {
    expect(checkAppStoreInput(input({ privateKey: PEM.replace(/\n/g, '') })).ok).toBe(true);
    expect(checkAppStoreInput(input({ privateKey: PEM.replace(/\n/g, '\\n') })).ok).toBe(true);
  });

  it.each([
    [{ issuerId: '' }, 'issuerId'],
    [{ issuerId: 'not-a-uuid' }, 'issuerId'],
    [{ keyId: ISSUER }, 'keyId'],
    [{ keyId: 'SHORT' }, 'keyId'],
    [{ privateKey: 'hello' }, 'privateKey'],
    [{ privateKey: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----' }, 'privateKey'],
    [{ privateKey: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' }, 'privateKey'],
    [{ vendorNumber: 'acme' }, 'vendorNumber'],
  ] as const)('rejects %j on its field', (overrides, field) => {
    const r = checkAppStoreInput(input(overrides));
    expect(r).toMatchObject({ ok: false, field });
  });

  it('never echoes the key in an error', () => {
    const r = checkAppStoreInput(input({ privateKey: `${PEM.slice(0, 80)}` }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain(PEM.slice(28, 60));
  });
});

describe('parseDuration', () => {
  it.each([
    ['7 Days', { interval: 'week', count: 1 }],
    ['1 Month', { interval: 'month', count: 1 }],
    ['2 Months', { interval: 'month', count: 2 }],
    ['6 Months', { interval: 'month', count: 6 }],
    ['1 Year', { interval: 'year', count: 1 }],
    ['3 days', { interval: 'day', count: 3 }],
  ])('%s', (raw, want) => expect(parseDuration(raw)).toEqual(want));

  it('returns null for anything else', () => {
    expect(parseDuration('monthly')).toBeNull();
    expect(parseDuration('0 Months')).toBeNull();
  });
});

describe('verify', () => {
  it('signs an ES256 team-key token and reads a recent sales report', async () => {
    const { fetch, calls } = fakeFetch([route(PATH, { bytes: salesGz }, { query: report('SALES', '2026-11-03'), absent: ['filter[version]'] })]);
    const ctx = makeCtx(fetch);
    const r = await appStoreAdapter.verify(input(), ctx);
    expect(r).toEqual({
      ok: true,
      accountLabel: `App Store vendor ${VENDOR}`,
      config: { issuerId: ISSUER, keyId: KEY_ID, vendorNumber: VENDOR },
      testMode: false,
      warnings: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    const token = calls[0]!.headers['authorization']!.replace(/^Bearer /, '');
    const jwt = await decodeJwt(token, keys.publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: 'ES256', typ: 'JWT', kid: KEY_ID });
    expect(jwt.payload).toMatchObject({ iss: ISSUER, aud: 'appstoreconnect-v1' });
    const { iat, exp } = jwt.payload as { iat: number; exp: number };
    expect(exp - iat).toBeLessThanOrEqual(20 * 60);
    expect(exp * 1000).toBeGreaterThan(ctx.now());
    expectNoSecretsInLogs(ctx, [PEM.slice(30, 90), token]);
  });

  it('connects with a note when Apple has no report for that day', async () => {
    const { fetch } = fakeFetch([route(PATH, { status: 404, json: err404 })]);
    const r = await appStoreAdapter.verify(input(), makeCtx(fetch));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings[0]).toMatch(/no sales report for 2026-11-03/);
  });

  it('maps 401 to the key, explaining what belongs together', async () => {
    const { fetch } = fakeFetch([route(PATH, { status: 401, json: err401 })]);
    const r = await appStoreAdapter.verify(input(), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'privateKey' });
    if (!r.ok) expect(r.error).toMatch(/Issuer ID, Key ID and \.p8/);
  });

  it('maps 403 to the role the key needs', async () => {
    const { fetch } = fakeFetch([route(PATH, { status: 403, json: err403 })]);
    const r = await appStoreAdapter.verify(input(), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'privateKey' });
    if (!r.ok) expect(r.error).toMatch(/Sales or Finance role/);
  });

  it('maps a vendor-number 400 to the vendor field', async () => {
    const { fetch } = fakeFetch([route(PATH, { status: 400, json: err400Vendor })]);
    const r = await appStoreAdapter.verify(input(), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'vendorNumber' });
  });

  it('refuses a key that is not EC P-256 before calling Apple', async () => {
    const rsa = await rsaKeyPair();
    const { fetch, calls } = fakeFetch([]);
    const r = await appStoreAdapter.verify(input({ privateKey: await pkcs8Pem(rsa.privateKey) }), makeCtx(fetch));
    expect(r).toMatchObject({ ok: false, field: 'privateKey' });
    expect(calls).toHaveLength(0);
  });

  it('rethrows 5xx so the form shows the generic try-again message', async () => {
    const { fetch } = fakeFetch([route(PATH, { status: 503, body: 'unavailable' })]);
    await expect(appStoreAdapter.verify(input(), makeCtx(fetch))).rejects.toMatchObject({ kind: 'upstream', status: 503 });
  });
});

describe('fetchSnapshot', () => {
  it('reads the newest subscription report and prices standard subscriptions by duration', async () => {
    const { fetch, calls } = fakeFetch([
      route(PATH, { status: 404, json: err404 }, { query: { ...report('SUBSCRIPTION', '2026-11-04'), 'filter[version]': '1_3' } }),
      route(PATH, { bytes: subscriptionGz }, { query: { ...report('SUBSCRIPTION', '2026-11-03'), 'filter[version]': '1_3' } }),
    ]);
    const ctx = makeCtx(fetch);
    const s = await appStoreAdapter.fetchSnapshot(input(), ctx);
    // 100 × 9.99 USD monthly + 10 × 2.99 USD weekly (×52/12); 24 × 59.99 EUR yearly; 3 × 1,200 JPY per 3 months.
    expect(s.mrr).toEqual({ USD: 99_900 + 12_957, EUR: 11_998, JPY: 1_200 });
    // Standard 100 + 24 + 10 + 3, plus 5 on a paid pay-as-you-go introductory price.
    expect(s.activeSubscriptions).toBe(142);
    expect(s.activeTrials).toBe(22);
    expect(s.revenuePeriod).toBeNull();
    expect(s.mrrByProduct).toEqual([
      { name: 'Acme Pro', mrr: { USD: 112_857, EUR: 11_998 }, subscriptions: 134 },
      { name: 'Acme Lite', mrr: { JPY: 1_200 }, subscriptions: 8 },
    ]);
    expect(daysOf(calls)).toEqual(['2026-11-04', '2026-11-03']);
    expect(JSON.stringify(ctx.logs)).not.toMatch(/"CA"|"NY"/);
  });

  it(`reports zero subscriptions after ${SUBSCRIPTION_LOOKBACK_DAYS} days without a subscription report`, async () => {
    const { fetch, calls } = fakeFetch([route(PATH, { status: 404, json: err404 })]);
    const s = await appStoreAdapter.fetchSnapshot(input(), makeCtx(fetch));
    expect(s).toMatchObject({ mrr: {}, activeSubscriptions: 0, activeTrials: 0, mrrByProduct: [] });
    expect(daysOf(calls)).toEqual(['2026-11-04', '2026-11-03', '2026-11-02', '2026-11-01']);
  });

  it('fails instead of writing a false snapshot when the report has unknown columns', async () => {
    const { fetch } = fakeFetch([route(PATH, { bytes: await gzip('Foo\tBar\n1\t2\n') })]);
    await expect(appStoreAdapter.fetchSnapshot(input(), makeCtx(fetch))).rejects.toMatchObject({ kind: 'upstream' });
  });
});

describe('fetchRevenue', () => {
  const since = Date.parse('2026-10-31T00:00:00Z');

  it('turns daily sales reports into points per customer currency', async () => {
    const { fetch, calls } = fakeFetch([
      route(PATH, { bytes: salesGz }, { query: report('SALES', '2026-11-03') }),
      route(PATH, { status: 404, json: err404 }),
    ]);
    const ctx = makeCtx(fetch);
    const page = await appStoreAdapter.fetchRevenue(input(), { since, cursor: null }, ctx);
    expect(page.done).toBe(true);
    expect(page.nextCursor).toBeNull();
    expect(page.events).toEqual([]);
    // Free downloads and updates (price 0) and the zero-unit partial refund line are left out.
    expect(page.daily).toEqual([
      { day: '2026-11-03', currency: 'USD', gross: 297 + 798, refunds: 99, count: 5 },
      { day: '2026-11-03', currency: 'EUR', gross: 3_996, refunds: 999, count: 4 },
      { day: '2026-11-03', currency: 'JPY', gross: 480, refunds: 0, count: 1 },
    ]);
    expect(daysOf(calls)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(calls.every((c) => !new URL(c.url).searchParams.has('filter[version]'))).toBe(true);
  });

  it(`re-reads the last ${RECHECK_DAYS} days even when since is later, so late reports are picked up`, async () => {
    const { fetch, calls } = fakeFetch([route(PATH, { status: 404, json: err404 })]);
    await appStoreAdapter.fetchRevenue(input(), { since: Date.parse('2026-11-04T06:00:00Z'), cursor: null }, makeCtx(fetch));
    expect(daysOf(calls)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
  });

  it('pauses with a day cursor when the budget runs out, and resumes from it', async () => {
    const { fetch, calls } = fakeFetch([route(PATH, { status: 404, json: err404 })]);
    const first = await appStoreAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch, { pageBudget: 2 }));
    expect(first).toMatchObject({ done: false, nextCursor: '2026-11-02' });
    await appStoreAdapter.fetchRevenue(input(), { since, cursor: first.nextCursor }, makeCtx(fetch));
    expect(daysOf(calls)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  });

  it('keeps what it read and returns a cursor when Apple rate-limits mid-backfill', async () => {
    const { fetch } = fakeFetch([
      route(PATH, { bytes: salesGz }, { query: report('SALES', '2026-10-31') }),
      route(PATH, { status: 429, json: err429 }),
    ]);
    const page = await appStoreAdapter.fetchRevenue(input(), { since, cursor: null }, makeCtx(fetch));
    expect(page).toMatchObject({ done: false, nextCursor: '2026-11-01' });
    expect(page.daily.map((p) => p.day)).toEqual(['2026-10-31', '2026-10-31', '2026-10-31']);
  });

  it('never asks for more than a year back', async () => {
    const { fetch, calls } = fakeFetch([route(PATH, { status: 404, json: err404 })]);
    const page = await appStoreAdapter.fetchRevenue(input(), { since: Date.parse('2024-01-01T00:00:00Z'), cursor: null }, makeCtx(fetch, { pageBudget: 1 }));
    expect(daysOf(calls)).toEqual(['2025-11-06']);
    expect(page.nextCursor).toBe('2025-11-07');
  });

  it('throws invalid_input without a network call when the stored fields are broken', async () => {
    const { fetch, calls } = fakeFetch([]);
    const err = await appStoreAdapter.fetchRevenue(input({ keyId: '' }), { since, cursor: null }, makeCtx(fetch)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'invalid_input', field: 'keyId' });
    expect(calls).toHaveLength(0);
  });
});
