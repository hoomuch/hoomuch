/** Settings: display currency, time zone, email digest, password change, account deletion. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { mediaKeysOfUser } from '../db/public';
import { deleteUser, getDigestUser, updateUserCurrency, updateUserTimezone } from '../db/queries';
import type { AppEnv } from '../env';
import { changePassword, confirmPassword, currentUser, endSession, requireUser } from '../lib/auth';
import { redirectWithFlash } from '../lib/flash';
import { isSupportedCurrency, normalizeCurrency } from '../lib/money';
import { normalizeTimeZone, timeZoneOptions, zoneLabel } from '../lib/time';
import { chooseDigest, digestAvailable, isDigestKind, rescheduleDigest } from '../services/digest';
import { deleteImages } from '../services/media';
import { chrome, formLimit, readForm } from './util';
import { renderPage } from '../views/render';

const PASSWORD_INPUT_MAX = 1024;

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  app.get('/settings', requireUser, async (c) => {
    const user = currentUser(c);
    // Both sources came with the session (lib/auth.ts). The digest is read only where mail is on.
    const digest = digestAvailable(c.env) ? ((await getDigestUser(c.env.DB, user.id))?.digest ?? 'off') : undefined;
    return renderPage(c, 'settings', {
        chrome: chrome(c),
        currency: user.baseCurrency,
        currencySource: c.get('currencySource'),
        timeZone: user.timeZone,
        timeZoneSource: c.get('timezoneSource'),
        timeZones: timeZoneOptions(),
        ...(digest ? { digest } : {}),
      });
  });

  app.post('/settings/digest', requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const kind = form.text('digest', 16);
    if (!digestAvailable(c.env)) return redirectWithFlash(c, '/settings', 'error', 'This instance doesn’t send email, so there’s no digest to turn on.');
    if (!isDigestKind(kind)) return redirectWithFlash(c, '/settings', 'error', 'Pick one of the listed options.');
    await chooseDigest(c.env.DB, user.id, kind, user.timeZone, new URL(c.req.url).origin);
    const saved =
      kind === 'off'
        ? 'Saved. The email digest is off.'
        : `Saved. Your digest arrives every Monday morning, around 8:00 in ${zoneLabel(user.timeZone)}.`;
    return redirectWithFlash(c, '/settings', 'success', saved);
  });

  app.post('/settings/timezone', requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const zone = normalizeTimeZone(form.text('timezone', 64));
    if (!zone) return redirectWithFlash(c, '/settings', 'error', 'Pick one of the listed time zones.');
    await updateUserTimezone(c.env.DB, user.id, zone);
    // A digest that's on moves to 8:00 in the new zone.
    await rescheduleDigest(c.env.DB, user.id, zone);
    return redirectWithFlash(c, '/settings', 'success', `Saved. Days now run midnight to midnight in ${zoneLabel(zone)}.`);
  });

  app.post('/settings/currency', requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const currency = normalizeCurrency(form.text('currency', 8));
    if (!isSupportedCurrency(currency)) {
      return redirectWithFlash(c, '/settings', 'error', 'Pick one of the listed currencies.');
    }
    await updateUserCurrency(c.env.DB, user.id, currency);
    return redirectWithFlash(c, '/settings', 'success', `Saved. Amounts now show in ${currency}.`);
  });

  app.post('/settings/password', requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const current = form.secret('current_password', PASSWORD_INPUT_MAX);
    const next = form.secret('new_password', PASSWORD_INPUT_MAX);

    const result = await changePassword(c, current, next);
    if (!result.ok) {
      return renderPage(c, 'settings', {
          chrome: chrome(c),
          currency: user.baseCurrency,
          timeZone: user.timeZone,
          timeZones: timeZoneOptions(),
          password: { error: result.error, fieldErrors: { [result.field]: result.error } },
        }, 422);
    }
    return redirectWithFlash(c, '/settings', 'success', 'Password changed. Your other devices were logged out.');
  });

  app.post('/settings/delete', requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const password = form.secret('password', PASSWORD_INPUT_MAX);
    const confirmed = form.text('confirm', 8) === 'yes';

    const fieldErrors: { password?: string; confirm?: string } = {};
    if (!confirmed) fieldErrors.confirm = 'Tick the box to confirm.';
    if (!password) fieldErrors.password = 'Enter your password.';
    else {
      const check = await confirmPassword(c.env, user.id, password);
      if (!check.ok) fieldErrors.password = check.error;
    }

    if (fieldErrors.password || fieldErrors.confirm) {
      return renderPage(c, 'settings', {
          chrome: chrome(c),
          currency: user.baseCurrency,
          timeZone: user.timeZone,
          timeZones: timeZoneOptions(),
          deleteAccount: { error: 'Your account was not deleted.', fieldErrors },
        }, 422);
    }

    // Their photo and logos go with the account: read the keys before the rows are gone.
    const images = await mediaKeysOfUser(c.env.DB, user.id);
    await deleteUser(c.env.DB, user.id);
    await deleteImages(c.env, images);
    await endSession(c);
    return redirectWithFlash(c, '/', 'info', 'Your account and all of its data were deleted.');
  });
}
