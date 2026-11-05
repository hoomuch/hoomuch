/**
 * hoomuch's building blocks on top of coss ui (src/components/ui). Owner: Experience (design).
 * CONTRACT: exported names and props are used by pages — add props freely, don't remove or rename.
 *
 * coss components are used as they come; these wrappers only fix hoomuch's rules on top:
 * every message has a spoken tone word, every field wires its help and error into
 * aria-describedby in the server HTML, forms are plain POST forms that work before hydration,
 * and wide tables scroll inside a focusable region instead of widening the page.
 *
 * Tailwind rule: class names must be complete literal strings (the scanner can't see
 * concatenated fragments). Pick from literal maps, never `btn-${variant}`.
 */

import { ChevronDown, ChevronLeft, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Alert as CossAlert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button as CossButton } from '@/components/ui/button';
import { Card as CossCard, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table } from '@/components/ui/table';
import { cn } from '../../lib/utils';

/** Joins class names (clsx + tailwind-merge). Kept under its old name for the pages. */
export const cx = cn;

// ---------- page structure ----------

export function PageHeader(props: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small "‹ Connections" link above the title, for detail pages. */
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {props.back ? (
          <a
            href={props.back.href}
            className="-ml-1 mb-2 inline-flex items-center gap-0.5 rounded-md pr-1 text-body text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4 shrink-0" />
            {props.back.label}
          </a>
        ) : null}
        {/* wrap-break-word: a long unbroken connection name must wrap at 320px, not widen the page. */}
        <h1 className="font-heading text-title wrap-break-word">{props.title}</h1>
        {props.description ? <div className="mt-1.5 max-w-2xl text-muted-foreground">{props.description}</div> : null}
      </div>
      {props.actions ? <div className="flex flex-wrap items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}

/**
 * coss Card as a <section>. `title` renders an <h2> in the card header.
 * Padding is set per side so coss's own rules still apply: the body drops its top padding under a
 * header, and the header tightens its bottom padding above a body.
 */
export function Card(props: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
  /** Extra classes for the card, e.g. "md:col-span-2". */
  className?: string;
  /** Extra classes for the card body. */
  bodyClassName?: string;
}) {
  return (
    <CossCard render={<section id={props.id} />} className={cn('min-w-0', props.className)}>
      {props.title ? (
        <CardHeader className="px-5 pt-5 sm:px-6 sm:pt-6">
          <CardTitle render={<h2 />} className="text-base">
            {props.title}
          </CardTitle>
          {props.description ? <CardDescription>{props.description}</CardDescription> : null}
          {props.actions ? <CardAction className="items-center gap-2">{props.actions}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardPanel className={cn('min-w-0 px-5 pb-5 sm:px-6 sm:pb-6', props.bodyClassName)}>{props.children}</CardPanel>
    </CossCard>
  );
}

// ---------- links ----------

/** A text link: brand blue, underlined, the same in prose and in notes. */
export function TextLink(props: {
  href: string;
  children?: ReactNode;
  className?: string;
  external?: boolean;
  /** After hydration only, e.g. to pick a calendar day in place; the href still works without it. */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <a
      href={props.href}
      onClick={props.onClick}
      target={props.external ? '_blank' : undefined}
      rel={props.external ? 'noopener noreferrer' : undefined}
      className={cn(
        'font-medium text-brand underline decoration-brand/40 underline-offset-[0.2em] transition-colors hover:decoration-brand',
        props.className,
      )}
    >
      {props.children}
    </a>
  );
}

/** A submit button styled as a TextLink, for one-click forms inside a sentence ("Undo", "Remove demo data"). */
export function LinkSubmit(props: { children?: ReactNode; className?: string }) {
  return (
    <button
      type="submit"
      className={cn(
        'cursor-pointer font-medium text-brand underline decoration-brand/40 underline-offset-[0.2em] transition-colors hover:decoration-brand',
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

// ---------- feedback ----------

export type Tone = 'info' | 'success' | 'warning' | 'error';

/** Spoken before the message so colour + icon are never the only signal. */
const TONE_WORD: Record<Tone, string> = {
  info: 'Note:',
  success: 'Success:',
  warning: 'Warning:',
  error: 'Error:',
};

export function ToneIcon(props: { tone: Tone; className?: string }) {
  switch (props.tone) {
    case 'success':
      return <CircleCheck className={cn('size-4 shrink-0 text-success', props.className)} />;
    case 'warning':
      return <TriangleAlert className={cn('size-4 shrink-0 text-warning', props.className)} />;
    case 'error':
      return <CircleAlert className={cn('size-4 shrink-0 text-destructive', props.className)} />;
    default:
      return <Info className={cn('size-4 shrink-0 text-info', props.className)} />;
  }
}

/**
 * The coss Alert behind Alert, Flash and FormError: tone icon, optional title, body.
 * role="alert" for errors (announced immediately), role="status" otherwise; pass role="none"
 * for static page content, which is read in order like any other text.
 * `autoFocus` makes the box a programmatic focus target (tabIndex -1) and focuses it on load:
 * the way to land a screen-reader user on a form's error after a failed submit.
 * `action` sits at the end (coss AlertAction).
 */
export function ToneBox(props: {
  tone: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: 'alert' | 'status' | 'none';
  id?: string;
  autoFocus?: boolean;
}) {
  const role = props.role ?? (props.tone === 'error' ? 'alert' : 'status');
  return (
    <CossAlert
      variant={props.tone}
      id={props.id}
      role={role === 'none' ? undefined : role}
      tabIndex={props.autoFocus ? -1 : undefined}
      autoFocus={props.autoFocus || undefined}
      className={cn('text-body', props.className)}
    >
      <ToneIcon tone={props.tone} />
      {props.title ? (
        <AlertTitle className="font-semibold">
          <span className="sr-only">{TONE_WORD[props.tone]} </span>
          {props.title}
        </AlertTitle>
      ) : null}
      {props.children ? (
        <AlertDescription className="block text-foreground/90">
          {props.title ? null : <span className="sr-only">{TONE_WORD[props.tone]} </span>}
          {props.children}
        </AlertDescription>
      ) : null}
    </CossAlert>
  );
}

/**
 * Inline, static message that is part of the page (warnings, "Last sync failed", the sync
 * notice). No live-region role by default: it's read in order, and a role="alert" that is
 * already in the markup on load makes some screen readers interrupt with it on every visit.
 * Flash and FormError (the result of an action) keep their roles.
 */
export function Alert(props: { tone?: Tone; title?: string; children?: ReactNode; className?: string; role?: 'alert' | 'status' | 'none' }) {
  return (
    <ToneBox tone={props.tone ?? 'info'} title={props.title} className={props.className} role={props.role ?? 'none'}>
      {props.children}
    </ToneBox>
  );
}

// ---------- segmented links ----------

/**
 * coss SegmentedControl made of links (range tabs, the transactions filter): one choice of
 * several, each its own URL, so it works before hydration. The current one is aria-current="page".
 * Idle text is muted-foreground at full strength (AA); coss's default is 72% of it.
 */
export function SegmentedLinks(props: {
  label: string;
  items: readonly { href: string; label: ReactNode; current: boolean; key: string }[];
  className?: string;
}) {
  return (
    <SegmentedControl render={<nav aria-label={props.label} />} size="sm" className={props.className}>
      {props.items.map((it) => (
        <SegmentedControlItem
          key={it.key}
          render={<a href={it.href} aria-current={it.current ? 'page' : undefined} />}
          className="text-muted-foreground tabular-nums hover:text-foreground"
        >
          {it.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

// ---------- buttons ----------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * coss buttons. primary: ink, one per view. secondary: outline. ghost: text-only.
 * danger: coss destructive-outline, the final destructive click.
 */
const COSS_VARIANT = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive-outline',
} as const;

function sizeOf(small?: boolean, large?: boolean): 'sm' | 'lg' | 'default' {
  return small ? 'sm' : large ? 'lg' : 'default';
}

/** Forms with a submit in flight; a second submit of the same form is ignored until the page changes. */
const inFlight = new WeakMap<HTMLFormElement, Event>();

/**
 * Submit feedback (after hydration): when this button submits its POST form, it gets aria-busy,
 * coss's spinner and its busy label ("Checking key…"), and a second submit of the form is ignored.
 * The button is never disabled: a disabled submitter would drop its name/value from the request.
 * Back/Forward can restore the page from memory, so that resets everything.
 */
function useSubmitBusy(): [RefObject<HTMLButtonElement | null>, boolean] {
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const button = ref.current;
    const form = button?.form;
    if (!button || !form || form.method.toLowerCase() !== 'post') return;
    const onSubmit = (e: SubmitEvent) => {
      const prev = inFlight.get(form);
      if (prev && prev !== e) {
        e.preventDefault();
        return;
      }
      inFlight.set(form, e);
      const submitter = e.submitter ?? form.querySelector('button[type="submit"], button:not([type])');
      if (submitter === button) setBusy(true);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      inFlight.delete(form);
      setBusy(false);
    };
    form.addEventListener('submit', onSubmit);
    window.addEventListener('pageshow', onShow);
    return () => {
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);
  return [ref, busy];
}

export function Button(props: {
  variant?: ButtonVariant;
  type?: 'submit' | 'button';
  name?: string;
  value?: string;
  small?: boolean;
  large?: boolean;
  /** Full width (auth cards, mobile forms). */
  block?: boolean;
  disabled?: boolean;
  /** Submit a form elsewhere on the page. */
  form?: string;
  className?: string;
  /**
   * Label while the form is on its way, e.g. "Checking key…" (with a spinner). Worth it where the
   * server takes seconds; other buttons just get the spinner.
   */
  busyLabel?: string;
  children?: ReactNode;
}) {
  const [ref, busy] = useSubmitBusy();
  return (
    <CossButton
      ref={ref}
      type={props.type ?? 'submit'}
      name={props.name}
      value={props.value}
      form={props.form}
      disabled={props.disabled}
      variant={COSS_VARIANT[props.variant ?? 'primary']}
      size={sizeOf(props.small, props.large)}
      aria-busy={busy || undefined}
      className={cn(props.block && 'w-full motion-safe:active:scale-[0.985]', props.className)}
    >
      {busy ? <Spinner aria-hidden="true" role={undefined} aria-label={undefined} className="size-4" /> : null}
      {busy && props.busyLabel ? props.busyLabel : props.children}
    </CossButton>
  );
}

export function LinkButton(props: {
  href: string;
  variant?: ButtonVariant;
  small?: boolean;
  large?: boolean;
  block?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <CossButton
      render={<a href={props.href} />}
      variant={COSS_VARIANT[props.variant ?? 'primary']}
      size={sizeOf(props.small, props.large)}
      className={cn(props.block && 'w-full motion-safe:active:scale-[0.985]', props.className)}
    >
      {props.children}
    </CossButton>
  );
}

// ---------- form fields ----------
// coss Label + Input, wired by hand: a visible <label for>, help + error ids in aria-describedby,
// aria-invalid on error. All of it is in the server HTML, so it holds before hydration too.

const FIELD = 'mb-4 flex flex-col items-start gap-2';
const HELP = 'text-caption text-muted-foreground';

function FieldError(props: { id: string; message: string }) {
  return (
    <p id={props.id} className="flex items-start gap-1.5 text-caption text-destructive-foreground">
      <CircleAlert className="mt-px size-3.5 shrink-0" />
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
  help?: ReactNode;
  error?: string;
  required?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
  minLength?: number;
  maxLength?: number;
  /** Defaults to `name`. */
  id?: string;
  /** e.g. "font-mono" for API keys. */
  inputClassName?: string;
  /** false for keys, IDs and emails. */
  spellCheck?: boolean;
  autoCapitalize?: 'off' | 'none' | 'on' | 'sentences' | 'words' | 'characters';
  inputMode?: 'none' | 'text' | 'email' | 'url' | 'numeric' | 'decimal' | 'search';
  /** Hide the "(optional)" note on non-required fields. */
  hideOptional?: boolean;
}

export function Field(props: FieldProps) {
  const id = props.id ?? props.name;
  const helpId = props.help ? `${id}-help` : undefined;
  const errId = props.error ? `${id}-error` : undefined;
  const type = props.type ?? 'text';
  return (
    <div className={FIELD} data-slot="field" data-invalid={props.error ? '' : undefined}>
      <Label htmlFor={id}>
        <span>
          {props.label}
          {props.required || props.hideOptional ? null : <span className="font-normal text-faint"> (optional)</span>}
        </span>
      </Label>
      <Input
        nativeInput
        id={id}
        name={props.name}
        type={type}
        defaultValue={type === 'password' ? undefined : props.value}
        placeholder={props.placeholder}
        required={props.required}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        minLength={props.minLength}
        maxLength={props.maxLength}
        spellCheck={props.spellCheck}
        autoCapitalize={props.autoCapitalize}
        inputMode={props.inputMode}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(errId, helpId)}
        className={props.inputClassName}
      />
      {props.error && errId ? <FieldError id={errId} message={props.error} /> : null}
      {props.help ? (
        <p id={helpId} className={HELP}>
          {props.help}
        </p>
      ) : null}
    </div>
  );
}

/** coss Select (Base UI). The value is posted through Base UI's hidden input named `name`. */
export function SelectField(props: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  value?: string;
  help?: ReactNode;
  error?: string;
  id?: string;
  required?: boolean;
}) {
  const id = props.id ?? props.name;
  const helpId = props.help ? `${id}-help` : undefined;
  const errId = props.error ? `${id}-error` : undefined;
  return (
    <div className={FIELD} data-slot="field">
      <Label htmlFor={id}>{props.label}</Label>
      <Select name={props.name} defaultValue={props.value} items={props.options} required={props.required}>
        <SelectTrigger
          id={id}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy(errId, helpId)}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {props.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {props.error && errId ? <FieldError id={errId} message={props.error} /> : null}
      {props.help ? (
        <p id={helpId} className={HELP}>
          {props.help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A required confirmation checkbox for destructive actions (coss Checkbox inside its label, so
 * the whole sentence is the click target). The statement is read in foreground, not muted.
 */
export function ConfirmCheckbox(props: { name?: string; label: ReactNode; error?: string; id?: string; autoFocus?: boolean }) {
  const name = props.name ?? 'confirm';
  const id = props.id ?? name;
  const errId = props.error ? `${id}-error` : undefined;
  return (
    <div className={FIELD} data-slot="field">
      <Label className="items-start gap-2.5 font-normal">
        <Checkbox
          id={id}
          name={name}
          value="yes"
          required
          autoFocus={props.autoFocus}
          // Explicit "false": Chromium otherwise exposes an untouched required checkbox as invalid,
          // so screen readers say "invalid entry" before anything was submitted.
          aria-invalid={props.error ? true : false}
          aria-describedby={errId}
          className="mt-px"
        />
        <span>{props.label}</span>
      </Label>
      {props.error && errId ? <FieldError id={errId} message={props.error} /> : null}
    </div>
  );
}

/**
 * Form-level error summary shown above the fields. Pass `autoFocus` when no field carries the
 * error (e.g. "Email or password is incorrect"), so focus lands on the message after the
 * re-rendered POST; when a field has the error, autofocus that field instead.
 */
export function FormError(props: { message?: string | null; title?: string; autoFocus?: boolean; id?: string }) {
  if (!props.message) return null;
  return (
    <ToneBox tone="error" title={props.title} className="mb-5" id={props.id} autoFocus={props.autoFocus}>
      {props.message}
    </ToneBox>
  );
}

// ---------- disclosure ----------

/**
 * "Show …" disclosure: a coss Collapsible with a quiet text trigger and a chevron. The panel stays
 * in the server HTML (keepMounted) and uses hidden="until-found", so find-in-page and links to an
 * id inside it open it too.
 */
export function Disclosure(props: {
  summary: ReactNode;
  defaultOpen?: boolean;
  children?: ReactNode;
  className?: string;
  panelClassName?: string;
}) {
  return (
    <Collapsible defaultOpen={props.defaultOpen} className={props.className}>
      <CollapsibleTrigger className="group inline-flex cursor-pointer items-center gap-1 rounded-md text-body text-muted-foreground transition-[color,scale] duration-150 ease-out hover:text-foreground motion-safe:active:scale-[0.97]">
        {props.summary}
        <ChevronDown className="size-4 shrink-0 transition-transform duration-200 ease-out group-data-panel-open:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsiblePanel keepMounted hiddenUntilFound className={props.panelClassName}>
        {props.children}
      </CollapsiblePanel>
    </Collapsible>
  );
}

// ---------- tables ----------

/**
 * A coss Table whose scroll container is a focusable region named by the table's caption
 * (WCAG 1.4.10: the table scrolls, never the page; 2.1.1: keyboard users scroll it with the
 * arrow keys). `relative` (coss's container has it) keeps sr-only text inside the scroller.
 * Children are the table's caption, head, body and foot.
 */
export function ScrollTable(props: {
  labelledBy?: string;
  label?: string;
  /** Classes for the scroll container (borders, margins). */
  className?: string;
  /** Classes for the <table>. */
  tableClassName?: string;
  /** coss's card variant: rows as a bordered, rounded list. */
  variant?: 'default' | 'card';
  children?: ReactNode;
}) {
  return (
    <Table
      variant={props.variant}
      render={
        <div
          role="region"
          aria-labelledby={props.labelledBy}
          aria-label={props.labelledBy ? undefined : props.label}
          tabIndex={0}
          className={cn('focus-inset rounded-md', props.className)}
        />
      }
      className={props.tableClassName}
    >
      {props.children}
    </Table>
  );
}

/** A row header cell (<th scope="row">) that looks like coss's TableCell. */
export function TableRowHeader(props: { children?: ReactNode; className?: string }) {
  return (
    <th scope="row" className={cn('whitespace-nowrap bg-clip-padding p-2.5 text-left align-middle font-normal leading-none', props.className)}>
      {props.children}
    </th>
  );
}

/** "—" for a value a provider doesn't report; screen readers hear "Not available" instead. */
export function NotAvailable(props: { className?: string } = {}) {
  return (
    <span className={props.className ?? 'text-faint'}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not available</span>
    </span>
  );
}
