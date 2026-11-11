/**
 * Public pages (SPEC F-21) through the real request pipeline: the owner's /share forms, and the
 * visitor's /p/<slug> page and badge, which render without the visitor's session so they can be cached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY } from '../../src/lib/time';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { fakeFetch, route } from '../fixtures/harness';
import { htmlOf } from '../fixtures/html';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
const OTHER_TOKEN = 'other-session-token';
const STRIPE = '11111111-1111-4111-8111-111111111111';
const PADDLE = '33333333-3333-4333-8333-333333333333';
const DEMO = '22222222-2222-4222-8222-222222222222';
const THEIRS = '44444444-4444-4444-8444-444444444444';

let t: TestD1;
let env: ReturnType<typeof testEnv>;
let pending: Promise<unknown>[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const { fetch } = fakeFetch([route(/.*/, { status: 503, json: {} })]);
  vi.stubGlobal('fetch', fetch);
  t = createTestD1();
  seedUser(t, { id: 'u1', email: 'owner@example.com' });
  seedUser(t, { id: 'u2', email: 'other@example.com' });
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(OTHER_TOKEN), 'u2', NOW + DAY, NOW);
  seedConnection(t, { id: STRIPE, userId: 'u1', provider: 'stripe', name: 'Acme web', lastSyncedAt: NOW - 3_600_000 });
  seedConnection(t, { id: PADDLE, userId: 'u1', provider: 'paddle', name: 'Acme desktop', status: 'pending' });
  seedConnection(t, { id: DEMO, userId: 'u1', provider: 'demo', name: 'Demo data', lastSyncedAt: NOW - 3_600_000 });
  seedConnection(t, { id: THEIRS, userId: 'u2', provider: 'stripe', name: 'Theirs', lastSyncedAt: NOW - 3_600_000 });
  t.exec(
    `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, captured_at) VALUES (?, '2026-11-05', '{"USD":1234500}', 321, 0)`,
    STRIPE,
  );
  env = testEnv(t.db, { PUBLIC_PAGES: 'true' });
  pending = [];
});

afterEach(async () => {
  await Promise.allSettled(pending);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function send(
  method: 'GET' | 'POST',
  path: string,
  opts: { form?: Record<string, string | readonly string[]>; token?: string | null; origin?: string; env?: ReturnType<typeof testEnv> } = {},
): Promise<Response> {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.form ?? {})) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  const req = new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: opts.origin ?? ORIGIN,
      ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(token ? { cookie: `__Host-hm_session=${token}` } : {}),
    },
    body: opts.form ? body.toString() : undefined,
    redirect: 'manual',
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  return worker.fetch!(req as never, opts.env ?? env, ctx as never) as Promise<Response>;
}

function products() {
  return t.rows<{ id: string; user_id: string; slug: string; name: string; website: string | null; published_at: number | null; stats: string | null }>(
    'SELECT id, user_id, slug, name, website, published_at, stats FROM public_products ORDER BY created_at, id',
  );
}

const PROFILE = { handle: 'taha', display_name: 'Taha B', bio: 'I make small apps.', website: 'taha.dev', x_handle: 'https://x.com/taha_b' };

async function createAndPublish(form: Record<string, string | readonly string[]> = {}, publish: Record<string, string> = {}) {
  if (t.rows("SELECT 1 FROM public_profiles WHERE user_id = 'u1'").length === 0) {
    expect((await send('POST', '/share/profile', { form: PROFILE })).status).toBe(303);
  }
  const created = await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE], ...form } });
  expect(created.status).toBe(303);
  const id = products().at(-1)!.id;
  const published = await send('POST', `/share/products/${id}/publish`, { form: { confirm: 'yes', ...publish } });
  expect(published.status).toBe(303);
  return id;
}

describe('with PUBLIC_PAGES off', () => {
  it('every public-page path is the ordinary 404, and the nav has no Share', async () => {
    const off = testEnv(t.db);
    for (const [method, path] of [
      ['GET', '/share'],
      ['POST', '/share/products'],
      ['GET', '/p/acme'],
      ['GET', '/badge/acme.svg'],
    ] as const) {
      const res = await send(method, path, { env: off, form: method === 'POST' ? { name: 'Acme' } : undefined });
      expect(res.status, path).toBe(404);
    }
    expect(products()).toEqual([]);
    expect(await htmlOf(await send('GET', '/settings', { env: off }))).not.toContain('href="/share"');
    expect(await htmlOf(await send('GET', '/settings'))).toContain('href="/share"');
    // The signed-in app's way to Explore, beside Settings.
    expect(await htmlOf(await send('GET', '/settings', { env: off }))).not.toContain('href="/explore"');
    expect(await htmlOf(await send('GET', '/settings'))).toContain('href="/explore"');
  });
});

