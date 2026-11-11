/** Landing, sign-up, log-in, log-out. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { getLandingGallery } from '../data/explore';
import { publicPagesEnabled } from '../lib/public-pages';
import type { AppEnv } from '../env';
import {
  authenticate,
  clientIp,
  endSession,
  normalizeEmail,
  registerUser,
  safeNext,
  signupAllowed,
  startSession,
} from '../lib/auth';
import { parseRange } from '../data/types';
import {
  HONEYPOT_FIELD,
  TURNSTILE_FIELD,
  TURNSTILE_MESSAGES,
  TURNSTILE_TOKEN_MAX,
  turnstileSiteKey,
  verifyTurnstile,
  type BotAction,
} from '../lib/bot-defense';
import { sendVerificationLink, VERIFY_LINK_TTL_MS, VERIFY_PATH, verificationRequired } from '../lib/email-verification';
import { redirectWithFlash, rememberNext, setCelebrate } from '../lib/flash';
import { mediaEnabled } from '../services/media';
import { RATE_LIMIT_PERIOD_SECONDS, withinAuthLimit } from '../lib/rate-limit';
import { parseRevenueVariant } from '../views/charts/revenue-chart';
import { fixtureDashboard } from '../views/fixtures';
import { syncCadence } from '../views/pages/shared';
import { chrome, formLimit, readForm, type AppContext, type FormFields } from './util';
import { MAIL_FAILED_MESSAGE } from './verify-email';
import { renderPage } from '../views/render';

const EMAIL_MAX = 254;
/** lib/auth rejects > 256 with a clear message; this only bounds the work. */
const PASSWORD_INPUT_MAX = 1024;
const NEXT_MAX = 512;

/**
 * Runs before any account logic, cheapest first: the network's submission rate (no D1), the
 * honeypot, then Turnstile when it's configured. Null means carry on.
 */
async function botCheck(
  c: AppContext,
  form: FormFields,
  action: BotAction,
): Promise<{ error: string; status: 400 | 429 | 503 } | null> {
  if (!(await withinAuthLimit(c))) {
    c.header('Retry-After', String(RATE_LIMIT_PERIOD_SECONDS));
    return { error: 'Too many attempts. Wait a minute, then try again.', status: 429 };
  }
  if (form.text(HONEYPOT_FIELD)) {
    // A field people never see was filled in. No email or IP in the log: the event is enough.
    console.log(JSON.stringify({ event: 'bot_honeypot', form: action }));
    return { error: 'Something went wrong. Try again.', status: 400 };
  }
  if (turnstileSiteKey(c.env)) {
    const result = await verifyTurnstile(c.env, form.text(TURNSTILE_FIELD, TURNSTILE_TOKEN_MAX), {
      ip: clientIp(c),
      action,
      hostname: new URL(c.req.url).hostname,
    });
    if (result !== 'ok') return { error: TURNSTILE_MESSAGES[result], status: result === 'unavailable' ? 503 : 400 };
  }
  return null;
}

/** Keeps `next` only if it is a safe same-site path, so we never carry junk around. */
function carryNext(v: string | undefined | null): string | null {
  if (!v || v.length > NEXT_MAX) return null;
  return safeNext(v) === v ? v : null;
}

/**
 * How long the edge keeps the signed-out landing page. It's the same for every visitor without a
 * cookie (demo numbers, the Explore gallery), the heaviest page to render, and the one search
 * engines and new visitors open first.
 */
const LANDING_EDGE_SECONDS = 300;

