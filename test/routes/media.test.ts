/**
 * Founders' photos and products' logos (routes/media.tsx) through the real request pipeline: the
 * owner's uploads, removals and website icons, and the visitor's /media/<key>, on an in-memory D1
 * and R2 bucket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { base64UrlToBytes, hashPassword, sha256Hex } from '../../src/lib/crypto';
import { UPLOAD_MAX_BYTES } from '../../src/lib/media';
import { DAY } from '../../src/lib/time';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { fakeFetch, route, type Route } from '../fixtures/harness';
import { htmlOf } from '../fixtures/html';
import { setLogo } from '../../src/db/public';
import { FakeR2, pngBytes } from '../fixtures/r2';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
const OTHER_TOKEN = 'other-session-token';
const STRIPE = '11111111-1111-4111-8111-111111111111';
const THEIRS = '44444444-4444-4444-8444-444444444444';
const PROFILE = { handle: 'taha', display_name: 'Taha B', bio: '', website: '', x_handle: '' };

let t: TestD1;
let r2: FakeR2;
let env: ReturnType<typeof testEnv>;
let pending: Promise<unknown>[];
let calls: Array<{ url: string }>;

/** Where the website icon lookups go: everything else (FX and the like) is a 503. */
function useWeb(routes: Route[]) {
  const fake = fakeFetch([...routes, route(/.*/, { status: 503, json: {} })]);
  calls = fake.calls;
  vi.stubGlobal('fetch', fake.fetch);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useWeb([]);
  t = createTestD1();
  r2 = new FakeR2();
  seedUser(t, { id: 'u1', email: 'owner@example.com' });
  seedUser(t, { id: 'u2', email: 'other@example.com' });
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(OTHER_TOKEN), 'u2', NOW + DAY, NOW);
  seedConnection(t, { id: STRIPE, userId: 'u1', provider: 'stripe', name: 'Acme web', lastSyncedAt: NOW - 3_600_000 });
  seedConnection(t, { id: THEIRS, userId: 'u2', provider: 'stripe', name: 'Theirs', lastSyncedAt: NOW - 3_600_000 });
  t.exec(`INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, captured_at) VALUES (?, '2026-11-05', '{"USD":1234500}', 321, 0)`, STRIPE);
  env = testEnv(t.db, { PUBLIC_PAGES: 'true', MEDIA: r2.asBucket() });
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
  opts: { form?: Record<string, string | readonly string[]>; file?: { field: string; bytes: Uint8Array; type?: string }; token?: string | null; env?: ReturnType<typeof testEnv> } = {},
): Promise<Response> {
  const token = opts.token === undefined ? TOKEN : opts.token;
  let body: BodyInit | undefined;
  const headers: Record<string, string> = { origin: ORIGIN, ...(token ? { cookie: `__Host-hm_session=${token}` } : {}) };
  if (opts.file) {
    // Multipart, as a form with a file field posts: the other fields too.
    const form = new FormData();
    for (const [k, v] of Object.entries(opts.form ?? {})) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
    form.append(opts.file.field, new File([opts.file.bytes.slice()], 'picked.png', { type: opts.file.type ?? 'image/png' }));
    body = form;
  } else if (opts.form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) for (const x of Array.isArray(v) ? v : [v]) params.append(k, x);
    body = params.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const req = new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: 'manual' });
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  return worker.fetch!(req as never, opts.env ?? env, ctx as never) as Promise<Response>;
}

const avatarKey = (user = 'u1') => t.rows<{ avatar_key: string | null }>('SELECT avatar_key FROM public_profiles WHERE user_id = ?', user)[0]?.avatar_key ?? null;
const product = () => t.rows<{ id: string; logo_key: string | null; logo_source: string | null }>('SELECT id, logo_key, logo_source FROM public_products')[0]!;

/** The flash a redirect carries (base64url JSON in the cookie). */
function flashOf(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('__Host-hm_flash=') && !c.includes('Max-Age=0'));
  const value = raw?.split(';')[0]?.split('=')[1] ?? '';
  return value ? (JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as { message: string }).message : '';
}

