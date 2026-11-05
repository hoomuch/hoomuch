/**
 * Abuse hardening (2026-11-05): disposable-email sign-ups, credential stuffing from one network,
 * bulk sign-ups, request floods (Rate Limiting bindings), the honeypot and optional Turnstile.
 * Library rules run on the in-memory D1; HTTP behaviour goes through the real Worker pipeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { authenticate, DAILY_KEY_PREFIX, DAILY_WINDOW_MS, registerUser, THROTTLE_WINDOW_MS } from '../../src/lib/auth';
import { HONEYPOT_FIELD, TURNSTILE_FIELD, turnstileSiteKey, verifyTurnstile } from '../../src/lib/bot-defense';
import { isDisposableEmail } from '../../src/lib/disposable-email';
import { DISPOSABLE_DOMAINS } from '../../src/lib/disposable-domains';
import { deleteStaleLoginAttempts } from '../../src/db/queries';
import { DAY, MINUTE } from '../../src/lib/time';
import type { Bindings } from '../../src/env';
import { createTestD1, testEnv, type TestD1 } from '../fixtures/d1';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const PW = 'correct horse battery';
const SITE_KEY = '0x4AAAAAAAtestsitekey';
const SECRET = '0x4AAAAAAAtestsecret';
let t: TestD1;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
});

afterEach(() => {
  t.sqlite.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const users = () => (t.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

function send(path: string, init: RequestInit = {}, env: Partial<Bindings> = {}): Promise<Response> {
  const req = new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch!(req as never, testEnv(t.db, env), ctx as never) as Promise<Response>;
}

function postForm(path: string, form: Record<string, string>, env: Partial<Bindings> = {}, ip = '203.0.113.7') {
  return send(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'cf-connecting-ip': ip },
      body: new URLSearchParams(form).toString(),
    },
    env,
  );
}

/** A Rate Limiting binding that records keys and answers with `success`. */
function fakeLimiter(success: boolean | (() => never)) {
  const keys: string[] = [];
  const binding: RateLimit = {
    async limit({ key }) {
      keys.push(key);
      if (typeof success === 'function') success();
      return { success: success as boolean };
    },
  };
  return { binding, keys };
}

// ---------- disposable email ----------

describe('disposable email domains', () => {
  it('matches listed domains and their subdomains, case-insensitively', () => {
    expect(isDisposableEmail('someone@mailinator.com')).toBe(true);
    expect(isDisposableEmail('someone@MAILINATOR.com')).toBe(true);
    expect(isDisposableEmail('someone@inbox.mailinator.com')).toBe(true);
    expect(isDisposableEmail('someone@mailinator.com.')).toBe(true);
    expect(isDisposableEmail('someone@guerrillamail.com')).toBe(true);
  });

  it('lets ordinary providers and look-alikes through', () => {
    for (const email of ['a@gmail.com', 'a@outlook.com', 'a@proton.me', 'a@icloud.com', 'a@company.co.uk']) {
      expect(isDisposableEmail(email)).toBe(false);
    }
    expect(isDisposableEmail('a@hoomuchmailinator.com')).toBe(false); // ends like one, isn't a subdomain
    expect(isDisposableEmail('no-at-sign')).toBe(false);
  });

  it('never lists a mainstream mailbox provider (guards every list refresh)', () => {
    const listed = new Set(DISPOSABLE_DOMAINS.split('\n'));
    const mainstream = [
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
      'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'gmx.de', 'yandex.com', 'zoho.com',
      'fastmail.com', 'hey.com', 'tutanota.com', 'mail.ru', 'qq.com',
    ];
    expect(mainstream.filter((d) => listed.has(d))).toEqual([]);
    expect(listed.size).toBeGreaterThan(1000);
  });

  it('refuses a disposable address at sign-up, on the email field, and creates nothing', async () => {
    const env = testEnv(t.db);
    expect(await registerUser(env, 'bot@yopmail.com', PW, '203.0.113.7')).toMatchObject({ ok: false, field: 'email' });
    expect(await registerUser(env, 'bot@sub.mailinator.com', PW, '203.0.113.7')).toMatchObject({ ok: false, field: 'email' });
    expect(users()).toBe(0);
    expect((await registerUser(env, 'real@example.com', PW, '203.0.113.7')).ok).toBe(true);
  });
});

