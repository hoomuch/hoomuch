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
import { DashboardPage } from './dashboard';
import { NotFoundPage, ServerErrorPage } from './errors';
import { LandingPage } from './landing';
import { SettingsPage } from './settings';
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
  verifyEmail: VerifyEmailPage,
  notFound: NotFoundPage,
  serverError: ServerErrorPage,
} as const;

export type PageName = keyof typeof PAGES;
export type PagePropsOf<N extends PageName> = ComponentProps<(typeof PAGES)[N]>;
