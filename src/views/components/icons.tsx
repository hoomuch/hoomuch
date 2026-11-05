/**
 * Small stroke icons (16-unit grid, 1.5 stroke, currentColor) and the hoomuch mark.
 * Owner: Experience (design). Always decorative: aria-hidden, so pair them with text.
 * Colour comes from a text-* class on the icon or its parent (CSP: no inline styles).
 */

import type { Child } from 'hono/jsx';

type IconProps = { class?: string };

function Svg(props: { class?: string; children?: Child }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class ?? 'size-4 shrink-0'}
    >
      {props.children}
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg class={p.class}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Svg>
  );
}

export function IconCheckCircle(p: IconProps) {
  return (
    <Svg class={p.class}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.5 8.25l1.75 1.75 3.25-3.75" />
    </Svg>
  );
}

export function IconErrorCircle(p: IconProps) {
  return (
    <Svg class={p.class}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75M8 11.25v.01" />
    </Svg>
  );
}

export function IconInfoCircle(p: IconProps) {
  return (
    <Svg class={p.class}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75v.01" />
    </Svg>
  );
}

export function IconWarning(p: IconProps) {
  return (
    <Svg class={p.class}>
      <path d="M7.13 2.98a1 1 0 0 1 1.74 0l5.2 9.1a1 1 0 0 1-.87 1.5H2.8a1 1 0 0 1-.87-1.5z" />
      <path d="M8 6.25v3M8 11.5v.01" />
    </Svg>
  );
}

/** Three-quarter arc: "in progress". Spin it with motion-safe:animate-spin. */
export function IconSync(p: IconProps) {
  return (
    <Svg class={p.class}>
      <path d="M13.25 8A5.25 5.25 0 1 1 8 2.75" />
    </Svg>
  );
}

export function IconClock(p: IconProps) {
  return (
    <Svg class={p.class}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 5v3.25l2 1.25" />
    </Svg>
  );
}

export function IconArrowUp(p: IconProps) {
  return (
    <Svg class={p.class}>
      <path d="M8 12.75v-9.5M4.25 7 8 3.25 11.75 7" />
    </Svg>
  );
}

export function IconArrowDown(p: IconProps) {
  return (
    <Svg class={p.class}>
      <path d="M8 3.25v9.5M4.25 9 8 12.75 11.75 9" />
    </Svg>
  );
}

export function IconExternal(p: IconProps) {
  return (
    <Svg class={p.class}>
      <path d="M6.75 3.25h-3.5v9.5h9.5v-3.5M9.5 3.25h3.25V6.5M12.5 3.5 7.5 8.5" />
    </Svg>
  );
}

export function IconChevronLeft(p: IconProps) {
  return (
    <Svg class={p.class}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </Svg>
  );
}

/**
 * The hoomuch mark: two interlocking rings, ink + accent. Each crossing is cut by a band in
 * the page colour (5 units wide, so a 1-unit gap either side of the 3-unit stroke), then the ring
 * that passes "over" is redrawn a few degrees longer so the cut's ends never show as seams. The
 * cut arcs start and end inside the other ring's hole. Same geometry as public/favicon.svg.
 */
export function RingsMark(p: IconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke-width="3" aria-hidden="true" class={p.class ?? 'size-5 shrink-0'}>
      <RingPaths />
    </svg>
  );
}

/** The rings on the mark's 32-unit grid. Their ink box is 4–28 × 7.5–24.5 (24 × 17 units). */
function RingPaths() {
  return (
    <>
      <circle cx="12.5" cy="16" r="7" class="stroke-base-content" />
      <circle cx="19.5" cy="16" r="7" class="stroke-accent" />
      <path d="M19.5 16A7 7 0 0 1 9 22.06" stroke-width="5" class="stroke-base-100" />
      <path d="M19.47 15.39A7 7 0 0 1 8.49 21.73" class="stroke-base-content" />
      <path d="M12.5 16A7 7 0 0 1 23 9.94" stroke-width="5" class="stroke-base-100" />
      <path d="M12.53 16.61A7 7 0 0 1 23.52 10.27" class="stroke-accent" />
    </>
  );
}

/**
 * The wordmark: "h", the rings standing in for "oo", then "much". The letters are live system-font
 * text, so size and colour come from the surrounding text. The rings are sized in `ex` (the
 * rendering font's own x-height, plus the small overshoot a real "o" has above and below), so they
 * match the lowercase letters on SF Pro and Segoe UI alike. Their 3-unit stroke lands close to a
 * semibold stem: use it inside font-semibold.
 * Screen readers and copy/paste get the plain word from the sr-only span; the drawn version is
 * aria-hidden and select-none.
 */
export function Wordmark(p: { class?: string }) {
  return (
    <span class={p.class}>
      <span class="sr-only">hoomuch</span>
      <span aria-hidden="true" class="whitespace-nowrap select-none">
        h
        <svg
          viewBox="4 7.5 24 17"
          fill="none"
          stroke-width="3"
          class="mx-[0.03em] inline-block h-[1.06ex] w-[1.5ex] align-[-0.03ex]"
        >
          <RingPaths />
        </svg>
        much
      </span>
    </span>
  );
}
