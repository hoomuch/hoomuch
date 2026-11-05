/** Settings: display currency, password change, account deletion. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { deleteUser, getCurrencySource, updateUserCurrency } from '../db/queries';
import type { AppEnv } from '../env';
import { changePassword, confirmPassword, currentUser, endSession, requireUser } from '../lib/auth';
import { redirectWithFlash } from '../lib/flash';
import { isSupportedCurrency, normalizeCurrency } from '../lib/money';
import { SettingsPage } from '../views/pages/settings';
import { chrome, formLimit, readForm } from './util';

const PASSWORD_INPUT_MAX = 1024;

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  app.get('/settings', requireUser, async (c) => {
    const user = currentUser(c);
    const source = await getCurrencySource(c.env.DB, user.id);
    return c.html(<SettingsPage chrome={chrome(c)} currency={user.baseCurrency} currencySource={source} />);
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
      return c.html(
        <SettingsPage
          chrome={chrome(c)}
          currency={user.baseCurrency}
          password={{ error: result.error, fieldErrors: { [result.field]: result.error } }}
        />,
        422,
      );
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
      return c.html(
        <SettingsPage
          chrome={chrome(c)}
          currency={user.baseCurrency}
          deleteAccount={{ error: 'Your account was not deleted.', fieldErrors }}
        />,
        422,
      );
    }

    await deleteUser(c.env.DB, user.id);
    await endSession(c);
    return redirectWithFlash(c, '/', 'info', 'Your account and all of its data were deleted.');
  });
}
