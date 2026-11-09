/**
 * Good defaults that remember: the display currency starts as the one most MRR is in (until the
 * user picks one), and the dashboard range and transactions filter come back on the next visit
 * (design/system.md §7, §3 of the audit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { dominantMrrCurrency } from '../../src/data/currency';
import { getCurrencySource, getUserById, setInferredCurrency, updateUserCurrency } from '../../src/db/queries';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY } from '../../src/lib/time';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { htmlOf } from '../fixtures/html';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
let t: TestD1;
let pending: Promise<unknown>[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
  t.exec('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)', '2026-11-04', 'USD', JSON.stringify({ EUR: 0.9, GBP: 0.8, JPY: 150 }), NOW);
});

afterEach(async () => {
  // Background work (waitUntil) must finish inside this test, not leak into the next one.
  await Promise.allSettled(pending);
  pending = [];
  vi.useRealTimers();
});

function snap(connectionId: string, mrr: Record<string, number>, day = '2026-11-05'): void {
  t.exec(
    'INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
    connectionId,
    day,
    JSON.stringify(mrr),
    1,
    0,
    NOW,
  );
}

function get(path: string, cookies: string[] = []): Promise<Response> {
  const req = new Request(`${ORIGIN}${path}`, { headers: { cookie: [`__Host-hm_session=${TOKEN}`, ...cookies].join('; ') } });
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  return worker.fetch!(req as never, testEnv(t.db), ctx as never) as Promise<Response>;
}

/** "name=value" for a cookie the response sets. */
function cookie(res: Response, base: string): string | null {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`__Host-${base}=`));
  return c ? c.split(';')[0]! : null;
}

describe('display currency', () => {
  it('picks the currency most real MRR is in, compared at today’s rates, ignoring demo data', async () => {
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', lastSyncedAt: NOW });
    seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat', lastSyncedAt: NOW });
    seedConnection(t, { id: 'demo', userId: 'u1', provider: 'demo', lastSyncedAt: NOW });
    snap('ls', { EUR: 400_000 }); // ≈ $4,444
    snap('rc', { USD: 300_000 });
    snap('demo', { USD: 9_000_000 }); // fake money doesn't vote
    expect(await dominantMrrCurrency(testEnv(t.db), 'u1')).toBe('EUR');
  });

  it('compares currencies in real money, not raw minor units (JPY has no decimals)', async () => {
    seedConnection(t, { id: 'jp', userId: 'u1', provider: 'revenuecat', lastSyncedAt: NOW });
    seedConnection(t, { id: 'us', userId: 'u1', provider: 'stripe', lastSyncedAt: NOW });
    snap('jp', { JPY: 600_000 }); // ¥600,000 ≈ $4,000: more minor units, less money
    snap('us', { USD: 500_000 }); // $5,000
    expect(await dominantMrrCurrency(testEnv(t.db), 'u1')).toBe('USD');
    t.exec("UPDATE snapshots SET mrr = ? WHERE connection_id = 'jp'", JSON.stringify({ JPY: 1_000_000 })); // ≈ $6,667
    expect(await dominantMrrCurrency(testEnv(t.db), 'u1')).toBe('JPY');
  });

  it('keeps the default when currencies can’t be compared or nothing has synced', async () => {
    expect(await dominantMrrCurrency(testEnv(t.db), 'u1')).toBeNull();
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe', lastSyncedAt: NOW });
    snap('a', { USD: 100_000, XAF: 900_000 }); // no XAF rate
    expect(await dominantMrrCurrency(testEnv(t.db), 'u1')).toBeNull();
  });

  it('sets it once on the dashboard, says so, and never overrides a choice made in Settings', async () => {
    seedConnection(t, { id: 'ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Pagekit', lastSyncedAt: NOW });
    snap('ls', { EUR: 400_000 });
    const first = await htmlOf(await get('/dashboard'));
    expect(first).toContain('Amounts are in EUR, the currency most of your MRR is in.');
    expect(first).toContain('€4,000');
    expect((await getUserById(t.db, 'u1'))!.base_currency).toBe('EUR');
    expect(await getCurrencySource(t.db, 'u1')).toBe('inferred');
    expect(await htmlOf(await get('/dashboard'))).not.toContain('Amounts are in EUR'); // once

    await updateUserCurrency(t.db, 'u1', 'USD');
    expect(await getCurrencySource(t.db, 'u1')).toBe('chosen');
    expect(await setInferredCurrency(t.db, 'u1', 'EUR')).toBe(false);
    expect((await getUserById(t.db, 'u1'))!.base_currency).toBe('USD');
  });
});

