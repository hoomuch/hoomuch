/**
 * One confetti burst over the whole page, after sign-up. Owner: Experience (design).
 *
 * Drawn with Magic UI's <Confetti> (components/ui/confetti.tsx, canvas-confetti underneath).
 * The layout mounts this only when the request carried the one-shot celebrate cookie
 * (lib/flash.ts → setCelebrate), so it fires once and a reload doesn't repeat it.
 *
 * - Renders nothing on the server and on the first client render, so hydration matches; the
 *   confetti chunk is fetched after hydration, so no other page pays for it.
 * - CSP: canvas-confetti's default off-thread worker is a blob: URL, which `script-src 'self'`
 *   blocks. It draws on the main thread instead (useWorker: false); one short burst is cheap.
 * - Reduced motion: no confetti at all (disableForReducedMotion).
 * - Decorative: aria-hidden, never takes a click, sits above everything and leaves no trace.
 */

import { useEffect, useState } from 'react';
import type { Options as ConfettiOptions, GlobalOptions as ConfettiGlobalOptions } from 'canvas-confetti';
import type { Confetti as ConfettiCanvas } from '@/components/ui/confetti';

/** Brand blue first, then success green, warning amber and Stripe's violet: cheerful, on brand. */
const COLORS = ['#0864cd', '#4f9cf0', '#137d41', '#f2b33d', '#635bff'];

const BURST: ConfettiOptions = {
  particleCount: 160,
  spread: 100,
  startVelocity: 50,
  ticks: 240,
  origin: { x: 0.5, y: 0.6 },
  colors: COLORS,
};

const GLOBAL: ConfettiGlobalOptions = { resize: true, useWorker: false, disableForReducedMotion: true };

export function Celebration() {
  const [Confetti, setConfetti] = useState<typeof ConfettiCanvas | null>(null);
  useEffect(() => {
    let live = true;
    void import('@/components/ui/confetti').then((m) => {
      if (live) setConfetti(() => m.Confetti);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!Confetti) return null;
  return (
    <Confetti
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[100] size-full"
      options={BURST}
      globalOptions={GLOBAL}
    />
  );
}
