/**
 * Public pages' D1 queries (SPEC F-21). Owner: Lead.
 *
 * The owner's side is scoped by user_id like every other request-path query. The exceptions are
 * the public reads: a visitor reads a product by its slug (getPublishedProductBySlug) or a profile
 * by its handle (getPublishedProfileByHandle), and only once its owner has published it. The stats sync code writes (saveProductStats) are keyed by product id, like
 * sync/repo.ts.
 */

import type { PublicProductStats } from '../data/types';
import { DAY, dayKey } from '../lib/time';
import { EXPLORE_GROWTH_MIN_MRR, EXPLORE_MIN_HISTORY_DAYS, MAX_PRODUCTS, STALE_AFTER_MS, type ExploreSort } from '../lib/public-pages';

export interface PublicProductRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  tagline: string | null;
  website: string | null;
  /** The App Store and Google Play listings, canonical (migration 0015); null for none. */
  app_store_url: string | null;
  play_store_url: string | null;
  published_at: number | null;
  /** PublicProductStats JSON; parse with parsePublicStats. */
  stats: string | null;
  stats_at: number | null;
  /** 1 = the owner lists it on Explore (migration 0013). */
  listed: number;
  /** The operator took it off Explore. */
  hidden_at: number | null;
  mrr_usd: number | null;
  growth_pct: number | null;
  synced_at: number | null;
  history_from: string | null;
  /** The logo in R2 (migration 0014; lib/media.ts), and where it came from; null for none. */
  logo_key: string | null;
  logo_source: LogoSource | null;
  created_at: number;
  updated_at: number;
}

/** A logo fetched from the product's website, or uploaded by its owner. */
export type LogoSource = 'site' | 'upload';

/** What the owner types for a product. */
export interface ProductFields {
  slug: string;
  name: string;
  tagline: string | null;
  website: string | null;
  appStoreUrl: string | null;
  playStoreUrl: string | null;
}

export type SaveResult = 'ok' | 'not-found' | 'slug-taken' | 'limit';

const isSlugConflict = (err: unknown) => /UNIQUE constraint failed: public_products\.slug/i.test(String(err));

/** The user's products, oldest first, and which of their connections each one adds up. */
export async function listProducts(
  db: D1Database,
  userId: string,
): Promise<{ products: PublicProductRow[]; links: Array<{ connection_id: string; product_id: string }> }> {
  const [products, links] = await db.batch([
    db.prepare('SELECT * FROM public_products WHERE user_id = ? ORDER BY created_at ASC, id ASC').bind(userId),
    db
      .prepare(
        `SELECT l.connection_id, l.product_id FROM public_product_connections l
           JOIN public_products p ON p.id = l.product_id
          WHERE p.user_id = ?`,
      )
      .bind(userId),
  ]);
  return {
    products: (products?.results ?? []) as unknown as PublicProductRow[],
    links: (links?.results ?? []) as unknown as Array<{ connection_id: string; product_id: string }>,
  };
}

/**
 * Links the product to these of the user's connections, replacing its links: only connections that
 * count publicly (not demo, not test mode) and aren't in another product. The product must be the
 * user's; otherwise nothing changes.
 */
function linkStatements(db: D1Database, userId: string, productId: string, connectionIds: readonly string[]): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM public_product_connections
          WHERE product_id = ?1 AND EXISTS (SELECT 1 FROM public_products p WHERE p.id = ?1 AND p.user_id = ?2)`,
      )
      .bind(productId, userId),
    db
      .prepare(
        `INSERT INTO public_product_connections (connection_id, product_id)
         SELECT c.id, ?1 FROM connections c
          WHERE c.user_id = ?2 AND c.id IN (SELECT value FROM json_each(?3))
            AND c.provider != 'demo' AND c.test_mode = 0
            AND EXISTS (SELECT 1 FROM public_products p WHERE p.id = ?1 AND p.user_id = ?2)
         ON CONFLICT (connection_id) DO NOTHING`,
      )
      .bind(productId, userId, JSON.stringify(connectionIds)),
  ];
}

/**
 * A new product with its connections, in one batch. 'limit' when the user already has
 * MAX_PRODUCTS (checked atomically, like the connection cap), 'slug-taken' when another product
 * has the slug.
 */
export async function insertProduct(
  db: D1Database,
  p: { id: string; userId: string; now: number } & ProductFields,
  connectionIds: readonly string[],
): Promise<SaveResult> {
  let inserted: D1Result | undefined;
  try {
    [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO public_products (id, user_id, slug, name, tagline, website, app_store_url, play_store_url, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?9, ?10, ?7, ?7
            WHERE (SELECT COUNT(*) FROM public_products WHERE user_id = ?2) < ?8`,
        )
        .bind(p.id, p.userId, p.slug, p.name, p.tagline, p.website, p.now, MAX_PRODUCTS, p.appStoreUrl, p.playStoreUrl),
      ...linkStatements(db, p.userId, p.id, connectionIds),
    ]);
  } catch (err) {
    if (isSlugConflict(err)) return 'slug-taken';
    throw err;
  }
  return (inserted?.meta.changes ?? 0) > 0 ? 'ok' : 'limit';
}

