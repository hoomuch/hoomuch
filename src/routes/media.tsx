/**
 * Founders' photos and products' logos (SPEC F-21/F-22). Owner: Experience (routes).
 *
 * The owner's side (under /share, signed in) uploads, removes, or asks for the website's icon, each a
 * plain POST form (Post/Redirect/Get; an upload is multipart). The visitor's side, /media/<key>,
 * serves the bytes from R2 without the visitor's session (src/index.tsx skips it, as for /p/),
 * same-origin so the CSP's img-src 'self' covers it, and forever cacheable: a key never changes what
 * it holds. Without the MEDIA binding, or with public pages off, every path here is a 404.
 */

import type { Context, Hono, Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../env';
import { getProduct, setAvatar } from '../db/public';
import { allowMediaChange, currentUser, requireUser } from '../lib/auth';
import { redirectWithFlash } from '../lib/flash';
import { cleanImage, CONTENT_TYPES, mediaKeyType, UPLOAD_MAX_BYTES, UPLOAD_TYPES, type ImageInfo } from '../lib/media';
import { deleteImages, mediaEnabled, putImage, refreshSiteIcon, replaceLogo } from '../services/media';
import { formLimit, isUuid } from './util';

const enabled = async (c: Context<AppEnv>, next: Next) => (mediaEnabled(c.env) ? next() : c.notFound());

const PROFILE_FORM = '/share/profile';
const productForm = (id: string) => `/share/products/${id}/edit`;

const TOO_BIG = `That image is over ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB. Pick a smaller one.`;
const NOT_AN_IMAGE = 'Use a PNG, JPEG, WebP or GIF image, at most 4096 pixels a side.';
const NO_FILE = 'Choose an image first.';
const SLOW_DOWN = 'That’s a lot of changes at once. Try again in a few minutes.';

/** Images change for a day before a browser asks again: long enough to spare requests, short enough that a removed photo goes. */
const MEDIA_MAX_AGE = 86_400;

/** An upload's body: the image and a little room for the multipart framing. Too big goes back with a note. */
const uploadLimit = bodyLimit({
  maxSize: UPLOAD_MAX_BYTES + 64 * 1024,
  onError: (c) => {
    const id = /^\/share\/products\/([^/]+)\//.exec(c.req.path)?.[1];
    return redirectWithFlash(c as Context<AppEnv>, isUuid(id) ? productForm(id) : PROFILE_FORM, 'error', TOO_BIG);
  },
});

/** The uploaded image under `field`, checked: its bytes and what they are, or why it was turned away. */
async function readUpload(
  c: Context<AppEnv>,
  field: string,
): Promise<{ ok: true; bytes: Uint8Array; info: ImageInfo } | { ok: false; error: string }> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return { ok: false, error: NO_FILE };
  }
  const file = body[field];
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: NO_FILE };
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, error: TOO_BIG };
  // Stored as cleaned: no camera or location metadata, nothing after the image's end.
  const image = cleanImage(new Uint8Array(await file.arrayBuffer()));
  if (!image || !UPLOAD_TYPES.includes(image.info.type)) return { ok: false, error: NOT_AN_IMAGE };
  return { ok: true, ...image };
}

export function registerMediaRoutes(app: Hono<AppEnv>): void {
  // ---------- the visitor's side ----------

  app.get('/media/:file', enabled, async (c) => {
    const key = c.req.param('file') ?? '';
    const type = mediaKeyType(key);
    const object = type ? await c.env.MEDIA!.get(key) : null;
    if (!type || !object) return c.notFound();
    return new Response(object.body, {
      headers: {
        // The type our key says, never one sniffed or sent: the bytes were checked as this on the way in.
        'Content-Type': CONTENT_TYPES[type],
        // nosniff, and a CSP of default-src 'none' and sandbox, come from src/index.tsx (mediaHeaders).
        'Cache-Control': `public, max-age=${MEDIA_MAX_AGE}, immutable`,
        ETag: object.httpEtag,
      },
    });
  });

  // ---------- the owner's photo ----------

  app.post('/share/profile/photo', enabled, requireUser, uploadLimit, async (c) => {
    const user = currentUser(c);
    const upload = await readUpload(c, 'photo');
    if (!upload.ok) return redirectWithFlash(c, PROFILE_FORM, 'error', upload.error);
    if (!(await allowMediaChange(c.env, user.id))) return redirectWithFlash(c, PROFILE_FORM, 'error', SLOW_DOWN);
    const key = await putImage(c.env.MEDIA!, upload.bytes, upload.info);
    const old = await setAvatar(c.env.DB, user.id, key, Date.now());
    if (old === 'no-profile') {
      await deleteImages(c.env, [key]);
      return redirectWithFlash(c, PROFILE_FORM, 'error', 'Save your profile first, then add a photo.');
    }
    await deleteImages(c.env, [old]);
    return redirectWithFlash(c, PROFILE_FORM, 'success', 'Your photo is updated.');
  });

  app.post('/share/profile/photo/delete', enabled, requireUser, formLimit, async (c) => {
    const old = await setAvatar(c.env.DB, currentUser(c).id, null, Date.now());
    if (old !== 'no-profile') await deleteImages(c.env, [old]);
    return redirectWithFlash(c, PROFILE_FORM, 'success', 'Photo removed. Your initials show instead.');
  });

  // ---------- a product's logo ----------

  app.post('/share/products/:id/logo', enabled, requireUser, uploadLimit, async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    if (!isUuid(id) || !(await getProduct(c.env.DB, user.id, id))) return c.notFound();
    const upload = await readUpload(c, 'logo');
    if (!upload.ok) return redirectWithFlash(c, productForm(id), 'error', upload.error);
    if (!(await allowMediaChange(c.env, user.id))) return redirectWithFlash(c, productForm(id), 'error', SLOW_DOWN);
    const key = await putImage(c.env.MEDIA!, upload.bytes, upload.info);
    if (!(await replaceLogo(c.env, user.id, id, key, 'upload'))) return c.notFound();
    return redirectWithFlash(c, productForm(id), 'success', 'Logo updated.');
  });

  app.post('/share/products/:id/logo/site', enabled, requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const product = isUuid(id) ? await getProduct(c.env.DB, user.id, id) : null;
    if (!product) return c.notFound();
    const back = productForm(product.id);
    if (!product.website) return redirectWithFlash(c, back, 'error', 'Add the product’s website first.');
    if (!(await allowMediaChange(c.env, user.id))) return redirectWithFlash(c, back, 'error', SLOW_DOWN);
    const result = await refreshSiteIcon(c.env, user.id, product.id, new URL(c.req.url).origin, { replaceUpload: true });
    return result === 'set'
      ? redirectWithFlash(c, back, 'success', 'Now showing your website’s icon.')
      : redirectWithFlash(c, back, 'error', 'Your website has no icon hoomuch can use, so the logo stays as it was.');
  });

  app.post('/share/products/:id/logo/delete', enabled, requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    if (!isUuid(id) || !(await replaceLogo(c.env, user.id, id, null, null))) return c.notFound();
    return redirectWithFlash(c, productForm(id), 'success', 'Logo removed. The initials show instead.');
  });
}
