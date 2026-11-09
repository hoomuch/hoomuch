/** GET /dashboard?range=7|30|90|364&revenue=bars|line&month=YYYY-MM&day=YYYY-MM-DD. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { parseCalendarQuery } from '../data/calendar';
import { dominantMrrCurrency } from '../data/currency';
import { getDashboardPage } from '../data/dashboard';
import { parseRange, RANGE_OPTIONS } from '../data/types';
import { setInferredCurrency } from '../db/queries';
import type { AppEnv } from '../env';
import { currentUser, requireUser } from '../lib/auth';
import { syncCadence, syncIntervalMinutes } from '../views/pages/shared';
import { rememberedQuery } from './prefs';
import { awaitingFirstSync, chrome, parsePoll, syncState } from './util';
import { parseRevenueVariant } from '../views/charts/revenue-chart';
import { renderPage } from '../views/render';

export function registerDashboardRoutes(app: Hono<AppEnv>): void {
  app.get('/dashboard', requireUser, async (c) => {
    let user = currentUser(c);
    // Until the user picks a display currency, start with the one most of their real MRR is in
    // (once, at the first dashboard load with numbers). Settings can change it any time. The source
    // came with the session (lib/auth.ts); setInferredCurrency re-checks it in its own UPDATE.
    let currencyInferred: string | null = null;
    if (c.get('currencySource') === 'default') {
      const dominant = await dominantMrrCurrency(c.env, user.id);
      if (dominant && (await setInferredCurrency(c.env.DB, user.id, dominant)) && dominant !== user.baseCurrency) {
        user = { ...user, baseCurrency: dominant };
        currencyInferred = dominant;
      }
    }
    // ?range= wins and is remembered; the bare nav link brings back the last range.
    const range = parseRange(rememberedQuery(c, 'range', 'hm_range', (v) => RANGE_OPTIONS.some((r) => String(r) === v)));
    // The revenue card's bars or line, remembered the same way.
    const revenueVariant = parseRevenueVariant(rememberedQuery(c, 'revenue', 'hm_revenue', (v) => parseRevenueVariant(v) === v));
    const poll = parsePoll(c.req.query('poll'));
    // The calendar's month and picked day (?month=, ?day=). Not remembered: a bare link is this month.
    const cal = parseCalendarQuery(c.req.query('month'), c.req.query('day'), Date.now(), user.timeZone);

    // One D1 round trip for the dashboard, the calendar and the connection list.
    const { data, connections, calendar } = await getDashboardPage(c.env, user, range, cal.month);

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
        revenueVariant,
      });
  });
}
