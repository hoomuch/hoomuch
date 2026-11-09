/**
 * An in-memory R2 bucket with the few methods the media code uses (put, get, delete), for the
 * route tests. Each object keeps its bytes and the content type it was stored with.
 */

export class FakeR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, value: Uint8Array | ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value instanceof ArrayBuffer ? value : value.slice());
    this.objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    return { key };
  }

  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: new Response(o.bytes.slice()).body, httpEtag: `"${key.slice(0, 8)}"`, httpMetadata: { contentType: o.contentType } };
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }

  /** As the binding the Worker's env expects. */
  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

/** A complete (if blank) PNG of this size: signature, IHDR, IEND; `tail` goes after IEND. CRCs are zero. */
export function pngBytes(width = 64, height = 64, tail: number[] = []): Uint8Array {
  const b = new Uint8Array(45 + tail.length);
  const v = new DataView(b.buffer);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  v.setUint32(16, width);
  v.setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  b.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44], 33); // IEND, after IHDR's CRC (29–32)
  b.set(tail, 45);
  return b;
}
