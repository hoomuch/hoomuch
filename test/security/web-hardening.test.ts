/**
 * Security regressions for the web layer (OWASP review, 2026-11-05): response headers, CSRF on
 * every state-changing form, spoofed client-IP headers, and the account-wide login limit.
 * Runs through the real Worker pipeline (middleware, routes) on the in-memory D1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { authenticate, registerUser } from '../../src/lib/auth';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY } from '../../src/lib/time';
import { createTestD1, seedUser, testEnv, type TestD1 } from '../fixtures/d1';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
const PW = 'correct horse battery';
let t: TestD1;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
});

afterEach(() => {
  t.sqlite.close();
  vi.useRealTimers();
});

function send(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch!(req as never, testEnv(t.db), ctx as never) as Promise<Response>;
}

function postForm(path: string, form: Record<string, string>, headers: Record<string, string>): Promise<Response> {
  return send(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

describe('response headers', () => {
  it('sends a strict CSP, framing, transport and permission headers on pages', async () => {
    const res = await send('/login');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const pp = res.headers.get('permissions-policy') ?? '';
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()']) expect(pp).toContain(feature);
  });

  it('keeps the headers on error pages too', async () => {
    const res = await send('/no-such-page');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('CSRF', () => {
  const session = { cookie: `__Host-hm_session=${TOKEN}` };
  // Every state-changing form in the app. A cross-site page must not be able to submit any of them.
  const forms: [string, Record<string, string>][] = [
    ['/logout', {}],
    ['/settings/currency', { currency: 'EUR' }],
    ['/settings/password', { current_password: PW, new_password: 'another long password' }],
    ['/settings/delete', { password: PW, confirm: 'yes' }],
    ['/connections/demo', {}],
    ['/connections', { provider: 'demo' }],
  ];

  it.each(forms)('rejects a cross-site POST to %s', async (path, form) => {
    const res = await postForm(path, form, { ...session, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    // Nothing happened: the session is still valid and the user still exists.
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    expect(t.sqlite.prepare("SELECT base_currency FROM users WHERE id = 'u1'").get()).toEqual({ base_currency: 'USD' });
  });

  it('skips CSRF for provider webhooks only: the owner’s webhook form keeps it', async () => {
    const crossSite = { ...session, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await postForm(`/connections/${id}/webhook`, { action: 'off' }, crossSite)).status).toBe(403);
    expect((await postForm('/webhooksx/settings', { currency: 'EUR' }, crossSite)).status).toBe(403);
    // A provider's form-encoded call reaches the webhook route (404: no such connection), not a 403.
    expect((await postForm(`/webhooks/${id}/${'A'.repeat(43)}`, { email: 'x' }, crossSite)).status).toBe(404);
  });

  it('rejects a POST with neither Origin nor Sec-Fetch-Site', async () => {
    const res = await postForm('/settings/currency', { currency: 'EUR' }, session);
    expect(res.status).toBe(403);
  });

  it('rejects a same-site but cross-origin POST (a sibling subdomain)', async () => {
    const res = await postForm('/settings/currency', { currency: 'EUR' }, {
      ...session,
      origin: 'https://evil.hoomuch.test',
      'sec-fetch-site': 'same-site',
    });
    expect(res.status).toBe(403);
  });

  it('rejects text/plain bodies (the third simple-request content type)', async () => {
    const res = await send('/settings/currency', {
      method: 'POST',
      headers: { ...session, origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: 'currency=EUR',
    });
    expect(res.status).toBe(403);
  });

  it('accepts the same-origin form post', async () => {
    const res = await postForm('/settings/currency', { currency: 'EUR' }, { ...session, origin: ORIGIN });
    expect(res.status).toBe(303);
    expect(t.sqlite.prepare("SELECT base_currency FROM users WHERE id = 'u1'").get()).toEqual({ base_currency: 'EUR' });
  });
});

describe('client IP for throttling', () => {
  it('ignores X-Forwarded-For, so rotating it does not reset the login limit', async () => {
    await registerUser(testEnv(t.db), 'owner@example.com', PW, '198.51.100.1');
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await postForm(
        '/login',
        { email: 'owner@example.com', password: 'wrong password!' },
        { origin: ORIGIN, 'x-forwarded-for': `10.0.${i}.1` },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  }, 30_000);

  it('buckets by CF-Connecting-IP, which Cloudflare sets', async () => {
    await registerUser(testEnv(t.db), 'owner@example.com', PW, '198.51.100.1');
    for (let i = 0; i < 10; i++) {
      await postForm('/login', { email: 'owner@example.com', password: 'wrong password!' }, { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' });
    }
    const blocked = await postForm('/login', { email: 'owner@example.com', password: PW }, { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' });
    expect(blocked.status).toBe(429);
    const other = await postForm('/login', { email: 'owner@example.com', password: PW }, { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.10' });
    expect(other.status).toBe(303);
  }, 30_000);
});

describe('account-wide login limit', () => {
  it('stops distributed guessing from many networks, even with the right password', async () => {
    const env = testEnv(t.db);
    await registerUser(env, 'target@example.com', PW, '198.51.100.1');
    // 50 different /64s, one guess each: none of them hits the per-network limit.
    for (let i = 0; i < 50; i++) {
      const r = await authenticate(env, 'target@example.com', `guess number ${i}`, `2001:db8:${i.toString(16)}::1`);
      expect(r).toEqual({ ok: false, error: 'Email or password is incorrect.' });
    }
    const r = await authenticate(env, 'target@example.com', PW, '2001:db8:ffff::1');
    expect(r).toMatchObject({ ok: false, throttled: true });
    // Other accounts are unaffected.
    await registerUser(env, 'other@example.com', PW, '198.51.100.2');
    expect(await authenticate(env, 'other@example.com', PW, '2001:db8:ffff::1')).toMatchObject({ ok: true });
  }, 60_000);

  it('lapses when the window closes', async () => {
    const env = testEnv(t.db);
    await registerUser(env, 'target@example.com', PW, '198.51.100.1');
    for (let i = 0; i < 50; i++) await authenticate(env, 'target@example.com', 'nope nope nope', `2001:db8:${i.toString(16)}::1`);
    expect(await authenticate(env, 'target@example.com', PW, '192.0.2.1')).toMatchObject({ throttled: true });
    vi.setSystemTime(NOW + 15 * 60_000 + 1);
    expect(await authenticate(env, 'target@example.com', PW, '192.0.2.1')).toMatchObject({ ok: true });
  }, 60_000);

  it('treats an unknown email exactly like a known one (no account probing)', async () => {
    const env = testEnv(t.db);
    for (let i = 0; i < 50; i++) await authenticate(env, 'ghost@example.com', 'nope nope nope', `2001:db8:${i.toString(16)}::1`);
    expect(await authenticate(env, 'ghost@example.com', 'nope nope nope', '192.0.2.1')).toMatchObject({ ok: false, throttled: true });
  }, 60_000);
});
