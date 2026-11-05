/**
 * KpiStat (one daisyUI `stat`) and DeltaBadge (period-over-period change).
 * Owner: Experience (design). CONTRACT: props are fixed.
 *
 * Money typography: tabular figures, tight tracking, one weight (semibold). The MRR hero is the
 * largest type on any page; secondary KPIs step down two sizes. Labels are sentence case.
 * stat-value carries a size token (text-display / text-title, both 600): daisyUI's own is 32px at
 * 800, and nowrap, so a long currency gets wrap-anywhere back as a last resort.
 */

import type { Child } from 'hono/jsx';
import { IconArrowDown, IconArrowUp } from './icons';
import { cx } from './ui';

/** |pct| below this reads as "0.0%", so it's shown as flat, not as a tiny rise or fall. */
const FLAT = 0.05;

type Direction = 'up' | 'down' | 'flat';

const DELTA_TONE: Record<'good' | 'bad' | 'flat' | 'neutral', string> = {
  good: 'text-success',
  bad: 'text-error',
  flat: 'text-ink-2',
  neutral: 'text-base-content',
};

const DELTA_WORD: Record<Direction, string> = { up: 'Up', down: 'Down', flat: 'Unchanged' };

/**
 * `pct` null → "—" (no comparable data). `invert` → a decrease is good (e.g. refunds).
 * `neutral` → ink either way, for figures where up isn't clearly good (trials: fewer can mean
 * more of them converted). Direction is carried by an arrow AND a visually hidden word, never by
 * colour alone.
 */
export function DeltaBadge(props: { pct: number | null; invert?: boolean; neutral?: boolean; label?: string; class?: string }) {
  if (props.pct === null || !Number.isFinite(props.pct)) {
    return (
      <span class={cx('tabular-nums text-ink-3', props.class)} title="No earlier data to compare">
        <span aria-hidden="true">—</span>
        <span class="sr-only">No earlier data to compare</span>
      </span>
    );
  }
  const pct = props.pct;
  const dir: Direction = Math.abs(pct) < FLAT ? 'flat' : pct > 0 ? 'up' : 'down';
  const tone =
    dir === 'flat' ? 'flat' : props.neutral ? 'neutral' : (dir === 'up') !== Boolean(props.invert) ? 'good' : 'bad';
  return (
    <span
      class={cx('inline-flex items-center gap-0.5 font-semibold whitespace-nowrap tabular-nums', DELTA_TONE[tone], props.class)}
      title={props.label}
    >
      {dir === 'up' ? <IconArrowUp class="size-3.5 shrink-0" /> : null}
      {dir === 'down' ? <IconArrowDown class="size-3.5 shrink-0" /> : null}
      <span class="sr-only">{DELTA_WORD[dir]} </span>
      {/* Unsigned: the arrow and the spoken word carry the direction. */}
      {dir === 'flat' ? '0.0%' : `${Math.abs(pct).toFixed(1)}%`}
    </span>
  );
}

export interface KpiStatProps {
  label: string;
  /** Already formatted, e.g. "$9,090". */
  value: string;
  /** Delta vs. the comparison point; omit to hide the badge. */
  deltaPct?: number | null;
  /** e.g. "vs. 30 days ago". */
  deltaLabel?: string;
  /** The MRR hero figure: biggest type on the page. */
  hero?: boolean;
  /** Small line under the value, e.g. "ARR $109K". */
  hint?: Child;
  /** A decrease is good (refunds, churn): flips the delta colour, not its arrow. */
  invertDelta?: boolean;
  /** Neither direction is good or bad (trials): the delta stays ink. */
  neutralDelta?: boolean;
  /**
   * The delta sits on the value's line and `deltaLabel` is only spoken, because a caption under
   * the row says it once for every figure (the dashboard's secondary row).
   */
  inlineDelta?: boolean;
  /** Extra literal classes for the wrapper (grid placement, padding). */
  class?: string;
}

export function KpiStat(props: KpiStatProps) {
  const hero = Boolean(props.hero);
  if (props.inlineDelta && !hero) {
    return (
      <div class={cx('stat min-w-0', props.class)}>
        <p class="stat-title">{props.label}</p>
        <p class="stat-value mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-title whitespace-normal">
          <span class="tabular-nums wrap-anywhere">{props.value}</span>
          {props.deltaPct !== undefined ? (
            <span class="text-body">
              <DeltaBadge pct={props.deltaPct} invert={props.invertDelta} neutral={props.neutralDelta} label={props.deltaLabel} />
              {props.deltaLabel ? <span class="sr-only"> {props.deltaLabel}</span> : null}
            </span>
          ) : null}
        </p>
        {props.hint ? <p class="stat-desc tabular-nums">{props.hint}</p> : null}
      </div>
    );
  }
  return (
    <div class={cx('stat min-w-0', props.class)}>
      <p class="stat-title">{props.label}</p>
      <p
        class={
          hero
            ? 'stat-value mt-1 text-display-sm tabular-nums wrap-anywhere whitespace-normal sm:text-display'
            : // Long currencies ("TRY 2,800,631", Intl joins code and number with a no-break space) must
              // fit a quarter of the card at md; wrap-anywhere is only the last-resort fallback.
              'stat-value mt-1 text-title tabular-nums wrap-anywhere whitespace-normal'
        }
      >
        {props.value}
      </p>
      {props.deltaPct !== undefined ? (
        <p class={hero ? 'stat-desc mt-2 flex flex-wrap items-baseline gap-x-2 text-body' : 'stat-desc mt-1 flex flex-wrap items-baseline gap-x-1.5'}>
          <DeltaBadge pct={props.deltaPct} invert={props.invertDelta} neutral={props.neutralDelta} class="self-center" />
          {props.deltaLabel ? <span>{props.deltaLabel}</span> : null}
        </p>
      ) : null}
      {props.hint ? <p class={hero ? 'stat-desc mt-1 text-body tabular-nums' : 'stat-desc tabular-nums'}>{props.hint}</p> : null}
    </div>
  );
}