/** The owner's edit: fields and connections together, in one batch (a taken slug changes nothing). */
export async function updateProduct(
  db: D1Database,
  userId: string,
  id: string,
  fields: ProductFields,
  connectionIds: readonly string[],
  now: number,
): Promise<SaveResult> {
  let updated: D1Result | undefined;
  try {
    [updated] = await db.batch([
      db
        .prepare(
          `UPDATE public_products SET slug = ?, name = ?, tagline = ?, website = ?, app_store_url = ?, play_store_url = ?, updated_at = ?
            WHERE id = ? AND user_id = ?`,
        )
        .bind(fields.slug, fields.name, fields.tagline, fields.website, fields.appStoreUrl, fields.playStoreUrl, now, id, userId),
      ...linkStatements(db, userId, id, connectionIds),
    ]);
  } catch (err) {
    if (isSlugConflict(err)) return 'slug-taken';
    throw err;
  }
  return (updated?.meta.changes ?? 0) > 0 ? 'ok' : 'not-found';
}

export function getProduct(db: D1Database, userId: string, id: string): Promise<PublicProductRow | null> {
  return db.prepare('SELECT * FROM public_products WHERE id = ? AND user_id = ?').bind(id, userId).first<PublicProductRow>();
}

/**
 * Publishes (now) or unpublishes (null) the user's product; publishing also records whether it's
 * listed on Explore. False when it isn't theirs.
 */
