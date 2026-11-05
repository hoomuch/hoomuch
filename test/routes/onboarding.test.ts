/**
 * Onboarding through the real request pipeline (middleware, CSRF, session, routes) with the
 * provider API faked: one message per event, and the first real connection replaces demo data
 * (design/system.md §6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { listConnections } from '../../src/db/queries';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY } from '../../src/lib/time';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { fakeFetch, route } from '../fixtures/harness';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
let t: TestD1;
let pending: Promise<unknown>[];

const emptyList = { object: 'list', data: [], has_more: false, url: '/v1/x' };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // Stripe answers every read with an empty list; FX and anything else fail quietly in the
  // background sync, which this file doesn't look at.
  const { fetch } = fakeFetch([route(/\/v1\//, { json: emptyList }), route(/.*/, { status: 503, json: {} })]);
  vi.stubGlobal('fetch', fetch);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
  pending = [];
});

afterEach(async () => {
  await Promise.allSettled(pending);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function post(path: string, form: Record<string, string>): Promise<Response> {
  const req = new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `__Host-hm_session=${TOKEN}`,
    },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  return worker.fetch!(req as never, testEnv(t.db), ctx as never) as Promise<Response>;
}

/** The flash cookie, if the response sets one. */
function flashCookie(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith('__Host-hm_flash=') && !c.includes('Max-Age=0')) ?? null;
}

const STRIPE = { provider: 'stripe', name: 'Acme', apiKey: 'rk_live_51TestKeyThatLooksRealEnough0000' };

describe('connecting', () => {
  it('replaces demo data with the first real connection and lets the dashboard say so', async () => {
    seedConnection(t, { id: 'demo1', userId: 'u1', provider: 'demo', name: 'Demo data', lastSyncedAt: NOW - 60_000 });
    const res = await post('/connections', STRIPE);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dashboard?first=1&demo=removed');
    expect(flashCookie(res)).toBeNull(); // the dashboard's sync notice is the one message
    const left = await listConnections(t.db, 'u1');
    expect(left.map((c) => c.provider)).toEqual(['stripe']);
  });

  it('keeps a demo connection added after real ones, and sends later connections to their own page', async () => {
    seedConnection(t, { id: 'real1', userId: 'u1', provider: 'stripe', name: 'First', lastSyncedAt: NOW - 60_000 });
    seedConnection(t, { id: 'demo1', userId: 'u1', provider: 'demo', name: 'Demo data', lastSyncedAt: NOW - 60_000 });
    const res = await post('/connections', STRIPE);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/connections\/[0-9a-f-]{36}$/);
    expect(flashCookie(res)).toBeNull();
    const providers = (await listConnections(t.db, 'u1')).map((c) => c.provider).sort();
    expect(providers).toEqual(['demo', 'stripe', 'stripe']);
  });

  it('goes to the dashboard without a celebration trigger for demo data, with its one flash', async () => {
    const res = await post('/connections/demo', {});
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect(flashCookie(res)).not.toBeNull();
  });
});
