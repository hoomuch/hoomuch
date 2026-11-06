/**
 * Read-model benchmark: the D1 work behind each page, in process, on the seeded database.
 *
 *   npm run bench:seed                     # once: bench/.state/bench.sqlite + users.json
 *   npm run bench:readmodels               # writes bench/results/readmodels-<label>.json
 *   node bench/compare.mjs <base.json> <head.json>
 *
 * Each case runs BENCH_WARMUP times unmeasured (page cache, JIT, statement compile), then
 * BENCH_ITERATIONS times, and reports p50/p95/p99 and the D1 round trips one call makes. SQLite
 * here is the same engine D1 runs; what this leaves out is the network between a Worker and D1,
 * which bench/README.md budgets per round trip.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'vitest';
import { addMonths } from '../src/data/calendar';
import { getCalendarMonth } from '../src/data/calendar';
import { getConnectionDetail, listConnectionSummaries } from '../src/data/connections';
import { dominantMrrCurrency } from '../src/data/currency';
import * as dashboardModule from '../src/data/dashboard';
import { getDashboardData } from '../src/data/dashboard';
import { listTransactions } from '../src/data/transactions';
import { getCurrencySource, getSessionWithUser } from '../src/db/queries';
import type { Bindings, SessionUser } from '../src/env';
import { addDays, zonedDayKey } from '../src/lib/time';
import { benchD1 } from './d1';

const STATE = 'bench/.state';
const DB_FILE = process.env.BENCH_DB ?? `${STATE}/bench.sqlite`;
const USERS_FILE = process.env.BENCH_USERS ?? `${STATE}/users.json`;
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 60);
/** Only cases whose name contains this (e.g. "large/" or "transactions"). */
const ONLY = process.env.BENCH_ONLY ?? '';
/** Print where each case's time goes, statement by statement (BENCH_PROFILE=1). */
const PROFILE = process.env.BENCH_PROFILE === '1';

interface SeedUser {
  persona: 'small' | 'medium' | 'large';
  userId: string;
  token: string;
  timeZone: string;
  currency: string;
  connectionIds: string[];
}

export interface CaseResult {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** D1 calls one run makes (a batch counts once). */
  roundTrips: number;
}

