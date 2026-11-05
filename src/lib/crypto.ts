/**
 * Crypto primitives built on WebCrypto only, so they run in Workers and in Node (tests).
 * Owner: Lead. See SPEC.md §8.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- encoding ----------

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  return base64UrlToBytes(s.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- randomness & hashing ----------

export function randomId(): string {
  return crypto.randomUUID();
}

/** URL-safe random token (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

/** Constant-time comparison for equal-purpose strings (hashes, tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ---------- passwords (PBKDF2-SHA256) ----------

/** Workers caps PBKDF2 at 100k iterations; going higher throws NotSupportedError. */
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Returns `pbkdf2$<iterations>$<salt>$<hash>` (base64url parts). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iter || !saltB64 || !hashB64) return false;
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const hash = await pbkdf2(password, base64UrlToBytes(saltB64), iterations);
  return timingSafeEqual(bytesToBase64Url(hash), hashB64);
}

// ---------- secrets at rest (AES-256-GCM) ----------

const keyCache = new Map<string, Promise<CryptoKey>>();

function importAesKey(keyB64: string): Promise<CryptoKey> {
  let p = keyCache.get(keyB64);
  if (!p) {
    const raw = base64ToBytes(keyB64);
    if (raw.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
    }
    p = crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(keyB64, p);
  }
  return p;
}

/** Encrypts a JSON-serialisable value. Output: `v1.<iv>.<ciphertext>` (base64url). */
export async function encryptJson(keyB64: string, value: unknown): Promise<string> {
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ct))}`;
}

export async function decryptJson<T>(keyB64: string, blob: string): Promise<T> {
  const [version, ivB64, ctB64] = blob.split('.');
  if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('Unsupported ciphertext format');
  const key = await importAesKey(keyB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(ivB64) as BufferSource },
    key,
    base64UrlToBytes(ctB64) as BufferSource,
  );
  return JSON.parse(dec.decode(pt)) as T;
}

/** "…a1b2" — last 4 characters of a secret, safe to show in the UI. */
export function keyHint(secret: string): string {
  const s = secret.trim();
  return s.length <= 8 ? '…' : `…${s.slice(-4)}`;
}
