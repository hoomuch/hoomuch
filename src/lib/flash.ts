/**
 * One-shot flash messages carried across a Post/Redirect/Get via a short-lived cookie.
 * Owner: Lead.
 */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, Flash, FlashType } from '../env';
import { cookieSpec } from './cookies';
import { base64UrlToBytes, bytesToBase64Url } from './crypto';

/** Base name; on HTTPS the cookie is `__Host-hm_flash` (see lib/cookies.ts). */
const FLASH_COOKIE = 'hm_flash';
/** A one-shot "throw confetti on the next page" marker (after sign-up). No message, no box. */
const CELEBRATE_COOKIE = 'hm_celebrate';
/** Where a sign-up was headed (`next`), kept while the account waits for its confirmation link. */
const RETURN_COOKIE = 'hm_next';
/** The longest `next` kept; carryNext (routes/auth.tsx) has already checked it's a same-site path. */
const RETURN_MAX = 512;

/** An Undo posts to one of our own paths: a single leading slash, then a plain path. */
const UNDO_ACTION_RE = /^\/[a-z0-9][a-z0-9/_-]{0,95}$/i;

export function setFlash(c: Context<AppEnv>, type: FlashType, message: string, undo?: Flash['undo']): void {
  const payload: Flash = { type, message: message.slice(0, 300) };
  if (undo && UNDO_ACTION_RE.test(undo.action)) payload.undo = { label: undo.label.slice(0, 40), action: undo.action };
  const value = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const { name, secure } = cookieSpec(c, FLASH_COOKIE);
  setCookie(c, name, value, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 60 });
}

/** Confetti on the next page, once. Rides the same Post/Redirect/Get as a flash. */
export function setCelebrate(c: Context<AppEnv>): void {
  const { name, secure } = cookieSpec(c, CELEBRATE_COOKIE);
  setCookie(c, name, '1', { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 60 });
}

/**
 * Keeps `next` across the email confirmation, so a visitor who signed up from a public page's lock
 * lands back on it once they confirm in this browser, not on an empty dashboard.
 */
export function rememberNext(c: Context<AppEnv>, next: string, maxAgeSeconds: number): void {
  if (next.length > RETURN_MAX) return;
  const { name, secure } = cookieSpec(c, RETURN_COOKIE);
  setCookie(c, name, encodeURIComponent(next), { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: maxAgeSeconds });
}

/** The kept `next`, cleared as it's read; null when there's none. Pass it through safeNext. */
export function takeNext(c: Context<AppEnv>): string | null {
  const { name, secure } = cookieSpec(c, RETURN_COOKIE);
  const raw = getCookie(c, name);
  if (raw === undefined) return null;
  deleteCookie(c, name, { path: '/', secure });
  try {
    return raw.length <= RETURN_MAX * 3 ? decodeURIComponent(raw) : null;
  } catch {
    return null;
  }
}

/** Reads (and clears) the flash cookie into c.var.flash, and the celebrate cookie into c.var.celebrate. */
export const loadFlash = createMiddleware<AppEnv>(async (c, next) => {
  c.set('flash', null);
  c.set('celebrate', false);
  const party = cookieSpec(c, CELEBRATE_COOKIE);
  if (getCookie(c, party.name) !== undefined) {
    deleteCookie(c, party.name, { path: '/', secure: party.secure });
    c.set('celebrate', true);
  }
  const { name, secure } = cookieSpec(c, FLASH_COOKIE);
  const raw = getCookie(c, name);
  if (raw && raw.length <= 1024) {
    deleteCookie(c, name, { path: '/', secure });
    try {
      const v = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw))) as Partial<Flash>;
      if ((v.type === 'success' || v.type === 'error' || v.type === 'info') && typeof v.message === 'string') {
        const u = v.undo;
        const undo =
          u && typeof u.label === 'string' && typeof u.action === 'string' && UNDO_ACTION_RE.test(u.action)
            ? { label: u.label.slice(0, 40), action: u.action }
            : undefined;
        c.set('flash', undo ? { type: v.type, message: v.message, undo } : { type: v.type, message: v.message });
      }
    } catch {
      // ignore malformed cookie
    }
  }
  await next();
});

/** setFlash + 303 redirect, the common PRG ending of a form handler. */
export function redirectWithFlash(
  c: Context<AppEnv>,
  to: string,
  type: FlashType,
  message: string,
  undo?: Flash['undo'],
): Response {
  setFlash(c, type, message, undo);
  return c.redirect(to, 303);
}
