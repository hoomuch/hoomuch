/**
 * Report-file readers for providers that publish exports instead of JSON APIs. Owner: Data Plane.
 *
 *   App Store Connect  Sales and Trends reports: gzip, tab-separated, UTF-8, no quoting.
 *   Google Play        monthly sales report: a zip holding one CSV; statistics exports: plain CSV,
 *                      usually UTF-16 with a byte-order mark.
 *
 * Everything streams: a file is decompressed, decoded and split into rows chunk by chunk, so a month of
 * orders is never held expanded in memory, and a decompression bomb stops at `MAX_EXPANDED_BYTES`.
 * Callers get one row at a time and keep only the columns they need: these files also carry buyer
 * locations (state, city, postcode), which hoomuch never reads into anything it stores or logs.
 */

import { ProviderError } from './types';

/** Expanded size at which a report is given up on (decompression-bomb guard). */
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

export type Row = readonly string[];

// ---------- decompression ----------

/** DecompressionStream, typed for the byte streams used here (lib.dom types its input as BufferSource). */
function decompressor(format: 'gzip' | 'deflate-raw'): TransformStream<Uint8Array, Uint8Array> {
  return new DecompressionStream(format) as unknown as TransformStream<Uint8Array, Uint8Array>;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Passes bytes through, failing once more than `max` have gone by. */
function limitBytes(provider: string, max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) {
        controller.error(new ProviderError('upstream', `${provider} sent a report too large to read.`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** True for a gzip member (RFC 1952 magic bytes). */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** The decompressed contents of a gzip file, as a stream. Plain (already decompressed) bytes pass through. */
export function gunzipStream(provider: string, bytes: Uint8Array): ReadableStream<Uint8Array> {
  const raw = streamOf(bytes);
  const expanded = isGzip(bytes) ? raw.pipeThrough(decompressor('gzip')) : raw;
  return expanded.pipeThrough(limitBytes(provider, MAX_EXPANDED_BYTES));
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  /** Offset of the entry's data (after its local header). */
  dataOffset: number;
}

function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}

/**
 * Lists a zip file's entries from its central directory (PKWARE APPNOTE 4.3.12–4.3.16). Null when the bytes
 * aren't a zip this reader understands: ZIP64, multi-disk and encrypted archives are refused.
 */
export function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const EOCD = 0x06054b50;
  const minEnd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minEnd; i--) {
    if (u32(bytes, i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16(bytes, eocd + 10);
  const dirSize = u32(bytes, eocd + 12);
  const dirOffset = u32(bytes, eocd + 16);
  if (u16(bytes, eocd + 4) !== 0 || count === 0xffff || dirOffset === 0xffffffff) return null;
  if (dirOffset + dirSize > bytes.length) return null;

  const entries: ZipEntry[] = [];
  let at = dirOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) return null;
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    if (flags & 0x1 || compressedSize === 0xffffffff || localOffset === 0xffffffff) return null;
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) return null;
    const dataOffset = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    if (dataOffset + compressedSize > bytes.length) return null;
    entries.push({ name, method, compressedSize, dataOffset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's decompressed contents, as a stream. Throws for compression methods other than stored/deflate. */
export function zipEntryStream(provider: string, bytes: Uint8Array, entry: ZipEntry): ReadableStream<Uint8Array> {
  const data = streamOf(bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize));
  let expanded: ReadableStream<Uint8Array>;
  if (entry.method === 0) expanded = data;
  else if (entry.method === 8) expanded = data.pipeThrough(decompressor('deflate-raw'));
  else throw new ProviderError('upstream', `${provider} sent a report compressed in a way hoomuch can’t read.`);
  return expanded.pipeThrough(limitBytes(provider, MAX_EXPANDED_BYTES));
}

// ---------- text decoding ----------

type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be';

/** Encoding from a byte-order mark, else a guess from NUL bytes (UTF-16 text in ASCII range is half NULs). */
function sniffEncoding(head: Uint8Array): { encoding: Encoding; bom: number } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf-8', bom: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bom: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bom: 2 };
  if (head.length >= 4 && head[0] !== 0 && head[1] === 0 && head[3] === 0) return { encoding: 'utf-16le', bom: 0 };
  if (head.length >= 4 && head[0] === 0 && head[1] !== 0 && head[2] === 0) return { encoding: 'utf-16be', bom: 0 };
  return { encoding: 'utf-8', bom: 0 };
}

/**
 * UTF-16 decoded by hand: it's two lines of arithmetic, and it doesn't depend on which encodings a runtime's
 * TextDecoder ships with. Lone surrogates pass through as they are (the rows are only split and trimmed).
 */
class Utf16Decoder {
  private carry: number | null = null;
  constructor(private readonly littleEndian: boolean) {}

  decode(chunk: Uint8Array): string {
    let bytes = chunk;
    if (this.carry !== null) {
      const joined = new Uint8Array(chunk.length + 1);
      joined[0] = this.carry;
      joined.set(chunk, 1);
      bytes = joined;
      this.carry = null;
    }
    const even = bytes.length - (bytes.length % 2);
    if (even < bytes.length) this.carry = bytes[bytes.length - 1]!;
    const units = new Array<number>(even / 2);
    for (let i = 0, j = 0; i < even; i += 2, j++) {
      units[j] = this.littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!;
    }
    let out = '';
    for (let i = 0; i < units.length; i += 0x2000) out += String.fromCharCode(...units.slice(i, i + 0x2000));
    return out;
  }
}

/** Decodes a byte stream to text chunks, detecting UTF-8 / UTF-16 from the first bytes. */
export async function* decodeText(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  let decode: ((chunk: Uint8Array) => string) | null = null;
  let flush: () => string = () => '';
  let head = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!decode) {
        // Wait for 4 bytes so the sniff sees a whole BOM / NUL pattern.
        const joined = new Uint8Array(head.length + value.length);
        joined.set(head);
        joined.set(value, head.length);
        if (joined.length < 4) {
          head = joined;
          continue;
        }
        const { encoding, bom } = sniffEncoding(joined);
        if (encoding === 'utf-8') {
          const td = new TextDecoder('utf-8');
          decode = (c) => td.decode(c, { stream: true });
          flush = () => td.decode();
        } else {
          const d = new Utf16Decoder(encoding === 'utf-16le');
          decode = (c) => d.decode(c);
        }
        const text = decode(joined.subarray(bom));
        if (text) yield text;
        continue;
      }
      const text = decode(value);
      if (text) yield text;
    }
    if (!decode && head.length > 0) {
      const { encoding, bom } = sniffEncoding(head);
      yield encoding === 'utf-8' ? new TextDecoder().decode(head.subarray(bom)) : new Utf16Decoder(encoding === 'utf-16le').decode(head.subarray(bom));
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

// ---------- rows ----------

/** Splits one CSV record (RFC 4180 quoting: "a, b" and "" for a literal quote). */
function splitQuoted(record: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < record.length; i++) {
    const ch = record[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (record[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function countQuotes(s: string): number {
  let n = 0;
  for (let i = s.indexOf('"'); i !== -1; i = s.indexOf('"', i + 1)) n++;
  return n;
}

export interface DelimitedOptions {
  delimiter: ',' | '\t';
  /** Honour RFC 4180 quotes (CSV). App Store Connect's TSV has none, and a title may contain a bare quote. */
  quoted: boolean;
}

/**
 * Feeds every non-empty row of a delimited text stream to `onRow`. Quoted fields may span lines. Return
 * `false` from `onRow` to stop early (the rest of the stream is cancelled).
 */
export async function readRows(
  chunks: AsyncIterable<string>,
  opts: DelimitedOptions,
  onRow: (row: Row) => boolean | void,
): Promise<void> {
  let pending = '';
  let record: string | null = null; // a quoted record still open across lines
  let quotes = 0;

  const emit = (line: string): boolean => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (opts.quoted) {
      record = record === null ? text : `${record}\n${text}`;
      quotes += countQuotes(text);
      if (quotes % 2 === 1) return true; // a quoted field continues on the next line
      const whole: string = record;
      record = null;
      quotes = 0;
      if (whole.trim() === '') return true;
      return onRow(whole.includes('"') ? splitQuoted(whole, opts.delimiter) : whole.split(opts.delimiter)) !== false;
    }
    if (text.trim() === '') return true;
    return onRow(text.split(opts.delimiter)) !== false;
  };

  for await (const chunk of chunks) {
    pending += chunk;
    let nl = pending.indexOf('\n');
    let start = 0;
    while (nl !== -1) {
      if (!emit(pending.slice(start, nl))) return;
      start = nl + 1;
      nl = pending.indexOf('\n', start);
    }
    pending = pending.slice(start);
  }
  if (pending !== '' || record !== null) emit(pending);
}

/** Header name for matching: lowercase letters and digits only ("Developer Proceeds (per unit)" → "developerproceedsperunit"). */
function headerKey(name: string): string {
  return name.replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Column positions by header name. `col(['Customer Price'])` is the index of the first header that matches
 * one of the names (after `headerKey`), or -1. Never depends on column order, which providers change.
 */
export function columnIndex(header: Row): (names: readonly string[]) => number {
  const keys = header.map(headerKey);
  return (names) => {
    for (const n of names) {
      const i = keys.indexOf(headerKey(n));
      if (i !== -1) return i;
    }
    return -1;
  };
}

/** A field by index, trimmed; '' when absent. */
export function field(row: Row, i: number): string {
  return i >= 0 && i < row.length ? row[i]!.trim() : '';
}

/**
 * A decimal from a report cell: "1,234.56", ".70", "-0.99", "12". Null for blanks and anything else.
 * Commas are thousands separators in both stores' exports (Google says so; Apple never uses them).
 */
export function parseDecimal(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A non-negative whole count from a report cell; 0 for blanks. Null for anything else. */
export function parseCount(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (t === '') return 0;
  if (!/^\d+(\.0+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(Math.trunc(n)) ? Math.trunc(n) : null;
}
