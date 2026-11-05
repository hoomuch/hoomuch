/** GET /dashboard?range=7|30|90. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { listConnectionSummaries } from '../data/connections';
import { getDashboardData } from '../data/dashboard';
import { parseRange } from '../data/types';
import type { AppEnv } from '../env';
import { currentUser, requireUser } from '../lib/auth';
import { DashboardPage } from '../views/pages/dashboard';
import { syncCadence } from '../views/pages/shared';
import { awaitingFirstSync, chrome, parsePoll, syncState } from './util';

export function registerDashboardRoutes(app: Hono<AppEnv>): void {
  app.get('/dashboard', requireUser, async (c) => {
    const user = currentUser(c);
    const range = parseRange(c.req.query('range'));
    const poll = parsePoll(c.req.query('poll'));

    const [data, connections] = await Promise.all([
      getDashboardData(c.env, user, range),
      listConnectionSummaries(c.env, user.id),
    ]);

    const sync = syncState(connections.some(awaitingFirstSync), poll, (n) => `/dashboard?range=${range}&poll=${n}`);
    // "There it is": the page was polling for a first sync (poll ≥ 1) and nothing is waiting any
    // more, or a first connection was just added and synced before this page loaded (?first=1).
    // No stored state: dismissing is a link to the same range without the trigger.
    const justSynced =
      !sync && (poll > 0 || c.req.query('first') === '1') && connections.some((x) => x.lastSyncedAt !== null);
    return c.html(
      <DashboardPage
        chrome={chrome(c)}
        data={data}
        connections={connections}
        sync={sync}
        cadence={syncCadence(c.env.SYNC_INTERVAL_MINUTES)}
        celebrate={justSynced ? { dismissHref: `/dashboard?range=${range}` } : null}
      />,
    );
  });
}
