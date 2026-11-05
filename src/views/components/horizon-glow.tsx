/**
 * A dotted sun rising behind the landing's live dashboard. Owner: Experience (design).
 *
 * Magic UI's Dither Field (components/ui/dither-field.tsx), a WebGL2 shader, on its "horizon"
 * pattern in brand blue; the pointer brightens the dots near it. Landing only: imported by the
 * landing page, never by the layout, so no other page downloads the shader.
 *
 * It draws only while near the viewport, pauses in background tabs, holds one still frame under
 * reduced motion, and falls back to CSS dots without WebGL2. Decorative: aria-hidden, behind the
 * content (-z-10), never takes a click. See views/components/backdrop.tsx for the rest of the light.
 */

import { DitherField } from '@/components/ui/dither-field';
import { cn } from '../../lib/utils';

/**
 * The field is a rectangle; an elliptical mask from the middle of its bottom edge fades it out
 * upwards and to both sides, so it reads as a glow with no edges, the pointer glow included.
 */
const SOFT_EDGES = '[mask-image:radial-gradient(ellipse_50%_100%_at_50%_100%,black_35%,transparent)]';

/** Position it with `className`; its bottom edge is the horizon (put it on the next box's top edge). */
export function HorizonGlow(props: { className?: string }) {
  return (
    <DitherField
      aria-hidden="true"
      pattern="horizon"
      color="var(--brand)"
      intensity={0.7}
      dotSize={2}
      className={cn('pointer-events-none absolute -z-10', SOFT_EDGES, props.className)}
    />
  );
}
