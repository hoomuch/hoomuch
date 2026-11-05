/**
 * Flash message area (one-shot cookie message from a PRG redirect). Owner: Experience (design).
 * CONTRACT: props are fixed.
 *
 * A coss alert (via ToneBox) with a tone icon. It drops in with CSS (`fade-in`, so it works
 * before hydration) and, once the page is interactive, can be dismissed: it fades back up the way
 * it came while its row closes, so the page below slides up instead of jumping, then it leaves
 * the page. One CSS transition (grid rows 1fr → 0fr, margin, opacity, translate), all 150ms, a
 * little faster than it arrived, so the first transitionend means it's done; a timer removes it
 * anyway if no transitionend comes (transitions turned off by a user stylesheet). Under reduced
 * motion only the fade runs and the row closes after it. No Motion here: the layout carries it
 * on every page. Errors use role="alert", everything else role="status" (polite).
 */

import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Flash as FlashMsg } from '../../env';
import { cn } from '../../lib/utils';
import { LinkSubmit, ToneBox } from './ui';

export function Flash(props: { flash: FlashMsg | null }) {
  const f = props.flash;
  const [state, setState] = useState<'open' | 'closing' | 'closed'>('open');
  useEffect(() => {
    if (state !== 'closing') return;
    // Never leave an invisible message (and its Dismiss button) in the tab order.
    const t = window.setTimeout(() => setState('closed'), 400);
    return () => window.clearTimeout(t);
  }, [state]);
  if (!f || state === 'closed') return null;
  return (
    <div
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && state === 'closing') setState('closed');
      }}
      className={cn(
        'fade-in mb-6 grid grid-rows-[1fr] transition-[grid-template-rows,margin,opacity,translate] duration-150 ease-out motion-reduce:transition-[opacity]',
        state === 'closing' && 'opacity-0 motion-safe:mb-0 motion-safe:grid-rows-[0fr] motion-safe:-translate-y-1',
      )}
    >
      {/* min-h-0 lets the row close; overflow is clipped only while it does, so focus rings show. */}
      <div className={cn('relative min-h-0', state === 'closing' && 'motion-safe:overflow-hidden')}>
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
          onClick={() => setState('closing')}
          className="absolute top-2 right-2 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground motion-safe:active:scale-95"
        >
          <X className="size-4" />
          <span className="sr-only">Dismiss message</span>
        </button>
      </div>
    </div>
  );
}
