/**
 * Pure scale / tick / label helpers shared by the charts. Owner: Experience (data-viz).
 * No DOM, no JSX — unit-tested in test/views/charts.test.ts.
 *
 * The charts draw with Recharts (see frame.tsx); these helpers decide what it draws, so the
 * numbers are ours and identical on the server and in the browser:
 *  - niceScale / revenueScale / mrrScale give the y domain and its ticks (min and max are ticks),
 *    tickLabels their labels; xLabelIndices the sparse x labels (first, middle, last).
 *  - bandGapRatio sets the space between daily bars, sameColorOpacities and isHexColor the colours,
 *    chartId the deterministic ids, money / shortDay / longDay / dayRangeLabel the text.
 *  - yMapper, xTicks (pct + anchor) and svgNum describe the same geometry for code that lays out
 *    SVG by hand; Recharts doesn't need them.
 */

import { currencyExponent, formatMoney, type FormatMoneyOptions } from '../../lib/money';

/** Plot area height in CSS px (frame.tsx: the h-48 chart box = top margin + this + the x axis). */
export const PLOT_HEIGHT = 160;

// ---------- number hygiene ----------

/** NaN / ±Infinity / -0 / non-numbers → 0. */
export function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n || 0 : 0;
}

/** Number for an SVG attribute: finite, at most 2 decimals, never "-0". */
export function svgNum(n: number): string {
  const v = Math.round(finite(n) * 100) / 100;
  return String(v || 0);
}

/** One major unit in minor units ($1 = 100, ¥1 = 1). The finest tick step we allow. */
export function majorUnit(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/** formatMoney that never throws (an unknown currency code falls back to a plain number). */
export function money(minor: number, currency: string, opts: FormatMoneyOptions = {}): string {
  const v = finite(minor);
  try {
    return formatMoney(v, currency, opts);
  } catch {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v / majorUnit(currency));
  }
}

// ---------- nice scales ----------

export interface NiceScale {
  /** Domain bottom; always equals ticks[0]. */
  min: number;
  /** Domain top; always equals the last tick. */
  max: number;
  step: number;
  /** Ascending, equally spaced, min…max inclusive. */
  ticks: number[];
}

export interface NiceScaleOptions {
  /** Smallest allowed step (default 1, i.e. one minor unit). Use majorUnit(currency) for money. */
  minStep?: number;
  /** Default 3. */
  minTicks?: number;
  /** Default 5. */
  maxTicks?: number;
}

const MULTIPLIERS = [1, 2, 5] as const;

function cleanTick(v: number, step: number): number {
  const r = Number.isInteger(step) ? Math.round(v) : Number.parseFloat(v.toPrecision(12));
  return r || 0;
}

/**
 * The tightest 1-2-5 step that covers [lo, hi] with `minTicks`–`maxTicks` gridlines (min and max are
 * themselves ticks, so the labels can be laid out with justify-between). Zero is always a tick when
 * the range crosses it, and then it is the baseline rather than a gridline, so one extra tick is
 * allowed: a −$90 refund next to $650 days gets −$200…$800 (6 ticks) instead of wasting a third of
 * the plot on −$500…$1K. Degenerate input is made safe: lo === hi === 0 → [0, s, 2s]; a single
 * non-zero value is extended to zero; NaN/Infinity count as 0.
 */
