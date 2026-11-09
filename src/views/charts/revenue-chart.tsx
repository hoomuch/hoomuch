/**
 * RevenueChart — daily net revenue, stacked by connection. shadcn Charts on Recharts 3.
 * Owner: Experience (data-viz). CONTRACT: props are fixed.
 *
 * - Bars stack bottom → top in `connections` order; positive and negative parts of a day stack
 *   separately around a visible zero line (stackOffset="sign" + a ReferenceLine at 0), so
 *   refund-heavy days go below it.
 * - Colour = ConnectionSummary.color as the SVG `fill` attribute. Connections sharing a colour
 *   (two Stripe accounts) step down in fill-opacity (1 / 0.65 / 0.4) and every stacked segment is
 *   separated by a 1px gap that shows the surface behind it (never a drawn border).
 * - Ids in byConnection that aren't in `connections`, plus any part of `total` that byConnection
 *   doesn't explain, become one "Other" segment in var(--faint) — so every bar always sums to the
 *   day total. A connection without a valid hex colour is drawn in var(--series-neutral).
 * - All-zero → only the $0 baseline and a calm message. The legend (more than one series) is
 *   server HTML, like the description and the "Show data" table; the plot paints after hydration.
 * - Entries with a `to` are weeks (the year's window): one bar each, named by their first and last day.
 * - `variant="line"`: the day's (or week's) total as one line on a zero-based scale, with a dot per
 *   point while they have room (a month or less); hovering splits it by connection, and the table
 *   below is the same. One series, so no legend: the card title names it.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
  type BarShapeProps,
  type TooltipContentProps,
} from 'recharts';
import { ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import type { ConnectionSummary, RevenueDay } from '../../data/types';
import { TableRowHeader } from '../components/ui';
import {
  AmountCell,
  AXIS_TEXT_FILL,
  ChartFrame,
  DataDetails,
  DayCell,
  HeadCell,
  Legend,
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
  bandGapRatio,
  chartId,
  dayRangeLabel,
  finite,
  isHexColor,
  longDay,
  money,
  revenueScale,
  sameColorOpacities,
  shortDay,
  tickLabels,
  xLabelIndices,
} from './scale';

export interface RevenueChartProps {
  /** One entry per day, or per week (entries with `to`), oldest → newest, zero-filled. */
  series: RevenueDay[];
  /** Colour + name per connection (BreakdownRow[] works too). Order = stacking order, bottom first. */
  connections: ConnectionSummary[];
  /** Display currency of every amount. */
  currency: string;
  /** Accessible title; defaults to "Daily revenue" ("Weekly revenue" for weeks). */
  title?: string;
  /** Stacked bars by connection (default), or the total as a line. */
  variant?: RevenueVariant;
}

/** How the revenue card draws its series (`?revenue=`, remembered like the range). */
export const REVENUE_VARIANTS = ['bars', 'line'] as const;
export type RevenueVariant = (typeof REVENUE_VARIANTS)[number];

/** A `?revenue=` value, or bars for anything else. */
export function parseRevenueVariant(v: string | undefined | null): RevenueVariant {
  return v === 'line' ? 'line' : 'bars';
}

/** The line's dots, one per point, while the points are at most this many (a month). */
const LINE_DOTS_MAX = 31;
/** Room right of the line's last point for its dot (r 4 + a 2px ring). */
const DOT_ROOM = 6;

/** Vertical gap between stacked segments, in CSS px. */
const SEGMENT_GAP = 1;
/** "Other": everything byConnection can't attribute to a listed connection. */
const OTHER_CLASS = 'fill-faint';
/** Fallback for a connection whose colour isn't a valid hex. */
const NEUTRAL_CLASS = 'fill-series-neutral';
/** SVG fill for the neutral classes (bars and tooltip swatches use attributes, not classes). */
const NEUTRAL_FILL: Record<string, string> = {
  [OTHER_CLASS]: 'var(--faint)',
  [NEUTRAL_CLASS]: 'var(--series-neutral)',
};

export interface RevenueSeries {
  key: string;
  name: string;
  /** Brand hex, or null when drawn with `neutralClass`. */
  color: string | null;
  opacity: number;
  neutralClass: string | null;
  /** Index into RevenueRow.values. */
  col: number;
}

