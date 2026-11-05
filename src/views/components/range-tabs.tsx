/**
 * RangeTabs: 7 / 30 / 90 day links (`?range=`). Owner: Experience (design).
 * CONTRACT: existing props are fixed; new ones must be optional.
 *
 * A coss segmented control made of links (SegmentedLinks in ui.tsx explains the active state).
 */

import { RANGE_OPTIONS, type RangeDays } from '../../data/types';
import { SegmentedLinks } from './ui';

export function RangeTabs(props: {
  current: RangeDays;
  basePath?: string;
  /** Fragment to keep the reader in place after the reload, e.g. "demo" on the landing page. */
  anchor?: string;
}) {
  const base = props.basePath ?? '/dashboard';
  const hash = props.anchor ? `#${props.anchor}` : '';
  return (
    <SegmentedLinks
      label="Date range"
      items={RANGE_OPTIONS.map((r) => ({
        key: String(r),
        href: `${base}?range=${r}${hash}`,
        current: r === props.current,
        label: (
          <>
            <span className="sr-only">Last </span>
            {r} days
          </>
        ),
      }))}
    />
  );
}
