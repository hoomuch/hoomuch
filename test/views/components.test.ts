/**
 * Design-system components rendered with react-dom/server, the Worker's renderer (no JSX in .ts tests).
 * Owner: Experience (design).
 */

import { createElement, type ComponentType, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { listConnectionSummaries } from '../../src/data/connections';
import { getDashboardData } from '../../src/data/dashboard';
import { listTransactions } from '../../src/data/transactions';
import { createTestD1, seedConnection, seedUser, testEnv } from '../fixtures/d1';
import { BreakdownTable } from '../../src/views/components/breakdown-table';
import { ProductTable } from '../../src/views/components/product-table';
import { ConnectionForm } from '../../src/views/components/connection-form';
import { DangerZone } from '../../src/views/components/danger-zone';
import { EmptyState } from '../../src/views/components/empty-state';
import { Flash } from '../../src/views/components/flash';
import { DeltaBadge, KpiStat } from '../../src/views/components/kpi';
import { RangeTabs } from '../../src/views/components/range-tabs';
import { RelativeTime } from '../../src/views/components/relative-time';
import { PageRoot } from '../../src/views/page-root';
import { ProviderDot, StatusBadge, TestModeBadge } from '../../src/views/components/badges';
import { RingsMark } from '../../src/views/components/icons';
import { ProviderLogo } from '../../src/views/components/provider-logos';
import { ProviderPickerPage } from '../../src/views/pages/connections';
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
  ScrollTable,
} from '../../src/views/components/ui';
import { Layout } from '../../src/views/layout';
import { SyncNotice, syncCadence } from '../../src/views/pages/shared';
import { Owl, OWL_SIZE } from '../../src/views/components/mascot';
import { LandingPage } from '../../src/views/pages/landing';
import {
  completenessNotes,
  DashboardPage,
  freshness,
  ProductCard,
  milestoneAtOrBelow,
  mrrOwl,
  recentMilestone,
  RevenueCard,
} from '../../src/views/pages/dashboard';
import { NotFoundPage, ServerErrorPage } from '../../src/views/pages/errors';
import { AuthPage } from '../../src/views/pages/auth';
import { SettingsPage } from '../../src/views/pages/settings';
import { TransactionsPage } from '../../src/views/pages/transactions';
import { ConnectionDetailPage } from '../../src/views/pages/connection-detail';
import { MAX_POLLS, parsePoll, POLL_SECONDS, POLL_STOPPED, syncState } from '../../src/routes/util';
import { HARD_STOP_GRACE_MS, SYNC_DEADLINE_MS } from '../../src/sync/engine';
import {
  fixtureConnectionDetail,
  fixtureDashboard,
  FIXTURE_CONNECTIONS,
  FIXTURE_NOW,
  fixtureTransactions,
} from '../../src/views/fixtures';
import { getProviderMeta, PROVIDERS } from '../../src/providers/registry';
import { HOUR, MINUTE } from '../../src/lib/time';

/** A React element for a component and its props (no JSX in .ts tests). */
function h<P extends object>(component: ComponentType<P>, props: P): ReactElement {
  return createElement(component, props);
}

/** Server HTML for an element, as the Worker renders it (without React's hydration markers). */
async function html(node: ReactElement): Promise<string> {
  return renderToStaticMarkup(node);
}

/** Every rendered sample, collected so the CSP check below covers all of them. */
const rendered: Record<string, string> = {};
async function render(name: string, node: ReactElement): Promise<string> {
  const out = await html(node);
  rendered[name] = out;
  return out;
}

