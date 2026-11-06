/**
 * Calendar read model: one month of the dashboard, day by day. Owner: Data Plane.
 *
 * One D1 round trip (a single `db.batch`), no provider calls (SPEC N-02). Same money rules as the
 * dashboard: amounts in the user's display currency, revenue at the rate of its own day and MRR at
 * the latest; currencies without a rate are left out (the dashboard already says so next to the MRR).
 */

import { connectionsStatement, type ConnectionView } from '../db/queries';
import type { Bindings, SessionUser } from '../env';
import { normalizeCurrency, parseMoneyMap } from '../lib/money';
import { addDays, dayKey, dayNumberToKeySql, dayRange, dayStart, UTC, zonedDayKey } from '../lib/time';
import { getProviderMeta } from '../providers/registry';
import { BACKFILL_DAYS } from '../sync/aggregate';
import { FxConverter, FxHistory, LATEST_FX_SQL, fxHistoryStatement, latestFx, type FxRow } from '../sync/fx';
import { localDays, revenueRowsStatement } from './days';
import { rowsOf, type CalendarDay, type CalendarMonth, type ReadModelQuery } from './types';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Nothing older is worth a URL: hoomuch backfills 90 days. */
const OLDEST_MONTH = '2000-01';

/** 'YYYY-MM' + n months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** First and last day of a 'YYYY-MM' month. */
export function monthBounds(month: string): { first: string; last: string } {
  const first = `${month}-01`;
  return { first, last: addDays(`${addMonths(month, 1)}-01`, -1) };
}

/**
 * A real 'YYYY-MM-DD' day from today (in `tz`) back to OLDEST_MONTH, or null. Shared with
 * /transactions?day=.
 */
export function parseDayParam(v: string | undefined | null, now: number = Date.now(), tz: string = UTC): string | null {
  if (!v || !DAY_RE.test(v)) return null;
  const ms = dayStart(v);
  if (Number.isNaN(ms) || dayKey(ms) !== v) return null;
  return v <= zonedDayKey(now, tz) && v.slice(0, 7) >= OLDEST_MONTH ? v : null;
}

/**
 * Reads `?month=` and `?day=` for the dashboard calendar. A valid day (today or earlier) wins and
 * picks its month; otherwise a valid month (not after the current one); otherwise this month.
 * Junk is ignored, never an error.
 */
export function parseCalendarQuery(
  monthParam: string | undefined,
  dayParam: string | undefined,
  now: number = Date.now(),
  tz: string = UTC,
): { month: string; day: string | null } {
  const current = zonedDayKey(now, tz).slice(0, 7);
  const day = parseDayParam(dayParam, now, tz);
  if (day) return { month: day.slice(0, 7), day };
  if (monthParam && MONTH_RE.test(monthParam) && monthParam <= current && monthParam >= OLDEST_MONTH) {
    return { month: monthParam, day: null };
  }
  return { month: current, day: null };
}

interface SnapRow {
  connection_id: string;
  day: string;
  mrr: string;
  active_subscriptions: number;
  active_trials: number | null;
}

interface RevRow {
  connection_id: string;
  day: string;
  currency: string;
  gross: number;
  refunds: number;
}

interface CountRow {
  day: string;
  type: 'charge' | 'refund';
  n: number;
}

interface Point {
  day: string;
  mrr: number;
  subs: number;
  trials: number | null;
}

export async function getCalendarMonth(env: Bindings, user: SessionUser, month: string): Promise<CalendarMonth> {
  const db = env.DB;
  const q = calendarQuery(db, user, month, Date.now());
  const [connsR, fxR, ...results] = await db.batch([connectionsStatement(db, user.id), db.prepare(LATEST_FX_SQL), ...q.statements]);
  return q.build(results, rowsOf<ConnectionView>(connsR), rowsOf<FxRow>(fxR));
}

