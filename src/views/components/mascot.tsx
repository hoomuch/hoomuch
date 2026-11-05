/**
 * Owl: the mascot, a small owl whose eyes are the logo's two rings. Owner: Experience (design).
 *
 * Rules (design/brief.md §4 Mascot):
 * - Eight fixed poses, no others. It never speaks: no bubbles, no captions in its voice.
 * - Personality zones only: landing hero + footer, empty states, the first sync (running and
 *   done), the dashboard's MRR card while nothing in it is a warning, 404.
 *   Never in pricing, settings, connect forms, alerts, errors, 500 or destructive confirmations.
 * - Always decorative: alt="" and nothing depends on it. It never moves on a screen seen daily.
 *
 * Files live in public/mascot at 2× the display size, with a recoloured *-dark.png picked by
 * prefers-color-scheme (same switch as the theme). Size comes from width/height attributes.
 * Every pose shares one 1024 canvas: the owl is drawn at the same scale with its feet on the
 * same line, so poses can swap in place.
 */

import { cn } from '../../lib/utils';

export type OwlPose = 'perched' | 'dozing' | 'cheer' | 'lost' | 'asleep' | 'proud' | 'flag' | 'counting';

/** Display size in CSS px per pose; the PNGs are exported at exactly 2× this. */
export const OWL_SIZE: Record<OwlPose, number> = {
  perched: 80,
  dozing: 96,
  cheer: 64,
  lost: 120,
  asleep: 48,
  proud: 80,
  flag: 80,
  counting: 80,
};

export function Owl(props: {
  pose: OwlPose;
  /** Override the display size (CSS px). Stay at or below OWL_SIZE[pose] to keep it sharp. */
  size?: number;
  /** Literal classes for the <picture> wrapper (placement, opacity). */
  className?: string;
  /** Above-the-fold use: load eagerly. Everything else is lazy. */
  eager?: boolean;
}) {
  const size = props.size ?? OWL_SIZE[props.pose];
  return (
    // w-fit: a block <picture> is otherwise full-width, and `mx-auto` couldn't centre it.
    <picture className={cn('block w-fit shrink-0', props.className)}>
      <source srcSet={`/mascot/${props.pose}-dark.png`} media="(prefers-color-scheme: dark)" />
      <img
        src={`/mascot/${props.pose}.png`}
        width={size}
        height={size}
        alt=""
        loading={props.eager ? undefined : 'lazy'}
        decoding="async"
        className="block select-none"
        draggable={false}
      />
    </picture>
  );
}
