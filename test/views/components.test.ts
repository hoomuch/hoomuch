/**
 * Design-system components rendered as plain functions (no JSX in .ts tests).
 * Owner: Experience (design).
 */

import { describe, expect, it } from 'vitest';
import { BreakdownTable } from '../../src/views/components/breakdown-table';
import { ConnectionForm } from '../../src/views/components/connection-form';
import { DangerZone } from '../../src/views/components/danger-zone';
import { EmptyState } from '../../src/views/components/empty-state';
import { Flash } from '../../src/views/components/flash';
import { DeltaBadge, KpiStat } from '../../src/views/components/kpi';
import { RangeTabs } from '../../src/views/components/range-tabs';
import { RelativeTime } from '../../src/views/components/relative-time';
import { ProviderDot, StatusBadge, TestModeBadge } from '../../src/views/components/badges';
import { RingsMark } from '../../src/views/components/icons';
import {
  Alert,
  Button,
  Card,
  ConfirmCheckbox,
  Field,
  FormError,
  LinkButton,
  NotAvailable,
  PageHeader,
  SelectField,
  TableScroller,
} from '../../src/views/components/ui';
import { Layout } from '../../src/views/layout';
import { SyncNotice, syncCadence } from '../../src/views/pages/shared';
import { Owl, OWL_SIZE } from '../../src/views/components/mascot';
import { LandingPage } from '../../src/views/pages/landing';
import {
  completenessNotes,
  DashboardPage,
  freshness,
  milestoneAtOrBelow,
  recentMilestone,
} from '../../src/views/pages/dashboard';
import { NotFoundPage, ServerErrorPage } from '../../src/views/pages/errors';
import { AuthPage } from '../../src/views/pages/auth';
import { SettingsPage } from '../../src/views/pages/settings';
import { TransactionsPage } from '../../src/views/pages/transactions';
import { ConnectionDetailPage } from '../../src/views/pages/connection-detail';
import { MAX_POLLS, parsePoll, POLL_SECONDS, POLL_STOPPED, syncState } from '../../src/routes/util';
import {
  fixtureConnectionDetail,
  fixtureDashboard,
  FIXTURE_CONNECTIONS,
  FIXTURE_NOW,
  fixtureTransactions,
} from '../../src/views/fixtures';
import { getProviderMeta, PROVIDERS } from '../../src/providers/registry';
import { HOUR, MINUTE } from '../../src/lib/time';

/** Components are plain functions; their result stringifies (possibly async) to HTML. */
async function html(node: unknown): Promise<string> {
  if (node === null || node === undefined) return '';
  return String(await (node as { toString(): string | Promise<string> }).toString());
}

/** Every rendered sample, collected so the CSP check below covers all of them. */
const rendered: Record<string, string> = {};
async function render(name: string, node: unknown): Promise<string> {
  const out = await html(node);
  rendered[name] = out;
  return out;
}

const user = { id: 'u1', email: 'ada@example.com', baseCurrency: 'USD' };

describe('Layout', () => {
  it('renders the shell with doctype, title, skip link, nav state and Settings apart on the right', async () => {
    const out = await render(
      'layout',
      Layout({ title: 'Dashboard', user, flash: { type: 'success', message: 'Connected.' }, nav: 'dashboard', noindex: true, children: 'Body' }),
    );
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<title>Dashboard · hoomuch</title>');
    expect(out).toContain('href="#main"');
    expect(out).toContain('id="main"');
    expect(out).toMatch(/<a href="\/dashboard" aria-current="page"/);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    // Three daily places in the nav; Settings on its own; Log out lives in Settings, not the bar.
    expect(out.match(/<li><a href="\/(dashboard|connections|transactions)"/g)).toHaveLength(3);
    expect(out).toMatch(/<a href="\/settings" class="[^"]*ml-auto/);
    expect(out).not.toContain('action="/logout"');
    // The optional submit-feedback script: same origin, deferred, never inline.
    expect(out).toContain('<script src="/app.js" defer=""></script>');
    expect(out).toContain('name="robots" content="noindex"');
    expect(out).toContain('role="status"');
    expect(out).toContain('Body');
  });

  it('hides the app nav when signed out and supports the narrow column and refresh', async () => {
    const out = await render(
      'layout-narrow',
      Layout({ title: 'Log in', user: null, flash: null, width: 'narrow', refresh: { seconds: 5, url: '/dashboard?poll=1' } }),
    );
    expect(out).not.toContain('aria-label="Main"');
    expect(out).not.toContain('/logout');
    expect(out).toContain('max-w-[28rem]');
    expect(out).toContain('content="5;url=/dashboard?poll=1"');
  });
});

describe('Flash', () => {
  it('renders nothing without a message', async () => {
    expect(await html(Flash({ flash: null }))).toBe('');
  });

  it('uses role=alert for errors and role=status otherwise, with a spoken tone word', async () => {
    const err = await render('flash-error', Flash({ flash: { type: 'error', message: 'Something went wrong.' } }));
    expect(err).toContain('role="alert"');
    expect(err).toContain('Error:');
    const ok = await render('flash-success', Flash({ flash: { type: 'success', message: 'Connected.' } }));
    expect(ok).toContain('role="status"');
    const info = await render('flash-info', Flash({ flash: { type: 'info', message: 'Syncing.' } }));
    expect(info).toContain('role="status"');
  });
});