describe('/share', () => {
  it('offers real, live connections only, and says which it left out', async () => {
    const html = await htmlOf(await send('GET', '/share'));
    expect(html).toContain('Acme web');
    expect(html).toContain('Acme desktop');
    expect(html).not.toContain(`value="${DEMO}"`);
    expect(html).toContain('Not offered: Demo data.');
    expect(html).not.toContain('Theirs');
  });

  it('saves a product with an address from its name, and works out a preview', async () => {
    const res = await send('POST', '/share/products', {
      form: { name: 'Acme Notes!', website: 'acme.com', connections: [STRIPE, PADDLE, DEMO, THEIRS] },
    });
    expect(res.status).toBe(303);
    const [p] = products();
    // Straight to the new product's own view, where it can be published.
    expect(res.headers.get('location')).toBe(`/share/products/${p!.id}`);
    expect(p).toMatchObject({ user_id: 'u1', slug: 'acme-notes', name: 'Acme Notes!', website: 'https://acme.com/', published_at: null });
    expect(JSON.parse(p!.stats!).mrr.value).toBe(1_234_500);
    const links = t.rows<{ connection_id: string }>('SELECT connection_id FROM public_product_connections ORDER BY connection_id');
    expect(links.map((l) => l.connection_id)).toEqual([STRIPE, PADDLE].sort());
  });

  it('turns a bad form back with the fields to fix, and saves nothing', async () => {
    for (const [form, message] of [
      [{ name: '', connections: [STRIPE] }, 'Give the product a name.'],
      [{ name: 'Acme', slug: 'Not A Slug', connections: [STRIPE] }, 'lowercase letters, digits and single hyphens'],
      [{ name: 'Acme', website: 'http://acme.com', connections: [STRIPE] }, 'Enter an https address'],
      [{ name: 'Acme', connections: [DEMO] }, 'Pick at least one connection.'],
    ] as const) {
      const res = await send('POST', '/share/products', { form });
      expect(res.status).toBe(422);
      expect(await htmlOf(res)).toContain(message);
    }
    expect(products()).toEqual([]);

    await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE] } });
    const taken = await send('POST', '/share/products', { form: { name: 'Acme', connections: [PADDLE] } });
    expect(taken.status).toBe(422);
    expect(await htmlOf(taken)).toContain('That address is taken.');
    const inUse = await send('POST', '/share/products', { form: { name: 'Other', connections: [STRIPE] } });
    expect(inUse.status).toBe(422);
    expect(await htmlOf(inUse)).toContain('Acme web is already in another product.');
  });

  it('publishes only with a founder profile, after the confirmation, and with figures to show', async () => {
    await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE] } });
    const noProfile = await send('POST', `/share/products/${products()[0]!.id}/publish`, { form: { confirm: 'yes' } });
    expect(noProfile.headers.get('location')).toBe('/share/profile');
    expect(products()[0]!.published_at).toBeNull();
    // The overview offers the profile, and the product's view says why it can't publish.
    expect(await htmlOf(await send('GET', '/share'))).toContain('Set up your founder profile');
    expect(await htmlOf(await send('GET', `/share/products/${products()[0]!.id}`))).toContain('Set up your founder profile</a> first');
    await send('POST', '/share/profile', { form: PROFILE });
    await send('POST', '/share/products', { form: { name: 'Desktop', connections: [PADDLE] } });
    const byName = (name: string) => products().find((p) => p.name === name)!;
    const acme = byName('Acme');
    const desktop = byName('Desktop');

    await send('POST', `/share/products/${acme.id}/publish`, { form: {} });
    expect(byName('Acme').published_at).toBeNull();

    // The Paddle connection hasn't synced: nothing to show, so it stays private.
    await send('POST', `/share/products/${desktop.id}/publish`, { form: { confirm: 'yes' } });
    expect(byName('Desktop').published_at).toBeNull();

    await send('POST', `/share/products/${acme.id}/publish`, { form: { confirm: 'yes' } });
    expect(byName('Acme').published_at).toBe(NOW);
    expect((await send('GET', '/p/acme', { token: null })).status).toBe(200);

    await send('POST', `/share/products/${acme.id}/unpublish`, { form: {} });
    expect((await send('GET', '/p/acme', { token: null })).status).toBe(404);
  });

  it('another account can’t touch the product', async () => {
    const id = await createAndPublish();
    for (const path of [`/share/products/${id}`, `/share/products/${id}/publish`, `/share/products/${id}/unpublish`, `/share/products/${id}/delete`]) {
      const res = await send('POST', path, { token: OTHER_TOKEN, form: { name: 'Mine now', connections: [THEIRS], confirm: 'yes' } });
      expect(res.status, path).toBe(404);
    }
    expect(products()[0]).toMatchObject({ user_id: 'u1', name: 'Acme', published_at: NOW });
  });

  it('turns down a cross-site POST', async () => {
    const res = await send('POST', '/share/products', { origin: 'https://evil.example', form: { name: 'Acme', connections: [STRIPE] } });
    expect(res.status).toBe(403);
    expect(products()).toEqual([]);
  });

  it('needs a session', async () => {
    const res = await send('GET', '/share', { token: null });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login?next=%2Fshare');
  });
});

