/**
 * A value to copy (a webhook URL, a badge's embed code): selectable as text without JavaScript, a
 * Copy button once hydrated. Owner: Experience (design).
 */

import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button as CossButton } from '@/components/ui/button';

/** How long "Copied" shows before the button reads "Copy" again. */
const COPIED_MS = 2000;

export function CopyField(props: { id: string; label: string; value: string }) {
  const [canCopy, setCanCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCanCopy(typeof navigator !== 'undefined' && Boolean(navigator.clipboard)), []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={props.id} className="sr-only">
        {props.label}
      </label>
      <input
        id={props.id}
        readOnly
        value={props.value}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        className="h-8.5 min-w-0 flex-1 rounded-lg border bg-muted/40 px-3 font-mono text-sm sm:h-7.5"
      />
      {canCopy ? (
        <CossButton
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(props.value).then(() => setCopied(true));
          }}
        >
          {copied ? (
            <>
              <Check />
              Copied
            </>
          ) : (
            'Copy'
          )}
        </CossButton>
      ) : null}
    </div>
  );
}
