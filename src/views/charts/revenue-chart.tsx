/**
 * RevenueChart — daily net revenue, stacked by connection. Server-rendered SVG, no JS.
 * Owner: Experience (data-viz). CONTRACT: props are fixed.
 *
 * - Bars stack bottom → top in `connections` order; positive and negative parts of a day stack
 *   separately around a visible zero baseline (refund-heavy days go below it).
 * - Colour = ConnectionSummary.color via the SVG `fill` attribute. Connections sharing a colour
 *   (two Stripe accounts) step down in fill-opacity (1 / 0.65 / 0.4) and every stacked segment is
 *   separated by a 1px gap that shows the surface behind it.
 * - Ids in byConnection that aren't in `connections`, plus any part of `total` that byConnection
 *   doesn't explain, become one neutral "Other" segment — so every bar always sums to the day total.
 */

import type { ConnectionSummary, RevenueDay } from '../../data/types';
import {
  AMOUNT_CELL,
  AMOUNT_CELL_ZERO,
  ChartGrid,
  DataDetails,
  HEAD_CELL_LEFT,
  HEAD_CELL_RIGHT,
  Legend,
  PlotMessage,
  ROW_HEAD,
} from './frame';
import {
  bandGapRatio,
  chartId,
  dayRangeLabel,
  finite,
  isHexColor,
  longDay,
  money,
  PLOT_HEIGHT,
  revenueScale,
  sameColorOpacities,
  shortDay,
  svgNum,
  tickLabels,
  xTicks,
  yMapper,
} from './scale';

export interface RevenueChartProps {
  /** Exactly rangeDays entries, oldest → newest, zero-filled. */
  series: RevenueDay[];
  /** Colour + name per connection (BreakdownRow[] works too). Order = stacking order, bottom first. */
  connections: ConnectionSummary[];
  /** Display currency of every amount. */
  currency: string;
  /** Accessible title; defaults to "Daily revenue". */
  title?: string;
}

/** viewBox units per day; x is stretched to the container anyway. */
const BAND = 10;
/** Vertical gap between stacked segments, in CSS px (y units are px, see scale.ts). */
const SEGMENT_GAP = 1;
const OTHER_CLASS = 'fill-ink-3';
/** Fallback for a connection whose colour isn't a valid hex. */
const NEUTRAL_CLASS = 'fill-series-neutral';

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

export interface RevenueRow {
  day: string;
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
    return { day: d.day, total, values, pos, neg };
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
  return { series, rows, allZero };
}

interface Seg {
  s: RevenueSeries;
  from: number;
  to: number;
}

function stacks(row: RevenueRow, series: RevenueSeries[]): { up: Seg[]; down: Seg[] } {
  const up: Seg[] = [];
  const down: Seg[] = [];
  let p = 0;
  let n = 0;
  for (const s of series) {
    const v = row.values[s.col] ?? 0;
    if (v > 0) {
      up.push({ s, from: p, to: p + v });
      p += v;
    } else if (v < 0) {
      down.push({ s, from: n, to: n + v });
      n += v;
    }
  }
  return { up, down };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describe(model: RevenueModel, currency: string): string {
  const { rows, series } = model;
  if (rows.length === 0) return 'No revenue data for this period.';
  const range = `${dayRangeLabel(rows[0]!.day, rows[rows.length - 1]!.day)} (${plural(rows.length, 'day', 'days')})`;
  if (model.allZero) return `Daily revenue, ${range}. No revenue in this period yet.`;

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
    `Daily revenue (charges minus refunds), ${range}` +
      (series.length > 1 ? `, stacked by connection: ${series.map((s) => s.name).join(', ')}.` : '.'),
    `Total ${money(sum, currency)}.`,
    `Highest day ${shortDay(hi.day)} at ${money(hi.total, currency)}; lowest day ${shortDay(lo.day)} at ${money(lo.total, currency)}; latest ${shortDay(last.day)} at ${money(last.total, currency)}.`,
  ];
  if (negDays > 0) parts.push(`${plural(negDays, 'day', 'days')} had more refunds than charges and ${negDays === 1 ? 'goes' : 'go'} below zero.`);
  return parts.join(' ');
}

