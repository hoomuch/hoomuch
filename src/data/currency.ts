/**
 * The display currency to start with, picked from the user's own numbers. Owner: Data Plane.
 * design/system.md §7: "the currency that carries most of the MRR at the first real sync".
 */

import type { Bindings } from '../env';
import { convertMinor, isSupportedCurrency, normalizeCurrency, parseMoneyMap } from '../lib/money';
import { LATEST_FX_SQL, latestFx } from '../sync/fx';

/**
 * The supported display currency with the largest share of current MRR across real (non-demo)
 * connections, compared in USD at the newest rates. Null when there's nothing to go on yet, or
 * when currencies can't be compared because a rate is missing.
 */
export async function dominantMrrCurrency(env: Bindings, userId: string): Promise<string | null> {
  const [snapsR, fxR] = await env.DB.batch([
    env.DB.prepare(
      `SELECT s.mrr FROM snapshots s JOIN connections c ON c.id = s.connection_id
        WHERE c.user_id = ? AND c.provider != 'demo'
          AND s.day = (SELECT MAX(day) FROM snapshots WHERE connection_id = s.connection_id)`,
    ).bind(userId),
    env.DB.prepare(LATEST_FX_SQL),
  ]);
  const totals = new Map<string, number>();
  for (const row of (snapsR!.results ?? []) as { mrr: string }[]) {
    for (const [cur, amount] of Object.entries(parseMoneyMap(row.mrr))) {
      const c = normalizeCurrency(cur);
      if (amount > 0) totals.set(c, (totals.get(c) ?? 0) + amount);
    }
  }
  if (totals.size === 0) return null;
  if (totals.size === 1) {
    const only = [...totals.keys()][0]!;
    return isSupportedCurrency(only) ? only : null;
  }
  const fx = latestFx(fxR!.results as { day: string; base: string; rates: string }[] | undefined);
  if (!fx) return null;
  let best: { currency: string; usd: number } | null = null;
  for (const [currency, amount] of totals) {
    const usd = convertMinor(amount, currency, 'USD', fx);
    if (usd === null) return null; // can't compare honestly; keep the default
    if (isSupportedCurrency(currency) && (best === null || usd > best.usd)) best = { currency, usd };
  }
  return best?.currency ?? null;
}
