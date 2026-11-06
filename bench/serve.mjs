#!/usr/bin/env node
/**
 * End-to-end bench server: the real Worker under `wrangler dev`, on a D1 seeded by bench/seed.mjs,
 * optionally driven by the k6 load test (bench/k6/app.js).
 *
 *   node bench/serve.mjs                              # seed if needed, serve until Ctrl-C
 *   node bench/serve.mjs --profile smoke              # ... run k6 once, stop, exit with k6's code
 *   RATE=20 node bench/serve.mjs --profile load --label abc123 -- --quiet   # after --: k6 flags
 *
 *   --profile <name>  smoke | load | stress | spike | soak (bench/k6/app.js); without it, just serve
 *   --label <name>    results file suffix, bench/results/k6-<profile>-<label>.json (LABEL, "local")
 *   --reseed          wipe the bench D1 and seed it again
 *   --scale <n>       bench/seed.mjs --scale, used when seeding (0.1 for a quick, small database)
 *   --port <n>        8788
 *   --watch           serve src/ live, rebuilding on every save, instead of a frozen snapshot
 * k6 settings (RATE, STEPS, SLO_SCALE, ...) come from the environment; see bench/k6/app.js.
 *
 * By default the Worker is frozen at start: `wrangler deploy --dry-run` bundles it exactly as a
 * deploy would, and `wrangler dev` serves that bundle, so saving a file in src/ mid-run doesn't
 * reload the server under load or mix two versions into one result. --watch serves src/ the way
 * `npm run dev` does. Either way the bundle is built with NODE_ENV=production
 * (BENCH_NODE_ENV to change it): `wrangler dev` otherwise bundles React's development build, whose
 * server rendering is far slower than what runs in production.
 *
 * Nothing here touches the developer's own `.wrangler` dev data or `.dev.vars`: the configs, a
 * throwaway ENCRYPTION_KEY, the snapshot, the D1 (`--persist-to`) and the server log all live in
 * bench/.state/wrangler/. The config is generated from wrangler.jsonc on every start, so it can't
 * drift, minus the `ratelimits` bindings: local miniflare enforces them (300 requests a minute per
 * IP), which would turn a load test into a 429 test, and without them the app applies only its D1
 * limits (src/lib/rate-limit.ts). Paths become absolute because the config lives in another folder.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'bench/.state');
const WR_DIR = join(STATE, 'wrangler');
/** Bundles src/ and runs the custom build: --watch serves it, and the snapshot is built from it. */
const CONFIG = join(WR_DIR, 'wrangler.json');
/** Serves the snapshot: the bundle in FROZEN/worker, a copy of public/ in FROZEN/public. */
const FROZEN_CONFIG = join(WR_DIR, 'wrangler.frozen.json');
const FROZEN = join(WR_DIR, 'frozen');
const PERSIST = join(WR_DIR, 'persist');
const LOG = join(WR_DIR, 'wrangler.log');
const USERS = join(STATE, 'users-e2e.json');
const RESULTS = join(ROOT, 'bench/results');
// Resolved like an import, so a checkout nested in this one (bench/ab.mjs) finds its node_modules.
const WRANGLER = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin/wrangler.js');
const K6_SCRIPT = join(ROOT, 'bench/k6/app.js');
const HOST = '127.0.0.1';
const DAY = 86_400_000;
/** With --watch, the first start builds the CSS and the browser bundle before the Worker answers. */
const READY_TIMEOUT_MS = Number(process.env.BENCH_READY_TIMEOUT_MS ?? 180_000);
const PROFILES = ['smoke', 'load', 'stress', 'spike', 'soak'];

const { values: args, positionals: k6Args } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string' },
    label: { type: 'string' },
    reseed: { type: 'boolean', default: false },
    scale: { type: 'string' },
    port: { type: 'string', default: '8788' },
    watch: { type: 'boolean', default: false },
  },
});
if (args.profile !== undefined && !PROFILES.includes(args.profile)) fail(`--profile must be one of ${PROFILES.join(', ')}`);
if (k6Args.length && !args.profile) fail('k6 arguments (after --) need --profile');
if (args.scale !== undefined && !(Number(args.scale) > 0)) fail('--scale must be a positive number');
const PORT = Number(args.port);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail('--port must be a port number');
const BASE_URL = `http://${HOST}:${PORT}`;

function fail(message) {
  console.error(`serve: ${message}`);
  process.exit(2);
}
const say = (message) => console.error(`serve: ${message}`);
const rel = (p) => relative(ROOT, p) || '.';

const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NODE_ENV: process.env.BENCH_NODE_ENV ?? 'production' };

function wrangler(argv, what) {
  const r = spawnSync(process.execPath, [WRANGLER, ...argv], { cwd: ROOT, env: wranglerEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr);
    fail(`${what} failed`);
  }
  return r.stdout;
}

