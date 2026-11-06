#!/usr/bin/env node
/**
 * Seeds a hoomuch D1 database (a plain SQLite file) with benchmark data at production-like volume.
 *
 *   node bench/seed.mjs --db bench/.state/bench.sqlite --migrate --users-out bench/.state/users.json
 *
 * Deterministic: the same --seed, --scale, --volume and day give the same rows. Nothing here is
 * real: users are bench-*@example.com, keys are placeholders, and there is no customer data, the
 * same as the real tables.
 *
 * Personas (see bench/README.md for why these volumes):
 *   small   1 Stripe connection, 400 days, ~12 charges a day          (~3k transactions)
 *   medium  3 transaction providers + RevenueCat, 2 years, ~120 a day  (~60k)
 *   large   12 connections, 9 of them transaction providers, 2 years, ~1,100 a day (~580k)
 * --scale multiplies the number of users of each persona (at least one each); --volume multiplies
 * the transactions per day. The defaults make a ~2.4M-transaction, ~700 MB database.
 *
 * --fresh deletes the file first. --migrate applies migrations/*.sql first (a fresh file; --migrations <dir> to take them from
 * another checkout); without it the schema must exist, as it does in the file
 * `wrangler d1 migrations apply --local` creates.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    migrate: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    migrations: { type: 'string' },
    scale: { type: 'string', default: '1' },
    volume: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    now: { type: 'string' },
    'users-out': { type: 'string' },
  },
});
if (!args.db) {
  console.error('usage: node bench/seed.mjs --db <file.sqlite> [--migrate] [--scale 1] [--volume 1] [--users-out users.json]');
  process.exit(2);
}
const SCALE = Number(args.scale);
const VOLUME = Number(args.volume);
const NOW = args.now ? Number(args.now) : Date.now();

// ---------- deterministic randomness ----------

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(args.seed) * 2654435761);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const hex = (n) => {
  let s = '';
  while (s.length < n) s += Math.floor(rand() * 0x100000000).toString(16).padStart(8, '0');
  return s.slice(0, n);
};
const uuid = () => {
  const h = hex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const providerId = (prefix, n) => {
  let s = prefix;
  for (let i = 0; i < n; i++) s += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
  return s;
};
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

// ---------- personas ----------

/** [provider, charges a day at full size (0 = reports daily totals)]. */
const PERSONAS = {
  small: {
    count: 150,
    days: 400,
    conns: [['stripe', 12]],
    products: 6,
    zones: ['UTC', 'Europe/Istanbul', 'America/New_York', 'Asia/Kolkata', 'Europe/Berlin', 'Australia/Sydney'],
    currencies: ['USD', 'USD', 'USD', 'EUR', 'GBP'],
  },
  medium: {
    count: 12,
    days: 730,
    conns: [['stripe', 60], ['paddle', 35], ['lemonsqueezy', 25], ['revenuecat', 0]],
    products: 14,
    zones: ['America/New_York', 'Europe/London', 'Asia/Kolkata'],
    currencies: ['USD', 'USD', 'EUR'],
  },
  large: {
    count: 2,
    days: 730,
    conns: [
      ['stripe', 220], ['stripe', 160], ['paddle', 140], ['paddle', 90], ['lemonsqueezy', 120], ['polar', 80],
      ['chargebee', 150], ['gumroad', 60], ['googleplay', 120], ['revenuecat', 0], ['appstore', 0], ['adapty', 0],
    ],
    products: 40,
    zones: ['Europe/Berlin', 'America/Los_Angeles'],
    currencies: ['USD', 'EUR'],
  },
};
const DAILY_PROVIDERS = new Set(['revenuecat', 'dodo', 'adapty', 'superwall', 'appstore']);
const ID_PREFIX = {
  stripe: 'ch_', paddle: 'txn_', lemonsqueezy: 'ls_', polar: 'pl_', chargebee: 'cb_', gumroad: 'gr_', googleplay: 'GPA.',
};