export function niceScale(lo: number, hi: number, opts: NiceScaleOptions = {}): NiceScale {
  const minStep = opts.minStep !== undefined && Number.isFinite(opts.minStep) && opts.minStep > 0 ? opts.minStep : 1;
  const minTicks = Math.min(Math.max(Math.round(finite(opts.minTicks ?? 3)), 2), 10);
  const maxTicks = Math.max(minTicks, 3, Math.min(Math.round(finite(opts.maxTicks ?? 5)), 10));

  let a = finite(lo);
  let b = finite(hi);
  if (a > b) [a, b] = [b, a];
  if (a === b) {
    if (a > 0) a = 0;
    else if (a < 0) b = 0;
    else b = minStep;
  }
  const span = b - a;
  const limit = a < 0 && b > 0 ? maxTicks + 1 : maxTicks;

  let step = 0;
  let nmin = 0;
  let nmax = 0;
  const e0 = Math.floor(Math.log10(Math.max(span / limit, minStep)));
  search: for (let e = e0 - 1; e <= e0 + 8; e++) {
    for (const m of MULTIPLIERS) {
      const s = m * 10 ** e;
      if (s < minStep) continue;
      const lo2 = Math.floor(a / s) * s;
      const hi2 = Math.ceil(b / s) * s;
      if (Math.round((hi2 - lo2) / s) + 1 <= limit) {
        step = s;
        nmin = lo2;
        nmax = hi2;
        break search;
      }
    }
  }
  if (step === 0) {
    // Unreachable for finite input (a step ≥ span always fits in 3 ticks), but never loop or divide by 0.
    step = Math.max(span, minStep);
    nmin = Math.floor(a / step) * step;
    nmax = nmin + 2 * step;
  }

  let count = Math.round((nmax - nmin) / step) + 1;
  while (count < minTicks) {
    if (nmax <= 0 && nmin < 0) nmin -= step;
    else nmax += step;
    count++;
  }

  const ticks: number[] = [];
  for (let i = 0; i < count; i++) ticks.push(cleanTick(nmin + i * step, step));
  return { min: ticks[0]!, max: ticks[ticks.length - 1]!, step, ticks };
}

/** Revenue: zero is always in the domain; positive and negative stacks are measured separately. */
export function revenueScale(minNeg: number, maxPos: number, currency: string): NiceScale {
  return niceScale(Math.min(0, finite(minNeg)), Math.max(0, finite(maxPos)), { minStep: majorUnit(currency) });
}

/**
 * MRR: a padded nice domain around the data, NOT zero-based. A trend line encodes position, not
 * length, so a non-zero baseline is honest as long as it is labelled (the bottom tick always is).
 *  - Padding is ≥ 15% of the data span AND ≥ 1% of the level, so a $5 wobble on $9K MRR doesn't
 *    fill the plot height and look like a crash.
 *  - Falls back to zero-based when the data already spans most of its own magnitude (min < max/3)
 *    or touches/crosses zero: padding would land near zero anyway, and zero is then the honest base.
 *  - Never shows negative ticks for non-negative data.
 */
export function mrrScale(values: number[], currency: string): NiceScale {
  const minStep = majorUnit(currency);
  const vals = values.map(finite);
  if (vals.length === 0) return niceScale(0, 0, { minStep });
  let lo = vals[0]!;
  let hi = vals[0]!;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo <= 0 || lo < hi / 3) return niceScale(Math.min(0, lo), Math.max(0, hi), { minStep });
  const pad = Math.max((hi - lo) * 0.15, hi * 0.01, minStep);
  const s = niceScale(lo - pad, hi + pad, { minStep });
  return s.min < 0 ? niceScale(0, hi, { minStep }) : s;
}

/** Linear value → y (CSS px, 0 = top). A zero-height domain maps everything to the bottom. */
export function yMapper(scale: NiceScale, height: number = PLOT_HEIGHT): (v: number) => number {
  const span = scale.max - scale.min;
  if (!(span > 0) || !Number.isFinite(span)) return () => height;
  return (v: number) => height - ((finite(v) - scale.min) / span) * height;
}

// ---------- labels ----------

function allDistinct(xs: string[]): boolean {
  return new Set(xs).size === xs.length;
}

/**
 * Axis labels for ticks: compact ("$1.2K", "€800", "¥12K"). When compact rounding would make two
 * ticks read the same (e.g. $1.25M vs $1.3M), retry with 2 fraction digits, then whole amounts.
 */
export function tickLabels(ticks: number[], currency: string): string[] {
  const compact2 = (v: number): string => {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.trim().toUpperCase(),
        notation: 'compact',
        maximumFractionDigits: 2,
      }).format(v / majorUnit(currency));
    } catch {
      return money(v, currency, { whole: true });
    }
  };
  const attempts: Array<(v: number) => string> = [
    (v) => money(v, currency, { compact: true }),
    compact2,
    (v) => money(v, currency, { whole: true }),
    (v) => money(v, currency),
  ];
  let out: string[] = [];
  for (const f of attempts) {
    out = ticks.map((t) => f(finite(t)));
    if (allDistinct(out)) return out;
  }
  return out;
}

