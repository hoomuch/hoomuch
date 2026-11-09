/**
 * Public pages (SPEC F-21). Owner: Experience (routes).
 *
 * The owner's side (/share) is like Settings: signed in, plain POST forms, Post/Redirect/Get.
 * The visitor's side (/p/<slug>, /badge/<slug>.svg) reads one stored row and renders without the
 * visitor's session (src/index.tsx skips it on these paths), so the response can be cached by
 * anyone. With PUBLIC_PAGES off, every one of these paths is the ordinary 404.
 */

import type { Context, Hono, Next } from 'hono';
import { getExplore } from '../data/explore';
import { parsePublicStats, PUBLIC_METRICS, PUBLIC_RANGES, publicFigures, type PublicMetric, type PublicRange } from '../data/types';
import { listConnections, type ConnectionView } from '../db/queries';
import {
  deleteProduct,
  getProduct,
  getProfile,
  getPublishedProductBySlug,
  getPublishedProfileByHandle,
  insertProduct,
  listProducts,
  saveProfile,
  setListed,
  setPublished,
  exploreBlocker,
  updateProduct,
  type ProductFields,
  type ProfileFields,
} from '../db/public';
import type { AppEnv } from '../env';
import { allowMediaChange, currentUser, requireUser, signupAllowed } from '../lib/auth';
import { randomId } from '../lib/crypto';
import { verificationRequired } from '../lib/email-verification';
import { redirectWithFlash } from '../lib/flash';
import {
  BIO_MAX,
  countsPublicly,
  DISPLAY_NAME_MAX,
  HANDLE_MAX,
  isValidHandle,
  isValidSlug,
  MAX_PRODUCTS,
  NAME_MAX,
  normalizeAppStoreUrl,
  normalizePlayStoreUrl,
  normalizeSlug,
  normalizeWebsite,
  normalizeXHandle,
  EXPLORE_QUERY_MAX,
  parseExploreSort,
  publicPagesEnabled,
  SLUG_MAX,
  STORE_LINK_MAX,
  slugFromName,
  STALE_AFTER_MS,
  TAGLINE_MAX,
  WEBSITE_MAX,
} from '../lib/public-pages';
import { legalOperator } from '../lib/legal';
import { mediaUrl } from '../lib/media';
import { checkUpload, deleteImages, mediaEnabled, putImage, refreshSiteIcon, replaceLogo } from '../services/media';
import { uploadLimit } from './media';
import { refreshProductStats } from '../services/public-pages';
import { isProviderId } from '../providers/types';
import { badgeSvg } from '../views/badge';
import { productMarkdown } from '../views/markdown';
import type { ProfileFormErrors, ProfileFormValues, ShareFormErrors, ShareFormValues, SharePageProps, ShareView } from '../views/pages/share';
import { renderPage } from '../views/render';
import { chrome, formLimit, readForm, type AppContext, type FormFields } from './util';

/** Paths served without the visitor's session (src/index.tsx); /media/ is routes/media.tsx. */
export const PUBLIC_PATH = /^\/(?:(?:p|u|badge|media)\/|explore(?:\.json)?$|sitemap\.xml$)/;

/** How long a browser may keep a public page or badge (an unpublish shows within this). */
const PAGE_MAX_AGE = 300;
const BADGE_MAX_AGE = 600;
/** The link preview image, in public/. */
const OG_IMAGE = '/og/verified.png';

const enabled = async (c: Context<AppEnv>, next: Next) => (publicPagesEnabled(c.env) ? next() : c.notFound());

const SLUG_ERROR = 'Use 3 to 40 lowercase letters, digits and single hyphens, like acme-notes.';