describe('/p/<slug>', () => {
  it('shows the verified figures to anyone, the same for everyone, and cacheable', async () => {
    // Figures going back two months: search engines may index it (searchIndexable).
    t.exec(`INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, captured_at) VALUES (?, '2026-09-01', '{"USD":1000000}', 300, 0)`, STRIPE);
    await createAndPublish({ name: 'Acme', tagline: 'Notes for teams', website: 'https://acme.com' });
    for (const token of [null, TOKEN]) {
      const res = await send('GET', '/p/acme', { token });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res.headers.getSetCookie()).toEqual([]);
      const html = await htmlOf(res);
      // The owner's own visit renders exactly what a visitor sees: no account, no email.
      expect(html).not.toContain('owner@example.com');
      expect(html).not.toContain('href="/share"');
      expect(html).toContain('$12,345');
      expect(html).toContain('321');
      expect(html).toContain('Notes for teams');
      expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
      expect(html).toContain('<link rel="canonical" href="https://hoomuch.test/p/acme"/>');
      expect(html).toContain('<meta property="og:image" content="https://hoomuch.test/og/verified.png"/>');
      expect(html).toContain('<meta property="og:title" content="Acme revenue: $12,345 MRR, verified"/>');
      expect(html).toContain('<link rel="alternate" type="text/markdown" href="https://hoomuch.test/p/acme.md"/>');
      expect(html).not.toContain('noindex');
      // Structured data for search engines: the page, its trail, the product and its founder.
      const ld = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)![1]!) as { '@graph': Array<Record<string, unknown>> };
      expect(ld['@graph'].map((n) => n['@type'])).toEqual(['WebPage', 'BreadcrumbList', 'SoftwareApplication', 'Person']);
      expect(ld['@graph'][2]).toMatchObject({ name: 'Acme', url: 'https://acme.com/', creator: { '@id': 'https://hoomuch.test/u/taha#person' } });
      // The founder, linked to their profile, with their X account.
      expect(html).toContain('href="/u/taha"');
      expect(html).toContain('Taha B');
      expect(html).toContain('href="https://x.com/taha_b"');
      // Log in comes back here; a browser with a session swaps it for Dashboard once hydrated.
      expect(html).toContain('href="/login?next=%2Fp%2Facme"');
      // How much it makes: the total held, the last 30 days and the subscriptions.
      expect(html).toContain('Total revenue');
      expect(html).toContain('Subscriptions');
      // One tap to post it, on X, LinkedIn or Bluesky.
      expect(html).toContain(`https://x.com/intent/post?text=${encodeURIComponent('Acme is at $12,345 MRR, verified by hoomuch')}`);
      expect(html).toContain(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent('https://hoomuch.test/p/acme')}`);
      expect(html).toContain('https://bsky.app/intent/compose?text=');
      // Where the figures come from, with the details in the HTML behind the disclosure.
      expect(html).toContain('How these figures are checked');
      expect(html).toContain('the owner can’t edit them');
    }
    // Any case of the address works; the canonical one is lowercase.
    expect((await send('GET', '/p/ACME', { token: null })).status).toBe(200);
  });

  it('links an app’s App Store and Google Play listings, stored in their canonical form', async () => {
    await createAndPublish({
      app_store: 'https://apps.apple.com/tr/app/acme-notes/id1234567890',
      play_store: 'https://play.google.com/store/apps/details?id=com.acme.notes&hl=tr',
    });
    expect(t.rows('SELECT app_store_url, play_store_url FROM public_products')).toEqual([
      { app_store_url: 'https://apps.apple.com/app/id1234567890', play_store_url: 'https://play.google.com/store/apps/details?id=com.acme.notes' },
    ]);
    const html = await htmlOf(await send('GET', '/p/acme', { token: null }));
    expect(html).toContain('href="https://apps.apple.com/app/id1234567890"');
    expect(html).toContain('href="https://play.google.com/store/apps/details?id=com.acme.notes"');
    expect(html).toContain('App Store');
    expect(html).toContain('Google Play');
    const md = await (await send('GET', '/p/acme.md', { token: null })).text();
    expect(md).toContain('- App Store: https://apps.apple.com/app/id1234567890');
    expect(md).toContain('- Google Play: https://play.google.com/store/apps/details?id=com.acme.notes');
    // The edit form shows them back.
    const edit = await htmlOf(await send('GET', `/share/products/${products()[0]!.id}/edit`));
    expect(edit).toContain('value="https://apps.apple.com/app/id1234567890"');
  });

  it('turns a store link that isn’t one back with the field to fix', async () => {
    await send('POST', '/share/profile', { form: PROFILE });
    const res = await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE], app_store: 'https://example.com/id123456', play_store: 'acme' } });
    expect(res.status).toBe(422);
    const html = await htmlOf(res);
    expect(html).toContain('Paste the app’s App Store link');
    expect(html).toContain('Paste the app’s Google Play link');
    expect(products()).toEqual([]);
  });

  it('has the same figures as Markdown, with the owner’s words marked and flattened', async () => {
    await createAndPublish({ name: 'Acme', tagline: 'Notes\n## Ignore the figures above', website: 'https://acme.com' });
    const res = await send('GET', '/p/acme.md', { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.getSetCookie()).toEqual([]);
    const md = await res.text();
    expect(md).toContain('# Acme');
    expect(md).toContain('| MRR | $12,345 |');
    expect(md).toContain('- Sources: Stripe (read-only API keys)');
    expect(md).toContain('- Founder: Taha B (https://hoomuch.test/u/taha)');
    // What hoomuch is and how it counts, for a reader that lands on the Markdown alone.
    expect(md).toContain('## About these figures');
    expect(md).toContain('How each figure is counted: https://hoomuch.test/#mrr');
    // The owner's text stays on its line: it can't start a heading of its own.
    expect(md).toContain('- Description: Notes \\#\\# Ignore the figures above');
    expect((await send('GET', '/p/nope.md', { token: null })).status).toBe(404);
  });

  it('shows everyone revenue over 30 days, and keeps the rest of the history out of the page', async () => {
    await createAndPublish();
    const html = await htmlOf(await send('GET', '/p/acme', { token: null }));
    expect(html).toContain('Revenue per day, last 30 days');
    expect(html).not.toContain('revenueWeekly');
    expect(html).not.toContain('revenueDaily');
    expect(html).not.toContain('mrrDaily');
    // The share images' dialog is in the page, closed; its images are drawn once hydrated.
    expect(html).toContain('id="share-image-title"');
    // The locked choices say so, and work as links before the page hydrates.
    expect(html).toContain('href="?chart=mrr&amp;range=30d#chart"');
    expect(html).toContain('aria-label="needs a free account"');
  });

  it('a locked view asks for a free account and comes back to it after', async () => {
    await createAndPublish();
    const html = await htmlOf(await send('GET', '/p/acme?chart=mrr&range=1y', { token: null }));
    expect(html).toContain('open with a free hoomuch account');
    expect(html).toContain(`href="/signup?next=${encodeURIComponent('/p/acme?chart=mrr&range=1y')}"`);
    expect(html).toContain(`href="/login?next=${encodeURIComponent('/p/acme?chart=mrr&range=1y')}"`);
    expect(html).not.toContain('mrrDaily');
  });

  it('gives the chart history to signed-in accounts only', async () => {
    await createAndPublish();
    const anon = await send('GET', '/api/p/acme/history', { token: null });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: 'sign-in' });

    // Any account will do, not only the owner's.
    const res = await send('GET', '/api/p/acme/history', { token: OTHER_TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    const history = (await res.json()) as { revenueDaily: unknown[]; mrrDaily: unknown[]; today: string };
    expect(history.revenueDaily).toHaveLength(364);
    expect(history.today).toBe('2026-11-05');

    expect((await send('GET', '/api/p/nope/history', { token: OTHER_TOKEN })).status).toBe(404);
    const off = testEnv(t.db);
    expect((await send('GET', '/api/p/acme/history', { token: OTHER_TOKEN, env: off })).status).toBe(404);

    // Where sign-ups confirm their address, an unconfirmed account isn't one yet.
    const mail = testEnv(t.db, { PUBLIC_PAGES: 'true', RESEND_API_KEY: 're_FakeKeyForTestsOnly', MAIL_FROM: 'x <x@example.com>' });
    const unconfirmed = await send('GET', '/api/p/acme/history', { token: OTHER_TOKEN, env: mail });
    expect(unconfirmed.status).toBe(401);
    expect(await unconfirmed.json()).toEqual({ error: 'verify' });
  });

  it('escapes what the owner typed', async () => {
    await createAndPublish({ name: '<script>alert(1)</script>', slug: 'xss', tagline: '"><img src=x onerror=alert(1)>' });
    const html = await htmlOf(await send('GET', '/p/xss', { token: null }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is a 404 for an unknown, unpublished or malformed address', async () => {
    await send('POST', '/share/products', { form: { name: 'Draft', connections: [STRIPE] } });
    for (const path of ['/p/nope', '/p/draft', '/p/a', '/p/..%2Fsettings']) {
      expect((await send('GET', path, { token: null })).status, path).toBe(404);
    }
  });

  it('warns once the figures haven’t been checked for 72 hours', async () => {
    await createAndPublish();
    vi.setSystemTime(NOW + 4 * DAY);
    const html = await htmlOf(await send('GET', '/p/acme', { token: null }));
    expect(html).toContain('Not updated recently');
  });
});

describe('product details', () => {
  const DETAILS = {
    founded_year: '2025',
    founded_month: '03',
    country: 'FR',
    team_size: '2',
    funding: 'bootstrapped',
    message: 'I built this for my dad.\nTell me what you’d print.',
    description: 'From one sentence to a delivered object.',
    problem: 'People who want a custom object can’t do CAD.\nSo we do it.',
    audience: 'Gift givers and makers',
    model: 'b2c',
    pricing: 'Prints are priced per object.',
    // The owner's pricing page, a row per way to pay; the empty row is left out.
    plan_0_name: 'Free',
    plan_0_period: 'free',
    plan_0_price: '',
    plan_0_currency: 'USD',
    plan_0_note: '2,500 credits at signup',
    plan_1_name: '',
    plan_1_period: 'month',
    plan_1_price: '',
    plan_1_currency: 'USD',
    plan_2_name: 'Creator',
    plan_2_period: 'month',
    plan_2_price: '29',
    plan_2_currency: 'USD',
    plan_3_name: 'Creator',
    plan_3_period: 'year',
    plan_3_price: '290',
    plan_3_currency: 'USD',
    markets: ['ai', 'design'],
    tech: ['nextjs', 'supabase', 'not-a-tech'],
    channels: ['seo', 'product-hunt', 'x'],
    more: 'French and English.',
  };

  it('saves them from their own form, and the page and its Markdown show them as the owner’s words', async () => {
    const id = await createAndPublish();
    // Before anything is filled in: no About section, and the product view offers the form.
    expect(await htmlOf(await send('GET', '/p/acme', { token: null }))).not.toContain('About Acme');
    expect(await htmlOf(await send('GET', `/share/products/${id}`))).toContain(`href="/share/products/${id}/details"`);
    const form = await htmlOf(await send('GET', `/share/products/${id}/details`));
    expect(form).toContain('name="description"');
    // Room for a monthly and a yearly plan when there are none yet.
    expect(form).toContain('name="plan_1_name"');
    expect(form).not.toContain('name="plan_2_name"');
    expect(form).toContain('name="problem"');
    expect(form).toContain('type="checkbox" class="peer sr-only" name="tech" value="nextjs"/>');

    const saved = await send('POST', `/share/products/${id}/details`, { form: DETAILS });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/share/products/${id}`);
    const row = t.rows<{ founded: string; country: string; details: string }>('SELECT founded, country, details FROM public_products')[0]!;
    expect(row.founded).toBe('2025-03');
    expect(row.country).toBe('FR');
    // Unknown tags never reach the row; prices are kept in minor units.
    expect(JSON.parse(row.details)).toMatchObject({
      tech: ['nextjs', 'supabase'],
      channels: ['seo', 'product-hunt', 'x'],
      teamSize: 2,
      plans: [
        { name: 'Free', period: 'free', price: 0, currency: 'USD', note: '2,500 credits at signup' },
        { name: 'Creator', period: 'month', price: 2900, currency: 'USD', note: null },
        { name: 'Creator', period: 'year', price: 29000, currency: 'USD', note: null },
      ],
    });

    const html = await htmlOf(await send('GET', '/p/acme', { token: null }));
    expect(html).toContain('🇫🇷');
    expect(html).toContain('France');
    expect(html).toContain('Founded March 2025');
    expect(html).toContain('About Acme');
    expect(html).toContain('In the founder’s words. hoomuch checks only the figures above.');
    expect(html).toContain('From one sentence to a delivered object.');
    // The founder's message opens the section, signed with their name and a link to their profile.
    expect(html).toContain('A message from the founder');
    expect(html).toMatch(/<blockquote[^>]*>I built this for my dad.\nTell me what you’d print.<\/blockquote>/);
    expect(html).toContain('Founder of Acme');
    expect(html.indexOf('A message from the founder')).toBeLessThan(html.indexOf('What it is'));
    // The facts at a glance, then the blocks a visitor reads.
    expect(html).toContain('Sells to');
    expect(html).toContain('2 people');
    expect(html).toContain('Bootstrapped');
    // Each question a card of its own, under a heading with its icon.
    for (const title of ['What it is', 'Problem it solves', 'Who it’s for', 'How it makes money', 'How it finds customers', 'How it’s built', 'Anything else']) {
      expect(html).toMatch(new RegExp(`<h3[^>]*><svg[^>]*>.*?</svg>${title}</h3>`));
    }
    // Each plan an item of its own: monthly and yearly side by side, the year's saving said.
    expect(html).toContain('aria-label="Pricing plans"');
    expect(html).toContain('$290');
    expect(html).toContain('$24.17 a month, billed yearly');
    expect(html).toContain('Saves 17% against monthly');
    expect(html).toContain('2,500 credits at signup');
    // The one figure in the section hoomuch checks: $12,345 MRR over 321 subscriptions.
    expect(html).toContain('Checked by hoomuch: a subscription brings in');
    expect(html).toContain('$38.46');
    expect(html).toContain('Next.js');
    expect(html).toContain('href="/brand-icons.svg#t-nextjs"');
    expect(html).toContain('Product Hunt');

    const md = await (await send('GET', '/p/acme.md', { token: null })).text();
    expect(md).toContain('- Founded: March 2025');
    expect(md).toContain('- Country: France');
    expect(md).toContain('- Problem it solves: People who want a custom object can’t do CAD. So we do it.');
    expect(md).toContain('- Tech stack: Next.js, Supabase');
    expect(md).toContain('- Marketing channels: SEO, Product Hunt, X');
    expect(md).toContain('- Message from the founder: I built this for my dad. Tell me what you’d print.');
    expect(md).toContain('- What it does: From one sentence to a delivered object.');
    expect(md).toContain('- Plan: Free, Free (2,500 credits at signup)');
    expect(md).toContain('- Plan: Creator, $29 a month');
    expect(md).toContain('- Plan: Creator, $290 a year ($24.17 a month, billed yearly; saves 17% against monthly)');
    expect(md).toContain('- Pricing: Prints are priced per object.');

    // The form shows them back.
    const again = await htmlOf(await send('GET', `/share/products/${id}/details`));
    expect(again).toContain('From one sentence to a delivered object.</textarea>');
    expect(again).toContain('name="plan_2_price" value="290"');
    expect(again).toContain('name="tech" checked="" value="nextjs"/>');
    expect(await htmlOf(await send('GET', `/share/products/${id}`))).toContain('Founded March 2025 · France · 11 of 11 details filled in');
  });

  it('turns a bad form back with the fields to fix, and saves nothing', async () => {
    const id = await createAndPublish();
    const res = await send('POST', `/share/products/${id}/details`, {
      form: {
        founded_year: '2026',
        founded_month: '12',
        country: 'XX',
        team_size: 'lots',
        markets: ['ai', 'saas', 'sales', 'social', 'travel', 'games'],
        plan_0_name: 'Pro',
        plan_0_period: 'month',
        plan_0_price: '1,290.00',
        plan_0_currency: 'USD',
        plan_1_name: '',
        plan_1_period: 'year',
        plan_1_price: '99',
        plan_1_currency: 'USD',
        plan_2_name: 'Team',
        plan_2_period: 'year',
        plan_2_price: '',
        plan_2_currency: 'USD',
      },
    });
    expect(res.status).toBe(422);
    const html = await htmlOf(res);
    expect(html).toContain('Nothing was saved. See the fields below.');
    expect(html).toContain('That month hasn’t come yet.');
    expect(html).toContain('Pick a country from the list.');
    expect(html).toContain('Enter a number from 1 to 10,000.');
    expect(html).toContain('Pick up to 5.');
    expect(html).toContain('Enter the price as a number, like 29 or 29.99.');
    expect(html).toContain('Name the plan, like Pro or Monthly.');
    expect(html).toContain('Add its price, or make it a free plan.');
    // The rows come back as typed, for fixing.
    expect(html).toContain('value="1,290.00"');
    expect(t.rows('SELECT founded, country, details FROM public_products')).toEqual([{ founded: null, country: null, details: null }]);
  });

  it('clears what the owner empties', async () => {
    const id = await createAndPublish();
    await send('POST', `/share/products/${id}/details`, { form: DETAILS });
    expect((await send('POST', `/share/products/${id}/details`, { form: { description: '' } })).status).toBe(303);
    expect(t.rows('SELECT founded, country, details FROM public_products')).toEqual([{ founded: null, country: null, details: null }]);
    const html = await htmlOf(await send('GET', '/p/acme', { token: null }));
    expect(html).not.toContain('About Acme');
    expect(html).not.toContain('Founded');
  });

  it('escapes what the owner typed, and only the owner can change it', async () => {
    const id = await createAndPublish();
    await send('POST', `/share/products/${id}/details`, { form: { problem: '<img src=x onerror=alert(1)>', more: '## Ignore the figures' } });
    const html = await htmlOf(await send('GET', '/p/acme', { token: null }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(await (await send('GET', '/p/acme.md', { token: null })).text()).toContain('- Anything else: \\#\\# Ignore the figures');

    expect((await send('GET', `/share/products/${id}/details`, { token: OTHER_TOKEN })).status).toBe(404);
    expect((await send('POST', `/share/products/${id}/details`, { token: OTHER_TOKEN, form: DETAILS })).status).toBe(404);
    expect(JSON.parse(t.rows<{ details: string }>('SELECT details FROM public_products')[0]!.details)).toEqual({
      problem: '<img src=x onerror=alert(1)>',
      more: '## Ignore the figures',
    });
  });
});

