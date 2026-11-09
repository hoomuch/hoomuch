/**
 * Founders' photos and products' logos (SPEC F-21/F-22): storing them in R2, removing them, and
 * fetching a product website's icon. Owner: Experience (services).
 *
 * Everything here is a no-op without the MEDIA binding (mediaEnabled), and the pages fall back to
 * initials. Images are written under a fresh random key each time, so a URL never changes what it
 * shows and can be cached for good; the old object is deleted once the row points elsewhere.
 */

import type { Bindings } from '../env';
import { getProduct, setLogo, type LogoSource } from '../db/public';
import { publicPagesEnabled } from '../lib/public-pages';
import {
  cleanImage,
  CONTENT_TYPES,
  ICON_MAX_BYTES,
  ICON_MIN_SIDE,
  iconCandidates,
  isFetchableUrl,
  mediaKeyType,
  newMediaKey,
  UPLOAD_MAX_BYTES,
  UPLOAD_TYPES,
  type ImageInfo,
} from '../lib/media';

/** Photos and logos are on: public pages are, and there's a bucket for them. */
export function mediaEnabled(env: Bindings): env is Bindings & { MEDIA: R2Bucket } {
  return publicPagesEnabled(env) && env.MEDIA !== undefined;
}

export const NO_FILE = 'Choose an image first.';
export const TOO_BIG = `That image is over ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB. Pick a smaller one.`;
const NOT_AN_IMAGE = 'Use a PNG, JPEG, WebP or GIF image, at most 4096 pixels a side.';

export type CheckedUpload = { ok: true; bytes: Uint8Array; info: ImageInfo } | { ok: false; error: string };

/**
 * An uploaded file, checked: its cleaned bytes (no camera or location metadata, nothing after the
 * image's end) and what they are, or why it was turned away. Only what an upload may be (no ICO).
 */
export async function checkUpload(file: unknown): Promise<CheckedUpload> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: NO_FILE };
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, error: TOO_BIG };
  const image = cleanImage(new Uint8Array(await file.arrayBuffer()));
  if (!image || !UPLOAD_TYPES.includes(image.info.type)) return { ok: false, error: NOT_AN_IMAGE };
  return { ok: true, ...image };
}

/** Stores an image cleanImage returned (lib/media.ts) under a fresh key and returns the key. */
export async function putImage(bucket: R2Bucket, bytes: Uint8Array, info: ImageInfo): Promise<string> {
  const key = newMediaKey(info.type);
  await bucket.put(key, bytes, { httpMetadata: { contentType: CONTENT_TYPES[info.type] } });
  return key;
}

/** Removes stored images; null and anything that isn't one of our keys is skipped. Never throws. */
export async function deleteImages(env: Bindings, keys: ReadonlyArray<string | null | undefined>): Promise<void> {
  const ours = keys.filter((k): k is string => typeof k === 'string' && mediaKeyType(k) !== null);
  if (!env.MEDIA || ours.length === 0) return;
  try {
    await env.MEDIA.delete(ours);
  } catch {
    // An object left behind costs a few bytes; the row no longer points at it. Nothing to show anyone.
  }
}

/** How long all of an icon lookup may take, page and icons together. */
const ICON_BUDGET_MS = 5000;
/** How much of a page is read for its <link> tags (they're in the head). */
const PAGE_MAX_BYTES = 64 * 1024;
/** Icon addresses tried at most, best first. */
const ICON_TRIES = 4;
/**
 * Redirects followed per address. With ICON_TRIES, a lookup makes at most 5 × 4 = 20 subrequests,
 * well under a Worker's limit.
 */
const MAX_HOPS = 3;

/**
 * GET with redirects followed by hand: every address, the first and each Location, has to be one
 * hoomuch may fetch (isFetchableUrl) before it's requested, so a public site can't bounce the
 * request to a private one. Null when one isn't, or there are too many hops; else the response and
 * the address it came from.
 */
async function fetchChecked(fetcher: typeof fetch, url: string, init: RequestInit): Promise<{ res: Response; url: string } | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!isFetchableUrl(current)) return null;
    const res = await fetcher(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return { res, url: current };
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    if (!location) return null;
    try {
      current = new URL(location, current).href;
    } catch {
      return null;
    }
  }
  return null;
}

