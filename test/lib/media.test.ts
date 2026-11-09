/**
 * Images on public pages (lib/media.ts): what the bytes are and how big they say they are, keys,
 * and which icons a website's HTML offers.
 */
import { describe, expect, it } from 'vitest';
import { cleanImage, iconCandidates, isFetchableUrl, MAX_FRAMES, MAX_SIDE, mediaKeyType, mediaUrl, newMediaKey, sniffImage } from '../../src/lib/media';
import { pngBytes } from '../fixtures/r2';

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const le16 = (n: number) => [n & 0xff, n >> 8];
const be16 = (n: number) => [n >> 8, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
/** A PNG chunk (CRC left zero: the cleaner keeps or drops chunks whole). */
const chunk = (type: string, data: number[] | string) => {
  const d = typeof data === 'string' ? [...data].map((c) => c.charCodeAt(0)) : data;
  return [...be32(d.length), ...[...type].map((c) => c.charCodeAt(0)), ...d, 0, 0, 0, 0];
};
/** A JPEG segment: marker, length, data. */
const seg = (marker: number, data: number[] | string) => {
  const d = typeof data === 'string' ? [...data].map((c) => c.charCodeAt(0)) : data;
  return [0xff, marker, ...be16(d.length + 2), ...d];
};
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, n >> 16];

describe('sniffImage', () => {
  it('reads PNG, GIF, JPEG, the three WebP layouts and ICO by their bytes', () => {
    expect(sniffImage(pngBytes(120, 80))).toEqual({ type: 'png', width: 120, height: 80 });
    expect(sniffImage(bytes('GIF89a', le16(40), le16(30), [0, 0, 0, 0]))).toEqual({ type: 'gif', width: 40, height: 30 });
    // SOI, an APP0 segment, then SOF0: precision, height, width.
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 70, 3, 0, 0, 0, 0]);
    expect(sniffImage(jpeg)).toEqual({ type: 'jpeg', width: 70, height: 50 });
    const vp8x = bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0, 0, 0, 0, 0], le24(399), le24(199));
    expect(sniffImage(vp8x)).toEqual({ type: 'webp', width: 400, height: 200 });
    const vp8l = bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8L', [0, 0, 0, 0], [0x2f], [255, 0xc0, 0x3f, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(vp8l)).toEqual({ type: 'webp', width: 256, height: 256 });
    const vp8 = bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(64), le16(48));
    expect(sniffImage(vp8)).toEqual({ type: 'webp', width: 64, height: 48 });
    // Two images, 16 and "0" (256): the icon is as big as its biggest.
    const ico = bytes([0, 0, 1, 0], le16(2), [16, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(ico)).toEqual({ type: 'ico', width: 256, height: 256 });
  });

  it('turns away anything else: SVG, HTML, text, truncated or empty headers', () => {
    for (const b of [
      bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      bytes('<!doctype html><html><script>alert(1)</script>'),
      bytes('just some text, long enough'),
      pngBytes().slice(0, 20),
      bytes([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0]),
      bytes([0, 0, 1, 0], le16(0), [0, 0, 0, 0, 0, 0]),
      new Uint8Array(),
    ]) {
      expect(sniffImage(b)).toBeNull();
    }
  });

  it('turns away an image that claims a giant canvas, or none', () => {
    expect(sniffImage(pngBytes(MAX_SIDE, MAX_SIDE))).not.toBeNull();
    expect(sniffImage(pngBytes(MAX_SIDE + 1, 10))).toBeNull();
    expect(sniffImage(pngBytes(0, 10))).toBeNull();
    expect(sniffImage(pngBytes(0xffffffff, 0xffffffff))).toBeNull();
  });
});

