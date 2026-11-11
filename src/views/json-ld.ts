/**
 * Structured data (schema.org JSON-LD) for the pages search engines index. Owner: Experience (pages).
 *
 * Pure builders over the props a page already has: no clock and no env, so the server and the
 * browser build the same object (the layout writes it into <head>, which hydrates like the rest).
 * Every value is one the page itself shows. Nothing is added for search engines alone: no ratings,
 * no reviews. The origin comes from the page's own URL, so a self-hosted copy describes itself and
 * never claims hoomuch.com.
 */

import type { PublicFigures } from '../data/types';
import { toMajor } from '../lib/money';
import type { PricePlan } from '../lib/product-details';

const NAME = 'hoomuch';
const SOURCE_URL = 'https://github.com/hoomuch/hoomuch';
const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

type Node = Record<string, unknown>;
/** A step on the way to a page: its name and its path (`/explore`). Home comes first on its own. */
export type Crumb = [name: string, path: string];

/** Leaves out empty values, so a missing optional field never shows up as null. */
function compact(o: Node): Node {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)),
  );
}

function graph(nodes: Array<Node | null>): Node {
  return { '@context': 'https://schema.org', '@graph': nodes.filter((n): n is Node => n !== null) };
}

const ref = (id: string) => ({ '@id': id });
const siteId = (origin: string) => `${origin}/#website`;
const organizationId = (origin: string) => `${origin}/#organization`;
const personId = (origin: string, handle: string) => `${origin}/u/${handle}#person`;
const absolute = (origin: string, path: string | null | undefined) => (path ? new URL(path, origin).toString() : null);
/** An epoch-ms instant as ISO 8601; formatting a given time, not reading the clock. */
const isoTime = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function breadcrumbs(origin: string, url: string, trail: Crumb[]): Node {
  return {
    '@type': 'BreadcrumbList',
    '@id': `${url}#breadcrumb`,
    itemListElement: [[NAME, '/'] as Crumb, ...trail].map(([name, path], i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name,
      item: `${origin}${path}`,
    })),
  };
}

/** The page node every non-home page has: what it is, where it sits, what it's about. */
function webPage(type: string, url: string, name: string, description: string | null, extra: Node = {}): Node {
  const origin = new URL(url).origin;
  return compact({
    '@type': type,
    '@id': `${url}#webpage`,
    url,
    name,
    description,
    inLanguage: 'en',
    isPartOf: ref(siteId(origin)),
    breadcrumb: ref(`${url}#breadcrumb`),
    ...extra,
  });
}

/**
 * The home page: who publishes the site, the site itself, and the app. `freeOffer` only where
 * anyone can sign up, like the pricing section it mirrors.
 */
export function homeJsonLd(p: { url: string; description: string; freeOffer: boolean }): Node {
  const origin = new URL(p.url).origin;
  return graph([
    {
      '@type': 'Organization',
      '@id': organizationId(origin),
      name: NAME,
      url: `${origin}/`,
      logo: `${origin}/icons/apple-touch-icon.png`,
      sameAs: [SOURCE_URL],
    },
    {
      '@type': 'WebSite',
      '@id': siteId(origin),
      url: `${origin}/`,
      name: NAME,
      inLanguage: 'en',
      publisher: ref(organizationId(origin)),
    },
    compact({
      '@type': 'WebApplication',
      '@id': `${origin}/#app`,
      name: NAME,
      url: `${origin}/`,
      description: p.description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      isAccessibleForFree: true,
      license: LICENSE_URL,
      publisher: ref(organizationId(origin)),
      offers: p.freeOffer ? { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Free under $1,000 MRR' } : null,
    }),
  ]);
}

/** A page of prose (integrations, guides, comparisons): the page and its trail. */
export function articleJsonLd(p: { url: string; title: string; description: string; trail: Crumb[] }): Node {
  const origin = new URL(p.url).origin;
  return graph([webPage('WebPage', p.url, p.title, p.description), breadcrumbs(origin, p.url, p.trail)]);
}

/** Explore's default view: the products, in the order the page lists them. */
export function exploreJsonLd(p: { url: string; title: string; description: string; items: Array<{ slug: string; name: string }> }): Node {
  const origin = new URL(p.url).origin;
  return graph([
    webPage('CollectionPage', p.url, p.title, p.description, { mainEntity: ref(`${p.url}#list`) }),
    {
      '@type': 'ItemList',
      '@id': `${p.url}#list`,
      itemListElement: p.items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, url: `${origin}/p/${it.slug}`, name: it.name })),
    },
    breadcrumbs(origin, p.url, [['Explore', '/explore']]),
  ]);
}

