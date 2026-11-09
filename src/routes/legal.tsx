/**
 * The privacy policy and terms (GET /privacy, /terms). Owner: Experience (routes).
 *
 * Served only where the instance names its operator (lib/legal.ts); anywhere else they're the
 * ordinary 404. Static text, rendered with the usual chrome so a signed-in owner keeps their nav.
 */

import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { legalOperator } from '../lib/legal';
import { renderPage } from '../views/render';
import { chrome, type AppContext } from './util';

function renderLegal(c: AppContext, doc: 'privacy' | 'terms'): Response | Promise<Response> {
  const operator = legalOperator(c.env);
  if (!operator) return c.notFound();
  return renderPage(c, 'legal', { chrome: chrome(c), doc, operator, host: new URL(c.req.url).host });
}

export function registerLegalRoutes(app: Hono<AppEnv>): void {
  app.get('/privacy', (c) => renderLegal(c, 'privacy'));
  app.get('/terms', (c) => renderLegal(c, 'terms'));
}
