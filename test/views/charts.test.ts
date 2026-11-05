/**
 * Charts: pure scale helpers + server-rendered RevenueChart / MrrChart markup.
 * No JSX here (vitest only includes .ts): components are called as functions and stringified.
 */

import { describe, expect, it } from 'vitest';
import type { ConnectionSummary, MrrDay, RevenueDay } from '../../src/data/types';
import { MrrChart, mrrPoints } from '../../src/views/charts/mrr-chart';
import { RevenueChart, revenueModel } from '../../src/views/charts/revenue-chart';
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

async function render(node: unknown): Promise<string> {
  return String(await (node as { toString(): string | Promise<string> }).toString());
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every chart, every state: nothing broken, nothing CSP-hostile, always a named image. */
function expectSafe(html: string): void {
  expect(html).not.toMatch(/NaN|Infinity|undefined|\[object /);
  expect(html).not.toContain(' style=');
  expect(html).not.toContain('<script');
  expect(html).toContain('role="img"');
  const title = html.match(/<title id="([^"]+)">[^<]+<\/title>/);
  const desc = html.match(/<desc id="([^"]+)">[^<]+<\/desc>/);
  expect(title).not.toBeNull();
  expect(desc).not.toBeNull();
  expect(html).toContain(`aria-labelledby="${title![1]}"`);
  expect(html).toContain(`aria-describedby="${desc![1]}"`);
  expect(html).toContain('viewBox="0 0 ');
  expect(html).toContain('preserveAspectRatio="none"');
}

/** Charts with data also carry the accessible table twin. */
function expectTable(html: string): void {
  expect(html).toContain('<details');
  expect(html).toContain('<summary');
  expect(html).toContain('Show data');
  expect(html).toMatch(/<caption[^>]*>[^<]+<\/caption>/);
  expect(html).toContain('<th scope="col"');
  expect(html).toContain('<th scope="row"');
  expect(html).toContain('tabular-nums');
  expect(html).toContain('text-right');
}

