/** Time helpers. Days are UTC 'YYYY-MM-DD'. Owner: Lead. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Midnight UTC of the given day key, in ms. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, n: number): string {
  return dayKey(dayStart(day) + n * DAY);
}

/** Inclusive list of day keys from `from` to `to`, oldest first. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The last `n` day keys ending today (inclusive), oldest first. */
export function lastNDays(n: number, now: number = Date.now()): string[] {
  const today = dayKey(now);
  return dayRange(addDays(today, -(n - 1)), today);
}

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "just now", "4 min ago", "3 h ago", "2 days ago", or "Sep 25, 2026" for older values. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 30 * DAY) {
    const d = Math.floor(diff / DAY);
    return d === 1 ? '1 day ago' : `${d} days ago`;
  }
  return shortDate.format(ms);
}
