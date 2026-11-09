/**
 * "This browser has a session": a hint the page's own script can read. Owner: Lead.
 *
 * The public pages (/p/, /u/, /explore) render without the visitor's session, so one HTML can be
 * cached for everyone. After hydration they read this hint to offer "Dashboard" instead of
 * "Log in", and to open the chart views an account unlocks without a click on the lock first.
 *
 * It proves nothing and holds nothing: the value is "1", the session itself is the HttpOnly
 * cookie, and every request that needs an account checks that one. A stale hint (a session that
 * ended elsewhere) only shows a "Dashboard" link that asks for a log-in; the next app page a
 * signed-out browser loads clears it (lib/auth.ts loadUser).
 */

/** Base name; on HTTPS the cookie is `__Host-hm_in` (see lib/cookies.ts). */
export const SIGNED_IN_COOKIE = 'hm_in';

/** Whether `document.cookie` carries the hint, under either name. */
export function hasSignedInHint(cookies: string): boolean {
  return /(?:^|;\s*)(?:__Host-)?hm_in=1(?:;|$)/.test(cookies);
}