describe('cleanImage', () => {
  it('takes a JPEG’s camera and location metadata and comments out, and stops at its end', () => {
    const exif = seg(0xe1, 'Exif\0\0GPS 41.0082 N 28.9784 E');
    const xmp = seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>');
    const sof = seg(0xc0, [8, ...be16(50), ...be16(70), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const jpeg = bytes(
      [0xff, 0xd8],
      seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
      exif,
      seg(0xe2, 'ICC_PROFILE\0\x01\x01icc'),
      xmp,
      seg(0xfe, 'shot on a phone'),
      seg(0xdb, new Array(65).fill(1)),
      sof,
      seg(0xda, [1, 1, 0, 0, 63, 0]),
      [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56], // scan data, with a stuffed FF and a restart marker
      seg(0xed, 'Photoshop 3.0\0IPTC'), // between scans (progressive): dropped too
      seg(0xda, [1, 1, 0, 0, 63, 0]),
      [0x78],
      [0xff, 0xd9],
      '<html><script>alert(1)</script>',
    );
    const out = cleanImage(jpeg)!;
    expect(out.info).toEqual({ type: 'jpeg', width: 70, height: 50 });
    const kept = text(out.bytes);
    for (const gone of ['Exif', 'GPS', 'xmpmeta', 'shot on a phone', 'IPTC', '<html>']) expect(kept).not.toContain(gone);
    for (const stays of ['JFIF', 'ICC_PROFILE']) expect(kept).toContain(stays);
    expect([...out.bytes.slice(-2)]).toEqual([0xff, 0xd9]);
    expect(sniffImage(out.bytes)).toEqual(out.info);
  });

  it('keeps only a PNG’s drawing chunks, and nothing after IEND', () => {
    const png = bytes(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      chunk('IHDR', [...be32(20), ...be32(10), 8, 6, 0, 0, 0]),
      chunk('tEXt', 'Comment\0hello'),
      chunk('eXIf', 'MM\0*GPS'),
      chunk('iTXt', 'XML:com.adobe.xmp\0'),
      chunk('pHYs', [0, 0, 11, 19, 0, 0, 11, 19, 1]),
      chunk('IDAT', [1, 2, 3]),
      chunk('tIME', [7, 234, 11, 9, 12, 0, 0]),
      chunk('IEND', []),
      '<script>alert(1)</script>',
    );
    const out = text(cleanImage(png)!.bytes);
    expect(out).toContain('pHYs');
    expect(out).toContain('IDAT');
    for (const gone of ['tEXt', 'eXIf', 'iTXt', 'tIME', 'script']) expect(out).not.toContain(gone);
    expect(out.endsWith('IEND\0\0\0\0')).toBe(true);
  });

  it('turns away a PNG without an end, or a chunk running past it', () => {
    const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...be32(20), ...be32(10), 8, 6, 0, 0, 0])];
    expect(cleanImage(bytes(head, chunk('IDAT', [1])))).toBeNull();
    expect(cleanImage(bytes(head, be32(1000), 'IDAT', [1, 2, 3]))).toBeNull();
  });

  it('drops a WebP’s EXIF and XMP chunks, says so in VP8X, and fixes the RIFF size', () => {
    const vp8x = [...'VP8X'].map((c) => c.charCodeAt(0)).concat(le32(10), [0x0c | 0x10, 0, 0, 0], le24(99), le24(99));
    const alph = [...'ALPH'].map((c) => c.charCodeAt(0)).concat(le32(3), [1, 2, 3, 0]); // odd size: one byte of padding
    const exif = [...'EXIF'].map((c) => c.charCodeAt(0)).concat(le32(8), [...'GPS here'].map((c) => c.charCodeAt(0)));
    const xmp = [...'XMP '].map((c) => c.charCodeAt(0)).concat(le32(4), [1, 2, 3, 4]);
    const body = [...'WEBP'].map((c) => c.charCodeAt(0)).concat(vp8x, alph, exif, xmp);
    const webp = bytes('RIFF', le32(body.length), body, 'junk after the RIFF');
    const out = cleanImage(webp)!;
    const kept = text(out.bytes);
    for (const gone of ['EXIF', 'GPS', 'XMP ', 'junk']) expect(kept).not.toContain(gone);
    expect(out.bytes[20]! & 0x0c).toBe(0); // no EXIF or XMP flag
    expect(out.bytes[20]! & 0x10).toBe(0x10); // alpha stays
    expect(new DataView(out.bytes.buffer).getUint32(4, true)).toBe(out.bytes.length - 8);
  });

  it('keeps a GIF’s frames and loop, drops its comments, and turns away a frame bigger than its canvas', () => {
    const frame = (w: number, h: number) => [0x2c, ...le16(0), ...le16(0), ...le16(w), ...le16(h), 0, 2, 2, 0x4c, 0x01, 0];
    const loop = [0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0];
    const comment = [0x21, 0xfe, 9, ...[...'secret me'].map((c) => c.charCodeAt(0)), 0];
    const head = [...'GIF89a'].map((c) => c.charCodeAt(0)).concat(le16(10), le16(10), [0, 0, 0]);
    const ok = cleanImage(bytes(head, loop, comment, [0x21, 0xf9, 4, 0, 10, 0, 0, 0], frame(10, 10), [0x3b], 'trailing'))!;
    const kept = text(ok.bytes);
    expect(kept).toContain('NETSCAPE2.0');
    expect(kept).not.toContain('secret');
    expect(kept.endsWith(';')).toBe(true);
    // A 1x1 canvas holding a 4000x4000 frame.
    expect(cleanImage(bytes('GIF89a', le16(1), le16(1), [0, 0, 0], frame(4000, 4000), [0x3b]))).toBeNull();
    // More frames than an avatar needs.
    expect(cleanImage(bytes(head, ...new Array(MAX_FRAMES + 1).fill(frame(10, 10)), [0x3b]))).toBeNull();
  });

  it('turns away an icon whose image is bigger than an icon', () => {
    const entry = (offset: number, size: number) => [16, 16, 0, 0, 1, 0, 32, 0, ...le32(size), ...le32(offset)];
    const pngInside = (w: number) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(w), 8, 6, 0, 0, 0];
    const ico = (inner: number[]) => bytes([0, 0, 1, 0], le16(1), entry(22, inner.length), inner, 'after');
    expect(cleanImage(ico(pngInside(16)))!.bytes.length).toBe(22 + pngInside(16).length);
    expect(cleanImage(ico(pngInside(65535)))).toBeNull();
    // An entry pointing past the end.
    expect(cleanImage(bytes([0, 0, 1, 0], le16(1), entry(22, 4000), pngInside(16)))).toBeNull();
  });
});

