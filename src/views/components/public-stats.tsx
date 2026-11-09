/**
 * The figures row of a public page (SPEC F-21/F-22): one card, its cells split by hairlines, two
 * by two on a phone and four in a row from `lg`; and the note on where the figures come from.
 * Owner: Experience (design).
 *
 * Built like the dashboard's secondary row (views/pages/dashboard.tsx SecondaryStats): KpiStat's
 * inline cells, the delta on the value's line, and the comparison said once under the card. The
 * hairlines are the card's border colour showing through a 1px grid gap, so they hold in any
 * arrangement of rows and columns.
 */

import { BadgeCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card as CossCard } from '@/components/ui/card';
import { Disclosure } from './ui';

export function StatGrid(props: { label: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={props.label}>
      <CossCard className="overflow-hidden">
        <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">{props.children}</div>
      </CossCard>
      {/* Each delta already speaks its comparison; this is the visual version of the same. */}
      {props.note ? (
        <p aria-hidden="true" className="mt-2 text-caption text-muted-foreground">
          {props.note}
        </p>
      ) : null}
    </section>
  );
}

/** The class a KpiStat in the grid takes: the card's colour over the hairline gap. */
export const STAT_CELL = 'bg-card';

/**
 * Where the figures come from, said once: a line anyone reads, caveats that stay in view, and the
 * longer story behind "How these figures are checked" (in the server HTML, found by find-in-page).
 */
export function VerifiedNote(props: { children: ReactNode; details: ReactNode; caveats?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-2">
      <p className="flex items-start gap-2 text-caption text-muted-foreground">
        <BadgeCheck className="mt-px size-3.5 shrink-0 text-success-foreground" />
        <span>{props.children}</span>
      </p>
      {props.caveats}
      <Disclosure summary="How these figures are checked">
        <div className="grid max-w-prose gap-3 pt-2 text-body text-pretty text-muted-foreground">{props.details}</div>
      </Disclosure>
    </div>
  );
}
