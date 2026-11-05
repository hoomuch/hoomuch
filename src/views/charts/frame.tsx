/**
 * Shared chart chrome for RevenueChart and MrrChart. Owner: Experience (data-viz).
 *
 * Rendering model: shadcn Charts (ChartContainer) on Recharts 3. Recharts draws nothing on the
 * server, only its sized wrapper, and paints after hydration. So everything a reader needs before
 * (or without) JavaScript is plain server HTML around the plot: the accessible name and
 * description, the empty-state message, notes, the legend, and the "Show data" table.
 *
 * Layout: the chart box has a fixed height (h-48 = 8px top margin + PLOT_HEIGHT + 24px x axis),
 * equal to `initialDimension`, so nothing moves when Recharts paints. Gridlines are horizontal
 * only (var(--border)), axis text is 12px muted-foreground with tabular figures, no axis lines.
 *
 * Accessibility: the chart box is role="img", named by the chart title and described by an
 * sr-only paragraph inside it (children of an img are presentational, so the paragraph isn't read
 * twice). Recharts' own SVG is aria-hidden and has no accessibility layer: the description and
 * the table carry the same information for screen-reader and keyboard users.
 *
 * CSP: the Worker allows inline styles (style-src 'unsafe-inline', for Base UI and Recharts), but
 * the charts don't depend on it: no <style> elements and no inline styles of our own.
 * ChartContainer only emits a <style> when its config has colours, so configs here never do;
 * colours are SVG presentation attributes (fill="var(--brand)"). The container also restates
 * Recharts' server-rendered sizing styles as classes, so the charts still paint under a stricter
 * style-src.
 *
 * Tailwind rule: class names are complete literal strings.
 */

import type { ReactElement, ReactNode } from 'react';
import type { XAxisTickContentProps } from 'recharts';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { TableBody, TableCell, TableFooter, TableHead, TableHeader } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Disclosure, ScrollTable, TableRowHeader } from '../components/ui';
import { PLOT_HEIGHT, svgNum } from './scale';

// ---------- geometry ----------

/** Space above the plot, so the top tick label (centred on the top gridline) isn't clipped. */
export const MARGIN_TOP = 8;
/** Height of the x axis band under the plot. */
export const X_AXIS_HEIGHT = 24;
/** Gap between an axis label and the plot. */
export const TICK_MARGIN = 8;
/** Total chart box height; must match the literal `h-48` below (8 + 160 + 24 = 192). */
export const CHART_HEIGHT = MARGIN_TOP + PLOT_HEIGHT + X_AXIS_HEIGHT;
/** First-render size, identical on server and client; the real width is measured after hydration. */
export const INITIAL_DIMENSION = { width: 640, height: CHART_HEIGHT } as const;

/**
 * Width for a y axis holding `labels`, from per-character advances of 12px Geist with tabular
 * figures (deterministic, so the server and the first client render agree and the plot doesn't
 * jump when Recharts would otherwise measure). Errs a little wide; labels are right-aligned.
 */
export function yAxisWidth(labels: string[]): number {
  let max = 0;
  for (const label of labels) {
    let w = 0;
    for (const ch of label) {
      if (ch >= '0' && ch <= '9') w += 7.2;
      else if (ch === '.' || ch === ',' || ch === ' ' || ch === ' ' || ch === "'") w += 3.4;
      else if (ch === '-' || ch === '−') w += 5.2;
      else if (ch >= 'A' && ch <= 'Z') w += 8;
      else if (ch >= 'a' && ch <= 'z') w += 6.4;
      else w += 7.6; // currency symbols and anything else
    }
    if (w > max) max = w;
  }
  return Math.ceil(max) + TICK_MARGIN + 2;
}

// ---------- the chart box ----------

/*
 * aspect-auto + h-48: a fixed box instead of ChartContainer's aspect-video.
 * The [&_.recharts-*] rules restate what Recharts puts in style attributes (which a strict CSP
 * drops from server HTML, and React doesn't re-apply on hydration): the responsive container
 * fills the box and may shrink, and the wrapper is the tooltip's positioning context.
 */
