/**
 * The email digest (SPEC F-25): last week's numbers, every Monday morning.
 * Owner: Lead.
 *
 * Off until the owner turns it on in Settings, and only on instances that send mail (lib/mail.ts).
 * The cron finds the users whose digest is due and puts one message each on the sync queue; the
 * queue's consumer builds the mail from the calendar read model (D1 only, never a provider) and
 * sends it. The mail holds the owner's own totals and connection names, nothing of their customers.
 * Nothing here logs an address, a figure or a link.
 */

import { getCalendarMonth } from '../data/calendar';
import { listConnectionSummaries } from '../data/connections';
import type { CalendarDay } from '../data/types';
import {
  claimDigest,
  getDigestUser,
  markDigestSent,
  selectDueDigests,
  setUserDigest,
  type DigestKind,
  type DigestUserRow,
} from '../db/queries';
import type { Bindings } from '../env';
import { derivedMac, timingSafeEqual } from '../lib/crypto';
import { escapeHtml, mailEnabled, sendMail, type MailMessage } from '../lib/mail';
import { formatMoney, formatNumber, normalizeCurrency } from '../lib/money';
import { addDays, dayStart, HOUR, UTC, zonedDayKey, zonedDayStart } from '../lib/time';
import { SEND_BATCH_MAX, type DigestMessage } from '../sync/queue';

/** The hour of the user's day the digest goes out at. */
const DIGEST_HOUR = 8;
/** Digests one cron tick queues. The rest wait for the next tick, half an hour later. */
const DIGESTS_PER_TICK = SEND_BATCH_MAX;
/** Where the mail's "stop these emails" link points: a page with one button (GET never changes anything). */
export const DIGEST_STOP_PATH = '/digest/stop';

const DIGEST_KINDS: readonly DigestKind[] = ['off', 'weekly'];

export function isDigestKind(v: string): v is DigestKind {
  return (DIGEST_KINDS as readonly string[]).includes(v);
}

/** True when the instance can offer the digest at all. */
export function digestAvailable(env: Pick<Bindings, 'RESEND_API_KEY'>): boolean {
  return mailEnabled(env);
}

const isMonday = (day: string): boolean => new Date(dayStart(day)).getUTCDay() === 1;

/** The next time a digest is due after `now`: 08:00 on the user's next Monday. Null when it's off. */
export function nextDigestAt(kind: DigestKind, tz: string, now: number): number | null {
  if (kind === 'off') return null;
  const zone = tz || UTC;
  let day = zonedDayKey(now, zone);
  // At most a week ahead; the bound only guards against a zone that never yields a Monday.
  for (let i = 0; i < 9; i++) {
    const at = zonedDayStart(day, zone) + DIGEST_HOUR * HOUR;
    if (at > now && isMonday(day)) return at;
    day = addDays(day, 1);
  }
  return null;
}

/** Saves the owner's choice from Settings. `origin` is the request's own, for the mail's links. */
export async function chooseDigest(db: D1Database, userId: string, kind: DigestKind, tz: string, origin: string, now: number = Date.now()): Promise<void> {
  await setUserDigest(db, userId, { kind, nextAt: nextDigestAt(kind, tz, now), origin: kind === 'off' ? null : origin });
}

/** After a time zone change: the next digest moves to 08:00 in the new zone. */
export async function rescheduleDigest(db: D1Database, userId: string, tz: string, now: number = Date.now()): Promise<void> {
  const u = await getDigestUser(db, userId);
  if (!u || u.digest === 'off') return;
  await setUserDigest(db, userId, { kind: u.digest, nextAt: nextDigestAt(u.digest, tz, now), origin: null });
}

// ---------- the stop link ----------

/** The token in a user's stop link: a MAC of their id, so the link works signed out and can't be guessed. */
function stopToken(env: Pick<Bindings, 'ENCRYPTION_KEY'>, userId: string): Promise<string> {
  return derivedMac(env.ENCRYPTION_KEY, 'digest-stop', userId);
}

export async function stopLinkValid(env: Pick<Bindings, 'ENCRYPTION_KEY'>, userId: string, token: string): Promise<boolean> {
  if (!userId || !token) return false;
  return timingSafeEqual(await stopToken(env, userId), token);
}

/** Turns the digest off through a stop link. False when the link isn't one of ours. */
export async function stopDigest(env: Bindings, userId: string, token: string): Promise<boolean> {
  if (!(await stopLinkValid(env, userId, token))) return false;
  await setUserDigest(env.DB, userId, { kind: 'off', nextAt: null, origin: null });
  return true;
}

// ---------- cron: queue what's due ----------

