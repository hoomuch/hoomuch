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

export function setFlash(c: Context<AppEnv>, type: FlashType, message: string): void {
  const value = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ type, message: message.slice(0, 300) })));
  const { name, secure } = cookieSpec(c, FLASH_COOKIE);
  setCookie(c, name, value, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 60 });
}

/** Reads (and clears) the flash cookie into c.var.flash. */
export const loadFlash = createMiddleware<AppEnv>(async (c, next) => {
  c.set('flash', null);
  const { name, secure } = cookieSpec(c, FLASH_COOKIE);
  const raw = getCookie(c, name);
  if (raw && raw.length <= 1024) {
    deleteCookie(c, name, { path: '/', secure });
    try {
      const v = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw))) as Partial<Flash>;
      if ((v.type === 'success' || v.type === 'error' || v.type === 'info') && typeof v.message === 'string') {
        c.set('flash', { type: v.type, message: v.message });
      }
    } catch {
      // ignore malformed cookie
    }
  }
  await next();
});

/** setFlash + 303 redirect, the common PRG ending of a form handler. */
export function redirectWithFlash(c: Context<AppEnv>, to: string, type: FlashType, message: string): Response {
  setFlash(c, type, message);
  return c.redirect(to, 303);
}
