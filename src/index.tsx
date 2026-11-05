/**
 * Worker entry: middleware, routes, cron. Owner: Lead.
 * Pages and handlers live in ./routes (Experience); sync lives in ./sync (Data Plane).
 */

import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Bindings } from './env';
import { DAILY_KEY_PREFIX, DAILY_WINDOW_MS, loadUser, THROTTLE_WINDOW_MS } from './lib/auth';
import { TURNSTILE_ORIGIN, turnstileSiteKey } from './lib/bot-defense';
import { loadFlash } from './lib/flash';
import { limitRequests } from './lib/rate-limit';
import { deleteExpiredSessions, deleteStaleLoginAttempts } from './db/queries';
import { registerRoutes } from './routes';
import { runScheduledSync } from './sync/engine';

const app = new Hono<AppEnv>();

const CSP = {
  defaultSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  // Recharts, Base UI and Motion set inline styles (positions, sizes, chart colours), and Base
  // UI injects one constant <style> rule (Select's scrollbar). App code writes no <style>.
  // Scripts stay same-origin only: the page payload is a JSON data block, never executed.
  styleSrc: ["'self'", "'unsafe-inline'"],
  scriptSrc: ["'self'"],
  fontSrc: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  objectSrc: ["'none'"],
};

const headerOptions = (contentSecurityPolicy: typeof CSP & { frameSrc?: string[] }) => ({
  contentSecurityPolicy,
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  referrerPolicy: 'strict-origin-when-cross-origin',
  xFrameOptions: 'DENY',
  // The app uses no powerful browser features; switch them off so injected or third-party
  // code couldn't ask for them either.
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    payment: [],
    usb: [],
    serial: [],
    hid: [],
    bluetooth: [],
    displayCapture: [],
    browsingTopics: [],
  },
});

const pageHeaders = secureHeaders(headerOptions(CSP));
/**
 * The log-in and sign-up pages of an instance that turns Turnstile on also load Cloudflare's
 * challenge script and its iframe. Every other page, and every instance without Turnstile, keeps
 * `script-src 'self'`.
 */
const TURNSTILE_PAGES = new Set(['/login', '/signup']);
const turnstilePageHeaders = secureHeaders(
  headerOptions({ ...CSP, scriptSrc: ["'self'", TURNSTILE_ORIGIN], frameSrc: [TURNSTILE_ORIGIN] }),
);

app.use('*', (c, next) =>
  (TURNSTILE_PAGES.has(c.req.path) && turnstileSiteKey(c.env) ? turnstilePageHeaders : pageHeaders)(c, next),
);
app.use('*', csrf());
// Pages carry revenue figures and the user's email: never keep them in browser or shared caches
// (Back after "Log out" on a shared machine). Static assets are served before the Worker runs.
app.use('*', async (c, next) => {
  await next();
  try {
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
  } catch {
    // immutable headers (none expected) — leave as is
  }
});
// Floods stop here, before the session lookup or any other D1 work.
app.use('*', limitRequests);
app.use('*', loadFlash);
app.use('*', loadUser);

app.get('/healthz', (c) => c.json({ ok: true }));

registerRoutes(app);

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    const now = controller.scheduledTime;
    ctx.waitUntil(
      Promise.allSettled([
        runScheduledSync(env, now),
        deleteExpiredSessions(env.DB, now),
        deleteStaleLoginAttempts(env.DB, now, {
          shortMs: THROTTLE_WINDOW_MS,
          dailyMs: DAILY_WINDOW_MS,
          dailyPrefix: DAILY_KEY_PREFIX,
        }),
      ]).then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') console.error(JSON.stringify({ event: 'cron_failed', message: String(r.reason) }));
        }
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
