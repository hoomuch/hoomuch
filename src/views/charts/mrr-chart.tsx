/**
 * MrrChart — MRR trend as a line (no area fill). shadcn Charts on Recharts 3.
 * Owner: Experience (data-viz). CONTRACT: props are fixed.
 *
 * - Line only, stroke var(--brand), with a dot on the last value. No area: the y axis rarely
 *   starts at zero, and a filled area would overstate the change.
 * - x domain = windowDays, edge to edge (a numeric index axis), so a sparse history sits honestly
 *   at the right end instead of being stretched across the plot.
 * - y domain = a padded nice domain around the data (see mrrScale in scale.ts); the bottom tick is
 *   always labelled, and it falls back to zero-based (with a baseline) when the data spans most of
 *   its own magnitude.
 * - 0 points → calm empty message; 1 point → a dot + a note; 2+ → line and a last-value dot.
 * - The server renders the description, notes and "Show data" table; the plot paints after hydration.
 *   With `weekly` (the year), the table lists each week's last snapshot; the line stays daily.
 */

import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import type { MrrDay } from '../../data/types';
import { formatPercent } from '../../lib/money';
import {
  AmountCell,
  AXIS_TEXT_FILL,
  ChartFrame,
  ChartNote,
  DataDetails,
  DayCell,
  HeadCell,
  MARGIN_TOP,
  Swatch,
  TableRow,
  TICK_MARGIN,
  TOOLTIP_MS,
  TooltipRow,
  X_AXIS_HEIGHT,
  xTick,
  yAxisWidth,
} from './frame';
import {
  chartId,
  dayRangeLabel,
  finite,
  longDay,
  money,
  mrrScale,
  shortDay,
  tickLabels,
  xLabelIndices,
  type NiceScale,
} from './scale';

export interface MrrChartProps {
  /** Days that have snapshots, oldest → newest; may be sparse or empty. */
  series: MrrDay[];
  /** Every day of the selected window, oldest → newest (x-axis domain). */
  windowDays: string[];
  currency: string;
  /** Accessible title; defaults to "MRR trend". */
  title?: string;
  /**
   * "Show data" lists each 7-day step's last snapshot, steps counted from the window's first day
   * (the year's weeks, like its revenue bars): 52 rows rather than 364. The line stays daily.
   */
  weekly?: boolean;
}

export interface MrrPoint {
  day: string;
  /** Index in the x domain. */
  i: number;
  value: number;
}

/** Pure: resolves the x domain and the points inside it (deduplicated by day, sorted). Exported for tests. */
export function mrrPoints(series: MrrDay[], windowDays: string[]): { domain: string[]; points: MrrPoint[] } {
  const domain = windowDays && windowDays.length > 0 ? windowDays : (series ?? []).map((d) => d.day);
  const index = new Map<string, number>();
  domain.forEach((d, i) => {
    if (!index.has(d)) index.set(d, i);
  });
  const byDay = new Map<string, MrrPoint>();
  for (const d of series ?? []) {
    const i = index.get(d.day);
    if (i === undefined) continue;
    byDay.set(d.day, { day: d.day, i, value: finite(d.total) });
  }
  return { domain, points: [...byDay.values()].sort((a, b) => a.i - b.i) };
}

