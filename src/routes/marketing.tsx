/**
 * The pages around the landing page (views/pages/marketing.tsx), robots.txt and llms.txt.
 * Owner: Experience (routes).
 *
 * All of them are the same for everyone: no session, no flash, no Set-Cookie (src/index.tsx skips
 * both on MARKETING_PATH), so one response can be cached by anyone. robots.txt and llms.txt are
 * written here instead of sitting in public/, so a self-hosted copy names its own domain.
 */

import type { Context, Hono } from 'hono';
import type { AppEnv } from '../env';
import { signupAllowed } from '../lib/auth';
import { legalOperator } from '../lib/legal';
import { publicPagesEnabled } from '../lib/public-pages';
import { PROVIDERS } from '../providers/registry';
import { COMPARISONS } from '../views/content/compare';
import { COUNTING } from '../views/content/counting';
import { INTEGRATION_GUIDES, PAIR_GUIDES } from '../views/content/integrations';
import { comparisonBySlug, guideBySlug, integrationBySlug } from '../views/pages/marketing';
import { renderPage } from '../views/render';
import { chrome } from './util';

/** Paths served without the visitor's session (src/index.tsx), like the public pages. */
export const MARKETING_PATH =
  /^\/(?:integrations(?:\/[a-z0-9-]+)?|guides\/[a-z0-9-]+|compare\/[a-z0-9-]+|verified-revenue|self-host|robots\.txt|llms\.txt)$/;

/** They change with a deploy, not with data. */
const MAX_AGE = 3600;
/** The link preview: the home page's (public/og/home.png). */
const IMAGE = '/og/home.png';
const SOURCE_URL = 'https://github.com/hoomuch/hoomuch';

/** App pages a crawler can't open (they redirect to log in), kept out of its way. */
const DISALLOW = ['/dashboard', '/connections', '/transactions', '/settings', '/share', '/api/'];

/** Every page here a search engine should know about, for /sitemap.xml. */
export function marketingPaths(c: Context<AppEnv>): string[] {
  return [
    '/integrations',
    ...INTEGRATION_GUIDES.map((g) => `/integrations/${g.slug}`),
    ...PAIR_GUIDES.map((g) => `/guides/${g.slug}`),
    ...(publicPagesEnabled(c.env) ? ['/verified-revenue'] : []),
    '/self-host',
    ...COMPARISONS.map((x) => `/compare/${x.slug}`),
  ];
}

function pageProps(c: Context<AppEnv>) {
  const origin = new URL(c.req.url).origin;
  c.header('Cache-Control', `public, max-age=${MAX_AGE}`);
  return { chrome: chrome(c), url: `${origin}${c.req.path}`, image: `${origin}${IMAGE}`, signupOpen: signupAllowed(c.env) };
}

export function registerMarketingRoutes(app: Hono<AppEnv>): void {
  app.get('/integrations', (c) => renderPage(c, 'integrations', pageProps(c)));

  app.get('/integrations/:slug', (c) => {
    const slug = c.req.param('slug');
    return integrationBySlug(slug) ? renderPage(c, 'integration', { ...pageProps(c), slug }) : c.notFound();
  });

  app.get('/guides/:slug', (c) => {
    const slug = c.req.param('slug');
    return guideBySlug(slug) ? renderPage(c, 'guide', { ...pageProps(c), slug }) : c.notFound();
  });

  app.get('/compare/:slug', (c) => {
    const slug = c.req.param('slug');
    return comparisonBySlug(slug) ? renderPage(c, 'compare', { ...pageProps(c), slug }) : c.notFound();
  });

  // What verified pages are, only where the instance has them.
  app.get('/verified-revenue', (c) => (publicPagesEnabled(c.env) ? renderPage(c, 'verifiedRevenue', pageProps(c)) : c.notFound()));

  app.get('/self-host', (c) => renderPage(c, 'selfHost', pageProps(c)));

  app.get('/robots.txt', (c) => {
    const origin = new URL(c.req.url).origin;
    const lines = [
      'User-agent: *',
      // Search and AI answers may use the pages (contentsignals.org); training is left unsaid.
      'Content-Signal: search=yes, ai-input=yes',
      ...DISALLOW.map((p) => `Disallow: ${p}`),
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
    ];
    return c.body(lines.join('\n'), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': `public, max-age=${MAX_AGE}` });
  });

  // A plain-language map for AI assistants (llmstxt.org): what this is, how it counts, where to read more.
  app.get('/llms.txt', (c) => c.body(llmsTxt(c), 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': `public, max-age=${MAX_AGE}` }));
}

function llmsTxt(c: Context<AppEnv>): string {
  const origin = new URL(c.req.url).origin;
  const host = new URL(c.req.url).host;
  const providers = PROVIDERS.filter((p) => p.id !== 'demo').map((p) => p.name);
  const publicPages = publicPagesEnabled(c.env);
  const link = (title: string, path: string, note?: string) => `- [${title}](${origin}${path})${note ? `: ${note}` : ''}`;
  return [
    '# hoomuch',
    '',
    `> A read-only, open-source (AGPL-3.0) revenue dashboard for founders who sell in more than one place: it reads MRR, ARR, subscriptions, trials and revenue from ${providers.length} billing platforms and app stores and adds them up on one dashboard, in one currency.`,
    '',
    'It connects to each store with an API key the founder makes, reads that store’s own API and never writes to it. There is no SDK and no code to add. Customers’ names, email addresses and card details are never stored.',
    '',
    `Supported: ${providers.join(', ')}.`,
    '',
    'How the figures are counted:',
    '',
    ...COUNTING.map((x) => `- ${x.term}: ${x.rule}`),
    '',
    ...(signupAllowed(c.env)
      ? [
          `Pricing on ${host}: free under $1,000 MRR, and free for everyone during the beta. After the beta, $9 a month or $90 a year for the private dashboard at $1,000 MRR and up.${publicPages ? ' Verified pages, the badge and Explore are free at any MRR.' : ''} Self-hosting is free.`,
          '',
        ]
      : []),
    '## Pages',
    '',
    link('Home', '/', 'the live demo dashboard, setup, what is stored, how MRR is counted, pricing'),
    link('Integrations', '/integrations', 'what hoomuch reads from each store and how it counts it'),
    ...INTEGRATION_GUIDES.map((g) => link(PROVIDERS.find((p) => p.id === g.id)?.name ?? g.slug, `/integrations/${g.slug}`, g.description)),
    ...PAIR_GUIDES.map((g) => link(g.title, `/guides/${g.slug}`, g.description)),
    link('Self-host', '/self-host', 'run it on your own Cloudflare account'),
    ...COMPARISONS.map((x) => link(x.title, `/compare/${x.slug}`, x.description)),
    '',
    ...(publicPages
      ? [
          '## Verified revenue',
          '',
          link('Verified revenue pages', '/verified-revenue', 'what a public page shows and how its figures are verified'),
          link('Explore', '/explore', 'products with verified MRR and revenue; every product page has a Markdown version at /p/<slug>.md'),
          link('Sitemap', '/sitemap.xml', 'every page, product and founder'),
          '',
        ]
      : []),
    '## Optional',
    '',
    `- [Source code](${SOURCE_URL}): README, configuration and deployment`,
    ...(legalOperator(c.env) ? [link('Privacy Policy', '/privacy'), link('Terms of Service', '/terms')] : []),
    '',
  ].join('\n');
}
