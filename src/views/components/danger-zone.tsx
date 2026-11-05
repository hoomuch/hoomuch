/** DangerZone: a daisyUI card with an error-toned border, for destructive forms. Owner: Experience (design). CONTRACT: props are fixed. */

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
    <section aria-labelledby={headingId} class="card card-border border-error/40">
      <div class="card-body">
        <h2 id={headingId} class="card-title text-error">
          <IconWarning class="size-4 shrink-0" />
          {props.title}
        </h2>
        {props.description ? <p class="max-w-prose text-ink-2">{props.description}</p> : null}
        {props.children ? <div class="mt-3">{props.children}</div> : null}
      </div>
    </section>
  );
}
