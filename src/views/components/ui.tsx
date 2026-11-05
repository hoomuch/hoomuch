/**
 * Base UI primitives shared by every page. Owner: Experience (design).
 * CONTRACT: exported names and props are used by pages — add props freely, don't remove or rename.
 *
 * Tailwind rule: class names must be complete literal strings (the scanner can't see
 * concatenated fragments). Pick from literal maps, never `btn-${variant}`.
 */

import type { Child } from 'hono/jsx';
import { IconCheckCircle, IconChevronLeft, IconErrorCircle, IconInfoCircle, IconWarning } from './icons';

/** Joins literal class names, skipping empty ones. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------- page structure ----------

export function PageHeader(props: {
  title: string;
  description?: Child;
  actions?: Child;
  /** Small "‹ Connections" link above the title, for detail pages. */
  back?: { href: string; label: string };
}) {
  return (
    <div class="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div class="min-w-0">
        {props.back ? (
          <a
            href={props.back.href}
            class="-ml-1 mb-2 inline-flex items-center gap-0.5 rounded-field pr-1 text-body text-ink-2 hover:text-base-content"
          >
            <IconChevronLeft class="size-4 shrink-0" />
            {props.back.label}
          </a>
        ) : null}
        {/* wrap-break-word: a long unbroken connection name must wrap at 320px, not widen the page. */}
        <h1 class="text-title wrap-break-word">{props.title}</h1>
        {props.description ? <p class="mt-1.5 max-w-2xl text-ink-2">{props.description}</p> : null}
      </div>
      {props.actions ? <div class="flex flex-wrap items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}

/** Bordered section. `title` renders an <h2>. */
export function Card(props: {
  title?: string;
  description?: Child;
  actions?: Child;
  children?: Child;
  id?: string;
  /** Extra literal classes for the section, e.g. "md:col-span-2". */
  class?: string;
}) {
  return (
    <section id={props.id} class={cx('min-w-0 rounded-box border border-base-300 p-5 sm:p-6', props.class)}>
      {props.title ? (
        <div class="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div class="min-w-0">
            <h2 class="font-semibold">{props.title}</h2>
            {props.description ? <p class="mt-1 text-body text-ink-2">{props.description}</p> : null}
          </div>
          {props.actions ? <div class="flex flex-wrap items-center gap-2">{props.actions}</div> : null}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

// ---------- feedback ----------

export type Tone = 'info' | 'success' | 'warning' | 'error';

/** Tinted 1px border + whisper of tint. Text stays base-content, so contrast never depends on tone. */
const TONE_BOX: Record<Tone, string> = {
  info: 'border-info/40 bg-info/5',
  success: 'border-success/40 bg-success/5',
  warning: 'border-warning/50 bg-warning/5',
  error: 'border-error/40 bg-error/5',
};

/** Spoken before the message so colour + icon are never the only signal. */
const TONE_WORD: Record<Tone, string> = {
  info: 'Note:',
  success: 'Success:',
  warning: 'Warning:',
  error: 'Error:',
};

export function ToneIcon(props: { tone: Tone; class?: string }) {
  switch (props.tone) {
    case 'success':
      return <IconCheckCircle class={cx('size-4 shrink-0 text-success', props.class)} />;
    case 'warning':
      return <IconWarning class={cx('size-4 shrink-0 text-warning', props.class)} />;
    case 'error':
      return <IconErrorCircle class={cx('size-4 shrink-0 text-error', props.class)} />;
    default:
      return <IconInfoCircle class={cx('size-4 shrink-0 text-info', props.class)} />;
  }
}

/**
 * The shared message box behind Alert, Flash and FormError: tone icon, optional title, body.
 * role="alert" for errors (announced immediately), role="status" otherwise; pass role="none"
 * for static page content, which is read in order like any other text.
 * `autofocus` makes the box a programmatic focus target (tabindex="-1") and focuses it on load:
 * the zero-JS way to land a screen-reader user on a form's error after a failed submit.
 */
export function ToneBox(props: {
  tone: Tone;
  title?: Child;
  children?: Child;
  class?: string;
  role?: 'alert' | 'status' | 'none';
  id?: string;
  autofocus?: boolean;
}) {
  const role = props.role ?? (props.tone === 'error' ? 'alert' : 'status');
  return (
    <div
      id={props.id}
      role={role === 'none' ? undefined : role}
      tabindex={props.autofocus ? -1 : undefined}
      autofocus={props.autofocus || undefined}
      class={cx('flex items-start gap-3 rounded-box border px-4 py-3 text-body', TONE_BOX[props.tone], props.class)}
    >
      <ToneIcon tone={props.tone} class="mt-0.5" />
      <div class="min-w-0 flex-1">
        <span class="sr-only">{TONE_WORD[props.tone]} </span>
        {props.title ? <p class="font-semibold">{props.title}</p> : null}
        {props.children ? <div class={props.title ? 'mt-0.5 text-base-content' : undefined}>{props.children}</div> : null}
      </div>
    </div>
  );
}

/**
 * Inline, static message that is part of the page (warnings, "Last sync failed", the sync
 * notice). No live-region role by default: it's read in order, and a role="alert" that is
 * already in the markup on load makes some screen readers interrupt with it on every visit.
 * Flash and FormError (the result of an action) keep their roles.
 */
export function Alert(props: { tone?: Tone; title?: string; children?: Child; class?: string; role?: 'alert' | 'status' | 'none' }) {
  return (
    <ToneBox tone={props.tone ?? 'info'} title={props.title} class={props.class} role={props.role ?? 'none'}>
      {props.children}
    </ToneBox>
  );
}

// ---------- buttons ----------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * primary: ink, one per view. secondary: quiet bordered. ghost: text-only.
 * danger: calm until hovered (red text, fills red on hover); the final destructive click.
 */
const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn',
  ghost: 'btn btn-ghost',
  danger: 'btn text-error hover:border-error hover:bg-error hover:text-error-content',
};

function buttonClass(variant: ButtonVariant | undefined, small?: boolean, block?: boolean, extra?: string): string {
  return cx(BUTTON_CLASS[variant ?? 'primary'], small && 'btn-sm', block && 'btn-block', extra);
}

export function Button(props: {
  variant?: ButtonVariant;
  type?: 'submit' | 'button';
  name?: string;
  value?: string;
  small?: boolean;
  /** Full width (auth cards, mobile forms). */
  block?: boolean;
  disabled?: boolean;
  /** Submit a form elsewhere on the page. */
  form?: string;
  /** Extra literal classes. */
  class?: string;
  /**
   * Label while the form is on its way, e.g. "Checking key…" (shown by /app.js, with a spinner).
   * Worth it where the server takes seconds; other buttons just get the spinner.
   */
  busyLabel?: string;
  children?: Child;
}) {
  return (
    <button
      type={props.type ?? 'submit'}
      data-busy={props.busyLabel}
      name={props.name}
      value={props.value}
      form={props.form}
      disabled={props.disabled}
      class={buttonClass(props.variant, props.small, props.block, props.class)}
    >
      {props.children}
    </button>
  );
}

export function LinkButton(props: {
  href: string;
  variant?: ButtonVariant;
  small?: boolean;
  block?: boolean;
  class?: string;
  children?: Child;
}) {
  return (
    <a href={props.href} class={buttonClass(props.variant, props.small, props.block, props.class)}>
      {props.children}
    </a>
  );
}

// ---------- form fields ----------
// Every field: visible <label for>, help + error wired with aria-describedby, aria-invalid on error.

const LABEL = 'mb-1.5 block text-body font-semibold';
const HELP = 'mt-1.5 text-body text-ink-2';

function FieldError(props: { id: string; message: string }) {
  return (
    <p id={props.id} class="mt-1.5 flex items-start gap-1.5 text-body text-error">
      <IconErrorCircle class="mt-0.5 size-3.5 shrink-0" />
      <span>{props.message}</span>
    </p>
  );
}

function describedBy(...ids: (string | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(' ') || undefined;
}

export interface FieldProps {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password' | 'search' | 'url';
  /** Never pass secret values back into a field (password fields drop it regardless). */
  value?: string;
  placeholder?: string;
  help?: Child;
  error?: string;
  required?: boolean;
  autocomplete?: string;
  autofocus?: boolean;
  minlength?: number;
  maxlength?: number;
  /** Defaults to `name`. */
  id?: string;
  /** e.g. "font-mono" for API keys. */
  inputClass?: string;
  /** false for keys, IDs and emails. */
  spellcheck?: boolean;
  autocapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
  inputmode?: 'none' | 'text' | 'email' | 'url' | 'numeric' | 'decimal' | 'search';
  /** Hide the "(optional)" note on non-required fields. */
  hideOptional?: boolean;
}

export function Field(props: FieldProps) {
  const id = props.id ?? props.name;
  const helpId = props.help ? `${id}-help` : undefined;
  const errId = props.error ? `${id}-error` : undefined;
  const type = props.type ?? 'text';
  return (
    <div class="mb-5">
      <label for={id} class={LABEL}>
        {props.label}
        {props.required || props.hideOptional ? null : <span class="font-normal text-ink-3"> (optional)</span>}
      </label>
      <input
        id={id}
        name={props.name}
        type={type}
        value={type === 'password' ? undefined : props.value}
        placeholder={props.placeholder}
        required={props.required}
        autocomplete={props.autocomplete}
        autofocus={props.autofocus}
        minlength={props.minlength}
        maxlength={props.maxlength}
        spellcheck={props.spellcheck}
        autocapitalize={props.autocapitalize}
        inputmode={props.inputmode}
        aria-invalid={props.error ? 'true' : undefined}
        aria-describedby={describedBy(errId, helpId)}
        class={cx('input w-full', props.inputClass)}
      />
      {props.error && errId ? <FieldError id={errId} message={props.error} /> : null}
      {props.help ? (
        <p id={helpId} class={HELP}>
          {props.help}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField(props: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  value?: string;
  help?: Child;
  error?: string;
  id?: string;
  required?: boolean;
  autocomplete?: string;
}) {
  const id = props.id ?? props.name;
  const helpId = props.help ? `${id}-help` : undefined;
  const errId = props.error ? `${id}-error` : undefined;
  return (
    <div class="mb-5">
      <label for={id} class={LABEL}>
        {props.label}
      </label>
      <select
        id={id}
        name={props.name}
        required={props.required}
        autocomplete={props.autocomplete}
        aria-invalid={props.error ? 'true' : undefined}
        aria-describedby={describedBy(errId, helpId)}
        class="select w-full"
      >
        {props.options.map((o) => (
          <option value={o.value} selected={o.value === props.value}>
            {o.label}
          </option>
        ))}
      </select>
      {props.error && errId ? <FieldError id={errId} message={props.error} /> : null}
      {props.help ? (
        <p id={helpId} class={HELP}>
          {props.help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A required confirmation checkbox for destructive actions. The whole label is the click target,
 * so the 16px box still meets the 24×24 target size (WCAG 2.5.8).
 */
export function ConfirmCheckbox(props: { name?: string; label: Child; error?: string; id?: string; autofocus?: boolean }) {
  const name = props.name ?? 'confirm';
  const id = props.id ?? name;
  const errId = props.error ? `${id}-error` : undefined;
  return (
    <div class="mb-5">
      <label for={id} class="flex cursor-pointer items-start gap-2.5 text-body">
        <input
          id={id}
          type="checkbox"
          name={name}
          value="yes"
          required
          autofocus={props.autofocus}
          // Explicit "false": Chromium otherwise exposes an untouched required checkbox as invalid
          // (native :invalid), so screen readers say "invalid entry" before anything was submitted.
          aria-invalid={props.error ? 'true' : 'false'}
          aria-describedby={errId}
          class="checkbox checkbox-sm mt-0.5"
        />
        <span>{props.label}</span>
      </label>
      {props.error && errId ? <FieldError id={errId} message={props.error} /> : null}
    </div>
  );
}

/**
 * Form-level error summary shown above the fields. Pass `autofocus` when no field carries the
 * error (e.g. "Email or password is incorrect"), so focus lands on the message after the
 * re-rendered POST; when a field has the error, autofocus that field instead.
 */
export function FormError(props: { message?: string | null; title?: string; autofocus?: boolean; id?: string }) {
  if (!props.message) return null;
  return (
    <ToneBox tone="error" title={props.title} class="mb-5" id={props.id} autofocus={props.autofocus}>
      {props.message}
    </ToneBox>
  );
}

// ---------- tables ----------

/**
 * Horizontal scroller for a table that may be wider than a phone (WCAG 1.4.10: the table
 * scrolls, never the page).
 *  - Focusable and named by the table's caption, so keyboard users can scroll it with the
 *    arrow keys (2.1.1) and screen readers announce what the stop is.
 *  - `relative` makes it the containing block for sr-only text inside the table; without it,
 *    those absolutely positioned spans escape the scroller and widen the page.
 *  - Links inside need nothing extra: the table's first column is flush, but the provider dot
 *    or the scroller's own padding leaves room for the outset focus ring.
 */
export function TableScroller(props: { labelledBy?: string; label?: string; class?: string; children?: Child }) {
  return (
    <div
      role="region"
      aria-labelledby={props.labelledBy}
      aria-label={props.labelledBy ? undefined : props.label}
      tabindex={0}
      class={cx('relative overflow-x-auto', props.class)}
    >
      {props.children}
    </div>
  );
}

/** "—" for a value a provider doesn't report; screen readers hear "Not available" instead. */
export function NotAvailable(props: { class?: string } = {}) {
  return (
    <span class={props.class ?? 'text-ink-3'}>
      <span aria-hidden="true">—</span>
      <span class="sr-only">Not available</span>
    </span>
  );
}
