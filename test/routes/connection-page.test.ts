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
    expect(flash(res)).not.toBeNull();
    expect(pending).toHaveLength(0);
  });

  it('shows the run in progress, then its result', async () => {
    const running = await (await send('GET', `/connections/${REAL}?sync=${NOW}`)).text();
    expect(running).toContain('Syncing now, usually in a few seconds.');
    expect(running).toContain(`content="5;url=/connections/${REAL}?sync=${NOW}&amp;poll=1"`);
    expect(running).toMatch(/<button type="submit" disabled="" class="btn[^"]*">Syncing…<\/button>/);

    run(NOW + 50, NOW + 2_000, 1, 12);
    const done = await (await send('GET', `/connections/${REAL}?sync=${NOW}&poll=1`)).text();
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
    const page = await (await send('GET', '/connections', undefined, [flash(res)!])).text();
    expect(page).toContain('Demo data removed.');
    expect(page).toMatch(/<form method="post" action="\/connections\/demo" class="inline"><button type="submit"[^>]*>Add it back<\/button><\/form>/);
  });

  it('only sends demo removals back to the dashboard or the connections list', async () => {
    const res = await send('POST', `/connections/${DEMO}/delete`, { back: '//evil.example' });
    expect(res.headers.get('location')).toBe('/connections');
  });

  it('keeps the confirmation for a real connection and reopens Manage when it’s missing', async () => {
    const res = await send('POST', `/connections/${REAL}/delete`, {});
    expect(res.headers.get('location')).toBe(`/connections/${REAL}?manage=open`);
    expect((await listConnections(t.db, 'u1')).map((c) => c.id).sort()).toEqual([REAL, DEMO].sort());
    const page = await (await send('GET', `/connections/${REAL}?manage=open`, undefined, [flash(res)!])).text();
    expect(page).toContain('Tick the box to confirm.');
    expect(page).toContain('<details id="manage" open=""');
  });
});
