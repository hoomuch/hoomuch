/**
 * Flash message area (one-shot cookie message from a PRG redirect). Owner: Experience (design).
 * CONTRACT: props are fixed.
 *
 * Calm by design: a tone icon and a faintly tinted border; the text itself stays ink.
 * Errors use role="alert", everything else role="status" (polite).
 */

import type { Flash as FlashMsg } from '../../env';
import { ToneBox } from './ui';

export function Flash(props: { flash: FlashMsg | null }) {
  const f = props.flash;
  if (!f) return null;
  return (
    <ToneBox tone={f.type} class="mb-6">
      {f.message}
    </ToneBox>
  );
}
