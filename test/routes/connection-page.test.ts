/**
 * The connection page through the real request pipeline: Sync now returns at once and the page
 * follows the run; demo data goes without a confirmation but offers an Undo; a real connection
 * keeps its confirmation (design/system.md §9).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { listConnections } from '../../src/db/queries';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY } from '../../src/lib/time';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { fakeFetch, route } from '../fixtures/harness';
import { htmlOf } from '../fixtures/html';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
const REAL = '11111111-1111-4111-8111-111111111111';
const DEMO = '22222222-2222-4222-8222-222222222222';
let t: TestD1;
let pending: Promise<unknown>[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const { fetch } = fakeFetch([route(/.*/, { status: 503, json: {} })]);
  vi.stubGlobal('fetch', fetch);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
  seedConnection(t, { id: REAL, userId: 'u1', provider: 'stripe', name: 'Acme', lastSyncedAt: NOW - 3_600_000 });
  seedConnection(t, { id: DEMO, userId: 'u1', provider: 'demo', name: 'Demo data', lastSyncedAt: NOW - 3_600_000 });
  pending = [];
});

afterEach(async () => {
  await Promise.allSettled(pending);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function send(method: 'GET' | 'POST', path: string, form?: Record<string, string>, cookies: string[] = []): Promise<Response> {
  const req = new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      cookie: [`__Host-hm_session=${TOKEN}`, ...cookies].join('; '),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  return worker.fetch!(req as never, testEnv(t.db), ctx as never) as Promise<Response>;
}

/** The flash cookie as "name=value", ready to send back. */
function flash(res: Response): string | null {
  const c = res.headers.getSetCookie().find((x) => x.startsWith('__Host-hm_flash=') && !x.includes('Max-Age=0'));
  return c ? c.split(';')[0]! : null;
}

function run(startedAt: number, finishedAt: number | null, ok: number | null, events = 0): void {
  t.exec(
    'INSERT INTO sync_runs (connection_id, kind, started_at, finished_at, ok, events) VALUES (?, ?, ?, ?, ?, ?)',
    REAL,
    'manual',
    startedAt,
    finishedAt,
    ok,
    events,
  );
}

describe('Sync now', () => {
  it('returns at once and lets the page follow the run in the background', async () => {
    const res = await send('POST', `/connections/${REAL}/sync`, {});
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/connections/${REAL}?sync=${NOW}`);
    expect(pending).toHaveLength(1); // the sync itself runs after the response
  });

  it('still refuses a second sync moments after the last one', async () => {
    t.exec('UPDATE connections SET last_sync_started_at = ? WHERE id = ?', NOW - 10_000, REAL);
    const res = await send('POST', `/connections/${REAL}/sync`, {});
    expect(res.headers.get('location')).toBe(`/connections/${REAL}`);
    expect(pending).toHaveLength(0);
    // The flash says why (any flash would have passed before).
    const page = await htmlOf(await send('GET', `/connections/${REAL}`, undefined, [flash(res)!]));
    expect(page).toContain('Synced moments ago. Try again in a minute.');
  });

  it('shows the run in progress, then its result', async () => {
    const running = await htmlOf(await send('GET', `/connections/${REAL}?sync=${NOW}`));
    expect(running).toContain('Syncing now, usually in a few seconds.');
    expect(running).toContain(`content="5;url=/connections/${REAL}?sync=${NOW}&amp;poll=1"`);
    expect(running).toMatch(/<button\b(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>Syncing…<\/button>/);

    run(NOW + 50, NOW + 2_000, 1, 12);
    const done = await htmlOf(await send('GET', `/connections/${REAL}?sync=${NOW}&poll=1`));
    expect(done).toContain('Synced. 12 revenue events processed.');
    expect(done).not.toContain('http-equiv="refresh"');
  });
});

describe('removing a connection', () => {
  it('removes demo data without a confirmation and offers to add it back', async () => {
    const res = await send('POST', `/connections/${DEMO}/delete`, { back: '/dashboard' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect((await listConnections(t.db, 'u1')).map((c) => c.id)).toEqual([REAL]);

    // The next page shows the flash with a working Undo.
    const page = await htmlOf(await send('GET', '/connections', undefined, [flash(res)!]));
    expect(page).toContain('Demo data removed.');
    expect(page).toMatch(/<form\b(?=[^>]*action="\/connections\/demo")(?=[^>]*method="post")[^>]*><button type="submit"[^>]*>Add it back<\/button><\/form>/);
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/\t/evil.example', '/dashboard/../evil'])(
    'only sends demo removals back to the dashboard or the connections list (back=%j)',
    async (back) => {
      // Each case needs demo data to remove.
      if (!(await listConnections(t.db, 'u1')).some((c) => c.id === DEMO)) throw new Error('setup: demo missing');
      const res = await send('POST', `/connections/${DEMO}/delete`, { back });
      expect(res.headers.get('location')).toBe('/connections');
    },
  );

  it('keeps the confirmation for a real connection and reopens Manage when it’s missing', async () => {
    const res = await send('POST', `/connections/${REAL}/delete`, {});
    expect(res.headers.get('location')).toBe(`/connections/${REAL}?manage=open`);
    expect((await listConnections(t.db, 'u1')).map((c) => c.id).sort()).toEqual([REAL, DEMO].sort());
    const page = await htmlOf(await send('GET', `/connections/${REAL}?manage=open`, undefined, [flash(res)!]));
    expect(page).toContain('Tick the box to confirm.');
    // Manage (a coss Collapsible) renders open.
    expect(page.match(/<section\b[^>]*\bid="manage"[^>]*>/)?.[0]).toContain('data-open=""');
  });
});