/**
 * Queues a message for every user whose digest is due and moves each to its next time. Returns how
 * many were queued. A user is claimed before their message is sent, so a failed send skips that
 * day's digest rather than risking two.
 */
export async function queueDueDigests(env: Bindings, now: number): Promise<number> {
  if (!digestAvailable(env)) return 0;
  const due = await selectDueDigests(env.DB, now, DIGESTS_PER_TICK);
  if (due.length === 0) return 0;
  const claims = await env.DB.batch(
    due.map((u) => claimDigest(env.DB, u.id, u.digest_next_at!, nextDigestAt(u.digest, u.timezone, now) ?? now + 24 * HOUR)),
  );
  const claimed = due.filter((_, i) => (claims[i]?.results?.length ?? 0) > 0);
  if (claimed.length === 0) return 0;
  await env.SYNC_QUEUE.sendBatch(claimed.map((u) => ({ body: { v: 1, digest: { userId: u.id } } satisfies DigestMessage })));
  return claimed.length;
}

// ---------- consumer: build and send ----------

/** What one digest covers, read from the calendar. Money is in `currency`, minor units. */
export interface DigestFigures {
  currency: string;
  /** The user's local days the digest covers: the seven before the day it's sent, Monday to Sunday. */
  from: string;
  to: string;
  /** Net revenue over those days; null when no connection has revenue history for them. */
  revenue: number | null;
  charges: number;
  refunds: number;
  /** At the end of `to`, and the change since the day before `from`. Null where there's no snapshot. */
  mrr: number | null;
  mrrChange: number | null;
  subscriptions: number | null;
  subscriptionsChange: number | null;
  trials: number | null;
  trialsChange: number | null;
  /** Names of the connections whose last sync failed. */
  failing: string[];
}

/** The last value on or before the end of the period, and what it was just before the period. */
function endAndChange(days: readonly CalendarDay[], from: string, pick: (d: CalendarDay) => number | null): [number | null, number | null] {
  const end = pick(days[days.length - 1]!);
  const before = days.find((d) => d.day < from);
  const start = before ? pick(before) : null;
  return [end, end !== null && start !== null ? end - start : null];
}

/** Reads the days `from - 1`..`to` from the calendar: one month, or two when the period crosses into one. */
async function readFigures(env: Bindings, u: DigestUserRow, today: string): Promise<DigestFigures | null> {
  const user = { id: u.id, email: u.email, baseCurrency: u.base_currency, timeZone: u.timezone || UTC };
  const to = addDays(today, -1);
  const from = addDays(today, -7);
  const first = addDays(from, -1);
  const months = [...new Set([first.slice(0, 7), to.slice(0, 7)])];
  const [calendars, connections] = await Promise.all([
    Promise.all(months.map((m) => getCalendarMonth(env, user, m))),
    listConnectionSummaries(env, u.id),
  ]);
  if (connections.length === 0) return null;
  const days = calendars.flatMap((c) => c.days).filter((d) => d.day >= first && d.day <= to);
  const period = days.filter((d) => d.day >= from);
  if (period.length === 0) return null;
  const withRevenue = period.filter((d) => d.net !== null);
  const [mrr, mrrChange] = endAndChange(days, from, (d) => d.mrr);
  const [subscriptions, subscriptionsChange] = endAndChange(days, from, (d) => d.activeSubscriptions);
  const [trials, trialsChange] = endAndChange(days, from, (d) => d.activeTrials);
  return {
    currency: normalizeCurrency(calendars[0]!.currency),
    from,
    to,
    revenue: withRevenue.length > 0 ? withRevenue.reduce((s, d) => s + (d.net ?? 0), 0) : null,
    charges: period.reduce((s, d) => s + d.charges, 0),
    refunds: period.reduce((s, d) => s + d.refundCount, 0),
    mrr,
    mrrChange,
    subscriptions,
    subscriptionsChange,
    trials,
    trialsChange,
    failing: connections.filter((c) => c.status === 'error').map((c) => c.name),
  };
}

const SHORT_DAY = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/** "+$40", "−$12.50", or '' for no change. */
function signedMoney(change: number | null, currency: string): string {
  if (change === null || change === 0) return '';
  return `${change > 0 ? '+' : '−'}${formatMoney(Math.abs(change), currency)}`;
}

function signedCount(change: number | null): string {
  if (change === null || change === 0) return '';
  return `${change > 0 ? '+' : '−'}${formatNumber(Math.abs(change))}`;
}

const plural = (n: number, one: string): string => `${formatNumber(n)} ${one}${n === 1 ? '' : 's'}`;

