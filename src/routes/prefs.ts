/**
 * Remembered view choices: the dashboard range and the transactions filter. Owner: Experience.
 * A URL that carries the parameter always wins and becomes the remembered value, so every state
 * still has its own URL; a bare URL (the nav link) brings back the last choice.
 */

import { getCookie, setCookie } from 'hono/cookie';
import { cookieSpec } from '../lib/cookies';
import type { AppContext } from './util';

/** A year: these are preferences, not sessions. */
const MAX_AGE = 365 * 24 * 60 * 60;

export function rememberedQuery(
  c: AppContext,
  param: string,
  cookieBase: string,
  valid: (v: string) => boolean,
): string | undefined {
  const { name, secure } = cookieSpec(c, cookieBase);
  const saved = getCookie(c, name);
  const fromUrl = c.req.query(param);
  if (fromUrl !== undefined && valid(fromUrl)) {
    if (saved !== fromUrl) setCookie(c, name, fromUrl, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: MAX_AGE });
    return fromUrl;
  }
  return saved !== undefined && valid(saved) ? saved : undefined;
}