async function withProfile() {
  expect((await send('POST', '/share/profile', { form: PROFILE })).status).toBe(303);
}

async function withProduct(form: Record<string, string> = {}) {
  await withProfile();
  expect((await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE], ...form } })).status).toBe(303);
  return product().id;
}

describe('a founder’s photo', () => {
  it('needs a profile to belong to', async () => {
    const res = await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes() } });
    expect(res.headers.get('location')).toBe('/share/profile');
    expect(flashOf(res)).toContain('Save your profile first');
    expect(r2.objects.size).toBe(0);
  });

  it('is stored under a fresh key, replaced with the old one deleted, and removed', async () => {
    await withProfile();
    expect((await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes() } })).status).toBe(303);
    const first = avatarKey()!;
    expect(first).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(r2.objects.get(first)?.contentType).toBe('image/png');

    await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes(200, 200) } });
    const second = avatarKey()!;
    expect(second).not.toBe(first);
    expect([...r2.objects.keys()]).toEqual([second]);

    const removed = await send('POST', '/share/profile/photo/delete', { form: {} });
    expect(flashOf(removed)).toContain('Photo removed');
    expect(avatarKey()).toBeNull();
    expect(r2.objects.size).toBe(0);
  });

  it('turns away what isn’t a PNG, JPEG, WebP or GIF, whatever it’s called', async () => {
    await withProfile();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const bytes of [svg, new TextEncoder().encode('<html><script>alert(1)</script></html>'), pngBytes(9000, 9000)]) {
      const res = await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes, type: 'image/png' } });
      expect(res.headers.get('location')).toBe('/share/profile');
      expect(flashOf(res)).toContain('Use a PNG, JPEG, WebP or GIF image');
    }
    // An icon is fine from a website, not as an upload.
    const ico = new Uint8Array([0, 0, 1, 0, 1, 0, 32, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(flashOf(await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: ico } }))).toContain('Use a PNG');
    expect(flashOf(await send('POST', '/share/profile/photo', { form: {} }))).toContain('Choose an image first');
    expect(r2.objects.size).toBe(0);
    expect(avatarKey()).toBeNull();
  });

  it('turns away a file over the limit before reading it', async () => {
    await withProfile();
    const res = await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes(64, 64, new Array(UPLOAD_MAX_BYTES + 70_000).fill(0)) } });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toContain('over 2 MB');
    expect(r2.objects.size).toBe(0);
  });

  it('is stored without what came with it: metadata and anything after the image', async () => {
    await withProfile();
    // A PNG with a text chunk (where a phone or editor puts its notes), then HTML after IEND.
    const withExtras = new Uint8Array([...pngBytes().slice(0, 33), 0, 0, 0, 5, ...new TextEncoder().encode('tEXtGPS:1'), 0, 0, 0, 0, ...pngBytes().slice(33)]);
    const extras = new Uint8Array([...withExtras, ...new TextEncoder().encode('<html><script>alert(1)</script>')]);
    await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: extras } });
    expect(r2.objects.get(avatarKey()!)?.bytes).toEqual(pngBytes());
  });

  it('allows so many changes, then asks for a pause', async () => {
    await withProfile();
    for (let n = 0; n < 20; n++) await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes() } });
    const last = avatarKey();
    const over = await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes(100, 100) } });
    expect(flashOf(over)).toContain('a lot of changes');
    expect(avatarKey()).toBe(last);
    expect(r2.objects.size).toBe(1);
  });

  it('shows on the profile, its products and Explore, served from this origin', async () => {
    const id = await withProduct();
    await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes() } });
    await send('POST', `/share/products/${id}/publish`, { form: { confirm: 'yes' } });
    const src = `/media/${avatarKey()}`;
    expect(await htmlOf(await send('GET', '/share'))).toContain(`src="${src}"`);
    expect(await htmlOf(await send('GET', '/u/taha', { token: null }))).toContain(`src="${src}"`);
    expect(await htmlOf(await send('GET', '/p/acme', { token: null }))).toContain(`src="${src}"`);
  });
});