export function registerPublicRoutes(app: Hono<AppEnv>): void {
  // ---------- the owner's side ----------

  app.get('/share', enabled, requireUser, (c) => renderShare(c));
  app.get('/share/profile', enabled, requireUser, (c) => renderShare(c, { view: { kind: 'profile' } }));
  app.get('/share/new', enabled, requireUser, (c) => renderShare(c, { view: { kind: 'new' } }));
  app.get('/share/products/:id', enabled, requireUser, async (c) => {
    const product = await getProduct(c.env.DB, currentUser(c).id, c.req.param('id'));
    if (!product) return c.notFound();
    return renderShare(c, { view: { kind: 'product', id: product.id } });
  });
  app.get('/share/products/:id/edit', enabled, requireUser, async (c) => {
    const product = await getProduct(c.env.DB, currentUser(c).id, c.req.param('id'));
    if (!product) return c.notFound();
    return renderShare(c, { view: { kind: 'edit', id: product.id } });
  });

  // The new-product form may carry a logo (multipart), so its body can be an image's size.
  app.post('/share/products', enabled, requireUser, uploadLimit, async (c) => {
    const user = currentUser(c);
    const conns = await listConnections(c.env.DB, user.id);
    const { links } = await listProducts(c.env.DB, user.id);
    const form = await readForm(c);
    const input = readProduct(form, conns, links, null);
    // A chosen logo is checked with the rest: a bad one saves nothing, like any other field.
    const file = mediaEnabled(c.env) ? form.file('logo') : null;
    const logo = file ? await checkUpload(file) : null;
    if (logo && !logo.ok) input.errors.logo = logo.error;
    const fromNew = (form: SharePageProps['form']) => renderShare(c, { view: { kind: 'new' }, form, status: 422 });
    if (!input.fields || input.errors.logo) {
      return fromNew({ productId: null, values: input.values, fieldErrors: input.errors, error: FIX_BELOW });
    }
    const id = randomId();
    const saved = await insertProduct(c.env.DB, { id, userId: user.id, now: Date.now(), ...input.fields }, input.values.connections);
    if (saved === 'limit') return redirectWithFlash(c, '/share', 'error', `You already have ${MAX_PRODUCTS} products, the most one account can have.`);
    if (saved === 'slug-taken') return fromNew({ productId: null, values: input.values, fieldErrors: { slug: SLUG_TAKEN }, error: FIX_BELOW });
    await refreshProductStats(c.env, id);
    let note = '';
    const iconSource = input.fields.website || input.fields.appStoreUrl;
    if (mediaEnabled(c.env) && (logo?.ok || iconSource) && !(await allowMediaChange(c.env, user.id))) {
      note = logo?.ok ? ' The logo wasn’t saved: that’s a lot of changes at once. Add it from Edit in a few minutes.' : '';
    } else if (logo?.ok && mediaEnabled(c.env)) {
      // The owner's own logo, so the website's icon isn't fetched.
      try {
        await replaceLogo(c.env, user.id, id, await putImage(c.env.MEDIA, logo.bytes, logo.info), 'upload');
      } catch {
        note = ' The logo wasn’t saved. Add it from Edit.';
      }
    } else if (iconSource) {
      // Its website's or App Store listing's icon as its logo, when there's one (and the instance keeps images).
      await refreshSiteIcon(c.env, user.id, id, new URL(c.req.url).origin, { websiteChanged: true });
    }
    return redirectWithFlash(c, `/share/products/${id}`, 'success', `Saved ${input.fields.name}. Publish it when you’re ready.${note}`);
  });

  app.post('/share/products/:id', enabled, requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const product = await getProduct(c.env.DB, user.id, id);
    if (!product) return c.notFound();
    const conns = await listConnections(c.env.DB, user.id);
    const { links } = await listProducts(c.env.DB, user.id);
    const input = readProduct(await readForm(c), conns, links, id);
    const failed = (form: SharePageProps['form']) => renderShare(c, { view: { kind: 'edit', id }, form, status: 422 });
    if (!input.fields) return failed({ productId: id, values: input.values, fieldErrors: input.errors, error: FIX_BELOW });
    const saved = await updateProduct(c.env.DB, user.id, id, input.fields, input.values.connections, Date.now());
    if (saved === 'not-found') return c.notFound();
    if (saved === 'slug-taken') return failed({ productId: id, values: input.values, fieldErrors: { slug: SLUG_TAKEN }, error: FIX_BELOW });
    await refreshProductStats(c.env, id);
    // A new website or App Store listing brings its icon (an uploaded logo stays); the old one's icon
    // goes with it. Over the account's limit on lookups (lib/auth.ts allowMediaChange), the save
    // still goes through.
    const sourceChanged = product.website !== input.fields.website || product.app_store_url !== input.fields.appStoreUrl;
    if (sourceChanged && mediaEnabled(c.env) && (await allowMediaChange(c.env, user.id))) {
      await refreshSiteIcon(c.env, user.id, id, new URL(c.req.url).origin, { websiteChanged: true });
    }
    const moved = product.published_at !== null && product.slug !== input.fields.slug;
    return redirectWithFlash(
      c,
      `/share/products/${id}`,
      'success',
      moved ? 'Saved. The page moved to its new address, so update any badge you embedded.' : 'Saved.',
    );
  });

  app.post('/share/products/:id/publish', enabled, requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const product = await getProduct(c.env.DB, user.id, id);
    if (!product) return c.notFound();
    const form = await readForm(c);
    const back = `/share/products/${id}`;
    if (form.text('confirm', 8) !== 'yes') {
      return redirectWithFlash(c, back, 'error', 'Tick the box to confirm these figures can be public, then publish.');
    }
    // A public product always says who makes it (SPEC F-22).
    if (!(await getProfile(c.env.DB, user.id))) {
      return redirectWithFlash(c, '/share/profile', 'error', 'Set up your founder profile first: a public page says who makes the product.');
    }
    // Fresh figures first: a page never goes up with stale or missing ones.
    await refreshProductStats(c.env, id);
    const fresh = await getProduct(c.env.DB, user.id, id);
    if (!fresh || !parsePublicStats(fresh.stats)) {
      return redirectWithFlash(c, back, 'error', 'Nothing to show yet. Pick a connection that has finished a sync, then publish.');
    }
    // The Explore box is ticked by default; unticked, the page and badge are public but unlisted.
    const listed = form.text('listed', 8) === 'yes';
    await setPublished(c.env.DB, user.id, id, Date.now(), listed);
    return redirectWithFlash(
      c,
      back,
      'success',
      `Published. ${product.name} is public at /p/${product.slug}${listed ? ' and listed on Explore' : ''}.`,
    );
  });

  app.post('/share/products/:id/unpublish', enabled, requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const product = await getProduct(c.env.DB, user.id, c.req.param('id'));
    if (!product || !(await setPublished(c.env.DB, user.id, product.id, null))) return c.notFound();
    return redirectWithFlash(c, `/share/products/${product.id}`, 'success', `Unpublished. The page and badge for ${product.name} are down.`);
  });

  app.post('/share/products/:id/listing', enabled, requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const product = await getProduct(c.env.DB, user.id, c.req.param('id'));
    if (!product) return c.notFound();
    const listed = (await readForm(c)).text('listed', 8) === 'yes';
    await setListed(c.env.DB, user.id, product.id, listed);
    return redirectWithFlash(
      c,
      `/share/products/${product.id}`,
      'success',
      listed ? `${product.name} is listed on Explore.` : `${product.name} is off Explore. Its page and badge stay public.`,
    );
  });

  app.post('/share/products/:id/delete', enabled, requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const product = await getProduct(c.env.DB, user.id, c.req.param('id'));
    const deleted = product ? await deleteProduct(c.env.DB, user.id, product.id) : null;
    if (!product || !deleted) return c.notFound();
    await deleteImages(c.env, [deleted.logo_key]);
    return redirectWithFlash(c, '/share', 'success', `Deleted ${product.name}. Its page and badge are down.`);
  });

  app.post('/share/profile', enabled, requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const input = readProfile(await readForm(c));
    const view = { kind: 'profile' } as const;
    if (!input.fields) return renderShare(c, { view, profileForm: { values: input.values, fieldErrors: input.errors, error: FIX_BELOW }, status: 422 });
    if ((await saveProfile(c.env.DB, user.id, input.fields, Date.now())) === 'handle-taken') {
      return renderShare(c, {
        view,
        profileForm: { values: input.values, fieldErrors: { handle: 'That handle is taken. Try another.' }, error: FIX_BELOW },
        status: 422,
      });
    }
    return redirectWithFlash(c, '/share', 'success', 'Saved your founder profile.');
  });

  // ---------- the visitor's side ----------

  app.get('/explore', enabled, async (c) => {
    const data = await getExplore(c.env.DB, exploreOptions(c));
    const origin = new URL(c.req.url).origin;
    c.header('Cache-Control', `public, max-age=${PAGE_MAX_AGE}`);
    return renderPage(c, 'explore', {
      data,
      url: `${origin}/explore`,
      image: `${origin}${OG_IMAGE}`,
      signupOpen: signupAllowed(c.env),
      ...(legalOperator(c.env) ? { legal: true } : {}),
    });
  });

  // The same view as data: the page searches as you type and swaps its list in place.
  app.get('/explore.json', enabled, async (c) => {
    const data = await getExplore(c.env.DB, exploreOptions(c));
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(data);
  });

  // Every page on Explore and its founder's, for search engines (submit it in their webmaster tools).
  app.get('/sitemap.xml', enabled, async (c) => {
    const origin = new URL(c.req.url).origin;
    const [products, founders] = await Promise.all([
      getExplore(c.env.DB, { tab: 'products', sort: 'new', provider: null }),
      getExplore(c.env.DB, { tab: 'founders', sort: 'mrr', provider: null }),
    ]);
    const paths = ['/', '/explore', ...products.items.map((i) => `/p/${i.slug}`), ...founders.founders.map((f) => `/u/${f.handle}`)];
    // Slugs and handles are [a-z0-9_-] (lib/public-pages.ts): nothing in a path needs escaping.
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      paths.map((p) => `  <url><loc>${origin}${p}</loc></url>\n`).join('') +
      '</urlset>\n';
    return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  });

  app.get('/u/:handle', enabled, async (c) => {
    const handle = (c.req.param('handle') ?? '').toLowerCase();
    if (!isValidHandle(handle)) return c.notFound();
    const found = await getPublishedProfileByHandle(c.env.DB, handle);
    const media = mediaEnabled(c.env);
    const products = (found?.products ?? []).flatMap((p) => {
      const stats = parsePublicStats(p.stats);
      return stats ? [{ slug: p.slug, name: p.name, tagline: p.tagline, logo: media ? mediaUrl(p.logo_key) : null, stats: publicFigures(stats) }] : [];
    });
    if (!found || products.length === 0) return c.notFound();
    const origin = new URL(c.req.url).origin;
    c.header('Cache-Control', `public, max-age=${PAGE_MAX_AGE}`);
    return renderPage(c, 'publicProfile', {
      profile: {
        handle: found.handle,
        displayName: found.display_name,
        bio: found.bio,
        website: found.website,
        xHandle: found.x_handle,
        avatar: media ? mediaUrl(found.avatar_key) : null,
      },
      products,
      url: `${origin}/u/${found.handle}`,
      image: `${origin}${OG_IMAGE}`,
      signupOpen: signupAllowed(c.env),
      ...(legalOperator(c.env) ? { legal: true } : {}),
    });
  });

  // The page, or `/p/<slug>.md`: the same figures as Markdown for AI assistants (views/markdown.ts).
  app.get('/p/:slug', enabled, async (c) => {
    const raw = c.req.param('slug') ?? '';
    const asMarkdown = raw.endsWith('.md');
    const slug = normalizeSlug(asMarkdown ? raw.slice(0, -3) : raw);
    if (!isValidSlug(slug)) return c.notFound();
    const row = await getPublishedProductBySlug(c.env.DB, slug);
    const stats = parsePublicStats(row?.stats);
    if (!row || !stats) return c.notFound();
    const origin = new URL(c.req.url).origin;
    const media = mediaEnabled(c.env);
    const product = {
      slug: row.slug,
      name: row.name,
      tagline: row.tagline,
      website: row.website,
      appStoreUrl: row.app_store_url,
      playStoreUrl: row.play_store_url,
      logo: media ? mediaUrl(row.logo_key) : null,
    };
    const owner =
      row.owner_handle && row.owner_name
        ? { handle: row.owner_handle, name: row.owner_name, x: row.owner_x, avatar: media ? mediaUrl(row.owner_avatar) : null }
        : null;
    c.header('Cache-Control', `public, max-age=${PAGE_MAX_AGE}`);
    if (asMarkdown) {
      return c.body(productMarkdown({ origin, product, owner, stats }), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    }
    const metric = c.req.query('chart');
    const range = c.req.query('range');
    return renderPage(c, 'publicProduct', {
      product,
      // The chart history stays out of the page: a visitor without an account sees the open view only.
      stats: publicFigures(stats),
      owner,
      url: `${origin}/p/${row.slug}`,
      image: `${origin}${OG_IMAGE}`,
      markdown: `${origin}/p/${row.slug}.md`,
      view: {
        metric: (PUBLIC_METRICS as readonly string[]).includes(metric ?? '') ? (metric as PublicMetric) : 'revenue',
        range: (PUBLIC_RANGES as readonly string[]).includes(range ?? '') ? (range as PublicRange) : '30d',
      },
      signupOpen: signupAllowed(c.env),
      ...(legalOperator(c.env) ? { legal: true } : {}),
    });
  });

  /**
   * The chart history behind a public page's locked views, for any signed-in account: the lock is
   * how a visitor becomes one. Not under /p/, so the session is read; private to the browser.
   */
  app.get('/api/p/:slug/history', enabled, async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'sign-in' }, 401);
    if (c.get('emailUnverified') && verificationRequired(c.env)) return c.json({ error: 'verify' }, 401);
    const slug = normalizeSlug(c.req.param('slug') ?? '');
    const row = isValidSlug(slug) ? await getPublishedProductBySlug(c.env.DB, slug) : null;
    const stats = parsePublicStats(row?.stats);
    if (!stats) return c.json({ error: 'not-found' }, 404);
    c.header('Cache-Control', 'private, max-age=300');
    return c.json(stats.history);
  });

  app.get('/badge/:file', enabled, async (c) => {
    const m = /^([a-z0-9-]+)\.svg$/.exec((c.req.param('file') ?? '').toLowerCase());
    const slug = m?.[1] ?? '';
    const row = isValidSlug(slug) ? await getPublishedProductBySlug(c.env.DB, slug) : null;
    const stats = parsePublicStats(row?.stats);
    const now = Date.now();
    const state = !stats ? 'missing' : stats.syncedAt === null || now - stats.syncedAt > STALE_AFTER_MS ? 'stale' : 'verified';
    return c.body(badgeSvg(state, stats?.mrr.value ?? null), stats ? 200 : 404, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // A missing badge may be published in a minute: don't keep the "not found" one long.
      'Cache-Control': `public, max-age=${stats ? BADGE_MAX_AGE : 60}`,
    });
  });
}