/** The digest as a message: plain text first, a minimal HTML copy with the same words. */
export function digestMessage(appName: string, to: string, f: DigestFigures, links: { dashboard: string; stop: string }): MailMessage {
  const period = `${SHORT_DAY.format(dayStart(f.from))} to ${SHORT_DAY.format(dayStart(f.to))}`;
  const rows: { label: string; value: string; note: string }[] = [];
  if (f.revenue !== null) {
    const counts = [f.charges > 0 ? plural(f.charges, 'charge') : '', f.refunds > 0 ? plural(f.refunds, 'refund') : ''].filter(Boolean).join(', ');
    rows.push({ label: 'Revenue', value: formatMoney(f.revenue, f.currency), note: counts });
  }
  if (f.mrr !== null) rows.push({ label: 'MRR', value: formatMoney(f.mrr, f.currency), note: signedMoney(f.mrrChange, f.currency) });
  if (f.subscriptions !== null) {
    rows.push({ label: 'Active subscriptions', value: formatNumber(f.subscriptions), note: signedCount(f.subscriptionsChange) });
  }
  if (f.trials !== null) rows.push({ label: 'Trials', value: formatNumber(f.trials), note: signedCount(f.trialsChange) });

  const headline = [
    f.revenue !== null ? `${formatMoney(f.revenue, f.currency)} revenue` : '',
    f.mrr !== null ? `MRR ${formatMoney(f.mrr, f.currency)}` : '',
  ].filter(Boolean);
  const subject = `Last week: ${headline.length > 0 ? headline.join(', ') : 'your numbers'}`;
  const failing = f.failing.length > 0 ? `Couldn’t sync: ${f.failing.join(', ')}. Open the connection to see why.` : '';
  const why = `You get this every Monday because you turned it on in ${appName}’s settings.`;

  const text = [
    period,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}${r.note ? ` (${r.note})` : ''}`),
    ...(failing ? ['', failing] : []),
    '',
    `Dashboard: ${links.dashboard}`,
    '',
    why,
    `Stop these emails: ${links.stop}`,
  ].join('\n');

  const cell = 'padding:6px 16px 6px 0;vertical-align:baseline';
  const html =
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">' +
    `<p style="color:#555">${escapeHtml(period)}</p>` +
    '<table style="border-collapse:collapse">' +
    rows
      .map(
        (r) =>
          `<tr><td style="${cell};color:#555">${escapeHtml(r.label)}</td>` +
          `<td style="${cell};font-weight:600">${escapeHtml(r.value)}</td>` +
          `<td style="${cell};color:#555">${escapeHtml(r.note)}</td></tr>`,
      )
      .join('') +
    '</table>' +
    (failing ? `<p style="color:#b42318">${escapeHtml(failing)}</p>` : '') +
    `<p><a href="${escapeHtml(links.dashboard)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Open the dashboard</a></p>` +
    `<p style="color:#555;font-size:13px">${escapeHtml(why)} <a href="${escapeHtml(links.stop)}" style="color:#555">Stop these emails</a></p>` +
    '</body></html>';
  return { to, subject, text, html, headers: { 'List-Unsubscribe': `<${links.stop}>` } };
}

export type DigestOutcome = 'sent' | 'skipped' | 'failed';

/**
 * Sends one user's digest. 'skipped': it's off, already sent today, or there's nothing to report
 * yet. 'failed': the mail didn't go out, and the caller may try again.
 */
export async function sendDigest(env: Bindings, userId: string, now: number = Date.now(), fetchImpl: typeof fetch = fetch): Promise<DigestOutcome> {
  if (!digestAvailable(env)) return 'skipped';
  const u = await getDigestUser(env.DB, userId);
  if (!u || u.digest === 'off' || u.email_verified_at === null || !u.digest_origin) return 'skipped';
  const today = zonedDayKey(now, u.timezone || UTC);
  if (u.digest_sent_day !== null && u.digest_sent_day >= today) return 'skipped';
  const figures = await readFigures(env, u, today);
  if (!figures || (figures.revenue === null && figures.mrr === null && figures.failing.length === 0)) return 'skipped';
  const stop = `${u.digest_origin}${DIGEST_STOP_PATH}?u=${encodeURIComponent(u.id)}&t=${await stopToken(env, u.id)}`;
  const dashboard = `${u.digest_origin}/dashboard`;
  const sent = await sendMail(env, digestMessage(env.APP_NAME || 'hoomuch', u.email, figures, { dashboard, stop }), fetchImpl);
  if (!sent) return 'failed';
  await markDigestSent(env.DB, u.id, today);
  return 'sent';
}
