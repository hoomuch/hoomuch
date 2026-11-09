/**
 * Email verification: the check-your-inbox page, resending the link, and the mailed link itself.
 * Owner: Experience (routes). See SPEC.md §8.
 *
 * The mailed link (GET) only shows a button; the POST behind it spends the token. Mail scanners
 * that fetch every link in a message therefore can't confirm an address on their own.
 */

import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { allowVerificationResend, currentUser, requireSignedIn, safeNext } from '../lib/auth';
import {
  checkLink,
  CONFIRM_PATH,
  confirmLink,
  sendVerificationLink,
  TOKEN_MAX,
  VERIFY_LINK_TTL_MS,
  VERIFY_PATH,
  verificationRequired,
} from '../lib/email-verification';
import { redirectWithFlash, setCelebrate, takeNext } from '../lib/flash';
import { HOUR } from '../lib/time';
import { renderPage } from '../views/render';
import { chrome, formLimit, readForm, type AppContext } from './util';

const LINK_HOURS = Math.round(VERIFY_LINK_TTL_MS / HOUR);

export const MAIL_FAILED_MESSAGE = 'We couldn’t send the email just now. Try “Send the link again” in a minute.';
const RESEND_MESSAGES = {
  wait: 'You’ve asked for a few links already. Wait 15 minutes, then try again.',
  tomorrow: 'You’ve asked for a lot of links today. Try again tomorrow, or check your spam folder.',
} as const;

/** The verify pages leave the app's nav out: nothing behind it opens until the address is confirmed. */
function bareChrome(c: AppContext) {
  return { ...chrome(c), user: null };
}

/** True when this signed-in account is being held for verification. */
function held(c: AppContext): boolean {
  return verificationRequired(c.env) && c.get('emailUnverified');
}

export function registerVerifyEmailRoutes(app: Hono<AppEnv>): void {
  app.get(VERIFY_PATH, requireSignedIn, (c) => {
    if (!held(c)) return c.redirect('/dashboard', 303);
    return renderPage(c, 'verifyEmail', {
      chrome: bareChrome(c),
      state: 'pending',
      email: currentUser(c).email,
      linkHours: LINK_HOURS,
    });
  });

  app.post(`${VERIFY_PATH}/resend`, requireSignedIn, formLimit, async (c) => {
    if (!held(c)) return c.redirect('/dashboard', 303);
    const user = currentUser(c);
    const again = { chrome: bareChrome(c), state: 'pending', email: user.email, linkHours: LINK_HOURS } as const;
    const allowed = await allowVerificationResend(c.env, user.id);
    if (allowed !== 'ok') return renderPage(c, 'verifyEmail', { ...again, error: RESEND_MESSAGES[allowed] }, 429);
    if (!(await sendVerificationLink(c.env, user, new URL(c.req.url).origin))) {
      return renderPage(c, 'verifyEmail', { ...again, error: MAIL_FAILED_MESSAGE }, 503);
    }
    return redirectWithFlash(c, VERIFY_PATH, 'success', 'Sent. The new link is on its way.');
  });

  // The link in the email. Read-only: says straight away when it's expired or unknown.
  app.get(CONFIRM_PATH, async (c) => {
    const token = (c.req.query('token') ?? '').slice(0, TOKEN_MAX + 1);
    const base = { chrome: bareChrome(c), linkHours: LINK_HOURS, signedIn: Boolean(c.get('user')) };
    const state = await checkLink(c.env.DB, token, Date.now());
    if (state === 'valid') return renderPage(c, 'verifyEmail', { ...base, state: 'confirm', token });
    return renderPage(c, 'verifyEmail', { ...base, state }, state === 'expired' ? 410 : 400);
  });

  app.post(CONFIRM_PATH, formLimit, async (c) => {
    const form = await readForm(c);
    const result = await confirmLink(c.env.DB, form.text('token', TOKEN_MAX + 1), Date.now());
    if (!result.ok) {
      return renderPage(
        c,
        'verifyEmail',
        { chrome: bareChrome(c), linkHours: LINK_HOURS, signedIn: Boolean(c.get('user')), state: result.reason },
        result.reason === 'expired' ? 410 : 400,
      );
    }
    if (c.get('user')?.id === result.userId) {
      // The welcome sign-up used to give: one confetti burst, no flash, on the page they signed
      // up from (a public page's lock) if there was one, or the empty dashboard.
      setCelebrate(c);
      return c.redirect(safeNext(takeNext(c)), 303);
    }
    // Opened in another browser or device. The link proves the address, not the password: log in.
    return redirectWithFlash(c, '/login', 'success', 'Email confirmed. Log in to continue.');
  });
}
