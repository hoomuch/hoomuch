/**
 * Shared setup for sync tests (not a test file). Fakes only Date (http retries use setTimeout),
 * stubs global fetch with frankfurter.dev, silences + records console output.
 */

import { vi } from 'vitest';
import { encryptJson } from '../../src/lib/crypto';
import { DAY } from '../../src/lib/time';
import type { DailyRevenuePoint, MetricsSnapshot, RevenueEvent, RevenuePage } from '../../src/providers/types';
import { TEST_ENCRYPTION_KEY, createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { fakeFetch, route, type FakeResponse, type RecordedCall } from '../fixtures/harness';

export const NOW = Date.parse('2026-11-05T12:00:00.000Z');
export const SECRET = 'rk_test_x';
export const FX_BODY = { amount: 1, base: 'USD', date: '2026-11-04', rates: { EUR: 0.92, GBP: 0.78, TRY: 34.1 } };

export const SNAP: MetricsSnapshot = {
  mrr: { USD: 120_000, EUR: 5_000 },
  activeSubscriptions: 42,
  activeTrials: 3,
  revenuePeriod: { USD: 300_000 },
  revenuePeriodDays: 30,
  newCustomers: 5,
};

export interface Ctx {
  t: TestD1;
  env: ReturnType<typeof testEnv>;
  userId: string;
  fxCalls: RecordedCall[];
  /** Everything written to console.* during the test. */
  out: string[];
}

export function setup(opts: { fx?: FakeResponse | FakeResponse[]; env?: Parameters<typeof testEnv>[1] } = {}): Ctx {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const { fetch, calls } = fakeFetch([route('/v1/latest', opts.fx ?? { json: FX_BODY })]);
  vi.stubGlobal('fetch', fetch);
  const out: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      out.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  const t = createTestD1();
  const userId = seedUser(t);
  return { t, env: testEnv(t.db, opts.env), userId, fxCalls: calls, out };
}

export function teardown(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
}

export function encryptedCreds(value: Record<string, string> = { apiKey: SECRET }): Promise<string> {
  return encryptJson(TEST_ENCRYPTION_KEY, value);
}

export async function seedStripe(
  c: Ctx,
  id: string,
  extra: Partial<Parameters<typeof seedConnection>[1]> = {},
): Promise<void> {
  seedConnection(c.t, {
    id,
    userId: c.userId,
    provider: 'stripe',
    credentialsEnc: await encryptedCreds(),
    status: 'pending',
    ...extra,
  });
}

/** Sets columns seedConnection doesn't cover. */
export function setCursorState(t: TestD1, id: string, cursor: string | null, syncedUntil: number | null): void {
  t.exec('UPDATE connections SET revenue_cursor = ?, revenue_synced_until = ? WHERE id = ?', cursor, syncedUntil, id);
}

export interface ConnRow {
  status: string;
  last_error: string | null;
  last_synced_at: number | null;
  last_sync_started_at: number | null;
  revenue_cursor: string | null;
  revenue_synced_until: number | null;
}

export function conn(t: TestD1, id: string): ConnRow {
  return t.rows<ConnRow>(
    `SELECT status, last_error, last_synced_at, last_sync_started_at, revenue_cursor, revenue_synced_until
       FROM connections WHERE id = ?`,
    id,
  )[0]!;
}

export interface RunRow {
  id: number;
  connection_id: string;
  kind: string;
  started_at: number;
  finished_at: number | null;
  ok: number | null;
  events: number;
  message: string | null;
}

export function runs(t: TestD1, id?: string): RunRow[] {
  return id
    ? t.rows<RunRow>('SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY id', id)
    : t.rows<RunRow>('SELECT * FROM sync_runs ORDER BY id');
}

export function dailyRows(t: TestD1, id: string, source: 'transactions' | 'provider' = 'transactions'): DailyRevenuePoint[] {
  return t.rows<DailyRevenuePoint>(
    `SELECT day, currency, gross, refunds, count FROM daily_revenue
      WHERE connection_id = ? AND source = ? ORDER BY day, currency`,
    id,
    source,
  );
}

export function txRows(t: TestD1, id: string): Array<{ externalId: string; occurredAt: number; amount: number; currency: string }> {
  return t.rows(
    `SELECT external_id AS externalId, occurred_at AS occurredAt, amount, currency FROM transactions
      WHERE connection_id = ? ORDER BY external_id`,
    id,
  );
}

export function charge(id: string, at: number, amount: number, currency = 'USD'): RevenueEvent {
  return { externalId: id, occurredAt: at, type: 'charge', amount, currency, fee: 30, description: 'Pro (monthly)' };
}

export function refund(id: string, at: number, amount: number, currency = 'USD'): RevenueEvent {
  return { externalId: id, occurredAt: at, type: 'refund', amount: -Math.abs(amount), currency, fee: null, description: 'Pro (monthly)' };
}

export function page(events: RevenueEvent[], opts: Partial<RevenuePage> = {}): RevenuePage {
  return { events, daily: [], nextCursor: null, done: true, ...opts };
}

/** Noon UTC, `n` days before NOW's day. */
export function daysAgo(n: number, hourOffset = 0): number {
  return NOW - n * DAY + hourOffset * 3_600_000;
}