// ---------- the bench wrangler configs ----------

/**
 * wrangler.jsonc as wrangler reads it (comments and all), through wrangler's own reader. In a
 * child process: loading wrangler costs ~300 MB that would otherwise sit in this process all run.
 */
function readWranglerConfig() {
  const script =
    "import { experimental_readRawConfig as read } from 'wrangler';" +
    'process.stdout.write(JSON.stringify(read({ config: process.argv[1] }).rawConfig));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, join(ROOT, 'wrangler.jsonc')], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) fail(`couldn't read wrangler.jsonc:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

function writeBenchConfig() {
  const cfg = readWranglerConfig();
  const abs = (p) => (isAbsolute(p) ? p : resolve(ROOT, p));
  delete cfg.$schema;
  delete cfg.ratelimits;
  // Its own name keeps it out of the way of a `npm run dev` in the dev registry.
  cfg.name = `${cfg.name}-bench`;
  if (cfg.main) cfg.main = abs(cfg.main);
  if (cfg.tsconfig) cfg.tsconfig = abs(cfg.tsconfig);
  if (cfg.base_dir) cfg.base_dir = abs(cfg.base_dir);
  if (cfg.build) {
    cfg.build.cwd = abs(cfg.build.cwd ?? '.');
    if (cfg.build.watch_dir) cfg.build.watch_dir = Array.isArray(cfg.build.watch_dir) ? cfg.build.watch_dir.map(abs) : abs(cfg.build.watch_dir);
  }
  if (cfg.assets?.directory) cfg.assets.directory = abs(cfg.assets.directory);
  for (const db of cfg.d1_databases ?? []) db.migrations_dir = abs(db.migrations_dir ?? 'migrations');
  if (cfg.env) say('wrangler.jsonc has [env] sections; the bench config uses the top level only');
  const binding = cfg.d1_databases?.[0]?.binding;
  if (!binding) fail('wrangler.jsonc has no d1_databases');

  mkdirSync(WR_DIR, { recursive: true });
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  // Next to the configs, where wrangler looks. A fresh key every start: nothing in the seed is
  // encrypted with it (the seeded provider keys are placeholders).
  writeFileSync(join(WR_DIR, '.dev.vars'), `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  return { cfg, binding };
}

function git(...argv) {
  const r = spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Bundles the Worker as `wrangler deploy` would and writes the config that serves the bundle. */
function freeze(cfg) {
  const started = Date.now();
  rmSync(FROZEN, { recursive: true, force: true });
  // Runs the custom build (CSS, browser bundle) first, as a deploy does. Nothing is uploaded.
  wrangler(['deploy', '--dry-run', '--outdir', join(FROZEN, 'worker'), '--config', CONFIG], 'wrangler deploy --dry-run');
  const frozen = structuredClone(cfg);
  frozen.main = join(FROZEN, 'worker/index.js');
  frozen.no_bundle = true;
  delete frozen.build;
  if (cfg.assets?.directory) {
    cpSync(cfg.assets.directory, join(FROZEN, 'public'), { recursive: true });
    frozen.assets.directory = join(FROZEN, 'public');
  }
  writeFileSync(FROZEN_CONFIG, `${JSON.stringify(frozen, null, 2)}\n`);
  const sha = git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain', '--', 'src', 'migrations') !== '';
  say(`froze the Worker at ${sha || 'an unknown commit'}${dirty ? ' plus uncommitted changes in src/ or migrations/' : ''} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

// ---------- D1: migrate, then seed once ----------

function migrate(binding) {
  say(`applying migrations to the bench D1 (${rel(PERSIST)})`);
  const out = wrangler(['d1', 'migrations', 'apply', binding, '--local', '--config', CONFIG, '--persist-to', PERSIST], 'wrangler d1 migrations apply');
  // Wrangler reprints the table after each migration; count the names, not the rows.
  const applied = new Set([...out.matchAll(/│\s*(\S+\.sql)\s*│\s*✅/g)].map((m) => m[1]));
  if (applied.size) say(`applied ${applied.size} migration(s)`);
}

/** The D1's SQLite file under the persist dir (miniflare names it by a hash of the database id). */
function d1File() {
  const dir = join(PERSIST, 'v3/d1/miniflare-D1DatabaseObject');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite') : [];
  if (files.length !== 1) fail(`expected one D1 file in ${rel(dir)}, found ${files.length ? files.join(', ') : 'none'}; try --reseed`);
  return join(dir, files[0]);
}

function userCount(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  } finally {
    db.close();
  }
}

function seed(file) {
  say(`seeding ${rel(file)}${args.scale ? ` at scale ${args.scale}` : ''}`);
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'bench/seed.mjs'), '--db', file, '--users-out', USERS, ...(args.scale ? ['--scale', args.scale] : [])],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (r.status !== 0) fail('bench/seed.mjs failed');
}

