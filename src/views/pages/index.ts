/**
 * Every page the Worker renders, by name. Owner: Experience (pages).
 * The server renders `PAGES[name]` (views/render.tsx) and the browser hydrates the same component
 * (client/entry.tsx loads it lazily, so a page only downloads what it uses).
 * Page props travel as JSON: keep them plain data (no functions, Dates, Maps or class instances).
 */

import type { ComponentProps } from 'react';
import { AuthPage } from './auth';
import { ConnectionDetailPage } from './connection-detail';
import { ConnectionsPage, NewConnectionPage, ProviderPickerPage } from './connections';
import { ExplorePage } from './explore';
import { DashboardPage } from './dashboard';
import { DigestStopPage } from './digest-stop';
import { NotFoundPage, ServerErrorPage } from './errors';
import { LandingPage } from './landing';
import { LegalPage } from './legal';
import { PublicProductPage } from './public-product';
import { PublicProfilePage } from './public-profile';
import { SettingsPage } from './settings';
import { SharePage } from './share';
import { TransactionsPage } from './transactions';
import { VerifyEmailPage } from './verify-email';

export const PAGES = {
  landing: LandingPage,
  auth: AuthPage,
  dashboard: DashboardPage,
  connections: ConnectionsPage,
  providerPicker: ProviderPickerPage,
  newConnection: NewConnectionPage,
  connectionDetail: ConnectionDetailPage,
  transactions: TransactionsPage,
  settings: SettingsPage,
  share: SharePage,
  publicProduct: PublicProductPage,
  publicProfile: PublicProfilePage,
  explore: ExplorePage,
  legal: LegalPage,
  verifyEmail: VerifyEmailPage,
  digestStop: DigestStopPage,
  notFound: NotFoundPage,
  serverError: ServerErrorPage,
} as const;

export type PageName = keyof typeof PAGES;
export type PagePropsOf<N extends PageName> = ComponentProps<(typeof PAGES)[N]>;