/** An Explore view from its URL (?tab, ?sort, ?provider, ?q), whatever is in it. */
function exploreOptions(c: Context<AppEnv>) {
  const provider = c.req.query('provider');
  const q = (c.req.query('q') ?? '').trim().slice(0, EXPLORE_QUERY_MAX);
  return {
    media: mediaEnabled(c.env),
    tab: c.req.query('tab') === 'founders' ? ('founders' as const) : ('products' as const),
    sort: parseExploreSort(c.req.query('sort')),
    provider: provider && isProviderId(provider) && provider !== 'demo' ? provider : null,
    q: q || null,
  };
}

const FIX_BELOW = 'Nothing was saved. See the fields below.';
const SLUG_TAKEN = 'That address is taken. Try another.';

/** The owner's product form, read and checked. `fields` is set only when everything is valid. */
function readProduct(
  form: FormFields,
  conns: readonly ConnectionView[],
  links: ReadonlyArray<{ connection_id: string; product_id: string }>,
  productId: string | null,
): { values: ShareFormValues; errors: ShareFormErrors; fields?: ProductFields } {
  const name = form.text('name', NAME_MAX);
  const slugInput = form.text('slug', SLUG_MAX + 20);
  const tagline = form.text('tagline', TAGLINE_MAX);
  const websiteInput = form.text('website', WEBSITE_MAX + 20);
  const appStoreInput = form.text('app_store', STORE_LINK_MAX);
  const playStoreInput = form.text('play_store', STORE_LINK_MAX);
  const eligible = new Set(conns.filter((c) => countsPublicly(c.provider, c.test_mode === 1)).map((c) => c.id));
  const picked = [...new Set(form.all('connections', 64, 25))].filter((id) => eligible.has(id));
  const values: ShareFormValues = {
    name,
    slug: slugInput,
    tagline,
    website: websiteInput,
    appStore: appStoreInput,
    playStore: playStoreInput,
    connections: picked,
  };

  const errors: ShareFormErrors = {};
  if (!name) errors.name = 'Give the product a name.';
  const slug = slugInput ? normalizeSlug(slugInput) : slugFromName(name);
  if (!isValidSlug(slug)) errors.slug = slugInput ? SLUG_ERROR : `The name doesn’t make an address. ${SLUG_ERROR}`;
  const website = websiteInput ? normalizeWebsite(websiteInput) : null;
  if (websiteInput && !website) errors.website = 'Enter an https address, like https://acme.com.';
  const appStoreUrl = appStoreInput ? normalizeAppStoreUrl(appStoreInput) : null;
  if (appStoreInput && !appStoreUrl) errors.appStore = 'Paste the app’s App Store link, like https://apps.apple.com/app/id1234567890.';
  const playStoreUrl = playStoreInput ? normalizePlayStoreUrl(playStoreInput) : null;
  if (playStoreInput && !playStoreUrl) {
    errors.playStore = 'Paste the app’s Google Play link, like https://play.google.com/store/apps/details?id=com.acme.app.';
  }
  const taken = links.find((l) => picked.includes(l.connection_id) && l.product_id !== productId);
  if (picked.length === 0) errors.connections = 'Pick at least one connection.';
  else if (taken) {
    const conn = conns.find((c) => c.id === taken.connection_id);
    errors.connections = `${conn?.name ?? 'A connection'} is already in another product. A connection counts in one product only.`;
  }
  if (Object.keys(errors).length > 0) return { values, errors };
  return { values, errors, fields: { slug, name, tagline: tagline || null, website, appStoreUrl, playStoreUrl } };
}

