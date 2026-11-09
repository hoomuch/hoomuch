/**
 * The embeddable badge (GET /badge/<slug>.svg, SPEC F-21): "Verified MRR | $12,340". Owner: Experience.
 *
 * A plain SVG string, so an <img> on any site, a README or a Markdown file shows it. It carries no
 * owner-typed text, only fixed words and a formatted amount; everything is escaped all the same.
 * Text widths come from a table of Verdana's advances at 11px, and `textLength` pins each run to
 * that width, so a fallback font can't overflow the box.
 */

import { formatMoney } from '../lib/money';

export type BadgeState = 'verified' | 'stale' | 'missing';

/** Verdana 11px advances, rounded to 0.1px; anything else counts as a wide letter. */
const ADVANCE: Record<string, number> = {
  ' ': 3.9, ',': 4.0, '.': 4.0, $: 7.0, '-': 4.6,
  0: 7.0, 1: 7.0, 2: 7.0, 3: 7.0, 4: 7.0, 5: 7.0, 6: 7.0, 7: 7.0, 8: 7.0, 9: 7.0,
  M: 8.9, R: 7.6, V: 7.5, a: 6.7, d: 6.9, e: 6.6, f: 3.9, h: 7.0, i: 3.0, m: 10.7, n: 7.0, o: 6.7,
  p: 6.9, r: 4.7, t: 4.3, u: 7.0, c: 5.8,
};

function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ADVANCE[ch] ?? 7.5;
  return Math.round(w * 10) / 10;
}

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

const INK = '#15181e';
const LIGHT = '#f4f5f7';
const BLUE = '#62a7fa';
/** The value's background: green while the figures are current, grey once they aren't. */
const VALUE_FILL: Record<BadgeState, string> = { verified: '#137d41', stale: '#6b7280', missing: '#6b7280' };
const LABEL: Record<BadgeState, string> = { verified: 'Verified MRR', stale: 'MRR, not updated', missing: 'hoomuch' };

const H = 20;
const PAD = 6;
const MARK = 14;

/** hoomuch's mark (favicon.svg's rings) at 14px, on the ink half. */
const MARK_SVG =
  `<g transform="translate(${PAD} 3) scale(0.4375)" fill="none" stroke-width="3">` +
  `<circle cx="12.5" cy="16" r="7" stroke="${LIGHT}"/><circle cx="19.5" cy="16" r="7" stroke="${BLUE}"/>` +
  `<path d="M19.5 16A7 7 0 0 1 9 22.06" stroke="${INK}" stroke-width="5"/><path d="M19.47 15.39A7 7 0 0 1 8.49 21.73" stroke="${LIGHT}"/>` +
  `<path d="M12.5 16A7 7 0 0 1 23 9.94" stroke="${INK}" stroke-width="5"/><path d="M12.53 16.61A7 7 0 0 1 23.52 10.27" stroke="${BLUE}"/></g>`;

/** The badge for an MRR in USD minor units, or the "not found" one when `mrr` is null. */
export function badgeSvg(state: BadgeState, mrr: number | null): string {
  const label = LABEL[state];
  const value = state === 'missing' || mrr === null ? 'not found' : formatMoney(mrr, 'USD', { whole: true });
  const labelW = textWidth(label);
  const valueW = textWidth(value);
  const left = Math.ceil(PAD + MARK + 4 + labelW + PAD);
  const right = Math.ceil(PAD + valueW + PAD);
  const width = left + right;
  const title =
    state === 'verified'
      ? `MRR ${value}, verified by hoomuch`
      : state === 'stale'
        ? `MRR ${value}, not updated recently (hoomuch)`
        : 'hoomuch: no public page here';
  const text = (x: number, w: number, s: string) =>
    `<text x="${x}" y="14" textLength="${w}" lengthAdjust="spacingAndGlyphs">${escapeXml(s)}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="${escapeXml(title)}">` +
    `<title>${escapeXml(title)}</title>` +
    `<clipPath id="r"><rect width="${width}" height="${H}" rx="4"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${left}" height="${H}" fill="${INK}"/><rect x="${left}" width="${right}" height="${H}" fill="${VALUE_FILL[state]}"/></g>` +
    MARK_SVG +
    `<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-rendering="geometricPrecision">` +
    text(PAD + MARK + 4, labelW, label) +
    text(left + PAD, valueW, value) +
    `</g></svg>`
  );
}
