/**
 * The transactions CSV export (GET /transactions.csv) and the fee on the list: the file holds the
 * user's own rows for the days asked, amounts as plain decimals, and nothing a spreadsheet would
 * run as a formula.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { EXPORT_MAX_ROWS } from '../../src/data/types';
import { listTransactions } from '../../src/data/transactions';
import { sha256Hex } from '../../src/lib/crypto';
import { csvNumber, toCsv } from '../../src/lib/csv';
import { DAY } from '../../src/lib/time';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { htmlOf } from '../fixtures/html';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
let t: TestD1;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1', baseCurrency: 'USD' });
  seedUser(t, { id: 'u2', email: 'other@example.com' });
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
  t.exec('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)', '2026-11-04', 'USD', JSON.stringify({ EUR: 0.5, JPY: 150 }), NOW);
  seedConnection(t, { id: 'c-stripe', userId: 'u1', provider: 'stripe', name: 'Stripe, main' });
  seedConnection(t, { id: 'c-ls', userId: 'u1', provider: 'lemonsqueezy', name: 'Lemon' });
  seedConnection(t, { id: 'c-other', userId: 'u2', provider: 'stripe', name: 'Not mine' });
});

afterEach(() => {
  vi.useRealTimers();
});

function txn(connectionId: string, id: string, at: string, amount: number, currency: string, fee: number | null, description: string | null): void {
  t.exec(
    `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    connectionId,
    id,
    Date.parse(at),
    amount < 0 ? 'refund' : 'charge',
    amount,
    currency,
    fee,
    description,
  );
}

function get(path: string, session = true): Promise<Response> {
  const req = new Request(`${ORIGIN}${path}`, { headers: session ? { cookie: `__Host-hm_session=${TOKEN}` } : {} });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch!(req as never, testEnv(t.db), ctx as never) as Promise<Response>;
}

/** The file's lines without the byte order mark. */
async function lines(res: Response): Promise<string[]> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return new TextDecoder().decode(bytes).trimEnd().split('\r\n');
}

describe('csv helpers', () => {
  it('writes minor units as decimals in the currency’s own digits', () => {
    expect(csvNumber(-1250, 'USD').raw).toBe('-12.50');
    expect(csvNumber(5, 'USD').raw).toBe('0.05');
    expect(csvNumber(500, 'JPY').raw).toBe('500');
    expect(csvNumber(1234, 'KWD').raw).toBe('1.234');
  });

  it('quotes commas, quotes and line breaks, and disarms formulas in text cells', () => {
    const out = toCsv(['a', 'b'], [['Pro, yearly', 'say "hi"'], ['=HYPERLINK("x")', null], ['-5 seats', csvNumber(-500, 'USD')]]);
    expect(out.slice(1).split('\r\n')).toEqual(['a,b', '"Pro, yearly","say ""hi"""', '"\'=HYPERLINK(""x"")",', "'-5 seats,-5.00", '']);
  });
});

describe('GET /transactions.csv', () => {
  beforeEach(() => {
    txn('c-stripe', 'ch_1', '2026-11-03T10:00:00Z', 2900, 'USD', 114, 'Pro monthly');
    txn('c-stripe', 're_1', '2026-11-04T09:00:00Z', -2900, 'USD', null, 'Pro monthly');
    txn('c-ls', 'ord_1', '2026-11-04T08:00:00Z', 1000, 'EUR', null, '=cmd|x');
    txn('c-stripe', 'ch_old', '2026-09-01T10:00:00Z', 900, 'USD', 56, 'Starter');
    txn('c-other', 'ch_theirs', '2026-11-04T10:00:00Z', 9900, 'USD', 300, 'Theirs');
  });

  it('downloads the period’s rows, newest first, with fees and converted amounts', async () => {
    const res = await get('/transactions.csv?from=2026-11-01&to=2026-11-05');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="hoomuch-transactions-2026-11-01-to-2026-11-05.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await lines(res)).toEqual([
      'date_utc,day,connection,provider,type,description,amount,currency,fee,net,amount_usd,fee_usd,id',
      '2026-11-04T09:00:00.000Z,2026-11-04,"Stripe, main",Stripe,refund,Pro monthly,-29.00,USD,,,-29.00,,re_1',
      "2026-11-04T08:00:00.000Z,2026-11-04,Lemon,Lemon Squeezy,charge,'=cmd|x,10.00,EUR,,,20.00,,ord_1",
      '2026-11-03T10:00:00.000Z,2026-11-03,"Stripe, main",Stripe,charge,Pro monthly,29.00,USD,1.14,27.86,29.00,1.14,ch_1',
    ]);
  });

  it('keeps the provider filter and defaults to the last 30 days', async () => {
    const res = await get('/transactions.csv?provider=lemonsqueezy');
    const out = await lines(res);
    expect(out).toHaveLength(2);
    expect(out[1]).toContain('ord_1');
    expect(res.headers.get('content-disposition')).toContain('2026-10-07-to-2026-11-05');
  });

  it('groups days in the user’s time zone', async () => {
    t.exec("UPDATE users SET timezone = 'Asia/Tokyo' WHERE id = 'u1'");
    txn('c-stripe', 'ch_late', '2026-11-02T16:00:00Z', 500, 'USD', null, 'Late'); // 01:00 on the 3rd in Tokyo
    const out = await lines(await get('/transactions.csv?from=2026-11-03&to=2026-11-03'));
    expect(out.slice(1).map((l) => l.split(',').at(-1))).toEqual(['ch_1', 'ch_late']);
    expect(out[2]).toContain(',2026-11-03,');
  });

  it('asks for a shorter period instead of cutting a long one off', async () => {
    t.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= ?)
       INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency)
       SELECT 'c-stripe', 'bulk_' || i, ? + i, 'charge', 100, 'USD' FROM n`,
      EXPORT_MAX_ROWS,
      Date.parse('2026-10-20T00:00:00Z'),
    );
    const res = await get('/transactions.csv?from=2026-10-01&to=2026-11-05');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/transactions');
  });

  it('turns down a period that ends before it starts, and a signed-out request', async () => {
    const backwards = await get('/transactions.csv?from=2026-11-05&to=2026-11-01');
    expect(backwards.status).toBe(303);
    const signedOut = await get('/transactions.csv', false);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get('location')).toContain('/login');
  });
});

describe('fees on the list', () => {
  it('reads the fee for the page’s rows and converts it at the day’s rate', async () => {
    txn('c-ls', 'ord_fee', '2026-11-04T08:00:00Z', 1000, 'EUR', 50, 'Pro');
    txn('c-stripe', 'ch_nofee', '2026-11-04T07:00:00Z', 1000, 'USD', null, 'Pro');
    const page = await listTransactions(testEnv(t.db), { id: 'u1', email: 'a@example.com', baseCurrency: 'USD', timeZone: 'UTC' }, { provider: null, page: 1 });
    expect(page.items.map((i) => [i.externalId, i.fee, i.displayFee])).toEqual([
      ['ord_fee', 50, 100],
      ['ch_nofee', null, null],
    ]);
  });

  it('shows the fee under the amount and offers the export', async () => {
    txn('c-stripe', 'ch_1', '2026-11-03T10:00:00Z', 2900, 'USD', 114, 'Pro monthly');
    const html = await htmlOf(await get('/transactions?provider=all'));
    expect(html).toContain('$1.14 fee');
    expect(html).toMatch(/<form[^>]*action="\/transactions\.csv"/);
    expect(html).toMatch(/name="to"[^>]*value="2026-11-05"|value="2026-11-05"[^>]*name="to"/);
  });
});
