/**
 * <time> with a relative label ("4 min ago"), the absolute time in the user's zone as its title and
 * the ISO instant as its datetime.
 * Owner: Experience (design). CONTRACT: props are fixed.
 * Without `now` it uses the request's clock (useNow), so server and browser agree on the label.
 */

import { relativeTime } from '../../lib/time';
import { useNow, useTimeZone } from '../page-root';
import { formatDateTime, zoneName } from '../pages/shared';

export function RelativeTime(props: { ms: number | null; now?: number; fallback?: string; className?: string }) {
  const requestNow = useNow();
  const tz = useTimeZone();
  if (props.ms === null) return <span className={props.className}>{props.fallback ?? 'Never'}</span>;
  const iso = new Date(props.ms).toISOString();
  return (
    <time dateTime={iso} title={`${formatDateTime(props.ms, tz)} ${zoneName(tz)}`} className={props.className}>
      {relativeTime(props.ms, props.now ?? requestNow)}
    </time>
  );
}
