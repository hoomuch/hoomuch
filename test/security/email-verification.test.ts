/**
 * Email verification (2026-11-05): sign-up mails a single-use link that expires, and the account is
 * held at "check your inbox" until it's used. Off without RESEND_API_KEY. Everything goes through
 * the real Worker pipeline on the in-memory D1, with Resend's API stubbed.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { purgeAbandonedAccounts } from '../../src/db/queries';
import { sha256Hex } from '../../src/lib/crypto';
import { VERIFY_LINK_TTL_MS, verificationMessage } from '../../src/lib/email-verification';
import { RESEND_ENDPOINT, sendMail } from '../../src/lib/mail';
import { DAY, MINUTE } from '../../src/lib/time';
import type { Bindings } from '../../src/env';
import schema from '../../migrations/0001_init.sql?raw';
import currencySource from '../../migrations/0002_currency_source.sql?raw';
import providerIds from '../../migrations/0003_provider_ids.sql?raw';
import emailVerification from '../../migrations/0004_email_verification.sql?raw';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const PW = 'correct horse battery';
const EMAIL = 'ada@example.com';
const MAIL_ON: Partial<Bindings> = { RESEND_API_KEY: 're_test_key_0123456789', MAIL_FROM: 'hoomuch <hello@hoomuch.test>' };

let t: TestD1;
let mails: Array<{ headers: Record<string, string>; body: { from: string; to: string[]; subject: string; text: string; html: string } }>;
let resendStatus: number;
let logs: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  mails = [];
  resendStatus = 200;
  logs = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== RESEND_ENDPOINT) return new Response('{}', { status: 503 }); // FX and the like, in the background
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      mails.push({ headers, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(resendStatus === 200 ? { id: 'msg_1' } : { name: 'application_error', message: `could not send to ${EMAIL}` }), {
        status: resendStatus,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  for (const level of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
  }
});

afterEach(() => {
  t.sqlite.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** One browser: keeps the cookies the Worker sets, like a real one would. */
class Browser {
  private jar = new Map<string, string>();
  constructor(
    private readonly env: Partial<Bindings> = MAIL_ON,
    private readonly ip = '203.0.113.7',
  ) {}

  private async send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', this.ip);
    if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const req = new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' });
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const res = (await worker.fetch!(req as never, testEnv(t.db, this.env), ctx as never)) as Response;
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (/Max-Age=0/i.test(line) || pair.slice(eq + 1) === '') this.jar.delete(name);
      else this.jar.set(name, pair.slice(eq + 1));
    }
    return res;
  }

  get(path: string): Promise<Response> {
    return this.send(path, {});
  }

  post(path: string, form: Record<string, string> = {}): Promise<Response> {
    return this.send(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }

  signUp(email = EMAIL): Promise<Response> {
    return this.post('/signup', { email, password: PW });
  }

  has(cookie: string): boolean {
    return this.jar.has(cookie);
  }
}

const userRow = (email = EMAIL) =>
  t.rows<{ id: string; email_verified_at: number | null }>('SELECT id, email_verified_at FROM users WHERE email = ?', email)[0];
const linkRows = () => t.rows<{ id: string; user_id: string; expires_at: number }>('SELECT * FROM email_verifications');

/** The token in the n-th mailed link (0 = first). */
function mailedToken(n = 0): string {
  const m = /\/verify-email\/confirm\?token=([A-Za-z0-9_-]{43})/.exec(mails[n]?.body.text ?? '');
  if (!m) throw new Error(`no link in mail ${n}`);
  return m[1]!;
}

/** A browser that has just signed up (mail on) and is sitting at check-your-inbox. */
async function signedUp(email = EMAIL, ip?: string): Promise<Browser> {
  const b = new Browser(MAIL_ON, ip);
  const res = await b.signUp(email);
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('/verify-email');
  return b;
}

// ---------- off by default ----------

describe('without RESEND_API_KEY', () => {
  it('signs up straight into the dashboard and mails nothing, as before', async () => {
    const b = new Browser({});
    const res = await b.signUp();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect(b.has('__Host-hm_celebrate')).toBe(true);
    expect((await b.get('/dashboard')).status).toBe(200);
    expect(mails).toEqual([]);
    expect(linkRows()).toEqual([]);
    expect(userRow()?.email_verified_at).toBeNull();
  });

  it('has no check-your-inbox page to be held at', async () => {
    const b = new Browser({});
    await b.signUp();
    expect((await b.get('/verify-email')).headers.get('location')).toBe('/dashboard');
    expect((await b.post('/verify-email/resend')).headers.get('location')).toBe('/dashboard');
    expect(mails).toEqual([]);
  });

  it('stays off with only MAIL_FROM set', async () => {
    const b = new Browser({ MAIL_FROM: 'hello@hoomuch.test' });
    expect((await b.signUp()).headers.get('location')).toBe('/dashboard');
    expect(mails).toEqual([]);
  });
});