/** The owner's profile form, read and checked. `fields` is set only when everything is valid. */
function readProfile(form: FormFields): { values: ProfileFormValues; errors: ProfileFormErrors; fields?: ProfileFields } {
  const values: ProfileFormValues = {
    handle: form.text('handle', HANDLE_MAX + 20),
    displayName: form.text('display_name', DISPLAY_NAME_MAX),
    bio: form.text('bio', BIO_MAX),
    website: form.text('website', WEBSITE_MAX + 20),
    xHandle: form.text('x_handle', 120),
  };
  const errors: ProfileFormErrors = {};
  const handle = values.handle.toLowerCase().replace(/^@/, '');
  if (!isValidHandle(handle)) errors.handle = 'Use 3 to 30 lowercase letters, digits, hyphens or underscores. Some names are reserved.';
  if (!values.displayName) errors.displayName = 'Add the name to show.';
  const website = values.website ? normalizeWebsite(values.website) : null;
  if (values.website && !website) errors.website = 'Enter an https address, like https://acme.com.';
  const xHandle = values.xHandle ? normalizeXHandle(values.xHandle) : null;
  if (values.xHandle && !xHandle) errors.xHandle = 'Enter your X username, like @acme.';
  if (Object.keys(errors).length > 0) return { values, errors };
  return { values, errors, fields: { handle, displayName: values.displayName, bio: values.bio || null, website, xHandle } };
}

