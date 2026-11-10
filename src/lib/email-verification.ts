/**
 * Email verification: single-use links that expire, proving the person owns the address they
 * signed up with. Owner: Lead. See SPEC.md §8.
 *
 * On only while mail is (lib/mail.ts). Tokens are stored as their SHA-256 hash, like sessions;
 * the raw token only travels in the mailed link and the confirm form. Never log either.
 */

import type { Bindings } from '../env';
import {
  consumeEmailVerification,
  getEmailVerification,
  insertEmailVerification,
  markEmailVerified,
} from '../db/queries';
import { randomToken, sha256Hex } from './crypto';
import { escapeHtml, mailEnabled, sendMail, type MailMessage } from './mail';
import { DAY } from './time';

/** How long a mailed link works. A new one can be sent from the check-your-inbox page. */
export const VERIFY_LINK_TTL_MS = DAY;
/** The check-your-inbox page an unverified account is held at. */
export const VERIFY_PATH = '/verify-email';
/** Where the mailed link points: a page with one button that confirms (GET never does). */
export const CONFIRM_PATH = '/verify-email/confirm';
/** randomToken() is 32 bytes: 43 base64url characters. Anything else is never looked up. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const TOKEN_MAX = 43;

/** True when new accounts must confirm their address before using the app. */
export function verificationRequired(env: Pick<Bindings, 'RESEND_API_KEY'>): boolean {
  return mailEnabled(env);
}

function wellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export type LinkState = 'valid' | 'expired' | 'invalid';

/** Read-only look at a link, so the confirm page can say up front that it's expired or unknown. */
export async function checkLink(db: D1Database, token: string, now: number): Promise<LinkState> {
  if (!wellFormedToken(token)) return 'invalid';
  const row = await getEmailVerification(db, await sha256Hex(token));
  if (!row) return 'invalid';
  return row.expires_at > now ? 'valid' : 'expired';
}

export type ConfirmResult = { ok: true; userId: string } | { ok: false; reason: 'expired' | 'invalid' };

/**
 * Spends a link and marks its account verified. The row is deleted and read back in one
 * statement, so two clicks racing each other can't both succeed.
 */
export async function confirmLink(db: D1Database, token: string, now: number): Promise<ConfirmResult> {
  if (!wellFormedToken(token)) return { ok: false, reason: 'invalid' };
  const id = await sha256Hex(token);
  const userId = await consumeEmailVerification(db, id, now);
  if (!userId) {
    // Expired rows stay until the account is confirmed or removed (see purgeAbandonedAccounts).
    return { ok: false, reason: (await getEmailVerification(db, id)) ? 'expired' : 'invalid' };
  }
  await markEmailVerified(db, userId, now);
  return { ok: true, userId };
}

/**
 * Issues a fresh link for the account and mails it. Earlier links keep working until they expire.
 * `origin` is the request's own origin, so the link points at the instance that sent it.
 * False when the mail couldn't be sent; the person can ask for another.
 */
export async function sendVerificationLink(
  env: Bindings,
  user: { id: string; email: string },
  origin: string,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const token = randomToken();
  await insertEmailVerification(env.DB, await sha256Hex(token), user.id, now + VERIFY_LINK_TTL_MS, now);
  const link = `${origin}${CONFIRM_PATH}?token=${token}`;
  return sendMail(env, verificationMessage(env.APP_NAME || 'hoomuch', user.email, link), fetchImpl);
}

/** The confirmation email: plain text first, a minimal HTML copy with the same words. */
export function verificationMessage(appName: string, to: string, link: string): MailMessage {
  const hours = Math.round(VERIFY_LINK_TTL_MS / 3_600_000);
  const lines = [
    `Confirm your email to finish setting up ${appName}:`,
    '',
    link,
    '',
    `The link works once and expires in ${hours} hours.`,
    `If you didn’t sign up for ${appName}, ignore this email and no account will be activated.`,
  ];
  const name = escapeHtml(appName);
  const href = escapeHtml(link);
  const html =
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">' +
    `<p>Confirm your email to finish setting up ${name}:</p>` +
    `<p><a href="${href}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Confirm my email</a></p>` +
    `<p style="color:#555">Or paste this link into your browser:<br>${href}</p>` +
    `<p style="color:#555">The link works once and expires in ${hours} hours. If you didn’t sign up for ${name}, ignore this email and no account will be activated.</p>` +
    '</body></html>';
  return { to, subject: `Confirm your email for ${appName}`, text: lines.join('\n'), html };
}
