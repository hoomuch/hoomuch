/**
 * Accounts, sessions and login throttling. Owner: Lead. See SPEC.md §8.
 * Routes should stay thin: call registerUser / authenticate / startSession / endSession.
 */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, Bindings, SessionUser } from '../env';
import { hashPassword, randomId, randomToken, sha256Hex, verifyPassword } from './crypto';
import { DAY, MINUTE } from './time';
import { cookieSpec } from './cookies';
import {
  deleteOtherSessions,
  deleteSession,
  extendSession,
  getSessionWithUser,
  getUserByEmail,
  getUserById,
  insertSession,
  insertUser,
  updateUserPassword,
} from '../db/queries';

/** Base name; on HTTPS the cookie is `__Host-hm_session` (see lib/cookies.ts). */
export const SESSION_COOKIE = 'hm_session';
const SESSION_TTL_MS = 30 * DAY;
const SESSION_REFRESH_BELOW_MS = 15 * DAY;
/** Hard cap: sliding renewal never keeps one session alive longer than this. */
const SESSION_ABSOLUTE_MAX_MS = 90 * DAY;

export const PASSWORD_MIN = 10;
const PASSWORD_MAX = 256;
const THROTTLE_WINDOW_MS = 15 * MINUTE;
/** Attempts per window for login (per email + IP) and password re-checks (per user). */
const THROTTLE_MAX_ATTEMPTS = 10;
/** Sign-up attempts per window per IP (counted whether they succeed or not). */
const SIGNUP_MAX_ATTEMPTS = 10;

/** Well-formed hash that matches no password; verifying against it equalises timing for unknown emails. */
const DUMMY_HASH = 'pbkdf2$100000$c29tZS1zYWx0LWZvci10aW1pbmc$2pX8YQ2yq1xS0bqgk5r4zC5N4bJt0bq0yq3s9m7vK1A';

