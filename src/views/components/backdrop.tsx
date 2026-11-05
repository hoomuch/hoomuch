/**
 * Ray light, grain and a dithered shader behind the top of a page. Owner: Experience (design).
 *
 * Built from Magic UI: Light Rays (components/ui/light-rays.tsx), Noise Texture
 * (noise-texture.tsx) and Dither Field (dither-field.tsx, a WebGL2 shader). Those files are
 * Magic UI's own; everything hoomuch-specific lives here.
 *
 * How much it moves follows how often the page is seen (design/system.md §3.6):
 * - <HeroBackdrop> (landing, 404: seen once). Still rays and grain are in the server HTML, then
 *   Magic UI's drifting rays fade in over them after hydration (their chunk, with Motion, loads
 *   only here). Reduced motion keeps the still ones.
 * - <QuietBackdrop> (dashboard: seen every day). The same rays and grain, dimmer and still. CSS
 *   only, no JavaScript. It sits behind the page header; cards are opaque, so it never tints data.
 * - <HorizonGlow> (landing demo, horizon-glow.tsx): the Dither Field shader. Kept in its own
 *   file so the layout, which imports this one, never pulls the shader into other pages.
 *
 * All of it is decorative: aria-hidden, never takes a click, painted behind the content (-z-10).
 * Colours come from --brand, so light and dark mode follow the theme.
 * CSP: inline styles only (style-src allows them); no scripts, workers or remote assets.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import type { LightRays as LightRaysComponent } from '@/components/ui/light-rays';
import { NoiseTexture } from '@/components/ui/noise-texture';
import { cn } from '../../lib/utils';

/** Brand blue at a given strength, as one CSS colour (theme-aware through --brand). */
const brand = (pct: number) => `color-mix(in srgb, var(--brand) ${pct}%, transparent)`;

/**
 * Fixed rays, so the server and the browser draw the same thing. Left rays lean left and right
 * rays lean right, a fan from above. Same shape as Magic UI's rays: a blurred, rounded beam that
 * fades from the top.
 */
const RAYS = [
  { left: 12, rotate: 22, width: 220, opacity: 0.5 },
  { left: 26, rotate: 11, width: 170, opacity: 0.85 },
  { left: 40, rotate: 4, width: 260, opacity: 0.6 },
  { left: 55, rotate: -5, width: 190, opacity: 0.95 },
  { left: 69, rotate: -13, width: 240, opacity: 0.6 },
  { left: 86, rotate: -21, width: 200, opacity: 0.5 },
] as const;

function StillRays(props: { color: string; length: string }) {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {RAYS.map((r) => (
        <div
          key={r.left}
          className="absolute -top-[12%] origin-top -translate-x-1/2 rounded-full bg-linear-to-b from-(--rays-color) to-transparent blur-[36px]"
          style={
            {
              '--rays-color': props.color,
              left: `${r.left}%`,
              width: r.width,
              height: props.length,
              rotate: `${r.rotate}deg`,
              opacity: r.opacity,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * Film grain over the light: full-range grey noise, soft-light blended, so it lightens and darkens
 * whatever is under it in both themes. The parent paints the page colour, so there is always
 * something to blend with.
 */
function Grain(props: { className?: string }) {
  return (
    <NoiseTexture
      frequency={0.7}
      octaves={3}
      slope={1}
      noiseOpacity={1}
      className={cn('mix-blend-soft-light opacity-60 dark:opacity-70', props.className)}
    />
  );
}

/** The light from above, as one soft ellipse behind the rays. */
function TopGlow(props: { strength: number }) {
  return (
    <div
      className="absolute inset-0"
      style={{ background: `radial-gradient(60rem 28rem at 50% -6rem, ${brand(props.strength)}, transparent 70%)` }}
    />
  );
}

/** Magic UI's animated Light Rays, loaded after hydration and only when motion is welcome. */
function DriftingRays() {
  const [Rays, setRays] = useState<typeof LightRaysComponent | null>(null);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let live = true;
    void import('@/components/ui/light-rays').then((m) => {
      if (live) setRays(() => m.LightRays);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!Rays) return null;
  return (
    <Rays
      className="animate-[fade_1.2s_ease-out_backwards]"
      color={brand(30)}
      count={6}
      blur={40}
      speed={16}
      length="36rem"
    />
  );
}

/**
 * The page colour first (so the grain has something to blend with), then the light, then the
 * grain; the whole stack fades out downwards so it ends without an edge.
 */
const STACK =
  'pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-hidden bg-background [mask-image:linear-gradient(to_bottom,black_45%,transparent)]';

/** Landing and 404: the hero light. Replaces the old flat radial glow. */
export function HeroBackdrop() {
  return (
    <div aria-hidden="true" className={cn(STACK, 'h-[42rem]')}>
      <TopGlow strength={16} />
      <StillRays color={brand(22)} length="34rem" />
      <DriftingRays />
      <Grain className="[mask-image:radial-gradient(64rem_30rem_at_50%_-4rem,black,transparent_75%)]" />
    </div>
  );
}

/** Dashboard: the same light, still and dimmer, ending above the first card's middle. */
export function QuietBackdrop() {
  return (
    <div aria-hidden="true" className={cn(STACK, 'h-[24rem]')}>
      <TopGlow strength={12} />
      <StillRays color={brand(16)} length="22rem" />
      <Grain className="opacity-45 dark:opacity-55 [mask-image:radial-gradient(56rem_20rem_at_50%_-4rem,black,transparent_75%)]" />
    </div>
  );
}