describe('keys', () => {
  it('are random, typed by their extension, and only ours become URLs', () => {
    const key = newMediaKey('webp');
    expect(key).toMatch(/^[0-9a-f]{32}\.webp$/);
    expect(newMediaKey('webp')).not.toBe(key);
    expect(mediaKeyType(key)).toBe('webp');
    expect(mediaKeyType(newMediaKey('jpeg'))).toBe('jpeg');
    expect(mediaUrl(key)).toBe(`/media/${key}`);
    for (const bad of ['../x.png', 'a.svg', `${'a'.repeat(32)}.html`, `${'A'.repeat(32)}.png`, `${'a'.repeat(32)}.png/x`]) {
      expect(mediaKeyType(bad)).toBeNull();
      expect(mediaUrl(bad)).toBeNull();
    }
    expect(mediaUrl(null)).toBeNull();
  });
});

describe('isFetchableUrl', () => {
  it('takes https on public hostnames only', () => {
    expect(isFetchableUrl('https://acme.com/')).toBe(true);
    expect(isFetchableUrl('https://www.acme.co.uk/pricing')).toBe(true);
    for (const bad of [
      'http://acme.com',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://10.0.0.1/',
      'https://[::1]/',
      'https://intranet/',
      'https://printer.local/',
      'https://api.internal/',
      'https://user:pass@acme.com/',
      'https://localhost./',
      'https://foo.localhost./',
      'https://metadata.google.internal./',
      'https://printer.local../',
      'https://acme.com:8443/',
      'ftp://acme.com',
      'not a url',
    ]) {
      expect(isFetchableUrl(bad)).toBe(false);
    }
  });
});

describe('iconCandidates', () => {
  it('ranks the page’s icons biggest first, skips SVG and data:, then tries the usual addresses', () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link href='/static/apple.png' rel='apple-touch-icon'>
      <link rel="icon" sizes="192x192" href="https://cdn.acme.com/icon-192.png?v=1&amp;x=2">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="stylesheet" href="/app.css">
      <link rel="shortcut icon" href="http://insecure.acme.com/favicon.ico">
    </head><body></body></html>`;
    expect(iconCandidates(html, 'https://acme.com/en/')).toEqual([
      'https://cdn.acme.com/icon-192.png?v=1&x=2',
      'https://acme.com/static/apple.png',
      'https://acme.com/favicon-32.png',
      'https://acme.com/apple-touch-icon.png',
      'https://acme.com/favicon.ico',
    ]);
  });

  it('falls back to the usual addresses when the page names none', () => {
    expect(iconCandidates('', 'https://acme.com/')).toEqual(['https://acme.com/apple-touch-icon.png', 'https://acme.com/favicon.ico']);
  });

  it('reads a hostile page in linear time, and only its head', () => {
    const t0 = performance.now();
    iconCandidates('<link'.repeat(40_000), 'https://acme.com/');
    expect(performance.now() - t0).toBeLessThan(200);
    const html = '<head><link rel="icon" href="/a.png"></head><body><link rel="icon" href="/b.png"></body>';
    expect(iconCandidates(html, 'https://acme.com/')[0]).toBe('https://acme.com/a.png');
    expect(iconCandidates(html, 'https://acme.com/')).not.toContain('https://acme.com/b.png');
    expect(iconCandidates('<linkx rel="icon" href="/x.png">', 'https://acme.com/')).not.toContain('https://acme.com/x.png');
  });

  it('drops icons on addresses hoomuch may not fetch', () => {
    const html = '<link rel="icon" href="https://localhost/x.png"><link rel="icon" href="https://192.168.0.1/x.png">';
    expect(iconCandidates(html, 'https://acme.com/')).toEqual(['https://acme.com/apple-touch-icon.png', 'https://acme.com/favicon.ico']);
  });
});