interface RevenueRow {
  day: string;
  /** The week's last day; null for a single day. */
  to: string | null;
  total: number;
  /** Net per series column (connections in order, then Other). */
  values: number[];
  /** Sum of the positive parts / negative parts (stacked separately). */
  pos: number;
  neg: number;
}

export interface RevenueModel {
  series: RevenueSeries[];
  rows: RevenueRow[];
  allZero: boolean;
  /** The rows are weeks. */
  weekly: boolean;
}

/** Pure: resolves series, Other, and per-day stacks. Exported for tests. */
export function revenueModel(days: RevenueDay[], connections: ConnectionSummary[]): RevenueModel {
  const conns: ConnectionSummary[] = [];
  const seen = new Set<string>();
  for (const c of connections ?? []) {
    if (c && typeof c.id === 'string' && !seen.has(c.id)) {
      seen.add(c.id);
      conns.push(c);
    }
  }
  const colIndex = new Map(conns.map((c, i) => [c.id, i] as const));
  const otherCol = conns.length;

  const rows: RevenueRow[] = (days ?? []).map((d) => {
    const values = new Array<number>(otherCol + 1).fill(0);
    let sumAll = 0;
    for (const [id, raw] of Object.entries(d.byConnection ?? {})) {
      const v = finite(raw);
      sumAll += v;
      const col = colIndex.get(id) ?? otherCol;
      values[col] = values[col]! + v;
    }
    const total = typeof d.total === 'number' && Number.isFinite(d.total) ? d.total : sumAll;
    values[otherCol] = values[otherCol]! + (total - sumAll);
    let pos = 0;
    let neg = 0;
    for (const v of values) {
      if (v > 0) pos += v;
      else if (v < 0) neg += v;
    }
    return { day: d.day, to: d.to ?? null, total, values, pos, neg };
  });

  const validColors = conns.map((c) => (isHexColor(c.color) ? c.color.trim() : ''));
  const opacities = sameColorOpacities(validColors.map((c, i) => c || `__neutral${i}`));
  const series: RevenueSeries[] = conns.map((c, i) => ({
    key: c.id,
    name: c.name,
    color: validColors[i] || null,
    opacity: validColors[i] ? opacities[i]! : 1,
    neutralClass: validColors[i] ? null : NEUTRAL_CLASS,
    col: i,
  }));
  if (rows.some((r) => r.values[otherCol] !== 0)) {
    series.push({ key: '__other__', name: 'Other', color: null, opacity: 1, neutralClass: OTHER_CLASS, col: otherCol });
  }

  const allZero = rows.every((r) => r.values.every((v) => v === 0));
  return { series, rows, allZero, weekly: rows.some((r) => r.to !== null) };
}

