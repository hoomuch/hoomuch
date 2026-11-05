/**
 * Shared chart chrome for RevenueChart and MrrChart. Owner: Experience (data-viz).
 *
 * Layout: a 2×2 grid — [y labels | plot] over [spacer | x labels].
 *  - The plot SVG is stretched horizontally (preserveAspectRatio="none") but has a fixed 160px height
 *    equal to its viewBox height, so the y labels can be plain HTML spaced with justify-between: the
 *    ticks are equally spaced and min/max are ticks, so label k sits exactly on gridline k.
 *  - The x labels are an SVG WITHOUT a viewBox: `x="48.3%"` positions text at a fraction of the plot
 *    width while the text itself renders at the CSS font size (12px) at 375px and at 960px alike.
 *
 * CSP: no inline styles anywhere; colours come from theme classes or SVG presentation attributes.
 * Text tokens follow app.css: chart text is base-content/70, never below /60.
 */

import type { Child } from 'hono/jsx';
import { TableScroller } from '../components/ui';
import { svgNum, type XTick } from './scale';

/** Plot + axes. `yLabels` are top → bottom (max first) and must correspond to equally spaced ticks. */
export function ChartGrid(props: { yLabels: string[]; xTicks: XTick[]; children?: Child; overlay?: Child }) {
  return (
    <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 pt-1.5">
      <YLabels labels={props.yLabels} />
      <div class="relative h-40 min-w-0">
        {props.children}
        {props.overlay}
      </div>
      <div aria-hidden="true"></div>
      <XLabels ticks={props.xTicks} />
    </div>
  );
}

function YLabels(props: { labels: string[] }) {
  // Each label is a zero-height row whose text overflows symmetrically around the gridline.
  const cls =
    props.labels.length > 1
      ? 'flex h-40 flex-col justify-between text-right text-xs leading-none tabular-nums text-base-content/70'
      : 'flex h-40 flex-col justify-end text-right text-xs leading-none tabular-nums text-base-content/70';
  return (
    <div aria-hidden="true" class={cls}>
      {props.labels.map((label) => (
        <div class="flex h-0 items-center justify-end whitespace-nowrap">{label}</div>
      ))}
    </div>
  );
}

function XLabels(props: { ticks: XTick[] }) {
  return (
    <svg
      aria-hidden="true"
      width="100%"
      height="20"
      class="mt-1 block h-5 w-full overflow-visible fill-base-content/70 text-xs tabular-nums"
    >
      {props.ticks.map((t) => (
        <text x={`${svgNum(t.pct)}%`} y="14" text-anchor={t.anchor}>
          {t.label}
        </text>
      ))}
    </svg>
  );
}

/** Calm centred message over an empty plot. Hidden from AT: the SVG <desc> says the same thing. */
export function PlotMessage(props: { children?: Child }) {
  return (
    <p
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-base-content/70"
    >
      {props.children}
    </p>
  );
}

/** Small muted note under a chart. */
export function ChartNote(props: { children?: Child }) {
  return <p class="mt-2 text-xs text-base-content/70">{props.children}</p>;
}

export interface LegendItem {
  name: string;
  /** Brand hex for the swatch fill; null → `neutralClass`. */
  color: string | null;
  opacity: number;
  /** Literal Tailwind fill class used when `color` is null. */
  neutralClass: string | null;
}

/** Rect swatches mirror the bar marks (including the same-colour opacity steps). */
export function Legend(props: { items: LegendItem[] }) {
  return (
    <ul aria-label="Legend" class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/70">
      {props.items.map((it) => (
        <li class="flex min-w-0 items-center gap-1.5">
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" class="shrink-0">
            <rect
              width="10"
              height="10"
              rx="2"
              fill={it.color ?? undefined}
              fill-opacity={it.opacity < 1 ? svgNum(it.opacity) : undefined}
              class={it.color ? undefined : (it.neutralClass ?? undefined)}
            />
          </svg>
          <span class="truncate">{it.name}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Show data" disclosure holding the accessible table twin of a chart.
 * `label` (the chart's title) is appended visually hidden, so two charts on a page don't give
 * screen readers two identical "Show data" summaries; the visible text stays first (2.5.3).
 * `id` names the caption that labels the focusable scroller; pass one unique per page.
 */
export function DataDetails(props: { caption: string; head: Child; body: Child; foot?: Child; label?: string; id?: string }) {
  const captionId = props.id ? `${props.id}-caption` : undefined;
  return (
    <details class="mt-4">
      <summary class="cursor-pointer text-sm text-base-content/70 hover:text-base-content">
        Show data
        {props.label ? <span class="sr-only"> for {props.label}</span> : null}
      </summary>
      {/* The real <caption> is sr-only: inside the horizontal scroller it would be as wide as the
          table and get clipped at 375px. The visible copy wraps in the card instead. */}
      <p aria-hidden="true" class="mt-2 text-xs text-base-content/70">
        {props.caption}
      </p>
      <TableScroller labelledBy={captionId} label={props.caption} class="mt-1">
        <table class="table tabular-nums">
          <caption id={captionId} class="sr-only">
            {props.caption}
          </caption>
          <thead>{props.head}</thead>
          <tbody>{props.body}</tbody>
          {props.foot ? <tfoot>{props.foot}</tfoot> : null}
        </table>
      </TableScroller>
    </details>
  );
}

/** Literal classes for amount cells (zeros are muted so the eye lands on real values). */
export const AMOUNT_CELL = 'whitespace-nowrap text-right';
export const AMOUNT_CELL_ZERO = 'whitespace-nowrap text-right text-base-content/60';
export const HEAD_CELL_RIGHT = 'whitespace-nowrap text-right';
export const HEAD_CELL_LEFT = 'whitespace-nowrap';
export const ROW_HEAD = 'whitespace-nowrap font-normal';
