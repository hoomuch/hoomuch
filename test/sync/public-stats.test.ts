import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePublicStats } from '../../src/data/types';
import {
  deleteProduct,
  getPublishedProductBySlug,
  insertProduct,
  listProducts,
  setPublished,
  updateProduct,
} from '../../src/db/public';
import { MAX_PRODUCTS } from '../../src/lib/public-pages';
import { stripeAdapter } from '../../src/providers/stripe';
import { deleteConnection } from '../../src/services/connections';
import { refreshProductStats } from '../../src/services/public-pages';
import { syncConnection } from '../../src/sync/engine';
import { seedConnection } from '../fixtures/d1';
import { NOW, SECRET, SNAP, page, seedStripe, setup, teardown, type Ctx } from './helpers';

const FIELDS = { slug: 'acme', name: 'Acme', tagline: null, website: null, appStoreUrl: null, playStoreUrl: null };

let current: Ctx | null = null;
function ctx(publicPages = true): Ctx {
  current = setup({ env: { PUBLIC_PAGES: publicPages ? 'true' : '' } });
  return current;
}

afterEach(() => {
  const out = current?.out.join('\n') ?? '';
  current = null;
  teardown();
  expect(out).not.toContain(SECRET);
});

function product(c: Ctx, id = 'p1') {
  return c.t.rows<{ stats: string | null; stats_at: number | null; published_at: number | null }>(
    'SELECT stats, stats_at, published_at FROM public_products WHERE id = ?',
    id,
  )[0];
}

function stripeOk() {
  vi.spyOn(stripeAdapter, 'fetchSnapshot').mockResolvedValue(SNAP);
  vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
}

describe('public product stats after a sync', () => {
  it('a sync of a published product’s connection stores its figures in USD', async () => {
    const c = ctx();
    await seedStripe(c, 'stripe-1');
    expect(await insertProduct(c.env.DB, { id: 'p1', userId: c.userId, now: NOW, ...FIELDS }, ['stripe-1'])).toBe('ok');
    await setPublished(c.env.DB, c.userId, 'p1', NOW);
    stripeOk();

    const r = await syncConnection(c.env, 'stripe-1', 'manual');
    expect(r.ok).toBe(true);
    const stats = parsePublicStats(product(c)!.stats);
    // SNAP: USD 1,200.00 + EUR 50.00 at 0.92 → 54.35.
    expect(stats?.mrr.value).toBe(120_000 + Math.round(5_000 / 0.92));
    expect(stats?.activeSubscriptions.value).toBe(42);
    expect(stats?.syncedAt).toBe(NOW);
    // The copies Explore sorts and filters on are written with the figures.
    expect(c.t.rows('SELECT mrr_usd, synced_at, history_from FROM public_products')).toEqual([
      { mrr_usd: stats!.mrr.value, synced_at: NOW, history_from: stats!.revenueSince ?? stats!.since },
    ]);

    const pub = await getPublishedProductBySlug(c.env.DB, 'ACME');
    expect(pub?.name).toBe('Acme');
  });

  it('leaves an unpublished product, and every product while public pages are off, alone', async () => {
    for (const [on, published] of [[true, false], [false, true]] as const) {
      const c = ctx(on);
      await seedStripe(c, 'stripe-1');
      await insertProduct(c.env.DB, { id: 'p1', userId: c.userId, now: NOW, ...FIELDS }, ['stripe-1']);
      if (published) await setPublished(c.env.DB, c.userId, 'p1', NOW);
      stripeOk();
      expect((await syncConnection(c.env, 'stripe-1', 'manual')).ok).toBe(true);
      expect(product(c)!.stats_at).toBeNull();
      teardown();
    }
  });

  it('a failure working out the figures doesn’t fail the sync, and logs only the product', async () => {
    const c = ctx();
    await seedStripe(c, 'stripe-1');
    await insertProduct(c.env.DB, { id: 'p1', userId: c.userId, now: NOW, ...FIELDS }, ['stripe-1']);
    await setPublished(c.env.DB, c.userId, 'p1', NOW);
    stripeOk();
    const realPrepare = c.env.DB.prepare.bind(c.env.DB);
    vi.spyOn(c.env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('UPDATE public_products SET stats')) throw new Error('D1 down');
      return realPrepare(sql);
    });

    expect((await syncConnection(c.env, 'stripe-1', 'manual')).ok).toBe(true);
    expect(c.out.join('\n')).toContain('public_stats_failed');
    expect(c.out.join('\n')).toContain('"productId":"p1"');
  });

  it('deleting a connection works its product out again without it', async () => {
    const c = ctx();
    await seedStripe(c, 'stripe-1');
    await seedStripe(c, 'stripe-2');
    await insertProduct(c.env.DB, { id: 'p1', userId: c.userId, now: NOW, ...FIELDS }, ['stripe-1', 'stripe-2']);
    await setPublished(c.env.DB, c.userId, 'p1', NOW);
    stripeOk();
    await syncConnection(c.env, 'stripe-1', 'manual');
    await syncConnection(c.env, 'stripe-2', 'manual');
    expect(parsePublicStats(product(c)!.stats)?.activeSubscriptions.value).toBe(84);

    expect(await deleteConnection(c.env, c.userId, 'stripe-2')).toBe(true);
    expect(parsePublicStats(product(c)!.stats)?.activeSubscriptions.value).toBe(42);

    // The last one gone: no figures, so the page is a 404.
    expect(await deleteConnection(c.env, c.userId, 'stripe-1')).toBe(true);
    expect(product(c)!.stats).toBeNull();
    expect(await getPublishedProductBySlug(c.env.DB, 'acme')).toBeNull();
  });
});

