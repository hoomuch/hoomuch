/** Settings (GET /settings): display currency, password, session (log out), account deletion. Owner: Experience (pages). */

import { PASSWORD_MIN } from '../../lib/auth';
import { SUPPORTED_CURRENCIES } from '../../lib/money';
import { DangerZone } from '../components/danger-zone';
import { Button, Card, ConfirmCheckbox, Field, FormError, PageHeader, SelectField } from '../components/ui';
import { Layout, type PageChrome } from '../layout';

export interface SettingsPageProps {
  chrome: PageChrome;
  /** The user's display currency (ISO 4217). */
  currency: string;
  /** "inferred": picked from their numbers, so say so next to the select. */
  currencySource?: 'default' | 'inferred' | 'chosen';
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
    <Layout {...props.chrome} title={focus ? 'Error: Settings' : 'Settings'} nav="settings" noindex>
      <PageHeader title="Settings" />
      <div class="grid max-w-xl gap-6">
        <Card
          id="display-currency"
          title="Display currency"
          description="Converted at the latest ECB rates, past days included. Transactions also show the original amount."
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

        <Card id="change-password" title="Change password" description="Changing it logs you out on other devices.">
          <form method="post" action="/settings/password">
            <FormError message={pwFormError} autofocus={focus === 'pw-form'} />
            <Field
              name="current_password"
              label="Current password"
              type="password"
              autocomplete="current-password"
              required
              maxlength={256}
              autofocus={focus === 'current'}
              error={pw?.fieldErrors?.current}
            />
            <Field
              name="new_password"
              label="New password"
              type="password"
              autocomplete="new-password"
              required
              minlength={PASSWORD_MIN}
              maxlength={256}
              help={`At least ${PASSWORD_MIN} characters.`}
              autofocus={focus === 'next'}
              error={pw?.fieldErrors?.next}
            />
            <Button variant="secondary">Change password</Button>
          </form>
        </Card>

        <Card id="session" title="Session">
          <p class="text-body text-ink-2">
            Logged in as <span class="font-semibold text-base-content wrap-anywhere">{props.chrome.user?.email}</span>.
          </p>
          <form method="post" action="/logout" class="mt-4">
            <Button variant="secondary">Log out</Button>
          </form>
        </Card>

        <DangerZone
          title="Delete account"
          description="Deletes your account, all connections and their stored keys, and all synced data. This can’t be undone."
        >
          <form method="post" action="/settings/delete" id="delete-account">
            <FormError message={delFormError} autofocus={focus === 'del-form'} />
            <Field
              id="delete-password"
              name="password"
              label="Password"
              type="password"
              autocomplete="current-password"
              required
              maxlength={256}
              autofocus={focus === 'del-password'}
              error={del?.fieldErrors?.password}
            />
            <ConfirmCheckbox
              label="Yes, delete my account and all of its data."
              autofocus={focus === 'confirm'}
              error={del?.fieldErrors?.confirm}
            />
            <Button variant="danger">Delete account</Button>
          </form>
        </DangerZone>
      </div>
    </Layout>
  );
}