// ---------- sign-up and the mail ----------

describe('sign-up with mail on', () => {
  it('mails one link through Resend and holds the account at check-your-inbox', async () => {
    const b = await signedUp('Ada@Example.com');
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    expect(mail!.headers.authorization).toBe(`Bearer ${MAIL_ON.RESEND_API_KEY}`);
    expect(mail!.headers['user-agent']).toBeTruthy(); // Resend refuses requests without one
    expect(mail!.body.from).toBe(MAIL_ON.MAIL_FROM);
    expect(mail!.body.to).toEqual([EMAIL]); // normalised, like the account
    expect(mail!.body.subject).toBe('Confirm your email for hoomuch');
    expect(mail!.body.text).toContain(`${ORIGIN}/verify-email/confirm?token=`);
    expect(mail!.body.html).toContain(`${ORIGIN}/verify-email/confirm?token=`);
    expect(b.has('__Host-hm_celebrate')).toBe(false); // the welcome waits for the confirmation

    const page = await b.get('/verify-email');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Check your inbox');
    expect(html).toContain(EMAIL);
    expect(html).toContain('action="/verify-email/resend"');
    expect(html).not.toContain('href="/settings"'); // no app nav while held
  });

  it('stores only the SHA-256 of the token, expiring in 24 hours', async () => {
    await signedUp();
    const token = mailedToken();
    const rows = linkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(await sha256Hex(token));
    expect(rows[0]!.id).not.toContain(token);
    expect(rows[0]!.user_id).toBe(userRow()!.id);
    expect(rows[0]!.expires_at).toBe(NOW + VERIFY_LINK_TTL_MS);
    expect(VERIFY_LINK_TTL_MS).toBe(DAY);
    expect(userRow()!.email_verified_at).toBeNull();
  });

  it('holds every app page and action, signed in or not', async () => {
    const b = await signedUp();
    for (const path of ['/dashboard', '/connections', '/connections/new', '/transactions', '/settings']) {
      const res = await b.get(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.get('location'), path).toBe('/verify-email');
    }
    const demo = await b.post('/connections/demo');
    expect(demo.headers.get('location')).toBe('/verify-email');
    expect(t.rows('SELECT id FROM connections')).toEqual([]);
    // The landing and log-in pages pass a signed-in visitor on to the dashboard, which holds them too.
    expect((await b.get('/')).headers.get('location')).toBe('/dashboard');
    // Log out still works.
    expect((await b.post('/logout')).headers.get('location')).toBe('/');
    expect((await b.get('/dashboard')).headers.get('location')).toBe('/login?next=%2Fdashboard');
  });

  it('holds the account again after logging back in', async () => {
    const b = await signedUp();
    await b.post('/logout');
    const res = await b.post('/login', { email: EMAIL, password: PW });
    expect(res.headers.get('location')).toBe('/dashboard');
    expect((await b.get('/dashboard')).headers.get('location')).toBe('/verify-email');
  });

  it('still creates the account when Resend fails, says so, and logs neither the address nor the link', async () => {
    resendStatus = 500;
    const b = new Browser();
    const res = await b.signUp();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/verify-email');
    expect(userRow()).toBeTruthy();
    const html = await (await b.get('/verify-email')).text();
    expect(html).toContain('couldn’t send the email');
    const failed = logs.find((l) => l.includes('mail_failed'));
    expect(failed).toContain('"status":500');
    expect(failed).toContain('"code":"application_error"');
    const dump = logs.join('\n');
    expect(dump).not.toContain(EMAIL);
    expect(dump).not.toContain(mailedToken());
    expect(dump).not.toContain(MAIL_ON.RESEND_API_KEY!);
  });

  it('says so when MAIL_FROM is missing, instead of mailing from nowhere', async () => {
    const b = new Browser({ RESEND_API_KEY: MAIL_ON.RESEND_API_KEY });
    expect((await b.signUp()).headers.get('location')).toBe('/verify-email');
    expect(mails).toEqual([]);
    expect(logs.some((l) => l.includes('mail_not_configured') && l.includes('MAIL_FROM'))).toBe(true);
  });
});

// ---------- the link ----------

