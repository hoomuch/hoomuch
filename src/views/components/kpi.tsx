/**
 * KpiStat (one figure with its label) and DeltaBadge (period-over-period change).
 * Owner: Experience (design). CONTRACT: props are fixed.
 *
 * Money typography: Geist with tabular figures, tight tracking, one weight (semibold). The MRR
 * hero is the largest type on any page; secondary KPIs step down two sizes. Labels are sentence
 * case. A long currency gets wrap-anywhere back as a last resort.
 */

import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** |pct| below this reads as "0.0%", so it's shown as flat, not as a tiny rise or fall. */
export const FLAT = 0.05;

type Direction = 'up' | 'down' | 'flat';

const DELTA_TONE: Record<'good' | 'bad' | 'flat' | 'neutral', string> = {
  good: 'text-success-foreground',
  bad: 'text-destructive-foreground',
  flat: 'text-muted-foreground',
  neutral: 'text-foreground',
};

const DELTA_WORD: Record<Direction, string> = { up: 'Up', down: 'Down', flat: 'Unchanged' };

/**
 * `pct` null → "—" (no comparable data). `invert` → a decrease is good (e.g. refunds).
 * `neutral` → foreground either way, for figures where up isn't clearly good (trials: fewer can
 * mean more of them converted). Direction is carried by an arrow AND a visually hidden word, never
 * by colour alone.
 */
export function DeltaBadge(props: { pct: number | null; invert?: boolean; neutral?: boolean; label?: string; className?: string }) {
  if (props.pct === null || !Number.isFinite(props.pct)) {
    return (
      <span className={cn('tabular-nums text-faint', props.className)} title="No earlier data to compare">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No earlier data to compare</span>
      </span>
    );
  }
  const pct = props.pct;
  const dir: Direction = Math.abs(pct) < FLAT ? 'flat' : pct > 0 ? 'up' : 'down';
  const tone =
    dir === 'flat' ? 'flat' : props.neutral ? 'neutral' : (dir === 'up') !== Boolean(props.invert) ? 'good' : 'bad';
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 font-semibold whitespace-nowrap tabular-nums', DELTA_TONE[tone], props.className)}
      title={props.label}
    >
      {dir === 'up' ? <ArrowUp className="size-3.5 shrink-0" strokeWidth={2.5} /> : null}
      {dir === 'down' ? <ArrowDown className="size-3.5 shrink-0" strokeWidth={2.5} /> : null}
      <span className="sr-only">{DELTA_WORD[dir]} </span>
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
  hint?: ReactNode;
  /** A decrease is good (refunds, churn): flips the delta colour, not its arrow. */
  invertDelta?: boolean;
  /** Neither direction is good or bad (trials): the delta stays foreground. */
  neutralDelta?: boolean;
  /**
   * The delta sits on the value's line and `deltaLabel` is only spoken, because a caption under
   * the row says it once for every figure (the dashboard's secondary row).
   */
  inlineDelta?: boolean;
  /** Extra classes for the wrapper (grid placement, padding). */
  className?: string;
}

const LABEL = 'text-body text-muted-foreground';
const HINT = 'text-body text-muted-foreground tabular-nums';

export function KpiStat(props: KpiStatProps) {
  const hero = Boolean(props.hero);
  if (props.inlineDelta && !hero) {
    return (
      <div className={cn('min-w-0 px-5 py-4 sm:px-6', props.className)} data-slot="kpi">
        <p className={LABEL}>{props.label}</p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-title">
          <span className="tabular-nums wrap-anywhere">{props.value}</span>
          {props.deltaPct !== undefined ? (
            <span className="text-body">
              <DeltaBadge pct={props.deltaPct} invert={props.invertDelta} neutral={props.neutralDelta} label={props.deltaLabel} />
              {props.deltaLabel ? <span className="sr-only"> {props.deltaLabel}</span> : null}
            </span>
          ) : null}
        </p>
        {props.hint ? <p className={HINT}>{props.hint}</p> : null}
      </div>
    );
  }
  return (
    <div className={cn('min-w-0', props.className)} data-slot="kpi">
      <p className={LABEL}>{props.label}</p>
      <p
        className={
          hero
            ? 'mt-1 text-display-sm tabular-nums wrap-anywhere sm:text-display'
            : // Long currencies ("TRY 2,800,631", Intl joins code and number with a no-break space) must
              // fit a quarter of the card at md; wrap-anywhere is only the last-resort fallback.
              'mt-1 text-title tabular-nums wrap-anywhere'
        }
      >
        {props.value}
      </p>
      {props.deltaPct !== undefined ? (
        <p
          className={
            hero
              ? 'mt-2 flex flex-wrap items-baseline gap-x-2 text-body text-muted-foreground'
              : 'mt-1 flex flex-wrap items-baseline gap-x-1.5 text-caption text-muted-foreground'
          }
        >
          <DeltaBadge pct={props.deltaPct} invert={props.invertDelta} neutral={props.neutralDelta} className="self-center" />
          {props.deltaLabel ? <span>{props.deltaLabel}</span> : null}
        </p>
      ) : null}
      {props.hint ? <p className={hero ? 'mt-1 text-body text-muted-foreground tabular-nums' : HINT}>{props.hint}</p> : null}
    </div>
  );
}
