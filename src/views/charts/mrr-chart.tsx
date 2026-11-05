/**
 * MrrChart — MRR trend as a line (no area fill). Server-rendered SVG, no JS.
 * Owner: Experience (data-viz). CONTRACT: props are fixed.
 *
 * - x domain = windowDays (edge to edge), so a sparse history sits honestly at the right end.
 * - y domain = a padded nice domain around the data (see mrrScale in scale.ts); the bottom tick is
 *   always labelled, and it falls back to zero-based when the data spans most of its own magnitude.
 * - 0 points → calm empty message; 1 point → a dot + a note; 2+ → line and a last-value dot.
 */

import type { MrrDay } from '../../data/types';
import { formatPercent } from '../../lib/money';
import {
  AMOUNT_CELL,
  ChartGrid,
  ChartNote,
  DataDetails,
  HEAD_CELL_LEFT,
  HEAD_CELL_RIGHT,
  PlotMessage,
  ROW_HEAD,
} from './frame';
import {
  chartId,
  dayRangeLabel,
  finite,
  longDay,
  money,
  mrrScale,
  PLOT_HEIGHT,
  shortDay,
  svgNum,
  tickLabels,
  xTicks,
  yMapper,
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
}

/** viewBox units between two consecutive days. */
const STEP = 10;

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

export function MrrChart(props: MrrChartProps) {
  const title = props.title ?? 'MRR trend';
  const currency = props.currency;
  const { domain, points } = mrrPoints(props.series, props.windowDays);
  const n = domain.length;
  const H = PLOT_HEIGHT;
  const W = Math.max(n - 1, 1) * STEP;
  const xAt = (i: number) => (n > 1 ? i * STEP : W / 2);

  const scale = mrrScale(
    points.map((p) => p.value),
    currency,
  );
  const y = yMapper(scale, H);
  const empty = points.length === 0;
  const yLabels = empty ? [] : tickLabels(scale.ticks, currency).reverse();

  const id = chartId('mrr', `${title}|${currency}|${domain[0] ?? ''}|${n}|${points.map((p) => `${p.i}:${p.value}`).join(',')}`);
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const desc = describe(domain, points, scale, currency);

  const xy = points.map((p) => ({ x: xAt(p.i), y: y(p.value), p }));
  const line = xy.map((q, k) => `${k === 0 ? 'M' : 'L'}${svgNum(q.x)} ${svgNum(q.y)}`).join('');
  // Line only, no area: the y-axis rarely starts at zero, and a filled area would overstate change.
  const lastQ = xy[xy.length - 1];
  // A zero-length round-capped stroke is a perfect circle even though the plot stretches in x.
  const dot = lastQ ? `M${svgNum(lastQ.x)} ${svgNum(lastQ.y)}h0.01` : '';

  const zeroBased = scale.min === 0;
  const gridTicks = empty ? [] : zeroBased ? scale.ticks.filter((t) => t !== 0) : scale.ticks;

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
      {gridTicks.map((t) => (
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
      {empty || zeroBased ? (
        <line
          x1="0"
          x2={svgNum(W)}
          y1={String(H)}
          y2={String(H)}
          class={empty ? 'stroke-base-300' : 'stroke-field'}
          vector-effect="non-scaling-stroke"
          shape-rendering="crispEdges"
        />
      ) : null}
      {xy.length > 1 ? (
        <path
          d={line}
          fill="none"
          class="stroke-accent"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      ) : null}
      {dot ? (
        <path
          d={dot}
          fill="none"
          class="stroke-base-100"
          stroke-width="12"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      ) : null}
      {dot ? (
        <path d={dot} fill="none" class="stroke-accent" stroke-width="8" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      ) : null}
      {/* Hover targets with native <title> tooltips, mouse only. aria-hidden because Chromium
          exposes titled children of role="img" to screen readers; <desc> + the table cover AT. */}
      {xy.length > 0 ? (
        <g aria-hidden="true">
          {xy.map((q, k) => {
            const prev = xy[k - 1];
            const next = xy[k + 1];
            const left = prev ? (prev.x + q.x) / 2 : Math.max(0, q.x - STEP / 2);
            const right = next ? (q.x + next.x) / 2 : Math.min(W, q.x + STEP / 2);
            return (
              <rect
                x={svgNum(left)}
                y="0"
                width={svgNum(Math.max(0, right - left))}
                height={String(H)}
                class="fill-transparent hover:fill-base-200"
              >
                <title>{`${longDay(q.p.day)}: MRR ${money(q.p.value, currency)}`}</title>
              </rect>
            );
          })}
        </g>
      ) : null}
    </svg>
  );

  const firstPoint = points[0];
  const note =
    points.length === 1
      ? 'The trend fills in as daily snapshots arrive.'
      : firstPoint && firstPoint.i > 0
        ? `History starts ${shortDay(firstPoint.day)}.`
        : null;

  return (
    <figure class="w-full">
      <ChartGrid
        yLabels={yLabels}
        xTicks={xTicks(domain, 'point')}
        overlay={empty ? <PlotMessage>MRR history appears after the first sync.</PlotMessage> : null}
      >
        {plot}
      </ChartGrid>
      {note ? <ChartNote>{note}</ChartNote> : null}
      {empty ? null : <MrrTable domain={domain} points={points} currency={currency} id={`${id}-data`} label={title} />}
    </figure>
  );
}

function MrrTable(props: { domain: string[]; points: MrrPoint[]; currency: string; id: string; label: string }) {
  const { points, currency } = props;
  const sparse = points.length < props.domain.length;
  const caption =
    `MRR by day, ${dayRangeLabel(points[0]!.day, points[points.length - 1]!.day)}, in ${currency.trim().toUpperCase()}.` +
    (sparse ? ' Days without a snapshot are left out.' : '');
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
          <th scope="col" class={HEAD_CELL_RIGHT}>
            MRR
          </th>
        </tr>
      }
      body={points.map((p) => (
        <tr>
          <th scope="row" class={ROW_HEAD}>
            <time datetime={p.day}>{shortDay(p.day)}</time>
          </th>
          <td class={AMOUNT_CELL}>{money(p.value, currency)}</td>
        </tr>
      ))}
    />
  );
}
