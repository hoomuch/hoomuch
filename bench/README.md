# Benchmarks

Two harnesses, one data set:

| | What it measures | Use it for |
|---|---|---|
| **Read-model benchmark** (`bench/readmodels.bench.ts`) | The D1 work behind each page, in process, on SQLite (the engine D1 runs): p50/p95/p99 and round trips per call, per persona | Query and index changes. Deterministic enough for a 10% regression gate (`npm run bench:ab`) |
| **End-to-end load test** (`bench/k6/app.js`, [k6](https://github.com/grafana/k6)) | Whole requests against `wrangler dev` (workerd, local D1, React rendering) under an arrival rate | The SLOs below, capacity, and anything that changes what a page does per request |

## The data

`bench/seed.mjs` writes a deterministic, production-shaped database. Everything in it is made up
(`bench-*@example.com` users, placeholder keys, no customer data, the same as the real tables).

| Persona | Users | Connections | History | Charges a day (now) | Transactions each |
|---|---:|---|---|---:|---:|
| small | 150 | 1 Stripe | 400 days | ~12 | ~3k |
| medium | 12 | Stripe, Paddle, Lemon Squeezy, RevenueCat | 2 years | ~120 | ~60k |
| large | 2 | 12: nine transaction providers, RevenueCat, App Store, Adapty | 2 years | ~1,100 | ~580k |

In total 164 users, 222 connections, 2.4M transactions, 93k snapshots (with a 20-product MRR split
each), 183k daily revenue rows and 800 days of rates for 170 currencies: about 700 MB.

**Volumes.** The large persona is the biggest account the product is for: around $1M MRR at a
$30 average plan is ~33k subscribers and ~1,100 charges a day. Most accounts are small, and the
traffic mix (below) weighs them that way.

**Where rows sit matters as much as how many there are.** Rows land in the order production writes
them: a connection's first sync backfills 90 days in one go, then hourly syncs add each hour's rows
interleaved with every other tenant's, and snapshots and daily totals arrive once a day. So one
connection's transactions are spread over many table pages, as they are on a real instance, and a
query that looks each row up in the table pays for it. (Seeding each connection's rows contiguously
made the transactions page look 2.6x faster than it is.)

There is no `ANALYZE`: the planner runs without `sqlite_stat1`, as on a fresh D1 and in the tests.

## Objectives

An objective is a target a measurement passes or fails, set before measuring.

### What users get (production)

Time to first byte at the edge, per page, over a rolling 28 days (Workers observability):

| Page | p95 | p99 |
|---|---:|---:|
| `/dashboard` | 600 ms | 1,200 ms |
| `/transactions` | 400 ms | 800 ms |
| `/connections`, `/connections/:id`, `/settings` | 300 ms | 600 ms |
| Errors (5xx) | < 0.1% of requests | |

A page's time on Cloudflare is its work (D1 time plus rendering, which the local test measures) plus
one Worker-to-D1 network round trip per *sequential* D1 call. The Worker runs near the user and D1
in one region, so that trip costs ~5–20 ms nearby and ~80–150 ms from another continent. The
local budgets below leave room for 3 such trips at 100 ms.

### What the local load test enforces (`bench/k6/slo.js`)

Under the `load` profile (expected load), against `wrangler dev` on a developer machine:

| Endpoint | Request | p95 | p99 |
|---|---|---:|---:|
| `dashboard` | `/dashboard?range=7\|30\|90` | 250 ms | 500 ms |
| `dashboard_month` | `/dashboard?month=…` (calendar month 1–6 back) | 250 ms | 500 ms |
| `transactions` | `/transactions` | 100 ms | 200 ms |
| `transactions_deep` | `/transactions?page=2…40` | 150 ms | 300 ms |
| `transactions_day` | `/transactions?day=…` | 100 ms | 200 ms |
| `connection` | `/connections/:id` | 100 ms | 200 ms |
| `connections` | `/connections` | 75 ms | 150 ms |
| `settings` | `/settings` | 75 ms | 150 ms |
| all | failed requests | < 0.1% | |
| all | checks (200, a rendered page) | > 99.9% | |

`SLO_SCALE=2` doubles every latency limit on a slower machine; error and check rates never scale.

### Capacity

One D1 database serves the whole instance and runs one query at a time, so the SQL time each page
costs, summed over all requests, is what limits throughput. Expected load is 10 page views a
second (about 2,000 accounts at a 5% peak concurrency, one view each 20 seconds when active, with
2x headroom). The objective: the `stress` profile keeps every endpoint inside its SLO up to at
least **5x expected load (50/s)**.

### Regressions

`npm run bench:ab` fails when any read-model case's p95 is more than **10% and more than 1 ms**
slower than on `main`, measured back to back on the same machine. Absolute numbers from different
machines aren't compared.

## Load profiles

All use open-model executors (`constant-arrival-rate`, `ramping-arrival-rate`): requests arrive on
schedule whether or not earlier ones are done, so a slow server shows up as latency instead of
being hidden by fewer requests (coordinated omission). Every rate is overridable through `-e`.

| Profile | Shape | Question |
|---|---|---|
| `smoke` | 1/s for 1 min | Does every page work under minimal load? |
| `load` | ramp to 10/s over 2 min, hold 8 min, ramp down | Does expected load meet the SLOs? |
| `stress` | 10 → 20 → 40 → 60 → 80 → 100 → 120/s, 2 min each | Where does it break? (reported per step) |
| `spike` | 2/s, then 60/s within 10 s for 2 min, then back | Does a sudden surge break it, and does it recover? Reported before / during / after the surge; it has recovered when every endpoint is back within its SLO afterwards |
| `soak` | 5/s for 30 min (`DURATION`) | Do latency or memory drift over time? Reported by thirds: drift is an endpoint whose p95 rose more than 20% (and 5 ms) from the first third to the last. `serve.mjs` samples workerd's memory every 10 s and reports its growth after the first third |

Each request picks a persona (small 70%, medium 25%, large 5%), one of its users, and a page:
dashboard 35%, a calendar month 10%, transactions 15%, a deeper transactions page 5%, a day's
transactions 5%, a connection 12%, the connection list 10%, settings 8%.

## Running

```bash
npm run bench:ab                              # main vs. your working tree (read models), ~10 min
npm run bench:ab -- --only large/ --rounds 5  # a subset, more rounds

npm run bench:seed                            # the read-model database on its own
npm run bench:readmodels                      # one read-model run → bench/results/
BENCH_PROFILE=1 BENCH_ONLY=large/dashboard npm run bench:readmodels   # time per statement

npm run bench:e2e -- --profile smoke          # wrangler dev + seeded local D1 + k6
npm run bench:e2e -- --profile load
npm run bench:e2e                             # just serve on :8788, for your own k6 runs
node bench/compare.mjs a.json b.json          # any two results, read-model or k6
```

Warm-up and repetition are built in: the read-model benchmark discards 5 warm-up calls per case
(page cache, statement compilation, JIT) and measures 60; `bench:ab` alternates base and head for 3
rounds and compares the median of each case's p95. The k6 profiles ramp up before they hold.

**`wrangler dev` renders React's development build** unless `NODE_ENV=production` is set, and
pages are 3–4x slower in it. `bench:e2e` sets it and serves a frozen bundle built like a deploy
(`wrangler deploy --dry-run`), so the numbers are production code and saving a file mid-run
changes nothing. `npm run dev` stays as it was: slower than production, on purpose, for React's
warnings.

**What this doesn't model.** The network between a Worker and D1 (budgeted above), D1's own
request overhead, many isolates (`wrangler dev` is one process), and production hardware. Read
the local numbers as cost and as a comparison, not as what a user will see.

## Results: 2026-11-06, `main` (6bef188) against the query work

On an Apple Silicon laptop, Node 24.22, full-size seed. `main` is the code before; the other
column is migration 0010 plus the read-model changes.

### Read models (`npm run bench:ab`; p95 ms, median of 3 alternating rounds of 60)

| Case | small | medium | large |
|---|---:|---:|---:|
| GET /dashboard, all its D1 work (5 → 2 round trips) | 4.15 → **2.55** | 17.00 → **7.43** | 95.84 → **46.49** |
| dashboard, 30 days | 3.04 → 1.77 | 14.33 → 6.15 | 86.90 → 44.00 |
| dashboard, 90 days | 7.57 → 3.78 | 39.33 → 17.67 | 250.46 → 127.05 |
| calendar, a month 6 back | 1.64 → 1.17 | 7.37 → 2.87 | 39.05 → 18.62 |
| transactions, page 1 | 12.76 → **0.97** | 52.28 → **1.06** | 189.00 → **1.18** |
| transactions, Next to page 40 | 13.17 → 0.96 | 62.22 → 1.11 | 223.31 → 1.23 |
| transactions, `?page=40` (an old link) | 13.49 → 5.76 | 62.08 → 10.62 | 222.41 → 15.43 |
| transactions, one day | 0.84 → 0.79 | 1.19 → 1.06 | 1.73 → 1.21 |

28 of 45 cases faster, none slower by the 10% gate, the other 17 within noise (sub-millisecond cases such as the session lookup).

### End to end (k6 against `wrangler dev`)

| Profile | `main` | after |
|---|---|---|
| `load`, all requests p95 / p99 (two alternating rounds) | 96 / 211, 91 / 174 ms | **42 / 92, 42 / 91 ms** |
| `load`, SLOs | **fails** `transactions` (p95 101–150 ms vs 100) | passes every endpoint |
| `stress`, last step within SLO | none (`transactions` over at 10/s) | **60/s** (6x expected load) |
| `stress`, breaking | 2.4% errors at 60/s; stuck at 57/s with 30% timeouts from 80/s | 0 errors up to 120/s; p95 322 ms there |
| `spike` | — | recovered: p95 43 → 70 (surge) → 44 ms, 0 errors |
| `soak`, 30 min | — | no drift (p95 by thirds 42.9, 43.2, 41.7 ms), 0 errors |

**Reading the local numbers.**

- **Light pages' medians under mixed load.** `connections` and `settings` medians come out a
  few ms lower against `main` in a mixed run. That's not the code. One by one, and under a
  light-only load (`ONLY=settings,connections,connection`), the two versions are equal or the new
  one is faster. Against `main` the laptop is busier, and an Apple Silicon machine keeps its cores
  fast under heavy load. Compare like with like.
- **workerd's memory.** In the soak it grew from 293 to 1,207 MB, at a slowing rate (77, 48, 19,
  then 9.5 MB a minute). That's the local D1's 770 MB file coming into memory as it's read, not a
  leak, which would grow at a steady rate. A run of a few hours is what would rule out a small one.