/** The calendar month as statements for a page's batch (ReadModelQuery); getCalendarMonth runs it alone. */
export function calendarQuery(db: D1Database, user: SessionUser, month: string, now: number): ReadModelQuery<CalendarMonth> {
  const tz = user.timeZone || UTC;
  const today = zonedDayKey(now, tz);
  const currency = normalizeCurrency(user.baseCurrency || 'USD');
  const { first, last } = monthBounds(month);
  const monthDays = localDays('t.occurred_at', first, last, tz);

  const SNAP_COLS = 's.connection_id, s.day, s.mrr, s.active_subscriptions, s.active_trials';
  return {
    statements: [
      // Each connection's last snapshot before the 1st: carried into the month, and the 1st's change.
      // Correlated on the connection: one primary-key seek each, however long the history.
      db
        .prepare(
          `SELECT ${SNAP_COLS} FROM connections c
             JOIN snapshots s ON s.connection_id = c.id
                             AND s.day = (SELECT MAX(x.day) FROM snapshots x WHERE x.connection_id = c.id AND x.day < ?2)
            WHERE c.user_id = ?1`,
        )
        .bind(user.id, first),
      db
        .prepare(
          `SELECT ${SNAP_COLS} FROM snapshots s JOIN connections c ON c.id = s.connection_id
            WHERE c.user_id = ? AND s.day >= ? AND s.day <= ? ORDER BY s.day ASC`,
        )
        .bind(user.id, first, last),
      revenueRowsStatement(db, user.id, tz, first, last),
      // Charges and refunds per local day, the same days the revenue above is grouped on.
      db
        .prepare(
          `SELECT ${dayNumberToKeySql('dn')} AS day, type, n FROM (
             SELECT ${monthDays.dayNumber.sql} AS dn, t.type, COUNT(*) AS n
               FROM transactions t JOIN connections c ON c.id = t.connection_id
              WHERE c.user_id = ? AND t.occurred_at >= ? AND t.occurred_at < ?
              GROUP BY dn, t.type)`,
        )
        .bind(...monthDays.dayNumber.binds, user.id, monthDays.lo, monthDays.hi),
      // Per connection, so each MIN is one seek in the primary key rather than a scan of the history.
      db
        .prepare(
          `SELECT MIN((SELECT MIN(s.day) FROM snapshots s WHERE s.connection_id = c.id)) AS day FROM connections c WHERE c.user_id = ?`,
        )
        .bind(user.id),
      fxHistoryStatement(db, user.id, currency, first, last),
    ],
    build: ([beforeR, snapsR, revR, countR, oldestR, histR], conns, fxRows) =>
      buildCalendar({
        month,
        currency,
        today,
        tz,
        first,
        last,
        conns,
        before: rowsOf<SnapRow>(beforeR),
        snaps: rowsOf<SnapRow>(snapsR),
        revRows: rowsOf<RevRow>(revR),
        counts: rowsOf<CountRow>(countR),
        oldestSnapshot: rowsOf<{ day: string | null }>(oldestR)[0]?.day ?? null,
        // Revenue at each day's rate, end-of-day MRR at the latest (SPEC §6).
        cv: new FxConverter(currency, latestFx(fxRows), new FxHistory(rowsOf<FxRow>(histR))),
      }),
  };
}

