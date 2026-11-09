/**
 * Remembered view choices: the dashboard range, its revenue chart and the transactions filter. Owner: Experience.
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
  const saved = getCookie(c, cookieSpec(c, cookieBase).name);
  const fromUrl = c.req.query(param);
  if (fromUrl !== undefined && valid(fromUrl)) {
    remember(c, cookieBase, fromUrl);
    return fromUrl;
  }
  return saved !== undefined && valid(saved) ? saved : undefined;
}

/** Remembers a choice the page made in place, without a reload (the revenue card's switch). */
export function remember(c: AppContext, cookieBase: string, value: string): void {
  const { name, secure } = cookieSpec(c, cookieBase);
  if (getCookie(c, name) !== value) setCookie(c, name, value, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: MAX_AGE });
}
