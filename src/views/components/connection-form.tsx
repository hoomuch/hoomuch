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

import { Check, ExternalLink } from 'lucide-react';
import { Card, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { article } from '../../providers/registry';
import type { ProviderMeta } from '../../providers/types';
import { ProviderLogo } from './provider-logos';
import { Alert, Button, Field, FormError, LinkButton, TextLink } from './ui';

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
 * The key-creation steps + permission checklist, in a coss Card on the muted fill. Exported so
 * the landing page can show the real thing; `preview` makes it an <h3> and drops the outbound
 * "Open Stripe" link.
 */
export function KeyGuide(props: { meta: ProviderMeta; headingId: string; preview?: boolean }) {
  const { meta } = props;
  const Heading = props.preview ? 'h3' : 'h2';
  const Sub = props.preview ? 'h4' : 'h3';
  return (
    // A named <section> (region), not <aside>: the steps are part of the task, and a complementary
    // landmark nested inside <main> is flagged by axe (landmark-complementary-is-top-level).
    <Card render={<section aria-labelledby={props.headingId} />} className="bg-muted/60 text-body">
      <CardHeader className="px-5 pt-5 sm:px-6 sm:pt-6">
        <CardTitle render={<Heading id={props.headingId} />} className="flex items-center gap-2 text-base">
          <ProviderLogo provider={meta.id} size="md" />
          Create {article(meta.name)} {meta.name} key
        </CardTitle>
      </CardHeader>
      <CardPanel className="px-5 pb-5 sm:px-6 sm:pb-6">
        {meta.keySteps.length > 0 ? (
          <ol className="space-y-3">
            {meta.keySteps.map((step, i) => (
              <li key={step} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full border border-input bg-background text-caption leading-none font-semibold tabular-nums text-muted-foreground"
                >
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        ) : null}

        {meta.keyUrl && !props.preview ? (
          <p className="mt-4 pl-8">
            <TextLink href={meta.keyUrl} external className="inline-flex items-center gap-1">
              {meta.keyUrlLabel ?? `Open ${meta.name}`}
              <ExternalLink className="size-3.5 shrink-0" />
              <span className="sr-only"> (opens in a new tab)</span>
            </TextLink>
          </p>
        ) : null}

        {meta.permissions.length > 0 ? (
          <div className="mt-5 border-t pt-4">
            <Sub className="font-semibold">Permissions it needs</Sub>
            <ul className="mt-2 space-y-1.5">
              {meta.permissions.map((p) => (
                <li key={p} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-muted-foreground">hoomuch only makes read requests.</p>
          </div>
        ) : null}
      </CardPanel>
    </Card>
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
    <div className={hasGuide ? 'grid items-start gap-8 md:grid-cols-2 md:gap-10' : 'max-w-md'}>
      <form method="post" action={props.action} className="min-w-0">
        {showGuide && meta.warning ? (
          <Alert tone="warning" title="Before you paste the key" className="mb-6">
            {meta.warning}
          </Alert>
        ) : null}
        <FormError message={props.error} autoFocus={!firstInvalid && Boolean(props.error)} />
        {props.mode === 'create' ? <input type="hidden" name="provider" value={meta.id} /> : null}
        {props.mode === 'create' ? (
          <Field
            name="name"
            label="Name"
            value={values['name']}
            placeholder={meta.name}
            help="Shown on your dashboard. You can change it later."
            error={errors['name']}
            autoFocus={firstInvalid === 'name'}
            maxLength={60}
          />
        ) : null}
        {meta.fields.map((f) => (
          <Field
            key={f.name}
            name={f.name}
            label={f.label}
            type={f.type}
            // Secrets are never echoed back, whatever `values` holds.
            value={f.secret ? undefined : values[f.name]}
            placeholder={f.placeholder}
            help={f.help}
            error={errors[f.name]}
            autoFocus={firstInvalid === f.name}
            required={f.required}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            inputClassName={f.secret ? 'font-mono' : undefined}
          />
        ))}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {/* Verifying a key is a live call to the provider: a few seconds, so say what's happening. */}
          <Button busyLabel="Checking key…">{submitLabel(meta, props.mode)}</Button>
          {props.cancelHref ? (
            <LinkButton href={props.cancelHref} variant="ghost">
              Cancel
            </LinkButton>
          ) : null}
        </div>
        {hasSecret ? (
          <p className="mt-3 text-muted-foreground">
            The key is checked with {meta.name} before it’s saved, then stored encrypted with AES-256-GCM.
          </p>
        ) : null}
      </form>
      {hasGuide ? <KeyGuide meta={meta} headingId={`${meta.id}-key-guide`} /> : null}
    </div>
  );
}