describe('DeltaBadge and KpiStat', () => {
  it('renders "—" for a null delta', async () => {
    const out = await render('delta-null', DeltaBadge({ pct: null }));
    expect(out).toContain('—');
    expect(out).not.toMatch(/\d%/);
  });

  it('says up/down in words, not only colour, and flips tone with invert', async () => {
    const up = await render('delta-up', DeltaBadge({ pct: 4.24 }));
    expect(up).toContain('Up ');
    expect(up).toContain('4.2%');
    expect(up).toContain('text-success');

    const down = await render('delta-down', DeltaBadge({ pct: -3 }));
    expect(down).toContain('Down ');
    expect(down).toContain('3.0%');
    expect(down).not.toMatch(/[+−-]3\.0%/); // the arrow carries the sign
    expect(down).toContain('text-error');

    const refundsUp = await render('delta-invert', DeltaBadge({ pct: 12, invert: true }));
    expect(refundsUp).toContain('Up ');
    expect(refundsUp).toContain('text-error');

    const flat = await render('delta-flat', DeltaBadge({ pct: 0.01 }));
    expect(flat).toContain('Unchanged');
    expect(flat).toContain('0.0%');
  });

  it('makes the hero the biggest figure, with tabular numbers', async () => {
    const hero = await render('kpi-hero', KpiStat({ label: 'MRR', value: '$9,090', hero: true, deltaPct: 4.2, deltaLabel: 'vs. 30 days ago' }));
    expect(hero).toContain('sm:text-display');
    expect(hero).toContain('tabular-nums');
    expect(hero).toContain('vs. 30 days ago');
    const small = await render('kpi', KpiStat({ label: 'ARR', value: '$109,080', deltaPct: null, hint: 'MRR × 12' }));
    expect(small).not.toContain('text-display');
    expect(small).toContain('—');
    const noDelta = await render('kpi-nodelta', KpiStat({ label: 'Trials', value: '50' }));
    expect(noDelta).not.toContain('—');
  });
});

describe('badges', () => {
  it('renders the provider dot from a literal class and every status with a text label', async () => {
    expect(await render('dot', ProviderDot({ dotClass: 'bg-[#635BFF]', size: 'md' }))).toContain('bg-[#635BFF]');
    const labels = { ok: 'Up to date', syncing: 'Syncing', pending: 'Pending', error: 'Error' } as const;
    for (const status of ['ok', 'syncing', 'pending', 'error'] as const) {
      expect(await render(`status-${status}`, StatusBadge({ status }))).toContain(labels[status]);
    }
    expect(await render('test-mode', TestModeBadge())).toContain('Test mode');
    expect(await render('mark', RingsMark({}))).toContain('aria-hidden="true"');
  });
});

