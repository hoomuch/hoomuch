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
import { PASSWORD_MAX, PASSWORD_MIN } from './password-policy';
import { isDisposableEmail } from './disposable-email';
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

export { PASSWORD_MIN };

/** Base name; on HTTPS the cookie is `__Host-hm_session` (see lib/cookies.ts). */
export const SESSION_COOKIE = 'hm_session';
const SESSION_TTL_MS = 30 * DAY;
const SESSION_REFRESH_BELOW_MS = 15 * DAY;
/** Hard cap: sliding renewal never keeps one session alive longer than this. */
const SESSION_ABSOLUTE_MAX_MS = 90 * DAY;

export const THROTTLE_WINDOW_MS = 15 * MINUTE;
/** Attempts per window for login (per email + IP) and password re-checks (per user). */
const THROTTLE_MAX_ATTEMPTS = 10;
/** Sign-up attempts per window per IP (counted whether they succeed or not). */
const SIGNUP_MAX_ATTEMPTS = 10;
/**
 * Login attempts per window from one network, whatever the email. The email + network limit
 * doesn't see credential stuffing (one guess each at many accounts), and every attempt costs a
 * PBKDF2 hash, so this also bounds the CPU one network can make the Worker burn.
 */
const LOGIN_IP_MAX_ATTEMPTS = 30;
/** Accounts actually created from one network per day. Bounds bulk sign-ups that pace themselves. */
const SIGNUP_DAILY_MAX = 5;
export const DAILY_WINDOW_MS = DAY;
/**
 * Day-long counters get this readable prefix on their (hashed) key so the cron can keep them for a
 * day while still dropping the 15-minute ones after 15 minutes. See deleteStaleLoginAttempts.
 */
export const DAILY_KEY_PREFIX = 'day:';
/**
 * Login attempts per window for one email from every network combined. The per-network limit
 * alone doesn't bound a botnet or an IPv6 range (one bucket per /64; a /48 holds 65,536), so
 * this caps distributed guessing against one account (OWASP Authentication Cheat Sheet: count
 * against the account, not just the source). Generous, so a typo-prone owner never meets it.
 */
const ACCOUNT_MAX_ATTEMPTS = 50;

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

/**
 * Keyboard rows and digit runs. A password that is one slice of these (either direction) is among
 * the first an attacker tries, whatever its length.
 */
const SEQUENCES = [
  '01234567890',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'qwertzuiop',
  'azertyuiop',
  '1qaz2wsx3edc4rfv5tgb6yhn',
  '1q2w3e4r5t6y7u8i9o0p',
  'q1w2e3r4t5y6u7i8o9p0',
];

/**
 * Words that top every leaked-password list. Matched as the whole password once trailing digits
 * and symbols are stripped, so "password123", "Qwerty2026!" and "letmein!!!!" are all caught.
 */
const COMMON_WORDS = new Set([
  'password', 'passw0rd', 'p@ssw0rd', 'qwerty', 'qwertyuiop', 'iloveyou', 'letmein', 'welcome', 'admin',
  'administrator', 'monkey', 'dragon', 'football', 'baseball', 'basketball', 'princess', 'sunshine',
  'superman', 'batman', 'trustno', 'starwars', 'whatever', 'shadow', 'master', 'michael', 'jennifer',
  'computer', 'internet', 'changeme', 'secret', 'login', 'abc', 'abcd', 'test', 'hello', 'freedom',
]);

/**
 * OWASP ASVS v5 6.2.4 / 6.2.11 (NIST SP 800-63B): refuse passwords that are common or built from
 * the context (the account's email, the app's name). No composition rules: length does the work.
 */
function guessable(pw: string, email: string): boolean {
  const p = pw.toLowerCase();
  if (new Set(p).size < 5) return true; // "aaaaaaaaaa", "1212121212", "abcabcabca"
  if (SEQUENCES.some((s) => s.includes(p) || [...s].reverse().join('').includes(p))) return true;
  if (COMMON_WORDS.has(p.replace(/[^a-z@]+$/, '').replace(/^[^a-z@]+/, ''))) return true;
  // Context words: the email, its name part, the app's name, padded out to length ("taha2026!!").
  // Only when little else is left, so "the matter is settled" stays fine for matt@….
  const address = normalizeEmail(email);
  for (const word of [address, address.split('@')[0] ?? '', 'hoomuch']) {
    if (word.length >= 4 && p.includes(word) && p.replaceAll(word, '').length < PASSWORD_MIN) return true;
  }
  return false;
}

function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `That password is too long. Use ${PASSWORD_MAX} characters or fewer.`;
  if (guessable(pw, email)) return 'That password is too easy to guess. Try a few unrelated words.';
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
async function reserveAttempt(
  env: Bindings,
  key: string,
  now: number,
  max: number,
  windowMs: number = THROTTLE_WINDOW_MS,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO login_attempts (key, failures, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
       window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
     RETURNING failures`,
  )
    .bind(key, now, now, windowMs, now, windowMs, now)
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
  if (isDisposableEmail(email)) {
    return { ok: false, error: 'Use an email address you’ll keep. Disposable inboxes can’t sign up.', field: 'email' };
  }
  const pwErr = passwordProblem(password, email);
  if (pwErr) return { ok: false, error: pwErr, field: 'password' };
  const exists = { ok: false as const, error: 'An account with this email already exists. Log in instead.', field: 'email' as const };
  if (await getUserByEmail(env.DB, email)) return exists;
  // Counted only once the sign-up would go through, so typos and taken emails don't use it up.
  const dayKey = DAILY_KEY_PREFIX + (await sha256Hex(`signup-day|${ipBucket(ip)}`));
  if (!(await reserveAttempt(env, dayKey, Date.now(), SIGNUP_DAILY_MAX, DAILY_WINDOW_MS))) {
    return { ok: false, error: 'Too many accounts were created from this network today. Try again tomorrow.', throttled: true };
  }
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
  const now = Date.now();
  const bucket = ipBucket(ip);
  // Every attempt from this network, whatever the email: credential stuffing tries each account once.
  if (!(await reserveAttempt(env, await sha256Hex(`login-ip|${bucket}`), now, LOGIN_IP_MAX_ATTEMPTS))) {
    return { ok: false, error: THROTTLED_MESSAGE, throttled: true };
  }
  const key = await sha256Hex(`login|${email}|${bucket}`);
  if (!(await reserveAttempt(env, key, now, THROTTLE_MAX_ATTEMPTS))) {
    return { ok: false, error: THROTTLED_MESSAGE, throttled: true };
  }
  // Keyed by the email whether or not an account exists, so the limit reveals nothing. Not
  // cleared on success: it lapses with its window, and a login can't reset an attacker's count.
  if (!(await reserveAttempt(env, await sha256Hex(`login-account|${email}`), now, ACCOUNT_MAX_ATTEMPTS))) {
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
  const problem = passwordProblem(next, user.email);
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

/**
 * Client IP for throttling. Cloudflare sets CF-Connecting-IP on every request and overwrites any
 * value the client sent. X-Forwarded-For is never read: the client controls it, so trusting it
 * would let each request pick a fresh throttle bucket.
 */
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip')?.trim() || 'unknown';
}
