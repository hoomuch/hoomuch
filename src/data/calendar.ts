/**
 * Calendar read model: one month of the dashboard, day by day. Owner: Data Plane.
 *
 * One D1 round trip (a single `db.batch`), no provider calls (SPEC N-02). Same money rules as the
 * dashboard: amounts in the user's display currency at the newest FX table, past days included;
 * currencies without a rate are left out (the dashboard already says so next to the MRR).
 */

import type { ConnectionRow } from '../db/queries';
import type { Bindings, SessionUser } from '../env';
import { normalizeCurrency, parseMoneyMap } from '../lib/money';
import { addDays, dayKey, dayRange, dayStart, UTC, zonedDayKey } from '../lib/time';
import { getProviderMeta } from '../providers/registry';
import { BACKFILL_DAYS } from '../sync/aggregate';
import { FxConverter, FxHistory, LATEST_FX_SQL, fxHistoryStatement, latestFx } from '../sync/fx';
import { localDays, revenueRowsStatement } from './days';
import type { CalendarDay, CalendarMonth } from './types';

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
  const now = Date.now();
  const tz = user.timeZone || UTC;
  const today = zonedDayKey(now, tz);
  const currency = normalizeCurrency(user.baseCurrency || 'USD');
  const { first, last } = monthBounds(month);
  const monthDays = localDays('t.occurred_at', first, last, tz);
  const db = env.DB;

  const SNAP_COLS = 's.connection_id, s.day, s.mrr, s.active_subscriptions, s.active_trials';
  const [connsR, beforeR, snapsR, revR, countR, oldestR, fxR, histR] = await db.batch([
    db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at ASC').bind(user.id),
    // Each connection's last snapshot before the 1st: carried into the month, and the 1st's change.
    db
      .prepare(
        `SELECT ${SNAP_COLS} FROM snapshots s JOIN connections c ON c.id = s.connection_id
          WHERE c.user_id = ?
            AND s.day = (SELECT MAX(day) FROM snapshots WHERE connection_id = s.connection_id AND day < ?)`,
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
        `SELECT ${monthDays.day.sql} AS day, t.type, COUNT(*) AS n
           FROM transactions t JOIN connections c ON c.id = t.connection_id
          WHERE c.user_id = ? AND t.occurred_at >= ? AND t.occurred_at < ?
          GROUP BY day, t.type`,
      )
      .bind(...monthDays.day.binds, user.id, monthDays.lo, monthDays.hi),
    db
      .prepare(
        `SELECT MIN(s.day) AS day FROM snapshots s JOIN connections c ON c.id = s.connection_id WHERE c.user_id = ?`,
      )
      .bind(user.id),
    db.prepare(LATEST_FX_SQL),
    fxHistoryStatement(db, user.id, currency, first, last),
  ]);

  const conns = (connsR!.results ?? []) as unknown as ConnectionRow[];
  const before = (beforeR!.results ?? []) as unknown as SnapRow[];
  const snaps = (snapsR!.results ?? []) as unknown as SnapRow[];
  const revRows = (revR!.results ?? []) as unknown as RevRow[];
  const counts = (countR!.results ?? []) as unknown as CountRow[];
  const oldestSnapshot = ((oldestR!.results?.[0] ?? null) as { day: string | null } | null)?.day ?? null;
  type FxRows = { day: string; base: string; rates: string }[] | undefined;
  // Revenue at each day's rate, end-of-day MRR at the latest (SPEC §6).
  const cv = new FxConverter(currency, latestFx(fxR!.results as FxRows), new FxHistory(histR!.results as FxRows));

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
    const gross = cv.amountOn(r.gross, r.currency, r.day);
    const refunds = cv.amountOn(r.refunds, r.currency, r.day);
    d.gross += gross;
    d.refunds += refunds;
    d.net = (d.net ?? 0) + gross - refunds;
    d.byConnection[r.connection_id] = (d.byConnection[r.connection_id] ?? 0) + gross - refunds;
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