describe('the mailed link', () => {
  it('shows a confirm button on GET and changes nothing, so mail scanners can’t confirm it', async () => {
    await signedUp();
    const token = mailedToken();
    const res = await new Browser().get(`/verify-email/confirm?token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Confirm my email');
    expect(html).toContain('action="/verify-email/confirm"');
    expect(html).toContain(`name="token" value="${token}"`);
    expect(userRow()!.email_verified_at).toBeNull();
    expect(linkRows()).toHaveLength(1);
  });

  it('confirms in the browser that signed up: dashboard, confetti, links gone', async () => {
    const b = await signedUp();
    const res = await b.post('/verify-email/confirm', { token: mailedToken() });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect(b.has('__Host-hm_celebrate')).toBe(true);
    expect(userRow()!.email_verified_at).toBe(NOW);
    expect(linkRows()).toEqual([]);
    expect((await b.get('/dashboard')).status).toBe(200);
    expect((await b.get('/verify-email')).headers.get('location')).toBe('/dashboard');
  });

  it('confirms from another device without signing it in', async () => {
    const b = await signedUp();
    const phone = new Browser();
    const res = await phone.post('/verify-email/confirm', { token: mailedToken() });
    expect(res.headers.get('location')).toBe('/login');
    expect(phone.has('__Host-hm_session')).toBe(false);
    expect(await (await phone.get('/login')).text()).toContain('Email confirmed. Log in to continue.');
    // The browser that signed up is let through now too.
    expect((await b.get('/dashboard')).status).toBe(200);
  });

  it('works only once', async () => {
    const b = await signedUp();
    const token = mailedToken();
    expect((await b.post('/verify-email/confirm', { token })).status).toBe(303);
    const again = await new Browser().post('/verify-email/confirm', { token });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('This link doesn’t work');
    expect((await new Browser().get(`/verify-email/confirm?token=${token}`)).status).toBe(400);
  });

  it('expires after 24 hours and leaves the account held', async () => {
    const b = await signedUp();
    const token = mailedToken();
    vi.setSystemTime(NOW + VERIFY_LINK_TTL_MS + 1);
    const view = await b.get(`/verify-email/confirm?token=${token}`);
    expect(view.status).toBe(410);
    const html = await view.text();
    expect(html).toContain('This link has expired');
    expect(html).toContain('href="/verify-email"'); // signed in: straight to "send again"
    expect((await b.post('/verify-email/confirm', { token })).status).toBe(410);
    expect(userRow()!.email_verified_at).toBeNull();
    expect((await b.get('/dashboard')).headers.get('location')).toBe('/verify-email');
  });

  it('turns away malformed and unknown tokens', async () => {
    await signedUp();
    const real = mailedToken();
    for (const token of ['', 'abc', `${real}x`, real.replace(/.$/, real.endsWith('A') ? 'B' : 'A'), '../../etc', 'a'.repeat(5000)]) {
      const res = await new Browser().post('/verify-email/confirm', { token });
      expect(res.status, token.slice(0, 10)).toBe(400);
    }
    const signedOut = await new Browser().get('/verify-email/confirm?token=nope');
    expect(signedOut.status).toBe(400);
    expect(await signedOut.text()).toContain('href="/login?next=%2Fverify-email"');
    expect(userRow()!.email_verified_at).toBeNull();
  });

  it('needs a same-origin POST to confirm (CSRF)', async () => {
    await signedUp();
    const req = new Request(`${ORIGIN}/verify-email/confirm`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: mailedToken() }).toString(),
    });
    const res = (await worker.fetch!(req as never, testEnv(t.db, MAIL_ON), { waitUntil() {}, passThroughOnException() {} } as never)) as Response;
    expect(res.status).toBe(403);
    expect(userRow()!.email_verified_at).toBeNull();
  });
});

// ---------- resend ----------

describe('sending the link again', () => {
  it('mails a fresh link, keeps the first one working, and says it went (Post/Redirect/Get)', async () => {
    const b = await signedUp();
    const res = await b.post('/verify-email/resend');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/verify-email');
    expect(mails).toHaveLength(2);
    expect(mailedToken(1)).not.toBe(mailedToken(0));
    expect(linkRows()).toHaveLength(2);
    expect(await (await b.get('/verify-email')).text()).toContain('Sent. The new link is on its way.');
    // Either link confirms; confirming spends both.
    expect((await b.post('/verify-email/confirm', { token: mailedToken(0) })).headers.get('location')).toBe('/dashboard');
    expect(linkRows()).toEqual([]);
  });

  it('allows 3 every 15 minutes and 10 a day per account', async () => {
    const b = await signedUp();
    for (let i = 0; i < 3; i++) expect((await b.post('/verify-email/resend')).status).toBe(303);
    const fourth = await b.post('/verify-email/resend');
    expect(fourth.status).toBe(429);
    expect(await fourth.text()).toContain('Wait 15 minutes');
    expect(mails).toHaveLength(4); // the sign-up's own mail + 3

    vi.setSystemTime(NOW + 16 * MINUTE);
    for (let i = 0; i < 3; i++) expect((await b.post('/verify-email/resend')).status).toBe(303);
    vi.setSystemTime(NOW + 32 * MINUTE);
    for (let i = 0; i < 3; i++) expect((await b.post('/verify-email/resend')).status).toBe(303);
    vi.setSystemTime(NOW + 48 * MINUTE);
    expect((await b.post('/verify-email/resend')).status).toBe(303); // the 10th today
    const eleventh = await b.post('/verify-email/resend');
    expect(eleventh.status).toBe(429);
    expect(await eleventh.text()).toContain('Try again tomorrow');
    expect(mails).toHaveLength(11);

    vi.setSystemTime(NOW + DAY + 49 * MINUTE);
    expect((await b.post('/verify-email/resend')).status).toBe(303);
  });

  it('counts per account, not per browser', async () => {
    const b = await signedUp();
    for (let i = 0; i < 3; i++) await b.post('/verify-email/resend');
    const other = new Browser();
    await other.post('/login', { email: EMAIL, password: PW });
    expect((await other.post('/verify-email/resend')).status).toBe(429);
    // Another account is unaffected.
    const someoneElse = await signedUp('grace@example.com', '198.51.100.9');
    expect((await someoneElse.post('/verify-email/resend')).status).toBe(303);
  });

  it('needs a signed-in, unconfirmed account', async () => {
    const res = await new Browser().post('/verify-email/resend');
    expect(res.headers.get('location')).toBe('/login?next=%2Fverify-email%2Fresend');
    const b = await signedUp();
    await b.post('/verify-email/confirm', { token: mailedToken() });
    expect((await b.post('/verify-email/resend')).headers.get('location')).toBe('/dashboard');
    expect(mails).toHaveLength(1);
  });

  it('says so when Resend is down', async () => {
    const b = await signedUp();
    resendStatus = 503;
    const res = await b.post('/verify-email/resend');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('couldn’t send the email');
  });
});

// ---------- squatting and clean-up ----------

describe('an address someone else signed up with', () => {
  it('stays taken while a link to it is live', async () => {
    await signedUp();
    const res = await new Browser(MAIL_ON, '198.51.100.20').signUp();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('already exists');
  });

  it('is free again once every link has expired: the real owner can sign up', async () => {
    await signedUp();
    const squatter = userRow()!.id;
    vi.setSystemTime(NOW + VERIFY_LINK_TTL_MS + MINUTE);
    const owner = new Browser(MAIL_ON, '198.51.100.20');
    expect((await owner.signUp()).headers.get('location')).toBe('/verify-email');
    expect(userRow()!.id).not.toBe(squatter);
    expect(t.rows('SELECT id FROM sessions WHERE user_id = ?', squatter)).toEqual([]);
    expect(t.rows('SELECT id FROM email_verifications WHERE user_id = ?', squatter)).toEqual([]);
    // The owner confirms with the new mail; the squatter's old link stays dead.
    expect((await owner.post('/verify-email/confirm', { token: mailedToken(1) })).headers.get('location')).toBe('/dashboard');
    expect((await new Browser().post('/verify-email/confirm', { token: mailedToken(0) })).status).toBe(400);
  });

  it('is never taken from a confirmed account', async () => {
    const b = await signedUp();
    await b.post('/verify-email/confirm', { token: mailedToken() });
    vi.setSystemTime(NOW + 30 * DAY);
    const res = await new Browser(MAIL_ON, '198.51.100.20').signUp();
    expect(res.status).toBe(400);
    expect(userRow()!.email_verified_at).toBe(NOW);
  });
});

describe('purgeAbandonedAccounts (cron)', () => {
  it('removes only unconfirmed accounts whose links have all expired and that hold nothing', async () => {
    const link = (userId: string, expiresAt: number, n = 0) =>
      t.exec('INSERT INTO email_verifications (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', `${userId}-${n}`, userId, expiresAt, 0);
    seedUser(t, { id: 'abandoned' });
    link('abandoned', NOW - 1);
    link('abandoned', NOW - DAY, 1);
    seedUser(t, { id: 'live-link' });
    link('live-link', NOW - 1);
    link('live-link', NOW + 1, 1);
    seedUser(t, { id: 'confirmed' });
    t.exec('UPDATE users SET email_verified_at = 1 WHERE id = ?', 'confirmed');
    link('confirmed', NOW - 1);
    seedUser(t, { id: 'has-data' }); // created while mail was off, asked for a link later, never clicked
    link('has-data', NOW - 1);
    seedConnection(t, { id: 'c1', userId: 'has-data', provider: 'demo' });
    seedUser(t, { id: 'never-mailed' }); // created while mail was off

    expect(await purgeAbandonedAccounts(t.db, NOW)).toBe(1);
    expect(t.rows<{ id: string }>('SELECT id FROM users ORDER BY id').map((r) => r.id)).toEqual([
      'confirmed',
      'has-data',
      'live-link',
      'never-mailed',
    ]);
    expect(t.rows("SELECT id FROM email_verifications WHERE user_id = 'abandoned'")).toEqual([]);
  });

  it('runs in the scheduled handler', async () => {
    await signedUp();
    vi.setSystemTime(NOW + VERIFY_LINK_TTL_MS + MINUTE);
    const pending: Promise<unknown>[] = [];
    await worker.scheduled!(
      { scheduledTime: Date.now(), cron: '*/30 * * * *', noRetry() {} } as never,
      testEnv(t.db, MAIL_ON),
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as never,
    );
    await Promise.all(pending);
    expect(userRow()).toBeUndefined();
  });
});

// ---------- existing accounts ----------

describe('accounts that predate verification', () => {
  it('are marked confirmed by migration 0004', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schema);
    db.exec(currencySource);
    db.exec(providerIds);
    db.prepare('INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('old', 'old@example.com', 'x', 1234, 1234);
    db.exec(emailVerification);
    expect(db.prepare('SELECT email_verified_at FROM users').get()).toEqual({ email_verified_at: 1234 });
    db.close();
  });

  it('keep using the app once mail is turned on', async () => {
    seedUser(t, { id: 'old', email: 'old@example.com' });
    t.exec('UPDATE users SET email_verified_at = 0');
    const token = 'existing-session-token';
    t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(token), 'old', NOW + DAY, NOW);
    const req = new Request(`${ORIGIN}/dashboard`, { headers: { cookie: `__Host-hm_session=${token}` }, redirect: 'manual' });
    const res = (await worker.fetch!(req as never, testEnv(t.db, MAIL_ON), { waitUntil() {}, passThroughOnException() {} } as never)) as Response;
    expect(res.status).toBe(200);
  });

  it('created while mail was off are asked to confirm once it is on, and can', async () => {
    const off = new Browser({});
    await off.signUp();
    expect((await off.get('/dashboard')).status).toBe(200);

    const on = new Browser(MAIL_ON);
    await on.post('/login', { email: EMAIL, password: PW });
    expect((await on.get('/dashboard')).headers.get('location')).toBe('/verify-email');
    expect((await on.post('/verify-email/resend')).status).toBe(303);
    expect((await on.post('/verify-email/confirm', { token: mailedToken() })).headers.get('location')).toBe('/dashboard');
    expect((await on.get('/dashboard')).status).toBe(200);
  });
});

// ---------- logging and the mailer ----------

describe('privacy', () => {
  it('never logs the address, the token or the key across the whole flow', async () => {
    const b = await signedUp();
    await b.post('/verify-email/resend');
    await b.post('/verify-email/confirm', { token: 'x'.repeat(43) });
    await b.post('/verify-email/confirm', { token: mailedToken(1) });
    const dump = logs.join('\n');
    for (const secret of [EMAIL, mailedToken(0), mailedToken(1), MAIL_ON.RESEND_API_KEY!]) expect(dump).not.toContain(secret);
  });

  it('sendMail reports network failures and timeouts as false, logging only the error name', async () => {
    const failing = (async () => {
      throw new TypeError(`fetch failed for ${EMAIL}`);
    }) as unknown as typeof fetch;
    const msg = verificationMessage('hoomuch', EMAIL, `${ORIGIN}/verify-email/confirm?token=${'t'.repeat(43)}`);
    expect(await sendMail(MAIL_ON, msg, failing)).toBe(false);
    expect(logs.at(-1)).toBe('{"event":"mail_failed","message":"TypeError"}');
  });

  it('escapes the instance name and link in the HTML copy', () => {
    const msg = verificationMessage('<b>hoo</b>', EMAIL, 'https://x.test/verify-email/confirm?token=a&b="c"');
    expect(msg.html).not.toContain('<b>hoo</b>');
    expect(msg.html).toContain('&lt;b&gt;hoo&lt;/b&gt;');
    expect(msg.html).toContain('token=a&amp;b=&quot;c&quot;');
    expect(msg.text).toContain('expires in 24 hours');
  });
});
