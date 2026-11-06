#!/usr/bin/env node
/**
 * Compares two benchmark results (bench/readmodels.bench.ts or bench/k6/app.js output, which share
 * the `cases: { name: { p50, p95, p99 } }` shape) and fails on a p95 regression.
 *
 *   node bench/compare.mjs <base.json> <head.json> [--threshold 10] [--min-ms 1]
 *
 * A case regresses when its p95 is more than --threshold percent AND more than --min-ms slower:
 * sub-millisecond cases move by tens of percent on scheduler noise alone. Results should come from
 * the same machine, back to back (bench/ab.mjs does that); absolute numbers from different
 * machines or CI runners aren't comparable. Exit code 1 on any regression.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { threshold: { type: 'string', default: '10' }, 'min-ms': { type: 'string', default: '1' } },
});
if (positionals.length !== 2) {
  console.error('usage: node bench/compare.mjs <base.json> <head.json> [--threshold 10] [--min-ms 1]');
  process.exit(2);
}
const THRESHOLD = Number(values.threshold);
const MIN_MS = Number(values['min-ms']);
const [base, head] = positionals.map((f) => JSON.parse(readFileSync(f, 'utf8')));

const names = [...new Set([...Object.keys(base.cases), ...Object.keys(head.cases)])];
const fmt = (x) => (x === undefined ? '—' : x.toFixed(2));
const rows = [];
let regressions = 0;
let improvements = 0;
for (const name of names) {
  const b = base.cases[name];
  const h = head.cases[name];
  if (!b || !h) {
    rows.push([name, fmt(b?.p95), fmt(h?.p95), '', b ? 'removed' : 'new']);
    continue;
  }
  const delta = h.p95 - b.p95;
  const pct = b.p95 > 0 ? (delta / b.p95) * 100 : 0;
  let verdict = '';
  if (pct > THRESHOLD && delta > MIN_MS) {
    verdict = 'REGRESSION';
    regressions++;
  } else if (-pct > THRESHOLD && -delta > MIN_MS) {
    verdict = `${(b.p95 / Math.max(h.p95, 1e-9)).toFixed(1)}x faster`;
    improvements++;
  }
  const trips = b.roundTrips !== undefined && b.roundTrips !== h.roundTrips ? `  trips ${b.roundTrips}→${h.roundTrips}` : '';
  rows.push([name, fmt(b.p95), fmt(h.p95), `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, verdict + trips]);
}

const widths = [Math.max(4, ...rows.map((r) => r[0].length)), 10, 10, 9];
const line = (r) => `${r[0].padEnd(widths[0])}  ${r[1].padStart(widths[1])}  ${r[2].padStart(widths[2])}  ${r[3].padStart(widths[3])}  ${r[4]}`;
console.log(`p95 ms: ${base.label} → ${head.label} (regression: > ${THRESHOLD}% and > ${MIN_MS} ms)`);
console.log(line(['case', 'base p95', 'head p95', 'change', '']));
for (const r of rows) console.log(line(r));
console.log(`${improvements} faster, ${regressions} regressed, ${names.length - improvements - regressions} within noise`);
process.exit(regressions > 0 ? 1 : 0);