async function renderShare(
  c: AppContext,
  opts: { view?: ShareView; form?: SharePageProps['form']; profileForm?: SharePageProps['profileForm']; status?: 422 } = {},
): Promise<Response> {
  const { view, form, profileForm, status } = opts;
  const user = currentUser(c);
  const [conns, { products, links }, profile] = await Promise.all([
    listConnections(c.env.DB, user.id),
    listProducts(c.env.DB, user.id),
    getProfile(c.env.DB, user.id),
  ]);
  const productOf = new Map(links.map((l) => [l.connection_id, l.product_id]));
  const linked = new Map<string, string[]>();
  for (const l of links) linked.set(l.product_id, [...(linked.get(l.product_id) ?? []), l.connection_id]);
  const eligible = conns.filter((x) => countsPublicly(x.provider, x.test_mode === 1));
  const now = Date.now();
  const media = mediaEnabled(c.env);
  const image = (key: string | null) => (media ? mediaUrl(key) : null);
  return renderPage(
    c,
    'share',
    {
      view,
      chrome: chrome(c),
      origin: new URL(c.req.url).origin,
      products: products.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        tagline: p.tagline,
        website: p.website,
        appStoreUrl: p.app_store_url,
        playStoreUrl: p.play_store_url,
        connectionIds: linked.get(p.id) ?? [],
        published: p.published_at !== null,
        mrr: parsePublicStats(p.stats)?.mrr.value ?? null,
        statsAt: p.stats_at,
        listed: p.listed === 1,
        publishedAt: p.published_at,
        explore: p.listed === 1 && p.published_at !== null ? exploreBlocker(p, now) : null,
        logo: image(p.logo_key),
        logoSource: media && p.logo_key ? p.logo_source : null,
      })),
      connections: eligible.map((x) => ({ id: x.id, name: x.name, provider: x.provider, productId: productOf.get(x.id) ?? null })),
      excluded: conns.filter((x) => !countsPublicly(x.provider, x.test_mode === 1)).map((x) => x.name),
      maxProducts: MAX_PRODUCTS,
      ...(media ? { media } : {}),
      form,
      profile: profile
        ? {
            handle: profile.handle,
            displayName: profile.display_name,
            bio: profile.bio,
            website: profile.website,
            xHandle: profile.x_handle,
            avatar: image(profile.avatar_key),
          }
        : null,
      profileForm,
    },
    status,
  );
}