/** The opening tags of `tag` elements that contain every needle (attribute order doesn't matter). */
function tags(out: string, tag: string, ...needles: string[]): string[] {
  return [...out.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((m) => m[0]).filter((t) => needles.every((n) => t.includes(n)));
}

const user = { id: 'u1', email: 'ada@example.com', baseCurrency: 'USD', timeZone: 'UTC' };

describe('Layout', () => {
  it('renders the shell with doctype, title, skip link, nav state and Settings apart on the right', async () => {
    const out = await render(
      'layout',
      h(Layout, { title: 'Dashboard', user, flash: { type: 'success', message: 'Connected.' }, nav: 'dashboard', noindex: true, children: 'Body' }),
    );
    expect(out.startsWith('<html lang="en">')).toBe(true);
    expect(out).toContain('<title>Dashboard · hoomuch</title>');
    expect(out).toContain('href="#main"');
    expect(out).toContain('id="main"');
    expect(tags(out, 'a', 'href="/dashboard"', 'aria-current="page"')).toHaveLength(1);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    // Three daily places in the nav; Settings on its own; Log out lives in Settings, not the bar.
    expect(tags(out, 'a', 'data-slot="nav-link"').filter((t) => /href="\/(dashboard|connections|transactions)"/.test(t))).toHaveLength(3);
    expect(out).toMatch(/<div class="[^"]*ml-auto[^"]*"><a href="\/settings"/);
    expect(out).not.toContain('action="/logout"');
    // The browser bundle: same origin, a deferred module, never inline code. Geist is preloaded.
    expect(out).toContain('<script type="module" src="/client/entry.js"></script>');
    expect(out).toContain('href="/fonts/geist.woff2"');
    expect(out).toContain('name="robots" content="noindex"');
    expect(out).toContain('role="status"');
    expect(out).toContain('Body');
    // App footer: the wordmark, the source (AGPL-3.0 §13) and issues, the read-only promise.
    // No backdrop here, so no owl.
    const footer = out.slice(out.indexOf('<footer'), out.indexOf('</footer>'));
    expect(footer).toContain('<span class="sr-only">hoomuch</span>');
    expect(footer).toContain('href="https://github.com/hoomuch/hoomuch"');
    expect(footer).toContain('href="https://github.com/hoomuch/hoomuch/issues"');
    expect(footer).toContain('Only ever reads. Keys are encrypted at rest.');
    expect(footer).not.toContain('/mascot/');
  });

  it('puts the asleep owl on the daily pages’ footer, never on Settings', async () => {
    const footerOf = (s: string) => s.slice(s.indexOf('<footer'), s.indexOf('</footer>'));
    const daily = await html(h(Layout, { title: 'Dashboard', user, flash: null, nav: 'dashboard', backdrop: true }));
    expect(footerOf(daily)).toContain('src="/mascot/asleep.png"');
    const settings = await html(h(Layout, { title: 'Settings', user, flash: null, nav: 'settings', backdrop: true }));
    expect(footerOf(settings)).not.toContain('/mascot/');
    const connection = await html(h(Layout, { title: 'Stripe', user, flash: null, nav: 'connections' }));
    expect(footerOf(connection)).not.toContain('/mascot/');
  });

  it('gives marketing pages the owl footer with its links and the page’s dry line', async () => {
    const out = await render(
      'layout-marketing',
      h(Layout, { title: 'Home', user: null, flash: null, marketing: true, footerNote: 'Syncs every hour, so you can check less often.' }),
    );
    const footer = out.slice(out.indexOf('<footer'), out.indexOf('</footer>'));
    expect(footer).toContain('src="/mascot/asleep.png"');
    expect(footer).toContain('Syncs every hour, so you can check less often.');
    expect(footer).toContain('aria-label="Footer"');
    for (const href of ['/#demo', '/#store', '/login', 'https://github.com/hoomuch/hoomuch#deploy-to-cloudflare']) {
      expect(footer).toContain(`href="${href}"`);
    }
    expect(footer).toContain('href="https://github.com/hoomuch/hoomuch/blob/main/LICENSE"');
  });

  it('hides the app nav when signed out and supports the narrow column and refresh', async () => {
    const out = await render(
      'layout-narrow',
      h(Layout, { title: 'Log in', user: null, flash: null, width: 'narrow', refresh: { seconds: 5, url: '/dashboard?poll=1' } }),
    );
    expect(out).not.toContain('aria-label="Main"');
    expect(out).not.toContain('/logout');
    expect(out).toContain('max-w-[28rem]');
    expect(out).toContain('content="5;url=/dashboard?poll=1"');
  });
});

describe('Flash', () => {
  it('renders nothing without a message', async () => {
    expect(await html(h(Flash, { flash: null }))).toBe('');
  });

  it('uses role=alert for errors and role=status otherwise, with a spoken tone word', async () => {
    const err = await render('flash-error', h(Flash, { flash: { type: 'error', message: 'Something went wrong.' } }));
    expect(err).toContain('role="alert"');
    expect(err).toContain('Error:');
    const ok = await render('flash-success', h(Flash, { flash: { type: 'success', message: 'Connected.' } }));
    expect(ok).toContain('role="status"');
    const info = await render('flash-info', h(Flash, { flash: { type: 'info', message: 'Syncing.' } }));
    expect(info).toContain('role="status"');
  });
});

describe('DeltaBadge and KpiStat', () => {
  it('renders "—" for a null delta', async () => {
    const out = await render('delta-null', h(DeltaBadge, { pct: null }));
    expect(out).toContain('—');
    expect(out).not.toMatch(/\d%/);
  });

  it('says up/down in words, not only colour, and flips tone with invert', async () => {
    const up = await render('delta-up', h(DeltaBadge, { pct: 4.24 }));
    expect(up).toContain('Up ');
    expect(up).toContain('4.2%');
    expect(up).toContain('text-success');

    const down = await render('delta-down', h(DeltaBadge, { pct: -3 }));
    expect(down).toContain('Down ');
    expect(down).toContain('3.0%');
    expect(down).not.toMatch(/[+−-]3\.0%/); // the arrow carries the sign
    expect(down).toContain('text-destructive-foreground');

    const refundsUp = await render('delta-invert', h(DeltaBadge, { pct: 12, invert: true }));
    expect(refundsUp).toContain('Up ');
    expect(refundsUp).toContain('text-destructive-foreground');

    const flat = await render('delta-flat', h(DeltaBadge, { pct: 0.01 }));
    expect(flat).toContain('Unchanged');
    expect(flat).toContain('0.0%');
  });

  it('makes the hero the biggest figure, with tabular numbers', async () => {
    const hero = await render('kpi-hero', h(KpiStat, { label: 'MRR', value: '$9,090', hero: true, deltaPct: 4.2, deltaLabel: 'vs. 30 days ago' }));
    expect(hero).toContain('sm:text-display');
    expect(hero).toContain('tabular-nums');
    expect(hero).toContain('vs. 30 days ago');
    const small = await render('kpi', h(KpiStat, { label: 'ARR', value: '$109,080', deltaPct: null, hint: 'MRR × 12' }));
    expect(small).not.toContain('text-display');
    expect(small).toContain('—');
    const noDelta = await render('kpi-nodelta', h(KpiStat, { label: 'Trials', value: '50' }));
    expect(noDelta).not.toContain('—');
  });
});

describe('badges', () => {
  it('renders the provider dot from a literal class and every status with a text label', async () => {
    expect(await render('dot', h(ProviderDot, { dotClass: 'bg-[#635BFF]', size: 'md' }))).toContain('bg-[#635BFF]');
    const labels = { ok: 'Up to date', syncing: 'Syncing', pending: 'Pending', error: 'Error' } as const;
    for (const status of ['ok', 'syncing', 'pending', 'error'] as const) {
      expect(await render(`status-${status}`, h(StatusBadge, { status }))).toContain(labels[status]);
    }
    expect(await render('test-mode', h(TestModeBadge, {}))).toContain('Test mode');
    expect(await render('mark', h(RingsMark, {}))).toContain('aria-hidden="true"');
  });
});

describe('RangeTabs', () => {
  it('links every range and marks the current one with aria-current', async () => {
    const out = await render('range', h(RangeTabs, { current: 30, basePath: '/preview/dashboard' }));
    expect(out).toContain('href="/preview/dashboard?range=7"');
    expect(out).toContain('href="/preview/dashboard?range=90"');
    // The year is 52 whole weeks; the tab says "1 year".
    expect(out).toMatch(/href="\/preview\/dashboard\?range=364"[^>]*>(?:<[^>]+>)*<span class="sr-only">Last <\/span>1 year/);
    expect(out).toMatch(/href="\/preview\/dashboard\?range=30" aria-current="page"/);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe('RevenueCard', () => {
  it('links Bars and Line, keeping the range and landing back on the card', async () => {
    const data = fixtureDashboard(90, 'full', FIXTURE_NOW);
    const line = await render('revenue-card-line', h(RevenueCard, { data, variant: 'line' }));
    expect(tags(line, 'section', 'id="revenue"')).toHaveLength(1);
    expect(line).toContain('<nav aria-label="Revenue chart"');
    expect(line).toContain('href="/dashboard?range=90&amp;revenue=bars#revenue"');
    expect(tags(line, 'a', 'href="/dashboard?range=90&amp;revenue=line#revenue"', 'aria-current="page"')).toHaveLength(1);
    expect(line).not.toContain('aria-label="Legend"');

    const bars = await render('revenue-card-bars', h(RevenueCard, { data, basePath: '/preview/dashboard' }));
    expect(tags(bars, 'a', 'href="/preview/dashboard?range=90&amp;revenue=bars#revenue"', 'aria-current="page"')).toHaveLength(1);
    expect(bars).toContain('aria-label="Legend"');
  });
});

describe('BreakdownTable', () => {
  it('renders right-aligned figures, an SVG share bar and "—" for missing data', async () => {
    const data = fixtureDashboard(30);
    const out = await render('breakdown', h(BreakdownTable, { rows: data.breakdown, currency: data.currency, rangeDays: 30 }));
    for (const r of data.breakdown) expect(out).toContain(`/connections/${r.id}`);
    expect(out).toMatch(/<rect width="\d+(\.\d)?%"/);
    expect(out).toContain('text-right');
    expect(out).toContain('—'); // the Lemon Squeezy row has no trial count
    expect(out).toContain('Revenue');
  });

  it('shows the test-mode badge on test connections', async () => {
    const row = { ...FIXTURE_CONNECTIONS[3]!, mrr: 0, activeSubscriptions: 0, activeTrials: null, revenue: null, sharePct: 0 };
    const out = await render('breakdown-test', h(BreakdownTable, { rows: [row], currency: 'USD', rangeDays: 7 }));
    expect(out).toContain('Test mode');
    expect(out).toContain('0%');
  });
});

describe('ProductTable', () => {
  const row = (name: string, connectionId: string, revenue: number) => ({
    name,
    connectionId,
    connectionName: connectionId === 'a' ? 'Pagekit' : 'Habit',
    dotClass: 'bg-[#AD7D00]',
    revenue,
    charges: 3,
    sharePct: 40,
  });

  it('lists products, then the rest folded and what came without a name', async () => {
    const data = fixtureDashboard(30);
    const out = await render('products', h(ProductTable, { products: data.products, currency: data.currency, rangeDays: 30 }));
    for (const r of data.products.rows) expect(out).toContain(r.name);
    expect(out).toContain('No product name');
    expect(out).toContain('Revenue by product, highest first');
    expect(out).toMatch(/<rect width="\d+(\.\d)?%"/);
    expect(out).toContain('—'); // no charge count for the unnamed row
    expect(out).not.toMatch(/\$[\d,]+\.\d\d/); // whole units
    // One connection: its name is for screen readers only, the dot says the rest.
    expect(out).toContain('<span class="sr-only">, Pagekit</span>');
  });

  it('names the connection when products come from several, and folds the tail', async () => {
    const out = await render(
      'products-many',
      h(ProductTable, {
        products: {
          rows: [row('Pro', 'a', 50_00), row('Pro', 'b', 40_00)],
          more: { count: 4, revenue: 10_00, charges: 6, sharePct: 10 },
          unnamed: { revenue: 0, sharePct: 0 },
          unnamedProviders: [],
          named: true,
        },
        currency: 'USD',
        rangeDays: 7,
      }),
    );
    expect(out).toContain('>Pagekit</span>');
    expect(out).toContain('>Habit</span>');
    expect(out).toContain('4 more products');
    expect(out).not.toContain('No product name'); // nothing came without one
  });
});

describe('ProductCard', () => {
  const NO_SPLIT = { rows: [], more: null, unnamed: { mrr: 0, sharePct: 0 }, unnamedProviders: [], needsPermission: [], split: false };
  const headings = (out: string) => [...out.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);

  it('splits MRR and revenue by product under their own headings, and says where the rest went', async () => {
    const out = await render('product-card', h(ProductCard, { data: fixtureDashboard(30, 'full', FIXTURE_NOW) }));
    expect(out).toContain('>By product<');
    expect(headings(out)).toEqual(['MRR now', 'Revenue, last 30 days']);
    expect(tags(out, 'table')).toHaveLength(2);
    // MRR first: Stripe's products, then the providers that don't split MRR.
    expect(out.indexOf('MRR by product, highest first')).toBeLessThan(out.indexOf('Revenue by product, highest first'));
    expect(out).toContain('>Subscriptions<');
    expect(out).toContain('title="Acme Pro"');
    expect(out).toContain('MRR from RevenueCat and Lemon Squeezy isn’t split by product, so it’s under “No product name”.');
    expect(out).toContain('Revenue from Stripe and RevenueCat comes without product names, so it’s under “No product name”.');
  });

  it('shows only the MRR split when no provider names what was sold', async () => {
    const data = fixtureDashboard(30, 'single', FIXTURE_NOW); // Stripe only
    const out = await render('product-card-mrr-only', h(ProductCard, { data }));
    expect(tags(out, 'table')).toHaveLength(1);
    expect(headings(out)).toEqual([]);
    expect(out).toContain('MRR by product, highest first');
    expect(out).not.toContain('No product name<');
    expect(out).toContain('Revenue from Stripe comes without product names, so only MRR is split here.');
  });

  it('says why there’s no table when nothing can be split, and how to split Stripe MRR', async () => {
    const data = fixtureDashboard(30, 'single', FIXTURE_NOW);
    data.productMrr = { ...NO_SPLIT, unnamed: { mrr: data.kpis.mrr.value, sharePct: 100 }, needsPermission: ['Acme Analytics'] };
    const out = await render('product-card-unnamed', h(ProductCard, { data }));
    expect(out).toContain('Revenue from Stripe comes without product names, so it can’t be split by product.');
    expect(out).toContain('Acme Analytics can split MRR by product once its Stripe key has Products: Read.');
    expect(out).not.toContain('<table');

    data.productMrr.needsPermission = ['Acme Analytics', 'Acme EU'];
    expect(await html(h(ProductCard, { data }))).toContain('Acme Analytics and Acme EU can split MRR by product once their Stripe keys have Products: Read.');
  });

  it('says so when nothing sold in the window', async () => {
    const data = fixtureDashboard(7, 'full', FIXTURE_NOW);
    data.products = { rows: [], more: null, unnamed: { revenue: 0, sharePct: 0 }, unnamedProviders: [], named: true };
    data.productMrr = NO_SPLIT;
    const out = await render('product-card-empty', h(ProductCard, { data }));
    expect(out).toContain('No sales in the last 7 days.');
    expect(out).not.toContain('<table');
  });

  it('says so when the split has no MRR in it', async () => {
    const data = fixtureDashboard(30, 'single', FIXTURE_NOW);
    data.productMrr = { ...NO_SPLIT, split: true };
    const out = await render('product-card-mrr-empty', h(ProductCard, { data }));
    expect(out).toContain('No MRR to split by product.');
    expect(out).not.toContain('<table');
  });
});

describe('ProviderLogo', () => {
  it('draws every provider as a decorative tile, with no remote image and unique clip ids', async () => {
    for (const p of PROVIDERS) {
      const out = await render(`logo-${p.id}`, h(ProviderLogo, { provider: p.id, size: 'lg' }));
      expect(out, p.id).toMatch(/^<(svg|span)\b[^>]*aria-hidden="true"/);
      expect(out, p.id).toContain('size-8');
      expect(out, p.id).not.toMatch(/<img|href=|xlink/);
    }
    // Two Polar logos on one page must not share a clipPath id.
    const twice = await html(createElement('div', null, h(ProviderLogo, { provider: 'polar' }), h(ProviderLogo, { provider: 'polar' })));
    const ids = [...twice.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('shows each real provider in the picker as a logo card, the demo row apart', async () => {
    const out = await render('provider-picker', h(ProviderPickerPage, { chrome: { user, flash: null } }));
    for (const p of PROVIDERS.filter((x) => x.id !== 'demo')) {
      expect(out).toContain(`href="/connections/new?provider=${p.id}"`);
      expect(out).toContain(p.name);
    }
    expect(tags(out, 'svg', 'size-8')).toHaveLength(PROVIDERS.length - 1);
    expect(out).toContain('href="/connections/new?provider=demo"');
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
          h(ConnectionForm, {
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
      h(ConnectionForm, { meta, mode: 'create', action: '/connections', values: { name: 'Pagekit', storeId: '18234', apiKey: SECRET }, fieldErrors: { apiKey: 'Required.' } }),
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
    const out = await render('form-rotate', h(ConnectionForm, { meta: getProviderMeta('stripe'), mode: 'rotate', action: '/connections/x/rotate', cancelHref: '/connections/x' }));
    expect(out).not.toContain('Create a Stripe key');
    expect(out).not.toContain('name="provider"');
    expect(out).toContain('Replace key');
    expect(out).toContain('Cancel');
  });
});

describe('ui primitives', () => {
  it('Field wires aria-describedby and aria-invalid', async () => {
    const out = await render('field-error', h(Field, { name: 'email', label: 'Email', type: 'email', help: 'We never share it.', error: 'Enter a valid email.', required: true }));
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="email-error email-help"');
    expect(out).toContain('id="email-error"');
    expect(out).toContain('id="email-help"');
    expect(tags(out, 'label', 'for="email"')).toHaveLength(1);

    const calm = await render('field', h(Field, { name: 'storeId', label: 'Store ID', help: 'Optional.' }));
    expect(calm).not.toContain('aria-invalid="');
    expect(calm).toContain('aria-describedby="storeId-help"');
    expect(calm).toContain('(optional)');
  });

  it('Field never echoes a password value', async () => {
    const out = await render('field-password', h(Field, { name: 'password', label: 'Password', type: 'password', value: 'hunter2hunter2', required: true }));
    expect(out).not.toContain('hunter2');
  });

  it('SelectField, ConfirmCheckbox and FormError wire their errors too', async () => {
    const sel = await render(
      'select',
      h(SelectField, { name: 'currency', label: 'Currency', options: [{ value: 'USD', label: 'US dollar' }, { value: 'EUR', label: 'Euro' }], value: 'EUR', error: 'Pick one.', help: 'Used for every total.' }),
    );
    // coss Select (Base UI): a combobox trigger named by the label, the value posted by a hidden input.
    expect(tags(sel, 'button', 'id="currency"', 'role="combobox"', 'aria-invalid="true"', 'aria-describedby="currency-error currency-help"')).toHaveLength(1);
    expect(tags(sel, 'label', 'for="currency"')).toHaveLength(1);
    expect(tags(sel, 'input', 'name="currency"', 'value="EUR"')).toHaveLength(1);
    expect(sel).toContain('Euro');

    const cb = await render('confirm', h(ConfirmCheckbox, { label: 'I understand this deletes everything.', error: 'Please confirm.' }));
    expect(tags(cb, 'input', 'type="checkbox"', 'name="confirm"', 'value="yes"', 'required=""')).toHaveLength(1);
    expect(tags(cb, 'span', 'role="checkbox"', 'aria-describedby="confirm-error"')).toHaveLength(1);

    expect(await html(h(FormError, { message: null }))).toBe('');
    expect(await render('form-error', h(FormError, { message: 'Wrong email or password.' }))).toContain('role="alert"');
  });

  it('renders page structure, alerts and button variants from literal classes', async () => {
    expect(await render('header', h(PageHeader, { title: 'Connections', description: 'Accounts', actions: 'x', back: { href: '/connections', label: 'Connections' } }))).toContain('<h1');
    expect(await render('card', h(Card, { title: 'Revenue', description: 'Daily', children: 'chart', className: 'md:col-span-2' }))).toContain('<h2');
    for (const tone of ['info', 'success', 'warning', 'error'] as const) {
      expect(await render(`alert-${tone}`, h(Alert, { tone, title: 'Title', children: 'Body' }))).toContain('Body');
    }
    // coss buttons: primary is the ink fill, secondary outline, danger destructive-outline. Submit by default.
    const save = await render('btn', h(Button, { children: 'Save' }));
    expect(tags(save, 'button', 'type="submit"', 'data-slot="button"', 'bg-primary')).toHaveLength(1);
    expect(save).not.toMatch(/\sdisabled=""/);
    const ghost = await render('btn-sm', h(Button, { variant: 'ghost', small: true, type: 'button', children: 'x' }));
    expect(tags(ghost, 'button', 'type="button"', 'hover:bg-accent', 'h-8')).toHaveLength(1);
    expect(await render('btn-danger', h(Button, { variant: 'danger', children: 'Delete' }))).toContain('text-destructive-foreground');
    const go = await render('link-btn', h(LinkButton, { href: '/x', variant: 'secondary', block: true, children: 'Go' }));
    expect(tags(go, 'a', 'href="/x"', 'border-input', 'w-full')).toHaveLength(1);
  });

  it('renders EmptyState, DangerZone and RelativeTime', async () => {
    expect(await render('empty', h(EmptyState, { title: 'No connections yet', children: 'Connect one.', actions: 'a' }))).toContain('No connections yet');
    const dz = await render('danger', h(DangerZone, { title: 'Delete account', description: 'Gone for good.', children: 'form' }));
    expect(dz).toContain('aria-labelledby="delete-account-title"');
    expect(dz).toContain('id="delete-account-title"');
    expect(await render('time', h(RelativeTime, { ms: FIXTURE_NOW - 4 * MINUTE, now: FIXTURE_NOW }))).toContain('4 min ago');
    expect(await render('time-never', h(RelativeTime, { ms: null }))).toContain('Never');
  });

  it('titles RelativeTime with the time in the page’s zone', async () => {
    // 20:00 UTC on Nov 4 is 01:30 on Nov 5 in Kolkata (+05:30).
    const ms = Date.UTC(2026, 10, 4, 20, 0);
    const inZone = (timeZone: string) =>
      render(`time-${timeZone}`, createElement(PageRoot, { json: '{}', now: FIXTURE_NOW, timeZone }, h(RelativeTime, { ms })));
    expect(tags(await inZone('Asia/Kolkata'), 'time', 'title="Nov 5, 2026, 01:30 Asia/Kolkata"')).toHaveLength(1);
    expect(tags(await inZone('UTC'), 'time', 'title="Nov 4, 2026, 20:00 UTC"')).toHaveLength(1);
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
      h(Layout, { title: 'Dashboard', user, flash: null, nav: 'dashboard', refresh: { seconds: 3, url: '/dashboard?poll=1', stopUrl: '/dashboard?poll=21' } }),
    );
    const stops = focusables(out);
    expect(stops[0]).toContain('href="#main"');
    expect(stops[1]).toContain('href="/dashboard?poll=21"');
    expect(out).toContain('Stop automatic refresh');
    expect(stops[1]).toContain('focus:not-sr-only');

    const plain = await render('layout-plain', h(Layout, { title: 'Dashboard', user, flash: null, refresh: { seconds: 3, url: '/x?poll=1' } }));
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

    const polling = await render('sync-polling', h(SyncNotice, { sync: first }));
    expect(polling).toContain('refreshes on its own');
    expect(polling).toContain(`href="${url(POLL_STOPPED).replace('&', '&amp;')}"`);
    expect(polling).toContain('Stop refreshing');
    expect(await render('sync-stopped', h(SyncNotice, { sync: { refresh: null, stopped: true } }))).toContain('Automatic refresh is off');
    const spent = await render('sync-spent', h(SyncNotice, { sync: { refresh: null } }));
    expect(spent).toContain('longer than usual');
    expect(spent).not.toContain('Stop refreshing');
  });

  it('keeps polling for as long as a sync can run, plus the queue picking it up', () => {
    expect(MAX_POLLS * POLL_SECONDS * 1000).toBeGreaterThanOrEqual(SYNC_DEADLINE_MS + HARD_STOP_GRACE_MS + 30_000);
  });

  it('keeps live-region roles for action results only', async () => {
    expect(await render('alert-static', h(Alert, { tone: 'error', title: 'Last sync failed', children: 'x' }))).not.toContain('role=');
    expect(await render('alert-warning', h(Alert, { tone: 'warning', children: 'x' }))).not.toContain('role=');
    expect(await render('alert-status', h(Alert, { tone: 'info', role: 'status', children: 'x' }))).toContain('role="status"');
    expect(await html(h(Flash, { flash: { type: 'error', message: 'x' } }))).toContain('role="alert"');
    expect(await html(h(FormError, { message: 'x' }))).toContain('role="alert"');
  });

  it('makes FormError and ConfirmCheckbox autofocus targets on request', async () => {
    const calm = await render('form-error-calm', h(FormError, { message: 'Email or password is incorrect.' }));
    expect(calm).not.toContain('tabindex');
    expect(calm).not.toContain('autofocus');
    const focused = await render('form-error-focus', h(FormError, { message: 'Email or password is incorrect.', autoFocus: true }));
    expect(focused).toContain('tabindex="-1"');
    expect(focused).toContain('autofocus=""');
    const confirm = await render('confirm-focus', h(ConfirmCheckbox, { label: 'Yes', autoFocus: true }));
    expect(tags(confirm, 'span', 'role="checkbox"', 'autofocus=""')).toHaveLength(1);
    // Not "invalid" before anything was submitted (Chromium maps the native required state otherwise).
    expect(confirm).toContain('aria-invalid="false"');
    expect(await html(h(ConfirmCheckbox, { label: 'Yes', error: 'Tick the box.' }))).toContain('aria-invalid="true"');
  });

  it('wraps wide tables in a focusable, named, positioned scroller', async () => {
    const out = await render('scroller', h(ScrollTable, { labelledBy: 'cap' }));
    expect(tags(out, 'div', 'role="region"', 'aria-labelledby="cap"', 'tabindex="0"', 'relative w-full overflow-x-auto')).toHaveLength(1);
    expect(out).toContain('<table');
    expect(await render('scroller-label', h(ScrollTable, { label: 'Data' }))).toContain('aria-label="Data"');

    const data = fixtureDashboard(30);
    const bd = await render('breakdown-a11y', h(BreakdownTable, { rows: data.breakdown, currency: data.currency, rangeDays: 30 }));
    const cap = bd.match(/<caption id="([^"]+)"[^>]*>([^<]+)<\/caption>/);
    expect(cap).not.toBeNull();
    expect(bd).toContain(`aria-labelledby="${cap![1]}"`);
    expect(cap![2]).toContain('highest first');
  });

  it('says "Not available" instead of a bare dash', async () => {
    const out = await render('na', h(NotAvailable, {}));
    expect(out).toContain('<span aria-hidden="true">—</span>');
    expect(out).toContain('<span class="sr-only">Not available</span>');
  });

  it('focuses the first invalid connection field, or the form error when no field has one', async () => {
    const meta = getProviderMeta('lemonsqueezy');
    const fieldErr = await render(
      'form-focus-field',
      h(ConnectionForm, { meta, mode: 'create', action: '/connections', error: 'Rejected.', fieldErrors: { apiKey: 'Rejected.' } }),
    );
    expect(fieldErr.match(/autofocus=""/g)).toHaveLength(1);
    expect(tags(fieldErr, 'input', 'id="apiKey"', 'autofocus=""')).toHaveLength(1);
    const formErr = await render('form-focus-form', h(ConnectionForm, { meta, mode: 'create', action: '/connections', error: 'Too many connections.' }));
    expect(formErr.match(/autofocus=""/g)).toHaveLength(1);
    expect(formErr).toMatch(/role="alert" tabindex="-1" autofocus=""/);
    const clean = await render('form-focus-none', h(ConnectionForm, { meta, mode: 'create', action: '/connections' }));
    expect(clean).not.toContain('autofocus');
    // The guide's external link says it opens a new tab.
    expect(clean).toMatch(/target="_blank"[^>]*>[\s\S]*?\(opens in a new tab\)/);
  });

  it('announces failed submits in the page title and focuses exactly one target', async () => {
    const chrome = { user: null, flash: null };
    const login = await render('auth-error', h(AuthPage, { chrome, mode: 'login', signupOpen: true, error: 'Email or password is incorrect.' }));
    expect(login).toContain('<title>Error: Log in · hoomuch</title>');
    expect(login.match(/autofocus=""/g)).toHaveLength(1);
    expect(login).toMatch(/role="alert" tabindex="-1" autofocus=""/);

    const signup = await render('auth-field', h(AuthPage, { chrome, mode: 'signup', signupOpen: true, error: 'Too short.', field: 'password' }));
    expect(signup).toContain('<title>Error: Sign up · hoomuch</title>');
    expect(signup.match(/autofocus=""/g)).toHaveLength(1);
    expect(tags(signup, 'input', 'id="password"', 'autofocus=""')).toHaveLength(1);
    // React writes some attribute names in camelCase (autoComplete, dateTime); HTML reads them case-insensitively.
    expect(signup).toMatch(/autocomplete="new-password"/i);

    const clean = await render('auth-clean', h(AuthPage, { chrome, mode: 'login', signupOpen: true }));
    expect(clean).toContain('<title>Log in · hoomuch</title>');
    expect(tags(clean, 'input', 'id="email"', 'autofocus=""')).toHaveLength(1);
    expect(clean).toMatch(/autocomplete="current-password"/i);
    expect(tags(clean, 'button', 'type="submit"', 'w-full')).toHaveLength(1);

    const settings = await render(
      'settings-errors',
      h(SettingsPage, {
        chrome: { user, flash: null },
        currency: 'USD',
        deleteAccount: { error: 'Not deleted.', fieldErrors: { password: 'Password is incorrect.', confirm: 'Tick the box.' } },
      }),
    );
    expect(settings).toContain('<title>Error: Settings · hoomuch</title>');
    expect(settings.match(/autofocus=""/g)).toHaveLength(1);
    expect(tags(settings, 'input', 'id="delete-password"', 'autofocus=""')).toHaveLength(1);
    expect(await html(h(SettingsPage, { chrome: { user, flash: null }, currency: 'USD' }))).not.toContain('autofocus');
  });

  it('keeps Log out in Settings, in the order currency, password, session, delete', async () => {
    const out = await render('settings', h(SettingsPage, { chrome: { user, flash: null }, currency: 'EUR', currencySource: 'inferred' }));
    const at = (needle: string) => out.indexOf(needle);
    expect(at('>Display currency<')).toBeLessThan(at('>Change password<'));
    expect(at('>Change password<')).toBeLessThan(at('>Session<'));
    expect(at('>Session<')).toBeLessThan(at('>Delete account<'));
    expect(out).toContain('action="/logout"');
    expect(out).toContain('ada@example.com');
    expect(out).toContain('Picked automatically: most of your MRR is in this currency.');
    expect(await html(h(SettingsPage, { chrome: { user, flash: null }, currency: 'USD', currencySource: 'chosen' }))).not.toContain(
      'Picked automatically',
    );
  });

  it('gives transactions a row header, a sort-order caption and named pagination', async () => {
    const out = await render(
      'transactions-a11y',
      h(TransactionsPage, {
        chrome: { user, flash: null },
        page: fixtureTransactions(2, null),
        hasConnections: true,
        filterProviders: ['stripe'],
      }),
    );
    expect(out).toContain('<title>Transactions, page 2 · hoomuch</title>');
    expect(out).toMatch(/<caption id="transactions-caption"[^>]*>Transactions, newest first, page 2<\/caption>/);
    expect(out).toContain('aria-labelledby="transactions-caption"');
    expect(out).toMatch(/<th scope="row"[^>]*><time datetime=/i);
    expect(tags(out, 'nav', 'aria-label="Pagination"')).toHaveLength(1);
    expect(tags(out, 'a', 'aria-label="Previous page"', 'href="/transactions?provider=all"')).toHaveLength(1);
    expect(tags(out, 'span', 'aria-current="page"')).toHaveLength(1);
    // Past page 1, the links say where their page starts (the cursors), so deep pages stay fast.
    const deep = await html(
      h(TransactionsPage, {
        chrome: { user, flash: null },
        page: { ...fixtureTransactions(3, null), hasMore: true, prevCursor: '1~c1~first', nextCursor: '1~c1~last' },
        hasConnections: true,
        filterProviders: ['stripe'],
      }),
    );
    expect(tags(deep, 'a', 'aria-label="Previous page"', 'href="/transactions?provider=all&amp;page=2&amp;after=1%7Ec1%7Efirst"')).toHaveLength(1);
    expect(tags(deep, 'a', 'aria-label="Next page"', 'href="/transactions?provider=all&amp;page=4&amp;before=1%7Ec1%7Elast"')).toHaveLength(1);
    // The provider filter: a segmented control of links, the current one marked.
    expect(tags(out, 'a', 'href="/transactions?provider=all"', 'aria-current="page"', 'data-slot="segmented-control-item"')).toHaveLength(1);
  });
});

describe('personality: owl, landing, first sync, 404', () => {
  it('renders the owl as a decorative, theme-aware picture sized by attributes', async () => {
    const out = await render('owl', h(Owl, { pose: 'dozing' }));
    expect(tags(out, 'source', 'srcSet="/mascot/dozing-dark.png"', 'media="(prefers-color-scheme: dark)"')).toHaveLength(1);
    expect(out).toContain('src="/mascot/dozing.png"');
    expect(out).toContain(`width="${OWL_SIZE.dozing}"`);
    expect(out).toContain('alt=""');
    expect(out).toContain('loading="lazy"');
    expect(await html(h(Owl, { pose: 'perched', eager: true }))).not.toContain('loading=');
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
    const out = await render('landing', h(LandingPage, { chrome: { user: null, flash: null }, signupOpen: true, demo, cadence: 'every hour' }));
    expect(out).toContain('Every store you sell in. One\u00a0MRR.');
    expect(out).toContain('aria-label="Supported providers"'); // the provider strip, from the registry
    expect(out).toContain('>Google Play<');
    expect(out).not.toContain('>Demo data<'); // the demo isn't a provider you can buy from
    expect(out.match(/href="\/signup"/g)).toHaveLength(2); // hero + last call, same action
    expect(out).toContain('aria-label="MRR"'); // the real MRR card
    expect(out).toContain('aria-label="Subscriptions, trials and revenue"');
    expect(out).toContain('>By product<'); // the demo has every card the dashboard has, up to the calendar
    expect(out).toContain('aria-label="Also in hoomuch"'); // and names what it can't show
    expect(out).toContain('href="/?range=90#demo"');
    expect(out).toContain('href="/?range=30&amp;revenue=line#revenue"');
    // The landing page doesn't remember choices, so its range tabs carry the line along.
    const line = await html(h(LandingPage, { chrome: { user: null, flash: null }, signupOpen: true, demo, cadence: 'every hour', revenueVariant: 'line' }));
    expect(line).toContain('href="/?range=90&amp;revenue=line#demo"');
    expect(tags(line, 'a', 'href="/?range=30&amp;revenue=line#revenue"', 'aria-current="page"')).toHaveLength(1);
    expect(out).toContain('Create a Stripe key');
    expect(out).not.toContain('dashboard.stripe.com'); // preview drops the outbound link
    expect(out).toContain('Setup is one key per store.');
    expect(out).toContain('Any of the 12 above.'); // counted from the registry
    expect(out).toContain('so they have full access'); // the full-access keys stay named plainly
    expect(out).toContain('AES-256-GCM');
    expect(out).toContain('Syncs run every hour, and about a minute after a new subscription or refund where you turn on webhooks.');
    expect(out).toContain('src="/mascot/perched.png"');
    expect(out).toContain('src="/mascot/asleep.png"'); // marketing footer
    expect(out).toContain('id="store"'); // the footer's "What we store" anchor
    expect(out).toContain('href="/login"'); // signed-out header link
    expect(out).toMatch(/href="https:\/\/github\.com\/hoomuch\/hoomuch"[^>]*aria-label="hoomuch on GitHub"/); // header icon link
    expect(out).not.toContain('NEEDS REAL DATA');
    expect(out).not.toContain('Why this exists'); // no founder note until it's real
    expect(out).toContain('Free until your MRR reaches $1,000.'); // the free tier leads the pricing
    expect(out).toContain('$9 per month'); // exact price, with its tax treatment
    expect(out).toContain('plus VAT or sales tax where it applies');

    const closed = await html(h(LandingPage, { chrome: { user: null, flash: null }, signupOpen: false, demo, cadence: 'every hour' }));
    expect(closed).not.toContain('href="/signup"');
    expect(closed).not.toContain('No key handy?');
    expect(closed).not.toContain('id="pricing-title"'); // a private instance doesn't advertise hoomuch.com
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
      h(DashboardPage, {
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
    // Order: freshness, MRR card (figure, ARR, trend, notes), secondary row, By connection, By product, Revenue.
    expect(at('Updated <time')).toBeLessThan(at('aria-label="MRR"'));
    expect(at('aria-label="MRR"')).toBeLessThan(at('ARR</p>'));
    expect(at('ARR</p>')).toBeLessThan(at('MRR, last 30 days'));
    expect(at('MRR, last 30 days')).toBeLessThan(at('Pagekit is showing numbers from'));
    expect(at('Pagekit is showing numbers from')).toBeLessThan(at('ARS amounts aren’t included.'));
    expect(at('ARS amounts aren’t included.')).toBeLessThan(at('aria-label="Subscriptions, trials and revenue"'));
    expect(at('aria-label="Subscriptions, trials and revenue"')).toBeLessThan(at('>By connection<'));
    expect(at('>By connection<')).toBeLessThan(at('>By product<'));
    expect(at('>By product<')).toBeLessThan(at('Habit — iOS reports a 28-day total only ($2,214), so it isn’t split by product here.'));
    expect(at('so it isn’t split by product here.')).toBeLessThan(at('>Revenue per day<'));
    expect(at('>Revenue per day<')).toBeLessThan(at('Habit — iOS reports a 28-day total only ($2,214), so it isn’t in these bars'));
    // The comparison is said once; each delta still speaks it.
    expect(out).toContain('Changes compare with 30 days ago. Revenue compares with the 30 days before.');
    expect(out.match(/>vs\. 30 days ago</g) ?? []).toHaveLength(1); // only the MRR delta shows it
    expect(out).toContain('<span class="sr-only"> vs. 30 days ago</span>');
    // Whole units on the dashboard. The "Show data" tables (collapsed panels) and the charts'
    // sr-only descriptions keep cents: they're the detail. No area fill under the MRR line.
    const visible = out
      .replace(/<div\b[^>]*data-slot="collapsible-panel"[\s\S]*?<\/table>/g, '')
      .replace(/<p\b[^>]*class="sr-only"[^>]*>[\s\S]*?<\/p>/g, '');
    expect(visible).not.toMatch(/\$[\d,]+\.\d\d/);
    expect(out).not.toContain('linearGradient');
  });

  it('keeps the trials delta neutral: fewer trials isn’t bad news by itself', async () => {
    const down = await html(h(DeltaBadge, { pct: -4.3, neutral: true }));
    expect(down).toContain('Down ');
    expect(down).toContain('text-foreground');
    expect(down).not.toContain('text-destructive');
    const up = await html(h(DeltaBadge, { pct: 4.3, neutral: true }));
    expect(up).not.toContain('text-success');
  });

  it('celebrates the first sync with live numbers, once, with a plain-link dismiss', async () => {
    const data = fixtureDashboard(30, 'full', FIXTURE_NOW);
    const base = { chrome: { user, flash: null }, data, connections: FIXTURE_CONNECTIONS.slice(0, 3), cadence: 'every hour' };
    const out = await render('dashboard-first', h(DashboardPage, { ...base, sync: null, celebrate: { dismissHref: '/dashboard?range=30' } }));
    expect(out).toContain('There it is: $9,');
    expect(out).toContain('MRR across 3 connections.');
    expect(out).toContain('It updates every hour.');
    expect(out).toContain('src="/mascot/cheer.png"');
    expect(out).toContain('href="/dashboard?range=30"');
    // Not while still syncing, and not without the trigger.
    const syncing = await html(h(DashboardPage, { ...base, sync: { refresh: null }, celebrate: { dismissHref: '/dashboard' } }));
    expect(syncing).not.toContain('There it is');
    expect(await html(h(DashboardPage, { ...base, sync: null }))).not.toContain('There it is');
  });

  it('confirms a new connection in the sync notice, so no flash has to', async () => {
    const sync = { refresh: { seconds: 5, url: '/dashboard?poll=1', stopUrl: '/dashboard?poll=21' } };
    const one = await render('sync-connected', h(SyncNotice, { sync, connected: ['Acme'], note: 'Demo data removed, so your totals are real.' }));
    expect(one).toContain('Connected to Acme. Adding up its first 90 days, usually in a few seconds. Demo data removed, so your totals are real.');
    const two = await html(h(SyncNotice, { sync, connected: ['Acme', 'Habit'] }));
    expect(two).toContain('Connected to Acme and Habit. Adding up their first 90 days');
    expect(await html(h(SyncNotice, { sync }))).toContain('Adding up your first 90 days');
  });

  it('shows a skeleton during the first sync and an explanation after a failed one, never $0', async () => {
    const [, , pagekit, sandbox] = FIXTURE_CONNECTIONS;
    const empty = fixtureDashboard(30, 'empty', FIXTURE_NOW);
    const base = { chrome: { user, flash: null }, data: empty, now: FIXTURE_NOW };
    const syncing = await render(
      'dashboard-first-sync',
      h(DashboardPage, { ...base, connections: [sandbox!], sync: { refresh: { seconds: 5, url: '/dashboard?poll=1' } } }),
    );
    expect(syncing).toContain('aria-busy="true"');
    expect(syncing).toContain('Your first numbers are on their way.');
    expect(syncing).toContain('Connected to Stripe sandbox.');
    expect(syncing).not.toContain('$0');
    expect(syncing).not.toContain('aria-label="Date range"'); // nothing to range over yet

    const failed = await render(
      'dashboard-no-numbers',
      h(DashboardPage, { ...base, connections: [{ ...pagekit!, lastSyncedAt: null }], sync: null }),
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
      h(DashboardPage, {
        chrome: { user, flash: null },
        data,
        connections: FIXTURE_CONNECTIONS.slice(0, 2),
        sync: null,
        now: FIXTURE_NOW,
        celebrate: { dismissHref: '/dashboard?range=30' },
        demoRemoved: true,
      }),
    );
    expect(tags(out, 'section', 'aria-labelledby="first-numbers"', 'fade-in')).toHaveLength(1);
    expect(out).toContain('You can stop checking now. Demo data removed, so your totals are real.');
  });

  it('picks the MRR owl from the numbers and drops it next to a warning', () => {
    const info = { tone: 'info' as const, text: 'Acme isn’t counted yet.' };
    const warning = { tone: 'warning' as const, text: 'Acme hasn’t synced since 3 Nov.' };
    expect(mrrOwl({ milestone: 5000, deltaPct: 12, notes: [] })).toBe('flag');
    expect(mrrOwl({ milestone: null, deltaPct: 12, notes: [info] })).toBe('proud');
    expect(mrrOwl({ milestone: null, deltaPct: 0.01, notes: [] })).toBe('perched'); // reads as flat
    expect(mrrOwl({ milestone: null, deltaPct: -3, notes: [] })).toBe('perched');
    expect(mrrOwl({ milestone: null, deltaPct: null, notes: [] })).toBe('perched');
    expect(mrrOwl({ milestone: 5000, deltaPct: 12, notes: [info, warning] })).toBeNull();
  });

  it('puts the mood owl in the dashboard’s MRR card only, and the counting owl in the first-sync skeleton', async () => {
    const data = fixtureDashboard(30, 'full', FIXTURE_NOW);
    const fresh = FIXTURE_CONNECTIONS.slice(0, 2).map((c) => ({ ...c, status: 'ok' as const, lastSyncedAt: FIXTURE_NOW - MINUTE }));
    const page = await render(
      'dashboard-owl',
      h(DashboardPage, { chrome: { user, flash: null }, data, connections: fresh, sync: null, now: FIXTURE_NOW }),
    );
    const milestone = recentMilestone(data.mrrSeries, data.currency, '2026-11-05');
    const pose = mrrOwl({ milestone, deltaPct: data.kpis.mrr.deltaPct, notes: [] });
    expect(pose).not.toBeNull();
    expect(tags(page, 'img', `src="/mascot/${pose}.png"`)).toHaveLength(1);
    // The landing demo reuses the MRR card; its owl sits on the frame, so the card brings none.
    const landing = await html(
      h(LandingPage, { chrome: { user: null, flash: null }, signupOpen: true, demo: data, cadence: 'every hour' }),
    );
    for (const p of ['proud', 'flag', 'counting']) expect(landing).not.toContain(`/mascot/${p}.png`);
    expect(tags(landing, 'img', 'src="/mascot/perched.png"')).toHaveLength(1);

    const syncing = await html(
      h(DashboardPage, {
        chrome: { user, flash: null },
        data: fixtureDashboard(30, 'empty', FIXTURE_NOW),
        connections: [{ ...FIXTURE_CONNECTIONS[3]!, lastSyncedAt: null, status: 'syncing' as const }],
        sync: { refresh: { seconds: 5, url: '/dashboard?poll=1' } },
        now: FIXTURE_NOW,
      }),
    );
    expect(syncing).toContain('src="/mascot/counting.png"');
  });

  it('gives the dashboard empty state the dozing owl and keeps the 500 page literal', async () => {
    const empty = await render(
      'dashboard-empty',
      h(DashboardPage, { chrome: { user, flash: null }, data: fixtureDashboard(30, 'empty'), connections: [], sync: null }),
    );
    expect(empty).toContain('Nothing to add up yet.');
    expect(empty).toContain('src="/mascot/dozing.png"');

    const notFound = await render('404', h(NotFoundPage, { chrome: { user: null, flash: null } }));
    expect(notFound).toContain('This page isn’t here.');
    expect(notFound).toContain('src="/mascot/lost.png"');

    const serverError = await render('500', h(ServerErrorPage, { chrome: { user, flash: null } }));
    expect(serverError).toContain('The error has been logged.');
    expect(serverError).not.toContain('/mascot/');
  });
});

describe('connection page', () => {
  const chrome = { user, flash: null };
  const page = (detail: ReturnType<typeof fixtureConnectionDetail>, extra: Record<string, unknown> = {}) =>
    h(ConnectionDetailPage, { chrome, detail, sync: null, now: FIXTURE_NOW, ...extra });

  it('leads with status and numbers, keeps changes in a closed Manage section, Sync now first', async () => {
    const out = await render('connection-ok', page(fixtureConnectionDetail(0)));
    expect(out).toMatch(/<form action="\/connections\/[^"]+\/sync" method="post"><button [^>]*>Sync now<\/button>/);
    expect(tags(out, 'button', 'type="submit"', 'bg-primary').some((t) => out.includes(`${t}Sync now<`))).toBe(true);
    // Manage is a coss Collapsible, closed; its panel stays in the server HTML (hidden until opened
    // or found: Base UI switches it to hidden="until-found" once the page hydrates).
    expect(tags(out, 'section', 'id="manage"', 'data-closed=""')).toHaveLength(1);
    expect(tags(out, 'div', 'data-slot="collapsible-panel"', 'hidden=""').length).toBeGreaterThan(0);
    expect(out).toContain('>Delete connection<');
    expect(out.indexOf('>Details<')).toBeLessThan(out.indexOf('>Recent snapshots<'));
    expect(out.indexOf('>Sync history<')).toBeLessThan(out.indexOf('id="manage"'));
    expect(out).toContain('Show the last 4 syncs');
  });

  it('makes Replace key the primary action after a failed sync, with Manage open', async () => {
    const failing = { ...fixtureConnectionDetail(2), status: 'error' as const };
    const out = await render('connection-failing', page(failing));
    expect(tags(out, 'a', 'href="#replace-key"', 'bg-primary')).toHaveLength(1);
    expect(tags(out, 'button', 'type="submit"', 'border-input').some((t) => out.includes(`${t}Sync now<`))).toBe(true); // still there, secondary
    expect(tags(out, 'section', 'id="manage"', 'data-open=""')).toHaveLength(1);
    expect(out).toContain('Last sync failed');
  });

  it('shows what the last sync couldn’t count, one sentence plain, several as a list', async () => {
    const one = await render('connection-warning', page({ ...fixtureConnectionDetail(0), warnings: ['MRR is before discounts.'] }));
    expect(one).toContain('One thing the last sync couldn’t count');
    expect(one).toContain('MRR is before discounts.');
    const two = await render('connection-warnings', page({ ...fixtureConnectionDetail(0), warnings: ['First.', 'Second.'] }));
    expect(two).toContain('What the last sync couldn’t count');
    expect(two).toMatch(/<li>First\.<\/li><li>Second\.<\/li>/);
    expect(await render('connection-no-warnings', page(fixtureConnectionDetail(0)))).not.toContain('couldn’t count');
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

/** Inline styles are allowed (style-src 'unsafe-inline': Base UI, Recharts and Motion set them). Scripts are not: the only one is the same-origin module bundle. */
function expectCspSafe(out: string, name: string): void {
  expect(out.replace('<script type="module" src="/client/entry.js"></script>', ''), name).not.toMatch(/<script/i);
  expect(out, name).not.toMatch(/\son[a-z]+=/i);
}

// Every sample the tests above rendered, checked once they have all run, whatever order they ran in.
// (The CSP test used to read `rendered` itself, so under `--sequence.shuffle` it could run first,
// against an empty map, and fail.)
afterAll(() => {
  for (const [name, out] of Object.entries(rendered)) expectCspSafe(out, name);
});

describe('currencies whose ISO 4217 digits differ from CLDR', () => {
  afterEach(() => vi.useRealTimers());

  it('shows a HUF 4,990.00 Stripe subscription as HUF 4,990 and converts it at its real size', async () => {
    // What the Stripe adapter stores for a HUF 4,990.00 monthly price (test/providers/stripe.test.ts):
    // MRR { HUF: 499000 } and a 499000 HUF charge, both in fillér. Display currency EUR; 1 USD = 400 HUF = 0.9 EUR.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE_NOW);
    const today = new Date(FIXTURE_NOW).toISOString().slice(0, 10);
    const t = createTestD1();
    seedUser(t, { id: 'u-huf', baseCurrency: 'EUR', timeZone: 'UTC' });
    seedConnection(t, { id: 'stripe-huf', userId: 'u-huf', provider: 'stripe', name: 'Budapest', status: 'ok', lastSyncedAt: FIXTURE_NOW - MINUTE });
    t.exec('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)', today, 'USD', JSON.stringify({ EUR: 0.9, HUF: 400 }), FIXTURE_NOW);
    t.exec(
      `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period, revenue_period_days, new_customers, captured_at)
       VALUES (?, ?, ?, 1, 0, NULL, NULL, NULL, ?)`,
      'stripe-huf', today, JSON.stringify({ HUF: 499000 }), FIXTURE_NOW,
    );
    t.exec(
      `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
       VALUES (?, ?, ?, 'charge', 499000, 'HUF', NULL, 'Pro')`,
      'stripe-huf', 'txn_FakeHuf', FIXTURE_NOW - HOUR,
    );
    const env = testEnv(t.db);
    const hufUser = { id: 'u-huf', email: 'u-huf@example.com', baseCurrency: 'EUR', timeZone: 'UTC' };

    const data = await getDashboardData(env, hufUser, 30);
    expect(data.kpis.mrr.value).toBe(1123); // HUF 4,990 → $12.475 → €11.2275; the old reading was €1,122.75
    const dashboard = await render(
      'dashboard-huf',
      h(DashboardPage, {
        chrome: { user: hufUser, flash: null },
        data,
        connections: await listConnectionSummaries(env, hufUser.id),
        sync: null,
        now: FIXTURE_NOW,
      }),
    );
    expect(dashboard).toMatch(/aria-label="MRR"[\s\S]*?€11[^,\d]/);
    expect(dashboard).toContain('€135 ARR');
    expect(dashboard).not.toContain('€1,123');

    const transactions = await render(
      'transactions-huf',
      h(TransactionsPage, {
        chrome: { user: hufUser, flash: null },
        page: await listTransactions(env, hufUser, { provider: null, page: 1 }),
        hasConnections: true,
        filterProviders: ['stripe'],
      }),
    );
    expect(transactions).toContain('HUF 4,990'); // the original amount, in whole forints
    expect(transactions).toContain('€11.23');
    expect(transactions).not.toContain('499,000');
  });
});

describe('CSP', () => {
  it('no page or component has an inline script or an inline event handler', async () => {
    // Its own samples, so this holds in any test order; the afterAll above covers the rest.
    const chrome = { user, flash: null };
    const data = fixtureDashboard(30, 'full', FIXTURE_NOW);
    const samples: Record<string, ReactElement> = {
      layout: h(Layout, { title: 'Dashboard', user, flash: { type: 'error', message: 'x' }, nav: 'dashboard', refresh: { seconds: 3, url: '/dashboard?poll=1', stopUrl: '/dashboard?poll=21' } }),
      landing: h(LandingPage, { chrome: { user: null, flash: null }, signupOpen: true, demo: data, cadence: 'every hour' }),
      dashboard: h(DashboardPage, { chrome, data, connections: FIXTURE_CONNECTIONS, sync: null, now: FIXTURE_NOW, celebrate: { dismissHref: '/dashboard' } }),
      connection: h(ConnectionDetailPage, { chrome, detail: fixtureConnectionDetail(2), sync: null, now: FIXTURE_NOW }),
      transactions: h(TransactionsPage, { chrome, page: fixtureTransactions(1, null), hasConnections: true, filterProviders: ['stripe'] }),
      settings: h(SettingsPage, { chrome, currency: 'USD', deleteAccount: { error: 'x', fieldErrors: { password: 'x' } } }),
      auth: h(AuthPage, { chrome: { user: null, flash: null }, mode: 'signup', signupOpen: true, error: 'x', field: 'password' }),
      picker: h(ProviderPickerPage, { chrome }),
      notFound: h(NotFoundPage, { chrome }),
      serverError: h(ServerErrorPage, { chrome }),
    };
    for (const meta of PROVIDERS) {
      samples[`form-${meta.id}`] = h(ConnectionForm, { meta, mode: 'create', action: '/connections', error: 'x', fieldErrors: { apiKey: 'x' } });
    }
    for (const [name, node] of Object.entries(samples)) expectCspSafe(await html(node), name);
  });
});
