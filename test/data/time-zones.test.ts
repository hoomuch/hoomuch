/**
 * Days in the user's time zone (SPEC §6) across read models, the engine, the views and Settings.
 * The clock is 2026-11-05 12:00 UTC: 17:30 in Kolkata (still the 5th), 01:00 on the 6th in Auckland,
 * 04:00 on the 5th in Los Angeles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { getCalendarMonth, parseCalendarQuery, parseDayParam } from '../../src/data/calendar';
import { getConnectionDetail } from '../../src/data/connections';
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
const LA = 'America/Los_Angeles';
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

describe('local days at their edges', () => {
  it('dashboard: today is the local day, so a charge just after local midnight is in the last bar', async () => {
    // 11:30 UTC on the 5th is 00:30 on the 6th in Auckland (+13:00).
    tx('st', 'after-midnight', Date.parse('2026-11-05T11:30:00Z'), 5_00);
    const d = await getDashboardData(testEnv(t.db), user(AUCKLAND), 7);
    expect(d.revenueSeries.at(-1)).toMatchObject({ day: '2026-11-06', total: 5_00 });
  });

  it('dashboard: products cover the same local days as the revenue KPI', async () => {
    // Auckland's 7 days are Oct 31 to Nov 6; 12:00 UTC on Oct 30 is 01:00 on Oct 31 there.
    tx('st', 'first-day', Date.parse('2026-10-30T12:00:00Z'), 4_00);
    const d = await getDashboardData(testEnv(t.db), user(AUCKLAND), 7);
    expect(d.revenueSeries[0]!.day).toBe('2026-10-31');
    expect(d.kpis.revenue.value).toBe(24_00); // Stripe 4 + 10 + 3, RevenueCat 7
    expect(d.products.rows.map((p) => [p.name, p.revenue])).toEqual([['Pro', 17_00]]);
    expect(d.products.unnamed.revenue).toBe(7_00);
  });

  it('calendar: a charge at local midnight on the 1st counts on the 1st', async () => {
    // Midnight on Nov 1 in Kolkata (+05:30) is 18:30 UTC on Oct 31; a second earlier is still October.
    tx('st', 'midnight', Date.parse('2026-10-31T18:30:00Z'), 6_00);
    tx('st', 'october', Date.parse('2026-10-31T18:29:59Z'), 1_00);
    const m = await getCalendarMonth(testEnv(t.db), user(KOLKATA), '2026-11');
    expect(m.days[0]).toMatchObject({ day: '2026-11-01', net: 6_00, charges: 1 });
  });

  it('?day= covers all 25 hours of the day DST ends', async () => {
    // Nov 1 in Los Angeles runs from 07:00 UTC (00:00 PDT) to 08:00 UTC on Nov 2 (00:00 PST).
    tx('st', 'first', Date.parse('2026-11-01T07:00:00Z'), 1_00);
    tx('st', 'last-hour', Date.parse('2026-11-02T07:30:00Z'), 2_00); // 23:30 PST
    tx('st', 'next-day', Date.parse('2026-11-02T08:00:00Z'), 3_00);
    tx('st', 'day-before', Date.parse('2026-11-01T06:59:59Z'), 4_00);
    const p = await listTransactions(testEnv(t.db), user(LA), { provider: null, page: 1, day: '2026-11-01' });
    expect(p.items.map((i) => i.externalId)).toEqual(['last-hour', 'first']);
  });

  it('revenue history starts on the local day the connection was created', async () => {
    // 03:00 UTC on Aug 8 is 20:00 on Aug 7 in Los Angeles; 90 days of backfill reach back to May 10.
    t.exec('UPDATE connections SET created_at = ?, revenue_synced_until = ? WHERE id = ?', Date.parse('2026-08-08T03:00:00Z'), NOW, 'st');
    const m = await getCalendarMonth(testEnv(t.db), user(LA), '2026-05');
    expect(m.revenueFrom).toBe('2026-05-10');
    // The 90-day window starts Aug 8 and the one before it May 10: covered, so it compares.
    const d = await getDashboardData(testEnv(t.db), user(LA), 90);
    expect(d.kpis.revenue.previous).toBe(0);
  });

  it('names App Store Connect’s Pacific days, unless the user’s days are Pacific too', async () => {
    seedConnection(t, { id: 'as', userId: 'u1', provider: 'appstore', name: 'iOS' });
    const utc = await getDashboardData(testEnv(t.db), user('UTC'), 7);
    expect(utc.days.otherZones).toEqual([{ label: 'Pacific Time', providers: ['App Store Connect'] }]);
    const la = await getDashboardData(testEnv(t.db), user(LA), 7);
    expect(la.days.otherZones).toEqual([{ label: 'UTC', providers: ['RevenueCat'] }]);
  });
});

describe('after a move west', () => {
  function snap(day: string, usd: number, capturedAt: number, warnings: string[] | null = null) {
    t.exec(
      `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, captured_at, warnings)
       VALUES ('st', ?, ?, 1, NULL, ?, ?)`,
      day, JSON.stringify({ USD: usd }), capturedAt, warnings ? JSON.stringify(warnings) : null,
    );
  }
  beforeEach(() => {
    // Synced in Auckland at 11:00Z (00:00 on the 6th there), then in Los Angeles at 11:30Z (03:30 on the 5th).
    snap('2026-11-06', 100_00, Date.parse('2026-11-05T11:00:00Z'), ['Some prices had no amount.']);
    snap('2026-11-05', 200_00, Date.parse('2026-11-05T11:30:00Z'));
  });

  it('dashboard: MRR is the newest snapshot up to today, and the trend stops at today', async () => {
    const d = await getDashboardData(testEnv(t.db), user(LA), 7);
    expect(d.kpis.mrr.value).toBe(200_00);
    expect(d.mrrSeries.map((p) => p.day)).toEqual(['2026-11-05']);
    expect(d.warnings).toEqual([]);
  });

  it('connection page: the latest snapshot and its warnings are today’s', async () => {
    const c = await getConnectionDetail(testEnv(t.db), user(LA), 'st');
    expect(c!.snapshots.map((s) => s.day)).toEqual(['2026-11-05']);
    expect(c!.warnings).toEqual([]);
  });

  it('calendar: today shows the newest snapshot up to today', async () => {
    const m = await getCalendarMonth(testEnv(t.db), user(LA), '2026-11');
    expect(m.today).toBe('2026-11-05');
    expect(m.days[4]).toMatchObject({ day: '2026-11-05', mrr: 200_00 });
    expect(m.days[5]).toMatchObject({ day: '2026-11-06', mrr: null });
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

  it('adds the year by the calendar in the user’s zone', () => {
    // 20:00 UTC on 2025-12-31 is 01:30 on 2026-01-01 in Kolkata: this year there, last year in UTC.
    expect(formatWhen(Date.parse('2025-12-31T20:00:00Z'), NOW, KOLKATA)).toBe('Jan 1, 01:30 Asia/Kolkata');
    expect(formatWhen(Date.parse('2025-12-31T20:00:00Z'), NOW)).toBe('Dec 31, 2025, 20:00 UTC');
    // 05:00 UTC on 2026-01-01 is still 21:00 on 2025-12-31 in Los Angeles (-08:00).
    expect(formatWhen(Date.parse('2026-01-01T05:00:00Z'), NOW, LA)).toBe('Dec 31, 2025, 21:00 America/Los Angeles');
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
  /** The JSON data block the browser hydrates from. */
  const payloadOf = (html: string) =>
    JSON.parse(/<script id="hm-page" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!) as {
      timeZone: string;
      props: { timeZones?: string[] };
    };
  /** The zone the Settings select posts: its hidden input's value. */
  const selectedZone = (html: string) => /<input[^>]*\bname="timezone" value="([^"]*)"/.exec(html)?.[1];

  it('takes the zone Cloudflare saw once, then shows it as picked automatically', async () => {
    const env = await signedIn();
    const html = await htmlOf(await get(env, '/settings', { timezone: 'Europe/Istanbul' }));
    expect(zoneOf()).toEqual({ timezone: 'Europe/Istanbul', timezone_source: 'inferred' });
    expect(html).toContain('Picked automatically from where you signed in.');
    expect(selectedZone(html)).toBe('Europe/Istanbul');
    // A later request from elsewhere doesn't move it again.
    await get(env, '/settings', { timezone: 'America/New_York' });
    expect(zoneOf()).toEqual({ timezone: 'Europe/Istanbul', timezone_source: 'inferred' });
  });

  it('keeps the default when Cloudflare’s zone isn’t one the list can show', async () => {
    for (const seen of ['Mars/Olympus', '+0530', 'EST5EDT']) {
      const env = await signedIn();
      const res = await get(env, '/settings', { timezone: seen });
      expect(res.status, seen).toBe(200);
      expect(zoneOf(), seen).toEqual({ timezone: 'UTC', timezone_source: 'default' });
      expect(selectedZone(await htmlOf(res)), seen).toBe('UTC');
    }
    // An old name is stored by its current one.
    await get(await signedIn(), '/settings', { timezone: 'Asia/Calcutta' });
    expect(zoneOf()).toEqual({ timezone: KOLKATA, timezone_source: 'inferred' });
  });

  it('offers the stored zone in the select, even one stored by an old name', async () => {
    for (const stored of [KOLKATA, 'Asia/Calcutta']) {
      const html = await htmlOf(await get(await signedIn(stored), '/settings'));
      expect(selectedZone(html), stored).toBe(KOLKATA);
      expect(payloadOf(html).props.timeZones, stored).toContain(KOLKATA);
    }
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
    // One spelling, whatever the case or the name's age.
    expect((await post('asia/kolkata')).status).toBe(303);
    expect(zoneOf()).toEqual({ timezone: 'Asia/Kolkata', timezone_source: 'chosen' });
    for (const junk of ['Mars/Olympus_Mons', '+0530', '+05:30', 'EST5EDT', 'Etc/GMT-5']) {
      await post(junk);
      expect(zoneOf(), junk).toEqual({ timezone: 'Asia/Kolkata', timezone_source: 'chosen' });
    }
    await post('Europe/Kiev');
    expect(zoneOf()).toEqual({ timezone: 'Europe/Kyiv', timezone_source: 'chosen' });
    await get(env, '/settings', { timezone: 'Europe/Istanbul' });
    expect(zoneOf()?.timezone).toBe('Europe/Kyiv');
  });

  it('pages carry the zone, so the browser prints the same times as the server', async () => {
    const env = await signedIn(KOLKATA);
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    tx('st', 'late', Date.parse('2026-11-04T20:00:00Z'), 10_00);
    const html = await htmlOf(await get(env, '/transactions'));
    expect(payloadOf(html).timeZone).toBe(KOLKATA);
    expect(html).toContain('Date (Asia/Kolkata)');
    // 20:00 UTC on the 4th is 01:30 on the 5th in Kolkata (+05:30).
    expect(html).toContain('>Nov 5, 2026, 01:30</time>');
  });

  it('a stored zone the runtime doesn’t know falls back to UTC', async () => {
    const env = await signedIn('Junk');
    seedConnection(t, { id: 'st', userId: 'u1', provider: 'stripe', name: 'Acme' });
    tx('st', 'late', Date.parse('2026-11-04T20:00:00Z'), 10_00);
    const res = await get(env, '/transactions');
    expect(res.status).toBe(200);
    const html = await htmlOf(res);
    expect(payloadOf(html).timeZone).toBe('UTC');
    expect(html).toContain('Date (UTC)');
    expect(html).toContain('>Nov 4, 2026, 20:00</time>');
  });
});