function descOf(html: string): string {
  return html.match(/<desc id="[^"]+">([^<]+)<\/desc>/)?.[1] ?? '';
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

// ---------- RevenueChart ----------

describe('RevenueChart', () => {
  for (const range of [7, 30, 90] as const) {
    it(`renders ${range} days of stacked bars`, async () => {
      const d = fixtureDashboard(range, 'full');
      const html = await render(RevenueChart({ series: d.revenueSeries, connections: d.breakdown, currency: d.currency }));
      expectSafe(html);
      expectTable(html);
      // One hover/tooltip column per day, one row per day + the totals row.
      expect(count(html, 'hover:fill-base-content/5')).toBe(range);
      expect(count(html, 'scope="row"')).toBe(range + 1);
      // Date + 3 connections + Total.
      expect(count(html, 'scope="col"')).toBe(5);
      expect(html).toContain('aria-label="Legend"');
      expect(count(html, '<text ')).toBe(3);
      expect(html).toContain(`viewBox="0 0 ${range * 10} ${PLOT_HEIGHT}"`);
      expect(html).toContain('vector-effect="non-scaling-stroke"');
      for (const c of d.breakdown) expect(html).toContain(`fill="${c.color}"`);
      const desc = descOf(html);
      expect(desc).toContain(`(${range} days)`);
      expect(desc).toMatch(/Total \$[\d,]+\.\d\d\./);
      expect(desc).toContain('Highest day');
      expect(desc).toContain('latest Nov 5');
      // Decorative labels are hidden from AT.
      expect(html).toMatch(/<div aria-hidden="true" class="flex h-40 flex-col/);
      expect(html).toMatch(/<svg aria-hidden="true" width="100%" height="20"/);
    });
  }

  it('renders a single connection without a legend', async () => {
    const d = fixtureDashboard(30, 'single');
    const html = await render(RevenueChart({ series: d.revenueSeries, connections: d.breakdown, currency: 'USD', title: 'Revenue' }));
    expectSafe(html);
    expect(html).not.toContain('aria-label="Legend"');
    expect(html).toContain('>Revenue</title>');
  });

  it('shows a flat baseline and a calm message for an all-zero series', async () => {
    const d = fixtureDashboard(30, 'empty');
    const html = await render(RevenueChart({ series: d.revenueSeries, connections: d.breakdown, currency: 'USD' }));
    expectSafe(html);
    expect(html).toContain('No revenue in this period yet.');
    expect(descOf(html)).toContain('No revenue in this period yet.');
    expect(html).toContain('$0');
    expect(html).not.toContain('stroke-base-300'); // no gridlines for a fake scale
    expect(html).toContain('stroke-base-content/40'); // the baseline
    expect(html).not.toContain('<rect x');
    expect(html).not.toContain('<details');

    const none = await render(RevenueChart({ series: [], connections: [], currency: 'USD' }));
    expectSafe(none);
    expect(none).toContain('No revenue in this period yet.');
  });

  it('draws refund-heavy days below a visible zero baseline, stacking +/- separately', async () => {
    const [a, b] = [conn('a', 'Acme', '#635BFF'), conn('b', 'Habit', '#F2545B', 'revenuecat')];
    const series: RevenueDay[] = days(7).map((day, i) =>
      i === 3
        ? { day, total: -24_000, byConnection: { a: -30_000, b: 6_000 } }
        : { day, total: 50_000, byConnection: { a: 30_000, b: 20_000 } },
    );
    const model = revenueModel(series, [a, b]);
    expect(model.rows[3]).toMatchObject({ pos: 6_000, neg: -30_000, total: -24_000 });

    const html = await render(RevenueChart({ series, connections: [a, b], currency: 'USD' }));
    expectSafe(html);
    expect(html).toContain('-$'); // a negative axis label
    const scale = revenueScale(-30_000, 50_000, 'USD');
    expect(scale.min).toBeLessThan(0);
    const y0 = svgNum(yMapper(scale)(0));
    expect(html).toContain(`class="stroke-base-content/40"`);
    expect(html).toContain(`y1="${y0}" y2="${y0}" class="stroke-base-content/40"`);
    // The negative bar starts at the baseline and goes down; the positive part sits on top of it.
    expect(html).toMatch(new RegExp(`<rect x="[\\d.]+" y="${y0.replace('.', '\\.')}" width="[\\d.]+" height="[\\d.]+" fill="#635BFF"`));
    expect(descOf(html)).toContain('1 day had more refunds than charges');
    expect(html).toContain('-$240.00');
  });

  it('separates connections that share a provider colour', async () => {
    const d = fixtureDashboard(30, 'full');
    const sandbox = FIXTURE_CONNECTIONS[3]!; // second Stripe connection, same #635BFF
    const series = d.revenueSeries.map((r) => ({ ...r, total: r.total + 4_000, byConnection: { ...r.byConnection, [sandbox.id]: 4_000 } }));
    const model = revenueModel(series, FIXTURE_CONNECTIONS);
    expect(model.series.map((s) => s.opacity)).toEqual([1, 1, 1, 0.65]);

    const html = await render(RevenueChart({ series, connections: FIXTURE_CONNECTIONS, currency: 'USD' }));
    expectSafe(html);
    expect(html).toContain('fill="#635BFF" fill-opacity="0.65"'); // bars and the legend swatch
    expect(html).toContain('>Stripe sandbox</span>');
    expect(count(html, 'scope="col"')).toBe(6);
    // Stacked segments are separated by a 1px gap, never by a drawn border.
    expect(html).not.toMatch(/<rect[^>]+stroke=/);
  });

  it('folds unknown connection ids (and unexplained totals) into one neutral "Other" segment', async () => {
    const a = conn('a', 'Acme', '#635BFF');
    const series: RevenueDay[] = days(7).map((day, i): RevenueDay => {
      const byConnection: Record<string, number> = i === 2 ? { a: 10_000, ghost: 1_500, phantom: 1_000 } : { a: 10_000 };
      return { day, total: 10_000 + (i === 2 ? 2_500 : 0) + (i === 4 ? 700 : 0), byConnection };
    });
    const model = revenueModel(series, [a]);
    expect(model.series.map((s) => s.name)).toEqual(['Acme', 'Other']);
    expect(model.rows[2]!.values).toEqual([10_000, 2_500]);
    expect(model.rows[4]!.values).toEqual([10_000, 700]); // total − Σ byConnection
    for (const r of model.rows) expect(r.values.reduce((s, v) => s + v, 0)).toBe(r.total);

    const html = await render(RevenueChart({ series, connections: [a], currency: 'USD' }));
    expectSafe(html);
    expectTable(html);
    expect(html).toContain('>Other</span>');
    expect(html).toContain('>Other</th>');
    expect(html).toContain('class="fill-base-content/25"');
    expect(html).not.toContain('ghost');
  });

  it('falls back to a neutral fill for a malformed colour', async () => {
    const bad = conn('x', 'Weird', 'red" onload="alert(1)');
    const series: RevenueDay[] = days(7).map((day) => ({ day, total: 1_000, byConnection: { x: 1_000 } }));
    const html = await render(RevenueChart({ series, connections: [bad], currency: 'USD' }));
    expectSafe(html);
    expect(html).not.toContain('onload');
    expect(html).toContain('class="fill-base-content/50"');
  });

  it('survives garbage amounts without leaking NaN', async () => {
    const series = days(30).map((day, i) => ({
      day,
      total: i === 5 ? Number.NaN : 1_000,
      byConnection: { a: i === 6 ? Number.POSITIVE_INFINITY : 1_000 },
    }));
    const html = await render(RevenueChart({ series, connections: [conn('a', 'Acme', '#635BFF')], currency: 'EUR' }));
    expectSafe(html);
  });
});

// ---------- MrrChart ----------

describe('MrrChart', () => {
  const windowDays = days(30);

  it('0 points: a calm empty message, no table', async () => {
    const html = await render(MrrChart({ series: [], windowDays, currency: 'USD' }));
    expectSafe(html);
    expect(html).toContain('MRR history appears after the first sync.');
    expect(descOf(html)).toContain('No snapshots yet');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('stroke-accent');

    const nothing = await render(MrrChart({ series: [], windowDays: [], currency: 'USD' }));
    expectSafe(nothing);
  });

  it('1 point: a single dot and a note', async () => {
    const series: MrrDay[] = [{ day: '2026-11-05', total: 909_000 }];
    const html = await render(MrrChart({ series, windowDays, currency: 'USD' }));
    expectSafe(html);
    expectTable(html);
    expect(html).toContain('The trend fills in as daily snapshots arrive.');
    expect(count(html, 'h0.01"')).toBe(2); // ring + dot
    expect(html).not.toContain('stroke-width="2"'); // no line
    expect(html).toContain('$9,090.00');
    // Sits at the right end of the window.
    expect(html).toContain(`d="M${(windowDays.length - 1) * 10} `);
  });

  for (const range of [7, 30, 90] as const) {
    it(`2+ points: line, soft area and last-value dot (${range} days)`, async () => {
      const d = fixtureDashboard(range, 'full');
      const html = await render(
        MrrChart({ series: d.mrrSeries, windowDays: d.revenueSeries.map((r) => r.day), currency: 'USD' }),
      );
      expectSafe(html);
      expectTable(html);
      expect(html).toMatch(/<path d="M0 [\d.]+(L[\d.]+ [\d.]+)+" fill="none" class="stroke-accent" stroke-width="2"/);
      expect(html).toMatch(/fill="url\(#mrr-[a-z0-9]+-fill\)"/);
      expect(html).toContain('class="text-accent"');
      expect(count(html, 'h0.01"')).toBe(2);
      expect(count(html, 'scope="row"')).toBe(d.mrrSeries.length);
      expect(count(html, '<text ')).toBe(3);
      const desc = descOf(html);
      expect(desc).toContain('A snapshot every day.');
      expect(desc).toMatch(/Latest \$[\d,]+\.\d\d on Nov 5, up \$[\d,.]+ \(\+[\d.]+%\)/);
      // Padded, labelled, non-zero baseline — and the description says so.
      const scale = mrrScale(
        d.mrrSeries.map((p) => p.total),
        'USD',
      );
      expect(scale.min).toBeGreaterThan(0);
      expect(desc).toContain('not zero');
      expect(html).toContain(`>${tickLabels([scale.min], 'USD')[0]}</div>`);
    });
  }

  it('sparse history sits at the right end of the window', async () => {
    const d = fixtureDashboard(30, 'sparse');
    const win = d.revenueSeries.map((r) => r.day);
    const { points } = mrrPoints(d.mrrSeries, win);
    expect(points.map((p) => p.i)).toEqual([27, 28, 29]);
    const html = await render(MrrChart({ series: d.mrrSeries, windowDays: win, currency: 'USD' }));
    expectSafe(html);
    expectTable(html);
    expect(html).toMatch(/<path d="M270 [\d.]+L280 [\d.]+L290 [\d.]+" fill="none" class="stroke-accent"/);
    expect(html).toContain('History starts Nov 3.');
    expect(html).toContain('Days without a snapshot are left out.');
    expect(descOf(html)).toContain('Snapshots on 3 of 30 days, starting Nov 3.');
    // The x axis still spans the whole window.
    expect(html).toContain('>Oct 7</text>');
    expect(html).toContain('>Nov 5</text>');
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

  it('uses a zero baseline when the data spans most of its magnitude', async () => {
    const series: MrrDay[] = days(7).map((day, i) => ({ day, total: (i + 1) * 100_000 }));
    const html = await render(MrrChart({ series, windowDays: days(7), currency: 'EUR' }));
    expectSafe(html);
    expect(html).toContain('>€0</div>');
    expect(descOf(html)).toContain('Vertical axis from €0');
  });

  it('formats JPY without minor digits', async () => {
    const series: MrrDay[] = days(7).map((day, i) => ({ day, total: 1_200_000 + i * 15_000 }));
    const html = await render(MrrChart({ series, windowDays: days(7), currency: 'JPY', title: 'MRR (JPY)' }));
    expectSafe(html);
    expect(html).toContain('¥1,290,000');
    expect(html).toMatch(/>¥1\.\d+M<\/div>/);
  });
});

describe('chart accessibility', () => {
  it('names each "Show data" disclosure after its chart and makes the table scroller a labelled stop', async () => {
    const d = fixtureDashboard(30, 'full');
    const rev = await render(RevenueChart({ series: d.revenueSeries, connections: d.breakdown, currency: d.currency }));
    const mrr = await render(MrrChart({ series: d.mrrSeries, windowDays: d.revenueSeries.map((x) => x.day), currency: d.currency }));
    const summary = (h: string) => h.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)![1]!.replace(/<[^>]+>/g, '');
    expect(summary(rev)).toBe('Show data for Daily revenue');
    expect(summary(mrr)).toBe('Show data for MRR trend');
    for (const h of [rev, mrr]) {
      const cap = h.match(/<caption id="([^"]+)"/);
      expect(cap).not.toBeNull();
      expect(h).toMatch(new RegExp(`role="region" aria-labelledby="${cap![1]}" tabindex="0"`));
      // Per-day tooltips are for the mouse: Chromium would expose them inside role="img", so they're hidden.
      const g = h.indexOf('<g aria-hidden="true">');
      expect(g).toBeGreaterThan(-1);
      expect(h.indexOf('<title>', h.indexOf('</desc>'))).toBeGreaterThan(g);
      // Decorative axis labels stay out of the accessibility tree.
      expect(h).toMatch(/<div aria-hidden="true" class="flex h-40/);
      expect(h).toMatch(/<svg aria-hidden="true" width="100%" height="20"/);
    }
    // Ids are unique across the two charts on one page.
    const ids = [...(rev + mrr).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
