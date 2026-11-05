/**
 * EmptyState: the dozing owl, a short message, primary actions. Owner: Experience (design).
 * CONTRACT: existing props are fixed; new ones must be optional.
 * Empty states are a personality zone (design/brief.md): one light line at most, the owl keeps
 * one eye open. Pass `plain` where an owl would be too much (small cards, secondary pages).
 */

import type { Child } from 'hono/jsx';
import { Owl } from './mascot';
import { cx } from './ui';

export function EmptyState(props: {
  title: string;
  children?: Child;
  actions?: Child;
  /** Hide the owl (e.g. inside a small card). */
  plain?: boolean;
  class?: string;
}) {
  return (
    <section class={cx('card card-border border-base-300', props.class)}>
      <div class="card-body items-center py-12 text-center sm:py-16">
        {props.plain ? null : <Owl pose="dozing" class="mb-3" />}
        <h2 class="text-title">{props.title}</h2>
        {props.children ? <div class="max-w-md text-pretty text-ink-2">{props.children}</div> : null}
        {props.actions ? <div class="card-actions mt-4 justify-center gap-3">{props.actions}</div> : null}
      </div>
    </section>
  );
}