// ---------- D1 limits ----------

describe('daily account cap per network', () => {
  it('allows 5 new accounts a day from one network, then refuses until the day has passed', async () => {
    const env = testEnv(t.db);
    for (let i = 0; i < 5; i++) expect((await registerUser(env, `u${i}@example.com`, PW, '2001:db8:5::1')).ok).toBe(true);
    // Same /64, different address: still the same network.
    const sixth = await registerUser(env, 'u5@example.com', PW, '2001:db8:5::ffff');
    expect(sixth).toMatchObject({ ok: false, throttled: true });
    expect(sixth.ok === false && sixth.error).toMatch(/today/);
    // Another network is unaffected.
    expect((await registerUser(env, 'other@example.com', PW, '198.51.100.20')).ok).toBe(true);
    vi.setSystemTime(NOW + DAY);
    expect((await registerUser(env, 'u5@example.com', PW, '2001:db8:5::1')).ok).toBe(true);
  });

  it('does not count sign-ups that fail validation or hit a taken email', async () => {
    const env = testEnv(t.db);
    await registerUser(env, 'taken@example.com', PW, '198.51.100.30');
    for (let i = 0; i < 4; i++) await registerUser(env, 'taken@example.com', PW, '203.0.113.9');
    await registerUser(env, 'short@example.com', 'short', '203.0.113.9');
    await registerUser(env, 'bot@yopmail.com', PW, '203.0.113.9');
    // 6 attempts so far from this network, none created an account: all 5 accounts are still available.
    for (let i = 0; i < 4; i++) expect((await registerUser(env, `n${i}@example.com`, PW, '203.0.113.9')).ok).toBe(true);
  });
});

describe('login attempts per network, across emails', () => {
  it('stops credential stuffing: 30 attempts per 15 minutes from one network, whatever the email', async () => {
    const env = testEnv(t.db);
    await registerUser(env, 'victim@example.com', PW, '198.51.100.40');
    for (let i = 0; i < 30; i++) {
      const r = await authenticate(env, `guess${i}@example.com`, 'some password', '203.0.113.50');
      expect(r.ok === false && r.throttled).toBeFalsy();
    }
    // The 31st is refused before any hashing, even for a real account with the right password.
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    expect(await authenticate(env, 'victim@example.com', PW, '203.0.113.50')).toMatchObject({ ok: false, throttled: true });
    expect(derive).not.toHaveBeenCalled();
    // Other networks are unaffected, and the window lapses.
    expect((await authenticate(env, 'victim@example.com', PW, '198.51.100.41')).ok).toBe(true);
    vi.setSystemTime(NOW + 15 * MINUTE);
    expect((await authenticate(env, 'victim@example.com', PW, '203.0.113.50')).ok).toBe(true);
  });
});

