/**
 * Time helpers. Owner: Lead. Days are 'YYYY-MM-DD'; `dayKey` and friends are UTC, the `zoned*`
 * helpers take an IANA zone (the user's, SPEC §6).
 */

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

// ---------- time zones (SPEC §6: days run midnight to midnight in the user's zone) ----------

/** The zone everything defaults to, and the one provider-reported days mostly use. */
export const UTC = 'UTC';

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function partsFormat(tz: string): Intl.DateTimeFormat {
  let f = zoneFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    zoneFormats.set(tz, f);
  }
  return f;
}

const UTC_ALIASES = new Set(['UTC', 'ETC/UTC', 'ETC/GMT', 'GMT', 'ETC/UCT', 'UCT', 'ETC/ZULU', 'ZULU']);

/**
 * Zones ICU (CLDR) still calls by a name IANA has since replaced. CLDR never renames its ids, so
 * this only grows when IANA renames a zone, and a runtime that already uses IANA's names never
 * hits it: either way the list, and so every stored zone, reads the same on Node and on Workers.
 */
const IANA_NAMES: ReadonlyMap<string, string> = new Map([
  ['Africa/Asmera', 'Africa/Asmara'],
  ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Cordoba', 'America/Argentina/Cordoba'],
  ['America/Godthab', 'America/Nuuk'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
  ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['Asia/Calcutta', 'Asia/Kolkata'],
  ['Asia/Katmandu', 'Asia/Kathmandu'],
  ['Asia/Rangoon', 'Asia/Yangon'],
  ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'],
  ['Europe/Kiev', 'Europe/Kyiv'],
  ['Pacific/Enderbury', 'Pacific/Kanton'],
  ['Pacific/Ponape', 'Pacific/Pohnpei'],
  ['Pacific/Truk', 'Pacific/Chuuk'],
]);

let zoneList: { options: string[]; byLowerCase: Map<string, string> } | null = null;

/**
 * The pickable zones, built once: UTC, then the runtime's Area/Location zones by their IANA names.
 * Fixed offsets (Etc/GMT+5) and POSIX rules (EST5EDT) stay out, whatever the runtime lists.
 */
function zones(): { options: string[]; byLowerCase: Map<string, string> } {
  if (!zoneList) {
    const runtime = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    const names = new Set<string>();
    for (const z of runtime) {
      const name = IANA_NAMES.get(z) ?? z;
      if (name.includes('/') && !name.startsWith('Etc/')) names.add(name);
    }
    const options = [UTC, ...[...names].sort()];
    zoneList = { options, byLowerCase: new Map(options.map((z) => [z.toLowerCase(), z])) };
  }
  return zoneList;
}

/**
 * The zone `tz` names, spelled as `timeZoneOptions()` lists it ("asia/calcutta" → "Asia/Kolkata",
 * UTC's aliases → "UTC"), or null: offsets ("+05:30", "Etc/GMT+5"), POSIX rules ("EST5EDT") and
 * anything else the list can't show are refused, so a stored zone is always one the user can pick.
 */
export function normalizeTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return null;
  if (UTC_ALIASES.has(tz.toUpperCase())) return UTC;
  const { byLowerCase } = zones();
  const listed = byLowerCase.get(tz.toLowerCase());
  if (listed) return listed;
  // POSIX rules and one-word links ("EST5EDT", "Japan") resolve differently by ICU version (an
  // older one maps EST5EDT to America/New_York): refused everywhere, so they read the same.
  if (!tz.includes('/')) return null;
  // An old name or a link ("Asia/Calcutta", "US/Pacific"): the zone the runtime resolves it to,
  // if that one is listed.
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (UTC_ALIASES.has(resolved.toUpperCase())) return UTC;
  return byLowerCase.get((IANA_NAMES.get(resolved) ?? resolved).toLowerCase()) ?? null;
}

/** Every zone a user can pick, UTC first, then the runtime's IANA zones by their current names. */
export function timeZoneOptions(): string[] {
  return [...zones().options];
}

/** Offset of `tz` from UTC at the instant `ms`, in ms (local wall clock = UTC + offset). */
export function zoneOffset(ms: number, tz: string): number {
  if (tz === UTC) return 0;
  const p: Record<string, number> = {};
  for (const part of partsFormat(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour'] === 24 ? 0 : p['hour']!, p['minute']!, p['second']!);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The 'YYYY-MM-DD' day `ms` falls on in `tz`. */
export function zonedDayKey(ms: number, tz: string): string {
  return tz === UTC ? dayKey(ms) : dayKey(ms + zoneOffset(ms, tz));
}

/** The instant `day` starts in `tz` (its local midnight, or the first instant after a DST gap). */
export function zonedDayStart(day: string, tz: string): number {
  const wall = dayStart(day);
  if (tz === UTC) return wall;
  let t = wall - zoneOffset(wall, tz);
  t = wall - zoneOffset(t, tz);
  // Where midnight itself is skipped by a DST change, step to the day's first real hour.
  for (let i = 0; i < 4 && zonedDayKey(t, tz) < day; i++) t += HOUR;
  return t;
}

/** A stretch of time with one UTC offset: instants from `from` on, until the next segment. */
export interface ZoneSegment {
  from: number;
  offset: number;
}

/** The offsets `tz` uses between `fromMs` and `toMs`, oldest first (one segment without DST). */
export function zoneSegments(fromMs: number, toMs: number, tz: string): ZoneSegment[] {
  const first = { from: fromMs, offset: zoneOffset(fromMs, tz) };
  if (tz === UTC) return [first];
  const out: ZoneSegment[] = [first];
  let prev = fromMs;
  let prevOffset = first.offset;
  // DST changes are months apart: a daily probe finds each, a binary search pins it to the minute.
  while (prev < toMs) {
    const next = Math.min(prev + DAY, toMs);
    const offset = zoneOffset(next, tz);
    if (offset !== prevOffset) {
      let lo = prev;
      let hi = next;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.max(MINUTE, Math.floor((hi - lo) / 2 / MINUTE) * MINUTE);
        if (zoneOffset(mid, tz) === prevOffset) lo = mid;
        else hi = mid;
      }
      out.push({ from: hi, offset });
      prevOffset = offset;
    }
    prev = next;
  }
  return out;
}

/**
 * SQL for the local day an epoch-ms column falls on, given the zone's segments over the queried
 * range (D1 has no time zone support). Returns the expression and its bind values, in order.
 */
export function localDaySql(column: string, segments: readonly ZoneSegment[]): { sql: string; binds: number[] } {
  if (segments.length <= 1) {
    return { sql: `strftime('%Y-%m-%d', (${column} + ?) / 1000, 'unixepoch')`, binds: [segments[0]?.offset ?? 0] };
  }
  const binds: number[] = [];
  let expr = 'CASE';
  for (let i = segments.length - 1; i >= 1; i--) {
    expr += ` WHEN ${column} >= ? THEN ?`;
    binds.push(segments[i]!.from, segments[i]!.offset);
  }
  expr += ' ELSE ? END';
  binds.push(segments[0]!.offset);
  return { sql: `strftime('%Y-%m-%d', (${column} + ${expr}) / 1000, 'unixepoch')`, binds };
}

/** "Europe/Istanbul" → "Europe/Istanbul", "America/New_York" → "America/New York": for labels. */
export function zoneLabel(tz: string): string {
  return tz.replace(/_/g, ' ');
}
