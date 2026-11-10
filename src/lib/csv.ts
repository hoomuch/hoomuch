/**
 * CSV for downloads (RFC 4180): comma-separated, CRLF line ends, quotes doubled. Owner: Lead.
 *
 * A file like this is opened in a spreadsheet, where a cell starting with `=`, `+`, `-` or `@` is
 * read as a formula. Product names come from providers, so text cells that start that way get a
 * leading apostrophe (OWASP "CSV injection"). Numbers go through `csvNumber`, which keeps the minus.
 */

import { currencyExponent } from './money';

/** A cell that is already a number or a code of ours (amounts, ISO dates, currency codes). */
type RawCell = { raw: string };
export type CsvCell = string | RawCell | null;

const FORMULA_START = /^[=+\-@\t\r]/;

function quote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function cell(v: CsvCell): string {
  if (v === null) return '';
  if (typeof v !== 'string') return quote(v.raw);
  return quote(FORMULA_START.test(v) ? `'${v}` : v);
}

/** Integer minor units as a plain decimal in the currency's own digits: -1250 USD → "-12.50", 500 JPY → "500". */
export function csvNumber(minor: number, currency: string): RawCell {
  const digits = currencyExponent(currency);
  const abs = String(Math.abs(Math.trunc(minor))).padStart(digits + 1, '0');
  const whole = digits === 0 ? abs : `${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
  return { raw: minor < 0 ? `-${whole}` : whole };
}

export function csvRaw(s: string): RawCell {
  return { raw: s };
}

/** The whole file: a byte order mark (Excel reads UTF-8 only with one), the header, then the rows. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header.map((h) => quote(h)).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
