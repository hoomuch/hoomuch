/**
 * <time> with a relative label ("4 min ago") and the absolute UTC time as title/datetime.
 * Owner: Experience (design). CONTRACT: props are fixed.
 */

import { relativeTime } from '../../lib/time';

export function RelativeTime(props: { ms: number | null; now?: number; fallback?: string; class?: string }) {
  if (props.ms === null) return <span class={props.class}>{props.fallback ?? 'Never'}</span>;
  const iso = new Date(props.ms).toISOString();
  return (
    <time datetime={iso} title={iso.replace('T', ' ').slice(0, 16) + ' UTC'} class={props.class}>
      {relativeTime(props.ms, props.now)}
    </time>
  );
}
