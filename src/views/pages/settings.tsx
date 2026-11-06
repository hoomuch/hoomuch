/** Settings (GET /settings): display currency, time zone, password, session (log out), account deletion. Owner: Experience (pages). */

import { PASSWORD_MIN } from '../../lib/password-policy';
import { SUPPORTED_CURRENCIES } from '../../lib/money';
import { zoneLabel } from '../../lib/time';
import { DangerZone } from '../components/danger-zone';
import { Button, Card, ConfirmCheckbox, Field, FormError, PageHeader, SelectField } from '../components/ui';
import { Layout, type PageChrome } from '../layout';

export interface SettingsPageProps {
  chrome: PageChrome;
  /** The user's display currency (ISO 4217). */
  currency: string;
  /** "inferred": picked from their numbers, so say so next to the select. */
  currencySource?: 'default' | 'inferred' | 'chosen';
  /** The zone the user's days run in (IANA). */
  timeZone?: string;
  /** "inferred": taken from where they signed in from, so say so next to the select. */
  timeZoneSource?: 'default' | 'inferred' | 'chosen';
  /** Every zone to offer (from the server, so the browser hydrates the same list). */
  timeZones?: string[];
  /** Errors from a failed password change (re-rendered with 422). */
  password?: { error?: string | null; fieldErrors?: { current?: string; next?: string } };
  /** Errors from a failed account deletion (re-rendered with 422). */
  deleteAccount?: { error?: string | null; fieldErrors?: { password?: string; confirm?: string } };
}

let currencyNames: Intl.DisplayNames | null | undefined;

/** "EUR — Euro"; falls back to the bare code if the runtime lacks display names. */
function currencyLabel(code: string): string {
  if (currencyNames === undefined) {
    try {
      currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' });
    } catch {
      currencyNames = null;
    }
  }
  const name = currencyNames?.of(code);
  return name && name !== code ? `${code} — ${name}` : code;
}

export function SettingsPage(props: SettingsPageProps) {
  const options = SUPPORTED_CURRENCIES.map((code) => ({ value: code, label: currencyLabel(code) }));
  const pw = props.password;
  const del = props.deleteAccount;
  const pwFormError = pw && !pw.fieldErrors?.current && !pw.fieldErrors?.next ? pw.error : null;
  const delFormError = del && !del.fieldErrors?.password && !del.fieldErrors?.confirm ? del.error : null;
  // A failed submit re-renders this page: focus the first thing to fix (in document order) and
  // lead the title with "Error: " so it's announced on load. At most one autofocus.
  const focus = pwFormError
    ? 'pw-form'
    : pw?.fieldErrors?.current
      ? 'current'
      : pw?.fieldErrors?.next
        ? 'next'
        : delFormError
          ? 'del-form'
          : del?.fieldErrors?.password
            ? 'del-password'
            : del?.fieldErrors?.confirm
              ? 'confirm'
              : null;
  return (
    <Layout {...props.chrome} title={focus ? 'Error: Settings' : 'Settings'} nav="settings" noindex backdrop>
      <PageHeader title="Settings" />
      <div className="grid max-w-xl gap-6">
        <Card
          id="display-currency"
          title="Display currency"
          description="Revenue converts at the exchange rate of the day it came in, MRR at the latest rates. Transactions also show the original amount."
        >
          <form method="post" action="/settings/currency">
            <SelectField
              name="currency"
              label="Currency"
              options={options}
              value={props.currency}
              help={props.currencySource === 'inferred' ? 'Picked automatically: most of your MRR is in this currency.' : undefined}
            />
            <Button variant="secondary">Save currency</Button>
          </form>
        </Card>

        <Card
          id="time-zone"
          title="Time zone"
          description="Days on the dashboard, the calendar and transactions run midnight to midnight here."
        >
          <form method="post" action="/settings/timezone">
            <SelectField
              name="timezone"
              label="Time zone"
              options={(props.timeZones ?? [props.timeZone ?? 'UTC']).map((z) => ({ value: z, label: zoneLabel(z) }))}
              value={props.timeZone ?? 'UTC'}
              help={props.timeZoneSource === 'inferred' ? 'Picked automatically from where you signed in.' : undefined}
            />
            <Button variant="secondary">Save time zone</Button>
          </form>
        </Card>

        <Card id="change-password" title="Change password" description="Changing it logs you out on other devices.">
          <form method="post" action="/settings/password">
            <FormError message={pwFormError} autoFocus={focus === 'pw-form'} />
            <Field
              name="current_password"
              label="Current password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              autoFocus={focus === 'current'}
              error={pw?.fieldErrors?.current}
            />
            <Field
              name="new_password"
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              maxLength={256}
              help={`At least ${PASSWORD_MIN} characters.`}
              autoFocus={focus === 'next'}
              error={pw?.fieldErrors?.next}
            />
            <Button variant="secondary">Change password</Button>
          </form>
        </Card>

        <Card id="session" title="Session">
          <p className="text-body text-muted-foreground">
            Logged in as <span className="font-semibold text-foreground wrap-anywhere">{props.chrome.user?.email}</span>.
          </p>
          <form method="post" action="/logout" className="mt-4">
            <Button variant="secondary">Log out</Button>
          </form>
        </Card>

        <DangerZone
          title="Delete account"
          description="Deletes your account, all connections and their stored keys, and all synced data. This can’t be undone."
        >
          <form method="post" action="/settings/delete" id="delete-account">
            <FormError message={delFormError} autoFocus={focus === 'del-form'} />
            <Field
              id="delete-password"
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              autoFocus={focus === 'del-password'}
              error={del?.fieldErrors?.password}
            />
            <ConfirmCheckbox
              label="Yes, delete my account and all of its data."
              autoFocus={focus === 'confirm'}
              error={del?.fieldErrors?.confirm}
            />
            <Button variant="danger">Delete account</Button>
          </form>
        </DangerZone>
      </div>
    </Layout>
  );
}