describe('RangeTabs', () => {
  it('links every range and marks the current one with aria-current', async () => {
    const out = await render('range', RangeTabs({ current: 30, basePath: '/preview/dashboard' }));
    expect(out).toContain('href="/preview/dashboard?range=7"');
    expect(out).toContain('href="/preview/dashboard?range=90"');
    expect(out).toMatch(/href="\/preview\/dashboard\?range=30" aria-current="page"/);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe('BreakdownTable', () => {
  it('renders right-aligned figures, an SVG share bar and "—" for missing data', async () => {
    const data = fixtureDashboard(30);
    const out = await render('breakdown', BreakdownTable({ rows: data.breakdown, currency: data.currency, rangeDays: 30 }));
    for (const r of data.breakdown) expect(out).toContain(`/connections/${r.id}`);
    expect(out).toMatch(/<rect width="\d+(\.\d)?%"/);
    expect(out).toContain('text-right');
    expect(out).toContain('—'); // the Lemon Squeezy row has no trial count
    expect(out).toContain('Revenue');
  });

  it('shows the test-mode badge on test connections', async () => {
    const row = { ...FIXTURE_CONNECTIONS[3]!, mrr: 0, activeSubscriptions: 0, activeTrials: null, revenue: null, sharePct: 0 };
    const out = await render('breakdown-test', BreakdownTable({ rows: [row], currency: 'USD', rangeDays: 7 }));
    expect(out).toContain('Test mode');
    expect(out).toContain('0%');
  });
});

describe('ConnectionForm', () => {
  const SECRET = 'rk_live_51TopSecretValueDoNotEcho';

  it('never renders a secret value, even when `values` contains one', async () => {
    for (const meta of PROVIDERS) {
      const values: Record<string, string> = { name: 'My shop', storeId: '18234', projectId: 'proj1a2b3c4d' };
      for (const f of meta.fields) if (f.secret) values[f.name] = SECRET;
      for (const mode of ['create', 'rotate'] as const) {
        const out = await render(
          `form-${meta.id}-${mode}`,
          ConnectionForm({
            meta,
            mode,
            action: '/connections',
            values,
            fieldErrors: { apiKey: 'That key was rejected.' },
            error: 'Could not connect.',
          }),
        );
        expect(out).not.toContain(SECRET);
        expect(out).not.toContain('TopSecret');
      }
    }
  });

  it('keeps non-secret values and wires errors to their fields', async () => {
    const meta = getProviderMeta('lemonsqueezy');
    const out = await render(
      'form-ls',
      ConnectionForm({ meta, mode: 'create', action: '/connections', values: { name: 'Pagekit', storeId: '18234', apiKey: SECRET }, fieldErrors: { apiKey: 'Required.' } }),
    );
    expect(out).toContain('value="Pagekit"');
    expect(out).toContain('value="18234"');
    expect(out).toContain('name="provider" value="lemonsqueezy"');
    expect(out).toMatch(/id="apiKey"[^>]*aria-invalid="true"/);
    expect(out).toContain('Create a Lemon Squeezy key');
    expect(out).toContain('Before you paste the key'); // the provider warning
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('hides the guide in rotate mode by default', async () => {
    const out = await render('form-rotate', ConnectionForm({ meta: getProviderMeta('stripe'), mode: 'rotate', action: '/connections/x/rotate', cancelHref: '/connections/x' }));
    expect(out).not.toContain('Create a Stripe key');
    expect(out).not.toContain('name="provider"');
    expect(out).toContain('Replace key');
    expect(out).toContain('Cancel');
  });
});

describe('ui primitives', () => {
  it('Field wires aria-describedby and aria-invalid', async () => {
    const out = await render('field-error', Field({ name: 'email', label: 'Email', type: 'email', help: 'We never share it.', error: 'Enter a valid email.', required: true }));
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="email-error email-help"');
    expect(out).toContain('id="email-error"');
    expect(out).toContain('id="email-help"');
    expect(out).toContain('<label for="email"');

    const calm = await render('field', Field({ name: 'storeId', label: 'Store ID', help: 'Optional.' }));
    expect(calm).not.toContain('aria-invalid');
    expect(calm).toContain('aria-describedby="storeId-help"');
    expect(calm).toContain('(optional)');
  });

  it('Field never echoes a password value', async () => {
    const out = await render('field-password', Field({ name: 'password', label: 'Password', type: 'password', value: 'hunter2hunter2', required: true }));
    expect(out).not.toContain('hunter2');
  });

  it('SelectField, ConfirmCheckbox and FormError wire their errors too', async () => {
    const sel = await render(
      'select',
      SelectField({ name: 'currency', label: 'Currency', options: [{ value: 'USD', label: 'US dollar' }, { value: 'EUR', label: 'Euro' }], value: 'EUR', error: 'Pick one.', help: 'Used for every total.' }),
    );
    expect(sel).toContain('aria-invalid="true"');
    expect(sel).toContain('aria-describedby="currency-error currency-help"');
    expect(sel).toMatch(/<option value="EUR" selected="">/);

    const cb = await render('confirm', ConfirmCheckbox({ label: 'I understand this deletes everything.', error: 'Please confirm.' }));
    expect(cb).toContain('required=""');
    expect(cb).toContain('aria-describedby="confirm-error"');

    expect(await html(FormError({ message: null }))).toBe('');
    expect(await render('form-error', FormError({ message: 'Wrong email or password.' }))).toContain('role="alert"');
  });

  it('renders page structure, alerts and button variants from literal classes', async () => {
    expect(await render('header', PageHeader({ title: 'Connections', description: 'Accounts', actions: 'x', back: { href: '/connections', label: 'Connections' } }))).toContain('<h1');
    expect(await render('card', Card({ title: 'Revenue', description: 'Daily', children: 'chart', class: 'md:col-span-2' }))).toContain('<h2');
    for (const tone of ['info', 'success', 'warning', 'error'] as const) {
      expect(await render(`alert-${tone}`, Alert({ tone, title: 'Title', children: 'Body' }))).toContain('Body');
    }
    expect(await render('btn', Button({ children: 'Save' }))).toContain('class="btn btn-primary"');
    expect(await render('btn-sm', Button({ variant: 'ghost', small: true, type: 'button', children: 'x' }))).toContain('btn btn-ghost btn-sm');
    expect(await render('btn-danger', Button({ variant: 'danger', children: 'Delete' }))).toContain('text-error');
    expect(await render('link-btn', LinkButton({ href: '/x', variant: 'secondary', block: true, children: 'Go' }))).toContain('class="btn btn-block"');
  });

  it('renders EmptyState, DangerZone and RelativeTime', async () => {
    expect(await render('empty', EmptyState({ title: 'No connections yet', children: 'Connect one.', actions: 'a' }))).toContain('No connections yet');
    const dz = await render('danger', DangerZone({ title: 'Delete account', description: 'Gone for good.', children: 'form' }));
    expect(dz).toContain('aria-labelledby="delete-account-title"');
    expect(dz).toContain('id="delete-account-title"');
    expect(await render('time', RelativeTime({ ms: FIXTURE_NOW - 4 * MINUTE, now: FIXTURE_NOW }))).toContain('4 min ago');
    expect(await render('time-never', RelativeTime({ ms: null }))).toContain('Never');
  });
});

describe('accessibility', () => {
  /** Every element that would take keyboard focus, in DOM order (good enough for SSR markup). */
  function focusables(out: string): string[] {
    const body = out.slice(out.indexOf('<body'));
    return [...body.matchAll(/<(a|button|input|select|textarea|summary)\b[^>]*>|<[a-z]+\b[^>]*\btabindex="0"[^>]*>/g)]
      .map((m) => m[0])
      .filter((t) => !/type="hidden"/.test(t));
  }

  it('keeps the skip link first and offers a stop-refresh link right after it while polling', async () => {
    const out = await render(
      'layout-refresh',
      Layout({ title: 'Dashboard', user, flash: null, nav: 'dashboard', refresh: { seconds: 3, url: '/dashboard?poll=1', stopUrl: '/dashboard?poll=21' } }),
    );
    const stops = focusables(out);
    expect(stops[0]).toContain('href="#main"');
    expect(stops[1]).toContain('href="/dashboard?poll=21"');
    expect(out).toContain('Stop automatic refresh');
    expect(stops[1]).toContain('focus:not-sr-only');

    const plain = await render('layout-plain', Layout({ title: 'Dashboard', user, flash: null, refresh: { seconds: 3, url: '/x?poll=1' } }));
    expect(plain).not.toContain('Stop automatic refresh');
  });

  it('bounds first-sync polling and lets the user turn it off (WCAG 2.2.1)', async () => {
    const url = (n: number) => `/dashboard?range=30&poll=${n}`;
    expect(syncState(false, 0, url)).toBeNull();
    const first = syncState(true, 0, url)!;
    expect(first.refresh).toEqual({ seconds: POLL_SECONDS, url: url(1), stopUrl: url(POLL_STOPPED) });
    expect(syncState(true, MAX_POLLS, url)).toEqual({ refresh: null });
    expect(syncState(true, POLL_STOPPED, url)).toEqual({ refresh: null, stopped: true });
    expect(parsePoll(String(POLL_STOPPED))).toBe(POLL_STOPPED);
    expect(parsePoll('999')).toBe(POLL_STOPPED);

    const polling = await render('sync-polling', SyncNotice({ sync: first }));
    expect(polling).toContain('refreshes on its own');
    expect(polling).toContain(`href="${url(POLL_STOPPED).replace('&', '&amp;')}"`);
    expect(polling).toContain('Stop refreshing');
    expect(await render('sync-stopped', SyncNotice({ sync: { refresh: null, stopped: true } }))).toContain('Automatic refresh is off');
    const spent = await render('sync-spent', SyncNotice({ sync: { refresh: null } }));
    expect(spent).toContain('longer than usual');
    expect(spent).not.toContain('Stop refreshing');
  });

  it('keeps live-region roles for action results only', async () => {
    expect(await render('alert-static', Alert({ tone: 'error', title: 'Last sync failed', children: 'x' }))).not.toContain('role=');
    expect(await render('alert-warning', Alert({ tone: 'warning', children: 'x' }))).not.toContain('role=');
    expect(await render('alert-status', Alert({ tone: 'info', role: 'status', children: 'x' }))).toContain('role="status"');
    expect(await html(Flash({ flash: { type: 'error', message: 'x' } }))).toContain('role="alert"');
    expect(await html(FormError({ message: 'x' }))).toContain('role="alert"');
  });

  it('makes FormError and ConfirmCheckbox autofocus targets on request', async () => {
    const calm = await render('form-error-calm', FormError({ message: 'Email or password is incorrect.' }));
    expect(calm).not.toContain('tabindex');
    expect(calm).not.toContain('autofocus');
    const focused = await render('form-error-focus', FormError({ message: 'Email or password is incorrect.', autofocus: true }));
    expect(focused).toContain('tabindex="-1"');
    expect(focused).toContain('autofocus=""');
    const confirm = await render('confirm-focus', ConfirmCheckbox({ label: 'Yes', autofocus: true }));
    expect(confirm).toMatch(/<input[^>]*autofocus=""/);
    // Not "invalid" before anything was submitted (Chromium maps the native required state otherwise).
    expect(confirm).toContain('aria-invalid="false"');
    expect(await html(ConfirmCheckbox({ label: 'Yes', error: 'Tick the box.' }))).toContain('aria-invalid="true"');
  });

  it('wraps wide tables in a focusable, named, positioned scroller', async () => {
    const out = await render('scroller', TableScroller({ labelledBy: 'cap', children: 'table' }));
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-labelledby="cap"');
    expect(out).toContain('tabindex="0"');
    expect(out).toMatch(/class="relative overflow-x-auto"/);
    expect(await render('scroller-label', TableScroller({ label: 'Data', children: 't' }))).toContain('aria-label="Data"');

    const data = fixtureDashboard(30);
    const bd = await render('breakdown-a11y', BreakdownTable({ rows: data.breakdown, currency: data.currency, rangeDays: 30 }));
    const cap = bd.match(/<caption id="([^"]+)"[^>]*>([^<]+)<\/caption>/);
    expect(cap).not.toBeNull();
    expect(bd).toContain(`aria-labelledby="${cap![1]}"`);
    expect(cap![2]).toContain('highest first');
  });

  it('says "Not available" instead of a bare dash', async () => {
    const out = await render('na', NotAvailable());
    expect(out).toContain('<span aria-hidden="true">—</span>');
    expect(out).toContain('<span class="sr-only">Not available</span>');
  });

  it('focuses the first invalid connection field, or the form error when no field has one', async () => {
    const meta = getProviderMeta('lemonsqueezy');
    const fieldErr = await render(
      'form-focus-field',
      ConnectionForm({ meta, mode: 'create', action: '/connections', error: 'Rejected.', fieldErrors: { apiKey: 'Rejected.' } }),
    );
    expect(fieldErr.match(/autofocus=""/g)).toHaveLength(1);
    expect(fieldErr).toMatch(/<input id="apiKey"[^>]*autofocus=""/);
    const formErr = await render('form-focus-form', ConnectionForm({ meta, mode: 'create', action: '/connections', error: 'Too many connections.' }));
    expect(formErr.match(/autofocus=""/g)).toHaveLength(1);
    expect(formErr).toMatch(/role="alert" tabindex="-1" autofocus=""/);
    const clean = await render('form-focus-none', ConnectionForm({ meta, mode: 'create', action: '/connections' }));
    expect(clean).not.toContain('autofocus');
    // The guide's external link says it opens a new tab.
    expect(clean).toMatch(/target="_blank"[^>]*>[\s\S]*?\(opens in a new tab\)/);
  });

  it('announces failed submits in the page title and focuses exactly one target', async () => {
    const chrome = { user: null, flash: null };
    const login = await render('auth-error', AuthPage({ chrome, mode: 'login', signupOpen: true, error: 'Email or password is incorrect.' }));
    expect(login).toContain('<title>Error: Log in · hoomuch</title>');
    expect(login.match(/autofocus=""/g)).toHaveLength(1);
    expect(login).toMatch(/role="alert" tabindex="-1" autofocus=""/);

    const signup = await render('auth-field', AuthPage({ chrome, mode: 'signup', signupOpen: true, error: 'Too short.', field: 'password' }));
    expect(signup).toContain('<title>Error: Sign up · hoomuch</title>');
    expect(signup.match(/autofocus=""/g)).toHaveLength(1);
    expect(signup).toMatch(/<input id="password"[^>]*autofocus=""/);
    expect(signup).toContain('autocomplete="new-password"');

    const clean = await render('auth-clean', AuthPage({ chrome, mode: 'login', signupOpen: true }));
    expect(clean).toContain('<title>Log in · hoomuch</title>');
    expect(clean).toMatch(/<input id="email"[^>]*autofocus=""/);
    expect(clean).toContain('autocomplete="current-password"');
    expect(clean).toContain('data-busy="Logging in…"');

    const settings = await render(
      'settings-errors',
      SettingsPage({
        chrome: { user, flash: null },
        currency: 'USD',
        deleteAccount: { error: 'Not deleted.', fieldErrors: { password: 'Password is incorrect.', confirm: 'Tick the box.' } },
      }),
    );
    expect(settings).toContain('<title>Error: Settings · hoomuch</title>');
    expect(settings.match(/autofocus=""/g)).toHaveLength(1);
    expect(settings).toMatch(/<input id="delete-password"[^>]*autofocus=""/);
    expect(await html(SettingsPage({ chrome: { user, flash: null }, currency: 'USD' }))).not.toContain('autofocus');
  });

  it('keeps Log out in Settings, in the order currency, password, session, delete', async () => {
    const out = await render('settings', SettingsPage({ chrome: { user, flash: null }, currency: 'EUR', currencySource: 'inferred' }));
    const at = (needle: string) => out.indexOf(needle);
    expect(at('>Display currency<')).toBeLessThan(at('>Change password<'));
    expect(at('>Change password<')).toBeLessThan(at('>Session<'));
    expect(at('>Session<')).toBeLessThan(at('>Delete account<'));
    expect(out).toContain('action="/logout"');
    expect(out).toContain('ada@example.com');
    expect(out).toContain('Picked automatically: most of your MRR is in this currency.');
    expect(await html(SettingsPage({ chrome: { user, flash: null }, currency: 'USD', currencySource: 'chosen' }))).not.toContain(
      'Picked automatically',
    );
  });

  it('gives transactions a row header, a sort-order caption and named pagination', async () => {
    const out = await render(
      'transactions-a11y',
      TransactionsPage({
        chrome: { user, flash: null },
        page: fixtureTransactions(2, null),
        hasConnections: true,
        filterProviders: ['stripe'],
      }),
    );
    expect(out).toContain('<title>Transactions, page 2 · hoomuch</title>');
    expect(out).toMatch(/<caption id="transactions-caption"[^>]*>Transactions, newest first, page 2<\/caption>/);
    expect(out).toContain('aria-labelledby="transactions-caption"');
    expect(out).toMatch(/<th scope="row"[^>]*><time datetime=/);
    expect(out).toContain('<span aria-hidden="true">←</span> Previous<span class="sr-only"> page</span>');
  });
});

describe('personality: owl, landing, first sync, 404', () => {
  it('renders the owl as a decorative, theme-aware picture sized by attributes', async () => {
    const out = await render('owl', Owl({ pose: 'dozing' }));
    expect(out).toContain('<source srcset="/mascot/dozing-dark.png" media="(prefers-color-scheme: dark)"');
    expect(out).toContain('src="/mascot/dozing.png"');
    expect(out).toContain(`width="${OWL_SIZE.dozing}"`);
    expect(out).toContain('alt=""');
    expect(out).toContain('loading="lazy"');
    expect(await html(Owl({ pose: 'perched', eager: true }))).not.toContain('loading=');
  });

  it('describes the sync cadence from SYNC_INTERVAL_MINUTES, rounded up to the 30-minute cron', () => {
    expect(syncCadence('60')).toBe('every hour');
    expect(syncCadence(undefined)).toBe('every hour');
    expect(syncCadence('junk')).toBe('every hour');
    expect(syncCadence('10')).toBe('every 30 minutes');
    expect(syncCadence('45')).toBe('every hour');
    expect(syncCadence('90')).toBe('every 90 minutes');
    expect(syncCadence('120')).toBe('every 2 hours');
  });

  it('shows the real dashboard, the one action and literal storage facts on the landing page', async () => {
    const demo = fixtureDashboard(30, 'full', FIXTURE_NOW);
    const out = await render('landing', LandingPage({ chrome: { user: null, flash: null }, signupOpen: true, demo, cadence: 'every hour' }));
    expect(out).toContain('Stripe + Lemon\u00a0Squeezy + RevenueCat =\u00a0one\u00a0MRR.');
    expect(out.match(/href="\/signup"/g)).toHaveLength(2); // hero + last call, same action
    expect(out).toContain('aria-label="MRR"'); // the real MRR card
    expect(out).toContain('aria-label="Subscriptions, trials and revenue"');
    expect(out).toContain('href="/?range=90#demo"');
    expect(out).toContain('Create a Stripe key');
    expect(out).not.toContain('dashboard.stripe.com'); // preview drops the outbound link
    expect(out).toContain('so this one has full access');
    expect(out).toContain('AES-256-GCM');
    expect(out).toContain('Syncs run every hour.');
    expect(out).toContain('src="/mascot/perched.png"');
    expect(out).toContain('src="/mascot/asleep.png"'); // marketing footer
    expect(out).toContain('href="/login"'); // signed-out header link
    expect(out).not.toContain('NEEDS REAL DATA');
    expect(out).not.toContain('Why this exists'); // no founder note until it's real
    expect(out).not.toContain('>Pricing<'); // no pricing until it's real

    const closed = await html(LandingPage({ chrome: { user: null, flash: null }, signupOpen: false, demo, cadence: 'every hour' }));
    expect(closed).not.toContain('href="/signup"');
    expect(closed).not.toContain('No key handy?');
  });

  it('finds a milestone crossed in the last 7 days and still held, never one it can’t see crossed', () => {
    expect([999, 1000, 2499, 2500, 9999, 10_000, 19_999, 20_000, 41_000].map(milestoneAtOrBelow)).toEqual([
      null, 1000, 1000, 2500, 5000, 10_000, 10_000, 20_000, 40_000,
    ]);
    // Series values are minor units (cents); days count back from 2026-11-05.
    const series = (vals: number[]) =>
      vals.map((major, i) => ({ day: `2026-11-${String(5 - vals.length + 1 + i).padStart(2, '0')}`, total: major * 100 }));
    expect(recentMilestone(series([4800, 4900, 5100]), 'USD', '2026-11-05')).toBe(5000);
    expect(recentMilestone(series([900, 2600, 5200]), 'USD', '2026-11-05')).toBe(5000); // the highest one
    expect(recentMilestone(series([4900, 5100, 4950]), 'USD', '2026-11-05')).toBeNull(); // fell back below
    expect(recentMilestone(series([5100, 5200]), 'USD', '2026-11-05')).toBeNull(); // never seen below it
    expect(recentMilestone(series([5100]), 'USD', '2026-11-05')).toBeNull();
    // Crossed 8 days before today: too old.
    const old = [
      { day: '2026-10-27', total: 4_900_00 },
      { day: '2026-10-28', total: 5_100_00 },
      { day: '2026-11-05', total: 5_200_00 },
    ];
    expect(recentMilestone(old, 'USD', '2026-11-05')).toBeNull();
    // Zero-decimal currencies count in their own units.
    expect(recentMilestone([{ day: '2026-11-04', total: 900 }, { day: '2026-11-05', total: 1_200 }], 'JPY', '2026-11-05')).toBe(1000);
  });

  it('says how fresh the numbers are from the oldest healthy sync', () => {
    const [stripe, rc, pagekit, sandbox] = FIXTURE_CONNECTIONS;
    const twoHours = 2 * HOUR;
    // Pagekit is failing, so the oldest healthy sync is RevenueCat's, 27 minutes ago.
    expect(freshness([stripe!, rc!, pagekit!], FIXTURE_NOW, twoHours)).toEqual({ kind: 'fresh', ms: FIXTURE_NOW - 27 * MINUTE });
    expect(freshness([stripe!], FIXTURE_NOW + 3 * HOUR, twoHours).kind).toBe('stale');
    expect(freshness([pagekit!], FIXTURE_NOW, twoHours)).toEqual({ kind: 'down', ms: pagekit!.lastSyncedAt });
    expect(freshness([sandbox!], FIXTURE_NOW, twoHours)).toEqual({ kind: 'never', ms: null });
  });

  it('explains what the MRR leaves out or shows out of date, next to it', () => {
    const [stripe, rc, pagekit, sandbox] = FIXTURE_CONNECTIONS;
    const base = { fxMissing: [] as string[], now: FIXTURE_NOW, staleAfterMs: 2 * HOUR };
    const one = completenessNotes({ ...base, connections: [stripe!, rc!, pagekit!] });
    expect(one).toEqual([
      {
        tone: 'warning',
        text: 'Pagekit is showing numbers from Nov 5, 07:30 UTC. Its last sync failed.',
        link: { href: `/connections/${pagekit!.id}`, label: 'Fix it' },
      },
    ]);
    const bothFailing = completenessNotes({ ...base, connections: [{ ...stripe!, status: 'error' }, pagekit!] });
    expect(bothFailing[0]!.text).toBe('None of your connections has synced since Nov 5, 10:26 UTC.');
    const staleOne = completenessNotes({ ...base, connections: [stripe!], now: FIXTURE_NOW + 3 * HOUR });
    expect(staleOne[0]).toMatchObject({ text: 'Acme Analytics hasn’t synced since Nov 5, 10:26 UTC.', link: { label: 'See why' } });
    // A first sync: said here unless the sync notice already says it.
    expect(completenessNotes({ ...base, connections: [stripe!, sandbox!] })[0]).toMatchObject({
      tone: 'info',
      text: 'Stripe sandbox isn’t counted yet. Its first sync is running.',
    });
    expect(completenessNotes({ ...base, connections: [stripe!, sandbox!], firstSyncShown: true })).toEqual([]);
    expect(completenessNotes({ ...base, connections: [stripe!], fxMissing: ['ARS'] })[0]!.text).toBe(
      'ARS amounts aren’t included. There’s no exchange rate for ARS yet.',
    );
    const demo = { ...stripe!, id: 'demo-id', name: 'Demo data', provider: 'demo' as const };
    expect(completenessNotes({ ...base, connections: [stripe!, demo] })[0]).toMatchObject({
      text: 'Includes demo data, so these totals aren’t all real.',
      form: { action: '/connections/demo-id/delete', label: 'Remove demo data', fields: { back: '/dashboard' } },
    });
    expect(completenessNotes({ ...base, connections: [demo] })).toEqual([]); // demo alone is honest
    // Never more than three lines.
    const many = completenessNotes({ ...base, connections: [stripe!, pagekit!, sandbox!, demo], fxMissing: ['ARS', 'XAF'] });
    expect(many).toHaveLength(3);
    // Failing, first sync, FX and demo: two shown, two folded.
    expect(many[2]).toMatchObject({ text: '2 more things need a look.', link: { href: '/connections' } });
  });

  it('leads with MRR and its trend, then puts each warning next to the figure it affects', async () => {
    const data = fixtureDashboard(30, 'warnings', FIXTURE_NOW);
    const out = await render(
      'dashboard-warnings',
      DashboardPage({
        chrome: { user, flash: null },
        data,
        connections: FIXTURE_CONNECTIONS.slice(0, 3),
        sync: null,
        now: FIXTURE_NOW,
        staleAfterMinutes: 120,
      }),
    );
    const at = (needle: string) => {
      const i = out.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    // Order: freshness, MRR card (figure, ARR, trend, notes), secondary row, By connection, Revenue.
    expect(at('Updated <time')).toBeLessThan(at('aria-label="MRR"'));
    expect(at('aria-label="MRR"')).toBeLessThan(at('ARR</p>'));
    expect(at('ARR</p>')).toBeLessThan(at('MRR, last 30 days'));
    expect(at('MRR, last 30 days')).toBeLessThan(at('Pagekit is showing numbers from'));
    expect(at('Pagekit is showing numbers from')).toBeLessThan(at('ARS amounts aren’t included.'));
    expect(at('ARS amounts aren’t included.')).toBeLessThan(at('aria-label="Subscriptions, trials and revenue"'));
    expect(at('aria-label="Subscriptions, trials and revenue"')).toBeLessThan(at('>By connection<'));
    expect(at('>By connection<')).toBeLessThan(at('>Revenue per day<'));
    expect(at('>Revenue per day<')).toBeLessThan(at('Habit — iOS reports a 28-day total only ($2,214)'));
    // The comparison is said once; each delta still speaks it.
    expect(out).toContain('Changes compare with 30 days ago. Revenue compares with the 30 days before.');
    expect(out.match(/>vs\. 30 days ago</g) ?? []).toHaveLength(1); // only the MRR delta shows it
    expect(out).toContain('<span class="sr-only"> vs. 30 days ago</span>');
    // Whole units on the dashboard. The "Show data" tables, tooltips and chart descriptions keep
    // cents: they're the detail. No area fill under the MRR line.
    const visible = out.replace(/<(details|title|desc)\b[\s\S]*?<\/\1>/g, '');
    expect(visible).not.toMatch(/\$[\d,]+\.\d\d/);
    expect(out).not.toContain('linearGradient');
  });

  it('keeps the trials delta neutral: fewer trials isn’t bad news by itself', async () => {
    const down = await html(DeltaBadge({ pct: -4.3, neutral: true }));
    expect(down).toContain('Down ');
    expect(down).toContain('text-base-content');
    expect(down).not.toContain('text-error');
    const up = await html(DeltaBadge({ pct: 4.3, neutral: true }));
    expect(up).not.toContain('text-success');
  });

  it('celebrates the first sync with live numbers, once, with a plain-link dismiss', async () => {
    const data = fixtureDashboard(30, 'full', FIXTURE_NOW);
    const base = { chrome: { user, flash: null }, data, connections: FIXTURE_CONNECTIONS.slice(0, 3), cadence: 'every hour' };
    const out = await render('dashboard-first', DashboardPage({ ...base, sync: null, celebrate: { dismissHref: '/dashboard?range=30' } }));
    expect(out).toContain('There it is: $9,');
    expect(out).toContain('MRR across 3 connections.');
    expect(out).toContain('It updates every hour.');
    expect(out).toContain('src="/mascot/cheer.png"');
    expect(out).toContain('href="/dashboard?range=30"');
    // Not while still syncing, and not without the trigger.
    const syncing = await html(DashboardPage({ ...base, sync: { refresh: null }, celebrate: { dismissHref: '/dashboard' } }));
    expect(syncing).not.toContain('There it is');
    expect(await html(DashboardPage({ ...base, sync: null }))).not.toContain('There it is');
  });

  it('confirms a new connection in the sync notice, so no flash has to', async () => {
    const sync = { refresh: { seconds: 5, url: '/dashboard?poll=1', stopUrl: '/dashboard?poll=21' } };
    const one = await render('sync-connected', SyncNotice({ sync, connected: ['Acme'], note: 'Demo data removed, so your totals are real.' }));
    expect(one).toContain('Connected to Acme. Adding up its first 90 days, usually in a few seconds. Demo data removed, so your totals are real.');
    const two = await html(SyncNotice({ sync, connected: ['Acme', 'Habit'] }));
    expect(two).toContain('Connected to Acme and Habit. Adding up their first 90 days');
    expect(await html(SyncNotice({ sync }))).toContain('Adding up your first 90 days');
  });

  it('shows a skeleton during the first sync and an explanation after a failed one, never $0', async () => {
    const [, , pagekit, sandbox] = FIXTURE_CONNECTIONS;
    const empty = fixtureDashboard(30, 'empty', FIXTURE_NOW);
    const base = { chrome: { user, flash: null }, data: empty, now: FIXTURE_NOW };
    const syncing = await render(
      'dashboard-first-sync',
      DashboardPage({ ...base, connections: [sandbox!], sync: { refresh: { seconds: 5, url: '/dashboard?poll=1' } } }),
    );
    expect(syncing).toContain('aria-busy="true"');
    expect(syncing).toContain('Your first numbers are on their way.');
    expect(syncing).toContain('Connected to Stripe sandbox.');
    expect(syncing).not.toContain('$0');
    expect(syncing).not.toContain('aria-label="Date range"'); // nothing to range over yet

    const failed = await render(
      'dashboard-no-numbers',
      DashboardPage({ ...base, connections: [{ ...pagekit!, lastSyncedAt: null }], sync: null }),
    );
    expect(failed).toContain('No numbers yet');
    expect(failed).toContain('Pagekit isn’t counted. Its first sync failed.');
    expect(failed).toContain(`href="/connections/${pagekit!.id}"`);
    expect(failed).not.toContain('$0');
    expect(failed).not.toContain('aria-busy');
  });

  it('fades the first-numbers strip in once and says when demo data made way', async () => {
    const data = fixtureDashboard(30, 'full', FIXTURE_NOW);
    const out = await html(
      DashboardPage({
        chrome: { user, flash: null },
        data,
        connections: FIXTURE_CONNECTIONS.slice(0, 2),
        sync: null,
        now: FIXTURE_NOW,
        celebrate: { dismissHref: '/dashboard?range=30' },
        demoRemoved: true,
      }),
    );
    expect(out).toMatch(/<section aria-labelledby="first-numbers" class="fade-in /);
    expect(out).toContain('You can stop checking now. Demo data removed, so your totals are real.');
  });

  it('gives the dashboard empty state the dozing owl and keeps the 500 page literal', async () => {
    const empty = await render(
      'dashboard-empty',
      DashboardPage({ chrome: { user, flash: null }, data: fixtureDashboard(30, 'empty'), connections: [], sync: null }),
    );
    expect(empty).toContain('Nothing to add up yet.');
    expect(empty).toContain('src="/mascot/dozing.png"');

    const notFound = await render('404', NotFoundPage({ chrome: { user: null, flash: null } }));
    expect(notFound).toContain('This page isn’t here.');
    expect(notFound).toContain('src="/mascot/lost.png"');

    const serverError = await render('500', ServerErrorPage({ chrome: { user, flash: null } }));
    expect(serverError).toContain('The error has been logged.');
    expect(serverError).not.toContain('/mascot/');
  });
});

describe('connection page', () => {
  const chrome = { user, flash: null };
  const page = (detail: ReturnType<typeof fixtureConnectionDetail>, extra: Record<string, unknown> = {}) =>
    ConnectionDetailPage({ chrome, detail, sync: null, now: FIXTURE_NOW, ...extra });

  it('leads with status and numbers, keeps changes in a closed Manage section, Sync now first', async () => {
    const out = await render('connection-ok', page(fixtureConnectionDetail(0)));
    expect(out).toMatch(/<form method="post" action="\/connections\/[^"]+\/sync"><button type="submit" class="btn btn-primary">Sync now<\/button>/);
    expect(out).toContain('<details id="manage" class="rounded-box');
    expect(out).not.toContain('<details id="manage" open');
    expect(out.indexOf('>Details<')).toBeLessThan(out.indexOf('>Recent snapshots<'));
    expect(out.indexOf('>Sync history<')).toBeLessThan(out.indexOf('id="manage"'));
    expect(out).toContain('Show the last 4 syncs');
  });

  it('makes Replace key the primary action after a failed sync, with Manage open', async () => {
    const failing = { ...fixtureConnectionDetail(2), status: 'error' as const };
    const out = await render('connection-failing', page(failing));
    expect(out).toContain('<a href="#replace-key" class="btn btn-primary">Replace key</a>');
    expect(out).toMatch(/<button type="submit" class="btn">Sync now<\/button>/); // still there, secondary
    expect(out).toContain('<details id="manage" open=""');
    expect(out).toContain('Last sync failed');
  });

  it('removes demo data from the header in one click, with no Manage section or checkbox', async () => {
    const demo = { ...fixtureConnectionDetail(0), provider: 'demo' as const, name: 'Demo data', keyHint: null };
    const out = await render('connection-demo', page(demo));
    expect(out).toContain('>Remove demo data</button>');
    expect(out).not.toContain('id="manage"');
    expect(out).not.toContain('type="checkbox"');
  });

  it('follows a manual sync and reports it once it’s done', async () => {
    const d = fixtureConnectionDetail(0);
    const running = await html(
      page(d, { manual: { state: 'running', why: 'key', sync: { refresh: { seconds: 5, url: '/x?poll=1', stopUrl: '/x?poll=21' } } } }),
    );
    expect(running).toContain('Key replaced. Syncing with the new key, usually in a few seconds.');
    expect(running).toContain('>Syncing…</button>');
    const done = await html(page(d, { manual: { state: 'done', why: 'sync', run: d.recentRuns[0]! } }));
    expect(done).toContain('Synced. 12 revenue events processed.');
  });
});

describe('CSP', () => {
  it('no rendered component uses an inline style attribute or inline script', () => {
    const names = Object.keys(rendered);
    expect(names.length).toBeGreaterThan(30);
    for (const name of names) {
      const out = rendered[name]!;
      expect(out, name).not.toContain(' style=');
      // The one script is the optional same-origin /app.js; never inline code.
      expect(out.replace('<script src="/app.js" defer=""></script>', ''), name).not.toMatch(/<script/i);
      expect(out, name).not.toMatch(/\son[a-z]+=/i);
    }
  });
});