function setSessionCookie(c: Context<AppEnv>, token: string): void {
  const { name, secure } = cookieSpec(c, SESSION_COOKIE);
  setCookie(c, name, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

function readSessionToken(c: Context<AppEnv>): string | undefined {
  const token = getCookie(c, cookieSpec(c, SESSION_COOKIE).name);
  return token && token.length <= 64 ? token : undefined;
}

export function signupAllowed(env: Bindings): boolean {
  return env.ALLOW_SIGNUP !== 'false';
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function passwordProblem(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `That password is too long. Use ${PASSWORD_MAX} characters or fewer.`;
  return null;
}

const THROTTLED_MESSAGE = 'Too many attempts. Try again in 15 minutes.';

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; error: string; field?: 'email' | 'password'; throttled?: true };

// ---------- attempt throttling (login, sign-up, password re-checks) ----------

/**
 * Atomically counts one attempt against `key` BEFORE any expensive work and says whether it is
 * still within `max` for the current window. Counting first (single upsert … RETURNING) means
 * parallel requests can't all slip past a read-then-write check.
 */
async function reserveAttempt(env: Bindings, key: string, now: number, max: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO login_attempts (key, failures, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
       window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
     RETURNING failures`,
  )
    .bind(key, now, now, THROTTLE_WINDOW_MS, now, THROTTLE_WINDOW_MS, now)
    .first<{ failures: number }>();
  return (row?.failures ?? 1) <= max;
}

async function clearAttempts(env: Bindings, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

/**
 * Throttling bucket for a client address. IPv6 is grouped by /64 — one host usually owns a
 * whole /64, so per-address buckets would make the limit meaningless.
 */
export function ipBucket(ip: string): string {
  const v = ip.trim().toLowerCase().split('%')[0] ?? '';
  if (!v.includes(':')) return v; // IPv4 or "unknown"
  if (v.includes('.')) return v.slice(v.lastIndexOf(':') + 1); // IPv4-mapped (::ffff:1.2.3.4)
  const [head = '', tail] = v.split('::', 2);
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, '') || '0')
    .join(':')}::/64`;
}

/** One bucket per user for re-entering the current password (change password, delete account). */
function passwordCheckKey(userId: string): Promise<string> {
  return sha256Hex(`password-check|${userId}`);
}

// ---------- accounts ----------

export async function registerUser(env: Bindings, emailRaw: string, password: string, ip: string): Promise<AuthResult> {
  if (!signupAllowed(env)) return { ok: false, error: 'Sign-ups are closed on this instance.' };
  // Bounds account creation and email probing ("already exists") from one network.
  if (!(await reserveAttempt(env, await sha256Hex(`signup|${ipBucket(ip)}`), Date.now(), SIGNUP_MAX_ATTEMPTS))) {
    return { ok: false, error: THROTTLED_MESSAGE, throttled: true };
  }
  const email = normalizeEmail(emailRaw);
  if (!validEmail(email)) return { ok: false, error: 'Enter a valid email address.', field: 'email' };
  const pwErr = passwordProblem(password);
  if (pwErr) return { ok: false, error: pwErr, field: 'password' };
  const exists = { ok: false as const, error: 'An account with this email already exists. Log in instead.', field: 'email' as const };
  if (await getUserByEmail(env.DB, email)) return exists;
  const id = randomId();
  try {
    await insertUser(env.DB, { id, email, passwordHash: await hashPassword(password) });
  } catch (err) {
    // Two concurrent sign-ups with the same email: the loser hits the UNIQUE index.
    if (/UNIQUE/i.test(String(err))) return exists;
    throw err;
  }
  return { ok: true, userId: id };
}

export async function authenticate(env: Bindings, emailRaw: string, password: string, ip: string): Promise<AuthResult> {
  const email = normalizeEmail(emailRaw);
  const key = await sha256Hex(`login|${email}|${ipBucket(ip)}`);
  if (!(await reserveAttempt(env, key, Date.now(), THROTTLE_MAX_ATTEMPTS))) {
    return { ok: false, error: THROTTLED_MESSAGE, throttled: true };
  }

  const user = validEmail(email) ? await getUserByEmail(env.DB, email) : null;
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (user && ok) {
    await clearAttempts(env, key);
    return { ok: true, userId: user.id };
  }
  return { ok: false, error: 'Email or password is incorrect.' };
}

export type PasswordCheck = { ok: true } | { ok: false; error: string; throttled: boolean };

/**
 * Re-checks the signed-in user's password before sensitive actions. Throttled per user, so a
 * hijacked session can't be used to brute-force the password.
 */
export async function confirmPassword(env: Bindings, userId: string, password: string): Promise<PasswordCheck> {
  const key = await passwordCheckKey(userId);
  if (!(await reserveAttempt(env, key, Date.now(), THROTTLE_MAX_ATTEMPTS))) {
    return { ok: false, error: THROTTLED_MESSAGE, throttled: true };
  }
  const row = await getUserById(env.DB, userId);
  if (row && (await verifyPassword(password, row.password_hash))) {
    await clearAttempts(env, key);
    return { ok: true };
  }
  return { ok: false, error: 'Password is incorrect.', throttled: false };
}

export async function changePassword(
  c: Context<AppEnv>,
  current: string,
  next: string,
): Promise<{ ok: true } | { ok: false; error: string; field: 'current' | 'next' }> {
  const user = currentUser(c);
  const check = await confirmPassword(c.env, user.id, current);
  if (!check.ok) {
    return { ok: false, error: check.throttled ? check.error : 'Current password is incorrect.', field: 'current' };
  }
  const problem = passwordProblem(next);
  if (problem) return { ok: false, error: problem, field: 'next' };
  await updateUserPassword(c.env.DB, user.id, await hashPassword(next));
  // Revoke every session, this one included (a stolen copy of this cookie must die too),
  // then sign this browser back in with a fresh token.
  await deleteOtherSessions(c.env.DB, user.id);
  await startSession(c, user.id);
  return { ok: true };
}

// ---------- sessions ----------

export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
  // Signing in over an existing session revokes the old one instead of leaving it valid.
  const previous = readSessionToken(c);
  if (previous) await deleteSession(c.env.DB, await sha256Hex(previous));
  const token = randomToken();
  await insertSession(c.env.DB, await sha256Hex(token), userId, Date.now() + SESSION_TTL_MS);
  setSessionCookie(c, token);
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const token = readSessionToken(c);
  if (token) await deleteSession(c.env.DB, await sha256Hex(token));
  const { name, secure } = cookieSpec(c, SESSION_COOKIE);
  deleteCookie(c, name, { path: '/', secure });
  c.set('user', null);
}

/** Populates c.var.user from the session cookie (null when signed out). Sliding expiry. */
export const loadUser = createMiddleware<AppEnv>(async (c, next) => {
  c.set('user', null);
  const token = readSessionToken(c);
  if (token) {
    const sessionId = await sha256Hex(token);
    const now = Date.now();
    const row = await getSessionWithUser(c.env.DB, sessionId, now, now - SESSION_ABSOLUTE_MAX_MS);
    if (row) {
      c.set('user', { id: row.user_id, email: row.email, baseCurrency: row.base_currency });
      if (row.expires_at - now < SESSION_REFRESH_BELOW_MS) {
        await extendSession(c.env.DB, sessionId, now + SESSION_TTL_MS);
        setSessionCookie(c, token);
      }
    }
  }
  await next();
});

/** Redirects to /login?next=… when signed out. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('user')) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 303);
  }
  await next();
});

/** The signed-in user. Only call behind `requireUser`. */
export function currentUser(c: Context<AppEnv>): SessionUser {
  const u = c.get('user');
  if (!u) throw new Error('currentUser() called without requireUser');
  return u;
}

/**
 * Only same-site relative paths survive; everything else becomes /dashboard.
 * Allowlist, not blocklist: printable ASCII only (browsers strip tab/CR/LF anywhere in a URL, so
 * "/\t/evil.com" would become "//evil.com"), no backslash anywhere, and no leading "//".
 */
export function safeNext(next: string | undefined | null): string {
  if (!next || !/^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/.test(next)) return '/dashboard';
  return next;
}

/** Client IP for throttling (Cloudflare sets CF-Connecting-IP). */
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}
