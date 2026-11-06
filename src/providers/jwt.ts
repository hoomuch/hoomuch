/**
 * JSON Web Tokens signed with a key the user pasted. Owner: Data Plane.
 *
 * App Store Connect signs every request with an ES256 token made from the team's .p8 key; Google trades an
 * RS256 assertion made from the service account's key for an access token. Both keys are PKCS#8 PEM, and
 * both are imported with WebCrypto as non-extractable signing keys (workerd and Node share the API).
 *
 * Pasted keys arrive mangled: an <input> drops line breaks, and a key copied out of a JSON file keeps its
 * "\n" escapes. `pemToDer` accepts all of these. Nothing here logs or echoes key material.
 */

const PEM_RE = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/;

export type PemProblem = 'missing' | 'encrypted' | 'not_pkcs8' | 'bad_base64';

/**
 * DER bytes of the first PKCS#8 private key in `text`, or the reason there isn't one. Accepts PEM with or
 * without line breaks, with literal "\n" escapes, and a bare base64 body.
 */
export function pemToDer(text: string): { ok: true; der: Uint8Array } | { ok: false; problem: PemProblem } {
  const unescaped = text.replace(/\\r|\\n/g, '\n');
  const m = PEM_RE.exec(unescaped);
  let body: string;
  if (m) {
    const label = m[1]!.trim();
    if (label === 'ENCRYPTED PRIVATE KEY') return { ok: false, problem: 'encrypted' };
    if (label !== 'PRIVATE KEY') return { ok: false, problem: 'not_pkcs8' };
    body = m[2]!;
  } else if (/-----BEGIN /.test(unescaped)) {
    return { ok: false, problem: 'missing' };
  } else {
    body = unescaped;
  }
  const b64 = body.replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    return { ok: false, problem: m ? 'bad_base64' : 'missing' };
  }
  try {
    return { ok: true, der: base64ToBytes(b64) };
  } catch {
    return { ok: false, problem: 'bad_base64' };
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export type JwtAlg = 'ES256' | 'RS256';

const IMPORT_PARAMS: Record<JwtAlg, EcKeyImportParams | RsaHashedImportParams> = {
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
};

const SIGN_PARAMS: Record<JwtAlg, AlgorithmIdentifier | EcdsaParams> = {
  ES256: { name: 'ECDSA', hash: 'SHA-256' },
  RS256: { name: 'RSASSA-PKCS1-v1_5' },
};

/** Imports a PKCS#8 key for `alg`. Null when the bytes aren't a key of that kind (wrong curve, RSA vs EC, …). */
export async function importSigningKey(der: Uint8Array, alg: JwtAlg): Promise<CryptoKey | null> {
  try {
    // A fresh ArrayBuffer: WebCrypto rejects views over SharedArrayBuffer and some runtimes over offsets.
    const buf = der.slice().buffer;
    return await crypto.subtle.importKey('pkcs8', buf, IMPORT_PARAMS[alg], false, ['sign']);
  } catch {
    return null;
  }
}

/**
 * Signs a compact JWS. ECDSA signatures from WebCrypto are already the raw r‖s pair JWS wants
 * (RFC 7518 §3.4), not DER.
 */
export async function signJwt(
  key: CryptoKey,
  alg: JwtAlg,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const signingInput = `${base64UrlJson({ ...header, alg, typ: 'JWT' })}.${base64UrlJson(payload)}`;
  const sig = await crypto.subtle.sign(SIGN_PARAMS[alg], key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(sig))}`;
}
