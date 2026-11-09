/**
 * A founder's photo and a product's logo, or their initials when there's none: on Share, the
 * public pages and Explore. Owner: Experience (design).
 *
 * Images come from this origin (/media/<key>, lib/media.ts), so the CSP's img-src 'self' allows
 * them. They're decorative (alt=""): the name always sits beside them.
 */

import { cn } from '../../lib/utils';

/** Up to two initials, for when there's no photo or logo. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : words;
  return letters.map((w) => [...w][0]!.toUpperCase()).join('').slice(0, 2) || '?';
}

/** A hairline drawn over the image's edge, so a white logo still reads as a tile on a white card. */
const IMAGE = 'shrink-0 bg-muted object-cover outline -outline-offset-1 outline-foreground/10';
const LETTERS = 'flex shrink-0 items-center justify-center bg-brand/12 font-semibold text-brand';

/** A person, round. Size and type come from `className`, e.g. "size-16 text-title". */
export function Avatar(props: { name: string; src?: string | null; className?: string }) {
  return <Tile name={props.name} src={props.src} className={cn('rounded-full', props.className)} />;
}

/** A product, a rounded square. Size, corners and type come from `className`. */
export function ProductTile(props: { name: string; src?: string | null; className?: string }) {
  return <Tile name={props.name} src={props.src} className={cn('rounded-xl', props.className)} />;
}

function Tile(props: { name: string; src?: string | null; className?: string }) {
  if (props.src) return <img src={props.src} alt="" loading="lazy" decoding="async" className={cn(IMAGE, props.className)} />;
  return (
    <span aria-hidden="true" className={cn(LETTERS, props.className)}>
      {initials(props.name)}
    </span>
  );
}