describe('/media/<key>', () => {
  it('serves the bytes as the type its key says, inert, cacheable for good, without the session', async () => {
    await withProfile();
    await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes() } });
    const res = await send('GET', `/media/${avatarKey()}`, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toMatch(/^default-src 'none'; sandbox/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pngBytes());
  });

  it('is a 404 for an unknown key, anything that isn’t one of ours, or without the bucket', async () => {
    for (const path of [`/media/${'a'.repeat(32)}.png`, '/media/..%2Fx.png', '/media/x.svg', '/media']) {
      expect((await send('GET', path, { token: null })).status).toBe(404);
    }
    // A trailing slash goes to the address without one (src/index.tsx), which is the 404 above.
    expect((await send('GET', '/media/', { token: null })).headers.get('location')).toBe('https://hoomuch.test/media');
    await withProfile();
    await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes() } });
    const off = testEnv(t.db, { PUBLIC_PAGES: 'true' });
    expect((await send('GET', `/media/${avatarKey()}`, { env: off })).status).toBe(404);
    expect((await send('POST', '/share/profile/photo', { env: off, file: { field: 'photo', bytes: pngBytes() } })).status).toBe(404);
    // And no way to add one is offered.
    expect(await htmlOf(await send('GET', '/share/profile', { env: off }))).not.toContain('/share/profile/photo');
  });
});

