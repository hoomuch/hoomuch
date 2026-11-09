/**
 * Images on public pages (SPEC F-21/F-22): a founder's photo and a product's logo. Owner: Lead.
 *
 * The bytes live in R2 (the optional MEDIA binding) under a random key and are served from this
 * origin at /media/<key> (routes/media.ts), so the CSP's img-src 'self' covers them and no visitor
 * loads anything from elsewhere. Pure helpers only: what an image is, its key and URL, and which
 * icons a website's HTML offers.
 *
 * An image is only what its bytes say: PNG, JPEG, WebP or GIF from an upload, and ICO as well from a
 * website's icon. Never SVG, which can carry script. Width and height come from the file's header
 * and are capped, so a small file can't claim a giant canvas for every visitor's browser to decode.
 * Before it's stored, cleanImage takes out what a picture doesn't need to show (camera and location
 * metadata, text chunks, anything after its end) and checks what the header alone can't (frames
 * that fit the canvas, a frame count, an icon's images as small as it says).
 */

export type ImageType = 'png' | 'jpeg' | 'webp' | 'gif' | 'ico';

export const CONTENT_TYPES: Record<ImageType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
};

const EXTENSIONS: Record<ImageType, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', ico: 'ico' };
const TYPE_OF_EXTENSION: Record<string, ImageType> = { png: 'png', jpg: 'jpeg', webp: 'webp', gif: 'gif', ico: 'ico' };

/** An upload, as sent (a browser with JavaScript scales it down first, so it's far smaller). */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
/** A website's icon. */
export const ICON_MAX_BYTES = 256 * 1024;
/** The longest side an image may say it has. */
export const MAX_SIDE = 4096;
/** The smallest icon worth showing: below this a 40px tile is a blur. */
export const ICON_MIN_SIDE = 16;
/** Frames an animated image may have. */
export const MAX_FRAMES = 200;
/** The square a browser scales a photo or logo down to before uploading it. */
export const UPLOAD_SIDE = 400;
/** The types an upload may be; ICO only ever comes from a website. */
export const UPLOAD_TYPES: readonly ImageType[] = ['png', 'jpeg', 'webp', 'gif'];

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const i32le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24);
const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));

/** What the bytes are and how big they say they are; null for anything else, or out of bounds. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  const info = readHeader(b);
  if (!info) return null;
  const ok = info.width >= 1 && info.height >= 1 && info.width <= MAX_SIDE && info.height <= MAX_SIDE;
  return ok ? info : null;
}

function readHeader(b: Uint8Array): ImageInfo | null {
  if (b.length < 12) return null;
  // PNG: the signature, then IHDR first, its width and height big-endian.
  if (b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n')) {
    if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
    return { type: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  // GIF: the logical screen size, little-endian.
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return { type: 'gif', width: u16le(b, 6), height: u16le(b, 8) };
  // WebP: a RIFF container; the size sits in the first chunk, in one of three layouts.
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return readWebp(b);
  // JPEG: walk the segments to the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) return readJpeg(b);
  // ICO: a directory of images; the biggest one is the icon's size (0 means 256).
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return readIco(b);
  return null;
}

function readWebp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30) return null;
  if (ascii(b, 12, 'VP8 ')) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | ((b[24]! << 24) >>> 0);
    return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) return { type: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

/** Start-of-frame markers: C0–CF but C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding). */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function readJpeg(b: Uint8Array): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (isSof(marker)) return { type: 'jpeg', width: u16be(b, i + 7), height: u16be(b, i + 5) };
    if (marker === 0xda || marker === 0xd9) return null; // the scan, or the end, before any frame
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function readIco(b: Uint8Array): ImageInfo | null {
  const count = u16le(b, 4);
  if (count < 1 || count > 64 || b.length < 6 + 16 * count) return null;
  let width = 0;
  let height = 0;
  for (let n = 0; n < count; n++) {
    const at = 6 + 16 * n;
    width = Math.max(width, b[at] || 256);
    height = Math.max(height, b[at + 1] || 256);
  }
  return { type: 'ico', width, height };
}

