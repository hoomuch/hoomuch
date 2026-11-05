/**
 * ConnectionForm: dynamic add / rotate-key form driven by ProviderMeta.fields, with the
 * key-creation steps, the permission checklist and the provider warning.
 * Owner: Experience (design). CONTRACT: props are fixed.
 *
 * Layout: form left, guide right at md+; stacked (form first) below. The provider warning sits
 * at the top of the form column so it's read before the key is pasted.
 *
 * Security: secret fields are NEVER pre-filled, even on a validation error.
 */

import type { ProviderMeta } from '../../providers/types';
import { Alert, Button, Field, FormError, LinkButton } from './ui';
import { ProviderDot } from './badges';
import { IconCheck, IconExternal } from './icons';

export interface ConnectionFormProps {
  meta: ProviderMeta;
  /** 'create' posts provider + name + fields; 'rotate' posts only the fields. */
  mode: 'create' | 'rotate';
  /** Form action URL, e.g. "/connections" or "/connections/<id>/rotate". */
  action: string;
  /** Previously submitted NON-SECRET values (name, storeId, projectId…). */
  values?: Record<string, string>;
  fieldErrors?: Record<string, string>;
  /** Form-level error message. */
  error?: string | null;
  /** Show the steps/permissions/warning panel (default true for create, false for rotate). */
  showGuide?: boolean;
  /** Adds a quiet "Cancel" link next to the submit button. */
  cancelHref?: string;
}

function submitLabel(meta: ProviderMeta, mode: 'create' | 'rotate'): string {
  if (mode === 'rotate') return 'Replace key';
  return meta.fields.length > 0 ? `Connect ${meta.name}` : `Add ${meta.name.toLowerCase()}`;
}

/**
 * The key-creation steps + permission checklist. Exported so the landing page can show the real
 * thing; `preview` makes it an <h3> and drops the outbound "Open Stripe" link.
 */
export function KeyGuide(props: { meta: ProviderMeta; headingId: string; preview?: boolean }) {
  const { meta } = props;
  const Heading = props.preview ? 'h3' : 'h2';
  const Sub = props.preview ? 'h4' : 'h3';
  return (
    // A named <section> (region), not <aside>: the steps are part of the task, and a complementary
    // landmark nested inside <main> is flagged by axe (landmark-complementary-is-top-level).
    <section aria-labelledby={props.headingId} class="card card-border border-base-300 bg-base-200">
      <div class="card-body">
      <Heading id={props.headingId} class="card-title">
        <ProviderDot dotClass={meta.dotClass} size="md" />
        Create a {meta.name} key
      </Heading>

      {meta.keySteps.length > 0 ? (
        <ol class="mt-4 space-y-3">
          {meta.keySteps.map((step, i) => (
            <li class="flex gap-3">
              <span
                aria-hidden="true"
                class="flex size-5 shrink-0 items-center justify-center rounded-full border border-field text-caption leading-none font-semibold tabular-nums text-ink-2"
              >
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {meta.keyUrl && !props.preview ? (
        <p class="mt-4 pl-8">
          <a href={meta.keyUrl} rel="noopener noreferrer" target="_blank" class="link link-accent inline-flex items-center gap-1 font-semibold">
            Open {meta.name}
            <IconExternal class="size-3.5 shrink-0" />
            <span class="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      ) : null}

      {meta.permissions.length > 0 ? (
        <div class="mt-5 border-t border-base-300 pt-4">
          <Sub class="font-semibold">Permissions it needs</Sub>
          <ul class="mt-2 space-y-1.5">
            {meta.permissions.map((p) => (
              <li class="flex items-start gap-2">
                <IconCheck class="mt-0.5 size-4 shrink-0 text-ink-2" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <p class="mt-3 text-ink-2">hoomuch only makes read requests.</p>
        </div>
      ) : null}
      </div>
    </section>
  );
}

export function ConnectionForm(props: ConnectionFormProps) {
  const { meta } = props;
  const values = props.values ?? {};
  const errors = props.fieldErrors ?? {};
  const showGuide = props.showGuide ?? props.mode === 'create';
  const hasGuide = showGuide && (meta.keySteps.length > 0 || meta.permissions.length > 0);
  const hasSecret = meta.fields.some((f) => f.secret);
  // After a failed submit, focus the first field with an error (document order), else the
  // form-level message. Only one autofocus per page, and only when there is an error.
  const fieldOrder = [...(props.mode === 'create' ? ['name'] : []), ...meta.fields.map((f) => f.name)];
  const firstInvalid = fieldOrder.find((n) => errors[n]);

  return (
    <div class={hasGuide ? 'grid items-start gap-8 md:grid-cols-2 md:gap-10' : 'max-w-md'}>
      <form method="post" action={props.action} class="min-w-0">
        {showGuide && meta.warning ? (
          <Alert tone="warning" title="Before you paste the key" class="mb-6">
            {meta.warning}
          </Alert>
        ) : null}
        <FormError message={props.error} autofocus={!firstInvalid && Boolean(props.error)} />
        {props.mode === 'create' ? <input type="hidden" name="provider" value={meta.id} /> : null}
        {props.mode === 'create' ? (
          <Field
            name="name"
            label="Name"
            value={values['name']}
            placeholder={meta.name}
            help="Shown on your dashboard. You can change it later."
            error={errors['name']}
            autofocus={firstInvalid === 'name'}
            maxlength={60}
          />
        ) : null}
        {meta.fields.map((f) => (
          <Field
            name={f.name}
            label={f.label}
            type={f.type}
            // Secrets are never echoed back, whatever `values` holds.
            value={f.secret ? undefined : values[f.name]}
            placeholder={f.placeholder}
            help={f.help}
            error={errors[f.name]}
            autofocus={firstInvalid === f.name}
            required={f.required}
            autocomplete="off"
            spellcheck={false}
            autocapitalize="off"
            inputClass={f.secret ? 'font-mono' : undefined}
          />
        ))}
        <div class="mt-6 flex flex-wrap items-center gap-3">
          {/* Verifying a key is a live call to the provider: a few seconds, so say what's happening. */}
          <Button busyLabel="Checking key…">{submitLabel(meta, props.mode)}</Button>
          {props.cancelHref ? (
            <LinkButton href={props.cancelHref} variant="ghost">
              Cancel
            </LinkButton>
          ) : null}
        </div>
        {hasSecret ? (
          <p class="mt-3 text-ink-2">
            The key is checked with {meta.name} before it’s saved, then stored encrypted with AES-256-GCM.
          </p>
        ) : null}
      </form>
      {hasGuide ? <KeyGuide meta={meta} headingId={`${meta.id}-key-guide`} /> : null}
    </div>
  );
}
