/**
 * EmptyState: the dozing owl, a short message, primary actions (coss Empty inside a Card).
 * Owner: Experience (design). CONTRACT: existing props are fixed; new ones must be optional.
 * Empty states are a personality zone (design/brief.md): one light line at most, the owl keeps
 * one eye open. Pass `plain` where an owl would be too much (small cards, secondary pages).
 */

import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty';
import { cn } from '../../lib/utils';
import { Owl } from './mascot';

export function EmptyState(props: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Hide the owl (e.g. inside a small card). */
  plain?: boolean;
  className?: string;
}) {
  return (
    <Card render={<section />} className={cn('overflow-hidden', props.className)}>
      <Empty className="py-12 sm:py-16">
        <EmptyHeader className="max-w-md">
          {props.plain ? null : (
            <EmptyMedia className="mb-3">
              <Owl pose="dozing" />
            </EmptyMedia>
          )}
          {/* coss EmptyTitle's look, as a real heading. */}
          <h2 data-slot="empty-title" className="font-heading text-title font-semibold">
            {props.title}
          </h2>
          {props.children ? <EmptyDescription className="mt-2 text-body text-pretty">{props.children}</EmptyDescription> : null}
        </EmptyHeader>
        {props.actions ? <EmptyContent className="flex-row flex-wrap justify-center gap-3">{props.actions}</EmptyContent> : null}
      </Empty>
    </Card>
  );
}
