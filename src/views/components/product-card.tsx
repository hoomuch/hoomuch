/**
 * A published product as a card that links to its page (SPEC F-21–F-23): on a founder's profile,
 * and in the landing page's strip. Owner: Experience (design).
 *
 * Card padding 20 / 24 and 16 between its parts (design/system.md §3.3). The whole card is the
 * link, so its figures are plain text inside it.
 */

import type { ReactNode } from 'react';
import { Card as CossCard, CardPanel } from '@/components/ui/card';
import type { ProviderId } from '../../providers/types';
import { ProductTile } from './avatar';
import { DeltaBadge } from './kpi';
import { ProviderLogo } from './provider-logos';

export interface CardFigure {
  label: string;
  value: string;
  /** A change shown after the value, e.g. MRR against 30 days ago. */
  deltaPct?: number | null;
}

export function ProductCard(props: {
  href: string;
  name: string;
  tagline: string | null;
  /** The logo's URL (lib/media.ts); initials without one. */
  logo?: string | null;
  /** "by Taha B": who makes it, where the card isn't already on their profile. Shown at the bottom. */
  byline?: string;
  /** Two or three of them. */
  figures: CardFigure[];
  providers: ProviderId[];
  /** A short note at the bottom right, e.g. "Not updated recently". */
  note?: ReactNode;
}) {
  return (
    <a href={props.href} className="block h-full rounded-2xl transition-colors hover:bg-accent/40">
      <CossCard className="h-full min-w-0 bg-transparent">
        <CardPanel className="flex h-full flex-col gap-4 p-5 sm:p-6">
          <div className="flex min-w-0 items-start gap-3">
            <ProductTile name={props.name} src={props.logo} className="size-10" />
            <div className="min-w-0">
              <p className="font-semibold wrap-break-word">{props.name}</p>
              {props.tagline ? <p className="text-body text-muted-foreground wrap-break-word">{props.tagline}</p> : null}
            </div>
          </div>
          <dl className={`mt-auto grid gap-3 border-t pt-4 ${props.figures.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
            {props.figures.map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="text-caption text-muted-foreground">{f.label}</dt>
                <dd className="flex flex-wrap items-baseline gap-x-1.5 font-semibold tabular-nums">
                  <span className="wrap-anywhere">{f.value}</span>
                  {/* The size on a wrapper: tailwind-merge would read a text-caption class on the badge as
                      a colour and drop the badge's own (green, red). */}
                  {f.deltaPct !== undefined ? (
                    <span className="text-caption">
                      <DeltaBadge pct={f.deltaPct} label="vs. 30 days ago" />
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          <p className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
            <span className="flex gap-1.5" aria-hidden="true">
              {props.providers.map((p) => (
                <ProviderLogo key={p} provider={p} />
              ))}
            </span>
            {/* Who makes it, or a note: quieter than the name and tagline above. */}
            <span className="min-w-0 truncate">{props.note ?? props.byline ?? null}</span>
          </p>
        </CardPanel>
      </CossCard>
    </a>
  );
}