function readSeed() {
  const s = JSON.parse(readFileSync(USERS, 'utf8'));
  const ageMs = Date.now() - s.seededAt;
  // Seeded sessions expire 29 days out and the app extends any within 15 days of expiry (a D1
  // write on every request), so past 14 days the numbers stop meaning "read-only page views".
  if (ageMs >= 14 * DAY) fail(`the seed is ${Math.floor(ageMs / DAY)} days old: its sessions now get extended on every request. Run with --reseed.`);
  if (ageMs > DAY) say(`warning: the seed is ${Math.floor(ageMs / 3_600_000)} hours old, so today has no data; --reseed for fair numbers`);
  if (args.scale !== undefined && Number(args.scale) !== s.scale) {
    say(`warning: the existing seed is at scale ${s.scale}, not ${args.scale}; --scale only applies when seeding (add --reseed)`);
  }
  return s;
}

function prepareDatabase(binding) {
  if (args.reseed) {
    say(`--reseed: removing ${rel(PERSIST)} and ${rel(USERS)}`);
    rmSync(PERSIST, { recursive: true, force: true });
    rmSync(USERS, { force: true });
  }
  migrate(binding);
  const file = d1File();
  const n = userCount(file);
  if (n === 0) seed(file);
  else if (!existsSync(USERS)) fail(`${rel(file)} has ${n} users but ${rel(USERS)} is missing (it holds their session tokens); run with --reseed`);
  const s = readSeed();
  const mb = Math.round(statSync(file).size / 1e6);
  say(`D1 ${rel(file)}: ${s.users.length} users, ${s.counts.transactions.toLocaleString('en')} transactions, ${mb} MB, scale ${s.scale}`);
  return s;
}

// ---------- wrangler dev ----------

function portFree(port) {
  return new Promise((done) => {
    const srv = createServer();
    srv.once('error', () => done(false));
    srv.listen(port, HOST, () => srv.close(() => done(true)));
  });
}

let server = null;

/**
 * Resident memory of the workerd processes in the wrangler dev group (the Worker and its local D1),
 * in MB, or null where `ps` can't say (Windows).
 */
function workerdRssMb() {
  if (!server) return null;
  const r = spawnSync('ps', ['-A', '-o', 'pgid=,rss=,comm='], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  let kb = 0;
  let found = false;
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) === server.pid && m[3].includes('workerd')) {
      kb += Number(m[2]);
      found = true;
    }
  }
  return found ? Math.round(kb / 1024) : null;
}

/**
 * Prints the run's workerd memory and adds it to the k6 results file. Growth is measured from a
 * third of the way in, after the page cache and the JIT have warmed up: steady growth after that,
 * over a soak, is what a leak looks like.
 */
function reportMemory(samples, profile, label) {
  if (samples.length < 2) return;
  const mbs = samples.map((x) => x.mb);
  const end = samples[samples.length - 1];
  const third = samples.find((x) => x.s >= end.s / 3) ?? samples[0];
  const memory = {
    unit: 'MB',
    startMb: samples[0].mb,
    thirdMb: third.mb,
    endMb: end.mb,
    maxMb: Math.max(...mbs),
    growthAfterWarmup: third.mb > 0 ? Math.round(((end.mb - third.mb) / third.mb) * 1000) / 1000 : null,
    samples,
  };
  say(
    `workerd memory: ${memory.startMb} MB at the start, ${memory.thirdMb} MB a third in, ${memory.endMb} MB at the end, ` +
      `${memory.maxMb} MB at most; ${memory.growthAfterWarmup === null ? '?' : `${(memory.growthAfterWarmup * 100).toFixed(1)}%`} after warm-up`,
  );
  const file = join(RESULTS, `k6-${profile}-${String(label).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  if (!existsSync(file)) return;
  const results = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...results, memory }, null, 2));
}

function startServer(config, { echo }) {
  const log = createWriteStream(LOG, { flags: 'w' });
  // Its own process group, so stopping it also stops workerd and any build it is running.
  server = spawn(
    process.execPath,
    [
      WRANGLER, 'dev', '--config', config, '--persist-to', PERSIST, '--ip', HOST, '--port', String(PORT),
      '--log-level', process.env.BENCH_WRANGLER_LOG_LEVEL ?? 'warn', '--show-interactive-dev-session=false',
    ],
    { cwd: ROOT, env: wranglerEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      log.write(chunk);
      if (echo) process.stderr.write(chunk);
    });
  }
  server.once('exit', () => log.end());
}

function tail(file, lines = 40) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function waitReady() {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (server.exitCode !== null || server.signalCode !== null) {
      fail(`wrangler dev exited (${server.exitCode ?? server.signalCode}) before it was ready:\n${tail(LOG)}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return Date.now() - started;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  await stopServer();
  fail(`wrangler dev wasn't ready within ${READY_TIMEOUT_MS / 1000} s:\n${tail(LOG)}`);
}

/**
 * One signed-in page per persona and page kind, twice: proves the cookie and the seed work (a 303
 * here means the sessions don't match the D1) and warms the Worker and SQLite before k6 measures.
 */
async function preflight(seedData) {
  const started = Date.now();
  const firsts = ['small', 'medium', 'large'].map((p) => seedData.users.find((u) => u.persona === p)).filter(Boolean);
  for (let round = 0; round < 2; round++) {
    for (const u of firsts) {
      for (const path of ['/dashboard', '/transactions', '/transactions?page=20', '/connections', `/connections/${u.connectionIds[0]}`, '/settings']) {
        const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: `hm_session=${u.token}` }, redirect: 'manual' });
        const body = await res.text();
        if (res.status !== 200 || !body.includes('<script id="hm-page" type="application/json">')) {
          await stopServer();
          fail(`preflight GET ${path} as a ${u.persona} user: ${res.status} ${res.headers.get('location') ?? ''}\n${body.slice(0, 300)}`);
        }
      }
    }
  }
  return Date.now() - started;
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((done) => server.once('exit', done));
  const killGroup = (signal) => {
    try {
      process.kill(-server.pid, signal);
    } catch {
      // already gone
    }
  };
  killGroup('SIGINT');
  const timer = setTimeout(() => killGroup('SIGKILL'), 10_000);
  await exited;
  clearTimeout(timer);
}