// ---------- cleaning ----------

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * The image as it will be stored: only the parts that draw it, ending where it ends. Null when it
 * doesn't hold together (a chunk running past the end, a frame outside the canvas, no end at all).
 * Whatever came after the image is gone, so the stored file is a picture and nothing else.
 */
export function cleanImage(b: Uint8Array): { bytes: Uint8Array; info: ImageInfo } | null {
  const info = sniffImage(b);
  if (!info) return null;
  let bytes: Uint8Array | null;
  switch (info.type) {
    case 'png':
      bytes = cleanPng(b, info);
      break;
    case 'jpeg':
      bytes = cleanJpeg(b);
      break;
    case 'webp':
      bytes = cleanWebp(b, info);
      break;
    case 'gif':
      bytes = cleanGif(b, info);
      break;
    case 'ico':
      bytes = cleanIco(b);
      break;
  }
  return bytes ? { bytes, info } : null;
}

/** PNG chunks that draw the image (APNG's included). Text, EXIF and time chunks are left out. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT']);

function cleanPng(b: Uint8Array, info: ImageInfo): Uint8Array | null {
  const parts = [b.subarray(0, 8)];
  let frames = 0;
  for (let i = 8; i + 12 <= b.length; ) {
    const end = i + 12 + u32be(b, i);
    if (end > b.length) return null;
    const type = fourcc(b, i + 4);
    if (type === 'fcTL') {
      // An animation frame: its size and offset within the canvas.
      if (end - i < 12 + 20 || ++frames > MAX_FRAMES) return null;
      const [w, h, x, y] = [u32be(b, i + 12), u32be(b, i + 16), u32be(b, i + 20), u32be(b, i + 24)];
      if (w < 1 || h < 1 || x + w > info.width || y + h > info.height) return null;
    }
    if (PNG_KEEP.has(type)) parts.push(b.subarray(i, end));
    if (type === 'IEND') return concat(parts);
    i = end;
  }
  return null;
}

/** A JPEG segment worth keeping: JFIF, an ICC profile, Adobe's colour transform, and every table and frame. */
function keepJpegSegment(marker: number, b: Uint8Array, data: number): boolean {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2) return ascii(b, data, 'ICC_PROFILE\0');
  // Every other APPn (Exif and GPS, XMP, IPTC, maker notes …) and comments.
  return !(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe;
}

function cleanJpeg(b: Uint8Array): Uint8Array | null {
  const parts = [b.subarray(0, 2)];
  let i = 2;
  // The header: segments up to the first scan.
  for (;;) {
    if (i + 4 > b.length || b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd9) return null; // the end, before any scan
    const end = i + 2 + u16be(b, i + 2);
    if (end > b.length || end < i + 4) return null;
    if (keepJpegSegment(marker, b, i + 4)) parts.push(b.subarray(i, end));
    i = end;
    if (marker === 0xda) break;
  }
  // The scans: entropy-coded data (FF only as FF00 or a restart marker), and between the scans of a
  // progressive JPEG more segments, kept or left out the same way, up to the end marker.
  let from = i;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xd9) {
      parts.push(b.subarray(from, i + 2));
      return concat(parts);
    }
    if (i + 4 > b.length) return null;
    const end = i + 2 + u16be(b, i + 2);
    if (end > b.length || end < i + 4) return null;
    parts.push(b.subarray(from, i));
    if (keepJpegSegment(marker, b, i + 4)) parts.push(b.subarray(i, end));
    i = from = end;
  }
  return null;
}