/** A plan's price as schema.org wants it: major units, as a string, in the plan's own currency. */
function offerOf(plan: PricePlan): Node {
  return { '@type': 'Offer', name: plan.name, price: String(toMajor(plan.price, plan.currency)), priceCurrency: plan.currency };
}

/** A public product page: the page, the product the owner describes, and its founder. */
export function productJsonLd(p: {
  url: string;
  title: string;
  description: string;
  product: {
    slug: string;
    name: string;
    tagline: string | null;
    website: string | null;
    appStoreUrl: string | null;
    playStoreUrl: string | null;
    logo: string | null;
    founded?: string | null;
    details?: { description: string | null; plans: PricePlan[] };
  };
  stats: Pick<PublicFigures, 'syncedAt'>;
  owner: { handle: string; name: string; x: string | null } | null;
}): Node {
  const origin = new URL(p.url).origin;
  const { product, owner } = p;
  const stores = [product.appStoreUrl ? 'iOS' : null, product.playStoreUrl ? 'Android' : null].filter((s): s is string => s !== null);
  const person = owner ? personId(origin, owner.handle) : null;
  return graph([
    webPage('WebPage', p.url, p.title, p.description, {
      about: ref(`${p.url}#product`),
      dateModified: isoTime(p.stats.syncedAt),
    }),
    breadcrumbs(origin, p.url, [
      ['Explore', '/explore'],
      [product.name, `/p/${product.slug}`],
    ]),
    compact({
      '@type': stores.length > 0 ? 'MobileApplication' : 'SoftwareApplication',
      '@id': `${p.url}#product`,
      name: product.name,
      description: product.details?.description ?? product.tagline,
      image: absolute(origin, product.logo),
      url: product.website ?? p.url,
      sameAs: [product.website, product.appStoreUrl, product.playStoreUrl].filter((u): u is string => !!u),
      operatingSystem: stores.join(', ') || null,
      dateCreated: product.founded ?? null,
      creator: person ? ref(person) : null,
      offers: (product.details?.plans ?? []).map(offerOf),
    }),
    owner && person
      ? compact({
          '@type': 'Person',
          '@id': person,
          name: owner.name,
          url: `${origin}/u/${owner.handle}`,
          sameAs: owner.x ? [`https://x.com/${owner.x}`] : null,
        })
      : null,
  ]);
}

/** A founder's page: the profile, the person, and the products they publish. */
export function profileJsonLd(p: {
  url: string;
  title: string;
  description: string;
  profile: { handle: string; displayName: string; bio: string | null; website: string | null; xHandle: string | null; avatar: string | null };
  products: Array<{ slug: string; name: string; stats: Pick<PublicFigures, 'syncedAt'> }>;
}): Node {
  const origin = new URL(p.url).origin;
  const person = personId(origin, p.profile.handle);
  const synced = p.products.map((x) => x.stats.syncedAt).filter((t): t is number => t !== null);
  return graph([
    webPage('ProfilePage', p.url, p.title, p.description, {
      mainEntity: ref(person),
      dateModified: synced.length > 0 ? isoTime(Math.max(...synced)) : null,
    }),
    breadcrumbs(origin, p.url, [[p.profile.displayName, `/u/${p.profile.handle}`]]),
    compact({
      '@type': 'Person',
      '@id': person,
      name: p.profile.displayName,
      alternateName: p.profile.handle,
      description: p.profile.bio,
      image: absolute(origin, p.profile.avatar),
      url: p.url,
      sameAs: [p.profile.website, p.profile.xHandle ? `https://x.com/${p.profile.xHandle}` : null].filter((u): u is string => !!u),
    }),
    {
      '@type': 'ItemList',
      '@id': `${p.url}#products`,
      name: `Products by ${p.profile.displayName}`,
      itemListElement: p.products.map((x, i) => ({ '@type': 'ListItem', position: i + 1, url: `${origin}/p/${x.slug}`, name: x.name })),
    },
  ]);
}
