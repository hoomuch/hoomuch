import { describe, expect, it } from 'vitest';
import { pemToDer } from '../../src/providers/jwt';
import {
  columnIndex,
  decodeText,
  gunzipStream,
  parseCount,
  parseDecimal,
  readRows,
  zipEntries,
  zipEntryStream,
  type Row,
} from '../../src/providers/reports';
import { gzip, utf16, zip } from '../fixtures/reports';

/** A stream that hands out `bytes` in chunks of `size`, to exercise boundaries. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = '';
  for await (const t of decodeText(stream)) out += t;
  return out;
}

async function rows(chunks: string[], quoted = true, delimiter: ',' | '\t' = ','): Promise<Row[]> {
  const out: Row[] = [];
  async function* gen() {
    yield* chunks;
  }
  await readRows(gen(), { delimiter, quoted }, (r) => {
    out.push(r);
  });
  return out;
}

describe('decodeText', () => {
  const sample = 'Date,Ürün,価格\n2026-11-04,Café 😀,1.200\n';

  it.each([1, 2, 3, 7, 4096])('reads UTF-16LE with a BOM in %i-byte chunks', async (size) => {
    expect(await text(chunked(utf16(sample), size))).toBe(sample);
  });

  it('reads UTF-16BE, and UTF-16 without a BOM', async () => {
    expect(await text(chunked(utf16(sample, { bigEndian: true }), 5))).toBe(sample);
    expect(await text(chunked(utf16('Date,Package Name\n', { bom: false }), 3))).toBe('Date,Package Name\n');
  });

  it('reads UTF-8 with or without a BOM, across multi-byte boundaries', async () => {
    const utf8 = new TextEncoder().encode(sample);
    expect(await text(chunked(utf8, 1))).toBe(sample);
    expect(await text(chunked(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]), 2))).toBe(sample);
  });

  it('reads files shorter than the sniffing window', async () => {
    expect(await text(chunked(new TextEncoder().encode('a\n'), 1))).toBe('a\n');
  });
});

describe('readRows', () => {
  it('splits quoted CSV, with escaped quotes and delimiters inside quotes', async () => {
    expect(await rows(['a,"b, c","say ""hi""",\r\n1,2,3,4\r\n'])).toEqual([
      ['a', 'b, c', 'say "hi"', ''],
      ['1', '2', '3', '4'],
    ]);
  });

  it('keeps a quoted line break inside its field, across chunks', async () => {
    expect(await rows(['x,"line one', '\nline two",y\nz,1,2'])).toEqual([
      ['x', 'line one\nline two', 'y'],
      ['z', '1', '2'],
    ]);
  });

  it('treats quotes as text in unquoted TSV', async () => {
    expect(await rows(['Title\tUnits\n"Pro" edition\t3\n'], false, '\t')).toEqual([
      ['Title', 'Units'],
      ['"Pro" edition', '3'],
    ]);
  });

  it('skips blank lines and stops when the callback says so', async () => {
    const seen: Row[] = [];
    async function* gen() {
      yield 'a\n\n b\nc\nd\n';
    }
    await readRows(gen(), { delimiter: ',', quoted: true }, (r) => {
      seen.push(r);
      return seen.length < 2;
    });
    expect(seen).toEqual([['a'], [' b']]);
  });
});

describe('columnIndex', () => {
  it('matches headers by name, ignoring case, spacing, punctuation and a BOM', () => {
    const col = columnIndex(['﻿Provider', 'Developer Proceeds (per unit)', 'customer  price']);
    expect(col(['Provider'])).toBe(0);
    expect(col(['Developer Proceeds', 'Developer Proceeds (per unit)'])).toBe(1);
    expect(col(['Customer Price'])).toBe(2);
    expect(col(['Units'])).toBe(-1);
  });
});

describe('numbers', () => {
  it.each([
    ['1,234.56', 1234.56],
    ['.70', 0.7],
    ['-0.99', -0.99],
    ['12', 12],
    ['+3', 3],
    ['', null],
    ['1.2.3', null],
    ['12 USD', null],
    ['NaN', null],
  ])('parseDecimal(%j)', (raw, want) => expect(parseDecimal(raw)).toBe(want));

  it.each([
    ['', 0],
    ['42', 42],
    ['1,024', 1024],
    ['3.0', 3],
    ['-1', null],
    ['2.5', null],
  ])('parseCount(%j)', (raw, want) => expect(parseCount(raw)).toBe(want));
});

describe('gzip and zip', () => {
  it('gunzips, and passes plain bytes through', async () => {
    expect(await text(gunzipStream('Test', await gzip('a\tb\n')))).toBe('a\tb\n');
    expect(await text(gunzipStream('Test', new TextEncoder().encode('plain\n')))).toBe('plain\n');
  });

  it('lists and inflates zip entries', async () => {
    const z = await zip([
      { name: 'readme.txt', data: 'hello', method: 0 },
      { name: 'salesreport_202611.csv', data: 'a,b\n1,2\n' },
    ]);
    const entries = zipEntries(z)!;
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ['readme.txt', 0],
      ['salesreport_202611.csv', 8],
    ]);
    expect(await text(zipEntryStream('Test', z, entries[1]!))).toBe('a,b\n1,2\n');
    expect(await text(zipEntryStream('Test', z, entries[0]!))).toBe('hello');
  });

  it('refuses bytes that are not a zip, and truncated archives', async () => {
    expect(zipEntries(new TextEncoder().encode('not a zip at all, just text'))).toBeNull();
    const z = await zip([{ name: 'a.csv', data: 'x'.repeat(1000) }]);
    expect(zipEntries(z.slice(0, z.length - 30))).toBeNull();
  });

  it('refuses encrypted entries', async () => {
    const z = await zip([{ name: 'a.csv', data: 'secret' }]);
    const entries = zipEntries(z)!;
    const dirStart = entries[0]!.dataOffset + entries[0]!.compressedSize;
    z[dirStart + 8] = 0x01; // general-purpose flag bit 0: encrypted
    expect(zipEntries(z)).toBeNull();
  });
});

describe('pemToDer', () => {
  const body = 'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg';
  it.each([
    ['with line breaks', `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`],
    ['on one line', `-----BEGIN PRIVATE KEY-----${body}-----END PRIVATE KEY-----`],
    ['with \\n escapes', `-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----\\n`],
    ['as a bare body', body],
  ])('reads a PKCS#8 key %s', (_label, pem) => {
    const r = pemToDer(pem);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.der[0]).toBe(0x30);
  });

  it.each([
    ['an encrypted key', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----', 'encrypted'],
    ['a PKCS#1 key', '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----', 'not_pkcs8'],
    ['a key cut short', '-----BEGIN PRIVATE KEY-----\nMIGTAgEA', 'missing'],
    ['garbage inside', '-----BEGIN PRIVATE KEY-----\n***\n-----END PRIVATE KEY-----', 'bad_base64'],
  ])('names the problem with %s', (_label, pem, problem) => {
    expect(pemToDer(pem)).toEqual({ ok: false, problem });
  });
});
