/**
 * The email digest's stop link (SPEC F-25). Owner: Experience (routes).
 *
 * The mailed link (GET) only shows a button; the POST behind it turns the digest off. Mail scanners
 * that fetch every link in a message therefore can't unsubscribe anyone. It works signed out: the
 * link carries a MAC of the account's id (services/digest.ts).
 */

import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { DIGEST_STOP_PATH, stopDigest, stopLinkValid } from '../services/digest';
import { renderPage } from '../views/render';
import { chrome, formLimit, readForm, type AppContext } from './util';

/** A user id and a 43-character MAC; anything longer is never looked at. */
const ID_MAX = 64;
const TOKEN_MAX = 43;

/** Without the app's nav: the page is the same for whoever opens the link. */
function bareChrome(c: AppContext) {
  return { ...chrome(c), user: null };
}

export function registerDigestRoutes(app: Hono<AppEnv>): void {
  app.get(DIGEST_STOP_PATH, async (c) => {
    const userId = (c.req.query('u') ?? '').slice(0, ID_MAX + 1);
    const token = (c.req.query('t') ?? '').slice(0, TOKEN_MAX + 1);
    if (!(await stopLinkValid(c.env, userId, token))) return renderPage(c, 'digestStop', { chrome: bareChrome(c), state: 'invalid' }, 400);
    return renderPage(c, 'digestStop', { chrome: bareChrome(c), state: 'confirm', userId, token });
  });

  app.post(DIGEST_STOP_PATH, formLimit, async (c) => {
    const form = await readForm(c);
    const ok = await stopDigest(c.env, form.text('u', ID_MAX + 1), form.text('t', TOKEN_MAX + 1));
    return renderPage(c, 'digestStop', { chrome: bareChrome(c), state: ok ? 'done' : 'invalid' }, ok ? 200 : 400);
  });
}
