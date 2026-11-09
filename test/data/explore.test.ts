import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExplore, getLandingGallery } from '../../src/data/explore';
import type { PublicProductStats } from '../../src/data/types';
import { DAY, HOUR, dayKey } from '../../src/lib/time';
import { createTestD1, seedUser, type TestD1 } from '../fixtures/d1';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
let t: TestD1;
let n = 0;

function stats(mrr: number, providers: string[], deltaPct: number | null = 10): PublicProductStats {
  const kpi = (value: number) => ({ value, previous: null, deltaPct: null });
  return {
    v: 1,
    currency: 'USD',
    mrr: { value: mrr, previous: null, deltaPct },
    activeSubscriptions: kpi(10),
    revenue: kpi(mrr),
    history: { today: dayKey(NOW), revenueDaily: [], revenueWeekly: [], revenueMonthly: [], mrrDaily: [], mrrMonthly: [] },
    revenueTotal: mrr * 3,
    revenueSince: dayKey(NOW - 90 * DAY),
    providers: providers as PublicProductStats['providers'],
    since: dayKey(NOW - 90 * DAY),
    syncedAt: NOW - HOUR,
    estimated: false,
    revenuePartial: false,
    missingFx: [],
    computedAt: NOW,
  };
}

/** A product row as the stats write leaves it, on Explore unless an override says otherwise. */
function product(
  userId: string,
  slug: string,
  o: {
    mrr?: number;
    growth?: number | null;
    providers?: string[];
    listed?: boolean;
    hidden?: boolean;
    published?: number | null;
    syncedAt?: number;
    historyFrom?: string;
  } = {},
) {
  const mrr = o.mrr ?? 50_000;
  const s = stats(mrr, o.providers ?? ['stripe'], o.growth === undefined ? 10 : o.growth);
  t.exec(
    `INSERT INTO public_products (id, user_id, slug, name, published_at, stats, stats_at, listed, hidden_at, mrr_usd, growth_pct,
       synced_at, history_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    `p${++n}`,
    userId,
    slug,
    slug.toUpperCase(),
    o.published === undefined ? NOW - n * 1000 : o.published,
    JSON.stringify(s),
    NOW,
    o.listed === false ? 0 : 1,
    o.hidden ? NOW : null,
    mrr,
    s.mrr.deltaPct,
    o.syncedAt ?? NOW - HOUR,
    o.historyFrom ?? dayKey(NOW - 90 * DAY),
  );
}

function profile(userId: string, handle: string) {
  t.exec('INSERT INTO public_profiles (user_id, handle, display_name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)', userId, handle, handle.toUpperCase());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  n = 0;
  for (const u of ['u1', 'u2', 'u3']) {
    seedUser(t, { id: u });
    profile(u, `${u}-handle`);
  }
});
afterEach(() => vi.useRealTimers());

describe('getExplore', () => {
  it('lists only what its founder lists, the operator hasn’t hidden, with MRR, a recent sync and 30 days of history', async () => {
    product('u1', 'big', { mrr: 900_000 });
    product('u1', 'small', { mrr: 20_000 });
    product('u2', 'unlisted', { listed: false });
    product('u2', 'hidden', { hidden: true });
    product('u2', 'draft', { published: null });
    product('u2', 'stale', { syncedAt: NOW - 4 * DAY });
    product('u3', 'brand-new', { historyFrom: dayKey(NOW - 10 * DAY) });
    product('u3', 'no-mrr', { mrr: 0 });
    product('u3', 'just-thirty', { historyFrom: dayKey(NOW - 30 * DAY), mrr: 10 });

    const before = t.roundTrips();
    const data = await getExplore(t.db, { tab: 'products', sort: 'mrr', provider: null });
    expect(t.roundTrips() - before).toBe(1);
    expect(data.items.map((i) => i.slug)).toEqual(['big', 'small', 'just-thirty']);
    expect(data.items[0]).toMatchObject({ name: 'BIG', founder: { handle: 'u1-handle', name: 'U1-HANDLE' }, mrr: 900_000, growthPct: 10 });
  });

  it('orders by growth (at $100+ MRR, with a change) or by newest', async () => {
    product('u1', 'steady', { mrr: 500_000, growth: 2 });
    product('u1', 'rocket', { mrr: 20_000, growth: 80 });
    product('u2', 'tiny', { mrr: 9_000, growth: 900 });
    product('u2', 'unknown', { mrr: 50_000, growth: null });

    const growth = await getExplore(t.db, { tab: 'products', sort: 'growth', provider: null });
    expect(growth.items.map((i) => i.slug)).toEqual(['rocket', 'steady']);
    const newest = await getExplore(t.db, { tab: 'products', sort: 'new', provider: null });
    expect(newest.items.map((i) => i.slug)).toEqual(['steady', 'rocket', 'tiny', 'unknown']);
  });

  it('filters by provider, and offers the providers on Explore with their counts', async () => {
    product('u1', 'web', { providers: ['stripe'] });
    product('u1', 'both', { providers: ['stripe', 'revenuecat'] });
    product('u2', 'app', { providers: ['appstore'] });
    product('u2', 'off', { providers: ['paddle'], listed: false });

    const rc = await getExplore(t.db, { tab: 'products', sort: 'mrr', provider: 'revenuecat' });
    expect(rc.items.map((i) => i.slug)).toEqual(['both']);
    expect(rc.providers).toEqual([
      { id: 'stripe', products: 2 },
      { id: 'appstore', products: 1 },
      { id: 'revenuecat', products: 1 },
    ]);
  });

  it('adds each founder’s products on Explore up', async () => {
    product('u1', 'a', { mrr: 10_000 });
    product('u1', 'b', { mrr: 15_000 });
    product('u1', 'c', { mrr: 99_000, listed: false });
    product('u2', 'd', { mrr: 20_000 });

    const data = await getExplore(t.db, { tab: 'founders', sort: 'mrr', provider: null });
    expect(data.items).toEqual([]);
    expect(data.founders).toEqual([
      { handle: 'u1-handle', name: 'U1-HANDLE', avatar: null, products: 2, mrr: 25_000 },
      { handle: 'u2-handle', name: 'U2-HANDLE', avatar: null, products: 1, mrr: 20_000 },
    ]);
  });
});

describe('Explore search', () => {
  it('matches a product’s name, tagline or founder, case-insensitively, and takes % and _ literally', async () => {
    product('u1', 'notely');
    product('u2', 'inkwell');
    t.exec("UPDATE public_products SET tagline = 'Notes that sync' WHERE slug = 'inkwell'");
    product('u3', 'fifty-pct');
    t.exec("UPDATE public_products SET name = '50% Off' WHERE slug = 'fifty-pct'");
    const find = async (q: string, tab: 'products' | 'founders' = 'products') => {
      const d = await getExplore(t.db, { tab, sort: 'mrr', provider: null, q });
      return tab === 'products' ? d.items.map((i) => i.slug).sort() : d.founders.map((f) => f.handle);
    };
    expect(await find('NOTE')).toEqual(['inkwell', 'notely']); // a name and a tagline
    expect(await find('u2-hand')).toEqual(['inkwell']); // the founder's handle
    expect(await find('%')).toEqual(['fifty-pct']); // not "anything"
    expect(await find('_')).toEqual([]); // a literal underscore, which nothing has (as a wildcard it would match all)
    expect(await find('nothing-like-it')).toEqual([]);
    expect(await find('U1', 'founders')).toEqual(['u1-handle']);
  });

  it('narrows the other choices too', async () => {
    product('u1', 'web-notes', { providers: ['stripe'], growth: 20, mrr: 30_000 });
    product('u2', 'app-notes', { providers: ['appstore'], growth: 5, mrr: 30_000 });
    const d = await getExplore(t.db, { tab: 'products', sort: 'growth', provider: 'appstore', q: 'notes' });
    expect(d.items.map((i) => i.slug)).toEqual(['app-notes']);
    expect(d.q).toBe('notes');
  });
});

describe('getLandingGallery', () => {
  it('waits for six products, then shows the fastest growing, or the biggest when few have grown', async () => {
    for (let i = 0; i < 5; i++) product('u1', `p-${i}`, { mrr: 20_000 + i, growth: i < 3 ? 10 + i : -5 });
    expect(await getLandingGallery(t.db)).toBeNull();

    product('u2', 'p-5', { mrr: 30_000, growth: 40 });
    const g = await getLandingGallery(t.db);
    expect(g?.kind).toBe('growth');
    expect(g?.items.map((i) => i.slug)).toEqual(['p-5', 'p-2', 'p-1', 'p-0']);

    t.exec("UPDATE public_products SET growth_pct = -1, stats = json_set(stats, '$.mrr.deltaPct', -1)");
    const m = await getLandingGallery(t.db);
    expect(m?.kind).toBe('mrr');
    expect(m?.items).toHaveLength(6);
    expect(m?.items[0]?.slug).toBe('p-5');
  });
});
