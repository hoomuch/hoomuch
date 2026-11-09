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
      expect(html).toContain('<meta property="og:title" content="Acme: $12,345 MRR, verified"/>');
      expect(html).toContain('<link rel="alternate" type="text/markdown" href="https://hoomuch.test/p/acme.md"/>');
      expect(html).not.toContain('noindex');
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
    // The owner's text stays on its line: it can't start a heading of its own.
    expect(md).toContain('- Description: Notes \\#\\# Ignore the figures above');
    expect((await send('GET', '/p/nope.md', { token: null })).status).toBe(404);
  });

  it('shows everyone revenue over 30 days, and keeps the rest of the history out of the page', async () => {
    await createAndPublish();
    const html = await htmlOf(await send('GET', '/p/acme', { token: null }));
    expect(html).toContain('Revenue per day, last 30 days');
    expect(html).not.toContain('revenueWeekly');
    expect(html).not.toContain('mrrDaily');
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
    expect(history.revenueDaily).toHaveLength(90);
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
    for (const loc of ['https://hoomuch.test/', 'https://hoomuch.test/explore', 'https://hoomuch.test/p/acme', 'https://hoomuch.test/u/taha']) {
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
  });

  it('is the ordinary 404 with public pages off, and links in the signed-out chrome only when on', async () => {
    const off = testEnv(t.db);
    expect((await send('GET', '/explore', { token: null, env: off })).status).toBe(404);
    expect((await send('GET', '/sitemap.xml', { token: null, env: off })).status).toBe(404);
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
