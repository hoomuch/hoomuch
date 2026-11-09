/**
 * The share images' layout (SPEC F-21): what each card says and where it goes, as plain numbers,
 * so draw.ts only paints and the tests check the maths. Owner: Experience (data-viz).
 *
 * Three cards: a figure (MRR, revenue over 30 days or the total held), the revenue chart, and the
 * revenue calendar, each in a light or a dark theme. Sizes are CSS pixels; the canvas draws them at
 * 2x, so a download is twice as wide. Amounts are USD minor units, like the stored figures.
 */

import type { RevenuePoint } from '../../../data/types';
import { formatMoney } from '../../../lib/money';
import { addDays, dayStart } from '../../../lib/time';
import { niceScale, shortDay, tickLabels } from '../../charts/scale';

export type CardKind = 'figure' | 'chart' | 'calendar';
export type CardTheme = 'light' | 'dark';
export type FigureChoice = 'mrr' | 'revenue' | 'total';
export type ChartPeriod = '7d' | '30d' | '1y';
export type CalendarPeriod = '3m' | '6m' | '12m';

export type CardSpec =
  | { kind: 'figure'; figure: FigureChoice }
  | { kind: 'chart'; period: ChartPeriod }
  | { kind: 'calendar'; period: CalendarPeriod };

/** What a card is made from: plain JSON, from the page's props or the history a visitor opened. */
export interface CardData {
  slug: string;
  name: string;
  /** The logo's same-origin URL (/media/…), null for initials. */
  logo: string | null;
  /** Where the page lives, e.g. "hoomuch.com": the card's footer says host/p/slug. */
  host: string;
  mrr: number;
  /** Revenue over the last 30 days. */
  revenue: number;
  revenueTotal: number;
  /** The owner's today: the last day of every series. */
  today: string;
  /** Daily revenue, oldest first, ending today: 30 days for a visitor without an account, a year once opened. */
  daily: readonly RevenuePoint[];
  /** The year in weeks; null while it's locked. */
  weekly: readonly RevenuePoint[] | null;
}

/** Whether a card needs the history behind the lock (a visitor without an account can't make it). */
export function needsHistory(spec: CardSpec): boolean {
  return spec.kind === 'calendar' || (spec.kind === 'chart' && spec.period === '1y');
}

// ---------- colours ----------

export interface CardColor {
  id: string;
  name: string;
  /** The colour on a light card and on a dark one. */
  light: string;
  dark: string;
  /** Its swatch, as literal Tailwind classes (the CSS build only sees whole class names). */
  swatch: { light: string; dark: string };
}

export const CARD_COLORS: readonly CardColor[] = [
  { id: 'blue', name: 'hoomuch blue', light: '#0864cd', dark: '#62a7fa', swatch: { light: 'bg-[#0864cd]', dark: 'bg-[#62a7fa]' } },
  { id: 'violet', name: 'Violet', light: '#7c3aed', dark: '#a78bfa', swatch: { light: 'bg-[#7c3aed]', dark: 'bg-[#a78bfa]' } },
  { id: 'indigo', name: 'Indigo', light: '#4f46e5', dark: '#818cf8', swatch: { light: 'bg-[#4f46e5]', dark: 'bg-[#818cf8]' } },
  { id: 'sky', name: 'Sky', light: '#0284c7', dark: '#38bdf8', swatch: { light: 'bg-[#0284c7]', dark: 'bg-[#38bdf8]' } },
  { id: 'teal', name: 'Teal', light: '#0d9488', dark: '#2dd4bf', swatch: { light: 'bg-[#0d9488]', dark: 'bg-[#2dd4bf]' } },
  { id: 'green', name: 'Green', light: '#16a34a', dark: '#4ade80', swatch: { light: 'bg-[#16a34a]', dark: 'bg-[#4ade80]' } },
  { id: 'lime', name: 'Lime', light: '#65a30d', dark: '#a3e635', swatch: { light: 'bg-[#65a30d]', dark: 'bg-[#a3e635]' } },
  { id: 'amber', name: 'Amber', light: '#d97706', dark: '#fbbf24', swatch: { light: 'bg-[#d97706]', dark: 'bg-[#fbbf24]' } },
  { id: 'orange', name: 'Orange', light: '#ea580c', dark: '#fb923c', swatch: { light: 'bg-[#ea580c]', dark: 'bg-[#fb923c]' } },
  { id: 'red', name: 'Red', light: '#dc2626', dark: '#f87171', swatch: { light: 'bg-[#dc2626]', dark: 'bg-[#f87171]' } },
  { id: 'pink', name: 'Pink', light: '#db2777', dark: '#f472b6', swatch: { light: 'bg-[#db2777]', dark: 'bg-[#f472b6]' } },
];

/** The card's own colours, hoomuch's palette (styles/app.css) for each theme. */
export const CARD_THEMES: Record<CardTheme, { bg: string; fg: string; muted: string; faint: string; border: string; empty: string; brand: string }> = {
  light: { bg: '#ffffff', fg: '#15181e', muted: '#5b5d62', faint: '#8a8f98', border: '#e2e4e8', empty: '#eef0f3', brand: '#0864cd' },
  dark: { bg: '#131417', fg: '#e9ebef', muted: '#a8a9ad', faint: '#6b6f76', border: '#2a2d31', empty: '#1e2024', brand: '#62a7fa' },
};