// ~170 rate codes, like Frankfurter's blended table: the real ones the seed uses, then filler codes.
const REAL_CODES = [
  'USD', 'EUR', 'GBP', 'JPY', 'TRY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL', 'MXN', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK',
  'HUF', 'RON', 'BGN', 'ISK', 'ILS', 'KRW', 'SGD', 'HKD', 'NZD', 'ZAR', 'THB', 'MYR', 'IDR', 'PHP', 'AED', 'SAR', 'KWD',
];
const FX_CODES = [...REAL_CODES];
for (let i = 0; FX_CODES.length < 170; i++) {
  const code = `X${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
  if (!FX_CODES.includes(code)) FX_CODES.push(code);
}

function makeProducts(n) {
  const tiers = ['Starter', 'Basic', 'Plus', 'Pro', 'Team', 'Business', 'Enterprise', 'Indie', 'Studio', 'Agency'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const yearly = Math.floor(i / tiers.length) % 2 === 1;
    const series = i >= 2 * tiers.length ? ` ${Math.floor(i / (2 * tiers.length)) + 1}` : '';
    const monthly = pick([500, 900, 1500, 1900, 2900, 4900, 9900, 19900]);
    out.push({ name: `${tiers[i % tiers.length]} ${yearly ? 'Yearly' : 'Monthly'}${series}`, price: yearly ? monthly * 10 : monthly, monthly });
  }
  // Zipf-like popularity: the first products sell most.
  const weights = out.map((_, i) => 1 / (i + 1));
  const total = weights.reduce((s, w) => s + w, 0);
  let acc = 0;
  const cdf = weights.map((w) => (acc += w / total));
  return { list: out, pick: () => out[Math.min(out.length - 1, cdf.findIndex((c) => rand() <= c))] };
}

// ---------- database ----------

if (args.fresh) rmSync(args.db, { force: true });
mkdirSync(dirname(args.db), { recursive: true });
const db = new DatabaseSync(args.db);
// Per-connection settings only: nothing persistent changes in a file wrangler owns.
db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF; PRAGMA cache_size = -262144;');
if (args.migrate) {
  const dir = args.migrations ?? join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
}
const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (existing > 0) {
  console.error(`${args.db} already has ${existing} users; seed a fresh database.`);
  process.exit(1);
}

const ins = {
  user: db.prepare(
    `INSERT INTO users (id, email, password_hash, base_currency, currency_source, email_verified_at, timezone, timezone_source, created_at, updated_at)
     VALUES (?, ?, 'pbkdf2-sha256$600000$YmVuY2g$YmVuY2g', ?, 'chosen', ?, ?, 'chosen', ?, ?)`,
  ),
  session: db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'),
  conn: db.prepare(
    `INSERT INTO connections (id, user_id, provider, name, credentials_enc, key_hint, config, test_mode, status, last_synced_at,
       last_sync_started_at, revenue_synced_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.bench.placeholder', '…beef', ?, 0, 'ok', ?, ?, ?, ?, ?)`,
  ),
  snap: db.prepare(
    `INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, revenue_period, revenue_period_days,
       new_customers, mrr_by_product, warnings, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ),
  txn: db.prepare(
    `INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency, fee, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  daily: db.prepare(
    `INSERT INTO daily_revenue (connection_id, day, currency, gross, refunds, count, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
  run: db.prepare(
    `INSERT INTO sync_runs (connection_id, kind, started_at, finished_at, ok, events, message) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
  fx: db.prepare('INSERT INTO fx_rates (day, base, rates, fetched_at) VALUES (?, ?, ?, ?)'),
};

const todayStart = Math.floor(NOW / DAY) * DAY;
const counts = { users: 0, connections: 0, transactions: 0, snapshots: 0, daily_revenue: 0, sync_runs: 0, fx_rates: 0 };

// ---------- FX: a random walk per currency, one row a day ----------

const FX_DAYS = 800;
{
  const rates = Object.fromEntries(FX_CODES.map((c) => [c, c === 'USD' ? 1 : Number((0.3 + rand() * 150).toFixed(6))]));
  rates.EUR = 0.92;
  rates.GBP = 0.79;
  rates.TRY = 34.5;
  rates.JPY = 151.2;
  db.exec('BEGIN');
  for (let d = FX_DAYS - 1; d >= 0; d--) {
    for (const c of FX_CODES) if (c !== 'USD') rates[c] = Number((rates[c] * (1 + (rand() - 0.5) * 0.01)).toFixed(6));
    ins.fx.run(dayKey(todayStart - d * DAY), 'USD', JSON.stringify(rates), NOW - d * DAY);
    counts.fx_rates++;
  }
  db.exec('COMMIT');
}

// ---------- tenants ----------
//
// Rows land in the order production writes them, because that decides how scattered one
// connection's rows are in the table b-tree (and so what every non-covering scan costs):
// a connection's first sync backfills BACKFILL_DAYS at once, then hourly syncs add each hour's
// rows, interleaved with every other tenant's; snapshots and daily totals land once a day.

const HOUR = 3_600_000;
const BACKFILL_DAYS = 90;
const WEEKLY = [0.85, 1.05, 1.08, 1.06, 1.04, 1.0, 0.9];
const users = [];
const conns = [];
const started = performance.now();

db.exec('BEGIN');
for (const [persona, p] of Object.entries(PERSONAS)) {
  const n = Math.max(1, Math.round(p.count * SCALE));
  for (let u = 0; u < n; u++) {
    const userId = uuid();
    const tz = p.zones[u % p.zones.length];
    const display = p.currencies[u % p.currencies.length];
    const historyStart = todayStart - (p.days - 1) * DAY;
    // Connected BACKFILL_DAYS after the data starts, so the first sync's backfill reaches its start.
    const userCreated = historyStart + BACKFILL_DAYS * DAY;
    ins.user.run(userId, `bench-${persona}-${u}@example.com`, display, userCreated, tz, userCreated, userCreated);
    counts.users++;
    // The raw token goes in the cookie; the row holds its hash (lib/auth.ts). Expiry stays more than
    // SESSION_REFRESH_BELOW_MS away for weeks, so no request extends it (no write per request).
    const token = hex(64);
    ins.session.run(sha256Hex(token), userId, NOW + 29 * DAY, NOW);

    const ids = [];
    p.conns.forEach(([provider, perDay], ci) => {
      const id = uuid();
      const daily = DAILY_PROVIDERS.has(provider);
      const dataStart = historyStart + ci * DAY;
      const createdAt = dataStart + BACKFILL_DAYS * DAY + 9 * HOUR;
      ins.conn.run(
        id, userId, provider, `${provider[0].toUpperCase()}${provider.slice(1)}${ci > 0 ? ` ${ci + 1}` : ''}`,
        daily ? '{"revenueHistory":"daily"}' : '{}', NOW - 20 * 60_000, NOW - 20 * 60_000, NOW - 20 * 60_000, createdAt, createdAt,
      );
      counts.connections++;
      ids.push(id);
      const products = makeProducts(p.products);
      const cur = pick(['USD', 'USD', 'USD', 'EUR', 'GBP']);
      conns.push({
        id, provider, daily, products, cur, alt: cur === 'USD' ? 'EUR' : 'USD', rate: perDay * VOLUME,
        avgMonthly: products.list.reduce((s, x) => s + x.monthly, 0) / products.list.length,
        dataStart, createdAt, days: p.days, agg: new Map(), connected: false,
        // Adapty (and Superwall) fill past snapshots on the first sync: fetchSnapshotHistory.
        snapshotHistory: provider === 'adapty' || provider === 'superwall',
      });
    });
    users.push({ persona, userId, token, timeZone: tz, currency: display, connectionIds: ids, historyDays: p.days });
  }
}
db.exec('COMMIT');

const growthOf = (c, at) => 0.4 + 0.6 * Math.max(0, Math.min(1, (at - c.dataStart) / ((c.days - 1) * DAY)));

/** One hour of a connection's charges and refunds (Poisson-ish, busier in the afternoon UTC). */
function hourOfTransactions(c, hourStart, until) {
  if (c.daily || until <= hourStart) return;
  const h = new Date(hourStart).getUTCHours();
  const lambda = (c.rate * growthOf(c, hourStart) * WEEKLY[new Date(hourStart).getUTCDay()] * (1 + 0.5 * Math.sin((2 * Math.PI * (h - 9)) / 24)) / 24) * ((until - hourStart) / HOUR);
  const n = Math.floor(lambda + rand());
  const times = Array.from({ length: n }, () => hourStart + Math.floor(rand() * (until - hourStart))).sort((a, b) => a - b);
  for (const at of times) {
    const product = c.products.pick();
    const refund = rand() < 0.03;
    const currency = rand() < 0.9 ? c.cur : c.alt;
    const amount = refund ? -product.price : product.price;
    ins.txn.run(
      c.id, providerId(ID_PREFIX[c.provider] ?? 'tx_', 24), at, refund ? 'refund' : 'charge', amount, currency,
      refund ? null : Math.round(product.price * 0.029) + 30, rand() < 0.05 ? null : product.name,
    );
    const key = `${dayKey(at)}|${currency}`;
    const a = c.agg.get(key) ?? { gross: 0, refunds: 0, count: 0 };
    if (amount > 0) a.gross += amount;
    else a.refunds -= amount;
    a.count++;
    c.agg.set(key, a);
  }
  counts.transactions += n;
}

/** daily_revenue for `day` as recomputeDailyRevenue / upsertProviderDaily leave it. */
function dailyRows(c, dayStart, until) {
  const day = dayKey(dayStart);
  if (c.daily) {
    const mrr = mrrOf(c, dayStart).mrr;
    const gross = Math.round((mrr / 30) * (0.8 + rand() * 0.4) * ((until - dayStart) / DAY));
    ins.daily.run(c.id, day, c.cur, gross, Math.round(gross * 0.02), Math.round(gross / c.avgMonthly), 'provider');
    counts.daily_revenue++;
    return;
  }
  for (const currency of [c.cur, c.alt]) {
    const a = c.agg.get(`${day}|${currency}`);
    if (!a) continue;
    ins.daily.run(c.id, day, currency, a.gross, a.refunds, a.count, 'transactions');
    c.agg.delete(`${day}|${currency}`);
    counts.daily_revenue++;
  }
}

function mrrOf(c, at) {
  const subs = Math.max(1, Math.round((c.rate || 40 * VOLUME) * 25 * growthOf(c, at)));
  return { subs, mrr: Math.round(subs * c.avgMonthly) };
}

/** The day's snapshot: MRR grows with the account; the split by product follows popularity. */
function snapshotRow(c, dayStart, capturedAt) {
  const { subs, mrr } = mrrOf(c, dayStart);
  const byProduct = c.products.list.slice(0, 20).map((x, i) => ({
    name: x.name,
    mrr: { [c.cur]: Math.max(1, Math.round((mrr * 0.9) / (i + 2))) },
    subscriptions: Math.max(1, Math.round(subs / (i + 2))),
  }));
  ins.snap.run(
    c.id, dayKey(dayStart), JSON.stringify({ [c.cur]: Math.round(mrr * 0.9), [c.alt]: Math.round(mrr * 0.1) }), subs,
    Math.round(subs * 0.06), c.daily ? JSON.stringify({ [c.cur]: mrr }) : null, c.daily ? 28 : null, Math.round(subs * 0.01),
    JSON.stringify(byProduct), capturedAt,
  );
  counts.snapshots++;
}

const clockStart = Math.min(...conns.map((c) => c.dataStart));
let lastReport = 0;
for (let hourStart = clockStart; hourStart < NOW; hourStart += HOUR) {
  const until = Math.min(hourStart + HOUR, NOW);
  const dayStart = Math.floor(hourStart / DAY) * DAY;
  const endOfDay = until === dayStart + DAY || until === NOW;
  if (hourStart === dayStart) db.exec('BEGIN');
  for (const c of conns) {
    if (until <= c.createdAt) continue;
    if (!c.connected) {
      // First sync: the whole backfill in one go, and past snapshots where the provider has them.
      c.connected = true;
      for (let t = c.dataStart; t < hourStart; t += HOUR) hourOfTransactions(c, t, t + HOUR);
      for (let d = c.dataStart; d < dayStart; d += DAY) {
        if (c.snapshotHistory) snapshotRow(c, d, c.createdAt);
        dailyRows(c, d, d + DAY);
      }
    }
    hourOfTransactions(c, hourStart, until);
    if (endOfDay) {
      snapshotRow(c, dayStart, until - 1);
      dailyRows(c, dayStart, until);
    }
  }
  if (endOfDay) db.exec('COMMIT');
  if (counts.transactions - lastReport > 500_000) {
    lastReport = counts.transactions;
    process.stderr.write(`  ${dayKey(hourStart)}: ${counts.transactions.toLocaleString('en')} transactions\n`);
  }
}

// The newest 100 runs of each connection (pruneSyncRuns keeps SYNC_RUNS_KEPT), one an hour.
db.exec('BEGIN');
for (let r = 100; r >= 1; r--) {
  for (const c of conns) {
    const at = NOW - r * HOUR;
    const ok = rand() > 0.02;
    ins.run.run(c.id, 'cron', at, at + 2_000 + Math.floor(rand() * 6_000), ok ? 1 : 0, Math.floor(rand() * 200), ok ? null : 'Provider timed out.');
    counts.sync_runs++;
  }
}
db.exec('COMMIT');

// No ANALYZE: the planner works without sqlite_stat1, as on a fresh D1 and in the tests.
db.close();

const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.error(`seeded ${args.db} in ${seconds}s: ${Object.entries(counts).map(([k, v]) => `${k} ${v.toLocaleString('en')}`).join(', ')}`);

if (args['users-out']) {
  mkdirSync(dirname(args['users-out']), { recursive: true });
  writeFileSync(args['users-out'], JSON.stringify({ seededAt: NOW, scale: SCALE, volume: VOLUME, counts, users }, null, 2));
}
