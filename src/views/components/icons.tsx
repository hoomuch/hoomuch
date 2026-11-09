/**
 * The hoomuch mark and wordmark, and the brand marks Lucide doesn't ship. Owner: Experience (design).
 * Every other icon is Lucide (`lucide-react`), imported where it's used. Lucide icons are
 * aria-hidden by default: always pair them with text.
 */

/** GitHub's mark (Primer Octicons `mark-github`, MIT). aria-hidden: the link around it is labelled. */
export function GitHubMark(p: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={p.className}>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/** X's mark (Simple Icons `x`, CC0). aria-hidden: the link around it is labelled. */
export function XMark(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={p.className}>
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

/** LinkedIn's mark (Simple Icons `linkedin`, CC0). aria-hidden: the link around it is labelled. */
export function LinkedInMark(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={p.className}>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

/** Bluesky's butterfly (Simple Icons `bluesky`, CC0). aria-hidden: the link around it is labelled. */
export function BlueskyMark(p: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={p.className}>
      <path d="M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026" />
    </svg>
  );
}

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
