/**
 * The share images' layout (SPEC F-21): the calendar's weeks, the chart's scale, the words on each
 * card and the locks. Drawing itself is the browser's (draw.ts); everything it draws comes from here.
 */
import { describe, expect, it } from 'vitest';
import type { RevenuePoint } from '../../src/data/types';
import { addDays } from '../../src/lib/time';
import {
  calendarGrid,
  calendarLayout,
  CALENDAR_WIDTH,
  CARD_COLORS,
  cardSize,
  cardSummary,
  chartGeometry,
  chartSeries,
  fileName,
  fitText,
  headline,
  initials,
  levelOf,
  needsHistory,
  PAD,
  type CardData,
} from '../../src/views/components/share-cards/layout';

/** A Monday. */
const TODAY = '2026-11-09';

function days(n: number, total: (i: number) => number): RevenuePoint[] {
  return Array.from({ length: n }, (_, i) => ({ day: addDays(TODAY, -(n - 1 - i)), total: total(i) }));
}

const DATA: CardData = {
  slug: 'acme',
  name: 'Acme',
  logo: null,
  host: 'hoomuch.com',
  mrr: 1_234_500,
  revenue: 300_000,
  revenueTotal: 4_200_000,
  today: TODAY,
  daily: days(364, () => 10_000),
  weekly: Array.from({ length: 52 }, (_, i) => ({ day: addDays(TODAY, -(51 - i) * 7 - 6), to: addDays(TODAY, -(51 - i) * 7), total: 70_000 })),
};