export async function setPublished(
  db: D1Database,
  userId: string,
  id: string,
  publishedAt: number | null,
  listed?: boolean,
): Promise<boolean> {
  const r = await db
    .prepare('UPDATE public_products SET published_at = ?, listed = COALESCE(?, listed), updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(publishedAt, listed === undefined ? null : listed ? 1 : 0, Date.now(), id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** The owner's choice to list the product on Explore. False when it isn't theirs. */
export async function setListed(db: D1Database, userId: string, id: string, listed: boolean): Promise<boolean> {
  const r = await db
    .prepare('UPDATE public_products SET listed = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(listed ? 1 : 0, Date.now(), id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Deletes the user's product; null when it isn't theirs, else the logo it had (read in the same statement, to delete from R2). */
export function deleteProduct(db: D1Database, userId: string, id: string): Promise<{ logo_key: string | null } | null> {
  return db.prepare('DELETE FROM public_products WHERE id = ? AND user_id = ? RETURNING logo_key').bind(id, userId).first<{ logo_key: string | null }>();
}

// ---------- stats (sync side: keyed by product, no user context) ----------

/** What working out a product's stats needs: its owner, the owner's zone and its connections. */
export async function productForStats(
  db: D1Database,
  productId: string,
): Promise<{ userId: string; timeZone: string; published: boolean; connectionIds: string[] } | null> {
  const row = await db
    .prepare(
      `SELECT p.user_id, u.timezone, p.published_at,
              (SELECT json_group_array(l.connection_id) FROM public_product_connections l WHERE l.product_id = p.id) AS connection_ids
         FROM public_products p JOIN users u ON u.id = p.user_id
        WHERE p.id = ?`,
    )
    .bind(productId)
    .first<{ user_id: string; timezone: string; published_at: number | null; connection_ids: string }>();
  if (!row) return null;
  return {
    userId: row.user_id,
    timeZone: row.timezone,
    published: row.published_at !== null,
    connectionIds: JSON.parse(row.connection_ids) as string[],
  };
}

/** The product a connection is in, if any. */
export async function productOfConnection(db: D1Database, connectionId: string): Promise<string | null> {
  return db.prepare('SELECT product_id FROM public_product_connections WHERE connection_id = ?').bind(connectionId).first<string>('product_id');
}

/** Stores the figures, and the copies of them Explore sorts and filters on (migration 0013). */
export async function saveProductStats(db: D1Database, productId: string, stats: PublicProductStats | null, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE public_products SET stats = ?, stats_at = ?, mrr_usd = ?, growth_pct = ?, synced_at = ?, history_from = ?
        WHERE id = ?`,
    )
    .bind(
      stats ? JSON.stringify(stats) : null,
      now,
      stats?.mrr.value ?? null,
      stats?.mrr.deltaPct ?? null,
      stats?.syncedAt ?? null,
      stats ? (stats.revenueSince ?? stats.since) : null,
      productId,
    )
    .run();
}

// ---------- profiles (SPEC F-22) ----------

export interface PublicProfileRow {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  website: string | null;
  x_handle: string | null;
  /** The photo in R2 (migration 0014; lib/media.ts); null for none. */
  avatar_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProfileFields {
  handle: string;
  displayName: string;
  bio: string | null;
  website: string | null;
  xHandle: string | null;
}

const isHandleConflict = (err: unknown) => /UNIQUE constraint failed: public_profiles\.handle/i.test(String(err));

export function getProfile(db: D1Database, userId: string): Promise<PublicProfileRow | null> {
  return db.prepare('SELECT * FROM public_profiles WHERE user_id = ?').bind(userId).first<PublicProfileRow>();
}

/** Creates or updates the user's profile; 'handle-taken' when another account has the handle. */
export async function saveProfile(db: D1Database, userId: string, f: ProfileFields, now: number): Promise<'ok' | 'handle-taken'> {
  try {
    await db
      .prepare(
        `INSERT INTO public_profiles (user_id, handle, display_name, bio, website, x_handle, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT (user_id) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name,
           bio = excluded.bio, website = excluded.website, x_handle = excluded.x_handle, updated_at = excluded.updated_at`,
      )
      .bind(userId, f.handle, f.displayName, f.bio, f.website, f.xHandle, now)
      .run();
  } catch (err) {
    if (isHandleConflict(err)) return 'handle-taken';
    throw err;
  }
  return 'ok';
}

// ---------- photos and logos (lib/media.ts) ----------

/**
 * Points the user's profile at a photo (or none) and returns the key it had, to delete; 'no-profile'
 * when they haven't saved one. One batch: the read sees the row as it was before the write.
 */
export async function setAvatar(db: D1Database, userId: string, key: string | null, now: number): Promise<string | null | 'no-profile'> {
  const [before, updated] = await db.batch([
    db.prepare('SELECT avatar_key FROM public_profiles WHERE user_id = ?').bind(userId),
    db.prepare('UPDATE public_profiles SET avatar_key = ?, updated_at = ? WHERE user_id = ?').bind(key, now, userId),
  ]);
  if ((updated?.meta.changes ?? 0) === 0) return 'no-profile';
  return (before?.results?.[0] as { avatar_key: string | null } | undefined)?.avatar_key ?? null;
}

/**
 * Points the user's product at a logo (or none) and returns the key it had; 'not-found' when it isn't
 * theirs, or when `keepUpload` is set and the owner's own logo is there (checked in the same write,
 * so a logo uploaded while a website icon was being fetched isn't replaced).
 */
export async function setLogo(
  db: D1Database,
  userId: string,
  id: string,
  key: string | null,
  source: LogoSource | null,
  keepUpload = false,
): Promise<string | null | 'not-found'> {
  const [before, updated] = await db.batch([
    db.prepare('SELECT logo_key FROM public_products WHERE id = ? AND user_id = ?').bind(id, userId),
    db
      .prepare(
        `UPDATE public_products SET logo_key = ?1, logo_source = ?2, updated_at = ?3
          WHERE id = ?4 AND user_id = ?5 AND (?6 = 0 OR logo_source IS NULL OR logo_source <> 'upload')`,
      )
      .bind(key, key === null ? null : source, Date.now(), id, userId, keepUpload ? 1 : 0),
  ]);
  if ((updated?.meta.changes ?? 0) === 0) return 'not-found';
  return (before?.results?.[0] as { logo_key: string | null } | undefined)?.logo_key ?? null;
}

/** Every image the user has stored: their photo and their products' logos (to delete with the account). */
export async function mediaKeysOfUser(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT avatar_key AS k FROM public_profiles WHERE user_id = ?1 AND avatar_key IS NOT NULL
       UNION ALL
       SELECT logo_key FROM public_products WHERE user_id = ?1 AND logo_key IS NOT NULL`,
    )
    .bind(userId)
    .all<{ k: string }>();
  return results.map((r) => r.k);
}

// ---------- the public reads ----------

/** What a visitor's page and badge read: one row, only for a published product with stats. */
export interface PublishedProduct {
  slug: string;
  name: string;
  tagline: string | null;
  website: string | null;
  stats: string;
  /** The founder (public_profiles): every published product has one, but read it as optional. */
  owner_handle: string | null;
  owner_name: string | null;
  owner_x: string | null;
  logo_key: string | null;
  owner_avatar: string | null;
  app_store_url: string | null;
  play_store_url: string | null;
}

export function getPublishedProductBySlug(db: D1Database, slug: string): Promise<PublishedProduct | null> {
  return db
    .prepare(
      `SELECT p.slug, p.name, p.tagline, p.website, p.app_store_url, p.play_store_url, p.stats, p.logo_key,
              f.handle AS owner_handle, f.display_name AS owner_name, f.x_handle AS owner_x, f.avatar_key AS owner_avatar
         FROM public_products p
         LEFT JOIN public_profiles f ON f.user_id = p.user_id
        WHERE p.slug = ? AND p.published_at IS NOT NULL AND p.stats IS NOT NULL`,
    )
    .bind(slug)
    .first<PublishedProduct>();
}

export interface PublishedProfile {
  handle: string;
  display_name: string;
  bio: string | null;
  website: string | null;
  x_handle: string | null;
  avatar_key: string | null;
  /** The owner's published products with figures, oldest first. */
  products: Array<{ slug: string; name: string; tagline: string | null; stats: string; logo_key: string | null }>;
}

/** A profile and its published products, in one round trip; null when it has none (then it isn't public). */
export async function getPublishedProfileByHandle(db: D1Database, handle: string): Promise<PublishedProfile | null> {
  const [profile, products] = await db.batch([
    db
      .prepare('SELECT handle, display_name, bio, website, x_handle, avatar_key FROM public_profiles WHERE handle = ?')
      .bind(handle),
    db
      .prepare(
        `SELECT p.slug, p.name, p.tagline, p.stats, p.logo_key FROM public_profiles f
           JOIN public_products p ON p.user_id = f.user_id
          WHERE f.handle = ? AND p.published_at IS NOT NULL AND p.stats IS NOT NULL
          ORDER BY p.created_at ASC, p.id ASC`,
      )
      .bind(handle),
  ]);
  const row = profile?.results?.[0] as Omit<PublishedProfile, 'products'> | undefined;
  const list = (products?.results ?? []) as unknown as PublishedProfile['products'];
  return row && list.length > 0 ? { ...row, products: list } : null;
}

// ---------- Explore (SPEC F-23) ----------

/**
 * What puts a published product on Explore, as SQL over `public_products p`: its owner lists it,
 * the operator hasn't hidden it, it has MRR, a sync in the last 72 hours, and revenue history
 * going back EXPLORE_MIN_HISTORY_DAYS. Binds ?1 (oldest sync allowed) and ?2 (latest first day).
 */
const ON_EXPLORE = `p.published_at IS NOT NULL AND p.listed = 1 AND p.hidden_at IS NULL AND p.stats IS NOT NULL
  AND p.mrr_usd > 0 AND p.synced_at >= ?1 AND p.history_from <= ?2`;

function exploreBinds(now: number): [number, string] {
  return [now - STALE_AFTER_MS, dayKey(now - EXPLORE_MIN_HISTORY_DAYS * DAY)];
}

/** Why a product the owner lists isn't on Explore, or null when it is (shown on the Share page). */
export function exploreBlocker(p: PublicProductRow, now: number): 'hidden' | 'history' | 'stale' | 'no-mrr' | null {
  if (p.hidden_at !== null) return 'hidden';
  if (!p.history_from || p.history_from > exploreBinds(now)[1]) return 'history';
  if (p.synced_at === null || p.synced_at < exploreBinds(now)[0]) return 'stale';
  if (!p.mrr_usd || p.mrr_usd <= 0) return 'no-mrr';
  return null;
}

export interface ExploreRow {
  slug: string;
  name: string;
  tagline: string | null;
  stats: string;
  published_at: number;
  owner_handle: string;
  owner_name: string;
  logo_key: string | null;
  owner_avatar: string | null;
}

export interface ExploreFounderRow {
  handle: string;
  display_name: string;
  avatar_key: string | null;
  products: number;
  mrr: number;
}

const ORDER: Record<ExploreSort, string> = {
  mrr: 'p.mrr_usd DESC, p.slug ASC',
  growth: 'p.growth_pct DESC, p.mrr_usd DESC, p.slug ASC',
  new: 'p.published_at DESC, p.slug ASC',
};

/** A LIKE pattern matching `q` anywhere, with its own %, _ and backslash taken literally (ESCAPE backslash). */
function likeAnywhere(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Collects a statement's binds after ON_EXPLORE's two and the LIMIT (?1–?3): each condition adds
 * its value and gets its ?N, so a statement binds exactly the parameters it uses.
 */
function binder(now: number, limit: number) {
  const binds: Array<string | number> = [...exploreBinds(now), limit];
  return { binds, add: (v: string | number) => `?${binds.push(v)}` };
}

/**
 * Explore's products, in one statement (for a batch). Growth ranks only products with a change and
 * $100+ MRR; `q` matches the name, the tagline or the founder's name or handle (case-insensitive).
 */
export function exploreProductsStatement(
  db: D1Database,
  opts: { sort: ExploreSort; provider: string | null; q?: string | null; now: number; limit: number },
): D1PreparedStatement {
  const b = binder(opts.now, opts.limit);
  const where = [ON_EXPLORE];
  if (opts.sort === 'growth') where.push(`p.growth_pct IS NOT NULL AND p.mrr_usd >= ${b.add(EXPLORE_GROWTH_MIN_MRR)}`);
  if (opts.provider) where.push(`EXISTS (SELECT 1 FROM json_each(p.stats, '$.providers') j WHERE j.value = ${b.add(opts.provider)})`);
  if (opts.q) {
    const like = b.add(likeAnywhere(opts.q));
    where.push(
      `(p.name LIKE ${like} ESCAPE '\\' OR p.tagline LIKE ${like} ESCAPE '\\' OR f.display_name LIKE ${like} ESCAPE '\\' OR f.handle LIKE ${like} ESCAPE '\\')`,
    );
  }
  return db
    .prepare(
      `SELECT p.slug, p.name, p.tagline, p.stats, p.published_at, p.logo_key,
              f.handle AS owner_handle, f.display_name AS owner_name, f.avatar_key AS owner_avatar
         FROM public_products p JOIN public_profiles f ON f.user_id = p.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${ORDER[opts.sort]}
        LIMIT ?3`,
    )
    .bind(...b.binds);
}

/** Explore's founders: each one's products on Explore, added up, biggest MRR first; `q` matches name or handle. */
export function exploreFoundersStatement(db: D1Database, opts: { q?: string | null; now: number; limit: number }): D1PreparedStatement {
  const b = binder(opts.now, opts.limit);
  const where = [ON_EXPLORE];
  if (opts.q) {
    const like = b.add(likeAnywhere(opts.q));
    where.push(`(f.display_name LIKE ${like} ESCAPE '\\' OR f.handle LIKE ${like} ESCAPE '\\')`);
  }
  return db
    .prepare(
      `SELECT f.handle, f.display_name, f.avatar_key, COUNT(*) AS products, SUM(p.mrr_usd) AS mrr
         FROM public_products p JOIN public_profiles f ON f.user_id = p.user_id
        WHERE ${where.join(' AND ')}
        GROUP BY f.user_id
        ORDER BY mrr DESC, f.handle ASC
        LIMIT ?3`,
    )
    .bind(...b.binds);
}

/** The providers behind the products on Explore (its filter), and how many products there are. */
export function exploreFacetsStatement(db: D1Database, now: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT j.value AS provider, COUNT(*) AS products
         FROM public_products p JOIN public_profiles f ON f.user_id = p.user_id, json_each(p.stats, '$.providers') j
        WHERE ${ON_EXPLORE}
        GROUP BY j.value`,
    )
    .bind(...exploreBinds(now));
}

/** How many products are on Explore (the landing page shows its strip from EXPLORE_LANDING_MIN). */
export function exploreCountStatement(db: D1Database, now: number): D1PreparedStatement {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM public_products p JOIN public_profiles f ON f.user_id = p.user_id WHERE ${ON_EXPLORE}`)
    .bind(...exploreBinds(now));
}