describe('remembered choices', () => {
  it('brings back the last dashboard range; a URL with ?range= still wins', async () => {
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe', lastSyncedAt: NOW });
    snap('a', { USD: 100_000 });
    const set = await get('/dashboard?range=90');
    const remembered = cookie(set, 'hm_range');
    expect(remembered).toBe('__Host-hm_range=90');
    const bare = await htmlOf(await get('/dashboard', [remembered!]));
    expect(bare).toMatch(/<a\b(?=[^>]*href="\/dashboard\?range=90")(?=[^>]*aria-current="page")/);
    const explicit = await htmlOf(await get('/dashboard?range=7', [remembered!]));
    expect(explicit).toMatch(/<a\b(?=[^>]*href="\/dashboard\?range=7")(?=[^>]*aria-current="page")/);
    // The year is remembered too; a range that isn't offered is neither shown nor remembered.
    const year = await get('/dashboard?range=364');
    expect(cookie(year, 'hm_range')).toBe('__Host-hm_range=364');
    expect(await htmlOf(year)).toContain('Revenue per week');
    const odd = await get('/dashboard?range=365', [remembered!]);
    expect(cookie(odd, 'hm_range')).toBeNull();
    expect(await htmlOf(odd)).toMatch(/<a\b(?=[^>]*href="\/dashboard\?range=90")(?=[^>]*aria-current="page")/);
  });

  it('brings back the revenue chart’s bars or line; ?revenue= wins, anything else is bars', async () => {
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe', lastSyncedAt: NOW });
    snap('a', { USD: 100_000 });
    const set = await get('/dashboard?range=30&revenue=line');
    const remembered = cookie(set, 'hm_revenue');
    expect(remembered).toBe('__Host-hm_revenue=line');
    const current = (v: string) => new RegExp(`<a\\b(?=[^>]*href="/dashboard\\?range=30&amp;revenue=${v}#revenue")(?=[^>]*aria-current="page")`);
    expect(await htmlOf(await get('/dashboard', [remembered!]))).toMatch(current('line'));
    expect(await htmlOf(await get('/dashboard?revenue=bars', [remembered!]))).toMatch(current('bars'));
    const odd = await get('/dashboard?revenue=pie', [remembered!]);
    expect(cookie(odd, 'hm_revenue')).toBeNull();
    expect(await htmlOf(odd)).toMatch(current('line'));
    expect(await htmlOf(await get('/dashboard'))).toMatch(current('bars'));
  });

  it('brings back the last transactions filter, with "All" as an explicit choice', async () => {
    seedConnection(t, { id: 'a', userId: 'u1', provider: 'stripe', lastSyncedAt: NOW });
    seedConnection(t, { id: 'b', userId: 'u1', provider: 'lemonsqueezy', lastSyncedAt: NOW });
    const set = await get('/transactions?provider=stripe');
    const remembered = cookie(set, 'hm_provider')!;
    const bare = await htmlOf(await get('/transactions', [remembered]));
    expect(bare).toMatch(/<a\b(?=[^>]*href="\/transactions\?provider=stripe")(?=[^>]*aria-current="page")/);
    expect(bare).toContain('href="/transactions?provider=all"');
    const all = await get('/transactions?provider=all', [remembered]);
    expect(cookie(all, 'hm_provider')).toBe('__Host-hm_provider=all');
    expect(await htmlOf(all)).toMatch(/<a\b(?=[^>]*href="\/transactions\?provider=all")(?=[^>]*aria-current="page")/);
  });
});

describe('settings', () => {
  it('shows where the currency and the zone came from without asking D1 again', async () => {
    t.exec("UPDATE users SET base_currency = 'EUR', currency_source = 'inferred', timezone = 'Europe/Istanbul', timezone_source = 'chosen'");
    // A session far from its refresh, so the request makes no write of its own either.
    t.exec('UPDATE sessions SET expires_at = ?', NOW + 20 * DAY);
    const before = t.roundTrips();
    const res = await get('/settings');
    expect(res.status).toBe(200);
    expect(t.roundTrips() - before).toBe(1); // the session lookup, which carries both sources
    const html = await res.text();
    const json = /<script id="hm-page" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
    expect(JSON.parse(json!).props).toMatchObject({
      currency: 'EUR',
      currencySource: 'inferred',
      timeZone: 'Europe/Istanbul',
      timeZoneSource: 'chosen',
    });
  });
});