// Whatever happens, don't leave workerd running.
process.on('exit', () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

// ---------- main ----------

const { cfg, binding } = writeBenchConfig();
const seedData = prepareDatabase(binding);
if (!(await portFree(PORT))) fail(`port ${PORT} is in use (another bench server?); stop it or pass --port`);
if (!args.watch) freeze(cfg);

say(`starting wrangler dev on ${BASE_URL}, ${args.watch ? 'watching src/' : 'frozen'}, NODE_ENV=${wranglerEnv.NODE_ENV} (log: ${rel(LOG)})`);
startServer(args.watch ? CONFIG : FROZEN_CONFIG, { echo: !args.profile });
const readyMs = await waitReady();
say(`ready in ${(readyMs / 1000).toFixed(1)} s`);
const warmMs = await preflight(seedData);
say(`preflight and warm-up: ${(warmMs / 1000).toFixed(1)} s`);

if (!args.profile) {
  say(`serving ${BASE_URL} with ${rel(USERS)}; Ctrl-C to stop`);
  say(`e.g. curl -H "Cookie: hm_session=${seedData.users[0].token}" ${BASE_URL}/dashboard`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    say('stopping');
    await stopServer();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.once('exit', (code, signal) => {
    if (!stopping) fail(`wrangler dev exited (${code ?? signal}):\n${tail(LOG)}`);
  });
} else {
  mkdirSync(RESULTS, { recursive: true });
  const label = args.label ?? process.env.LABEL ?? 'local';
  say(`k6 run ${rel(K6_SCRIPT)} PROFILE=${args.profile} LABEL=${label}`);
  const k6 = spawn('k6', ['run', ...k6Args, K6_SCRIPT], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, BASE_URL, USERS, PROFILE: args.profile, LABEL: label, RESULTS_DIR: rel(RESULTS) },
  });
  // Ctrl-C reaches k6 directly (same process group): it stops and still writes its summary. A
  // SIGTERM sent to this process alone is passed on.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => k6.kill('SIGTERM'));
  let serverDied = false;
  server.once('exit', () => {
    serverDied = true;
  });
  // Memory every 10 s, so a soak shows growth the latency numbers can't.
  const startedAt = Date.now();
  const memory = [];
  const sample = () => {
    const mb = workerdRssMb();
    if (mb !== null) memory.push({ s: Math.round((Date.now() - startedAt) / 1000), mb });
  };
  sample();
  const sampler = setInterval(sample, 10_000);
  const code = await new Promise((done) => {
    k6.once('error', (e) => {
      say(`couldn't run k6: ${e.message}`);
      done(2);
    });
    k6.once('exit', (c, signal) => done(c ?? (signal ? 1 : 0)));
  });
  clearInterval(sampler);
  if (!serverDied) sample();
  if (serverDied) say(`wrangler dev exited during the run:\n${tail(LOG)}`);
  reportMemory(memory, args.profile, label);
  await stopServer();
  say(`k6 exited with ${code}`);
  process.exit(code);
}