/** WebP chunks that draw the image. EXIF and XMP are left out. */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function cleanWebp(b: Uint8Array, info: ImageInfo): Uint8Array | null {
  const end = 8 + u32le(b, 4);
  if (end > b.length || end < 20) return null;
  const parts = [b.subarray(0, 12)];
  let frames = 0;
  for (let i = 12; i < end; ) {
    if (i + 8 > end) return null;
    const type = fourcc(b, i);
    const size = u32le(b, i + 4);
    const next = i + 8 + size + (size & 1);
    if (i + 8 + size > end) return null;
    if (type === 'ANMF') {
      // An animation frame: offset (in pairs of pixels), then size, within the canvas.
      if (size < 16 || ++frames > MAX_FRAMES) return null;
      const x = u24le(b, i + 8) * 2;
      const y = u24le(b, i + 11) * 2;
      if (x + u24le(b, i + 14) + 1 > info.width || y + u24le(b, i + 17) + 1 > info.height) return null;
    }
    if (WEBP_KEEP.has(type)) parts.push(b.subarray(i, Math.min(next, end)));
    i = next;
  }
  const out = concat(parts);
  // The RIFF size is what's left, and VP8X no longer says there's EXIF (0x08) or XMP (0x04).
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  if (ascii(out, 12, 'VP8X')) out[20]! &= ~0x0c;
  return out;
}

/** Past a run of GIF sub-blocks (each a length byte, then that many bytes; a zero ends them); -1 past the end. */
function skipSubBlocks(b: Uint8Array, i: number): number {
  while (i < b.length) {
    const n = b[i]!;
    i += 1 + n;
    if (n === 0) return i;
  }
  return -1;
}

function cleanGif(b: Uint8Array, info: ImageInfo): Uint8Array | null {
  const flags = b[10]!;
  let i = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  if (i > b.length) return null;
  const parts = [b.subarray(0, i)];
  let frames = 0;
  while (i < b.length) {
    const block = b[i]!;
    if (block === 0x3b) {
      parts.push(b.subarray(i, i + 1));
      return concat(parts);
    }
    if (block === 0x21) {
      // An extension: frame timing (F9) and the loop count (NETSCAPE2.0) stay; comments, text and the rest go.
      const end = skipSubBlocks(b, i + 2);
      if (end < 0) return null;
      const label = b[i + 1];
      const loop = label === 0xff && b[i + 2] === 11 && (ascii(b, i + 3, 'NETSCAPE2.0') || ascii(b, i + 3, 'ANIMEXTS1.0'));
      if (label === 0xf9 || loop) parts.push(b.subarray(i, end));
      i = end;
      continue;
    }
    if (block === 0x2c) {
      // A frame: it has to fit the canvas the header declared.
      if (i + 10 > b.length || ++frames > MAX_FRAMES) return null;
      const [x, y, w, h, f] = [u16le(b, i + 1), u16le(b, i + 3), u16le(b, i + 5), u16le(b, i + 7), b[i + 9]!];
      if (w < 1 || h < 1 || x + w > info.width || y + h > info.height) return null;
      const end = skipSubBlocks(b, i + 10 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0) + 1);
      if (end < 0) return null;
      parts.push(b.subarray(i, end));
      i = end;
      continue;
    }
    return null;
  }
  return null;
}

/** An icon from a website: every image in it as small as the directory says, and nothing after the last. */
function cleanIco(b: Uint8Array): Uint8Array | null {
  const count = u16le(b, 4);
  let end = 6 + 16 * count;
  for (let n = 0; n < count; n++) {
    const at = 6 + 16 * n;
    const size = u32le(b, at + 8);
    const offset = u32le(b, at + 12);
    if (offset < 6 + 16 * count || size < 16 || offset + size > b.length) return null;
    // A PNG says its size in IHDR; a bitmap in its header, with the height doubled for the mask.
    const png = b[offset] === 0x89 && ascii(b, offset + 1, 'PNG');
    const width = png ? u32be(b, offset + 16) : i32le(b, offset + 4);
    const height = png ? u32be(b, offset + 20) : Math.abs(i32le(b, offset + 8)) / 2;
    if (width < 1 || height < 1 || width > 256 || height > 256) return null;
    end = Math.max(end, offset + size);
  }
  return b.slice(0, end);
}

/** A fresh key for an image of this type: 32 random hex digits and its extension. */
export function newMediaKey(type: ImageType): string {
  return `${crypto.randomUUID().replaceAll('-', '')}.${EXTENSIONS[type]}`;
}

