/**
 * Keeps public products' stored figures current (SPEC F-21). Owner: Lead.
 *
 * A public page reads one precomputed row, so the figures are worked out here: when one of the
 * product's connections finishes a sync, when the owner saves or publishes the product, and when a
 * connection's data is deleted or replaced. Nothing here throws: a failure leaves the last figures
 * in place and logs the product id, never anything else.
 */

import type { Bindings } from '../env';
import { getProductStats } from '../data/dashboard';
import { productForStats, productOfConnection, saveProductStats } from '../db/public';
import { publicPagesEnabled } from '../lib/public-pages';
import { sanitizeErrorText } from '../providers/http';

/**
 * Works out and stores the product's figures; null figures when none of its connections counts or
 * none has a snapshot yet (its page is a 404 until then). `onlyPublished` skips a product that
 * isn't public, which is what the sync wants: an unpublished product's preview is refreshed when
 * its owner saves it.
 */
export async function refreshProductStats(env: Bindings, productId: string, opts: { onlyPublished?: boolean } = {}): Promise<void> {
  try {
    const p = await productForStats(env.DB, productId);
    if (!p || (opts.onlyPublished && !p.published)) return;
    const now = Date.now();
    const stats = await getProductStats(env.DB, { id: p.userId, timeZone: p.timeZone }, new Set(p.connectionIds), now);
    await saveProductStats(env.DB, productId, stats, now);
  } catch (err) {
    console.error(JSON.stringify({ event: 'public_stats_failed', productId, message: sanitizeErrorText(String(err)) }));
  }
}

/** After a connection's data changed (a sync finished, data was cleared): its published product, if any. */
export async function refreshStatsForConnection(env: Bindings, connectionId: string): Promise<void> {
  if (!publicPagesEnabled(env)) return;
  let productId: string | null;
  try {
    productId = await productOfConnection(env.DB, connectionId);
  } catch (err) {
    console.error(JSON.stringify({ event: 'public_stats_failed', connectionId, message: sanitizeErrorText(String(err)) }));
    return;
  }
  if (productId) await refreshProductStats(env, productId, { onlyPublished: true });
}

/**
 * Before a connection is deleted: the product it's in, so its figures can be worked out again once
 * the connection is gone (the link row goes with it). Null when public pages are off.
 */
export async function productBeforeDelete(env: Bindings, connectionId: string): Promise<string | null> {
  if (!publicPagesEnabled(env)) return null;
  try {
    return await productOfConnection(env.DB, connectionId);
  } catch {
    return null;
  }
}
