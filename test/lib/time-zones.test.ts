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

const LA = 'America/Los_Angeles'; // DST ended 2026-11-01 at 02:00 PDT (09:00Z)
const KOLKATA = 'Asia/Kolkata'; // +05:30, no DST
const AUCKLAND = 'Pacific/Auckland'; // +13:00 in November (NZDT)
const iso = (s: string) => Date.parse(s);

describe('normalizeTimeZone / options', () => {
  it('accepts IANA names the runtime knows, in canonical spelling', () => {
    expect(normalizeTimeZone('Europe/Istanbul')).toBe('Europe/Istanbul');
    expect(normalizeTimeZone('UTC')).toBe('UTC');
    expect(normalizeTimeZone('Etc/UTC')).toBe('UTC');
    for (const bad of ['Not/AZone', '', 'Europe/Istanbul; DROP', 42, null, 'x'.repeat(80)]) expect(normalizeTimeZone(bad)).toBeNull();
  });

  it('lists UTC first, then the IANA zones', () => {
    const z = timeZoneOptions();
    expect(z[0]).toBe('UTC');
    expect(z).toContain(LA);
    expect(z.filter((x) => x === 'UTC')).toHaveLength(1);
    expect(zoneLabel('America/New_York')).toBe('America/New York');
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
