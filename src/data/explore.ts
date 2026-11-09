/**
 * Explore read model (SPEC F-23): the published products and founders on /explore, and the landing
 * page's strip. Owner: Data Plane.
 *
 * Everything comes from `public_products` (the figures stored when a sync finished) and
 * `public_profiles`, one D1 round trip per call, never the dashboard's read models.
 */

import {
  exploreCountStatement,
  exploreFacetsStatement,
  exploreFoundersStatement,
  exploreProductsStatement,
  type ExploreFounderRow,
  type ExploreRow,
} from '../db/public';
import { mediaUrl } from '../lib/media';
import { EXPLORE_LANDING_MIN, EXPLORE_LIMIT, type ExploreSort } from '../lib/public-pages';
import { isProviderId, type ProviderId } from '../providers/types';
import { parsePublicStats, rowsOf } from './types';

/** A product on Explore, as its row and cards show it. Amounts in USD minor units. */
export interface ExploreItem {
  slug: string;
  name: string;
  tagline: string | null;
  /** The logo's URL (lib/media.ts), null for initials. */
  logo: string | null;
  founder: { handle: string; name: string; avatar: string | null };
  mrr: number;
  /** MRR against 30 days ago; null without a comparison. */
  growthPct: number | null;
  revenue30: number;
  providers: ProviderId[];
}

export interface ExploreFounder {
  handle: string;
  name: string;
  /** The photo's URL (lib/media.ts), null for initials. */
  avatar: string | null;
  products: number;
  mrr: number;
}

export type ExploreTab = 'products' | 'founders';

export interface ExploreData {
  tab: ExploreTab;
  sort: ExploreSort;
  /** The provider filter, or null for all. */
  provider: ProviderId | null;
  /** The search, or null for none. */
  q: string | null;
  /** Providers behind the products on Explore, with how many products each: the filter's choices. */
  providers: Array<{ id: ProviderId; products: number }>;
  items: ExploreItem[];
  founders: ExploreFounder[];
}

/** A stored image's URL, when this instance serves them (`media`: the MEDIA binding is there). */
const image = (key: string | null, media: boolean) => (media ? mediaUrl(key) : null);

function toItems(rows: readonly ExploreRow[], media: boolean): ExploreItem[] {
  return rows.flatMap((r) => {
    const stats = parsePublicStats(r.stats);
    if (!stats) return [];
    return [
      {
        slug: r.slug,
        name: r.name,
        tagline: r.tagline,
        logo: image(r.logo_key, media),
        founder: { handle: r.owner_handle, name: r.owner_name, avatar: image(r.owner_avatar, media) },
        mrr: stats.mrr.value,
        growthPct: stats.mrr.deltaPct,
        revenue30: stats.revenue.value,
        providers: stats.providers,
      },
    ];
  });
}

export async function getExplore(
  db: D1Database,
  opts: { tab: ExploreTab; sort: ExploreSort; provider: ProviderId | null; q?: string | null; now?: number; media?: boolean },
): Promise<ExploreData> {
  const now = opts.now ?? Date.now();
  const media = opts.media ?? false;
  const list =
    opts.tab === 'founders'
      ? exploreFoundersStatement(db, { q: opts.q, now, limit: EXPLORE_LIMIT })
      : exploreProductsStatement(db, { sort: opts.sort, provider: opts.provider, q: opts.q, now, limit: EXPLORE_LIMIT });
  const [listR, facetsR] = await db.batch([list, exploreFacetsStatement(db, now)]);
  const providers = rowsOf<{ provider: string; products: number }>(facetsR)
    .filter((f): f is { provider: ProviderId; products: number } => isProviderId(f.provider) && f.provider !== 'demo')
    .map((f) => ({ id: f.provider, products: f.products }))
    .sort((a, b) => b.products - a.products || a.id.localeCompare(b.id));
  return {
    tab: opts.tab,
    sort: opts.sort,
    provider: opts.provider,
    q: opts.q ?? null,
    providers,
    items: opts.tab === 'products' ? toItems(rowsOf<ExploreRow>(listR), media) : [],
    founders:
      opts.tab === 'founders'
        ? rowsOf<ExploreFounderRow>(listR).map((f) => ({
            handle: f.handle,
            name: f.display_name,
            avatar: image(f.avatar_key, media),
            products: f.products,
            mrr: f.mrr,
          }))
        : [],
  };
}

/**
 * The landing page's strip: the fastest growing products this month ($100+ MRR), or the biggest
 * when too few have grown; null until EXPLORE_LANDING_MIN products are on Explore, so the page
 * never shows a sparse gallery. One round trip.
 */
export async function getLandingGallery(
  db: D1Database,
  now: number = Date.now(),
  media = false,
): Promise<{ kind: 'growth' | 'mrr'; items: ExploreItem[] } | null> {
  const [countR, growthR, mrrR] = await db.batch([
    exploreCountStatement(db, now),
    exploreProductsStatement(db, { sort: 'growth', provider: null, now, limit: EXPLORE_LANDING_MIN }),
    exploreProductsStatement(db, { sort: 'mrr', provider: null, now, limit: EXPLORE_LANDING_MIN }),
  ]);
  const count = rowsOf<{ n: number }>(countR)[0]?.n ?? 0;
  if (count < EXPLORE_LANDING_MIN) return null;
  const growth = toItems(rowsOf<ExploreRow>(growthR), media).filter((i) => (i.growthPct ?? 0) > 0);
  return growth.length >= 3 ? { kind: 'growth', items: growth } : { kind: 'mrr', items: toItems(rowsOf<ExploreRow>(mrrR), media) };
}
