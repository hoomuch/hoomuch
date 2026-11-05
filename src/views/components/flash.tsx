/**
 * Flash message area (one-shot cookie message from a PRG redirect). Owner: Experience (design).
 * CONTRACT: props are fixed.
 *
 * A daisyUI soft alert (via ToneBox): a tone icon and a faint tint; the text itself stays ink. It
 * fades in over --dur-base, the only motion it has.
 * Errors use role="alert", everything else role="status" (polite).
 */

import type { Flash as FlashMsg } from '../../env';
import { ToneBox } from './ui';

export function Flash(props: { flash: FlashMsg | null }) {
  const f = props.flash;
  if (!f) return null;
  return (
    <ToneBox tone={f.type} class="fade-in mb-6">
      {f.message}
      {f.undo ? (
        <>
          {' '}
          {/* A plain form: the Undo works without JavaScript and goes through the CSRF check. */}
          <form method="post" action={f.undo.action} class="inline">
            <button type="submit" class="link link-accent font-semibold">
              {f.undo.label}
            </button>
          </form>
        </>
      ) : null}
    </ToneBox>
  );
}