const MEDIA_KEY_RE = /^[0-9a-f]{32}\.(png|jpg|webp|gif|ico)$/;

/** The image type a key was stored as; null for anything that isn't one of ours. */
export function mediaKeyType(key: string): ImageType | null {
  const m = MEDIA_KEY_RE.exec(key);
  return m ? TYPE_OF_EXTENSION[m[1]!]! : null;
}

/** Where a page loads a stored image from; null for none. */
export function mediaUrl(key: string | null | undefined): string | null {
  return key && mediaKeyType(key) ? `/media/${key}` : null;
}

// ---------- a website's icon ----------

/**
 * Whether hoomuch may fetch a page or icon at this address: https, on a public hostname. No IP
 * literals and no names that only mean something on a private network.
 */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // "localhost." is localhost: a trailing dot only makes a name fully qualified.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host);
}

/** The four attributes read from a <link> tag, each quoted either way or not at all. */
const ATTRIBUTES = {
  rel: /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  href: /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  sizes: /\ssizes\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  type: /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
};

/** An attribute's value in one tag; undefined when it isn't there. */
function attr(tag: string, name: keyof typeof ATTRIBUTES): string | undefined {
  const m = ATTRIBUTES[name].exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

/** The most <link> tags read from a page, and the longest one. */
const MAX_LINKS = 64;
const MAX_TAG = 2048;

/**
 * The page's <link> tags, in one pass: indexOf, never a regex over the page (a page of "<link"
 * with no ">" would make one take time in the square of its length). Stops at the end of the head.
 */
function linkTags(html: string): string[] {
  const lower = html.toLowerCase();
  const stops = [lower.indexOf('</head'), lower.indexOf('<body')].filter((n) => n >= 0);
  const stop = stops.length > 0 ? Math.min(...stops) : lower.length;
  const tags: string[] = [];
  for (let from = 0; tags.length < MAX_LINKS; ) {
    const start = lower.indexOf('<link', from);
    if (start < 0 || start >= stop) break;
    const end = lower.indexOf('>', start);
    if (end < 0) break;
    // "<link" followed by a name character is another tag ("<linkfoo"), not a link.
    if (!/[\s/>]/.test(lower[start + 5] ?? '')) {
      from = start + 5;
      continue;
    }
    if (end - start <= MAX_TAG) tags.push(html.slice(start, end + 1));
    from = end + 1;
  }
  return tags;
}

/** How much we want an icon this size: bigger is sharper, up to what a tile ever shows. */
const want = (side: number) => Math.min(side, 256);

/**
 * The icons a page offers, best first (its <link rel="icon"> and apple-touch-icon tags, biggest
 * first, no SVG), then the two every browser tries on its own: /apple-touch-icon.png and
 * /favicon.ico. Addresses resolve against the page's final URL; only fetchable ones are kept.
 */
export function iconCandidates(html: string, pageUrl: string): string[] {
  const found: Array<{ url: string; side: number; order: number }> = [];
  for (const tag of linkTags(html)) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!touch && !rel.includes('icon')) continue;
    const href = attr(tag, 'href')?.trim().replaceAll('&amp;', '&');
    if (!href || /^data:/i.test(href)) continue;
    if ((attr(tag, 'type') ?? '').toLowerCase().includes('svg') || /\.svg(?:[?#]|$)/i.test(href)) continue;
    let url: string;
    try {
      url = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    const sides = [...(attr(tag, 'sizes') ?? '').matchAll(/(\d+)x\d+/gi)].map((s) => Number(s[1]));
    const side = sides.length > 0 ? Math.max(...sides) : touch ? 180 : /\.ico(?:[?#]|$)/i.test(href) ? 16 : 32;
    found.push({ url, side, order: found.length });
  }
  found.sort((a, b) => want(b.side) - want(a.side) || a.order - b.order);
  const origin = new URL(pageUrl).origin;
  const all = [...found.map((f) => f.url), `${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`];
  return [...new Set(all)].filter(isFetchableUrl);
}