function tooltip(row: RevenueRow, series: RevenueSeries[], currency: string): string {
  const lines = [`${longDay(row.day)}: ${money(row.total, currency)} total`];
  if (series.length > 1) {
    for (const s of series) {
      const v = row.values[s.col] ?? 0;
      if (v !== 0) lines.push(`${s.name}: ${money(v, currency)}`);
    }
  }
  return lines.join('\n');
}

export function RevenueChart(props: RevenueChartProps) {
  const title = props.title ?? 'Daily revenue';
  const currency = props.currency;
  const model = revenueModel(props.series, props.connections);
  const { rows, series, allZero } = model;
  const n = rows.length;
  const H = PLOT_HEIGHT;
  const W = Math.max(n, 1) * BAND;
  const gap = bandGapRatio(n);
  const barW = BAND * (1 - gap);

  let maxPos = 0;
  let minNeg = 0;
  for (const r of rows) {
    if (r.pos > maxPos) maxPos = r.pos;
    if (r.neg < minNeg) minNeg = r.neg;
  }
  const scale = revenueScale(minNeg, maxPos, currency);
  const y = yMapper(scale, H);
  const y0 = y(0);
  const labels = tickLabels(scale.ticks, currency);
  // All-zero: only the "$0" baseline label, no gridlines — a flat, calm frame instead of a fake scale.
  const yLabels = allZero ? [labels[scale.ticks.indexOf(0)] ?? money(0, currency, { compact: true })] : labels.slice().reverse();

  const id = chartId(
    'rev',
    `${title}|${currency}|${series.map((s) => s.key).join(',')}|${rows.map((r) => `${r.day}:${r.total}`).join(',')}`,
  );
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const desc = describe(model, currency);

  const bars = allZero
    ? []
    : rows.flatMap((row, i) => {
        const x = i * BAND + (BAND * gap) / 2;
        const { up, down } = stacks(row, series);
        const rects = [];
        for (let j = 0; j < up.length; j++) {
          const seg = up[j]!;
          let top = y(seg.to);
          const bottom = y(seg.from);
          if (j < up.length - 1 && bottom - top >= 2 * SEGMENT_GAP) top += SEGMENT_GAP;
          rects.push(<Bar seg={seg} x={x} w={barW} top={top} bottom={bottom} />);
        }
        for (let j = 0; j < down.length; j++) {
          const seg = down[j]!;
          const top = y(seg.from);
          let bottom = y(seg.to);
          if (j < down.length - 1 && bottom - top >= 2 * SEGMENT_GAP) bottom -= SEGMENT_GAP;
          rects.push(<Bar seg={seg} x={x} w={barW} top={top} bottom={bottom} />);
        }
        return rects;
      });

  const plot = (
    <svg
      role="img"
      aria-labelledby={titleId}
      aria-describedby={descId}
      viewBox={`0 0 ${svgNum(W)} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={String(H)}
      class="block h-40 w-full overflow-visible"
    >
      <title id={titleId}>{title}</title>
      <desc id={descId}>{desc}</desc>
      {allZero
        ? null
        : scale.ticks
            .filter((t) => t !== 0)
            .map((t) => (
              <line
                x1="0"
                x2={svgNum(W)}
                y1={svgNum(y(t))}
                y2={svgNum(y(t))}
                class="stroke-base-300"
                vector-effect="non-scaling-stroke"
                shape-rendering="crispEdges"
              />
            ))}
      {bars}
      <line
        x1="0"
        x2={svgNum(W)}
        y1={svgNum(y0)}
        y2={svgNum(y0)}
        class="stroke-field"
        vector-effect="non-scaling-stroke"
        shape-rendering="crispEdges"
      />
      {/* Per-day hover targets with a native <title> tooltip, for mouse users only. Chromium
          still exposes titled children of role="img" as graphics-symbol nodes (30–90 long names
          inside the image), so the group is aria-hidden; the tooltips keep working. Screen-reader
          and keyboard users get the same numbers from <desc> and the "Show data" table. */}
      {allZero ? null : (
        <g aria-hidden="true">
          {rows.map((row, i) => (
            <rect
              x={svgNum(i * BAND)}
              y="0"
              width={svgNum(BAND)}
              height={String(H)}
              class="fill-transparent hover:fill-base-200"
            >
              <title>{tooltip(row, series, currency)}</title>
            </rect>
          ))}
        </g>
      )}
    </svg>
  );

  return (
    // block: daisyUI lays out a <figure> inside a .card as a centred flex row (it is meant for card images).
    <figure class="block w-full">
      {series.length > 1 && !allZero ? (
        <Legend
          items={series.map((s) => ({ name: s.name, color: s.color, opacity: s.opacity, neutralClass: s.neutralClass }))}
        />
      ) : null}
      <ChartGrid
        yLabels={yLabels}
        xTicks={xTicks(
          rows.map((r) => r.day),
          'band',
          gap,
        )}
        overlay={allZero ? <PlotMessage>No revenue in this period yet.</PlotMessage> : null}
      >
        {plot}
      </ChartGrid>
      {allZero ? null : <RevenueTable model={model} currency={currency} id={`${id}-data`} label={title} />}
    </figure>
  );
}

function Bar(props: { seg: Seg; x: number; w: number; top: number; bottom: number }) {
  const { s } = props.seg;
  const h = Math.max(0, props.bottom - props.top);
  return (
    <rect
      x={svgNum(props.x)}
      y={svgNum(props.top)}
      width={svgNum(props.w)}
      height={svgNum(h)}
      fill={s.color ?? undefined}
      fill-opacity={s.color && s.opacity < 1 ? svgNum(s.opacity) : undefined}
      class={s.color ? undefined : (s.neutralClass ?? undefined)}
    />
  );
}

function RevenueTable(props: { model: RevenueModel; currency: string; id: string; label: string }) {
  const { rows, series } = props.model;
  const cur = props.currency;
  const colTotals = series.map((s) => rows.reduce((acc, r) => acc + (r.values[s.col] ?? 0), 0));
  const grand = rows.reduce((acc, r) => acc + r.total, 0);
  const caption = `Daily revenue by connection, ${dayRangeLabel(rows[0]!.day, rows[rows.length - 1]!.day)}, in ${cur.trim().toUpperCase()}.`;
  const cell = (v: number) => <td class={v === 0 ? AMOUNT_CELL_ZERO : AMOUNT_CELL}>{money(v, cur)}</td>;
  return (
    <DataDetails
      id={props.id}
      label={props.label}
      caption={caption}
      head={
        <tr>
          <th scope="col" class={HEAD_CELL_LEFT}>
            Date
          </th>
          {series.map((s) => (
            <th scope="col" class={HEAD_CELL_RIGHT}>
              {s.name}
            </th>
          ))}
          <th scope="col" class={HEAD_CELL_RIGHT}>
            Total
          </th>
        </tr>
      }
      body={rows.map((r) => (
        <tr>
          <th scope="row" class={ROW_HEAD}>
            <time datetime={r.day}>{shortDay(r.day)}</time>
          </th>
          {series.map((s) => cell(r.values[s.col] ?? 0))}
          {cell(r.total)}
        </tr>
      ))}
      foot={
        <tr>
          <th scope="row" class={HEAD_CELL_LEFT}>
            Total
          </th>
          {colTotals.map((v) => cell(v))}
          {cell(grand)}
        </tr>
      }
    />
  );
}
