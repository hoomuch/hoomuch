/** FX on frankfurter.dev v2 (src/sync/fx.ts): storage, ECB precedence, history and day rates. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FX_HISTORY_DAYS,
  FxConverter,
  FxHistory,
  ensureFxHistory,
  getLatestFx,
  latestFx,
  refreshFx,
} from '../../src/sync/fx';
import { addDays } from '../../src/lib/time';
import { createTestD1, seedConnection, seedUser } from '../fixtures/d1';
import { fakeFetch, route } from '../fixtures/harness';
import { fxV2 } from '../fixtures/fx';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const TODAY = '2026-11-05';

afterEach(() => vi.restoreAllMocks());

const rows = (t: ReturnType<typeof createTestD1>) =>
  t.rows<{ day: string; rates: string }>('SELECT day, rates FROM fx_rates ORDER BY day').map((r) => ({ day: r.day, rates: JSON.parse(r.rates) }));

describe('refreshFx', () => {
  it('stores each quote under its own date, with the ECB’s rate over the blended one', async () => {
    const t = createTestD1();
    const { fetch, calls } = fakeFetch([
      route('/v2/rates', { json: fxV2({ date: '2026-11-04', rates: { EUR: 0.9 } }) }, { query: { providers: 'ecb' } }),
      route('/v2/rates', { json: fxV2({ date: '2026-11-04', rates: { EUR: 0.91, ARS: 1500 } }, { date: '2026-11-05', rates: { TRY: 50 } }) }),
    ]);
    const latest = await refreshFx(t.db, fetch, NOW);
    expect(calls.map((c) => c.url)).toEqual(['https://api.frankfurter.dev/v2/rates?base=USD', 'https://api.frankfurter.dev/v2/rates?base=USD&providers=ecb']);
    expect(rows(t)).toEqual([
      { day: '2026-11-04', rates: { EUR: 0.9, ARS: 1500 } },
      { day: '2026-11-05', rates: { TRY: 50 } },
    ]);
    expect(latest).toEqual({ base: 'USD', day: '2026-11-05', rates: { EUR: 0.9, ARS: 1500, TRY: 50 } });
  });

  it('merges into a day it already has, and keeps going when the ECB is down', async () => {
    const t = createTestD1();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    t.exec(`INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES ('2026-11-04', 'USD', '{"GBP":0.8,"EUR":0.95}', 0)`);
    const { fetch } = fakeFetch([
      route('/v2/rates', { status: 503, json: {} }, { query: { providers: 'ecb' } }),
      route('/v2/rates', { json: fxV2({ date: '2026-11-04', rates: { EUR: 0.91 } }) }),
    ]);
    await refreshFx(t.db, fetch, NOW);
    expect(rows(t)).toEqual([{ day: '2026-11-04', rates: { GBP: 0.8, EUR: 0.91 } }]);
  });

  it('the latest table takes each currency’s newest rate within the last 10 days', async () => {
    const t = createTestD1();
    const insert = (day: string, rates: Record<string, number>) =>
      t.exec('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, 0)', day, 'USD', JSON.stringify(rates));
    insert('2026-10-01', { JPY: 140 }); // too old to count as latest
    insert('2026-11-03', { EUR: 0.9, ARS: 1500 });
    insert('2026-11-05', { EUR: 0.92 });
    insert('2026-11-06', {}); // a history marker is never "latest"
    expect(await getLatestFx(t.db)).toEqual({ base: 'USD', day: '2026-11-05', rates: { EUR: 0.92, ARS: 1500 } });
    expect(latestFx([])).toBeNull();
  });
});

describe('FxHistory and FxConverter.amountOn', () => {
  const history = new FxHistory([
    { day: '2026-11-02', base: 'USD', rates: '{"EUR":0.5}' },
    { day: '2026-11-04', base: 'USD', rates: '{"EUR":0.8,"GBP":0.75}' },
  ]);

  it('takes the newest rate on or before the day, the oldest before history starts', () => {
    expect(history.rateOn('EUR', '2026-11-02')).toBe(0.5);
    expect(history.rateOn('EUR', '2026-11-03')).toBe(0.5); // a weekend or holiday
    expect(history.rateOn('EUR', '2026-11-05')).toBe(0.8);
    expect(history.rateOn('EUR', '2026-10-01')).toBe(0.5);
    expect(history.rateOn('GBP', '2026-11-02')).toBe(0.75);
    expect(history.rateOn('usd', '2026-11-02')).toBe(1);
    expect(history.rateOn('JPY', '2026-11-02')).toBeNull();
  });

  it('converts revenue at its day’s rate, MRR at the latest, and falls back to the latest without history', () => {
    const cv = new FxConverter('USD', { base: 'USD', day: '2026-11-04', rates: { EUR: 0.8, JPY: 150 } }, history);
    expect(cv.amountOn(100_00, 'EUR', '2026-11-02')).toBe(200_00); // 100 € at 0.5
    expect(cv.amountOn(100_00, 'EUR', '2026-11-04')).toBe(125_00); // 100 € at 0.8
    expect(cv.amountOn(1500, 'JPY', '2026-11-02')).toBe(10_00); // no JPY history: latest
    expect(cv.usedDaily).toBe(true);
    expect(cv.used).toBe(false); // the latest table's date is for MRR
    expect(cv.amount(100_00, 'EUR')).toBe(125_00);
    expect(cv.used).toBe(true);
    expect(cv.amountOn(5, 'XXX', '2026-11-02')).toBe(0);
    expect([...cv.missing]).toEqual(['XXX']);
  });
});

describe('ensureFxHistory', () => {
  function seed() {
    const t = createTestD1();
    seedUser(t, { id: 'u1' });
    t.exec("UPDATE users SET base_currency = 'GBP' WHERE id = 'u1'");
    seedConnection(t, { id: 'c', userId: 'u1', provider: 'stripe' });
    t.exec("INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES ('c', '2026-09-01', 'EUR', 100, 0, 1, 'transactions')");
    t.exec("INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES ('c', '2026-09-01', 'ZZZ', 100, 0, 1, 'transactions')");
    t.exec(`INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES ('2026-11-04', 'USD', '{"EUR":0.9,"GBP":0.8,"TRY":50}', 0)`);
    return t;
  }

  it('fetches the missing past once, for the currencies in use that Frankfurter knows, and marks how far back', async () => {
    const t = seed();
    const target = addDays(TODAY, -FX_HISTORY_DAYS);
    const { fetch, calls } = fakeFetch([
      route('/v2/rates', { json: fxV2({ date: '2026-09-01', rates: { EUR: 0.85 } }) }, { query: { providers: 'ecb' } }),
      route('/v2/rates', { json: fxV2({ date: '2026-09-01', rates: { EUR: 0.86, GBP: 0.74 } }) }),
    ]);

    expect(await ensureFxHistory(t.db, fetch, NOW)).toBe('filled');
    const range = `&from=${target}&to=2026-11-03&quotes=EUR,GBP`; // ZZZ isn't a currency Frankfurter has; TRY isn't in use
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.frankfurter.dev/v2/rates?base=USD${range}`,
      `https://api.frankfurter.dev/v2/rates?base=USD&providers=ecb${range}`,
    ]);
    expect(rows(t)).toEqual([
      { day: target, rates: {} },
      { day: '2026-09-01', rates: { EUR: 0.85, GBP: 0.74 } },
      { day: '2026-11-04', rates: { EUR: 0.9, GBP: 0.8, TRY: 50 } },
    ]);

    expect(await ensureFxHistory(t.db, fetch, NOW)).toBe('covered');
    expect(calls).toHaveLength(2);
  });

  it('waits when there is nothing to fill or no rates yet, and a failure leaves no marker', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const empty = createTestD1();
    expect(await ensureFxHistory(empty.db, fakeFetch([]).fetch, NOW)).toBe('failed'); // no latest rates yet

    const usdOnly = createTestD1();
    seedUser(usdOnly, { id: 'u1' });
    usdOnly.exec(`INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES ('2026-11-04', 'USD', '{"EUR":0.9}', 0)`);
    expect(await ensureFxHistory(usdOnly.db, fakeFetch([]).fetch, NOW)).toBe('nothing_to_fill');

    const t = seed();
    expect(await ensureFxHistory(t.db, fakeFetch([route('/v2/rates', { status: 500, json: {} })]).fetch, NOW)).toBe('failed');
    expect(rows(t).map((r) => r.day)).toEqual(['2026-11-04']);
  });
});
