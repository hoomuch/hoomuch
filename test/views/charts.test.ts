/**
 * Charts: pure scale helpers + the server-rendered parts of RevenueChart / MrrChart.
 * No JSX here (vitest only includes .ts): components render with react-dom/server's
 * renderToStaticMarkup(createElement(...)), the same React the Worker uses.
 *
 * Recharts draws nothing on the server (only its sized wrapper) and paints after hydration, so
 * these tests cover what the server HTML must carry on its own: the role="img" name and
 * description, the messages and notes, the legend, and the complete "Show data" table.
 */

import { createElement, Fragment, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConnectionSummary, MrrDay, RevenueDay } from '../../src/data/types';
import { CHART_HEIGHT, INITIAL_DIMENSION, TICK_MARGIN, yAxisWidth } from '../../src/views/charts/frame';
import { MrrChart, mrrPoints, type MrrChartProps } from '../../src/views/charts/mrr-chart';
import { RevenueChart, revenueModel, type RevenueChartProps } from '../../src/views/charts/revenue-chart';
import {
  bandGapRatio,
  chartId,
  dayRangeLabel,
  finite,
  isHexColor,
  majorUnit,
  mrrScale,
  niceScale,
  PLOT_HEIGHT,
  revenueScale,
  sameColorOpacities,
  shortDay,
  svgNum,
  tickLabels,
  xLabelIndices,
  xTicks,
  yMapper,
  type NiceScale,
} from '../../src/views/charts/scale';
import { FIXTURE_CONNECTIONS, fixtureDashboard } from '../../src/views/fixtures';

// ---------- helpers ----------

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(component, props));
}

const revenue = (props: RevenueChartProps) => render(RevenueChart, props);
const mrr = (props: MrrChartProps) => render(MrrChart, props);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The role="img" element's name and its description text (resolved through aria-describedby). */
function imageOf(html: string): { name: string; desc: string } {
  const img = html.match(/<div role="img" aria-label="([^"]+)" aria-describedby="([^"]+)"/);
  expect(img).not.toBeNull();
  const desc = html.match(new RegExp(`<p id="${img![2]}" class="sr-only">([^<]+)</p>`));
  expect(desc).not.toBeNull();
  return { name: decode(img![1]!), desc: decode(desc![1]!) };
}

function descOf(html: string): string {
  return imageOf(html).desc;
}

/**
 * Every chart, every state: nothing broken, CSP-friendly, always a named and described image
 * around an aria-hidden, fixed-size Recharts box that is still empty on the server.
 */
