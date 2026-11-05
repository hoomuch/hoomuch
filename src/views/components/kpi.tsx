/**
 * KpiStat (one figure in the KPI strip) and DeltaBadge (period-over-period change).
 * Owner: Experience (design). CONTRACT: props are fixed.
 *
 * Money typography: tabular figures, tight tracking, one weight (semibold). The MRR hero is the
 * largest type on any page; secondary KPIs step down two sizes. Labels are sentence case.
 */

import type { Child } from 'hono/jsx';
import { IconArrowDown, IconArrowUp } from './icons';
import { cx } from './ui';

/** |pct| below this reads as "0.0%", so it's shown as flat, not as a tiny rise or fall. */
const FLAT = 0.05;

type Direction = 'up' | 'down' | 'flat';

const DELTA_TONE: Record<'good' | 'bad' | 'flat', string> = {
  good: 'text-success',
  bad: 'text-error',
  flat: 'text-base-content/70',
};

const DELTA_WORD: Record<Direction, string> = { up: 'Up', down: 'Down', flat: 'Unchanged' };

/**
 * `pct` null → "—" (no comparable data). `invert` → a decrease is good (e.g. refunds).
 * Direction is carried by an arrow AND a visually hidden word, never by colour alone.
 */
export function DeltaBadge(props: { pct: number | null; invert?: boolean; label?: string; class?: string }) {
  if (props.pct === null || !Number.isFinite(props.pct)) {
    return (
      <span class={cx('tabular-nums text-base-content/60', props.class)} title="No earlier data to compare">
        <span aria-hidden="true">—</span>
        <span class="sr-only">No earlier data to compare</span>
      </span>
    );
  }
  const pct = props.pct;
  const dir: Direction = Math.abs(pct) < FLAT ? 'flat' : pct > 0 ? 'up' : 'down';
  const tone = dir === 'flat' ? 'flat' : (dir === 'up') !== Boolean(props.invert) ? 'good' : 'bad';
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
  /** Extra literal classes for the wrapper (grid placement, padding). */
  class?: string;
}

export function KpiStat(props: KpiStatProps) {
  const hero = Boolean(props.hero);
  return (
    <div class={cx('min-w-0', props.class)}>
      <p class={'text-sm text-base-content/70'}>{props.label}</p>
      <p
        class={
          hero
            ? 'mt-2 text-4xl leading-none font-semibold tracking-tight tabular-nums wrap-anywhere sm:text-5xl md:text-4xl lg:text-5xl'
            : // Long currencies ("TRY 2,800,631", Intl joins code and number with a no-break space) must
              // fit a quarter of the card at md; wrap-anywhere is only the last-resort fallback.
              'mt-1.5 text-xl leading-tight font-semibold tracking-tight tabular-nums wrap-anywhere lg:text-2xl'
        }
      >
        {props.value}
      </p>
      {props.deltaPct !== undefined ? (
        <p class={hero ? 'mt-3 flex flex-wrap items-baseline gap-x-2 text-sm' : 'mt-1 flex flex-wrap items-baseline gap-x-1.5 text-sm'}>
          <DeltaBadge pct={props.deltaPct} invert={props.invertDelta} class="self-center" />
          {props.deltaLabel ? <span class="text-base-content/70">{props.deltaLabel}</span> : null}
        </p>
      ) : null}
      {props.hint ? <p class="mt-1 text-sm text-base-content/70 tabular-nums">{props.hint}</p> : null}
    </div>
  );
}