const CONTAINER_CLASS =
  'aspect-auto h-48 w-full justify-start tabular-nums [&_.recharts-responsive-container]:size-full [&_.recharts-responsive-container]:min-w-0 [&_.recharts-wrapper]:relative';

/** No colours in the config: ChartContainer would inject a <style> element for them. */
const NO_CONFIG: ChartConfig = {};

/**
 * The plot: role="img" named `title` and described by `description`, a fixed-height
 * ChartContainer around a Recharts chart, and an optional server-rendered message over it.
 */
export function ChartFrame(props: {
  /** Deterministic chart id (scale.ts chartId); also names the description. */
  id: string;
  title: string;
  description: string;
  /** Calm centred message over an empty plot. */
  message?: ReactNode;
  /** A Recharts chart element (LineChart, BarChart). */
  children: ReactElement;
}) {
  const descId = `${props.id}-desc`;
  return (
    <div role="img" aria-label={props.title} aria-describedby={descId} className="relative min-w-0">
      <p id={descId} className="sr-only">
        {props.description}
      </p>
      <ChartContainer
        id={props.id}
        config={NO_CONFIG}
        initialDimension={INITIAL_DIMENSION}
        aria-hidden="true"
        className={CONTAINER_CLASS}
      >
        {props.children}
      </ChartContainer>
      {props.message ? <PlotMessage>{props.message}</PlotMessage> : null}
    </div>
  );
}

/** Calm centred message over the plot area. Hidden from AT: the description says the same thing. */
export function PlotMessage(props: { children?: ReactNode }) {
  return (
    <p
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-2 bottom-6 flex items-center justify-center px-4 text-center text-body text-muted-foreground"
    >
      {props.children}
    </p>
  );
}

/** Small muted note under a chart. */
export function ChartNote(props: { children?: ReactNode }) {
  return <p className="mt-2 text-caption text-muted-foreground">{props.children}</p>;
}

/**
 * How long the tooltip takes to slide from one data point to the next. Recharts' default is 400ms,
 * which trails the pointer when you scrub across 30–90 days; 100ms keeps it glued to the cursor
 * and still smooth. Reduced motion turns the slide off (styles/app.css).
 */
export const TOOLTIP_MS = 100;

// ---------- axes ----------

export const AXIS_TEXT_FILL = 'var(--muted-foreground)';

/**
 * Renderer for sparse x labels (first, middle, last; see xLabelIndices) on an index axis of `count`
 * days. The first label starts at the plot's left edge and the last ends at its right edge, so they
 * never overflow the card; in a band (bar) axis the edges are the first and last bars' outer edges.
 * `bandGap` is the share of each band left empty (bandGapRatio); omit it for a point (line) axis.
 */
export function xTick(opts: { count: number; label: (index: number) => string; bandGap?: number }) {
  return function XTick(props: XAxisTickContentProps): ReactNode {
    const v = Number(props.payload.value);
    const n = opts.count;
    const anchor: 'start' | 'middle' | 'end' = n <= 1 ? 'middle' : v === 0 ? 'start' : v === n - 1 ? 'end' : 'middle';
    let dx = 0;
    if (opts.bandGap !== undefined && anchor !== 'middle') {
      const band = Number(props.width) / Math.max(n, 1);
      const half = Number.isFinite(band) ? (band * (1 - opts.bandGap)) / 2 : 0;
      dx = anchor === 'start' ? -half : half;
    }
    return (
      <text x={Number(props.x) + dx} y={Number(props.y)} dy="0.71em" textAnchor={anchor} fill={AXIS_TEXT_FILL}>
        {opts.label(v)}
      </text>
    );
  };
}

// ---------- tooltips ----------

/** A 10px rounded swatch, the same mark as the legend's. */
export function Swatch(props: { fill: string; opacity?: number }) {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
      <rect
        width="10"
        height="10"
        rx="2"
        fill={props.fill}
        fillOpacity={props.opacity !== undefined && props.opacity < 1 ? svgNum(props.opacity) : undefined}
      />
    </svg>
  );
}