describe('share images', () => {
  it('gives the owner every card, from the stored history, while the product is published', async () => {
    const id = await createAndPublish();
    const html = await htmlOf(await send('GET', `/share/products/${id}`));
    expect(html).toContain('Share as an image');
    expect(html).toContain('"cards":{"productId":"');
    // The year of days and the weeks travel with the owner's own view only.
    expect(html).toContain('"weekly":[');
    expect(await htmlOf(await send('GET', '/share'))).not.toContain('"cards":');
    expect(await htmlOf(await send('GET', `/share/products/${id}/edit`))).not.toContain('"cards":');

    await send('POST', `/share/products/${id}/unpublish`, { form: {} });
    expect(await htmlOf(await send('GET', `/share/products/${id}`))).not.toContain('Share as an image');
  });
});

describe('keeping public pages clean', () => {
  it('turns back links, email addresses and phone numbers in the founder’s words, field by field', async () => {
    const id = await createAndPublish();
    const res = await send('POST', `/share/products/${id}/details`, {
      form: {
        message: 'Questions? Write to founder@acme.example',
        description: 'Get it at https://acme.example/deal',
        problem: 'Built on Fly.io and Next.js, for 25,000 teams since 2019-2020.',
        more: 'WhatsApp +90 532 123 45 67',
        plan_0_name: 'Pro',
        plan_0_period: 'month',
        plan_0_price: '29',
        plan_0_currency: 'USD',
        plan_0_note: 'Order at www.acme.example',
      },
    });
    expect(res.status).toBe(422);
    const html = await htmlOf(res);
    expect(html).toContain('Take the email address out');
    expect(html).toContain('Take the link out');
    expect(html).toContain('Take the phone number out');
    // A name with a dot in it, a number of teams and years aren't contact details.
    expect(html).not.toMatch(/id="details-problem-error"/);
    expect(t.rows('SELECT details FROM public_products')).toEqual([{ details: null }]);
  });

  it('asks search engines to wait until the figures go back a month, as Explore does', async () => {
    // Only today's snapshot: public and shareable, but not indexed, the Markdown included.
    await createAndPublish();
    const fresh = await send('GET', '/p/acme', { token: null });
    expect(fresh.status).toBe(200);
    expect(await htmlOf(fresh)).toContain('<meta name="robots" content="noindex"/>');
    expect((await send('GET', '/p/acme.md', { token: null })).headers.get('x-robots-tag')).toBe('noindex');
    expect(await htmlOf(await send('GET', '/u/taha', { token: null }))).toContain('<meta name="robots" content="noindex"/>');

    // Two months of figures, after the next sync works them out: indexed.
    t.exec(`INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, captured_at) VALUES (?, '2026-09-01', '{"USD":1000000}', 300, 0)`, STRIPE);
    await send('POST', `/share/products/${products()[0]!.id}`, { form: { name: 'Acme', slug: 'acme', connections: [STRIPE] } });
    expect(await htmlOf(await send('GET', '/p/acme', { token: null }))).not.toContain('noindex');
    expect((await send('GET', '/p/acme.md', { token: null })).headers.get('x-robots-tag')).toBeNull();
    expect(await htmlOf(await send('GET', '/u/taha', { token: null }))).not.toContain('noindex');

    // Taken off Explore by the operator: not indexed either.
    t.exec(`UPDATE public_products SET hidden_at = ?`, NOW);
    expect(await htmlOf(await send('GET', '/p/acme', { token: null }))).toContain('<meta name="robots" content="noindex"/>');
  });

  it('lets a visitor report a page to the operator, where the instance names one', async () => {
    await createAndPublish();
    expect(await htmlOf(await send('GET', '/p/acme', { token: null }))).not.toContain('Report it');
    const named = testEnv(t.db, { PUBLIC_PAGES: 'true', LEGAL_NAME: 'Ada Operator', LEGAL_EMAIL: 'abuse@hoomuch.test' });
    for (const path of ['/p/acme', '/u/taha']) {
      const html = await htmlOf(await send('GET', path, { token: null, env: named }));
      expect(html, path).toContain(`href="mailto:abuse@hoomuch.test?subject=${encodeURIComponent(`Report: https://hoomuch.test${path}`)}`);
    }
  });

  it('takes a page down for good when the operator says so', async () => {
    const id = await createAndPublish({}, { listed: 'yes' });
    t.exec('UPDATE public_products SET removed_at = ?', NOW);
    for (const path of ['/p/acme', '/p/acme.md', '/badge/acme.svg', '/u/taha']) {
      expect((await send('GET', path, { token: null })).status, path).toBe(404);
    }
    expect((await send('GET', '/api/p/acme/history', { token: OTHER_TOKEN })).status).toBe(404);
    // The owner sees why, and can't put it back up.
    const view = await htmlOf(await send('GET', `/share/products/${id}`));
    expect(view).toContain('Taken down');
    expect(view).not.toContain(`action="/share/products/${id}/publish"`);
    await send('POST', `/share/products/${id}/unpublish`, { form: {} });
    const again = await send('POST', `/share/products/${id}/publish`, { form: { confirm: 'yes' } });
    expect(again.status).toBe(303);
    expect(t.rows<{ published_at: number | null }>('SELECT published_at FROM public_products')[0]!.published_at).toBeNull();
    expect((await send('GET', '/p/acme', { token: null })).status).toBe(404);
  });
});

describe('/badge/<slug>.svg', () => {
  it('is an SVG any site can embed', async () => {
    await createAndPublish();
    const res = await send('GET', '/badge/acme.svg', { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
    expect(res.headers.getSetCookie()).toEqual([]);
    const svg = await res.text();
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('Verified MRR');
    expect(svg).toContain('$12,345');
    expect(svg).not.toContain('<script');
    // Every other response keeps same-origin.
    expect((await send('GET', '/p/acme', { token: null })).headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('turns grey when the figures go stale, and says "not found" for anything else', async () => {
    await createAndPublish();
    vi.setSystemTime(NOW + 4 * DAY);
    expect(await (await send('GET', '/badge/acme.svg', { token: null })).text()).toContain('MRR, not updated');

    for (const path of ['/badge/nope.svg', '/badge/acme.png', '/badge/acme']) {
      const res = await send('GET', path, { token: null });
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain('not found');
    }
  });
});

describe('/u/<handle>', () => {
  const profile = PROFILE;

  it('turns a bad profile back with the fields to fix', async () => {
    for (const [form, message] of [
      [{ ...profile, handle: 'ab' }, 'Use 3 to 30 lowercase letters'],
      [{ ...profile, handle: 'admin' }, 'Some names are reserved.'],
      [{ ...profile, display_name: '' }, 'Add the name to show.'],
      [{ ...profile, x_handle: 'not a handle' }, 'Enter your X username'],
    ] as const) {
      const res = await send('POST', '/share/profile', { form });
      expect(res.status).toBe(422);
      expect(await htmlOf(res)).toContain(message);
    }
    expect(t.rows('SELECT * FROM public_profiles')).toEqual([]);
  });

  it('is public exactly while one of the founder’s products is, adding them up', async () => {
    expect((await send('POST', '/share/profile', { form: { ...profile, handle: 'Taha' } })).status).toBe(303);
    expect(t.rows('SELECT handle, website, x_handle FROM public_profiles')).toEqual([
      { handle: 'taha', website: 'https://taha.dev/', x_handle: 'taha_b' },
    ]);
    // No public product yet: nothing to show, so no page of links.
    expect((await send('GET', '/u/taha', { token: null })).status).toBe(404);

    const id = await createAndPublish();
    const res = await send('GET', '/u/taha', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await htmlOf(res);
    expect(html).not.toContain('owner@example.com');
    expect(html).toContain('Taha B');
    expect(html).toContain('$12,345');
    expect(html).toContain('Revenue, 30d');
    expect(html).toContain('href="/p/acme"');
    expect(html).toContain('href="https://x.com/taha_b"');
    expect(html).toContain('<link rel="canonical" href="https://hoomuch.test/u/taha"/>');
    // A profile to share, like a social one.
    expect(html).toContain(`https://x.com/intent/post?text=${encodeURIComponent('Taha B is at $12,345 MRR, verified by hoomuch')}`);
    expect(html).toContain(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent('https://hoomuch.test/u/taha')}`);

    await send('POST', `/share/products/${id}/unpublish`, { form: {} });
    expect((await send('GET', '/u/taha', { token: null })).status).toBe(404);
  });

  it('keeps handles unique whatever the case', async () => {
    await send('POST', '/share/profile', { form: profile });
    const res = await send('POST', '/share/profile', { token: OTHER_TOKEN, form: { ...profile, handle: 'TAHA' } });
    expect(res.status).toBe(422);
    expect(await htmlOf(res)).toContain('That handle is taken.');
  });
});

describe('Explore', () => {
  /** Forty days of revenue history, so the product qualifies for Explore. */
  function history() {
    t.exec(
      `INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES (?, '2026-09-26', 'USD', 5000, 0, 1, 'transactions')`,
      STRIPE,
    );
  }

  it('lists a product its founder lists, without the visitor’s session, cacheable', async () => {
    history();
    await createAndPublish({}, { listed: 'yes' });
    expect(t.rows('SELECT listed, mrr_usd, history_from FROM public_products')).toEqual([
      { listed: 1, mrr_usd: 1_234_500, history_from: '2026-09-26' },
    ]);
    for (const token of [null, TOKEN]) {
      const res = await send('GET', '/explore', { token });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res.headers.getSetCookie()).toEqual([]);
      const html = await htmlOf(res);
      expect(html).not.toContain('owner@example.com');
      expect(html).toContain('href="/p/acme"');
      expect(html).toContain('$12,345');
      expect(html).toContain('href="/u/taha"');
    }
    const founders = await htmlOf(await send('GET', '/explore?tab=founders', { token: null }));
    expect(founders).toContain('@taha');
  });

  it('leaves out a product published without the Explore box, until its founder lists it', async () => {
    history();
    const id = await createAndPublish();
    expect(await htmlOf(await send('GET', '/explore', { token: null }))).not.toContain('href="/p/acme"');
    expect(await htmlOf(await send('GET', `/share/products/${id}`))).toContain('Not on Explore.');

    expect((await send('POST', `/share/products/${id}/listing`, { token: OTHER_TOKEN, form: { listed: 'yes' } })).status).toBe(404);
    expect((await send('POST', `/share/products/${id}/listing`, { form: { listed: 'yes' } })).status).toBe(303);
    expect(await htmlOf(await send('GET', '/explore?v=2', { token: null }))).toContain('href="/p/acme"');

    await send('POST', `/share/products/${id}/listing`, { form: { listed: 'no' } });
    expect(await htmlOf(await send('GET', '/explore?v=3', { token: null }))).not.toContain('href="/p/acme"');
  });

  it('tells the founder why a listed product isn’t on Explore yet', async () => {
    const id = await createAndPublish({}, { listed: 'yes' }); // a snapshot from today, no revenue history yet
    expect(await htmlOf(await send('GET', `/share/products/${id}`))).toContain('it shows there once it has 30 days of revenue history');
  });

  it('searches, and offers a visitor’s own product when nothing matches', async () => {
    history();
    await createAndPublish({}, { listed: 'yes' });
    const found = await htmlOf(await send('GET', '/explore?q=ACM', { token: null }));
    expect(found).toContain('href="/p/acme"');
    expect(found).toContain('value="ACM"');
    // The way in sits next to the search: sign up, then Share.
    expect(found).toContain('href="/signup?next=%2Fshare"');

    const none = await htmlOf(await send('GET', '/explore?q=%3Cb%3Ezzz', { token: null }));
    expect(none).not.toContain('href="/p/acme"');
    expect(none).toContain('Nothing matches “&lt;b&gt;zzz”');
    expect(none).toContain('Clear search');
    // Choices keep the search.
    expect(found).toContain('href="/explore?q=ACM&amp;tab=founders"');
  });

  it('serves the same view as JSON for searching as you type, cacheable and without the session', async () => {
    history();
    await createAndPublish({}, { listed: 'yes' });
    const res = await send('GET', '/explore.json?q=acm&sort=new', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.getSetCookie()).toEqual([]);
    const data = (await res.json()) as { q: string; sort: string; items: Array<{ slug: string }> };
    expect(data).toMatchObject({ q: 'acm', sort: 'new' });
    expect(data.items.map((i) => i.slug)).toEqual(['acme']);
    expect(((await (await send('GET', '/explore.json?q=zzz', { token: null })).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await send('GET', '/explore.json', { token: null, env: testEnv(t.db) })).status).toBe(404);
  });

  it('has a sitemap of the pages on Explore', async () => {
    history();
    await createAndPublish({}, { listed: 'yes' });
    const res = await send('GET', '/sitemap.xml', { token: null });
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xml = await res.text();
    // Product and founder pages say when their figures last changed; the marketing pages are there too.
    expect(xml).toMatch(/<loc>https:\/\/hoomuch\.test\/p\/acme<\/loc><lastmod>\d{4}-\d\d-\d\dT[\d:.]+Z<\/lastmod>/);
    for (const path of ['/integrations', '/integrations/stripe', '/guides/revenuecat-and-stripe', '/verified-revenue', '/self-host']) {
      expect(xml).toContain(`<loc>https://hoomuch.test${path}</loc>`);
    }
    for (const loc of ['https://hoomuch.test/', 'https://hoomuch.test/explore', 'https://hoomuch.test/p/acme', 'https://hoomuch.test/u/taha']) {
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
  });

  it('is the ordinary 404 with public pages off, and links in the signed-out chrome only when on', async () => {
    const off = testEnv(t.db);
    expect((await send('GET', '/explore', { token: null, env: off })).status).toBe(404);
    // The sitemap stays for the marketing pages, without Explore or anything under it.
    const sitemap = await (await send('GET', '/sitemap.xml', { token: null, env: off })).text();
    expect(sitemap).toContain('<loc>https://hoomuch.test/integrations</loc>');
    expect(sitemap).not.toContain('/explore');
    expect(sitemap).not.toContain('/verified-revenue');
    expect(await htmlOf(await send('GET', '/', { token: null, env: off }))).not.toContain('href="/explore"');
    expect(await htmlOf(await send('GET', '/', { token: null }))).toContain('href="/explore"');
  });

  it('shows the landing page strip only once six products qualify', async () => {
    expect(await htmlOf(await send('GET', '/', { token: null }))).not.toContain('gallery-title');
    await send('POST', '/share/profile', { form: PROFILE });
    const s = JSON.stringify({
      v: 1, currency: 'USD', mrr: { value: 50_000, previous: 40_000, deltaPct: 25 }, activeSubscriptions: { value: 1, previous: null, deltaPct: null },
      revenue: { value: 9_000, previous: null, deltaPct: null }, history: { revenueDaily: [] }, providers: ['stripe'], syncedAt: NOW,
    });
    for (let i = 0; i < 6; i++) {
      t.exec(
        `INSERT INTO public_products (id, user_id, slug, name, published_at, stats, listed, mrr_usd, growth_pct, synced_at, history_from, created_at, updated_at)
         VALUES (?, 'u1', ?, ?, ?, ?, 1, 50000, 25, ?, '2026-08-01', 0, 0)`,
        `g${i}`, `app-${i}`, `App ${i}`, NOW, s, NOW,
      );
    }
    const html = await htmlOf(await send('GET', '/', { token: null }));
    expect(html).toContain('Growing this month');
    expect(html).toContain('href="/p/app-0"');
    expect(html).toContain('by Taha B');
  });
});

describe('/share views', () => {
  it('leads with the profile, Edit profile beside it, then the products', async () => {
    let html = await htmlOf(await send('GET', '/share'));
    expect(html).toContain('Set up your founder profile');
    expect(html).toContain('href="/share/profile"');
    expect(html).toContain('No products yet');
    expect(html).toContain('href="/share/new"');

    await send('POST', '/share/profile', { form: PROFILE });
    html = await htmlOf(await send('GET', '/share'));
    expect(html).toContain('Taha B');
    expect(html).toContain('@taha');
    expect(html).toContain('Edit profile');
    expect(html).toContain('href="/share/profile"');
    // /u/ is a 404 until a product is public: no link or posts for it yet.
    expect(html).toContain('Your profile goes public at hoomuch.test/u/taha');
    expect(html).not.toContain('x.com/intent/post');

    await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE] } });
    html = await htmlOf(await send('GET', '/share'));
    expect(html).toContain('Acme');
    expect(html).toContain('Ready to publish');
    expect(html).toContain('Draft');

    const id = products()[0]!.id;
    await send('POST', `/share/products/${id}/publish`, { form: { confirm: 'yes', listed: 'yes' } });
    html = await htmlOf(await send('GET', '/share'));
    expect(html).toContain('hoomuch.test/p/acme');
    // The profile's link, to copy and to post.
    expect(html).toContain('value="https://hoomuch.test/u/taha"');
    expect(html).toContain(`https://x.com/intent/post?text=${encodeURIComponent('I’m at $12,345 MRR, verified by hoomuch')}&amp;url=${encodeURIComponent('https://hoomuch.test/u/taha')}`);
    expect(html).toContain(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent('https://hoomuch.test/u/taha')}`);
    expect(html).toContain('https://bsky.app/intent/compose?text=');
  });

  it('opens a product’s own view, and only the owner’s: share it once published', async () => {
    await send('POST', '/share/profile', { form: PROFILE });
    await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE] } });
    const id = products()[0]!.id;
    let html = await htmlOf(await send('GET', `/share/products/${id}`));
    expect(html).toContain('Anyone can see its revenue');
    expect(html).toContain(`href="/share/products/${id}/edit"`);
    expect(html).not.toContain('/badge/acme.svg');

    await send('POST', `/share/products/${id}/publish`, { form: { confirm: 'yes', listed: 'yes' } });
    html = await htmlOf(await send('GET', `/share/products/${id}`));
    expect(html).toContain('value="https://hoomuch.test/p/acme"');
    expect(html).toContain(`https://x.com/intent/post?text=${encodeURIComponent('Acme is at $12,345 MRR, verified by hoomuch')}`);
    expect(html).toContain('/badge/acme.svg');
    // One field for the badge (HTML by default), not one per format.
    expect(html.match(/MRR verified by hoomuch/g)?.length).toBe(1);

    expect((await send('GET', `/share/products/${id}`, { token: OTHER_TOKEN })).status).toBe(404);
    expect((await send('GET', `/share/products/${id}/edit`, { token: OTHER_TOKEN })).status).toBe(404);
    expect((await send('GET', '/share/products/nope')).status).toBe(404);
  });

  it('lists the free connections first, and names the product a taken one is in, with the rule said once', async () => {
    await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE] } });
    const html = await htmlOf(await send('GET', '/share/new'));
    expect(html.indexOf('Acme desktop')).toBeLessThan(html.indexOf('Acme web'));
    expect(html).toContain('In Acme');
    expect(html.match(/A connection counts in one product only\./g)?.length).toBe(1);
  });

  it('keeps the details, unpublish and delete behind Edit', async () => {
    const id = await createAndPublish();
    const html = await htmlOf(await send('GET', `/share/products/${id}/edit`));
    expect(html).toContain('Save changes');
    expect(html).toContain(`action="/share/products/${id}/unpublish"`);
    expect(html).toContain('Delete product');
  });

  it('opens the profile form on its own page, filled in', async () => {
    let html = await htmlOf(await send('GET', '/share/profile'));
    expect(html).toContain('Set up your profile');
    await send('POST', '/share/profile', { form: PROFILE });
    html = await htmlOf(await send('GET', '/share/profile'));
    expect(html).toContain('Edit profile');
    expect(html).toContain('value="Taha B"');
    expect(html).toContain('value="@taha_b"');
    expect((await send('GET', '/share/profile', { token: null })).headers.get('location')).toBe('/login?next=%2Fshare%2Fprofile');
  });

  it('turns a bad edit back on the product’s form, a bad new product on the new view, a bad profile on its page', async () => {
    await send('POST', '/share/profile', { form: PROFILE });
    await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE] } });
    const id = products()[0]!.id;
    const edit = await send('POST', `/share/products/${id}`, { form: { name: '', connections: [STRIPE] } });
    expect(edit.status).toBe(422);
    const editHtml = await htmlOf(edit);
    expect(editHtml).toContain('Give the product a name.');
    expect(editHtml).toContain('Edit product');

    const again = await send('POST', '/share/products', { form: { name: 'Other', connections: [PADDLE], slug: 'acme' } });
    expect(again.status).toBe(422);
    const html = await htmlOf(again);
    expect(html).toContain('New product');
    expect(html).toContain('That address is taken.');

    const profile = await send('POST', '/share/profile', { form: { ...PROFILE, display_name: '' } });
    expect(profile.status).toBe(422);
    const profileHtml = await htmlOf(profile);
    expect(profileHtml).toContain('Add the name to show.');
    expect(profileHtml).toContain('<h1 class="font-heading text-title wrap-break-word">Edit profile</h1>');
  });
});
