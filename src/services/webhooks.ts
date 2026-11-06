/**
 * Provider webhooks (SPEC F-17). Owner: Data Plane.
 *
 * A webhook is only a nudge: a valid call schedules a sync of that connection through its own
 * read-only key, a minute later, so a burst of events (a checkout sends several) becomes one sync.
 * The request body is never read, parsed, stored or logged: it can hold customer details, and
 * hoomuch doesn't need it. hoomuch never registers anything at the provider; the user pastes the
 * URL into the provider's dashboard.
 *
 * The URL is /webhooks/<connection id>/<token>, where token = HMAC(key derived from ENCRYPTION_KEY,
 * "<id>:<nonce>"). Only the nonce is stored, so the owner can see the URL at any time and a
 * database dump alone can't produce one. "New URL" replaces the nonce; "Turn off" clears it.
 */

import type { Bindings } from '../env';
import { getConnection } from '../db/queries';
import { derivedMac, randomToken, timingSafeEqual } from '../lib/crypto';
import { MINUTE } from '../lib/time';
import { QUEUED_STALE_MS, message } from '../sync/queue';
import { clearQueued } from '../sync/repo';
import { getProviderMeta } from '../providers/registry';
import { isProviderId } from '../providers/types';

const MAC_INFO = 'hoomuch webhook url v1';
/** A burst of events within this long becomes one sync. */
export const WEBHOOK_SYNC_DELAY_SECONDS = 60;
/** Webhook syncs of one connection start at least this far apart (each is a full sync). */
export const WEBHOOK_MIN_GAP_MS = 5 * MINUTE;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const WEBHOOK_PATH_PREFIX = '/webhooks/';

export async function webhookToken(env: Pick<Bindings, 'ENCRYPTION_KEY'>, connectionId: string, nonce: string): Promise<string> {
  return derivedMac(env.ENCRYPTION_KEY, MAC_INFO, `${connectionId}:${nonce}`);
}

/** The path (no origin) of a connection's webhook URL. */
export async function webhookPath(env: Pick<Bindings, 'ENCRYPTION_KEY'>, connectionId: string, nonce: string): Promise<string> {
  return `${WEBHOOK_PATH_PREFIX}${connectionId}/${await webhookToken(env, connectionId, nonce)}`;
}

/** A request path safe to log: a webhook URL's token is a secret, so everything after the id goes. */
export function loggablePath(path: string): string {
  const at = path.indexOf(WEBHOOK_PATH_PREFIX);
  if (at === -1) return path;
  const idEnd = path.indexOf('/', at + WEBHOOK_PATH_PREFIX.length);
  return idEnd === -1 ? path : `${path.slice(0, idEnd)}/…`;
}

export type WebhookAction = 'on' | 'rotate' | 'off';

/**
 * Turns a connection's webhook URL on, replaces it, or turns it off. False when the connection
 * isn't the user's, or its provider has no webhook setup in hoomuch.
 */
export async function setWebhook(env: Bindings, userId: string, id: string, action: WebhookAction): Promise<boolean> {
  const row = await getConnection(env.DB, userId, id);
  if (!row || !getProviderMeta(row.provider).webhook) return false;
  if (action === 'on' && row.webhook_nonce) return true; // already on: keep the URL the user pasted
  const nonce = action === 'off' ? null : randomToken(16);
  const r = await env.DB.prepare(
    'UPDATE connections SET webhook_nonce = ?, webhook_last_at = CASE WHEN ? IS NULL THEN NULL ELSE webhook_last_at END WHERE id = ? AND user_id = ?',
  )
    .bind(nonce, nonce, id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export interface WebhookReceipt {
  /** A sync was queued by this call (false: one was already on its way). */
  scheduled: boolean;
}

/**
 * A provider called a webhook URL. Null when the URL isn't valid (unknown connection, webhooks off,
 * a provider without webhook setup, wrong token): the route answers every such case the same way.
 * Throws when D1, the key or the queue fails, so the route can answer 5xx and the provider retries.
 */
export async function receiveWebhook(env: Bindings, connectionId: string, token: string, now: number): Promise<WebhookReceipt | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = await env.DB.prepare('SELECT provider, webhook_nonce FROM connections WHERE id = ?')
    .bind(connectionId)
    .first<{ provider: string; webhook_nonce: string | null }>();
  if (!row?.webhook_nonce) return null;
  // setWebhook refuses these, but a nonce can outlive a provider's webhook setup.
  if (!isProviderId(row.provider) || !getProviderMeta(row.provider).webhook) return null;
  const nonce = row.webhook_nonce;
  if (!timingSafeEqual(await webhookToken(env, connectionId, nonce), token)) return null;

  // Record the call, then claim the queue slot unless a sync is already on its way. The claim
  // writes queued_at only while it's free or stale, so of two calls in the same millisecond only
  // one wins. Matching the nonce again means a URL turned off or replaced since the read above
  // does neither.
  const [seen, claim] = await env.DB.batch<{ last_sync_started_at: number | null }>([
    env.DB.prepare('UPDATE connections SET webhook_last_at = ?1 WHERE id = ?2 AND webhook_nonce = ?3 RETURNING id')
      .bind(now, connectionId, nonce),
    env.DB.prepare(
      `UPDATE connections SET queued_at = ?1
        WHERE id = ?2 AND webhook_nonce = ?3 AND (queued_at IS NULL OR queued_at <= ?4)
        RETURNING last_sync_started_at`,
    )
      .bind(now, connectionId, nonce, now - QUEUED_STALE_MS),
  ]);
  if (!seen?.results?.length) return null;
  const claimed = claim?.results?.[0];
  if (!claimed) return { scheduled: false };

  const sinceLast = claimed.last_sync_started_at === null ? Number.POSITIVE_INFINITY : now - claimed.last_sync_started_at;
  const gapSeconds = Math.ceil(Math.max(0, WEBHOOK_MIN_GAP_MS - sinceLast) / 1000);
  try {
    await env.SYNC_QUEUE.send(message(connectionId, 'webhook', now), {
      delaySeconds: Math.max(WEBHOOK_SYNC_DELAY_SECONDS, gapSeconds),
    });
  } catch (err) {
    await clearQueued(env.DB, [connectionId], now)
      .run()
      .catch(() => {});
    throw err;
  }
  return { scheduled: true };
}