/** The SVG fill of a series: its brand hex, or the token behind its neutral class. */
function seriesFill(s: RevenueSeries): string {
  return s.color ?? NEUTRAL_FILL[s.neutralClass ?? ''] ?? 'var(--series-neutral)';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The row's day, or its week as "Nov 3 – Nov 9": short, for labels and table rows. */
function rowLabel(r: RevenueRow): string {
  return r.to ? `${shortDay(r.day)} – ${shortDay(r.to)}` : shortDay(r.day);
}

/** The whole window, first day to last ("Oct 7 – Nov 5, 2026"). */
function windowLabel(rows: RevenueRow[]): string {
  const last = rows[rows.length - 1]!;
  return dayRangeLabel(rows[0]!.day, last.to ?? last.day);
}

function describe(model: RevenueModel, currency: string, line: boolean): string {
  const { rows, series, weekly } = model;
  if (rows.length === 0) return 'No revenue data for this period.';
  const unit = weekly ? 'week' : 'day';
  const per = weekly ? 'Weekly' : 'Daily';
  const range = `${windowLabel(rows)} (${plural(rows.length, unit, `${unit}s`)})`;
  if (model.allZero) return `${per} revenue, ${range}. No revenue in this period yet.`;

  let sum = 0;
  let hi = rows[0]!;
  let lo = rows[0]!;
  let negDays = 0;
  for (const r of rows) {
    sum += r.total;
    if (r.total > hi.total) hi = r;
    if (r.total < lo.total) lo = r;
    if (r.total < 0) negDays++;
  }
  const last = rows[rows.length - 1]!;
  const parts = [
    `${per} revenue (charges minus refunds), ${range}` +
      (series.length <= 1
        ? '.'
        : line
          ? `, as one line of the total; the table splits it by connection: ${series.map((s) => s.name).join(', ')}.`
          : `, stacked by connection: ${series.map((s) => s.name).join(', ')}.`),
    `Total ${money(sum, currency)}.`,
    `Highest ${unit} ${rowLabel(hi)} at ${money(hi.total, currency)}; lowest ${unit} ${rowLabel(lo)} at ${money(lo.total, currency)}; latest ${rowLabel(last)} at ${money(last.total, currency)}.`,
  ];
  if (negDays > 0) parts.push(`${plural(negDays, unit, `${unit}s`)} had more refunds than charges and ${negDays === 1 ? 'goes' : 'go'} below zero.`);
  return parts.join(' ');
}

/** One bar band per day. `c{col}` holds the series values Recharts stacks (index keys: ids may contain dots). */
interface Datum {
  i: number;
  row: RevenueRow;
  /** Topmost positive / bottommost negative segment of the day (no gap beyond the outer end). */
  topPos: number;
  botNeg: number;
  [key: `c${number}`]: number;
}

function toData(model: RevenueModel): Datum[] {
  return model.rows.map((row, i) => {
    const d: Datum = { i, row, topPos: -1, botNeg: -1 };
    for (const s of model.series) {
      const v = row.values[s.col] ?? 0;
      d[`c${s.col}`] = v;
      if (v > 0) d.topPos = s.col;
      else if (v < 0) d.botNeg = s.col;
    }
    return d;
  });
}

/**
 * A stacked segment with a 1px gap on its outer side (away from zero) unless it's the outermost
 * one of its stack, so neighbours separate by showing the surface behind them.
 */
function segmentShape(s: RevenueSeries) {
  const fill = seriesFill(s);
  const opacity = s.opacity < 1 ? s.opacity : undefined;
  return function Segment(props: BarShapeProps) {
    const d = props.payload as Datum | undefined;
    const x = finite(props.x);
    const w = finite(props.width);
    let top = Math.min(finite(props.y), finite(props.y) + finite(props.height));
    let h = Math.abs(finite(props.height));
    const v = d ? (d.row.values[s.col] ?? 0) : 0;
    if (!d || v === 0 || h <= 0 || w <= 0) return <g />;
    if (v > 0 && d.topPos !== s.col && h >= 2 * SEGMENT_GAP) {
      top += SEGMENT_GAP;
      h -= SEGMENT_GAP;
    } else if (v < 0 && d.botNeg !== s.col && h >= 2 * SEGMENT_GAP) {
      h -= SEGMENT_GAP;
    }
    return <rect x={x} y={top} width={w} height={h} fill={fill} fillOpacity={opacity} />;
  };
}

/** The day, its total, then each non-zero series (when there is more than one). */
function revenueTooltip(series: RevenueSeries[], currency: string) {
  return function RevenueTooltip(props: TooltipContentProps) {
    const d = props.payload?.[0]?.payload as Datum | undefined;
    if (!props.active || !d) return null;
    const total = { dataKey: '__total', name: 'Total', value: d.row.total, payload: d };
    const parts =
      series.length > 1
        ? series
            .filter((s) => (d.row.values[s.col] ?? 0) !== 0)
            .map((s) => ({ dataKey: `c${s.col}`, name: s.name, value: d.row.values[s.col] ?? 0, payload: d }))
        : [];
    const byKey = new Map<string, RevenueSeries>(series.map((s) => [`c${s.col}`, s]));
    return (
      <ChartTooltipContent
        active
        payload={[total, ...parts] as unknown as TooltipContentProps['payload']}
        labelFormatter={() => (d.row.to ? dayRangeLabel(d.row.day, d.row.to) : longDay(d.row.day))}
        formatter={(value, _name, item) => {
          const s = byKey.get(String(item.dataKey));
          return s ? (
            <TooltipRow name={s.name} value={money(Number(value), currency)} swatch={<Swatch fill={seriesFill(s)} opacity={s.opacity} />} />
          ) : (
            <TooltipRow strong name="Total" value={money(Number(value), currency)} />
          );
        }}
      />
    );
  };
}

export function RevenueChart(props: RevenueChartProps) {
  const currency = props.currency;
  const line = props.variant === 'line';
  const model = revenueModel(props.series, props.connections);
  const title = props.title ?? (model.weekly ? 'Weekly revenue' : 'Daily revenue');
  const { rows, series, allZero } = model;
  const n = rows.length;
  const gap = bandGapRatio(n);

  // Bars stack each day's positive and negative parts apart; the line plots the day's total.
  let maxPos = 0;
  let minNeg = 0;
  for (const r of rows) {
    const hi = line ? r.total : r.pos;
    const lo = line ? r.total : r.neg;
    if (hi > maxPos) maxPos = hi;
    if (lo < minNeg) minNeg = lo;
  }
  const scale = revenueScale(minNeg, maxPos, currency);
  const labels = tickLabels(scale.ticks, currency);
  const labelOf = new Map(scale.ticks.map((t, k) => [t, labels[k]!] as const));
  // All-zero: only the "$0" baseline label, no gridlines — a flat, calm frame instead of a fake scale.
  const yTicks = allZero ? [0] : scale.ticks;
  const yLabels = yTicks.map((t) => labelOf.get(t) ?? money(t, currency, { compact: true }));

  const id = chartId(
    'rev',
    `${line ? 'line|' : ''}${title}|${currency}|${series.map((s) => s.key).join(',')}|${rows.map((r) => `${r.day}:${r.total}`).join(',')}`,
  );
  const desc = describe(model, currency, line);
  const data = toData(model);
  // The ends are the window's: the first entry's first day, the last entry's last day (today).
  const xLabel = (i: number) => (rows[i] ? shortDay(i === n - 1 ? (rows[i].to ?? rows[i].day) : rows[i].day) : '');
  const yAxis = (
    <YAxis
      type="number"
      domain={[scale.min, scale.max]}
      // All-zero data gives Recharts no domain, and it would drop the axis and the baseline.
      allowDataOverflow={allZero}
      ticks={yTicks}
      interval={0}
      axisLine={false}
      tickLine={false}
      tickSize={0}
      tickMargin={TICK_MARGIN}
      width={yAxisWidth(yLabels)}
      tick={{ fill: AXIS_TEXT_FILL }}
      tickFormatter={(v: number) => labelOf.get(v) ?? money(v, currency, { compact: true })}
    />
  );
  const grid = allZero ? null : <CartesianGrid vertical={false} horizontalValues={scale.ticks.filter((t) => t !== 0)} stroke="var(--border)" />;
  const baseline = <ReferenceLine y={0} stroke="var(--input)" ifOverflow="visible" />;
  const dot = { r: 4, fill: 'var(--brand)', stroke: 'var(--background)', strokeWidth: 2 };

  return (
    <figure className="w-full min-w-0">
      {series.length > 1 && !allZero && !line ? (
        <Legend
          items={series.map((s) => ({ name: s.name, color: s.color, opacity: s.opacity, neutralClass: s.neutralClass }))}
        />
      ) : null}
      <ChartFrame id={id} title={title} description={desc} message={allZero ? 'No revenue in this period yet.' : null}>
        {line ? (
          <LineChart data={data} accessibilityLayer={false} margin={{ top: MARGIN_TOP, right: DOT_ROOM, bottom: 0, left: 0 }}>
            {grid}
            <XAxis
              type="number"
              dataKey="i"
              // One point: centre it. Otherwise the window runs edge to edge.
              domain={n > 1 ? [0, n - 1] : [-1, 1]}
              ticks={xLabelIndices(n)}
              interval={0}
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
              tickSize={0}
              tickMargin={TICK_MARGIN}
              height={X_AXIS_HEIGHT}
              tick={xTick({ count: n, label: xLabel })}
            />
            {yAxis}
            {allZero ? null : (
              <ChartTooltip
                cursor={{ stroke: 'var(--border)' }}
                animationDuration={TOOLTIP_MS}
                animationEasing="ease-out"
                content={revenueTooltip(series, currency)}
              />
            )}
            {baseline}
            {/* Drawn even when all-zero, without a stroke: Recharts needs a series to lay out the axes. */}
            <Line
              type="linear"
              dataKey={(d: Datum) => d.row.total}
              name="Revenue"
              stroke={allZero ? 'none' : 'var(--brand)'}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill="none"
              dot={!allZero && n <= LINE_DOTS_MAX ? dot : false}
              activeDot={allZero ? false : dot}
              isAnimationActive={false}
            />
          </LineChart>
        ) : (
          <BarChart
            data={data}
            accessibilityLayer={false}
            stackOffset="sign"
            barCategoryGap={`${(gap / 2) * 100}%`}
            barGap={0}
            margin={{ top: MARGIN_TOP, right: 0, bottom: 0, left: 0 }}
          >
            {grid}
            <XAxis
              type="category"
              dataKey="i"
              ticks={xLabelIndices(n)}
              interval={0}
              axisLine={false}
              tickLine={false}
              tickSize={0}
              tickMargin={TICK_MARGIN}
              height={X_AXIS_HEIGHT}
              tick={xTick({ count: n, bandGap: gap, label: xLabel })}
            />
            {yAxis}
            {allZero ? null : <ChartTooltip cursor={{ fill: 'var(--muted)' }} animationDuration={TOOLTIP_MS} animationEasing="ease-out" content={revenueTooltip(series, currency)} />}
            {/* Always drawn (all-zero days draw nothing): Recharts needs a series to lay out the y axis. */}
            {series.length > 0 ? (
              series.map((s) => (
                  <Bar
                    key={s.key}
                    dataKey={`c${s.col}`}
                    name={s.name}
                    stackId="day"
                    fill={seriesFill(s)}
                    fillOpacity={s.opacity}
                    shape={segmentShape(s)}
                    isAnimationActive={false}
                  />
                ))
            ) : (
              <Bar dataKey={(d: Datum) => d.row.total} stackId="day" fill="none" isAnimationActive={false} />
            )}
            {baseline}
          </BarChart>
        )}
      </ChartFrame>
      {allZero ? null : <RevenueTable model={model} currency={currency} id={`${id}-data`} label={title} />}
    </figure>
  );
}

function RevenueTable(props: { model: RevenueModel; currency: string; id: string; label: string }) {
  const { rows, series } = props.model;
  const cur = props.currency;
  const colTotals = series.map((s) => rows.reduce((acc, r) => acc + (r.values[s.col] ?? 0), 0));
  const grand = rows.reduce((acc, r) => acc + r.total, 0);
  const caption = `${props.model.weekly ? 'Weekly' : 'Daily'} revenue by connection, ${windowLabel(rows)}, in ${cur.trim().toUpperCase()}.`;
  return (
    <DataDetails
      id={props.id}
      label={props.label}
      caption={caption}
      head={
        <TableRow>
          <HeadCell>{props.model.weekly ? 'Week' : 'Date'}</HeadCell>
          {series.map((s) => (
            <HeadCell key={s.key} numeric>
              {s.name}
            </HeadCell>
          ))}
          <HeadCell numeric>Total</HeadCell>
        </TableRow>
      }
      body={rows.map((r, i) => (
        <TableRow key={`${i}-${r.day}`}>
          <DayCell day={r.day} label={rowLabel(r)} />
          {series.map((s) => (
            <AmountCell key={s.key} value={r.values[s.col] ?? 0} text={money(r.values[s.col] ?? 0, cur)} />
          ))}
          <AmountCell value={r.total} text={money(r.total, cur)} />
        </TableRow>
      ))}
      foot={
        <TableRow>
          <TableRowHeader className="font-medium">Total</TableRowHeader>
          {colTotals.map((v, k) => (
            <AmountCell key={series[k]!.key} value={v} text={money(v, cur)} />
          ))}
          <AmountCell value={grand} text={money(grand, cur)} />
        </TableRow>
      }
    />
  );
}
