/**
 * Days in the user's time zone (SPEC §6) across read models, the engine, the views and Settings.
 * The clock is 2026-11-05 12:00 UTC: 17:30 in Kolkata (still the 5th), 01:00 on the 6th in Auckland.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { getCalendarMonth, parseCalendarQuery, parseDayParam } from '../../src/data/calendar';
import { getDashboardData } from '../../src/data/dashboard';
import { listTransactions } from '../../src/data/transactions';
import type { SessionUser } from '../../src/env';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY, addDays, zonedDayStart } from '../../src/lib/time';
import { stripeAdapter } from '../../src/providers/stripe';
import { planRevenue } from '../../src/sync/aggregate';
import { syncConnection } from '../../src/sync/engine';
import { formatDateTime, formatWhen } from '../../src/views/pages/shared';
import { dayZonesNote } from '../../src/views/pages/dashboard';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { htmlOf } from '../fixtures/html';
import { encryptedCreds, page, SNAP } from '../sync/helpers';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const KOLKATA = 'Asia/Kolkata';
const AUCKLAND = 'Pacific/Auckland';
const user = (timeZone: string): SessionUser => ({ id: 'u1', email: 'u1@example.com', baseCurrency: 'USD', timeZone });

let t: TestD1;

function tx(conn: string, id: string, at: number, amount: number) {
  t.exec(
    `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
     VALUES (?, ?, ?, ?, ?, 'USD', NULL, 'Pro')`,
    conn, id, at, amount < 0 ? 'refund' : 'charge', amount,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1', timeZone: KOLKATA });
  seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme', createdAt: NOW - 30 * DAY });
  seedConnection(t, { id: 'rc', userId: 'u1', provider: 'revenuecat', name: 'App' });
  // 20:00 UTC on the 4th is 01:30 on the 5th in Kolkata; 18:00 UTC on the 4th is 23:30 on the 4th.
  tx('st', 'late', Date.parse('2026-11-04T20:00:00Z'), 10_00);
  tx('st', 'early', Date.parse('2026-11-04T18:00:00Z'), 3_00);
  t.exec("INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES ('rc', '2026-11-04', 'USD', 7_00, 0, 1, 'provider')");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('read models', () => {
  it('dashboard: transactions on the local day, provider totals on their own day, and a note saying so', async () => {
    const d = await getDashboardData(testEnv(t.db), user(KOLKATA), 7);
    const byDay = Object.fromEntries(d.revenueSeries.map((r) => [r.day, r.byConnection]));
    expect(d.revenueSeries.at(-1)!.day).toBe('2026-11-05');
    expect(byDay['2026-11-05']).toEqual({ st: 10_00 });
    expect(byDay['2026-11-04']).toEqual({ st: 3_00, rc: 7_00 });
    expect(d.days).toEqual({ timeZone: KOLKATA, otherZones: [{ label: 'UTC', providers: ['RevenueCat'] }] });
    expect(dayZonesNote(d.days)).toBe('Days run midnight to midnight in Asia/Kolkata. RevenueCat reports its days in UTC.');

    // The same data for a UTC user puts both charges on the 4th, and needs no note.
    const utc = await getDashboardData(testEnv(t.db), user('UTC'), 7);
    expect(Object.fromEntries(utc.revenueSeries.map((r) => [r.day, r.total]))['2026-11-04']).toBe(20_00);
    expect(utc.days.otherZones).toEqual([]);
  });

  it('calendar: charges counted on the local day; "today" is local', async () => {
    const m = await getCalendarMonth(testEnv(t.db), user(AUCKLAND), '2026-11');
    expect(m.today).toBe('2026-11-06');
    // Both charges are on the 5th in Auckland (+13:00); RevenueCat's total stays on its own UTC day.
    expect(m.days[4]).toMatchObject({ day: '2026-11-05', net: 13_00, charges: 2 });
    expect(m.days[3]).toMatchObject({ day: '2026-11-04', net: 7_00, charges: 0 });
  });

  it('?day= and the calendar query follow the local date', async () => {
    expect(parseDayParam('2026-11-06', NOW, AUCKLAND)).toBe('2026-11-06');
    expect(parseDayParam('2026-11-06', NOW, 'UTC')).toBeNull(); // still the 5th in UTC
    expect(parseCalendarQuery(undefined, undefined, Date.parse('2026-11-30T20:00:00Z'), AUCKLAND).month).toBe('2026-12');
    const p = await listTransactions(testEnv(t.db), user(KOLKATA), { provider: null, page: 1, day: '2026-11-05' });
    expect(p.items.map((i) => i.externalId)).toEqual(['late']);
  });
});

describe('engine', () => {
  it('keys the snapshot by the owner’s local day and starts a first backfill at local midnight', async () => {
    t.exec("UPDATE users SET timezone = ? WHERE id = 'u1'", AUCKLAND);
    t.exec('UPDATE connections SET credentials_enc = ? WHERE id = ?', await encryptedCreds(), 'st');
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockResolvedValue(SNAP);
    const rev = vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
    vi.stubGlobal('fetch', async () => new Response('[]', { status: 503 }));

    await syncConnection(testEnv(t.db), 'st', 'initial');

    expect(t.rows('SELECT day FROM snapshots WHERE connection_id = ?', 'st')).toEqual([{ day: '2026-11-06' }]);
    expect(rev.mock.calls[0]![1]).toEqual({ since: zonedDayStart(addDays('2026-11-06', -89), AUCKLAND), cursor: null });
    expect(planRevenue({ revenue_cursor: null, revenue_synced_until: null }, NOW).since).toBe(Date.parse('2026-08-08T00:00:00Z'));
    vi.unstubAllGlobals();
  });
});

describe('views', () => {
  it('formats instants in the zone and names it', () => {
    const at = Date.parse('2026-11-04T20:00:00Z');
    expect(formatDateTime(at, KOLKATA)).toBe('Nov 5, 2026, 01:30');
    expect(formatWhen(at, NOW, KOLKATA)).toBe('Nov 5, 01:30 Asia/Kolkata');
    expect(formatWhen(at, NOW)).toBe('Nov 4, 20:00 UTC');
  });
});

describe('Settings and inference', () => {
  const TOKEN = 'tz-session';
  const ORIGIN = 'https://hoomuch.test';
  async function signedIn(zone?: string) {
    t = createTestD1();
    seedUser(t, { id: 'u1', ...(zone ? { timeZone: zone } : {}) });
    t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
    return testEnv(t.db);
  }
  const get = (env: ReturnType<typeof testEnv>, path: string, cf?: { timezone: string }) => {
    const req = new Request(`${ORIGIN}${path}`, { headers: { cookie: `__Host-hm_session=${TOKEN}` } });
    if (cf) Object.defineProperty(req, 'cf', { value: cf });
    return worker.fetch!(req as never, env, { waitUntil() {}, passThroughOnException() {} } as never) as Promise<Response>;
  };
  const zoneOf = () => t.rows<{ timezone: string; timezone_source: string }>('SELECT timezone, timezone_source FROM users')[0];

  it('takes the zone Cloudflare saw once, then shows it as picked automatically', async () => {
    const env = await signedIn();
    const html = await htmlOf(await get(env, '/settings', { timezone: 'Europe/Istanbul' }));
    expect(zoneOf()).toEqual({ timezone: 'Europe/Istanbul', timezone_source: 'inferred' });
    expect(html).toContain('Picked automatically from where you signed in.');
    expect(html).toContain('Europe/Istanbul');
    // A later request from elsewhere doesn't move it again.
    await get(env, '/settings', { timezone: 'America/New_York' });
    expect(zoneOf()).toEqual({ timezone: 'Europe/Istanbul', timezone_source: 'inferred' });
  });

  it('a zone chosen in Settings sticks, and junk is refused', async () => {
    const env = await signedIn();
    const post = (zone: string) =>
      worker.fetch!(
        new Request(`${ORIGIN}/settings/timezone`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-hm_session=${TOKEN}` },
          body: new URLSearchParams({ timezone: zone }).toString(),
          redirect: 'manual',
        }) as never,
        env,
        { waitUntil() {}, passThroughOnException() {} } as never,
      ) as Promise<Response>;
    expect((await post('Asia/Kolkata')).status).toBe(303);
    expect(zoneOf()).toEqual({ timezone: 'Asia/Kolkata', timezone_source: 'chosen' });
    await post('Mars/Olympus_Mons');
    expect(zoneOf()).toEqual({ timezone: 'Asia/Kolkata', timezone_source: 'chosen' });
    await get(env, '/settings', { timezone: 'Europe/Istanbul' });
    expect(zoneOf()?.timezone).toBe('Asia/Kolkata');
  });

  it('pages carry the zone, so the browser prints the same times as the server', async () => {
    const env = await signedIn(KOLKATA);
    const html = await (await get(env, '/settings')).text();
    expect(html).toContain('"timeZone":"Asia/Kolkata"');
  });
});
