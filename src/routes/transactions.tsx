/** GET /transactions?provider=&page=&day=, and its CSV export at /transactions.csv. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { parseDayParam } from '../data/calendar';
import { listConnectionSummaries } from '../data/connections';
import { exportTransactions, listTransactions, parseCursor } from '../data/transactions';
import { EXPORT_MAX_ROWS, type ConnectionSummary, type TransactionRow } from '../data/types';
import type { AppEnv } from '../env';
import { currentUser, requireUser } from '../lib/auth';
import { csvNumber, csvRaw, toCsv, type CsvCell } from '../lib/csv';
import { redirectWithFlash } from '../lib/flash';
import { formatNumber } from '../lib/money';
import { addDays, zonedDayKey } from '../lib/time';
import { getProviderMeta } from '../providers/registry';
import { isProviderId, PROVIDER_IDS, type ProviderId } from '../providers/types';
import { rememberedQuery } from './prefs';
import { chrome, parsePage } from './util';
import { renderPage } from '../views/render';

/** Filters for the providers the user actually has (plus the active one), in registry order. */
function filterProviders(connections: ConnectionSummary[], active: ProviderId | null): ProviderId[] {
  const present = new Set<ProviderId>(connections.map((c) => c.provider));
  if (active) present.add(active);
  return PROVIDER_IDS.filter((id) => present.has(id));
}

/** Days the export form starts with, ending today. */
const EXPORT_DEFAULT_DAYS = 30;

/**
 * The export's columns. Amounts are plain decimals: as charged, in `currency`, and converted to the
 * display currency at that day's rate (empty when there's no rate). `net` is the amount less the
 * provider's fee where it reports one.
 */
function transactionsCsv(items: readonly TransactionRow[], currency: string, tz: string): string {
  const cur = currency.toLowerCase();
  const header = ['date_utc', 'day', 'connection', 'provider', 'type', 'description', 'amount', 'currency', 'fee', 'net', `amount_${cur}`, `fee_${cur}`, 'id'];
  const rows = items.map((t): CsvCell[] => [
    csvRaw(new Date(t.occurredAt).toISOString()),
    csvRaw(zonedDayKey(t.occurredAt, tz)),
    t.connectionName,
    getProviderMeta(t.provider).name,
    csvRaw(t.type),
    t.description,
    csvNumber(t.amount, t.originalCurrency),
    csvRaw(t.originalCurrency),
    t.fee === null ? null : csvNumber(t.fee, t.originalCurrency),
    t.fee === null ? null : csvNumber(t.amount - t.fee, t.originalCurrency),
    t.displayAmount === null ? null : csvNumber(t.displayAmount, currency),
    t.displayFee === null ? null : csvNumber(t.displayFee, currency),
    t.externalId,
  ]);
  return toCsv(header, rows);
}

export function registerTransactionRoutes(app: Hono<AppEnv>): void {
  app.get('/transactions', requireUser, async (c) => {
    const user = currentUser(c);
    // ?provider= (an id, or "all") wins and is remembered; junk is ignored, not an error.
    const p = rememberedQuery(c, 'provider', 'hm_provider', (v) => v === 'all' || isProviderId(v));
    const provider = p !== undefined && isProviderId(p) ? p : null;
    const page = parsePage(c.req.query('page'));
    // ?day= narrows the list to one of the user's local days (the dashboard calendar links here).
    // Not remembered.
    const day = parseDayParam(c.req.query('day'), Date.now(), user.timeZone);
    // Where the Next / Previous link said the page starts (data/transactions.ts); junk is ignored.
    const before = parseCursor(c.req.query('before'));
    const after = parseCursor(c.req.query('after'));

    const [txns, connections] = await Promise.all([
      listTransactions(c.env, user, { provider, page, day, before, after }),
      listConnectionSummaries(c.env, user.id),
    ]);

    // The export form starts on the day shown, or on the last 30 days.
    const today = zonedDayKey(Date.now(), user.timeZone);
    return renderPage(c, 'transactions', {
        chrome: chrome(c),
        page: txns,
        hasConnections: connections.length > 0,
        filterProviders: filterProviders(connections, provider),
        exportRange: day ? { from: day, to: day, max: today } : { from: addDays(today, -(EXPORT_DEFAULT_DAYS - 1)), to: today, max: today },
      });
  });

  // The list as a file, for a spreadsheet or an accountant: ?from=&to= (the user's local days) and
  // ?provider=. A plain GET form posts here, so it works before hydration.
  app.get('/transactions.csv', requireUser, async (c) => {
    const user = currentUser(c);
    const now = Date.now();
    const today = zonedDayKey(now, user.timeZone);
    const p = c.req.query('provider');
    const provider = p !== undefined && isProviderId(p) ? p : null;
    const to = parseDayParam(c.req.query('to'), now, user.timeZone) ?? today;
    const from = parseDayParam(c.req.query('from'), now, user.timeZone) ?? addDays(to, -(EXPORT_DEFAULT_DAYS - 1));
    if (from > to) return redirectWithFlash(c, '/transactions', 'error', 'The export’s first day is after its last. Pick the days again.');

    const out = await exportTransactions(c.env, user, { provider, from, to });
    if (out.tooMany) {
      return redirectWithFlash(
        c,
        '/transactions',
        'error',
        `That period has more than ${formatNumber(EXPORT_MAX_ROWS)} transactions. Export it in shorter parts.`,
      );
    }
    return c.body(transactionsCsv(out.items, out.currency, user.timeZone), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="hoomuch-transactions-${from}-to-${to}.csv"`,
    });
  });
}
