/**
 * What search engines and AI assistants read (routes/marketing.tsx, the landing page, src/index.tsx):
 * robots.txt and llms.txt name this instance, every indexable page has one canonical address and
 * structured data, the marketing pages render the same for everyone, and the signed-out landing page
 * is cached at the edge without ever serving a signed-in browser.
 */
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { PROVIDER_IDS } from '../../src/providers/types';
import { INTEGRATION_GUIDES } from '../../src/views/content/integrations';
import { createTestD1, testEnv } from '../fixtures/d1';
import { htmlOf } from '../fixtures/html';

const PUBLIC = { PUBLIC_PAGES: 'true' };

function send(path: string, opts: { vars?: Record<string, string>; method?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const env = testEnv(createTestD1().db, opts.vars ?? {});
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const req = new Request(`https://hoomuch.test${path}`, { method: opts.method ?? 'GET', headers: opts.headers, redirect: 'manual' });
  return worker.fetch!(req as never, env, ctx as never) as Promise<Response>;
}

/** The page's JSON-LD block, parsed. */
function jsonLd(html: string): { '@graph': Array<Record<string, unknown>> } {
  const m = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html);
  expect(m, 'JSON-LD block').not.toBeNull();
  return JSON.parse(m![1]!) as { '@graph': Array<Record<string, unknown>> };
}

