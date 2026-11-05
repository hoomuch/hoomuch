/** DangerZone: bordered box for destructive forms. Owner: Experience (design). CONTRACT: props are fixed. */

import type { Child } from 'hono/jsx';
import { IconWarning } from './icons';

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function DangerZone(props: { title: string; description?: Child; children?: Child; id?: string }) {
  const headingId = `${(props.id ?? slug(props.title)) || 'danger'}-title`;
  return (
    <section aria-labelledby={headingId} class="rounded-box border border-error/40 p-5 sm:p-6">
      <h2 id={headingId} class="flex items-center gap-2 font-semibold text-error">
        <IconWarning class="size-4 shrink-0" />
        {props.title}
      </h2>
      {props.description ? <p class="mt-1.5 max-w-prose text-body text-ink-2">{props.description}</p> : null}
      {props.children ? <div class="mt-5">{props.children}</div> : null}
    </section>
  );
}
