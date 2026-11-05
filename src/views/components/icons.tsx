/**
 * The hoomuch mark and wordmark. Owner: Experience (design).
 * Every other icon is Lucide (`lucide-react`), imported where it's used. Lucide icons are
 * aria-hidden by default: always pair them with text.
 */

/**
 * The hoomuch mark: two interlocking rings, ink + brand blue. Each crossing is cut by a band in
 * the page colour (5 units wide, so a 1-unit gap either side of the 3-unit stroke), then the ring
 * that passes "over" is redrawn a few degrees longer so the cut's ends never show as seams. The
 * cut arcs start and end inside the other ring's hole. Same geometry as public/favicon.svg.
 */
export function RingsMark(p: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" strokeWidth="3" aria-hidden="true" className={p.className ?? 'size-5 shrink-0'}>
      <RingPaths />
    </svg>
  );
}

/** The rings on the mark's 32-unit grid. Their ink box is 4–28 × 7.5–24.5 (24 × 17 units). */
function RingPaths() {
  return (
    <>
      <circle cx="12.5" cy="16" r="7" className="stroke-foreground" />
      <circle cx="19.5" cy="16" r="7" className="stroke-brand" />
      <path d="M19.5 16A7 7 0 0 1 9 22.06" strokeWidth="5" className="stroke-background" />
      <path d="M19.47 15.39A7 7 0 0 1 8.49 21.73" className="stroke-foreground" />
      <path d="M12.5 16A7 7 0 0 1 23 9.94" strokeWidth="5" className="stroke-background" />
      <path d="M12.53 16.61A7 7 0 0 1 23.52 10.27" className="stroke-brand" />
    </>
  );
}

/**
 * The wordmark: "h", the rings standing in for "oo", then "much". The letters are live Geist
 * text, so size and colour come from the surrounding text. The rings are sized in `ex` (the
 * font's own x-height, plus the small overshoot a real "o" has above and below), so they match the
 * lowercase letters. Their 3-unit stroke lands close to a semibold stem: use it inside
 * font-semibold.
 * Screen readers and copy/paste get the plain word from the sr-only span; the drawn version is
 * aria-hidden and select-none.
 */
export function Wordmark(p: { className?: string }) {
  return (
    <span className={p.className}>
      <span className="sr-only">hoomuch</span>
      <span aria-hidden="true" className="whitespace-nowrap select-none">
        h
        <svg
          viewBox="4 7.5 24 17"
          fill="none"
          strokeWidth="3"
          className="mx-[0.03em] inline-block h-[1.06ex] w-[1.5ex] align-[-0.03ex]"
        >
          <RingPaths />
        </svg>
        much
      </span>
    </span>
  );
}
