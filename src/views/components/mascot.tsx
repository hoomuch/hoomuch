/**
 * Owl: the mascot, a small owl whose eyes are the logo's two rings. Owner: Experience (design).
 *
 * Rules (design/brief.md §4 Mascot):
 * - Five fixed poses, never more. It never speaks: no bubbles, no captions in its voice.
 * - Personality zones only: landing hero + footer, empty states, the first-sync moment, 404.
 *   Never in pricing, settings, connect forms, alerts, errors, 500 or destructive confirmations.
 * - Always decorative: alt="" and nothing depends on it.
 *
 * Files live in public/mascot at 2× the display size, with a recoloured *-dark.png picked by
 * prefers-color-scheme (same switch as the daisyUI themes). Size comes from width/height
 * attributes, not style="", so it passes the CSP.
 */

import { cx } from './ui';

export type OwlPose = 'perched' | 'dozing' | 'cheer' | 'lost' | 'asleep';

/** Display size in CSS px per pose; the PNGs are exported at exactly 2× this. */
export const OWL_SIZE: Record<OwlPose, number> = {
  perched: 80,
  dozing: 96,
  cheer: 64,
  lost: 120,
  asleep: 48,
};

export function Owl(props: {
  pose: OwlPose;
  /** Override the display size (CSS px). Stay at or below OWL_SIZE[pose] to keep it sharp. */
  size?: number;
  /** Literal classes for the <picture> wrapper (placement, opacity). */
  class?: string;
  /** Above-the-fold use: load eagerly. Everything else is lazy. */
  eager?: boolean;
}) {
  const size = props.size ?? OWL_SIZE[props.pose];
  return (
    // w-fit: a block <picture> is otherwise full-width, and `mx-auto` couldn't centre it.
    <picture class={cx('block w-fit shrink-0', props.class)}>
      <source srcset={`/mascot/${props.pose}-dark.png`} media="(prefers-color-scheme: dark)" />
      <img
        src={`/mascot/${props.pose}.png`}
        width={size}
        height={size}
        alt=""
        loading={props.eager ? undefined : 'lazy'}
        decoding="async"
        class="block select-none"
        draggable="false"
      />
    </picture>
  );
}
