/** Time zone helpers (src/lib/time.ts): local days, local midnights, DST, and their SQL. */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  HOUR,
  MINUTE,
  localDaySql,
  normalizeTimeZone,
  timeZoneOptions,
  zoneLabel,
  zoneOffset,
  zoneSegments,
  zonedDayKey,
  zonedDayStart,
} from '../../src/lib/time';
import { localDays } from '../../src/data/days';

const LA = 'America/Los_Angeles'; // DST ended 2026-11-01 at 02:00 PDT (09:00Z)
const KOLKATA = 'Asia/Kolkata'; // +05:30, no DST
const AUCKLAND = 'Pacific/Auckland'; // +13:00 in November (NZDT)
const SANTIAGO = 'America/Santiago'; // -04 in winter, -03 in summer; changes at local midnight
const LORD_HOWE = 'Australia/Lord_Howe'; // +10:30, +11:00 in summer: a half-hour DST
const iso = (s: string) => Date.parse(s);

describe('normalizeTimeZone / options', () => {
  it('accepts IANA names the runtime knows, in canonical spelling', () => {
    expect(normalizeTimeZone('Europe/Istanbul')).toBe('Europe/Istanbul');
    expect(normalizeTimeZone('UTC')).toBe('UTC');
    expect(normalizeTimeZone('Etc/UTC')).toBe('UTC');
    for (const bad of ['Not/AZone', '', 'Europe/Istanbul; DROP', 42, null, 'x'.repeat(80), 'constructor', 'toString']) expect(normalizeTimeZone(bad)).toBeNull();
  });

  it('lists UTC first, then the IANA zones', () => {
    const z = timeZoneOptions();
    expect(z[0]).toBe('UTC');
    expect(z).toContain(LA);
    expect(z.filter((x) => x === 'UTC')).toHaveLength(1);
    expect(zoneLabel('America/New_York')).toBe('America/New York');
  });

  // ICU still calls some zones by names IANA has since replaced (Asia/Calcutta, Europe/Kiev); a
  // runtime may use either. These hold on both.
  it('stores one spelling: IANA’s current name, case-normalised', () => {
    expect(normalizeTimeZone('asia/kolkata')).toBe(KOLKATA);
    expect(normalizeTimeZone('Asia/Calcutta')).toBe(KOLKATA);
    expect(normalizeTimeZone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(normalizeTimeZone('europe/kyiv')).toBe('Europe/Kyiv');
    expect(normalizeTimeZone('America/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(normalizeTimeZone('EUROPE/ISTANBUL')).toBe('Europe/Istanbul');
    expect(normalizeTimeZone('etc/utc')).toBe('UTC');
    // A legacy alias maps to its zone, where the runtime says which one, or is refused.
    expect([LA, null]).toContain(normalizeTimeZone('US/Pacific'));
  });

  it('refuses offsets and zones the list can’t show', () => {
    // EST5EDT and Japan are links some ICU versions resolve (to America/New_York, Asia/Tokyo).
    for (const bad of ['+0530', '+05:30', '-08', '-08:00', 'Etc/GMT+5', 'Etc/GMT-14', 'EST5EDT', 'PST8PDT', 'Japan', 'GB']) {
      expect(normalizeTimeZone(bad), bad).toBeNull();
    }
  });

  it('lists every zone once, by its current name, and every stored zone is one of them', () => {
    const z = timeZoneOptions();
    expect(z).toContain(KOLKATA);
    expect(z).toContain('Europe/Kyiv');
    expect(z).not.toContain('Asia/Calcutta');
    expect(z).not.toContain('Europe/Kiev');
    expect(z.slice(1).filter((x) => !x.includes('/') || x.startsWith('Etc/'))).toEqual([]);
    expect(new Set(z).size).toBe(z.length);
    for (const name of z) expect(normalizeTimeZone(name), name).toBe(name);
    for (const input of ['asia/calcutta', 'US/Eastern', 'Europe/Uzhgorod', 'GB', 'Japan', 'America/Indianapolis']) {
      const n = normalizeTimeZone(input);
      if (n !== null) expect(z, input).toContain(n);
    }
  });
});

describe('local days and midnights', () => {
  it('puts an instant on the day it is in that zone', () => {
    const t = iso('2026-11-05T05:00:00Z');
    expect(zonedDayKey(t, 'UTC')).toBe('2026-11-05');
    expect(zonedDayKey(t, LA)).toBe('2026-11-04');
    expect(zonedDayKey(iso('2026-11-04T18:29:59Z'), KOLKATA)).toBe('2026-11-04');
    expect(zonedDayKey(iso('2026-11-04T18:30:00Z'), KOLKATA)).toBe('2026-11-05');
    expect(zonedDayKey(iso('2026-11-04T11:00:00Z'), AUCKLAND)).toBe('2026-11-05');
  });

  it('finds local midnight on either side of a DST change', () => {
    expect(zonedDayStart('2026-11-01', LA)).toBe(iso('2026-11-01T07:00:00Z')); // still PDT at midnight
    expect(zonedDayStart('2026-11-02', LA)).toBe(iso('2026-11-02T08:00:00Z')); // PST
    expect(zonedDayStart('2026-11-05', KOLKATA)).toBe(iso('2026-11-04T18:30:00Z'));
    expect(zonedDayStart('2026-11-05', AUCKLAND)).toBe(iso('2026-11-04T11:00:00Z'));
    expect(zonedDayStart('2026-11-05', 'UTC')).toBe(iso('2026-11-05T00:00:00Z'));
    // The DST day is 25 hours long.
    expect(zonedDayStart('2026-11-02', LA) - zonedDayStart('2026-11-01', LA)).toBe(25 * HOUR);
  });

  it('finds the start of a day that shrinks by half an hour, or whose midnight is skipped', () => {
    // Lord Howe goes from +10:30 to +11:00 at 02:00 on Sunday 2026-10-04 (15:30 UTC on the 3rd).
    expect(zonedDayStart('2026-10-04', LORD_HOWE)).toBe(iso('2026-10-03T13:30:00Z'));
    expect(zonedDayStart('2026-10-05', LORD_HOWE)).toBe(iso('2026-10-04T13:00:00Z'));
    expect(zonedDayStart('2026-10-05', LORD_HOWE) - zonedDayStart('2026-10-04', LORD_HOWE)).toBe(23.5 * HOUR);
    // Chile starts DST at 04:00 UTC on Sunday 2026-09-06: 00:00 (-04) becomes 01:00 (-03).
    expect(zonedDayStart('2026-09-06', SANTIAGO)).toBe(iso('2026-09-06T04:00:00Z'));
    expect(zonedDayStart('2026-09-07', SANTIAGO)).toBe(iso('2026-09-07T03:00:00Z'));
  });

  it('splits a range into one segment per offset, to the minute', () => {
    const from = zonedDayStart('2026-10-25', LA);
    const to = zonedDayStart('2026-11-06', LA);
    expect(zoneSegments(from, to, LA)).toEqual([
      { from, offset: -7 * HOUR },
      { from: iso('2026-11-01T09:00:00Z'), offset: -8 * HOUR },
    ]);
    expect(zoneSegments(from, to, KOLKATA)).toEqual([{ from, offset: 5 * HOUR + 30 * MINUTE }]);
    expect(zoneOffset(iso('2026-11-01T08:59:00Z'), LA)).toBe(-7 * HOUR);
  });
});

describe('localDaySql', () => {
  const db = new DatabaseSync(':memory:');
  /** Evaluates the expression in SQLite for one instant (the "column" is that instant, as a literal). */
  const dayInSql = (ms: number, tz: string, from: number, to: number) => {
    const { sql, binds } = localDaySql(String(ms), zoneSegments(from, to, tz));
    return (db.prepare(`SELECT ${sql} AS d`).get(...binds) as { d: string }).d;
  };

  it('matches zonedDayKey for every hour across a DST change', () => {
    const from = zonedDayStart('2026-10-30', LA);
    const to = zonedDayStart('2026-11-04', LA);
    for (let t = from; t < to; t += HOUR) expect(dayInSql(t, LA, from, to), new Date(t).toISOString()).toBe(zonedDayKey(t, LA));
  });

  it('is a fixed offset without DST', () => {
    const from = zonedDayStart('2026-11-01', KOLKATA);
    const to = zonedDayStart('2026-11-06', KOLKATA);
    expect(localDaySql('t.occurred_at', zoneSegments(from, to, KOLKATA))).toEqual({
      sql: "strftime('%Y-%m-%d', (t.occurred_at + ?) / 1000, 'unixepoch')",
      binds: [5 * HOUR + 30 * MINUTE],
    });
    expect(dayInSql(iso('2026-11-04T18:30:00Z'), KOLKATA, from, to)).toBe('2026-11-05');
  });
});

describe('localDays in SQL', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE probes (at INTEGER NOT NULL)');
  /** Each instant's local day as SQLite computes it with `localDays`' expression for the range. */
  function sqlDays(fromDay: string, toDay: string, tz: string, instants: number[]): Map<number, string> {
    db.exec('DELETE FROM probes');
    const insert = db.prepare('INSERT INTO probes (at) VALUES (?)');
    for (const ms of instants) insert.run(ms);
    const { day } = localDays('p.at', fromDay, toDay, tz);
    const rows = db.prepare(`SELECT p.at AS at, ${day.sql} AS d FROM probes p`).all(...day.binds) as { at: number; d: string }[];
    return new Map(rows.map((r) => [r.at, r.d]));
  }
  /** The calendar day on a wall clock `offsetHours` from UTC: read off the shifted ISO string. */
  const wallDay = (ms: number, offsetHours: number) => new Date(ms + offsetHours * HOUR).toISOString().slice(0, 10);
  const every = (from: number, to: number, step: number) => Array.from({ length: Math.ceil((to - from) / step) }, (_, i) => from + i * step);

  it('Santiago: the hour after DST ends is still the day before', () => {
    // Chile leaves DST at 03:00 UTC on Sunday 2026-04-05: midnight (-03) becomes 23:00 on the 4th (-04).
    const END = iso('2026-04-05T03:00:00Z');
    const { lo, hi } = localDays('p.at', '2026-04-03', '2026-04-07', SANTIAGO);
    expect([lo, hi]).toEqual([iso('2026-04-03T03:00:00Z'), iso('2026-04-08T04:00:00Z')]);
    const days = sqlDays('2026-04-03', '2026-04-07', SANTIAGO, every(lo, hi, 30 * MINUTE));
    expect(days.size).toBe(5 * 48 + 2);
    for (const [at, d] of days) expect(d, new Date(at).toISOString()).toBe(wallDay(at, at < END ? -3 : -4));
    expect(days.get(END)).toBe('2026-04-04'); // 23:00 on the 4th, not midnight on the 5th
    expect(days.get(iso('2026-04-05T04:00:00Z'))).toBe('2026-04-05');
  });

  it('Los Angeles over most of a year: three offsets, the newest checked first', () => {
    // PDT from 10:00 UTC on 2026-03-08, PST again from 09:00 UTC on 2026-11-01.
    const { lo, hi, day } = localDays('p.at', '2026-03-01', '2026-11-30', LA);
    expect(zoneSegments(lo, hi, LA)).toEqual([
      { from: iso('2026-03-01T08:00:00Z'), offset: -8 * HOUR },
      { from: iso('2026-03-08T10:00:00Z'), offset: -7 * HOUR },
      { from: iso('2026-11-01T09:00:00Z'), offset: -8 * HOUR },
    ]);
    expect(day.binds).toHaveLength(5);
    const days = sqlDays('2026-03-01', '2026-11-30', LA, every(iso('2026-11-01T00:00:00Z'), iso('2026-11-05T00:00:00Z'), HOUR));
    expect(days.size).toBe(96);
    for (const [at, d] of days) expect(d, new Date(at).toISOString()).toBe(wallDay(at, at < iso('2026-11-01T09:00:00Z') ? -7 : -8));
    expect(days.get(iso('2026-11-02T07:00:00Z'))).toBe('2026-11-01'); // 23:00 PST
  });
});
