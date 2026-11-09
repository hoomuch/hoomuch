/**
 * Public pages (SPEC F-21): the switch and the rules for what an owner types. Owner: Lead.
 * Pure, so the share page in the browser can use the same rules as the server.
 */

import type { Bindings } from '../env';
import { DAY, dayKey, HOUR } from './time';

/** Public pages are on only where the instance says so (`PUBLIC_PAGES=true`); off by default. */
export function publicPagesEnabled(env: Pick<Bindings, 'PUBLIC_PAGES'> | undefined): boolean {
  return env?.PUBLIC_PAGES?.trim() === 'true';
}

/** Products one account can have. */
export const MAX_PRODUCTS = 10;

/** A public page and its badge say "not updated" once its oldest connection's last sync is older than this. */
export const STALE_AFTER_MS = 72 * HOUR;

const SLUG_MIN = 3;
export const SLUG_MAX = 40;
export const NAME_MAX = 60;
export const TAGLINE_MAX = 120;
export const WEBSITE_MAX = 200;

/** Lowercase letters and digits, hyphens inside: `acme`, `acme-app-2`. */
const SLUG_PATTERN = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const SLUG_RE = new RegExp(`^${SLUG_PATTERN}$`);

export function isValidSlug(slug: string): boolean {
  return slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && SLUG_RE.test(slug) && !slug.includes('--');
}

/**
 * A slug suggested from a product name: "Acme Notes!" → "acme-notes". Letters outside a–z lose
 * their accents where they have one ("Çiçek" → "cicek"), everything else becomes a hyphen. May
 * still be too short; isValidSlug says.
 */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

/** What the owner typed for a slug, lowercased and trimmed; no other changes, so a typo shows as invalid. */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * The owner's website as an https URL without credentials, or null if it isn't one. A bare
 * "acme.com" gets https:// in front.
 */
export function normalizeWebsite(input: string): string | null {
  const raw = input.trim();
  if (raw === '' || raw.length > WEBSITE_MAX) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
  const out = url.toString();
  return out.length > WEBSITE_MAX ? null : out;
}

/** The most a store link may be as typed (its canonical form is shorter). */
export const STORE_LINK_MAX = 300;

/**
 * An App Store listing as `https://apps.apple.com/app/id<number>`, from any form a person pastes:
 * a country or app name in the path (`apps.apple.com/tr/app/weigho/id123`), the old
 * itunes.apple.com host, or `id123` alone. Null for anything else.
 */
export function normalizeAppStoreUrl(input: string): string | null {
  const raw = input.trim();
  if (raw === '' || raw.length > STORE_LINK_MAX) return null;
  const bare = /^id(\d{5,12})$/i.exec(raw);
  if (bare) return `https://apps.apple.com/app/id${bare[1]}`;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !/^(apps|itunes)\.apple\.com$/i.test(url.hostname)) return null;
  const id = /\/id(\d{5,12})(?:\/|$)/.exec(url.pathname)?.[1];
  return id ? `https://apps.apple.com/app/id${id}` : null;
}

/** An Android package name, e.g. com.acme.notes: two or more dotted parts, each starting with a letter. */
const PACKAGE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/i;

/**
 * A Google Play listing as `https://play.google.com/store/apps/details?id=<package>`, from the
 * listing's address (any extra query, such as `hl`, is dropped) or the package name alone.
 */
export function normalizePlayStoreUrl(input: string): string | null {
  const raw = input.trim();
  if (raw === '' || raw.length > STORE_LINK_MAX) return null;
  let pkg: string | null = null;
  // nosemgrep: detect-redos -- raw is at most STORE_LINK_MAX long, and PACKAGE_RE's parts are split by a dot none of them matches
  if (PACKAGE_RE.test(raw) && !raw.toLowerCase().startsWith('play.google.com')) {
    pkg = raw;
  } else {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'play.google.com') return null;
    if (url.pathname.replace(/\/$/, '') !== '/store/apps/details') return null;
    pkg = url.searchParams.get('id');
  }
  // nosemgrep: detect-redos -- pkg is at most 150 long, and PACKAGE_RE's parts are split by a dot none of them matches
  return pkg && pkg.length <= 150 && PACKAGE_RE.test(pkg) ? `https://play.google.com/store/apps/details?id=${pkg}` : null;
}

/** The App Store listing's id, from its canonical link (to look its icon up). */
export function appStoreId(url: string | null): string | null {
  return url ? (/\/id(\d{5,12})$/.exec(url)?.[1] ?? null) : null;
}

// ---------- profiles (SPEC F-22) ----------

export const HANDLE_MAX = 30;
export const DISPLAY_NAME_MAX = 60;
export const BIO_MAX = 160;

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/** Handles nobody gets: they'd pass for hoomuch itself. */
const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'api', 'app', 'billing', 'help', 'hoomuch', 'mod', 'moderator', 'official',
  'root', 'security', 'staff', 'support', 'system', 'team', 'www',
]);

export function isValidHandle(handle: string): boolean {
  return handle.length >= 3 && handle.length <= HANDLE_MAX && HANDLE_RE.test(handle) && !RESERVED_HANDLES.has(handle);
}

/**
 * An X (Twitter) username from what the owner typed: "@acme", "acme" or an x.com / twitter.com
 * profile URL. Null when it isn't one (1 to 15 letters, digits or underscores).
 */
export function normalizeXHandle(input: string): string | null {
  let v = input.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(v);
  if (url) v = url[1]!;
  v = v.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(v) ? v : null;
}

/**
 * Whether a connection's figures can count on a public page: never the demo data, never a
 * test-mode key (Stripe `sk_test_`, Paddle sandbox…), whose money isn't real.
 */
export function countsPublicly(provider: string, testMode: boolean): boolean {
  return provider !== 'demo' && !testMode;
}

// ---------- Explore (SPEC F-23) ----------

/** Revenue history a product needs before Explore lists it, so a fresh account can't fake its way in. */
export const EXPLORE_MIN_HISTORY_DAYS = 30;
/** Growth ranks only products at this MRR or more (USD cents): from $5, +900% means nothing. */
export const EXPLORE_GROWTH_MIN_MRR = 10_000;
/** Products Explore lists at most, per view. */
export const EXPLORE_LIMIT = 100;
/** The landing page shows its strip only once this many products qualify, and this many in it. */
export const EXPLORE_LANDING_MIN = 6;

/** Longest Explore search kept; anything past it is cut. */
export const EXPLORE_QUERY_MAX = 60;

export type ExploreSort = 'mrr' | 'growth' | 'new';

export function parseExploreSort(v: string | undefined | null): ExploreSort {
  return v === 'growth' || v === 'new' ? v : 'mrr';
}

/**
 * Whether search engines may index a public page: only once its figures go back as far as
 * Explore asks (EXPLORE_MIN_HISTORY_DAYS of revenue history), and never while the operator has it
 * off Explore. Until then it's public and shareable, but worth nothing to someone publishing a page
 * for its links or words: they'd need a payment account with a month of real revenue first.
 */
export function searchIndexable(historyFrom: string | null, hidden: boolean, now: number): boolean {
  return !hidden && historyFrom !== null && historyFrom <= dayKey(now - EXPLORE_MIN_HISTORY_DAYS * DAY);
}
