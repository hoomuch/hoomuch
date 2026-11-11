/**
 * Browser entry: hydrates the page the server rendered. Owner: Experience (design).
 * Built by scripts/build-client.mjs into public/client/ (code-split: each page loads only what
 * it uses, so pages without charts never download Recharts).
 */

import type { ComponentType } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { PageRoot } from '../views/page-root';
import type { PageName } from '../views/pages';
import type { PagePayload } from '../views/render';

type Loader = () => Promise<ComponentType<never>>;

const LOADERS: Record<PageName, Loader> = {
  landing: () => import('../views/pages/landing').then((m) => m.LandingPage),
  auth: () => import('../views/pages/auth').then((m) => m.AuthPage),
  dashboard: () => import('../views/pages/dashboard').then((m) => m.DashboardPage),
  connections: () => import('../views/pages/connections').then((m) => m.ConnectionsPage),
  providerPicker: () => import('../views/pages/connections').then((m) => m.ProviderPickerPage),
  newConnection: () => import('../views/pages/connections').then((m) => m.NewConnectionPage),
  connectionDetail: () => import('../views/pages/connection-detail').then((m) => m.ConnectionDetailPage),
  transactions: () => import('../views/pages/transactions').then((m) => m.TransactionsPage),
  settings: () => import('../views/pages/settings').then((m) => m.SettingsPage),
  share: () => import('../views/pages/share').then((m) => m.SharePage),
  publicProduct: () => import('../views/pages/public-product').then((m) => m.PublicProductPage),
  publicProfile: () => import('../views/pages/public-profile').then((m) => m.PublicProfilePage),
  explore: () => import('../views/pages/explore').then((m) => m.ExplorePage),
  legal: () => import('../views/pages/legal').then((m) => m.LegalPage),
  integrations: () => import('../views/pages/marketing').then((m) => m.IntegrationsPage),
  integration: () => import('../views/pages/marketing').then((m) => m.IntegrationPage),
  guide: () => import('../views/pages/marketing').then((m) => m.GuidePage),
  verifiedRevenue: () => import('../views/pages/marketing').then((m) => m.VerifiedRevenuePage),
  selfHost: () => import('../views/pages/marketing').then((m) => m.SelfHostPage),
  compare: () => import('../views/pages/marketing').then((m) => m.ComparePage),
  verifyEmail: () => import('../views/pages/verify-email').then((m) => m.VerifyEmailPage),
  digestStop: () => import('../views/pages/digest-stop').then((m) => m.DigestStopPage),
  notFound: () => import('../views/pages/errors').then((m) => m.NotFoundPage),
  serverError: () => import('../views/pages/errors').then((m) => m.ServerErrorPage),
};

async function hydrate(): Promise<void> {
  const el = document.getElementById('hm-page');
  const json = el?.textContent;
  if (!json) return;
  const payload = JSON.parse(json) as PagePayload;
  // nosemgrep: unsafe-dynamic-method -- the server wrote the page name, and LOADERS is fixed
  const load = LOADERS[payload.name];
  if (!load) return;
  const Page = (await load()) as ComponentType<Record<string, unknown>>;
  hydrateRoot(
    document,
    <PageRoot json={json} now={payload.now} timeZone={payload.timeZone ?? 'UTC'}>
      <Page {...(payload.props as Record<string, unknown>)} />
    </PageRoot>,
  );
}

void hydrate();
