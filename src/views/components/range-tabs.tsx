/**
 * RangeTabs: 7 / 30 / 90 day links (`?range=`), zero JS. Owner: Experience (design).
 * CONTRACT: existing props are fixed; new ones must be optional.
 *
 * daisyUI boxed tabs made of links (BOX_TAB in ui.tsx explains the active state).
 */

import { RANGE_OPTIONS, type RangeDays } from '../../data/types';
import { BOX_TAB } from './ui';

export function RangeTabs(props: {
  current: RangeDays;
  basePath?: string;
  /** Fragment to keep the reader in place after the reload, e.g. "demo" on the landing page. */
  anchor?: string;
}) {
  const base = props.basePath ?? '/dashboard';
  const hash = props.anchor ? `#${props.anchor}` : '';
  return (
    <nav aria-label="Date range" class="tabs tabs-box tabs-sm flex-nowrap border border-base-300">
      {RANGE_OPTIONS.map((r) => (
        <a href={`${base}?range=${r}${hash}`} aria-current={r === props.current ? 'page' : undefined} class={BOX_TAB}>
          <span class="sr-only">Last </span>
          {r} days
        </a>
      ))}
    </nav>
  );
}
