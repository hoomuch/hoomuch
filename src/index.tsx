/**
 * Worker entry: middleware, routes, cron. Owner: Lead.
 * Pages and handlers live in ./routes (Experience); sync lives in ./sync (Data Plane).
 */

import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Bindings } from './env';
import { loadUser } from './lib/auth';
import { loadFlash } from './lib/flash';
import { deleteExpiredSessions, deleteStaleLoginAttempts } from './db/queries';
import { MINUTE } from './lib/time';
import { registerRoutes } from './routes';
import { runScheduledSync } from './sync/engine';

const app = new Hono<AppEnv>();

app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
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
    },
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
  }),
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
        deleteStaleLoginAttempts(env.DB, now - 15 * MINUTE),
      ]).then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') console.error(JSON.stringify({ event: 'cron_failed', message: String(r.reason) }));
        }
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
