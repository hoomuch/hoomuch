#!/usr/bin/env node
/**
 * A/B read-model benchmark: a git ref (default `main`) against the working tree, on the same
 * machine, the same seeded data, back to back.
 *
 *   npm run bench:ab                       # main vs. the working tree
 *   npm run bench:ab -- --base v1.1.0 --rounds 5 --only large/
 *
 * 1. Checks the base ref out as a worktree under bench/.state/ab/ and copies today's harness
 *    (bench/*.ts) into it, so both sides are measured the same way.
 * 2. Seeds one database with the BASE migrations, then gives the head a copy upgraded with the
 *    migrations the base doesn't have, as `wrangler d1 migrations apply` does on deploy.
 * 3. Runs the benchmark alternately (base, head, base, head, …) so drift in machine load hits both,
 *    takes each case's median over the rounds, and runs bench/compare.mjs on the two.
 *
 * Exit code 1 when a case's p95 regressed by more than --threshold percent (default 10).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'main' },
    rounds: { type: 'string', default: '3' },
    scale: { type: 'string', default: '1' },
    iterations: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '5' },
    only: { type: 'string', default: '' },
    threshold: { type: 'string', default: '10' },
    reseed: { type: 'boolean', default: false },
  },
});

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const baseSha = git('rev-parse', '--short', args.base);
const headSha = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'src', 'migrations') !== '';
const headLabel = `${headSha}${dirty ? '+wt' : ''}`;

const STATE = join(ROOT, 'bench/.state/ab');
const OUT = join(ROOT, 'bench/results/ab');
const tree = join(STATE, `base-${baseSha}`);
mkdirSync(STATE, { recursive: true });
mkdirSync(OUT, { recursive: true });

// ---- the base checkout, with today's harness ----
if (!existsSync(tree)) {
  git('worktree', 'prune');
  git('worktree', 'add', '--detach', tree, baseSha);
}
mkdirSync(join(tree, 'bench'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'bench')).filter((f) => f.endsWith('.ts'))) {
  copyFileSync(join(ROOT, 'bench', f), join(tree, 'bench', f));
}

// ---- data: seeded with the base schema, upgraded for the head ----
const baseDb = join(STATE, `base-${baseSha}-x${args.scale}.sqlite`);
const headDb = join(STATE, `head-x${args.scale}.sqlite`);
const users = join(STATE, `users-${baseSha}-x${args.scale}.json`);
const today = new Date().toISOString().slice(0, 10);
const fresh = existsSync(users) && new Date(JSON.parse(readFileSync(users, 'utf8')).seededAt).toISOString().slice(0, 10) === today;
if (args.reseed || !fresh || !existsSync(baseDb)) {
  rmSync(baseDb, { force: true });
  execFileSync(
    process.execPath,
    [join(ROOT, 'bench/seed.mjs'), '--db', baseDb, '--migrate', '--migrations', join(tree, 'migrations'), '--scale', args.scale, '--users-out', users],
    { stdio: 'inherit' },
  );
}
copyFileSync(baseDb, headDb);
const baseMigrations = new Set(readdirSync(join(tree, 'migrations')));
const pending = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql') && !baseMigrations.has(f)).sort();
{
  const db = new DatabaseSync(headDb);
  for (const f of pending) db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  db.close();
}
console.error(`base ${baseSha}: ${baseDb}\nhead ${headLabel}: ${headDb}${pending.length ? ` (+ ${pending.join(', ')})` : ''}`);

// ---- alternate rounds ----
function run(side, cwd, db, round) {
  const label = `${side}-r${round}`;
  const r = spawnSync('npx', ['vitest', 'run', '--config', 'bench/vitest.config.ts'], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      BENCH_DB: db,
      BENCH_USERS: users,
      BENCH_LABEL: label,
      BENCH_OUT: OUT,
      BENCH_ITERATIONS: args.iterations,
      BENCH_WARMUP: args.warmup,
      BENCH_ONLY: args.only,
    },
  });
  if (r.status !== 0) throw new Error(`${side} round ${round} failed`);
  return JSON.parse(readFileSync(join(OUT, `readmodels-${label}.json`), 'utf8'));
}
const rounds = { base: [], head: [] };
for (let i = 1; i <= Number(args.rounds); i++) {
  console.error(`\n== round ${i}/${args.rounds}: base ${baseSha}`);
  rounds.base.push(run('base', tree, baseDb, i));
  console.error(`\n== round ${i}/${args.rounds}: head ${headLabel}`);
  rounds.head.push(run('head', ROOT, headDb, i));
}

// ---- median of each metric over the rounds ----
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function combine(results, label) {
  const cases = {};
  for (const name of Object.keys(results[0].cases)) {
    const all = results.map((r) => r.cases[name]).filter(Boolean);
    cases[name] = Object.fromEntries(
      Object.keys(all[0]).map((k) => [k, k === 'roundTrips' || k === 'n' ? all[0][k] : median(all.map((c) => c[k]))]),
    );
  }
  return { ...results[0], label, rounds: results.length, cases };
}
const baseFile = join(OUT, 'base.json');
const headFile = join(OUT, 'head.json');
writeFileSync(baseFile, JSON.stringify(combine(rounds.base, baseSha), null, 2));
writeFileSync(headFile, JSON.stringify(combine(rounds.head, headLabel), null, 2));

console.error('');
const cmp = spawnSync(process.execPath, [join(ROOT, 'bench/compare.mjs'), baseFile, headFile, '--threshold', args.threshold], { stdio: 'inherit' });
process.exit(cmp.status ?? 1);