describe('robots.txt and llms.txt', () => {
  it('name this instance, keep crawlers out of the app, and point at the sitemap', async () => {
    const res = await send('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.getSetCookie()).toEqual([]);
    const txt = await res.text();
    for (const path of ['/dashboard', '/connections', '/transactions', '/settings', '/share', '/api/']) expect(txt).toContain(`Disallow: ${path}\n`);
    expect(txt).toContain('Content-Signal: search=yes, ai-input=yes');
    expect(txt).toContain('Sitemap: https://hoomuch.test/sitemap.xml');
    expect(txt).not.toContain('hoomuch.com');
  });

  it('describe the product, how it counts and where to read more, for AI assistants', async () => {
    const txt = await (await send('/llms.txt', { vars: PUBLIC })).text();
    expect(txt.startsWith('# hoomuch\n')).toBe(true);
    for (const name of ['Stripe', 'RevenueCat', 'App Store Connect', 'Google Play']) expect(txt).toContain(name);
    expect(txt).toContain('- MRR: Every active, paid subscription’s price, brought to a month');
    expect(txt).toContain('[Stripe](https://hoomuch.test/integrations/stripe)');
    expect(txt).toContain('(https://hoomuch.test/explore)');
    expect(txt).toContain('Pricing on hoomuch.test: free under $1,000 MRR');
    expect(txt).toContain('Verified pages, the badge and Explore are free at any MRR.');
    const noPages = await (await send('/llms.txt')).text();
    expect(noPages).toContain('Pricing on hoomuch.test');
    expect(noPages).not.toContain('free at any MRR'); // no public pages, so no promise about them
    // A private instance doesn't advertise hoomuch.com's plans or pages it doesn't have.
    const closed = await (await send('/llms.txt', { vars: { ALLOW_SIGNUP: 'false' } })).text();
    expect(closed).not.toContain('Pricing on');
    expect(closed).not.toContain('/explore');
  });
});

describe('one address per page', () => {
  it('sends a trailing slash to the address without one, on this origin, for GET only', async () => {
    const res = await send('/integrations/?ref=x');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://hoomuch.test/integrations?ref=x');
    // "//evil.com/" stays a path on this site, never a protocol-relative address.
    expect((await send('//evil.com/')).headers.get('location')).toBe('https://hoomuch.test//evil.com');
    expect((await send('/login/', { method: 'POST' })).status).not.toBe(301);
  });

  it('gives the landing page one canonical address, a link preview and structured data', async () => {
    for (const path of ['/', '/?range=7#demo', '/?range=30&revenue=line']) {
      const html = await htmlOf(await send(path));
      expect(html).toContain('<link rel="canonical" href="https://hoomuch.test/"/>');
      expect(html).toContain('<meta property="og:image" content="https://hoomuch.test/og/home.png"/>');
    }
    const html = await htmlOf(await send('/'));
    const graph = jsonLd(html)['@graph'];
    expect(graph.map((n) => n['@type'])).toEqual(['Organization', 'WebSite', 'WebApplication']);
    expect(graph[0]).toMatchObject({ url: 'https://hoomuch.test/', sameAs: ['https://github.com/hoomuch/hoomuch'] });
    expect(graph[2]).toMatchObject({ offers: { price: '0', priceCurrency: 'USD' } });
    // The demo is a preview: its cards sit under its heading, and its rows don't lead into the app.
    expect(html).not.toContain('href="/connections/');
    expect(html).toMatch(/<h3 [^>]*data-slot="card-title"[^>]*>MRR movement/);
    expect(html).toContain('How hoomuch counts MRR.');
  });

  it('gives log in, sign up and the legal pages a canonical address without their query', async () => {
    expect(await htmlOf(await send('/login?next=%2Fdashboard'))).toContain('<link rel="canonical" href="https://hoomuch.test/login"/>');
    expect(await htmlOf(await send('/signup?next=%2Fshare'))).toContain('<link rel="canonical" href="https://hoomuch.test/signup"/>');
    const legal = { LEGAL_NAME: 'Ada Operator', LEGAL_EMAIL: 'hello@hoomuch.test' };
    expect(await htmlOf(await send('/terms', { vars: legal }))).toContain('<link rel="canonical" href="https://hoomuch.test/terms"/>');
  });
});

describe('the marketing pages', () => {
  it('list every integration, and give each one a page of its own', async () => {
    const index = await htmlOf(await send('/integrations'));
    // One for every provider a visitor can connect (CONTRIBUTING.md, "Adding a provider").
    expect(INTEGRATION_GUIDES.map((g) => g.id).sort()).toEqual(PROVIDER_IDS.filter((id) => id !== 'demo').sort());
    for (const g of INTEGRATION_GUIDES) expect(index).toContain(`href="/integrations/${g.slug}"`);
    for (const g of INTEGRATION_GUIDES) {
      const res = await send(`/integrations/${g.slug}`);
      expect(res.status, g.slug).toBe(200);
      const html = await htmlOf(res);
      expect(html).toContain(`<link rel="canonical" href="https://hoomuch.test/integrations/${g.slug}"/>`);
      expect(html).toContain(`<title>${g.title.replace(/&/g, '&amp;')} · hoomuch</title>`);
      expect(jsonLd(html)['@graph'].map((n) => n['@type'])).toEqual(['WebPage', 'BreadcrumbList']);
    }
    expect((await send('/integrations/nope')).status).toBe(404);
  });

  it('render the same for everyone: cacheable, without the session', async () => {
    for (const path of ['/integrations', '/integrations/stripe', '/guides/revenuecat-and-stripe', '/self-host', '/compare/baremetrics-alternative']) {
      const res = await send(path, { headers: { cookie: 'hm_session=not-a-session' } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('public, max-age=3600');
      expect(res.headers.getSetCookie(), path).toEqual([]);
    }
  });

  it('say where another product’s details come from, and when they were read', async () => {
    for (const slug of ['baremetrics-alternative', 'chartmogul-alternative', 'trustmrr-alternative']) {
      const html = await htmlOf(await send(`/compare/${slug}`));
      expect(html).toContain('checked 11 November 2026');
      expect(html).toContain('fits better');
    }
    expect((await send('/compare/nope')).status).toBe(404);
  });

  it('explain verified pages only where the instance has them', async () => {
    expect((await send('/verified-revenue')).status).toBe(404);
    expect((await send('/verified-revenue', { vars: PUBLIC })).status).toBe(200);
  });

  it('say publishing is free at any MRR only where sign-up is open', async () => {
    const open = await htmlOf(await send('/verified-revenue', { vars: PUBLIC }));
    expect(open).toContain('id="cost-title"');
    expect(open).toContain('free to publish at any MRR');
    expect(open).not.toContain('free until your MRR reaches $1,000'); // the page's own plan line replaces it
    const closed = await htmlOf(await send('/verified-revenue', { vars: { ...PUBLIC, ALLOW_SIGNUP: 'false' } }));
    expect(closed).not.toContain('id="cost-title"');
    expect(closed).not.toContain('$1,000');
  });

  it('keep hoomuch.com’s price out where sign-up is closed', async () => {
    const open = await htmlOf(await send('/self-host'));
    expect(open).toContain('free until your MRR reaches $1,000');
    const closed = await htmlOf(await send('/self-host', { vars: { ALLOW_SIGNUP: 'false' } }));
    expect(closed).not.toContain('$1,000');
  });
});

describe('the signed-out landing page at the edge', () => {
  const stored = new Map<string, Response>();
  const fake = {
    match: async (url: string) => stored.get(url)?.clone(),
    put: async (url: string, res: Response) => void stored.set(url, res),
  };
  afterEach(() => {
    stored.clear();
    delete (globalThis as { caches?: unknown }).caches;
  });

  it('is kept for a few minutes for visitors without a cookie, and never for anyone with one', async () => {
    (globalThis as { caches?: unknown }).caches = { default: fake };
    const first = await send('/');
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=300');
    expect([...stored.keys()]).toEqual(['https://hoomuch.test/']);
    // The next visitor gets the stored page, with the security headers set again on the way out.
    // Cloudflare hands it back with the zone's Browser Cache TTL as max-age: browsers mustn't keep it.
    stored.set('https://hoomuch.test/', new Response('cached', { headers: { 'cache-control': 'public, max-age=14400, s-maxage=300' } }));
    const second = await send('/');
    expect(await second.text()).toBe('cached');
    expect(second.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=300');
    expect(second.headers.get('content-security-policy')).toContain("script-src 'self'");
    // Any cookie skips it: a flash, a choice or a session renders as usual.
    const withCookie = await send('/', { headers: { cookie: 'hm_flash=x' } });
    expect(await withCookie.text()).not.toBe('cached');
    expect(withCookie.headers.get('cache-control')).toBe('no-store');
  });
});