/** One "name … amount" line inside ChartTooltipContent (its `formatter` output). */
export function TooltipRow(props: { name: ReactNode; value: string; swatch?: ReactNode; strong?: boolean }) {
  return (
    <>
      {props.swatch}
      <div className="flex flex-1 items-center justify-between gap-4 leading-none">
        <span className={props.strong ? 'font-medium text-foreground' : 'text-muted-foreground'}>{props.name}</span>
        <span className="font-mono font-medium text-foreground tabular-nums">{props.value}</span>
      </div>
    </>
  );
}

// ---------- legend ----------

export interface LegendItem {
  name: string;
  /** Brand hex for the swatch fill; null → `neutralClass`. */
  color: string | null;
  opacity: number;
  /** Literal Tailwind fill class used when `color` is null. */
  neutralClass: string | null;
}

/** Server-rendered legend (shows before hydration). Swatches mirror the bars, opacity steps included. */
export function Legend(props: { items: LegendItem[] }) {
  return (
    <ul aria-label="Legend" className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
      {props.items.map((it, i) => (
        <li key={`${i}-${it.name}`} className="flex min-w-0 items-center gap-1.5">
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
            <rect
              width="10"
              height="10"
              rx="2"
              fill={it.color ?? undefined}
              fillOpacity={it.color && it.opacity < 1 ? svgNum(it.opacity) : undefined}
              className={it.color ? undefined : (it.neutralClass ?? undefined)}
            />
          </svg>
          <span className="truncate">{it.name}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- the data table ----------

/**
 * "Show data" disclosure (closed by default) holding the accessible table twin of a chart.
 * `label` (the chart's title) is appended visually hidden, so two charts on a page don't give
 * screen readers two identical "Show data" buttons; the visible text stays first (2.5.3).
 * `id` names the caption that labels the focusable scroller; pass one unique per page.
 */
export function DataDetails(props: {
  caption: string;
  head: ReactNode;
  body: ReactNode;
  foot?: ReactNode;
  label?: string;
  id: string;
}) {
  const captionId = `${props.id}-caption`;
  return (
    <Disclosure
      className="mt-4"
      summary={
        <span>
          Show data{props.label ? <span className="sr-only"> for {props.label}</span> : null}
        </span>
      }
    >
      {/* The real <caption> is sr-only: inside the horizontal scroller it would be as wide as the
          table and get clipped at 375px. The visible copy wraps in the card instead. */}
      <p aria-hidden="true" className="mt-2 text-caption text-muted-foreground">
        {props.caption}
      </p>
      <ScrollTable labelledBy={captionId} className="mt-1" tableClassName="tabular-nums">
        <caption id={captionId} className="sr-only">
          {props.caption}
        </caption>
        <TableHeader>{props.head}</TableHeader>
        <TableBody>{props.body}</TableBody>
        {props.foot ? <TableFooter>{props.foot}</TableFooter> : null}
      </ScrollTable>
    </Disclosure>
  );
}

/** Column header; amounts are right-aligned. */
export function HeadCell(props: { children?: ReactNode; numeric?: boolean }) {
  return (
    <TableHead scope="col" className={props.numeric ? 'text-right' : undefined}>
      {props.children}
    </TableHead>
  );
}

/** Row header holding a day. */
export function DayCell(props: { day: string; label: string }) {
  return (
    <TableRowHeader>
      <time dateTime={props.day}>{props.label}</time>
    </TableRowHeader>
  );
}

/** Amount cell; zeros are faint so the eye lands on real values (`keepZero` for levels like MRR). */
export function AmountCell(props: { value: number; text: string; keepZero?: boolean }) {
  return (
    <TableCell className={cn('text-right tabular-nums', props.value === 0 && !props.keepZero && 'text-faint')}>{props.text}</TableCell>
  );
}

export { TableRow } from '@/components/ui/table';