describe('the calendar', () => {
  it('covers the period’s days to today, Monday on top, and leaves the days around them out', () => {
    // 91 days to a Monday: from a Tuesday 13 weeks back, so 14 columns.
    const g = calendarGrid(DATA.daily, TODAY, '3m');
    expect(g.weeks).toBe(14);
    expect(g.cells).toHaveLength(14 * 7);
    expect(g.cells[0]!.row).toBe(0);
    const drawn = g.cells.filter((c) => !c.outside);
    expect(drawn).toHaveLength(91);
    expect(drawn[0]!.day).toBe(addDays(TODAY, -90));
    const today = g.cells.find((c) => c.day === TODAY)!;
    expect([today.col, today.row]).toEqual([13, 0]);
    // The Monday before the first day, and Tuesday to Sunday of this week, are left out.
    expect(g.cells.filter((c) => c.outside).map((c) => c.day)).toEqual([addDays(TODAY, -91), ...[1, 2, 3, 4, 5, 6].map((n) => addDays(TODAY, n))]);
    expect(g.cells.filter((c) => c.outside).every((c) => c.total === null)).toBe(true);
    expect(g.total).toBe(91 * 10_000);
  });

  it('says the same year as the chart', () => {
    const g = calendarGrid(DATA.daily, TODAY, '12m');
    expect(g.weeks).toBe(53);
    expect(g.total).toBe(364 * 10_000);
    expect(headline({ kind: 'calendar', period: '12m' }, DATA).value).toBe(headline({ kind: 'chart', period: '1y' }, DATA).value);
  });

  it('tints in four steps against the best day, and leaves days without figures empty', () => {
    expect([0, -5, 1, 25, 26, 50, 75, 76, 100].map((v) => levelOf(v, 100))).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 4]);
    expect(levelOf(10, 0)).toBe(0);
    // Only 30 days held: everything before is empty, not zero revenue drawn as a level.
    const g = calendarGrid(days(30, (i) => (i === 29 ? 40_000 : 10_000)), TODAY, '12m');
    const held = g.cells.filter((c) => c.total !== null);
    expect(held).toHaveLength(30);
    expect(g.cells.find((c) => c.day === TODAY)!.level).toBe(4);
    expect(held.filter((c) => c.day !== TODAY).every((c) => c.level === 1)).toBe(true);
    expect(g.best).toBe(40_000);
  });

  it('labels each month over the week it starts in, never two too close', () => {
    const g = calendarGrid(DATA.daily, TODAY, '12m');
    const labels = g.months.map((m) => m.label);
    // Nov 11, 2025 to Nov 9, 2026: both Novembers, and every month between once.
    expect(labels).toEqual(['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']);
    for (let i = 1; i < g.months.length; i++) expect(g.months[i]!.col - g.months[i - 1]!.col).toBeGreaterThanOrEqual(3);
    for (const m of g.months.slice(1)) {
      const week = g.cells.filter((c) => c.col === m.col);
      expect(week.some((c) => c.day.endsWith('-01'))).toBe(true);
    }
  });

  it('fits every period inside the card, whatever day it ends on', () => {
    for (const period of ['3m', '6m', '12m'] as const) {
      const l = calendarLayout(period);
      for (let d = 0; d < 7; d++) {
        const { weeks } = calendarGrid([], addDays(TODAY, d), period);
        expect(l.left + weeks * l.cell + (weeks - 1) * l.gap).toBeLessThanOrEqual(CALENDAR_WIDTH - PAD);
      }
      expect(l.cell).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('the chart', () => {
  it('shows days for a week or a month and weeks for the year', () => {
    expect(chartSeries('7d', DATA)).toHaveLength(7);
    expect(chartSeries('30d', DATA)).toHaveLength(30);
    expect(chartSeries('1y', DATA)).toHaveLength(52);
    expect(chartSeries('1y', { ...DATA, weekly: null })).toEqual([]);
  });

  it('puts zero at the bottom, the best day at the top tick or under it, and labels both ends', () => {
    const series = days(30, (i) => (i === 20 ? 36_000 : 0));
    const box = { x: 60, y: 100, w: 500, h: 200 };
    const g = chartGeometry(series, box);
    expect(g.ticks[0]!.y).toBe(box.y + box.h);
    expect(g.ticks[0]!.label).toBe('$0');
    expect(g.ticks.at(-1)!.y).toBe(box.y);
    expect(g.base).toBe(box.y + box.h);
    expect(Math.min(...g.points.map((p) => p.y))).toBeGreaterThanOrEqual(box.y);
    expect(g.points[0]!.x).toBe(box.x);
    expect(g.points.at(-1)!.x).toBe(box.x + box.w);
    expect(g.xLabels[0]).toMatchObject({ x: box.x, align: 'left', label: 'Oct 11' });
    expect(g.xLabels.at(-1)).toMatchObject({ x: box.x + box.w, align: 'right', label: 'Nov 9' });
  });

  it('copes with a refund-only day and with nothing at all', () => {
    const g = chartGeometry(days(7, (i) => (i === 3 ? -5_000 : 2_000)), { x: 0, y: 0, w: 100, h: 100 });
    expect(g.ticks[0]!.label.startsWith('-')).toBe(true);
    expect(g.base).toBeLessThan(100);
    expect(chartGeometry([], { x: 0, y: 0, w: 100, h: 100 })).toMatchObject({ points: [], xLabels: [] });
  });
});

describe('the card', () => {
  it('says the figure the visitor picked, in words a screen reader speaks too', () => {
    expect(headline({ kind: 'figure', figure: 'mrr' }, DATA)).toEqual({ value: '$12,345', caption: 'MRR' });
    expect(headline({ kind: 'figure', figure: 'total' }, DATA)).toEqual({ value: '$42,000', caption: 'Total revenue' });
    expect(headline({ kind: 'chart', period: '7d' }, DATA)).toEqual({ value: '$700', caption: 'revenue, last 7 days' });
    expect(headline({ kind: 'calendar', period: '3m' }, DATA).caption).toBe('revenue, last 3 months');
    expect(cardSummary({ kind: 'figure', figure: 'mrr' }, DATA)).toBe('Acme: MRR $12,345. Verified by hoomuch, hoomuch.com/p/acme.');
    expect(cardSummary({ kind: 'chart', period: '30d' }, DATA)).toBe(
      'Acme: Revenue, last 30 days $3,000, as a chart. Verified by hoomuch, hoomuch.com/p/acme.',
    );
  });

  it('locks what reaches past the open 30 days', () => {
    expect(needsHistory({ kind: 'figure', figure: 'total' })).toBe(false);
    expect(needsHistory({ kind: 'chart', period: '30d' })).toBe(false);
    expect(needsHistory({ kind: 'chart', period: '1y' })).toBe(true);
    expect(needsHistory({ kind: 'calendar', period: '3m' })).toBe(true);
  });

  it('names the file after the product and the card', () => {
    expect(fileName({ kind: 'figure', figure: 'mrr' }, 'acme')).toBe('acme-mrr.png');
    expect(fileName({ kind: 'chart', period: '30d' }, 'acme')).toBe('acme-revenue-30d.png');
    expect(fileName({ kind: 'calendar', period: '12m' }, 'acme')).toBe('acme-calendar-12m.png');
  });

  it('cuts a long name with an ellipsis, never through a character', () => {
    const measure = (s: string) => [...s].length * 10;
    expect(fitText('Acme', 100, measure)).toBe('Acme');
    expect(fitText('Acme Notes for Teams', 100, measure)).toBe('Acme Note…');
    expect(fitText('🦉🦉🦉🦉🦉🦉', 40, measure)).toBe('🦉🦉🦉…');
    expect(fitText('Acme', 5, measure)).toBe('…');
    expect(initials('acme notes app')).toBe('AA');
    expect(initials('  ')).toBe('?');
  });

  it('has the calendar as tall as its weeks need, and every colour for both themes', () => {
    expect(cardSize({ kind: 'calendar', period: '3m' }).h).toBeGreaterThan(cardSize({ kind: 'calendar', period: '12m' }).h);
    for (const c of CARD_COLORS) {
      expect(c.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(c.dark).toMatch(/^#[0-9a-f]{6}$/);
      expect(c.swatch.light).toBe(`bg-[${c.light}]`);
      expect(c.swatch.dark).toBe(`bg-[${c.dark}]`);
    }
  });
});