/** Nearest-rank percentile of ascending samples. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function label(): string {
  if (process.env.BENCH_LABEL) return process.env.BENCH_LABEL;
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain -- src migrations', { encoding: 'utf8' }).trim() !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'local';
  }
}

it('read models on the seeded database', async () => {
  if (!existsSync(DB_FILE) || !existsSync(USERS_FILE)) {
    throw new Error(`No seeded database at ${DB_FILE}: run \`npm run bench:seed\` first.`);
  }
  const seed = JSON.parse(readFileSync(USERS_FILE, 'utf8')) as { seededAt: number; users: SeedUser[] };
  const ageHours = (Date.now() - seed.seededAt) / 3_600_000;
  if (ageHours > 24) console.warn(`The seed is ${ageHours.toFixed(0)} hours old: today has no data. Re-seed for fair numbers.`);

  const sqlite = new DatabaseSync(DB_FILE, { readOnly: true });
  const t = benchD1(sqlite);
  // Only DB is read on these paths (no provider calls, no secrets).
  const env = { DB: t.db } as unknown as Bindings;

  // One representative user per persona: the first of each.
  const personas = (['small', 'medium', 'large'] as const)
    .map((p) => seed.users.find((u) => u.persona === p))
    .filter((u): u is SeedUser => u !== undefined);

  const cases: Array<{ name: string; run: () => Promise<unknown> }> = [];
  for (const u of personas) {
    const user: SessionUser = { id: u.userId, email: `${u.persona}@example.com`, baseCurrency: u.currency, timeZone: u.timeZone };
    const today = zonedDayKey(Date.now(), u.timeZone);
    const month = today.slice(0, 7);
    const sessionId = await crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(u.token))
      .then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''));
    const P = u.persona;
    const last39 = (await listTransactions(env, user, { provider: null, page: 39 })).items.at(-1);
    const page39Last = last39 ? { at: last39.occurredAt, connectionId: last39.connectionId, externalId: last39.externalId } : null;
    cases.push(
      { name: `${P}/session`, run: () => getSessionWithUser(env.DB, sessionId, Date.now(), Date.now() - 90 * 86_400_000) },
      { name: `${P}/dashboard:7`, run: () => getDashboardData(env, user, 7) },
      { name: `${P}/dashboard:30`, run: () => getDashboardData(env, user, 30) },
      { name: `${P}/dashboard:90`, run: () => getDashboardData(env, user, 90) },
      { name: `${P}/calendar:this-month`, run: () => getCalendarMonth(env, user, month) },
      { name: `${P}/calendar:6-months-ago`, run: () => getCalendarMonth(env, user, addMonths(month, -6)) },
      { name: `${P}/currency:dominant`, run: () => dominantMrrCurrency(env, user.id) },
      { name: `${P}/transactions:page-1`, run: () => listTransactions(env, user, { provider: null, page: 1 }) },
      { name: `${P}/transactions:page-40`, run: () => listTransactions(env, user, { provider: null, page: 40 }) },
      {
        // Clicking Next onto page 40: with cursors, the page past page 39's last row; a version
        // without them ignores `before` and reads page 40 by offset, which is what its link does.
        name: `${P}/transactions:next-to-40`,
        run: async () => listTransactions(env, user, { provider: null, page: 40, before: page39Last } as Parameters<typeof listTransactions>[2]),
      },
      { name: `${P}/transactions:day`, run: () => listTransactions(env, user, { provider: null, page: 1, day: addDays(today, -1) }) },
      { name: `${P}/transactions:stripe`, run: () => listTransactions(env, user, { provider: 'stripe', page: 1 }) },
      { name: `${P}/connection`, run: () => getConnectionDetail(env, user, u.connectionIds[0]!) },
      { name: `${P}/connections`, run: () => listConnectionSummaries(env, user.id) },
      {
        // GET /dashboard as the route makes it (routes/dashboard.tsx), session lookup included. Older
        // versions asked D1 for the currency source separately (a session row without it), and read
        // the dashboard, the connections and the calendar in three calls (no getDashboardPage).
        name: `${P}/page:dashboard`,
        run: async () => {
          const row = await getSessionWithUser(env.DB, sessionId, Date.now(), Date.now() - 90 * 86_400_000);
          if (!row || !('currency_source' in row)) await getCurrencySource(env.DB, user.id);
          if ('getDashboardPage' in dashboardModule) await dashboardModule.getDashboardPage(env, user, 30, month);
          else await Promise.all([getDashboardData(env, user, 30), listConnectionSummaries(env, user.id), getCalendarMonth(env, user, month)]);
        },
      },
    );
  }

  const results: Record<string, CaseResult> = {};
  const lines: string[] = [];
  for (const c of cases.filter((c) => c.name.includes(ONLY))) {
    for (let i = 0; i < WARMUP; i++) await c.run();
    t.takeProfile();
    const before = t.roundTrips();
    await c.run();
    const roundTrips = t.roundTrips() - before;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      await c.run();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const profile = t.takeProfile();
    if (PROFILE) {
      for (const p of profile.slice(0, 4)) {
        lines.push(`    ${(p.ms / p.calls).toFixed(2).padStart(8)} ms/call  ${p.sql.slice(0, 140)}`);
      }
    }
    const r: CaseResult = {
      n: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      max: samples[samples.length - 1]!,
      mean: samples.reduce((s, x) => s + x, 0) / samples.length,
      roundTrips,
    };
    results[c.name] = r;
    const ms = (x: number) => x.toFixed(2).padStart(9);
    lines.push(`${c.name.padEnd(36)}${ms(r.p50)}${ms(r.p95)}${ms(r.p99)}${ms(r.max)}${String(roundTrips).padStart(6)}`);
  }
  sqlite.close();

  const out = {
    kind: 'readmodels',
    label: label(),
    at: new Date().toISOString(),
    node: process.version,
    sqlite: (new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
    warmup: WARMUP,
    iterations: ITERATIONS,
    cases: results,
  };
  const dir = process.env.BENCH_OUT ?? 'bench/results';
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/readmodels-${out.label}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  // Straight to the terminal: vitest holds back console output of passing tests.
  process.stdout.write(
    [`${'case'.padEnd(36)}${'p50 ms'.padStart(9)}${'p95 ms'.padStart(9)}${'p99 ms'.padStart(9)}${'max ms'.padStart(9)}${'trips'.padStart(6)}`, ...lines, `→ ${file}`, ''].join('\n'),
  );
});
