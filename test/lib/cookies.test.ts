/** Lead: cookie naming/flags on HTTPS vs plain-HTTP localhost (SPEC §8). */

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/env';
import { loadUser, startSession } from '../../src/lib/auth';
import { loadFlash, setFlash } from '../../src/lib/flash';
import { insertUser } from '../../src/db/queries';
import { createTestD1, testEnv, type TestD1 } from '../fixtures/d1';

let t: TestD1 | null = null;
afterEach(() => {
  t?.sqlite.close();
  t = null;
});

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', loadFlash);
  a.use('*', loadUser);
  a.post('/in', async (c) => {
    await startSession(c, 'u1');
    setFlash(c, 'info', 'hi');
    return c.text('ok');
  });
  a.get('/me', (c) => c.json({ user: c.get('user')?.email ?? null, flash: c.get('flash')?.message ?? null }));
  return a;
}

async function setup() {
  t = createTestD1();
  const env = testEnv(t.db);
  await insertUser(env.DB, { id: 'u1', email: 'c@example.com', passwordHash: 'x' });
  return env;
}

const fakeCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

describe('cookies', () => {
  it('use __Host- names with Secure on HTTPS, and round-trip', async () => {
    const env = await setup();
    const res = await app().request('https://hoomuch.example.com/in', { method: 'POST' }, env, fakeCtx);
    const set = res.headers.getSetCookie();
    const session = set.find((h) => h.startsWith('__Host-hm_session='));
    const flash = set.find((h) => h.startsWith('__Host-hm_flash='));
    expect(session).toMatch(/; Path=\/;.*Secure/);
    expect(session).not.toMatch(/Domain=/i);
    expect(flash).toMatch(/Secure/);

    const cookie = set.map((h) => h.split(';')[0]).join('; ');
    const me = await app().request('https://hoomuch.example.com/me', { headers: { cookie } }, env, fakeCtx);
    expect(await me.json()).toEqual({ user: 'c@example.com', flash: 'hi' });

    // A bare (non-prefixed) cookie planted by a sibling subdomain is ignored on HTTPS.
    const planted = cookie.replaceAll('__Host-', '');
    const me2 = await app().request('https://hoomuch.example.com/me', { headers: { cookie: planted } }, env, fakeCtx);
    expect(await me2.json()).toEqual({ user: null, flash: null });
  });

  it('are Secure even on plain HTTP for non-local hosts', async () => {
    const env = await setup();
    const res = await app().request('http://hoomuch.example.com/in', { method: 'POST' }, env, fakeCtx);
    expect(res.headers.getSetCookie().every((h) => h.startsWith('__Host-') && /Secure/.test(h))).toBe(true);
  });

  it('keep bare names without Secure on http://localhost (local dev)', async () => {
    const env = await setup();
    const res = await app().request('http://localhost:8787/in', { method: 'POST' }, env, fakeCtx);
    const set = res.headers.getSetCookie();
    expect(set.some((h) => h.startsWith('hm_session=') && !/Secure/.test(h))).toBe(true);
  });
});