/** Cloudflare's cache for this zone; none in tests or `wrangler dev` without one. */
function edgeCache(): Cache | null {
  return typeof caches === 'undefined' ? null : ((caches as unknown as { default?: Cache }).default ?? null);
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.get('/', async (c) => {
    if (c.get('user')) return c.redirect('/dashboard', 303);
    // Any cookie (a session, a flash, a choice) skips the edge cache, so a signed-in browser still
    // goes to its dashboard and a flash still shows. Browsers revalidate (max-age=0).
    const cache = c.req.header('Cookie') ? null : edgeCache();
    const hit = cache ? await cache.match(c.req.url) : undefined;
    // A copy: middleware still sets its headers on the way out.
    if (hit) return new Response(hit.body, hit);
    const origin = new URL(c.req.url).origin;
    // The live preview: deterministic demo numbers dated to today, rendered by the real components.
    const demo = fixtureDashboard(parseRange(c.req.query('range')), 'full', Date.now());
    // Real products from Explore (SPEC F-23), where public pages are on: one indexed read.
    const gallery = publicPagesEnabled(c.env) ? await getLandingGallery(c.env.DB, Date.now(), mediaEnabled(c.env)) : null;
    const res = renderPage(c, 'landing', {
        chrome: chrome(c),
        url: `${origin}/`,
        image: `${origin}/og/home.png`,
        signupOpen: signupAllowed(c.env),
        demo,
        revenueVariant: parseRevenueVariant(c.req.query('revenue')),
        cadence: syncCadence(c.env.SYNC_INTERVAL_MINUTES),
        gallery,
      });
    if (cache && !res.headers.has('Set-Cookie')) {
      res.headers.set('Cache-Control', `public, max-age=0, s-maxage=${LANDING_EDGE_SECONDS}`);
      c.executionCtx.waitUntil(cache.put(c.req.url, res.clone()));
    }
    return res;
  });

  // ----- sign up -----

  app.get('/signup', (c) => {
    const next = carryNext(c.req.query('next'));
    if (c.get('user')) return c.redirect(safeNext(next), 303);
    return renderPage(c, 'auth', {
        chrome: chrome(c),
        mode: 'signup',
        canonical: `${new URL(c.req.url).origin}/signup`,
        next,
        signupOpen: signupAllowed(c.env),
        turnstileSiteKey: turnstileSiteKey(c.env),
      });
  });

  app.post('/signup', formLimit, async (c) => {
    if (!signupAllowed(c.env)) {
      return renderPage(c, 'auth', {
          chrome: chrome(c),
          mode: 'signup',
          signupOpen: false,
        }, 403);
    }
    const form = await readForm(c);
    const email = form.text('email', EMAIL_MAX);
    const password = form.secret('password', PASSWORD_INPUT_MAX);
    const next = carryNext(form.text('next', NEXT_MAX + 1));
    const again = { chrome: chrome(c), mode: 'signup', signupOpen: true, next, email, turnstileSiteKey: turnstileSiteKey(c.env) } as const;

    const blocked = await botCheck(c, form, 'signup');
    if (blocked) return renderPage(c, 'auth', { ...again, error: blocked.error }, blocked.status);

    const result = await registerUser(c.env, email, password, clientIp(c));
    if (!result.ok) {
      return renderPage(c, 'auth', { ...again, error: result.error, field: result.field }, result.throttled ? 429 : 400);
    }
    await startSession(c, result.userId);
    if (verificationRequired(c.env)) {
      // Held at check-your-inbox until the mailed link is used; the welcome waits for that, and so
      // does the page they signed up from (a public page's lock), kept for when they confirm.
      if (next) rememberNext(c, next, Math.floor(VERIFY_LINK_TTL_MS / 1000));
      const user = { id: result.userId, email: normalizeEmail(email) };
      if (await sendVerificationLink(c.env, user, new URL(c.req.url).origin)) return c.redirect(VERIFY_PATH, 303);
      return redirectWithFlash(c, VERIFY_PATH, 'error', MAIL_FAILED_MESSAGE);
    }
    // No flash: the empty dashboard is the welcome (design/system.md §6). Just one confetti burst.
    setCelebrate(c);
    return c.redirect(safeNext(next), 303);
  });

  // ----- log in -----

  app.get('/login', (c) => {
    const next = carryNext(c.req.query('next'));
    if (c.get('user')) return c.redirect(safeNext(next), 303);
    return renderPage(c, 'auth', {
        chrome: chrome(c),
        mode: 'login',
        canonical: `${new URL(c.req.url).origin}/login`,
        next,
        signupOpen: signupAllowed(c.env),
        turnstileSiteKey: turnstileSiteKey(c.env),
      });
  });

  app.post('/login', formLimit, async (c) => {
    const form = await readForm(c);
    const email = form.text('email', EMAIL_MAX);
    const password = form.secret('password', PASSWORD_INPUT_MAX);
    const next = carryNext(form.text('next', NEXT_MAX + 1));
    const again = {
      chrome: chrome(c),
      mode: 'login',
      signupOpen: signupAllowed(c.env),
      next,
      email,
      turnstileSiteKey: turnstileSiteKey(c.env),
    } as const;

    const blocked = await botCheck(c, form, 'login');
    if (blocked) return renderPage(c, 'auth', { ...again, error: blocked.error }, blocked.status);

    const result = await authenticate(c.env, email, password, clientIp(c));
    if (!result.ok) {
      return renderPage(c, 'auth', { ...again, error: result.error, field: result.field }, result.throttled ? 429 : 401);
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
