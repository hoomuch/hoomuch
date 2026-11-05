/**
 * RangeTabs: 7 / 30 / 90 day links (`?range=`), zero JS. Owner: Experience (design).
 * CONTRACT: existing props are fixed; new ones must be optional.
 *
 * A segmented control made of links. The selected segment carries aria-current="page" and a
 * 3:1 border (--color-field) plus ink text, so the state never relies on the fill alone.
 */

import { RANGE_OPTIONS, type RangeDays } from '../../data/types';

const SEGMENT =
  'block rounded-[calc(var(--radius-field)-3px)] border border-transparent px-3 py-1 text-body whitespace-nowrap tabular-nums text-ink-2 hover:text-base-content aria-[current=page]:border-field aria-[current=page]:bg-base-100 aria-[current=page]:text-base-content';

export function RangeTabs(props: {
  current: RangeDays;
  basePath?: string;
  /** Fragment to keep the reader in place after the reload, e.g. "demo" on the landing page. */
  anchor?: string;
}) {
  const base = props.basePath ?? '/dashboard';
  const hash = props.anchor ? `#${props.anchor}` : '';
  return (
    <nav aria-label="Date range">
      <ul class="inline-flex gap-0.5 rounded-field border border-base-300 bg-base-200 p-0.5">
        {RANGE_OPTIONS.map((r) => (
          <li>
            <a href={`${base}?range=${r}${hash}`} aria-current={r === props.current ? 'page' : undefined} class={SEGMENT}>
              <span class="sr-only">Last </span>
              {r} days
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