function expectSafe(html: string): void {
  expect(html).not.toMatch(/NaN|Infinity|undefined|\[object /);
  expect(html).not.toContain('<style'); // ChartContainer's colour <style> would break style-src 'self'
  expect(html).not.toContain('<script');
  const { name, desc } = imageOf(html);
  expect(name.length).toBeGreaterThan(0);
  expect(desc.length).toBeGreaterThan(20);
  // The description sits inside the image (read once, as its description), before the chart box.
  const img = html.indexOf('role="img"');
  const p = html.indexOf('class="sr-only"', img);
  const box = html.indexOf('data-slot="chart"', img);
  expect(p).toBeGreaterThan(img);
  expect(box).toBeGreaterThan(p);
  // Recharts' box: deterministic id, hidden from AT, fixed height equal to the first-render size.
  expect(html).toMatch(/<div data-slot="chart" data-chart="chart-(rev|mrr)-[a-z0-9]+" class="[^"]*\baspect-auto h-48\b[^"]*" aria-hidden="true">/);
  expect(html).toContain(`<div width="${INITIAL_DIMENSION.width}" height="${CHART_HEIGHT}" class="recharts-wrapper"`);
  // Recharts paints after hydration: no plot SVG in the server HTML.
  expect(html).not.toMatch(/<svg[^>]*recharts-surface/);
}

/** Charts with data also carry the accessible table twin, closed but complete in the server HTML. */
function expectTable(html: string): void {
  expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false" data-slot="collapsible-trigger"/);
  expect(html).toContain('<span>Show data<span class="sr-only"> for ');
  expect(html).toContain('lucide-chevron-down');
  expect(html).toMatch(/<div data-closed="" [^>]*hidden="" [^>]*data-slot="collapsible-panel"/);
  const panel = html.slice(html.indexOf('data-slot="collapsible-panel"'));
  expect(panel).toContain('<table');
  expect(panel).toMatch(/<caption id="[^"]+" class="sr-only">[^<]+<\/caption>/);
  expect(panel).toMatch(/<p aria-hidden="true" class="mt-2 text-caption text-muted-foreground">[^<]+<\/p>/);
  expect(panel).toContain('scope="col"');
  expect(panel).toContain('<th scope="row"');
  expect(panel).toMatch(/<time dateTime="\d{4}-\d\d-\d\d">/);
  expect(panel).toContain('tabular-nums');
  expect(panel).toContain('text-right');
}

function captionOf(html: string): string {
  return decode(html.match(/<caption id="[^"]+" class="sr-only">([^<]+)<\/caption>/)?.[1] ?? '');
}

/** Visible text of the "Show data" trigger, sr-only suffix included. */
function triggerText(html: string): string {
  const m = html.match(/data-slot="collapsible-trigger"[^>]*>([\s\S]*?)<\/button>/);
  return decode((m?.[1] ?? '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ''));
}

function isOneTwoFive(step: number): boolean {
  const mag = 10 ** Math.floor(Math.log10(step));
  return [1, 2, 5].includes(Math.round(step / mag));
}

function expectNice(s: NiceScale, lo: number, hi: number): void {
  for (const t of s.ticks) expect(Number.isFinite(t)).toBe(true);
  expect(s.min).toBe(s.ticks[0]);
  expect(s.max).toBe(s.ticks[s.ticks.length - 1]);
  expect(s.min).toBeLessThanOrEqual(Math.min(lo, hi));
  expect(s.max).toBeGreaterThanOrEqual(Math.max(lo, hi));
  expect(s.ticks.length).toBeGreaterThanOrEqual(3);
  const crossesZero = Math.min(lo, hi) < 0 && Math.max(lo, hi) > 0;
  expect(s.ticks.length).toBeLessThanOrEqual(crossesZero ? 6 : 5);
  expect(isOneTwoFive(s.step)).toBe(true);
  for (let i = 1; i < s.ticks.length; i++) expect(s.ticks[i]! - s.ticks[i - 1]!).toBeCloseTo(s.step, 6);
  if (s.min <= 0 && s.max >= 0) expect(s.ticks).toContain(0);
  expect(s.ticks.some((t) => Object.is(t, -0))).toBe(false);
}

const conn = (id: string, name: string, color: string, provider: ConnectionSummary['provider'] = 'stripe'): ConnectionSummary => ({
  id,
  name,
  provider,
  color,
  dotClass: 'bg-[#635BFF]',
  status: 'ok',
  lastSyncedAt: null,
  lastError: null,
  testMode: false,
});

const days = (n: number, end = '2026-11-05'): string[] => {
  const out: string[] = [];
  const endMs = Date.parse(`${end}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) out.push(new Date(endMs - i * 86_400_000).toISOString().slice(0, 10));
  return out;
};

// ---------- scale.ts ----------

describe('niceScale', () => {
  it('picks the tightest 1-2-5 step with 3–5 gridlines', () => {
    const s = niceScale(0, 158_000, { minStep: 100 });
    expect(s.ticks).toEqual([0, 50_000, 100_000, 150_000, 200_000]);
    expectNice(s, 0, 158_000);
    expect(niceScale(0, 48_339, { minStep: 100 }).ticks).toEqual([0, 20_000, 40_000, 60_000]);
  });

  it('handles a negative minimum: zero is a tick, one extra tick is allowed for the baseline', () => {
    const s = niceScale(-3_000, 12_000, { minStep: 100 });
    expectNice(s, -3_000, 12_000);
    expect(s.ticks).toContain(0);
    // A small refund next to big days doesn't waste a third of the plot on the negative side.
    const r = niceScale(-9_000, 65_000, { minStep: 100 });
    expect(r.ticks).toEqual([-20_000, 0, 20_000, 40_000, 60_000, 80_000]);
    // All-negative data extends downwards.
    const n = niceScale(-12_345, 0, { minStep: 100 });
    expectNice(n, -12_345, 0);
    expect(n.max).toBe(0);
  });

  it('turns all-zero data into a safe, non-degenerate domain', () => {
    const s = niceScale(0, 0, { minStep: 100 });
    expect(s.ticks).toEqual([0, 100, 200]);
    expect(s.max - s.min).toBeGreaterThan(0);
    expect(revenueScale(0, 0, 'USD').ticks).toEqual([0, 100, 200]);
    expect(revenueScale(0, 0, 'JPY').ticks).toEqual([0, 1, 2]);
  });

  it('never goes below one major unit on tiny ranges (no "$0.01" ticks)', () => {
    expect(niceScale(0, 3, { minStep: 100 }).ticks).toEqual([0, 100, 200]);
    expect(niceScale(0, 0.4).ticks).toEqual([0, 1, 2]);
    const s = niceScale(909_000, 909_050, { minStep: 100 });
    expectNice(s, 909_000, 909_050);
    expect(s.step).toBeGreaterThanOrEqual(100);
  });

  it('is safe with NaN, Infinity, reversed and single-value input', () => {
    for (const [lo, hi] of [
      [Number.NaN, Number.NaN],
      [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
      [500, -500],
      [7_777, 7_777],
      [-42, -42],
    ] as const) {
      const s = niceScale(lo, hi, { minStep: 100 });
      for (const t of s.ticks) expect(Number.isFinite(t)).toBe(true);
      expect(s.max).toBeGreaterThan(s.min);
    }
    expectNice(niceScale(500, -500, { minStep: 100 }), -500, 500);
    expect(niceScale(7_777, 7_777, { minStep: 100 }).min).toBe(0);
  });

  it('holds its invariants across many random ranges', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 500; i++) {
      const mag = 10 ** Math.floor(rand() * 9);
      const a = Math.round((rand() - 0.3) * mag);
      const b = Math.round((rand() - 0.1) * mag);
      const lo = Math.min(a, b, 0);
      const hi = Math.max(a, b, 0);
      expectNice(niceScale(lo, hi, { minStep: 100 }), lo, hi);
      expectNice(niceScale(lo, hi, { minStep: 1 }), lo, hi);
    }
  });

  it('handles JPY (exponent 0) with yen-sized steps', () => {
    expect(majorUnit('JPY')).toBe(1);
    expect(majorUnit('USD')).toBe(100);
    const s = revenueScale(0, 123_456, 'JPY');
    expect(s.ticks).toEqual([0, 50_000, 100_000, 150_000]);
    expect(tickLabels(s.ticks, 'JPY')).toEqual(['¥0', '¥50K', '¥100K', '¥150K']);
    expect(revenueScale(0, 7, 'JPY').ticks).toEqual([0, 2, 4, 6, 8]);
  });
});

describe('mrrScale', () => {
  it('pads a nice domain around the data instead of starting at zero', () => {
    const vals = [820_000, 860_000, 909_000];
    const s = mrrScale(vals, 'USD');
    expectNice(s, 820_000, 909_000);
    expect(s.min).toBeGreaterThan(0);
    expect(s.min).toBeLessThan(820_000);
    expect(s.max).toBeGreaterThan(909_000);
  });

  it('keeps a small wobble small (span is at least ~2% of the level)', () => {
    const s = mrrScale([909_000, 909_500], 'USD');
    expect(s.max - s.min).toBeGreaterThanOrEqual(909_500 * 0.02);
    expect(new Set(tickLabels(s.ticks, 'USD')).size).toBe(s.ticks.length);
  });

  it('falls back to zero-based when the data spans most of its magnitude, and never goes negative', () => {
    expect(mrrScale([10_000, 900_000], 'USD').min).toBe(0);
    expect(mrrScale([0, 0], 'USD').ticks).toEqual([0, 100, 200]);
    expect(mrrScale([], 'USD').min).toBe(0);
    for (const v of [100, 150, 999, 25_000]) expect(mrrScale([v], 'USD').min).toBeGreaterThanOrEqual(0);
    const one = mrrScale([909_000], 'USD');
    expect(one.min).toBeLessThan(909_000);
    expect(one.max).toBeGreaterThan(909_000);
  });
});

describe('labels', () => {
  it('formats compact money labels', () => {
    expect(tickLabels([0, 50_000, 100_000, 150_000], 'USD')).toEqual(['$0', '$500', '$1K', '$1.5K']);
    expect(tickLabels([0, 120_000], 'USD')).toEqual(['$0', '$1.2K']);
    expect(tickLabels([0, 80_000], 'EUR')).toEqual(['€0', '€800']);
    expect(tickLabels([0, 12_000], 'JPY')).toEqual(['¥0', '¥12K']);
    expect(tickLabels([-50_000, 0, 50_000], 'USD')).toEqual(['-$500', '$0', '$500']);
  });

  it('falls back when compact rounding would make two ticks read the same', () => {
    const two = tickLabels([125_000_000, 130_000_000], 'USD');
    expect(two).toEqual(['$1.25M', '$1.3M']);
    const whole = tickLabels([100_000_000, 100_010_000], 'USD');
    expect(new Set(whole).size).toBe(2);
    expect(whole[1]).toBe('$1,000,100');
  });

  it('formats days and ranges in UTC', () => {
    expect(shortDay('2026-10-07')).toBe('Oct 7');
    expect(shortDay('not-a-day')).toBe('not-a-day');
    expect(dayRangeLabel('2026-10-07', '2026-11-05')).toBe('Oct 7 – Nov 5, 2026');
    expect(dayRangeLabel('2025-12-20', '2026-01-18')).toBe('Dec 20, 2025 – Jan 18, 2026');
    expect(dayRangeLabel('2026-11-05', '2026-11-05')).toBe('Nov 5, 2026');
  });

  it('places sparse x labels at first, middle and last', () => {
    expect(xLabelIndices(0)).toEqual([]);
    expect(xLabelIndices(1)).toEqual([0]);
    expect(xLabelIndices(2)).toEqual([0, 1]);
    expect(xLabelIndices(7)).toEqual([0, 3, 6]);
    expect(xLabelIndices(30)).toEqual([0, 14, 29]);
    expect(xLabelIndices(90)).toEqual([0, 44, 89]);

    const band = xTicks(days(7), 'band', 0.6);
    expect(band.map((t) => t.anchor)).toEqual(['start', 'middle', 'end']);
    expect(band[0]!.pct).toBeCloseTo((0.3 / 7) * 100, 1); // first bar's left edge
    expect(band[1]!.pct).toBe(50); // middle bar's centre
    expect(band[2]!.pct).toBeCloseTo((6.7 / 7) * 100, 1); // last bar's right edge
    expect(band.map((t) => t.label)).toEqual(['Oct 30', 'Nov 2', 'Nov 5']);

    const point = xTicks(days(30), 'point');
    expect(point.map((t) => t.pct)).toEqual([0, 48.28, 100]);
    expect(xTicks(['2026-11-05'], 'point')).toEqual([{ label: 'Nov 5', pct: 50, anchor: 'middle' }]);
    expect(xTicks([], 'band')).toEqual([]);
  });
});

describe('geometry & colour helpers', () => {
  it('scales the bar gap with the number of days', () => {
    expect(bandGapRatio(7)).toBeCloseTo(0.6, 5);
    expect(bandGapRatio(30)).toBeGreaterThan(bandGapRatio(90));
    expect(bandGapRatio(90)).toBeGreaterThanOrEqual(0.3);
    for (const n of [0, 1, 2, 7, 14, 30, 90, 365, Number.NaN]) {
      const g = bandGapRatio(n);
      expect(g).toBeGreaterThanOrEqual(0.3);
      expect(g).toBeLessThanOrEqual(0.6);
    }
  });

  it('steps opacity for series that share a colour', () => {
    expect(sameColorOpacities(['#635BFF', '#F2545B', '#635bff', '#635BFF', '#635BFF', '#635BFF'])).toEqual([
      1, 1, 0.65, 0.4, 0.25, 0.25,
    ]);
  });

  it('sanitises numbers and colours for attributes', () => {
    expect(svgNum(Number.NaN)).toBe('0');
    expect(svgNum(Number.POSITIVE_INFINITY)).toBe('0');
    expect(svgNum(-0)).toBe('0');
    expect(svgNum(1 / 3)).toBe('0.33');
    expect(finite('12' as unknown)).toBe(0);
    expect(isHexColor('#635BFF')).toBe(true);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('#635BFF" onload="x')).toBe(false);
    expect(yMapper({ min: 0, max: 0, step: 0, ticks: [0] })(5)).toBe(PLOT_HEIGHT);
    expect(yMapper(niceScale(0, 200))(200)).toBe(0);
    expect(chartId('rev', 'a')).toBe(chartId('rev', 'a'));
    expect(chartId('rev', 'a')).not.toBe(chartId('rev', 'b'));
  });
});

// ---------- frame ----------

describe('chart frame', () => {
  it('keeps the plot at PLOT_HEIGHT inside a fixed box that matches the first render', () => {
    expect(CHART_HEIGHT).toBe(192); // the literal h-48 on ChartContainer
    expect(CHART_HEIGHT).toBeGreaterThan(PLOT_HEIGHT);
    expect(INITIAL_DIMENSION.height).toBe(CHART_HEIGHT);
  });

  it('sizes the y axis from its labels, deterministically', () => {
    const narrow = yAxisWidth(['$0', '$200']);
    const wide = yAxisWidth(['$1,000,100', '$1,000,000']);
    expect(narrow).toBeGreaterThan(TICK_MARGIN);
    expect(wide).toBeGreaterThan(narrow);
    expect(yAxisWidth(['-$200', '$0', '$600'])).toBeGreaterThan(yAxisWidth(['$0', '$600']));
    expect(yAxisWidth([])).toBe(TICK_MARGIN + 2);
    expect(yAxisWidth(['€8K'])).toBe(yAxisWidth(['€8K']));
  });
});

// ---------- RevenueChart ----------

describe('RevenueChart', () => {
  for (const range of [7, 30, 90] as const) {
    it(`server-renders ${range} days: description, legend and the full table`, () => {
      const d = fixtureDashboard(range, 'full');
      const html = revenue({ series: d.revenueSeries, connections: d.breakdown, currency: d.currency });
      expectSafe(html);
      expectTable(html);
      expect(imageOf(html).name).toBe('Daily revenue');
      // One row per day + the totals row; Date + 3 connections + Total.
      expect(count(html, 'scope="row"')).toBe(range + 1);
      expect(count(html, 'scope="col"')).toBe(5);
      expect(html).toContain('data-slot="table-footer"');
      // Legend as server HTML, swatches in the provider colours.
      expect(html).toContain('<ul aria-label="Legend"');
      for (const c of d.breakdown) {
        expect(html).toContain(`<rect width="10" height="10" rx="2" fill="${c.color}">`);
        expect(html).toContain(`<span class="truncate">${c.name}</span>`);
      }
      // Legend comes before the chart.
      expect(html.indexOf('aria-label="Legend"')).toBeLessThan(html.indexOf('role="img"'));
      const desc = descOf(html);
      expect(desc).toContain(`(${range} days)`);
      expect(desc).toContain(`stacked by connection: ${d.breakdown.map((c) => c.name).join(', ')}.`);
      expect(desc).toMatch(/Total \$[\d,]+\.\d\d\./);
      expect(desc).toContain('Highest day');
      expect(desc).toContain('latest Nov 5');
      expect(captionOf(html)).toMatch(/^Daily revenue by connection, .+, in USD\.$/);
      // The grand total in the footer matches the description's total.
      const total = desc.match(/Total (\$[\d,]+\.\d\d)\./)![1]!;
      const foot = html.slice(html.indexOf('data-slot="table-footer"'));
      expect(foot).toContain('>Total</th>');
      expect(foot).toContain(`>${total}</td>`);
    });
  }

  it('renders a single connection without a legend', () => {
    const d = fixtureDashboard(30, 'single');
    const html = revenue({ series: d.revenueSeries, connections: d.breakdown, currency: 'USD', title: 'Revenue' });
    expectSafe(html);
    expectTable(html);
    expect(html).not.toContain('aria-label="Legend"');
    expect(imageOf(html).name).toBe('Revenue');
    expect(triggerText(html)).toBe('Show data for Revenue');
  });

  it('shows only a calm message for an all-zero series: no legend, no table', () => {
    const d = fixtureDashboard(30, 'empty');
    const html = revenue({ series: d.revenueSeries, connections: d.breakdown, currency: 'USD' });
    expectSafe(html);
    expect(html).toContain(
      '<p aria-hidden="true" class="pointer-events-none absolute inset-x-0 top-2 bottom-6 flex items-center justify-center px-4 text-center text-body text-muted-foreground">No revenue in this period yet.</p>',
    );
    expect(descOf(html)).toContain('No revenue in this period yet.');
    expect(html).not.toContain('aria-label="Legend"');
    expect(html).not.toContain('collapsible');
    expect(html).not.toContain('<table');
    // The message is part of the image (presentational inside role="img").
    expect(html.indexOf('No revenue in this period yet.</p>')).toBeGreaterThan(html.indexOf('role="img"'));
    // The flat frame's scale: only the $0 baseline label is shown.
    expect(tickLabels([0], 'USD')).toEqual(['$0']);
    expect(revenueModel(d.revenueSeries, d.breakdown).allZero).toBe(true);

    const none = revenue({ series: [], connections: [], currency: 'USD' });
    expectSafe(none);
    expect(none).toContain('No revenue in this period yet.');
    expect(descOf(none)).toBe('No revenue data for this period.');
  });

  it('stacks refund-heavy days below zero, positive and negative parts separately', () => {
    const [a, b] = [conn('a', 'Acme', '#635BFF'), conn('b', 'Habit', '#F2545B', 'revenuecat')];
    const series: RevenueDay[] = days(7).map((day, i) =>
      i === 3
        ? { day, total: -24_000, byConnection: { a: -30_000, b: 6_000 } }
        : { day, total: 50_000, byConnection: { a: 30_000, b: 20_000 } },
    );
    const model = revenueModel(series, [a, b]);
    expect(model.rows[3]).toMatchObject({ pos: 6_000, neg: -30_000, total: -24_000 });
    const scale = revenueScale(-30_000, 50_000, 'USD');
    expect(scale.min).toBeLessThan(0);
    expect(scale.ticks).toContain(0);
    expect(tickLabels(scale.ticks, 'USD').some((l) => l.startsWith('-$'))).toBe(true);

    const html = revenue({ series, connections: [a, b], currency: 'USD' });
    expectSafe(html);
    expectTable(html);
    expect(descOf(html)).toContain('1 day had more refunds than charges and goes below zero.');
    expect(html).toContain('>-$300.00</td>');
    expect(html).toContain('>-$240.00</td>');
  });

  it('separates connections that share a provider colour', () => {
    const d = fixtureDashboard(30, 'full');
    const sandbox = FIXTURE_CONNECTIONS[3]!; // second Stripe connection, same #635BFF
    const series = d.revenueSeries.map((r) => ({ ...r, total: r.total + 4_000, byConnection: { ...r.byConnection, [sandbox.id]: 4_000 } }));
    const model = revenueModel(series, FIXTURE_CONNECTIONS);
    expect(model.series.map((s) => s.opacity)).toEqual([1, 1, 1, 0.65]);

    const html = revenue({ series, connections: FIXTURE_CONNECTIONS, currency: 'USD' });
    expectSafe(html);
    expect(html).toContain('<rect width="10" height="10" rx="2" fill="#635BFF" fill-opacity="0.65">'); // legend swatch
    expect(html).toContain('<span class="truncate">Stripe sandbox</span>');
    expect(count(html, 'scope="col"')).toBe(6);
  });

  it('folds unknown connection ids (and unexplained totals) into one "Other" series', () => {
    const a = conn('a', 'Acme', '#635BFF');
    const series: RevenueDay[] = days(7).map((day, i): RevenueDay => {
      const byConnection: Record<string, number> = i === 2 ? { a: 10_000, ghost: 1_500, phantom: 1_000 } : { a: 10_000 };
      return { day, total: 10_000 + (i === 2 ? 2_500 : 0) + (i === 4 ? 700 : 0), byConnection };
    });
    const model = revenueModel(series, [a]);
    expect(model.series.map((s) => s.name)).toEqual(['Acme', 'Other']);
    expect(model.series[1]).toMatchObject({ color: null, neutralClass: 'fill-faint' });
    expect(model.rows[2]!.values).toEqual([10_000, 2_500]);
    expect(model.rows[4]!.values).toEqual([10_000, 700]); // total − Σ byConnection
    for (const r of model.rows) expect(r.values.reduce((s, v) => s + v, 0)).toBe(r.total);

    const html = revenue({ series, connections: [a], currency: 'USD' });
    expectSafe(html);
    expectTable(html);
    expect(html).toContain('<span class="truncate">Other</span>');
    expect(html).toContain('<rect width="10" height="10" rx="2" class="fill-faint">');
    expect(html).toMatch(/scope="col">Other<\/th>/);
    expect(html).not.toContain('ghost');
    // Zero amounts are faint, real ones aren't.
    expect(html).toMatch(/<td class="[^"]*\btext-right tabular-nums text-faint"[^>]*>\$0\.00<\/td>/);
    expect(html).toMatch(/<td class="[^"]*\btext-right tabular-nums"[^>]*>\$25\.00<\/td>/);
  });

  it('falls back to the neutral series colour for a malformed one', () => {
    const bad = conn('x', 'Weird', 'red" onload="alert(1)');
    const good = conn('y', 'Fine', '#F2545B');
    const series: RevenueDay[] = days(7).map((day) => ({ day, total: 2_000, byConnection: { x: 1_000, y: 1_000 } }));
    expect(revenueModel(series, [bad, good]).series[0]).toMatchObject({ color: null, opacity: 1, neutralClass: 'fill-series-neutral' });
    const html = revenue({ series, connections: [bad, good], currency: 'USD' });
    expectSafe(html);
    expect(html).not.toContain('onload');
    expect(html).toContain('<rect width="10" height="10" rx="2" class="fill-series-neutral">');
  });

  it('survives garbage amounts without leaking NaN', () => {
    const series = days(30).map((day, i) => ({
      day,
      total: i === 5 ? Number.NaN : 1_000,
      byConnection: { a: i === 6 ? Number.POSITIVE_INFINITY : 1_000 },
    }));
    const html = revenue({ series, connections: [conn('a', 'Acme', '#635BFF')], currency: 'EUR' });
    expectSafe(html);
    expectTable(html);
    expect(captionOf(html)).toContain('in EUR.');
  });
});

// ---------- MrrChart ----------

describe('MrrChart', () => {
  const windowDays = days(30);

  it('0 points: a calm empty message, no note, no table', () => {
    const html = mrr({ series: [], windowDays, currency: 'USD' });
    expectSafe(html);
    expect(html).toContain('>MRR history appears after the first sync.</p>');
    expect(descOf(html)).toContain('No snapshots yet');
    expect(html).not.toContain('collapsible');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('text-caption text-muted-foreground">The trend');

    const nothing = mrr({ series: [], windowDays: [], currency: 'USD' });
    expectSafe(nothing);
    expect(descOf(nothing)).toContain('MRR, this period.');
  });

  it('1 point: a dot, a note and a one-row table', () => {
    const series: MrrDay[] = [{ day: '2026-11-05', total: 909_000 }];
    const html = mrr({ series, windowDays, currency: 'USD' });
    expectSafe(html);
    expectTable(html);
    expect(html).toContain('<p class="mt-2 text-caption text-muted-foreground">The trend fills in as daily snapshots arrive.</p>');
    expect(html).not.toContain('History starts');
    expect(count(html, 'scope="row"')).toBe(1);
    expect(html).toContain('>$9,090.00</td>');
    expect(descOf(html)).toContain('One snapshot so far: $9,090.00 on Nov 5.');
    // Sits at the right end of the window.
    expect(mrrPoints(series, windowDays).points[0]!.i).toBe(windowDays.length - 1);
  });

  for (const range of [7, 30, 90] as const) {
    it(`2+ points: description, table and no note for a full history (${range} days)`, () => {
      const d = fixtureDashboard(range, 'full');
      const html = mrr({ series: d.mrrSeries, windowDays: d.revenueSeries.map((r) => r.day), currency: 'USD' });
      expectSafe(html);
      expectTable(html);
      expect(imageOf(html).name).toBe('MRR trend');
      expect(count(html, 'scope="row"')).toBe(d.mrrSeries.length);
      expect(count(html, 'scope="col"')).toBe(2);
      expect(html).not.toContain('text-caption text-muted-foreground">History starts');
      expect(html).not.toContain('Days without a snapshot');
      const desc = descOf(html);
      expect(desc).toContain(`(${range} days)`);
      expect(desc).toContain('A snapshot every day.');
      expect(desc).toMatch(/Latest \$[\d,]+\.\d\d on Nov 5, up \$[\d,.]+ \(\+[\d.]+%\)/);
      // Padded, labelled, non-zero baseline — and the description says so.
      const scale = mrrScale(
        d.mrrSeries.map((p) => p.total),
        'USD',
      );
      expect(scale.min).toBeGreaterThan(0);
      expect(desc).toContain('not zero');
      expect(captionOf(html)).toMatch(/^MRR by day, .+, in USD\.$/);
    });
  }

  it('sparse history sits at the right end of the window, with a note', () => {
    const d = fixtureDashboard(30, 'sparse');
    const win = d.revenueSeries.map((r) => r.day);
    const { points } = mrrPoints(d.mrrSeries, win);
    expect(points.map((p) => p.i)).toEqual([27, 28, 29]);
    const html = mrr({ series: d.mrrSeries, windowDays: win, currency: 'USD' });
    expectSafe(html);
    expectTable(html);
    expect(html).toContain('<p class="mt-2 text-caption text-muted-foreground">History starts Nov 3.</p>');
    expect(captionOf(html)).toContain('Days without a snapshot are left out.');
    expect(count(html, 'scope="row"')).toBe(3);
    const desc = descOf(html);
    expect(desc).toContain('Snapshots on 3 of 30 days, starting Nov 3.');
    // The description still spans the whole window.
    expect(desc).toContain('MRR, Oct 7 – Nov 5, 2026 (30 days).');
  });

  it('dedupes days, drops points outside the window, and falls back to series days', () => {
    const series: MrrDay[] = [
      { day: '2026-11-03', total: 100 },
      { day: '2026-11-03', total: 200 },
      { day: '2020-01-01', total: 999 },
      { day: '2026-11-05', total: 300 },
    ];
    expect(mrrPoints(series, days(7)).points.map((p) => [p.i, p.value])).toEqual([
      [4, 200],
      [6, 300],
    ]);
    const fallback = mrrPoints([{ day: '2026-11-05', total: 1 }], []);
    expect(fallback.domain).toEqual(['2026-11-05']);
  });

  it('uses a zero baseline when the data spans most of its magnitude', () => {
    const series: MrrDay[] = days(7).map((day, i) => ({ day, total: (i + 1) * 100_000 }));
    expect(mrrScale(series.map((s) => s.total), 'EUR').min).toBe(0);
    const html = mrr({ series, windowDays: days(7), currency: 'EUR' });
    expectSafe(html);
    expect(descOf(html)).toContain('Vertical axis from €0');
    expect(html).toContain('>€7,000.00</td>');
  });

  it('formats JPY without minor digits, and keeps a $0 level visible', () => {
    const series: MrrDay[] = days(7).map((day, i) => ({ day, total: 1_200_000 + i * 15_000 }));
    const html = mrr({ series, windowDays: days(7), currency: 'JPY', title: 'MRR (JPY)' });
    expectSafe(html);
    expect(html).toContain('>¥1,290,000</td>');
    expect(imageOf(html).name).toBe('MRR (JPY)');
    expect(captionOf(html)).toContain('in JPY.');

    // MRR is a level, not a flow: a $0 day is a real value, not muted like a zero revenue cell.
    const zero = mrr({ series: [{ day: '2026-11-04', total: 0 }, { day: '2026-11-05', total: 500 }], windowDays: days(7), currency: 'USD' });
    expect(zero).toMatch(/<td class="[^"]*\btext-right tabular-nums"[^>]*>\$0\.00<\/td>/);
  });
});

describe('chart accessibility and hydration', () => {
  const d = fixtureDashboard(30, 'full');
  const revProps: RevenueChartProps = { series: d.revenueSeries, connections: d.breakdown, currency: d.currency };
  const mrrProps: MrrChartProps = { series: d.mrrSeries, windowDays: d.revenueSeries.map((x) => x.day), currency: d.currency };

  it('names each "Show data" trigger after its chart and makes the table scroller a labelled stop', () => {
    const rev = revenue(revProps);
    const m = mrr(mrrProps);
    expect(triggerText(rev)).toBe('Show data for Daily revenue');
    expect(triggerText(m)).toBe('Show data for MRR trend');
    for (const h of [rev, m]) {
      const cap = h.match(/<caption id="([^"]+)"/);
      expect(cap).not.toBeNull();
      expect(h).toMatch(new RegExp(`role="region" aria-labelledby="${cap![1]}" tabindex="0"`));
      // The Recharts box (tooltips included) stays out of the accessibility tree; the image is
      // named and described by server HTML instead.
      expect(h).toMatch(/data-slot="chart"[^>]*aria-hidden="true"/);
      expect(h).not.toContain('tabindex="0" class="recharts');
    }
  });

  it('gives two charts on one page unique ids', () => {
    const page = renderToStaticMarkup(createElement(Fragment, null, createElement(RevenueChart, revProps), createElement(MrrChart, mrrProps)));
    const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    expect(ids.length).toBeGreaterThan(4);
    expect(new Set(ids).size).toBe(ids.length);
    const charts = [...page.matchAll(/data-chart="([^"]+)"/g)].map((x) => x[1]);
    expect(charts).toHaveLength(2);
    expect(new Set(charts).size).toBe(2);
  });

  it('renders the same markup every time (hydration-safe: no clocks, no random ids)', () => {
    expect(revenue(revProps)).toBe(revenue(revProps));
    expect(mrr(mrrProps)).toBe(mrr(mrrProps));
    // The chart id comes from the content, not from useId, so it is stable across renders and pages.
    const id = chartId('rev', 'x');
    expect(id).toMatch(/^rev-[a-z0-9]+$/);
    expect(revenue(revProps)).toMatch(/data-chart="chart-rev-[a-z0-9]+"/);
    expect(revenue({ ...revProps, title: 'Other title' }).match(/data-chart="([^"]+)"/)![1]).not.toBe(
      revenue(revProps).match(/data-chart="([^"]+)"/)![1],
    );
  });
});
