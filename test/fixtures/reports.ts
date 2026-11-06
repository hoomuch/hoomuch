/**
 * Builders for report-file fixtures (gzip, zip, UTF-16 CSV) and throwaway signing keys. Not a test file.
 * Everything is generated at runtime from the plain-text fixtures, so no binary files live in the repo.
 */

async function pipe(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const out = await new Response(new Blob([bytes.slice()]).stream().pipeThrough(transform)).arrayBuffer();
  return new Uint8Array(out);
}

const toBytes = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

export function gzip(data: string | Uint8Array): Promise<Uint8Array> {
  return pipe(toBytes(data), new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
}

function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive (PKWARE APPNOTE), deflated unless `method: 0`. */
export async function zip(entries: Array<{ name: string; data: string | Uint8Array; method?: 0 | 8 }>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = toBytes(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? await deflateRaw(raw) : raw;
    const name = new TextEncoder().encode(e.name);
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(10, method, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const dirSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** UTF-16 bytes, with a byte-order mark by default (how Play Console writes its statistics CSVs). */
export function utf16(text: string, opts: { bigEndian?: boolean; bom?: boolean } = {}): Uint8Array {
  const units = (opts.bom ?? true ? '﻿' : '') + text;
  const out = new Uint8Array(units.length * 2);
  for (let i = 0; i < units.length; i++) {
    const u = units.charCodeAt(i);
    out[i * 2] = opts.bigEndian ? u >> 8 : u & 0xff;
    out[i * 2 + 1] = opts.bigEndian ? u & 0xff : u >> 8;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** PEM of a key's PKCS#8 export, wrapped at 64 columns like the files Apple and Google hand out. */
export async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const b64 = toBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

export function ecKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

export function rsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** True when the signature verifies with `publicKey`. */
  valid: boolean;
}

export async function decodeJwt(token: string, publicKey: CryptoKey): Promise<DecodedJwt> {
  const [h, p, s] = token.split('.') as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(fromBase64Url(h))) as Record<string, unknown>;
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(p))) as Record<string, unknown>;
  const algorithm = header['alg'] === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const valid = await crypto.subtle.verify(algorithm, publicKey, fromBase64Url(s), new TextEncoder().encode(`${h}.${p}`));
  return { header, payload, valid };
}
