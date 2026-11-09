/**
 * RangeTabs: 7 days / 30 days / 90 days / 1 year links (`?range=`). Owner: Experience (design).
 * CONTRACT: existing props are fixed; new ones must be optional.
 *
 * A coss segmented control made of links (SegmentedLinks in ui.tsx explains the active state).
 */

import { RANGE_OPTIONS, type RangeDays } from '../../data/types';
import { SegmentedLinks } from './ui';

/** The tab's name: "30 days", or "1 year" for the 52-week window (its figures say "52 weeks"). */
function tabLabel(r: RangeDays): string {
  return r === 364 ? '1 year' : `${r} days`;
}

export function RangeTabs(props: {
  current: RangeDays;
  basePath?: string;
  /** Fragment to keep the reader in place after the reload, e.g. "demo" on the landing page. */
  anchor?: string;
  /** Query to carry over, e.g. "revenue=line" on the landing page, which doesn't remember choices. */
  keep?: string;
}) {
  const base = props.basePath ?? '/dashboard';
  const hash = props.anchor ? `#${props.anchor}` : '';
  const keep = props.keep ? `&${props.keep}` : '';
  return (
    <SegmentedLinks
      label="Date range"
      items={RANGE_OPTIONS.map((r) => ({
        key: String(r),
        href: `${base}?range=${r}${keep}${hash}`,
        current: r === props.current,
        label: (
          <>
            <span className="sr-only">Last </span>
            {tabLabel(r)}
          </>
        ),
      }))}
    />
  );
}