/** Each 7-day step's last point, steps counted from the domain's first day. Exported for tests. */
export function weekEnds(points: MrrPoint[]): MrrPoint[] {
  const out: MrrPoint[] = [];
  for (const p of points) {
    const prev = out.at(-1);
    if (prev && Math.floor(prev.i / 7) === Math.floor(p.i / 7)) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

function describe(domain: string[], points: MrrPoint[], scale: NiceScale, currency: string): string {
  const n = domain.length;
  const range = n > 0 ? `${dayRangeLabel(domain[0]!, domain[n - 1]!)} (${n} ${n === 1 ? 'day' : 'days'})` : 'this period';
  if (points.length === 0) return `MRR, ${range}. No snapshots yet. MRR history appears after the first sync.`;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (points.length === 1) {
    return `MRR, ${range}. One snapshot so far: ${money(last.value, currency)} on ${shortDay(last.day)}. The trend fills in as daily snapshots arrive.`;
  }
  let lo = first;
  let hi = first;
  for (const p of points) {
    if (p.value < lo.value) lo = p;
    if (p.value > hi.value) hi = p;
  }
  const diff = last.value - first.value;
  const change =
    diff === 0
      ? `unchanged since ${shortDay(first.day)}`
      : `${diff > 0 ? 'up' : 'down'} ${money(Math.abs(diff), currency)}` +
        (first.value !== 0 ? ` (${formatPercent((diff / Math.abs(first.value)) * 100)})` : '') +
        ` since ${shortDay(first.day)}`;
  const coverage =
    points.length === n ? 'A snapshot every day.' : `Snapshots on ${points.length} of ${n} days, starting ${shortDay(first.day)}.`;
  const axis =
    scale.min === 0
      ? `Vertical axis from ${money(0, currency, { whole: true })} to ${money(scale.max, currency, { whole: true })}.`
      : `Vertical axis starts at ${money(scale.min, currency, { whole: true })}, not zero, and ends at ${money(scale.max, currency, { whole: true })}.`;
  return [
    `MRR, ${range}.`,
    coverage,
    `Latest ${money(last.value, currency)} on ${shortDay(last.day)}, ${change}.`,
    `Low ${money(lo.value, currency)} on ${shortDay(lo.day)}; high ${money(hi.value, currency)} on ${shortDay(hi.day)}.`,
    axis,
  ].join(' ');
}

/** Room right of the last point for its dot (r 4 + a 2px ring). */
const DOT_ROOM = 6;

export function MrrChart(props: MrrChartProps) {
  const title = props.title ?? 'MRR trend';
  const currency = props.currency;
  const { domain, points } = mrrPoints(props.series, props.windowDays);
  const n = domain.length;
  const empty = points.length === 0;

  const scale = mrrScale(
    points.map((p) => p.value),
    currency,
  );
  const zeroBased = scale.min === 0;
  const labels = tickLabels(scale.ticks, currency);
  const labelOf = new Map(scale.ticks.map((t, k) => [t, labels[k]!] as const));

  const id = chartId('mrr', `${title}|${currency}|${domain[0] ?? ''}|${n}|${points.map((p) => `${p.i}:${p.value}`).join(',')}`);
  const desc = describe(domain, points, scale, currency);

  // One window day: centre it. Otherwise the window runs edge to edge.
  const xDomain: [number, number] = n > 1 ? [0, n - 1] : [-1, 1];
  // Gridlines at every tick; on a zero-based scale the bottom one is the (stronger) baseline instead.
  const gridValues = empty ? [] : zeroBased ? scale.ticks.filter((t) => t !== 0) : scale.ticks;
  const last = points[points.length - 1];
  // Recharts only draws axes for a chart with a series, so an empty window still gets one: the
  // window days with no values (no line, no tooltip), which keeps the dates and the baseline.
  const data: { i: number; day: string; value: number | null }[] = empty
    ? domain.map((day, i) => ({ i, day, value: null }))
    : points.map((p) => ({ i: p.i, day: p.day, value: p.value }));

  const firstPoint = points[0];
  const note =
    points.length === 1
      ? 'The trend fills in as daily snapshots arrive.'
      : firstPoint && firstPoint.i > 0
        ? `History starts ${shortDay(firstPoint.day)}.`
        : null;

  return (
    <figure className="w-full min-w-0">
      <ChartFrame id={id} title={title} description={desc} message={empty ? 'MRR history appears after the first sync.' : null}>
        <LineChart
          data={data}
          accessibilityLayer={false}
          margin={{ top: MARGIN_TOP, right: DOT_ROOM, bottom: 0, left: 0 }}
        >
          {gridValues.length > 0 ? (
            <CartesianGrid vertical={false} horizontalValues={gridValues} stroke="var(--border)" />
          ) : null}
          <XAxis
            type="number"
            dataKey="i"
            domain={xDomain}
            ticks={xLabelIndices(n)}
            interval={0}
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tickSize={0}
            tickMargin={TICK_MARGIN}
            height={X_AXIS_HEIGHT}
            tick={xTick({ count: n, label: (i) => (domain[i] ? shortDay(domain[i]) : '') })}
          />
          <YAxis
            type="number"
            domain={[scale.min, scale.max]}
            // With no values Recharts has no data domain and would drop the axis (and the baseline);
            // otherwise the scale already covers the data, and overflow would only clip the line.
            allowDataOverflow={empty}
            ticks={scale.ticks}
            interval={0}
            hide={empty}
            axisLine={false}
            tickLine={false}
            tickSize={0}
            tickMargin={TICK_MARGIN}
            width={yAxisWidth(labels)}
            tick={{ fill: AXIS_TEXT_FILL }}
            tickFormatter={(v: number) => labelOf.get(v) ?? money(v, currency, { compact: true })}
          />
          {empty || zeroBased ? (
            <ReferenceLine y={scale.min} stroke={empty ? 'var(--border)' : 'var(--input)'} ifOverflow="visible" />
          ) : null}
          {empty ? null : (
            <ChartTooltip
              cursor={{ stroke: 'var(--border)' }}
              animationDuration={TOOLTIP_MS}
              animationEasing="ease-out"
              content={
                <ChartTooltipContent
                  labelFormatter={(_label, payload) => {
                    const day = (payload?.[0]?.payload as { day?: string } | undefined)?.day;
                    return day ? longDay(day) : null;
                  }}
                  formatter={(value) => (
                    <TooltipRow name="MRR" value={money(Number(value), currency)} swatch={<Swatch fill="var(--brand)" />} />
                  )}
                />
              }
            />
          )}
          {/* With one snapshot the path has no length; the ReferenceDot below is what shows. */}
          <Line
            type="linear"
            dataKey="value"
            name="MRR"
            stroke="var(--brand)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
            dot={false}
            activeDot={empty ? false : { r: 4, fill: 'var(--brand)', stroke: 'var(--background)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
          {last ? (
            <ReferenceDot
              x={last.i}
              y={last.value}
              r={4}
              fill="var(--brand)"
              stroke="var(--background)"
              strokeWidth={2}
              ifOverflow="visible"
            />
          ) : null}
        </LineChart>
      </ChartFrame>
      {note ? <ChartNote>{note}</ChartNote> : null}
      {empty ? null : (
        <MrrTable domain={domain} points={points} weekly={props.weekly ?? false} currency={currency} id={`${id}-data`} label={title} />
      )}
    </figure>
  );
}

function MrrTable(props: { domain: string[]; points: MrrPoint[]; weekly: boolean; currency: string; id: string; label: string }) {
  const { currency, weekly } = props;
  const points = weekly ? weekEnds(props.points) : props.points;
  const sparse = points.length < (weekly ? Math.ceil(props.domain.length / 7) : props.domain.length);
  const caption =
    `${weekly ? 'MRR at the end of each week' : 'MRR by day'}, ${dayRangeLabel(points[0]!.day, points[points.length - 1]!.day)}, in ${currency.trim().toUpperCase()}.` +
    (weekly ? ' Each week shows its last snapshot.' : '') +
    (sparse ? ` ${weekly ? 'Weeks' : 'Days'} without a snapshot are left out.` : '');
  return (
    <DataDetails
      id={props.id}
      label={props.label}
      caption={caption}
      head={
        <TableRow>
          <HeadCell>Date</HeadCell>
          <HeadCell numeric>MRR</HeadCell>
        </TableRow>
      }
      body={points.map((p) => (
        <TableRow key={p.day}>
          <DayCell day={p.day} label={shortDay(p.day)} />
          <AmountCell value={p.value} text={money(p.value, currency)} keepZero />
        </TableRow>
      ))}
    />
  );
}