describe('throttle cleanup', () => {
  it('drops short-window rows after 15 minutes but keeps day-long rows for a day', async () => {
    const insert = (key: string, start: number) =>
      t.exec('INSERT INTO login_attempts (key, failures, window_start) VALUES (?, 1, ?)', key, start);
    insert('short-fresh', NOW - 5 * MINUTE);
    insert('short-stale', NOW - 16 * MINUTE);
    insert(`${DAILY_KEY_PREFIX}fresh`, NOW - 20 * 60 * MINUTE);
    insert(`${DAILY_KEY_PREFIX}stale`, NOW - DAY - MINUTE);
    await deleteStaleLoginAttempts(t.db, NOW, { shortMs: THROTTLE_WINDOW_MS, dailyMs: DAILY_WINDOW_MS, dailyPrefix: DAILY_KEY_PREFIX });
    const keys = (t.sqlite.prepare('SELECT key FROM login_attempts ORDER BY key').all() as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual([`${DAILY_KEY_PREFIX}fresh`, 'short-fresh']);
  });
});

// ---------- Rate Limiting bindings ----------

describe('request rate limits', () => {
  it('turns a flood away with 429 and Retry-After before the session lookup', async () => {
    const { binding, keys } = fakeLimiter(false);
    const prepare = vi.spyOn(t.db, 'prepare');
    const res = await send('/login', { headers: { 'cf-connecting-ip': '2001:db8:9:9::1', cookie: '__Host-hm_session=abc' } }, { RL_REQUESTS: binding });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(prepare).not.toHaveBeenCalled();
    // Keyed by network: the IPv6 /64, not the single address.
    expect(keys).toEqual(['req|2001:db8:9:9::/64']);
  });

  it('serves normally while under the limit, and fails open if the binding errors', async () => {
    expect((await send('/login', {}, { RL_REQUESTS: fakeLimiter(true).binding })).status).toBe(200);
    const broken = fakeLimiter(() => {
      throw new Error('binding down');
    });
    expect((await send('/login', {}, { RL_REQUESTS: broken.binding })).status).toBe(200);
  });

  it('limits log-in and sign-up submissions separately, before any password hashing', async () => {
    const { binding, keys } = fakeLimiter(false);
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const login = await postForm('/login', { email: 'a@example.com', password: PW }, { RL_AUTH: binding });
    expect(login.status).toBe(429);
    expect(login.headers.get('retry-after')).toBe('60');
    expect(await login.text()).toContain('Too many attempts');
    const signup = await postForm('/signup', { email: 'b@example.com', password: PW }, { RL_AUTH: binding });
    expect(signup.status).toBe(429);
    expect(derive).not.toHaveBeenCalled();
    expect(users()).toBe(0);
    expect(keys).toEqual(['auth|203.0.113.7', 'auth|203.0.113.7']);
  });
});

// ---------- honeypot ----------

describe('honeypot', () => {
  it('refuses a sign-up that fills the hidden field, and creates nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await postForm('/signup', { email: 'bot@example.com', password: PW, [HONEYPOT_FIELD]: 'https://spam.example' });
    expect(res.status).toBe(400);
    expect(users()).toBe(0);
    // Logged without the email or the IP.
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('bot_honeypot')) ?? '';
    expect(line).toContain('"form":"signup"');
    expect(line).not.toContain('bot@example.com');
    expect(line).not.toContain('203.0.113.7');
  });

  it('refuses a log-in that fills it, before any password hashing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const res = await postForm('/login', { email: 'a@example.com', password: PW, [HONEYPOT_FIELD]: 'x' });
    expect(res.status).toBe(400);
    expect(derive).not.toHaveBeenCalled();
  });

  it('is in the form, hidden from people and assistive tech, and an empty one passes', async () => {
    const html = await (await send('/signup')).text();
    const trap = /<div class="hidden" aria-hidden="true"><label>[^<]*(<input [^>]*>)<\/label><\/div>/.exec(html)?.[1] ?? '';
    expect(trap).toContain(`name="${HONEYPOT_FIELD}"`);
    expect(trap).toContain('tabindex="-1"');
    expect(trap.toLowerCase()).toContain('autocomplete="off"');
    const res = await postForm('/signup', { email: 'human@example.com', password: PW, [HONEYPOT_FIELD]: '' });
    expect(res.status).toBe(303);
    expect(users()).toBe(1);
  });
});

// ---------- Turnstile ----------

describe('turnstileSiteKey', () => {
  it('is on only when both keys are set', () => {
    expect(turnstileSiteKey({})).toBeNull();
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: SITE_KEY })).toBeNull();
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: SECRET })).toBeNull();
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET_KEY: SECRET })).toBe(SITE_KEY);
  });
});

