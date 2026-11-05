/** GET /dashboard?range=7|30|90&month=YYYY-MM&day=YYYY-MM-DD. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { getCalendarMonth, parseCalendarQuery } from '../data/calendar';
import { listConnectionSummaries } from '../data/connections';
import { dominantMrrCurrency } from '../data/currency';
import { getDashboardData } from '../data/dashboard';
import { parseRange } from '../data/types';
import { getCurrencySource, setInferredCurrency } from '../db/queries';
import type { AppEnv } from '../env';
import { currentUser, requireUser } from '../lib/auth';
import { syncCadence, syncIntervalMinutes } from '../views/pages/shared';
import { rememberedQuery } from './prefs';
import { awaitingFirstSync, chrome, parsePoll, syncState } from './util';
import { renderPage } from '../views/render';

export function registerDashboardRoutes(app: Hono<AppEnv>): void {
  app.get('/dashboard', requireUser, async (c) => {
    let user = currentUser(c);
    // Until the user picks a display currency, start with the one most of their real MRR is in
    // (once, at the first dashboard load with numbers). Settings can change it any time.
    let currencyInferred: string | null = null;
    if ((await getCurrencySource(c.env.DB, user.id)) === 'default') {
      const dominant = await dominantMrrCurrency(c.env, user.id);
      if (dominant && (await setInferredCurrency(c.env.DB, user.id, dominant)) && dominant !== user.baseCurrency) {
        user = { ...user, baseCurrency: dominant };
        currencyInferred = dominant;
      }
    }
    // ?range= wins and is remembered; the bare nav link brings back the last range.
    const range = parseRange(rememberedQuery(c, 'range', 'hm_range', (v) => v === '7' || v === '30' || v === '90'));
    const poll = parsePoll(c.req.query('poll'));
    // The calendar's month and picked day (?month=, ?day=). Not remembered: a bare link is this month.
    const cal = parseCalendarQuery(c.req.query('month'), c.req.query('day'));

    const [data, connections, calendar] = await Promise.all([
      getDashboardData(c.env, user, range),
      listConnectionSummaries(c.env, user.id),
      getCalendarMonth(c.env, user, cal.month),
    ]);

    // The first real connection just replaced demo data: say so in the notice or the strip, and
    // keep saying it across the auto-refreshes until one of them shows.
    const demoRemoved = c.req.query('demo') === 'removed';
    const keep = demoRemoved ? '&demo=removed' : '';
    const sync = syncState(connections.some(awaitingFirstSync), poll, (n) => `/dashboard?range=${range}&poll=${n}${keep}`);
    // "There it is": the page was polling for a first sync (poll ≥ 1) and nothing is waiting any
    // more, or a first connection was just added and synced before this page loaded (?first=1).
    // Real numbers only: demo data never earns the moment. No stored state: dismissing is a link
    // to the same range without the trigger.
    const justSynced =
      !sync &&
      (poll > 0 || c.req.query('first') === '1') &&
      connections.some((x) => x.provider !== 'demo' && x.lastSyncedAt !== null);
    return renderPage(c, 'dashboard', {
        chrome: chrome(c),
        data,
        connections,
        sync,
        cadence: syncCadence(c.env.SYNC_INTERVAL_MINUTES),
        // Stale once a connection has missed two syncs in a row.
        staleAfterMinutes: 2 * syncIntervalMinutes(c.env.SYNC_INTERVAL_MINUTES),
        celebrate: justSynced ? { dismissHref: `/dashboard?range=${range}` } : null,
        demoRemoved,
        currencyInferred,
        calendar,
        calendarDay: cal.day,
      });
  });
}
