/**
 * Request rate limits on Cloudflare's Rate Limiting binding. Owner: Lead. See SPEC.md §8.
 *
 * These run before anything touches D1, so a flood is turned away at the cost of an in-memory
 * counter, not a database read or write. Counts are per Cloudflare location and approximate; the
 * exact, durable limits (per email, per account, per day) stay in D1 (lib/auth.ts).
 * The bindings are optional: without them (tests, an older wrangler.jsonc) only the D1 limits apply.
 */

import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { clientIp, ipBucket } from './auth';

/** Seconds until a client may retry; every binding uses a 60-second period (wrangler.jsonc). */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * True while `key` is within its limit. Fails open: if the binding is missing or errors, the
 * request goes on to the D1 limits rather than locking everyone out.
 */
export async function withinLimit(binding: RateLimit | undefined, key: string): Promise<boolean> {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

/**
 * Every request the Worker serves (static assets never reach it), per network. Provider webhooks
 * are exempt: one provider sends every tenant's calls from the same few addresses, so a per-network
 * limit would turn away one tenant's webhooks because of another's. They have their own limit, per
 * connection (`RL_WEBHOOKS`, routes/webhooks.ts).
 */
export const limitRequests = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.path.startsWith('/webhooks/')) return next();
  if (!(await withinLimit(c.env.RL_REQUESTS, `req|${ipBucket(clientIp(c))}`))) {
    return c.text('Too many requests. Wait a minute, then try again.', 429, {
      'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS),
    });
  }
  await next();
});

/** Log-in and sign-up submissions, per network: these cost a password hash each. */
export function withinAuthLimit(c: Context<AppEnv>): Promise<boolean> {
  return withinLimit(c.env.RL_AUTH, `auth|${ipBucket(clientIp(c))}`);
}