describe('the owner’s product queries', () => {
  it('link only the owner’s real, live connections, each to one product', async () => {
    const c = ctx();
    await seedStripe(c, 'mine');
    seedConnection(c.t, { id: 'demo', userId: c.userId, provider: 'demo' });
    seedConnection(c.t, { id: 'test', userId: c.userId, provider: 'stripe', testMode: true });
    c.t.exec("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('other', 'o@example.com', 'x', 0, 0)");
    seedConnection(c.t, { id: 'theirs', userId: 'other', provider: 'stripe' });

    await insertProduct(c.env.DB, { id: 'p1', userId: c.userId, now: NOW, ...FIELDS }, ['mine', 'demo', 'test', 'theirs']);
    await insertProduct(c.env.DB, { id: 'p2', userId: c.userId, now: NOW, ...FIELDS, slug: 'second' }, ['mine']);
    const { products, links } = await listProducts(c.env.DB, c.userId);
    expect(products.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(links).toEqual([{ connection_id: 'mine', product_id: 'p1' }]);

    // Moving it: the edit replaces p1's links, then p2 can take it.
    expect(await updateProduct(c.env.DB, c.userId, 'p1', FIELDS, [], NOW)).toBe('ok');
    expect(await updateProduct(c.env.DB, c.userId, 'p2', { ...FIELDS, slug: 'second' }, ['mine'], NOW)).toBe('ok');
    expect((await listProducts(c.env.DB, c.userId)).links).toEqual([{ connection_id: 'mine', product_id: 'p2' }]);

    // Someone else's product: nothing changes.
    expect(await updateProduct(c.env.DB, 'other', 'p2', FIELDS, [], NOW)).toBe('not-found');
    expect(await setPublished(c.env.DB, 'other', 'p2', NOW)).toBe(false);
    expect(await deleteProduct(c.env.DB, 'other', 'p2')).toBeNull();
    expect((await listProducts(c.env.DB, c.userId)).links).toHaveLength(1);
  });

  it('keep slugs unique across accounts, whatever the case, and cap products per account', async () => {
    const c = ctx();
    expect(await insertProduct(c.env.DB, { id: 'p1', userId: c.userId, now: NOW, ...FIELDS }, [])).toBe('ok');
    c.t.exec("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('other', 'o@example.com', 'x', 0, 0)");
    expect(await insertProduct(c.env.DB, { id: 'p2', userId: 'other', now: NOW, ...FIELDS, slug: 'ACME' }, [])).toBe('slug-taken');
    expect(await insertProduct(c.env.DB, { id: 'p2', userId: 'other', now: NOW, ...FIELDS, slug: 'acme-2' }, [])).toBe('ok');
    expect(await updateProduct(c.env.DB, 'other', 'p2', FIELDS, [], NOW)).toBe('slug-taken');

    for (let i = 3; i <= MAX_PRODUCTS + 1; i++) {
      await insertProduct(c.env.DB, { id: `p${i}`, userId: c.userId, now: NOW, ...FIELDS, slug: `acme-${i}` }, []);
    }
    expect(c.t.rows('SELECT id FROM public_products WHERE user_id = ?', c.userId)).toHaveLength(MAX_PRODUCTS);
    expect(await insertProduct(c.env.DB, { id: 'px', userId: c.userId, now: NOW, ...FIELDS, slug: 'one-more' }, [])).toBe('limit');
  });

  it('a product is public only once published and worked out', async () => {
    const c = ctx();
    await seedStripe(c, 'stripe-1');
    await insertProduct(c.env.DB, { id: 'p1', userId: c.userId, now: NOW, ...FIELDS }, ['stripe-1']);
    c.t.exec(
      `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, captured_at) VALUES ('stripe-1', '2026-11-05', '{"USD":100}', 1, 0)`,
    );
    await refreshProductStats(c.env, 'p1'); // the owner's save works out a preview
    expect(product(c)!.stats).not.toBeNull();
    expect(await getPublishedProductBySlug(c.env.DB, 'acme')).toBeNull();

    await setPublished(c.env.DB, c.userId, 'p1', NOW);
    expect(await getPublishedProductBySlug(c.env.DB, 'acme')).not.toBeNull();
    await setPublished(c.env.DB, c.userId, 'p1', null);
    expect(await getPublishedProductBySlug(c.env.DB, 'acme')).toBeNull();
  });

  it('go with the account', async () => {
    const c = ctx();
    await seedStripe(c, 'stripe-1');
    await insertProduct(c.env.DB, { id: 'p1', userId: c.userId, now: NOW, ...FIELDS }, ['stripe-1']);
    c.t.exec('DELETE FROM users WHERE id = ?', c.userId);
    expect(c.t.rows('SELECT * FROM public_products')).toEqual([]);
    expect(c.t.rows('SELECT * FROM public_product_connections')).toEqual([]);
  });
});
