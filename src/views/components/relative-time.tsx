/**
 * <time> with a relative label ("4 min ago") and the absolute UTC time as title/datetime.
 * Owner: Experience (design). CONTRACT: props are fixed.
 * Without `now` it uses the request's clock (useNow), so server and browser agree on the label.
 */

import { relativeTime } from '../../lib/time';
import { useNow } from '../page-root';

export function RelativeTime(props: { ms: number | null; now?: number; fallback?: string; className?: string }) {
  const requestNow = useNow();
  if (props.ms === null) return <span className={props.className}>{props.fallback ?? 'Never'}</span>;
  const iso = new Date(props.ms).toISOString();
  return (
    <time dateTime={iso} title={iso.replace('T', ' ').slice(0, 16) + ' UTC'} className={props.className}>
      {relativeTime(props.ms, props.now ?? requestNow)}
    </time>
  );
}
