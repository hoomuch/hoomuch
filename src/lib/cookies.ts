/**
 * Cookie naming and flags shared by sessions and flash messages. Owner: Lead. See SPEC.md §8.
 *
 * Everywhere except plain-HTTP local development, cookies are `Secure` and carry the `__Host-`
 * prefix, so a sibling subdomain can't plant or overwrite them (no Domain, Path=/, Secure).
 * Local dev over http://localhost keeps the bare name, because some browsers (Safari) won't store
 * Secure cookies on plain-HTTP localhost.
 */

import type { Context } from 'hono';

function isLocalDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

export interface CookieSpec {
  name: string;
  secure: boolean;
}

export function cookieSpec(c: Context, base: string): CookieSpec {
  const url = new URL(c.req.url);
  const secure = url.protocol === 'https:' || !isLocalDevHost(url.hostname);
  return { name: secure ? `__Host-${base}` : base, secure };
}
