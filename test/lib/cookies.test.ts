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
    // Not readable by scripts, and not sent on cross-site subrequests or form posts.
    for (const c of [session, flash]) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
    // The one a script may read: "1", the hint public pages use to offer Dashboard (lib/signed-in.ts).
    const hint = set.find((h) => h.startsWith('__Host-hm_in='));
    expect(hint).toMatch(/^__Host-hm_in=1; /);
    expect(hint).not.toMatch(/HttpOnly/i);
    expect(hint).toMatch(/SameSite=Lax/i);
    expect(hint).toMatch(/Secure/);

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
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(3); // session + signed-in hint + flash; `every` alone would pass on none
    expect(set.every((h) => h.startsWith('__Host-') && /Secure/.test(h))).toBe(true);
  });

  it('keep bare names without Secure on http://localhost (local dev)', async () => {
    const env = await setup();
    const res = await app().request('http://localhost:8787/in', { method: 'POST' }, env, fakeCtx);
    const set = res.headers.getSetCookie();
    expect(set.some((h) => h.startsWith('hm_session=') && !/Secure/.test(h))).toBe(true);
    // Local dev drops only Secure and the prefix; the other flags stay.
    for (const c of set.filter((h) => !h.startsWith('hm_in='))) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
    expect(set.some((h) => h.startsWith('hm_in=1;') && !/Secure|HttpOnly/i.test(h))).toBe(true);
  });

  it('keep the signed-in hint in step with the session', async () => {
    const env = await setup();
    const res = await app().request('https://hoomuch.example.com/in', { method: 'POST' }, env, fakeCtx);
    const session = res.headers.getSetCookie().find((h) => h.startsWith('__Host-hm_session='))!.split(';')[0]!;
    // A session from before the hint existed gets one on its next page.
    const old = await app().request('https://hoomuch.example.com/me', { headers: { cookie: session } }, env, fakeCtx);
    expect(old.headers.getSetCookie().some((h) => h.startsWith('__Host-hm_in=1;'))).toBe(true);
    // A hint without a session (it ended in another browser) is dropped.
    const stale = await app().request('https://hoomuch.example.com/me', { headers: { cookie: '__Host-hm_in=1' } }, env, fakeCtx);
    expect(stale.headers.getSetCookie().some((h) => h.startsWith('__Host-hm_in=;') && /Max-Age=0/.test(h))).toBe(true);
    // Both in step: nothing to send.
    const fine = await app().request('https://hoomuch.example.com/me', { headers: { cookie: `${session}; __Host-hm_in=1` } }, env, fakeCtx);
    expect(fine.headers.getSetCookie()).toEqual([]);
  });
});
