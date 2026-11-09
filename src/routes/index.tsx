/**
 * Route registration. Owner: Experience.
 * index.tsx calls registerRoutes(app) after the global middleware (CSP, CSRF, flash, user).
 * Pages live in ../views/pages; handlers stay thin (parse → call lib/data/services → render or PRG).
 */

import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { registerAuthRoutes } from './auth';
import { registerConnectionRoutes } from './connections';
import { registerDashboardRoutes } from './dashboard';
import { registerErrorHandlers } from './errors';
import { registerPublicRoutes } from './public';
import { registerSettingsRoutes } from './settings';
import { registerTransactionRoutes } from './transactions';
import { registerVerifyEmailRoutes } from './verify-email';
import { registerWebhookRoutes } from './webhooks';

export function registerRoutes(app: Hono<AppEnv>): void {
  registerAuthRoutes(app);
  registerVerifyEmailRoutes(app);
  registerDashboardRoutes(app);
  registerConnectionRoutes(app);
  registerTransactionRoutes(app);
  registerSettingsRoutes(app);
  registerWebhookRoutes(app);
  registerPublicRoutes(app);
  registerErrorHandlers(app);
}
