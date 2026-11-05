/** Landing, sign-up, log-in, log-out. Owner: Experience (routes). */

import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import {
  authenticate,
  clientIp,
  endSession,
  registerUser,
  safeNext,
  signupAllowed,
  startSession,
} from '../lib/auth';
import { parseRange } from '../data/types';
import { redirectWithFlash } from '../lib/flash';
import { fixtureDashboard } from '../views/fixtures';
import { AuthPage } from '../views/pages/auth';
import { LandingPage } from '../views/pages/landing';
import { syncCadence } from '../views/pages/shared';
import { chrome, formLimit, readForm } from './util';

const EMAIL_MAX = 254;
/** lib/auth rejects > 256 with a clear message; this only bounds the work. */
const PASSWORD_INPUT_MAX = 1024;
const NEXT_MAX = 512;

/** Keeps `next` only if it is a safe same-site path, so we never carry junk around. */
function carryNext(v: string | undefined | null): string | null {
  if (!v || v.length > NEXT_MAX) return null;
  return safeNext(v) === v ? v : null;
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.get('/', (c) => {
    if (c.get('user')) return c.redirect('/dashboard', 303);
    // The live preview: deterministic demo numbers dated to today, rendered by the real components.
    const demo = fixtureDashboard(parseRange(c.req.query('range')), 'full', Date.now());
    return c.html(
      <LandingPage
        chrome={chrome(c)}
        signupOpen={signupAllowed(c.env)}
        demo={demo}
        cadence={syncCadence(c.env.SYNC_INTERVAL_MINUTES)}
      />,
    );
  });

  // ----- sign up -----

  app.get('/signup', (c) => {
    const next = carryNext(c.req.query('next'));
    if (c.get('user')) return c.redirect(safeNext(next), 303);
    return c.html(<AuthPage chrome={chrome(c)} mode="signup" next={next} signupOpen={signupAllowed(c.env)} />);
  });

  app.post('/signup', formLimit, async (c) => {
    if (!signupAllowed(c.env)) {
      return c.html(<AuthPage chrome={chrome(c)} mode="signup" signupOpen={false} />, 403);
    }
    const form = await readForm(c);
    const email = form.text('email', EMAIL_MAX);
    const password = form.secret('password', PASSWORD_INPUT_MAX);
    const next = carryNext(form.text('next', NEXT_MAX + 1));

    const result = await registerUser(c.env, email, password, clientIp(c));
    if (!result.ok) {
      return c.html(
        <AuthPage
          chrome={chrome(c)}
          mode="signup"
          signupOpen
          next={next}
          email={email}
          error={result.error}
          field={result.field}
        />,
        result.throttled ? 429 : 400,
      );
    }
    await startSession(c, result.userId);
    // No flash: the empty dashboard is the welcome (design/system.md §6).
    return c.redirect(safeNext(next), 303);
  });

  // ----- log in -----

  app.get('/login', (c) => {
    const next = carryNext(c.req.query('next'));
    if (c.get('user')) return c.redirect(safeNext(next), 303);
    return c.html(<AuthPage chrome={chrome(c)} mode="login" next={next} signupOpen={signupAllowed(c.env)} />);
  });

  app.post('/login', formLimit, async (c) => {
    const form = await readForm(c);
    const email = form.text('email', EMAIL_MAX);
    const password = form.secret('password', PASSWORD_INPUT_MAX);
    const next = carryNext(form.text('next', NEXT_MAX + 1));

    const result = await authenticate(c.env, email, password, clientIp(c));
    if (!result.ok) {
      return c.html(
        <AuthPage
          chrome={chrome(c)}
          mode="login"
          signupOpen={signupAllowed(c.env)}
          next={next}
          email={email}
          error={result.error}
          field={result.field}
        />,
        result.throttled ? 429 : 401,
      );
    }
    await startSession(c, result.userId);
    return c.redirect(safeNext(next), 303);
  });

  // ----- log out -----

  app.post('/logout', async (c) => {
    await endSession(c);
    return redirectWithFlash(c, '/', 'info', 'Logged out.');
  });
}