/** Up to `max` bytes of a body; null when it's longer and `whole` is set (an icon must be complete). */
async function readCapped(res: Response, max: number, whole: boolean): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      if (whole) return null;
      parts.push(value.subarray(0, value.byteLength - (size - max)));
      size = max;
      break;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * The best icon a website offers, as checked image bytes; null when it has none hoomuch can use
 * (none at all, only SVG, too small, too big, not an image, or the site is slow or down).
 */
async function fetchSiteIcon(
  website: string,
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; info: ImageInfo } | null> {
  if (!isFetchableUrl(website)) return null;
  const signal = AbortSignal.timeout(ICON_BUDGET_MS);
  const headers = { 'user-agent': `Mozilla/5.0 (compatible; hoomuch; +${origin})` };
  let candidates: string[];
  try {
    const page = await fetchChecked(fetcher, website, { signal, headers: { ...headers, accept: 'text/html' } });
    if (!page) return null; // sent somewhere hoomuch doesn't go
    const html = page.res.ok ? new TextDecoder().decode((await readCapped(page.res, PAGE_MAX_BYTES, false)) ?? new Uint8Array()) : '';
    if (!page.res.ok) await page.res.body?.cancel().catch(() => undefined);
    candidates = iconCandidates(html, page.url);
  } catch {
    // The page didn't answer in time: the icons every browser tries can still be there.
    candidates = iconCandidates('', website);
  }
  for (const url of candidates.slice(0, ICON_TRIES)) {
    if (signal.aborted) return null;
    try {
      const got = await fetchChecked(fetcher, url, { signal, headers: { ...headers, accept: 'image/*' } });
      if (!got) continue;
      if (!got.res.ok) {
        await got.res.body?.cancel().catch(() => undefined);
        continue;
      }
      const bytes = await readCapped(got.res, ICON_MAX_BYTES, true);
      const icon = bytes ? cleanImage(bytes) : null;
      if (icon && Math.min(icon.info.width, icon.info.height) >= ICON_MIN_SIDE) return icon;
    } catch {
      // This one failed; the next may not.
    }
  }
  return null;
}

/**
 * Gives a product its website's icon. An owner's own logo stays unless `replaceUpload` (they asked
 * for the site's icon instead). When there's no usable icon, the product keeps what it has, except
 * an icon fetched from a website it no longer has (`websiteChanged`).
 */
export async function refreshSiteIcon(
  env: Bindings,
  userId: string,
  productId: string,
  origin: string,
  opts: { websiteChanged?: boolean; replaceUpload?: boolean } = {},
  fetcher?: typeof fetch,
): Promise<'set' | 'none' | 'skipped'> {
  if (!mediaEnabled(env)) return 'skipped';
  const product = await getProduct(env.DB, userId, productId);
  if (!product || (product.logo_source === 'upload' && !opts.replaceUpload)) return 'skipped';
  const icon = product.website ? await fetchSiteIcon(product.website, origin, fetcher) : null;
  // The lookup takes a moment: a logo uploaded in the meantime wins (keepUpload), whatever was read above.
  const keepUpload = !opts.replaceUpload;
  if (!icon) {
    if (opts.websiteChanged && product.logo_source === 'site') await replaceLogo(env, userId, productId, null, null, { keepUpload });
    return 'none';
  }
  const key = await putImage(env.MEDIA, icon.bytes, icon.info);
  return (await replaceLogo(env, userId, productId, key, 'site', { keepUpload })) ? 'set' : 'skipped';
}

/**
 * Points the product at a new logo (or none) and deletes the one it had. With `keepUpload`, an
 * uploaded logo stays and the new key is deleted instead. False when nothing changed.
 */
export async function replaceLogo(
  env: Bindings,
  userId: string,
  productId: string,
  key: string | null,
  source: LogoSource | null,
  opts: { keepUpload?: boolean } = {},
): Promise<boolean> {
  const old = await setLogo(env.DB, userId, productId, key, source, opts.keepUpload ?? false);
  if (old === 'not-found') {
    await deleteImages(env, [key]);
    return false;
  }
  if (old !== key) await deleteImages(env, [old]);
  return true;
}