const SHORT_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** '2026-10-07' → "Oct 7". Unparseable input is returned as-is. */
export function shortDay(day: string): string {
  const ms = dayMs(day);
  return Number.isFinite(ms) ? SHORT_DAY.format(ms) : day;
}

/** '2026-10-07' → "Oct 7, 2026". */
export function longDay(day: string): string {
  const ms = dayMs(day);
  return Number.isFinite(ms) ? LONG_DAY.format(ms) : day;
}

/** "Oct 7 – Nov 5, 2026", "Dec 20, 2025 – Jan 18, 2026", or one day. */
export function dayRangeLabel(first: string, last: string): string {
  if (first === last) return longDay(first);
  if (first.slice(0, 4) === last.slice(0, 4)) return `${shortDay(first)} – ${longDay(last)}`;
  return `${longDay(first)} – ${longDay(last)}`;
}

/** First, middle and last index (deduplicated) for sparse x labels. */
export function xLabelIndices(n: number): number[] {
  const len = Math.floor(finite(n));
  if (len <= 0) return [];
  return [...new Set([0, Math.floor((len - 1) / 2), len - 1])].sort((x, y) => x - y);
}

export interface XTick {
  label: string;
  /** Horizontal position, 0–100 (% of the plot width). */
  pct: number;
  anchor: 'start' | 'middle' | 'end';
}

/**
 * Positions for the first/middle/last date labels.
 * 'band'  (bars): the first label starts at the first bar's left edge, the last ends at the last
 *                 bar's right edge, the middle is centred on its bar.
 * 'point' (line): points run edge to edge; first label starts at 0%, last ends at 100%.
 */
export function xTicks(days: string[], mode: 'band' | 'point', gapRatio = 0): XTick[] {
  const n = days.length;
  if (n === 0) return [];
  if (n === 1) return [{ label: shortDay(days[0]!), pct: 50, anchor: 'middle' }];
  const g = Math.min(Math.max(finite(gapRatio), 0), 0.9);
  return xLabelIndices(n).map((i) => {
    const anchor: XTick['anchor'] = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    let pct: number;
    if (mode === 'point') pct = (i / (n - 1)) * 100;
    else if (anchor === 'start') pct = ((i + g / 2) / n) * 100;
    else if (anchor === 'end') pct = ((i + 1 - g / 2) / n) * 100;
    else pct = ((i + 0.5) / n) * 100;
    return { label: shortDay(days[i]!), pct: Math.round(pct * 100) / 100, anchor };
  });
}

// ---------- bars & colour ----------

/**
 * Share of each day's band left empty between bars. Scales with the bar count so 7 bars don't turn
 * into slabs and 90 bars keep a ≥ ~1px gap at a 375px viewport (plot ≈ 250px → band ≈ 2.8px):
 * 7 → 0.6, 30 → 0.35, 90 → 0.3.
 */
export function bandGapRatio(n: number): number {
  const len = finite(n);
  if (len <= 0) return 0.5;
  return Math.min(0.6, Math.max(0.3, 0.28 + 2.24 / len));
}

/** fill-opacity steps for series that share a colour (two Stripe accounts): 1 / 0.65 / 0.4 / 0.25. */
export const SAME_COLOR_OPACITY = [1, 0.65, 0.4, 0.25] as const;

export function sameColorOpacities(colors: string[]): number[] {
  const seen = new Map<string, number>();
  return colors.map((c) => {
    const key = c.trim().toLowerCase();
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    return SAME_COLOR_OPACITY[Math.min(k, SAME_COLOR_OPACITY.length - 1)]!;
  });
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(c: unknown): c is string {
  return typeof c === 'string' && HEX.test(c.trim());
}

/** Short deterministic id (FNV-1a) so title/desc/gradient ids are stable and unique per chart content. */
export function chartId(prefix: string, seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}-${h.toString(36)}`;
}