function buildCalendar(p: {
  month: string;
  currency: string;
  today: string;
  tz: string;
  first: string;
  last: string;
  conns: readonly ConnectionView[];
  before: SnapRow[];
  snaps: SnapRow[];
  revRows: RevRow[];
  counts: CountRow[];
  oldestSnapshot: string | null;
  cv: FxConverter;
}): CalendarMonth {
  const { month, currency, today, tz, first, last, conns, before, snaps, revRows, counts, oldestSnapshot, cv } = p;

  // ---- where revenue history starts ----
  // A connection counts once a revenue sync has run (or rows exist), except a daily-totals provider
  // that can't report them (RevenueCat without Charts): the dashboard explains that one.
  const hasRows = new Set(revRows.map((r) => r.connection_id));
  let revenueFrom: string | null = null;
  for (const c of conns) {
    const meta = getProviderMeta(c.provider);
    let dailyOk = true;
    if (meta.revenueHistory === 'daily') {
      try {
        dailyOk = (JSON.parse(c.config || '{}') as Record<string, unknown>)['revenueHistory'] === 'daily';
      } catch {
        dailyOk = false;
      }
    }
    const contributes = hasRows.has(c.id) || (c.revenue_synced_until !== null && dailyOk && meta.revenueHistory !== 'none');
    if (!contributes) continue;
    const from = addDays(zonedDayKey(c.created_at, tz), -(BACKFILL_DAYS - 1));
    if (revenueFrom === null || from < revenueFrom) revenueFrom = from;
  }

  // ---- revenue and counts per day ----
  const days = dayRange(first, last);
  const index = new Map(days.map((d, i) => [d, i]));
  const out: CalendarDay[] = days.map((day) => {
    const past = day <= today;
    return {
      day,
      net: past && revenueFrom !== null && day >= revenueFrom ? 0 : null,
      gross: 0,
      refunds: 0,
      byConnection: {},
      charges: 0,
      refundCount: 0,
      mrr: null,
      activeSubscriptions: null,
      activeTrials: null,
      mrrChange: null,
      subscriptionsChange: null,
      trialsChange: null,
    };
  });

  for (const r of revRows) {
    const i = index.get(r.day);
    if (i === undefined || r.day > today) continue;
    const d = out[i]!;
    // Net converts as one sum, as the dashboard's bar does; refunds are what gross leaves over it,
    // so the cell's gross − refunds is its net.
    const gross = cv.amountOn(r.gross, r.currency, r.day);
    const net = cv.amountOn(r.gross - r.refunds, r.currency, r.day);
    d.gross += gross;
    d.refunds += gross - net;
    d.net = (d.net ?? 0) + net;
    d.byConnection[r.connection_id] = (d.byConnection[r.connection_id] ?? 0) + net;
  }
  for (const d of out) {
    for (const [id, v] of Object.entries(d.byConnection)) if (v === 0) delete d.byConnection[id];
  }
  for (const c of counts) {
    const i = index.get(c.day);
    if (i === undefined || c.day > today) continue;
    if (c.type === 'refund') out[i]!.refundCount += c.n;
    else out[i]!.charges += c.n;
  }

  // ---- end-of-day totals, each connection carried forward from its last snapshot ----
  const timeline = new Map<string, Point[]>();
  const push = (s: SnapRow) => {
    const list = timeline.get(s.connection_id) ?? [];
    list.push({ day: s.day, mrr: cv.map(parseMoneyMap(s.mrr)), subs: s.active_subscriptions, trials: s.active_trials });
    timeline.set(s.connection_id, list);
  };
  for (const s of before) push(s);
  for (const s of snaps) push(s);

  const totalsOn = (day: string) => {
    let any = false;
    let mrr = 0;
    let subs = 0;
    let trials: number | null = null;
    for (const list of timeline.values()) {
      let p: Point | null = null;
      for (const q of list) {
        if (q.day > day) break;
        p = q;
      }
      if (!p) continue;
      any = true;
      mrr += p.mrr;
      subs += p.subs;
      if (p.trials !== null) trials = (trials ?? 0) + p.trials;
    }
    return any ? { mrr, subs, trials } : null;
  };

  let prev = totalsOn(addDays(first, -1));
  for (const d of out) {
    if (d.day > today) break;
    const t = totalsOn(d.day);
    if (t) {
      d.mrr = t.mrr;
      d.activeSubscriptions = t.subs;
      d.activeTrials = t.trials;
      if (prev) {
        d.mrrChange = t.mrr - prev.mrr;
        d.subscriptionsChange = t.subs - prev.subs;
        d.trialsChange = t.trials !== null && prev.trials !== null ? t.trials - prev.trials : null;
      }
    }
    prev = t;
  }

  // ---- neighbours ----
  const oldest = [revenueFrom, oldestSnapshot].filter((d): d is string => d !== null).sort()[0] ?? null;
  const prevMonth = oldest !== null && oldest < first ? addMonths(month, -1) : null;
  const nextMonth = month < today.slice(0, 7) ? addMonths(month, 1) : null;

  return { month, currency, today, days: out, revenueFrom, mrrFrom: oldestSnapshot, prevMonth, nextMonth };
}