// ---------- text ----------

const usd = (minor: number) => formatMoney(minor, 'USD', { whole: true });

const sum = (rows: readonly { total: number }[]) => rows.reduce((a, r) => a + r.total, 0);

const CHART_WORDS: Record<ChartPeriod, string> = { '7d': 'last 7 days', '30d': 'last 30 days', '1y': 'last 12 months' };
const CALENDAR_WORDS: Record<CalendarPeriod, string> = { '3m': 'last 3 months', '6m': 'last 6 months', '12m': 'last 12 months' };
const FIGURE_LABEL: Record<FigureChoice, string> = { mrr: 'MRR', revenue: 'Revenue, last 30 days', total: 'Total revenue' };

/** The card's big number and the words under it. */
export function headline(spec: CardSpec, data: CardData): { value: string; caption: string } {
  if (spec.kind === 'figure') {
    const v = spec.figure === 'mrr' ? data.mrr : spec.figure === 'revenue' ? data.revenue : data.revenueTotal;
    return { value: usd(v), caption: FIGURE_LABEL[spec.figure] };
  }
  if (spec.kind === 'chart') return { value: usd(sum(chartSeries(spec.period, data))), caption: `revenue, ${CHART_WORDS[spec.period]}` };
  const grid = calendarGrid(data.daily, data.today, spec.period);
  return { value: usd(grid.total), caption: `revenue, ${CALENDAR_WORDS[spec.period]}` };
}

/** What a screen reader hears for the preview: the card's sentence. */
export function cardSummary(spec: CardSpec, data: CardData): string {
  const h = headline(spec, data);
  const what = spec.kind === 'figure' ? h.caption : `${h.caption[0]!.toUpperCase()}${h.caption.slice(1)}`;
  const kind = spec.kind === 'chart' ? ', as a chart' : spec.kind === 'calendar' ? ', as a calendar' : '';
  return `${data.name}: ${what} ${h.value}${kind}. Verified by hoomuch, ${data.host}/p/${data.slug}.`;
}

/** The file a download saves to, e.g. "acme-revenue-30d.png". */
export function fileName(spec: CardSpec, slug: string): string {
  const part = spec.kind === 'figure' ? spec.figure : spec.kind === 'chart' ? `revenue-${spec.period}` : `calendar-${spec.period}`;
  return `${slug}-${part}.png`;
}

/** Up to two initials, for a product without a logo (like views/components/avatar.tsx). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : words;
  return letters.map((w) => [...w][0]!.toUpperCase()).join('').slice(0, 2) || '?';
}

/**
 * `text` cut to fit `max` width with an ellipsis, measured by `measure` (the canvas's measureText
 * in the browser). Whole characters only, so an emoji is never split.
 */
export function fitText(text: string, max: number, measure: (s: string) => number): string {
  if (measure(text) <= max) return text;
  const chars = [...text];
  while (chars.length > 0 && measure(`${chars.join('').trimEnd()}…`) > max) chars.pop();
  return chars.length > 0 ? `${chars.join('').trimEnd()}…` : '…';
}

// ---------- sizes ----------

/** Card sizes in CSS px. The calendar is as tall as its weeks need. */
const FIGURE_SIZE = { w: 520, h: 250 };
const CHART_SIZE = { w: 640, h: 380 };
export const CALENDAR_WIDTH = 720;
export const PAD = 28;
/** The footer's height: the rings, "Verified by hoomuch" and the page's address. */
export const FOOTER_H = 44;

export function cardSize(spec: CardSpec): { w: number; h: number } {
  if (spec.kind === 'figure') return FIGURE_SIZE;
  if (spec.kind === 'chart') return CHART_SIZE;
  const g = calendarLayout(spec.period);
  return { w: CALENDAR_WIDTH, h: g.top + 7 * g.cell + 6 * g.gap + 44 + FOOTER_H };
}

// ---------- the chart ----------

/** The chart's points: days for 7 and 30 days, weeks for the year. */
export function chartSeries(period: ChartPeriod, data: CardData): readonly RevenuePoint[] {
  if (period === '1y') return data.weekly ?? [];
  return data.daily.slice(period === '7d' ? -7 : -30);
}

export interface ChartGeometry {
  /** Gridlines, bottom to top, with their labels. */
  ticks: Array<{ y: number; label: string }>;
  points: Array<{ x: number; y: number }>;
  /** The baseline's y (zero, or the lowest tick when revenue dips below it). */
  base: number;
  xLabels: Array<{ x: number; label: string; align: 'left' | 'center' | 'right' }>;
}