describe('verifyTurnstile', () => {
  const opts = { ip: '203.0.113.7', action: 'signup' as const, hostname: 'hoomuch.test' };
  function siteverify(reply: unknown, status = 200) {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: new URLSearchParams(String(init.body)) });
      return new Response(JSON.stringify(reply), { status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('passes a fresh token issued for this form on this site, sending secret, token and IP', async () => {
    const { fetchImpl, calls } = siteverify({ success: true, action: 'signup', hostname: 'hoomuch.test' });
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: SECRET }, 'tok', opts, fetchImpl)).toBe('ok');
    expect(calls[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(Object.fromEntries(calls[0]!.body)).toEqual({ secret: SECRET, response: 'tok', remoteip: '203.0.113.7' });
  });

  it('rejects a failed check, a token from another form or another site', async () => {
    const env = { TURNSTILE_SECRET_KEY: SECRET };
    expect(await verifyTurnstile(env, 'tok', opts, siteverify({ success: false }).fetchImpl)).toBe('failed');
    expect(await verifyTurnstile(env, 'tok', opts, siteverify({ success: true, action: 'login', hostname: 'hoomuch.test' }).fetchImpl)).toBe('failed');
    expect(await verifyTurnstile(env, 'tok', opts, siteverify({ success: true, action: 'signup', hostname: 'evil.example' }).fetchImpl)).toBe('failed');
  });

  it('needs no network call for a missing or oversized token', async () => {
    const { fetchImpl, calls } = siteverify({ success: true });
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: SECRET }, '', opts, fetchImpl)).toBe('missing');
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: SECRET }, 'x'.repeat(2049), opts, fetchImpl)).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('fails closed when Siteverify is down, without logging the token or secret', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: SECRET }, 'tok-secret-value', opts, siteverify({}, 500).fetchImpl)).toBe('unavailable');
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: SECRET }, 'tok-secret-value', opts, down)).toBe('unavailable');
    const logged = err.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('turnstile_unavailable');
    expect(logged).not.toContain('tok-secret-value');
    expect(logged).not.toContain(SECRET);
  });

  it("accepts Cloudflare's dummy test secret on any host (its tokens say action \"test\", hostname \"localhost\")", async () => {
    const { fetchImpl } = siteverify({ success: true, action: 'test', hostname: 'localhost' });
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }, 'XXXX.DUMMY.TOKEN.XXXX', opts, fetchImpl)).toBe('ok');
  });
});

describe('Turnstile on the auth pages', () => {
  const on = { TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_SECRET_KEY: SECRET };

  it('allows challenges.cloudflare.com in the CSP of /login and /signup only, and only when on', async () => {
    for (const path of ['/login', '/signup']) {
      const csp = (await send(path, {}, on)).headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
      expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    }
    const landing = (await send('/', {}, on)).headers.get('content-security-policy') ?? '';
    expect(landing).toContain("script-src 'self';");
    expect(landing).not.toContain('challenges.cloudflare.com');
    const off = (await send('/signup')).headers.get('content-security-policy') ?? '';
    expect(off).not.toContain('challenges.cloudflare.com');
  });

  it('hands the site key to the page only when on', async () => {
    expect(await (await send('/signup', {}, on)).text()).toContain(`"turnstileSiteKey":"${SITE_KEY}"`);
    expect(await (await send('/signup')).text()).not.toContain(SITE_KEY);
  });

  it('refuses a sign-up without a token, then accepts one Siteverify passes', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, action: 'signup', hostname: 'hoomuch.test' })));
    vi.stubGlobal('fetch', fetchSpy);
    const missing = await postForm('/signup', { email: 'human@example.com', password: PW }, on);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('security check');
    expect(users()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    const ok = await postForm('/signup', { email: 'human@example.com', password: PW, [TURNSTILE_FIELD]: 'tok' }, on);
    expect(ok.status).toBe(303);
    expect(users()).toBe(1);
  });

  it('refuses a log-in whose token fails, before any password hashing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }))));
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const res = await postForm('/login', { email: 'a@example.com', password: PW, [TURNSTILE_FIELD]: 'bad' }, on);
    expect(res.status).toBe(400);
    expect(derive).not.toHaveBeenCalled();
  });
});