describe('a product’s logo', () => {
  const site = (icon: Uint8Array = pngBytes(180, 180)) => [
    // The fake matches on the path; the calls below show the hosts.
    route('/', { body: '<html><head><link rel="apple-touch-icon" href="/apple.png"></head></html>', headers: { 'content-type': 'text/html' } }),
    route('/apple.png', { bytes: icon, headers: { 'content-type': 'image/png' } }),
  ];

  it('comes from its website when it’s saved with one', async () => {
    useWeb(site());
    await withProduct({ website: 'https://acme.com' });
    expect(product().logo_source).toBe('site');
    expect(r2.objects.get(product().logo_key!)?.bytes).toEqual(pngBytes(180, 180));
    expect(calls.map((c) => c.url)).toEqual(['https://acme.com/', 'https://acme.com/apple.png']);
  });

  it('follows a redirect only to an address hoomuch may fetch', async () => {
    // The site sends the page to an internal address, and its icon too.
    useWeb([
      route('/', { status: 302, body: '', headers: { location: 'https://localhost./admin' } }),
      route('/apple-touch-icon.png', { status: 301, body: '', headers: { location: 'https://169.254.169.254/latest/meta-data' } }),
      route('/favicon.ico', [
        { status: 302, body: '', headers: { location: '/a' } },
        { status: 302, body: '', headers: { location: '/b' } },
        { status: 302, body: '', headers: { location: '/c' } },
        { status: 302, body: '', headers: { location: '/d' } },
      ]),
    ]);
    await withProduct({ website: 'https://acme.com' });
    expect(product().logo_key).toBeNull();
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes('localhost') || u.includes('169.254'))).toBe(false);
    // Three hops at most, then it gives up.
    expect(urls.filter((u) => u.startsWith('https://acme.com/favicon.ico') || /acme\.com\/[a-d]$/.test(u)).length).toBeLessThanOrEqual(4);
  });

  it('keeps initials when the website has nothing usable, and never fetches a private address', async () => {
    useWeb([
      route('/', { body: '<link rel="icon" href="https://localhost/x.png"><link rel="icon" href="/i.svg">' }),
      route('/apple-touch-icon.png', { status: 404, body: '' }),
      route('/favicon.ico', { body: '<html>not an icon</html>' }),
    ]);
    await withProduct({ website: 'https://acme.com' });
    expect(product().logo_key).toBeNull();
    expect(calls.map((c) => c.url)).not.toContain('https://localhost/x.png');
    expect(calls.map((c) => c.url)).not.toContain('https://acme.com/i.svg');
  });

  it('is the owner’s own once uploaded: a new website doesn’t replace it, the site’s icon only on request', async () => {
    useWeb(site());
    const id = await withProduct({ website: 'https://acme.com' });
    const siteKey = product().logo_key!;
    expect(flashOf(await send('POST', `/share/products/${id}/logo`, { file: { field: 'logo', bytes: pngBytes(256, 256) } }))).toBe('Logo updated.');
    expect(product().logo_source).toBe('upload');
    expect(r2.objects.has(siteKey)).toBe(false);

    await send('POST', `/share/products/${id}`, { form: { name: 'Acme', connections: [STRIPE], website: 'https://acme.com/new' } });
    expect(product().logo_source).toBe('upload');

    await send('POST', `/share/products/${id}`, { form: { name: 'Acme', connections: [STRIPE], website: 'https://acme.com' } });
    const res = await send('POST', `/share/products/${id}/logo/site`, { form: {} });
    expect(flashOf(res)).toContain('fetched icon');
    expect(product().logo_source).toBe('site');
    expect(r2.objects.size).toBe(1);
  });

  it('never replaces a logo uploaded while the website’s icon was being fetched', async () => {
    const id = await withProduct();
    t.exec("UPDATE public_products SET logo_key = ?, logo_source = 'upload'", `${'a'.repeat(32)}.png`);
    // What the icon lookup writes when it's done, keeping an upload.
    expect(await setLogo(env.DB, 'u1', id, `${'b'.repeat(32)}.png`, 'site', true)).toBe('not-found');
    expect(product()).toMatchObject({ logo_key: `${'a'.repeat(32)}.png`, logo_source: 'upload' });
    // The owner asking for the site's icon does replace it.
    expect(await setLogo(env.DB, 'u1', id, `${'b'.repeat(32)}.png`, 'site', false)).toBe(`${'a'.repeat(32)}.png`);
  });

  it('can come with a new product: the owner’s own, so the website’s icon isn’t fetched', async () => {
    useWeb(site());
    await withProfile();
    const res = await send('POST', '/share/products', {
      form: { name: 'Acme', connections: [STRIPE], website: 'https://acme.com' },
      file: { field: 'logo', bytes: pngBytes(256, 256) },
    });
    expect(res.status).toBe(303);
    expect(product().logo_source).toBe('upload');
    expect(r2.objects.get(product().logo_key!)?.bytes).toEqual(pngBytes(256, 256));
    expect(calls).toEqual([]);
  });

  it('turns a new product away with its logo when the logo isn’t an image, keeping what was typed', async () => {
    await withProfile();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const res = await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE] }, file: { field: 'logo', bytes: svg } });
    expect(res.status).toBe(422);
    const html = await htmlOf(res);
    expect(html).toContain('Use a PNG, JPEG, WebP or GIF image');
    expect(html).toContain('value="Acme"');
    expect(t.rows('SELECT id FROM public_products')).toEqual([]);
    expect(r2.objects.size).toBe(0);
  });

  it('is asked for on the new-product form only where the instance keeps images', async () => {
    await withProfile();
    const html = await htmlOf(await send('GET', '/share/new'));
    expect(html).toMatch(/enctype="multipart\/form-data"/i);
    expect(html).toContain('name="logo"');
    const off = await htmlOf(await send('GET', '/share/new', { env: testEnv(t.db, { PUBLIC_PAGES: 'true' }) }));
    expect(off).not.toContain('name="logo"');
    expect(off).not.toContain('multipart/form-data');
  });

  it('comes from the App Store listing when there’s no website', async () => {
    // Apple's lookup API, then the artwork it names, asked for at upload size (the fake matches on the path).
    useWeb([
      route('/lookup', { json: { resultCount: 1, results: [{ artworkUrl512: 'https://is1-ssl.mzstatic.com/image/thumb/icon/512x512bb.png' }] } }, { query: { id: '1234567890' } }),
      route('/image/thumb/icon/400x400bb.jpg', { bytes: pngBytes(400, 400), headers: { 'content-type': 'image/png' } }),
    ]);
    await withProduct({ app_store: 'https://apps.apple.com/app/id1234567890' });
    expect(product().logo_source).toBe('site');
    expect(r2.objects.get(product().logo_key!)?.bytes).toEqual(pngBytes(400, 400));
    expect(calls.map((c) => c.url)).toEqual([
      'https://itunes.apple.com/lookup?id=1234567890',
      'https://is1-ssl.mzstatic.com/image/thumb/icon/400x400bb.jpg',
    ]);
  });

  it('falls back to the App Store artwork as named when the smaller one isn’t there', async () => {
    useWeb([
      route('/lookup', { json: { resultCount: 1, results: [{ artworkUrl512: 'https://is1-ssl.mzstatic.com/image/thumb/icon/512x512bb.png' }] } }, { query: { id: '1234567890' } }),
      route('/image/thumb/icon/400x400bb.jpg', { status: 404 }),
      route('/image/thumb/icon/512x512bb.png', { bytes: pngBytes(512, 512), headers: { 'content-type': 'image/png' } }),
    ]);
    await withProduct({ app_store: 'https://apps.apple.com/app/id1234567890' });
    expect(r2.objects.get(product().logo_key!)?.bytes).toEqual(pngBytes(512, 512));
    expect(calls.map((c) => c.url).slice(1)).toEqual([
      'https://is1-ssl.mzstatic.com/image/thumb/icon/400x400bb.jpg',
      'https://is1-ssl.mzstatic.com/image/thumb/icon/512x512bb.png',
    ]);
  });

  it('drops the old site’s icon when the website changes to one without an icon', async () => {
    useWeb(site());
    const id = await withProduct({ website: 'https://acme.com' });
    expect(product().logo_key).not.toBeNull();
    useWeb([]);
    await send('POST', `/share/products/${id}`, { form: { name: 'Acme', connections: [STRIPE], website: 'https://other.com' } });
    expect(product().logo_key).toBeNull();
    expect(r2.objects.size).toBe(0);
  });

  it('is removed with the product, and with the account', async () => {
    useWeb(site());
    const id = await withProduct({ website: 'https://acme.com' });
    await send('POST', `/share/products/${id}/delete`, { form: {} });
    expect(r2.objects.size).toBe(0);

    await send('POST', '/share/products', { form: { name: 'Acme', connections: [STRIPE], website: 'https://acme.com' } });
    await send('POST', '/share/profile/photo', { file: { field: 'photo', bytes: pngBytes() } });
    expect(r2.objects.size).toBe(2);
    // A refused delete keeps them; the account's deletion takes them all.
    t.exec('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword('correct horse battery'), 'u1');
    expect((await send('POST', '/settings/delete', { form: { password: 'wrong password here', confirm: 'yes' } })).status).toBe(422);
    expect(r2.objects.size).toBe(2);
    expect((await send('POST', '/settings/delete', { form: { password: 'correct horse battery', confirm: 'yes' } })).status).toBe(303);
    expect(r2.objects.size).toBe(0);
  });

  it('is only ever the owner’s to change', async () => {
    const id = await withProduct();
    for (const [path, opts] of [
      [`/share/products/${id}/logo`, { file: { field: 'logo', bytes: pngBytes() } }],
      [`/share/products/${id}/logo/site`, { form: {} }],
      [`/share/products/${id}/logo/delete`, { form: {} }],
    ] as const) {
      expect((await send('POST', path, { ...opts, token: OTHER_TOKEN })).status).toBe(404);
    }
    expect(r2.objects.size).toBe(0);
    // Another owner removing "their" photo touches nothing of u1's.
    await send('POST', `/share/products/${id}/logo`, { file: { field: 'logo', bytes: pngBytes() } });
    await send('POST', '/share/profile/photo/delete', { form: {}, token: OTHER_TOKEN });
    expect(r2.objects.size).toBe(1);
  });

  it('shows on its page, the founder’s profile and Explore', async () => {
    const id = await withProduct();
    await send('POST', `/share/products/${id}/logo`, { file: { field: 'logo', bytes: pngBytes() } });
    await send('POST', `/share/products/${id}/publish`, { form: { confirm: 'yes' } });
    const src = `/media/${product().logo_key}`;
    expect(await htmlOf(await send('GET', '/p/acme', { token: null }))).toContain(`src="${src}"`);
    expect(await htmlOf(await send('GET', '/u/taha', { token: null }))).toContain(`src="${src}"`);
    expect(await htmlOf(await send('GET', `/share/products/${id}/edit`))).toContain(`src="${src}"`);
  });
});
