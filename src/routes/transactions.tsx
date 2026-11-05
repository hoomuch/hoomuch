/** GET /transactions?provider=&page=. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { listConnectionSummaries } from '../data/connections';
import { listTransactions } from '../data/transactions';
import type { ConnectionSummary } from '../data/types';
import type { AppEnv } from '../env';
import { currentUser, requireUser } from '../lib/auth';
import { isProviderId, PROVIDER_IDS, type ProviderId } from '../providers/types';
import { TransactionsPage } from '../views/pages/transactions';
import { chrome, parsePage } from './util';

/** Filters for the providers the user actually has (plus the active one), in registry order. */
export function filterProviders(connections: ConnectionSummary[], active: ProviderId | null): ProviderId[] {
  const present = new Set<ProviderId>(connections.map((c) => c.provider));
  if (active) present.add(active);
  return PROVIDER_IDS.filter((id) => present.has(id));
}

export function registerTransactionRoutes(app: Hono<AppEnv>): void {
  app.get('/transactions', requireUser, async (c) => {
    const user = currentUser(c);
    const p = c.req.query('provider');
    const provider = isProviderId(p) ? p : null; // junk is ignored, not an error
    const page = parsePage(c.req.query('page'));

    const [txns, connections] = await Promise.all([
      listTransactions(c.env, user, { provider, page }),
      listConnectionSummaries(c.env, user.id),
    ]);

    return c.html(
      <TransactionsPage
        chrome={chrome(c)}
        page={txns}
        hasConnections={connections.length > 0}
        filterProviders={filterProviders(connections, provider)}
      />,
    );
  });
}
