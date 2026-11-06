/**
 * Provider webhook endpoint (SPEC F-17). Owner: Experience (handler), Data Plane (services/webhooks.ts).
 *
 * Called by providers, not browsers: no session, no CSRF (index.tsx skips it for this path) and the
 * per-network request limit doesn't apply (providers send from shared addresses). A per-connection
 * limit (`RL_WEBHOOKS`) applies instead. The body is never read. Every invalid URL gets the same
 * answer, so the endpoint doesn't say which connections exist.
 */

import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { RATE_LIMIT_PERIOD_SECONDS, withinLimit } from '../lib/rate-limit';
import { receiveWebhook, WEBHOOK_PATH_PREFIX } from '../services/webhooks';
import { isUuid } from './util';

function log(event: string, data: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ event, ...data }));
  } catch {
    // never let logging fail a webhook
  }
}

export function registerWebhookRoutes(app: Hono<AppEnv>): void {
  app.post(`${WEBHOOK_PATH_PREFIX}:id/:token`, async (c) => {
    const id = c.req.param('id');
    const notFound = () => c.json({ ok: false }, 404);
    if (!isUuid(id)) return notFound();
    if (!(await withinLimit(c.env.RL_WEBHOOKS, `hook|${id}`))) {
      return c.json({ ok: false }, 429, { 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) });
    }
    let receipt;
    try {
      receipt = await receiveWebhook(c.env, id, c.req.param('token'), Date.now());
    } catch {
      // The queue refused the sync: a 5xx makes the provider try again later.
      log('webhook_failed', { connectionId: id });
      return c.json({ ok: false }, 503);
    }
    if (!receipt) return notFound();
    log('webhook_received', { connectionId: id, scheduled: receipt.scheduled });
    return c.json({ ok: true });
  });

  // Anything else under the prefix: the same answer as a wrong URL, as JSON rather than a page.
  app.all(`${WEBHOOK_PATH_PREFIX}*`, (c) => c.json({ ok: false }, 404));
}