/** Where the chart goes inside `box` (the plot area, axis labels outside it). */
export function chartGeometry(series: readonly RevenuePoint[], box: { x: number; y: number; w: number; h: number }): ChartGeometry {
  const values = series.map((p) => p.total);
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values, 0), { minStep: 100, minTicks: 3, maxTicks: 5 });
  const span = scale.max - scale.min || 1;
  const yOf = (v: number) => box.y + box.h - ((v - scale.min) / span) * box.h;
  const n = series.length;
  const xOf = (i: number) => (n <= 1 ? box.x + box.w / 2 : box.x + (i / (n - 1)) * box.w);
  const labels = tickLabels(scale.ticks, 'USD');
  const picks = n <= 1 ? [0] : [...new Set([0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1])];
  return {
    ticks: scale.ticks.map((t, i) => ({ y: yOf(t), label: labels[i]! })),
    points: series.map((p, i) => ({ x: xOf(i), y: yOf(p.total) })),
    base: yOf(Math.max(scale.min, 0)),
    xLabels:
      n === 0
        ? []
        : picks.map((i, k) => ({
            x: xOf(i),
            label: shortDay(series[i]!.day),
            align: picks.length > 1 && k === 0 ? 'left' : picks.length > 1 && k === picks.length - 1 ? 'right' : 'center',
          })),
  };
}

// ---------- the calendar ----------

/** The days each period covers, ending today: whole weeks, the year the same 364 days as the chart's. */
const CALENDAR_DAYS: Record<CalendarPeriod, number> = { '3m': 91, '6m': 182, '12m': 364 };

/**
 * The calendar's cell size and gap, and where the grid starts. Sized for the most columns the
 * period can take (its weeks, plus one when they don't start on a Monday), so every day's card is
 * the same size.
 */
export function calendarLayout(period: CalendarPeriod): { cell: number; gap: number; left: number; top: number } {
  const columns = CALENDAR_DAYS[period] / 7 + 1;
  const gap = columns > 30 ? 3 : 4;
  // Room for the weekday labels on the left; month labels over the grid.
  const left = PAD + 30;
  const room = CALENDAR_WIDTH - left - PAD;
  const cell = Math.min(22, Math.floor((room - (columns - 1) * gap) / columns));
  return { cell, gap, left, top: PAD + 64 + 18 };
}

export interface CalendarCell {
  day: string;
  /** Column (week) and row (Monday = 0). */
  col: number;
  row: number;
  /** null when there's no figure for the day (before the history, or still to come). */
  total: number | null;
  /** 0 = nothing, 1–4 = a quarter of the period's best day, half of it… */
  level: 0 | 1 | 2 | 3 | 4;
  /** Before the period or after today: in the grid's first or last week, but not drawn. */
  outside: boolean;
}

/** Monday = 0 … Sunday = 6. */
function weekday(day: string): number {
  return (new Date(dayStart(day)).getUTCDay() + 6) % 7;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A day's step against the best day: four, like the dashboard calendar's tints. */
export function levelOf(total: number, best: number): 0 | 1 | 2 | 3 | 4 {
  if (!(total > 0) || !(best > 0)) return 0;
  return Math.min(4, Math.max(1, Math.ceil((total / best) * 4))) as 1 | 2 | 3 | 4;
}

/**
 * The period's days as weeks, Monday on top, from the week its first day is in to the week with
 * today in it (the days around them in those weeks are left out); month labels over the column
 * where each month begins (none closer than three columns), and the period's total.
 */
export function calendarGrid(
  daily: readonly RevenuePoint[],
  today: string,
  period: CalendarPeriod,
): { weeks: number; cells: CalendarCell[]; months: Array<{ col: number; label: string }>; total: number; best: number } {
  const days = CALENDAR_DAYS[period];
  const first = addDays(today, -(days - 1));
  const start = addDays(first, -weekday(first));
  const weeks = Math.ceil((weekday(first) + days) / 7);
  const byDay = new Map(daily.map((d) => [d.day, d.total]));
  const cells: CalendarCell[] = [];
  let best = 0;
  let total = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const day = addDays(start, i);
    const outside = day < first || day > today;
    const v = outside ? undefined : byDay.get(day);
    if (v !== undefined) {
      total += v;
      if (v > best) best = v;
    }
    cells.push({ day, col: Math.floor(i / 7), row: i % 7, total: v ?? null, level: 0, outside });
  }
  for (const c of cells) c.level = c.total === null ? 0 : levelOf(c.total, best);
  const months: Array<{ col: number; label: string }> = [];
  const monthOf = (day: string) => MONTH_SHORT[Number(day.slice(5, 7)) - 1]!;
  for (let col = 0; col < weeks; col++) {
    const week = cells.slice(col * 7, col * 7 + 7).filter((c) => !c.outside);
    const starts = week.find((c) => c.day.endsWith('-01'));
    // Each month over the week it starts in; the first column says the month it's already in,
    // unless the next one starts too close to fit both.
    if (starts) months.push({ col, label: monthOf(starts.day) });
    else if (col === 0 && !cells.slice(7, 21).some((c) => c.day.endsWith('-01'))) months.push({ col, label: monthOf(week[0]!.day) });
  }
  for (let i = months.length - 1; i > 0; i--) if (months[i]!.col - months[i - 1]!.col < 3) months.splice(i - 1, 1);
  return { weeks, cells, months, total, best };
}
