/**
 * Flash message area (one-shot cookie message from a PRG redirect). Owner: Experience (design).
 * CONTRACT: props are fixed.
 *
 * A coss alert (via ToneBox) with a tone icon. It fades in with CSS (so it works before
 * hydration) and, once the page is interactive, can be dismissed: it fades out with a CSS
 * transition, then leaves the page. No Motion here: the layout carries it on every page, and a
 * fade doesn't need it. Errors use role="alert", everything else role="status" (polite).
 */

import { X } from 'lucide-react';
import { useState } from 'react';
import type { Flash as FlashMsg } from '../../env';
import { cn } from '../../lib/utils';
import { LinkSubmit, ToneBox } from './ui';

export function Flash(props: { flash: FlashMsg | null }) {
  const f = props.flash;
  const [state, setState] = useState<'open' | 'closing' | 'closed'>('open');
  if (!f || state === 'closed') return null;
  return (
    <div
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && state === 'closing') setState('closed');
      }}
      className={cn(
        'fade-in relative mb-6 transition-opacity duration-150 ease-(--ease-standard) motion-reduce:transition-none',
        state === 'closing' && 'opacity-0',
      )}
    >
      <ToneBox tone={f.type} className="pr-10">
        {f.message}
        {f.undo ? (
          <>
            {' '}
            {/* A plain form: the Undo works before hydration and goes through the CSRF check. */}
            <form method="post" action={f.undo.action} className="inline">
              <LinkSubmit>{f.undo.label}</LinkSubmit>
            </form>
          </>
        ) : null}
      </ToneBox>
      <button
        type="button"
        onClick={() =>
          // Reduced motion has no transition to wait for (and no transitionend), so it goes at once.
          setState(window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'closed' : 'closing')
        }
        className="absolute top-2 right-2 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" />
        <span className="sr-only">Dismiss message</span>
      </button>
    </div>
  );
}
