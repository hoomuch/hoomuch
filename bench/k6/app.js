/**
 * End-to-end load test: signed-in page views against the real Worker (wrangler dev on a seeded D1).
 *
 *   node bench/serve.mjs --profile smoke                       # the usual way: serve, run this, stop
 *   k6 run -e PROFILE=load -e USERS=/abs/users-e2e.json bench/k6/app.js   # against a running server
 *
 * Profiles (PROFILE, default smoke). Every one is open-model (arrival-rate executors): requests
 * start on schedule whether or not the last ones came back, so a slow server shows up as latency
 * and dropped iterations, not as fewer requests (no coordinated omission).
 *   smoke   RATE=1 req/s for DURATION=1m
 *   load    ramp to RATE=10 over RAMP_UP=2m, hold for HOLD=8m, ramp down over RAMP_DOWN=1m
 *   stress  STEPS=10,20,40,60,80,100,120 req/s, STEP_DURATION=2m each, jumping straight to the
 *           next rate. Never fails: it reports each step's latency, errors and achieved rate, to
 *           find the breaking point.
 *   spike   BASE_RATE=2 for BASE_DURATION=1m, up to SPIKE_RATE=60 within SPIKE_RAMP=10s, held for
 *           SPIKE_HOLD=2m, back to BASE_RATE within SPIKE_RAMP, held for RECOVERY=2m
 *   soak    RATE=5 req/s for DURATION=30m
 * Other settings: ONLY (comma-separated endpoints to keep from the mix), BASE_URL (http://127.0.0.1:8788), USERS (the users file bench/seed.mjs wrote;
 * absolute, or relative to this file), LABEL (results file suffix, default "local"), SLO_SCALE
 * (slo.js), PRE_VUS / MAX_VUS (VU pool; defaults scale with the peak rate), TIMEOUT (per request,
 * 30s), RESULTS_DIR (bench/results, relative to the directory k6 runs in; k6 won't create it, and
 * serve.mjs does).
 *
 * Each iteration is one page view: a persona by weight, a random seeded user of it, then a page by
 * weight (MIX below). Every request is tagged `endpoint` and `persona` (`step` under stress, `phase`
 * under spike and soak) and gets a `name` without ids, dates or page numbers, so metric cardinality
 * stays fixed.
 *
 * handleSummary writes bench/results/k6-<PROFILE>-<LABEL>.json for bench/compare.mjs and prints a
 * table. It imports nothing remote, so it works offline.
 */

import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { CHECKS_RATE_MIN, ERROR_RATE_MAX, SLO, SLO_SCALE, sloThresholds } from './slo.js';

// ---------- settings ----------

const PROFILE = __ENV.PROFILE || 'smoke';
const LABEL = __ENV.LABEL || 'local';
const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const USERS_FILE = __ENV.USERS || '../.state/users-e2e.json';
const RESULTS_DIR = (__ENV.RESULTS_DIR || 'bench/results').replace(/\/+$/, '');
const TIMEOUT = __ENV.TIMEOUT || '30s';
const STRESS = PROFILE === 'stress';

const env = (name, fallback) => (__ENV[name] !== undefined && __ENV[name] !== '' ? __ENV[name] : fallback);
function rate(name, fallback) {
  const v = Number(env(name, fallback));
  if (!(v > 0)) throw new Error(`${name} must be a positive number of requests a second, got "${__ENV[name]}"`);
  return v;
}
/** A k6 duration string ("2m", "90s", "1m30s", "500ms") in ms; throws on anything else. */
function durationMs(name, fallback) {
  const s = String(env(name, fallback));
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let ms = 0;
  let consumed = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    ms += Number(m[1]) * { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }[m[2]];
    consumed += m[0].length;
  }
  if (consumed !== s.length || s.length === 0) throw new Error(`${name} must be a duration such as 2m or 90s, got "${s}"`);
  return ms;
}
/** Back to a string k6 accepts, in whole seconds where possible. */
const dur = (ms) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

/** The executor and the settings it was built from (recorded in the results file). */
function profile() {
  switch (PROFILE) {
    case 'smoke':
    case 'soak': {
      const r = rate('RATE', PROFILE === 'smoke' ? 1 : 5);
      const d = durationMs('DURATION', PROFILE === 'smoke' ? '1m' : '30m');
      return {
        peak: r,
        params: { rate: r, duration: dur(d) },
        // A soak reports its thirds apart, to show drift (smoke shares this case and has no phases).
        phaseEnds: PROFILE === 'soak' ? [d / 3, (2 * d) / 3] : [],
        scenario: { executor: 'constant-arrival-rate', rate: r, timeUnit: '1s', duration: dur(d) },
      };
    }
    case 'load': {
      const r = rate('RATE', 10);
      const up = durationMs('RAMP_UP', '2m');
      const hold = durationMs('HOLD', '8m');
      const down = durationMs('RAMP_DOWN', '1m');
      return {
        peak: r,
        params: { rate: r, rampUp: dur(up), hold: dur(hold), rampDown: dur(down) },
        scenario: {
          executor: 'ramping-arrival-rate',
          startRate: 0,
          timeUnit: '1s',
          stages: [
            { target: r, duration: dur(up) },
            { target: r, duration: dur(hold) },
            { target: 0, duration: dur(down) },
          ],
        },
      };
    }
    case 'stress': {
      const steps = STEPS;
      return {
        peak: Math.max(...steps),
        params: { steps, stepDuration: dur(STEP_MS) },
        scenario: {
          executor: 'ramping-arrival-rate',
          startRate: steps[0],
          timeUnit: '1s',
          // A 0s stage jumps straight to the next rate, so each step is STEP_MS at one rate.
          stages: steps.flatMap((r, i) => [...(i > 0 ? [{ target: r, duration: '0s' }] : []), { target: r, duration: dur(STEP_MS) }]),
        },
      };
    }
    case 'spike': {
      const base = rate('BASE_RATE', 2);
      const spike = rate('SPIKE_RATE', 60);
      const before = durationMs('BASE_DURATION', '1m');
      const ramp = durationMs('SPIKE_RAMP', '10s');
      const hold = durationMs('SPIKE_HOLD', '2m');
      const recovery = durationMs('RECOVERY', '2m');
      return {
        peak: Math.max(base, spike),
        params: { baseRate: base, spikeRate: spike, baseDuration: dur(before), spikeRamp: dur(ramp), spikeHold: dur(hold), recovery: dur(recovery) },
        // before | the surge, up, held and back down | after: the last is the recovery.
        phaseEnds: [before, before + 2 * ramp + hold],
        scenario: {
          executor: 'ramping-arrival-rate',
          startRate: base,
          timeUnit: '1s',
          stages: [
            { target: base, duration: dur(before) },
            { target: spike, duration: dur(ramp) },
            { target: spike, duration: dur(hold) },
            { target: base, duration: dur(ramp) },
            { target: base, duration: dur(recovery) },
          ],
        },
      };
    }
    default:
      throw new Error(`Unknown PROFILE "${PROFILE}": use smoke, load, stress, spike or soak`);
  }
}

const STEPS = STRESS
  ? String(env('STEPS', '10,20,40,60,80,100,120'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const v = Number(s);
        if (!(v > 0)) throw new Error(`STEPS must be a comma-separated list of positive rates, got "${__ENV.STEPS}"`);
        return v;
      })
  : [];
const STEP_MS = STRESS ? durationMs('STEP_DURATION', '2m') : 0;

const PLAN = profile();
/**
 * Spike and soak report their phases apart (a request is tagged with the phase it starts in):
 * whether latency recovers after a surge, or drifts over a long run. An aggregate hides both.
 */
const PHASES = PROFILE === 'spike' ? ['before', 'spike', 'after'] : PROFILE === 'soak' ? ['first-third', 'middle-third', 'last-third'] : [];
/** A soak drifts when an endpoint's last-third p95 is this much (and DRIFT_MIN_MS) above its first. */
const DRIFT_MAX = 0.2;
const DRIFT_MIN_MS = 5;
const int = (name, fallback) => {
  const v = Number(env(name, fallback));
  if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive whole number, got "${__ENV[name]}"`);
  return v;
};
// Enough VUs preallocated for a second of latency at the peak rate; room for five before k6 has
// to drop iterations (which it reports, and which the stress table shows as a shortfall).
const PRE_VUS = int('PRE_VUS', Math.max(5, Math.ceil(PLAN.peak)));
const MAX_VUS = Math.max(PRE_VUS, int('MAX_VUS', Math.max(20, Math.min(1000, Math.ceil(PLAN.peak * 5)))));

// ---------- the traffic mix ----------

const PERSONAS = [
  ['small', 0.7],
  ['medium', 0.25],
  ['large', 0.05],
];
const FULL_MIX = [
  ['dashboard', 0.35],
  ['dashboard_month', 0.1],
  ['transactions', 0.15],
  ['transactions_deep', 0.05],
  ['transactions_day', 0.05],
  ['connection', 0.12],
  ['connections', 0.1],
  ['settings', 0.08],
];
/** ONLY=settings,connections keeps those endpoints (their weights scaled up), for a targeted run. */
const ONLY = String(env('ONLY', '')).split(',').map((e) => e.trim()).filter(Boolean);
for (const e of ONLY) if (!FULL_MIX.some(([x]) => x === e)) throw new Error(`ONLY: unknown endpoint "${e}"`);
const MIX = ONLY.length ? FULL_MIX.filter(([e]) => ONLY.includes(e)) : FULL_MIX;
const ENDPOINTS = MIX.map(([e]) => e);
for (const e of ENDPOINTS) if (!SLO[e]) throw new Error(`slo.js has no SLO for endpoint "${e}"`);

const seedMeta = new SharedArray('seed', () => {
  const s = JSON.parse(open(USERS_FILE));
  return [{ seededAt: s.seededAt, scale: s.scale, volume: s.volume, users: s.users.length }];
});
const USERS = Object.fromEntries(
  PERSONAS.map(([p]) => [
    p,
    new SharedArray(`users-${p}`, () =>
      JSON.parse(open(USERS_FILE))
        .users.filter((u) => u.persona === p)
        .map((u) => ({ token: u.token, connectionIds: u.connectionIds })),
    ),
  ]),
);
// A persona the seed has no users for drops out of the draw.
const PERSONA_DRAW = PERSONAS.filter(([p]) => USERS[p].length > 0);
if (PERSONA_DRAW.length === 0) throw new Error(`No users in ${USERS_FILE}`);

function weighted(entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r < 0) return v;
  }
  return entries[entries.length - 1][0];
}
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pad2 = (n) => String(n).padStart(2, '0');

/** YYYY-MM, `back` months before this UTC month. */
function monthBack(back) {
  const d = new Date();
  const m = d.getUTCFullYear() * 12 + d.getUTCMonth() - back;
  return `${Math.floor(m / 12)}-${pad2((m % 12) + 1)}`;
}
/**
 * YYYY-MM-DD, `back` UTC days before today. At least one day back, so it is never after the
 * user's own today, whatever their zone (a later day falls back to the unfiltered list).
 */
function dayBack(back) {
  return new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
}

/** The request for one endpoint: path, the `name` tag, and the page name its payload carries. */
const REQUEST = {
  dashboard: () => {
    const r = Math.random();
    const range = r < 0.7 ? 30 : r < 0.85 ? 7 : r < 0.95 ? 90 : 364;
    return { path: `/dashboard?range=${range}`, name: `/dashboard?range=${range}`, page: 'dashboard' };
  },
  dashboard_month: () => ({ path: `/dashboard?month=${monthBack(randInt(1, 6))}`, name: '/dashboard?month=:month', page: 'dashboard' }),
  // Every persona has Stripe; a fifth of the list views filter by it.
  transactions: () =>
    Math.random() < 0.8
      ? { path: '/transactions', name: '/transactions', page: 'transactions' }
      : { path: '/transactions?provider=stripe', name: '/transactions?provider=stripe', page: 'transactions' },
  transactions_deep: () => ({ path: `/transactions?page=${randInt(2, 40)}`, name: '/transactions?page=:n', page: 'transactions' }),
  transactions_day: () => ({ path: `/transactions?day=${dayBack(randInt(1, 14))}`, name: '/transactions?day=:day', page: 'transactions' }),
  connection: (u) => ({
    path: `/connections/${u.connectionIds[Math.floor(Math.random() * u.connectionIds.length)]}`,
    name: '/connections/:id',
    page: 'connectionDetail',
  }),
  connections: () => ({ path: '/connections', name: '/connections', page: 'connections' }),
  settings: () => ({ path: '/settings', name: '/settings', page: 'settings' }),
};

// ---------- options ----------

/**
 * Pass/fail thresholds come from slo.js, except under stress, which runs past the breaking point on
 * purpose. A threshold that always passes (`max>=0`, `rate>=0`) only makes k6 keep that submetric,
 * so handleSummary can report it.
 */
const SLO_THRESHOLDS = STRESS ? {} : sloThresholds();
const thresholds = { ...SLO_THRESHOLDS };
const keep = (metric) => {
  if (thresholds[metric]) return;
  const isRate = metric.startsWith('http_req_failed') || metric.startsWith('checks');
  thresholds[metric] = [isRate ? 'rate>=0' : 'max>=0'];
};
const selectors = (tags) => `{${tags.join(',')}}`;
const CASE_SELECTORS = [];
for (const e of ENDPOINTS) {
  CASE_SELECTORS.push([e, selectors([`endpoint:${e}`])]);
  for (const [p] of PERSONAS) CASE_SELECTORS.push([`${e}/${p}`, selectors([`endpoint:${e}`, `persona:${p}`])]);
}
for (const s of STEPS) {
  CASE_SELECTORS.push([`step:${s}`, selectors([`step:${s}`])]);
  for (const e of ENDPOINTS) CASE_SELECTORS.push([`step:${s}/${e}`, selectors([`step:${s}`, `endpoint:${e}`])]);
}
for (const p of PHASES) {
  CASE_SELECTORS.push([`phase:${p}`, selectors([`phase:${p}`])]);
  for (const e of ENDPOINTS) CASE_SELECTORS.push([`phase:${p}/${e}`, selectors([`phase:${p}`, `endpoint:${e}`])]);
}
for (const [, sel] of CASE_SELECTORS) {
  keep(`http_req_duration${sel}`);
  keep(`http_req_failed${sel}`);
}
keep('http_req_failed');
keep('checks');

export const options = {
  scenarios: {
    [PROFILE]: { ...PLAN.scenario, preAllocatedVUs: PRE_VUS, maxVUs: MAX_VUS },
  },
  thresholds,
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  userAgent: 'hoomuch-bench-k6',
};

// Only a 200 is a success: a 303 to /login (a dead session) or a 429 must count as failed.
http.setResponseCallback(http.expectedStatuses(200));

const responses = {
  '3xx': new Counter('responses_3xx'),
  429: new Counter('responses_429'),
  '4xx': new Counter('responses_4xx'),
  '5xx': new Counter('responses_5xx'),
  none: new Counter('responses_none'),
};
function countStatus(status) {
  if (status === 200) return;
  if (status === 0) responses.none.add(1);
  else if (status === 429) responses[429].add(1);
  else if (status >= 500) responses['5xx'].add(1);
  else if (status >= 400) responses['4xx'].add(1);
  else if (status >= 300) responses['3xx'].add(1);
}

/** The spike or soak phase this iteration starts in, from the time since the scenario started. */
function currentPhase() {
  const elapsed = Date.now() - exec.scenario.startTime;
  return PHASES[PLAN.phaseEnds.filter((end) => elapsed >= end).length];
}

/** The stress step this iteration starts in, from the time since the scenario started. */
function currentStep() {
  const i = Math.floor((Date.now() - exec.scenario.startTime) / STEP_MS);
  return String(STEPS[Math.min(STEPS.length - 1, Math.max(0, i))]);
}

// ---------- one page view ----------

export default function () {
  const persona = weighted(PERSONA_DRAW);
  const users = USERS[persona];
  const user = users[Math.floor(Math.random() * users.length)];
  const endpoint = weighted(MIX);
  const req = REQUEST[endpoint](user);
  const tags = { endpoint, persona, name: req.name };
  if (STRESS) tags.step = currentStep();
  if (PHASES.length) tags.phase = currentPhase();

  const res = http.get(`${BASE_URL}${req.path}`, {
    // Only the session cookie: no jar carried between users (k6 resets it every iteration anyway).
    headers: { Cookie: `hm_session=${user.token}` },
    redirects: 0,
    timeout: TIMEOUT,
    tags,
  });
  countStatus(res.status);
  // The page payload block the server renders into every page (views/page-root.tsx).
  const marker = `<script id="hm-page" type="application/json">{"name":"${req.page}"`;
  const checkTags = { endpoint, persona };
  if (STRESS) checkTags.step = tags.step;
  if (PHASES.length) checkTags.phase = tags.phase;
  check(
    res,
    {
      'status is 200': (r) => r.status === 200,
      'renders the page': (r) => typeof r.body === 'string' && r.body.indexOf(marker) !== -1,
    },
    checkTags,
  );
}

// ---------- summary ----------

const r2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r5 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : null);

function caseFrom(metrics, sel) {
  const d = metrics[`http_req_duration${sel}`];
  const f = metrics[`http_req_failed${sel}`];
  const n = d?.values?.count ?? (f ? f.values.passes + f.values.fails : 0);
  if (!(n > 0)) return null;
  const v = d.values;
  return { n, p50: r2(v.med), p95: r2(v['p(95)']), p99: r2(v['p(99)']), max: r2(v.max), failedRate: f ? r5(f.values.rate) : 0 };
}

const passed = (metric) => !metric || Object.values(metric.thresholds ?? {}).every((t) => t.ok);
const counterValue = (metrics, name) => metrics[name]?.values?.count ?? 0;

function fmtTable(header, rows, align) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  const cell = (c, i) => (align[i] === 'l' ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]));
  return all.map((r) => r.map(cell).join('  ').trimEnd()).join('\n');
}
const ms = (x) => (x === null || x === undefined ? '-' : x.toFixed(1));
const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(2)}%`);

/**
 * Spike: did every endpoint get back within its SLO after the surge? Soak: did any endpoint's p95
 * climb from the first third to the last (more than DRIFT_MAX and DRIFT_MIN_MS)? Adds `out.phases`.
 */
function phaseReport(cases, out, lines) {
  const list = PHASES.map((p) => {
    const c = cases[`phase:${p}`];
    const over = ENDPOINTS.filter((e) => {
      const ce = cases[`phase:${p}/${e}`];
      return ce && ce.p95 > SLO[e].p95;
    });
    return { phase: p, ...(c ?? { n: 0 }), overSlo: over };
  });
  let verdict;
  if (PROFILE === 'spike') {
    const after = list[2];
    const failed = (cases['phase:after']?.failedRate ?? 0) >= ERROR_RATE_MAX;
    const ok = after.n > 0 && after.overSlo.length === 0 && !failed;
    verdict = { recovered: ok, text: ok ? 'recovered: every endpoint within SLO after the surge' : `not recovered after the surge: ${after.n === 0 ? 'no requests' : [...after.overSlo.map((e) => `${e} p95 over SLO`), ...(failed ? ['failures'] : [])].join(', ')}` };
  } else {
    const drift = ENDPOINTS.map((e) => {
      const a = cases[`phase:first-third/${e}`];
      const b = cases[`phase:last-third/${e}`];
      if (!a || !b) return null;
      return { endpoint: e, firstP95: a.p95, lastP95: b.p95, change: r2((b.p95 - a.p95) / a.p95) };
    }).filter(Boolean);
    const drifted = drift.filter((d) => d.lastP95 > d.firstP95 * (1 + DRIFT_MAX) && d.lastP95 - d.firstP95 > DRIFT_MIN_MS);
    verdict = {
      drifted: drifted.map((d) => d.endpoint),
      drift,
      text: drifted.length
        ? `drift: ${drifted.map((d) => `${d.endpoint} p95 ${ms(d.firstP95)} → ${ms(d.lastP95)} ms`).join(', ')}`
        : `no drift: no endpoint's p95 rose more than ${DRIFT_MAX * 100}% (and ${DRIFT_MIN_MS} ms) from the first third to the last`,
    };
  }
  out.phases = { list, ...verdict };
  lines.push('');
  lines.push(
    fmtTable(
      ['phase', 'n', 'p50', 'p95', 'p99', 'max', 'failed', 'p95 over SLO'],
      list.map((p) => [p.phase, p.n, ms(p.p50), ms(p.p95), ms(p.p99), ms(p.max), pct(p.failedRate), p.overSlo.length ? p.overSlo.join(', ') : '-']),
      ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
    ),
  );
  lines.push('');
  lines.push(verdict.text);
}

export function handleSummary(data) {
  const m = data.metrics;
  const cases = {};
  for (const [key, sel] of CASE_SELECTORS) {
    const c = caseFrom(m, sel);
    if (c) cases[key] = c;
  }
  const overall = caseFrom(m, '');
  const durationS = (data.state?.testRunDurationMs ?? 0) / 1000;
  const totals = {
    durationS: r2(durationS),
    requests: counterValue(m, 'http_reqs'),
    rps: r2(m.http_reqs?.values?.rate),
    droppedIterations: counterValue(m, 'dropped_iterations'),
    maxVUs: m.vus_max?.values?.max ?? null,
    checksRate: r5(m.checks?.values?.rate),
    failedRate: r5(m.http_req_failed?.values?.rate),
  };
  const statuses = {
    '3xx': counterValue(m, 'responses_3xx'),
    429: counterValue(m, 'responses_429'),
    '4xx': counterValue(m, 'responses_4xx'),
    '5xx': counterValue(m, 'responses_5xx'),
    none: counterValue(m, 'responses_none'),
  };

  const thresholdResults = {};
  for (const key of Object.keys(SLO_THRESHOLDS)) thresholdResults[key] = passed(m[key]);
  const allPassed = Object.values(thresholdResults).every(Boolean);

  const out = {
    kind: 'k6',
    label: LABEL,
    profile: PROFILE,
    at: new Date().toISOString(),
    baseUrl: BASE_URL,
    params: PLAN.params,
    seed: seedMeta[0],
    slo: { scale: SLO_SCALE, errorRateMax: ERROR_RATE_MAX, checksRateMin: CHECKS_RATE_MIN, endpoints: SLO },
    overall,
    totals,
    statuses,
    cases,
    thresholds: thresholdResults,
    passed: STRESS ? null : allPassed,
  };

  const lines = [];
  lines.push('');
  lines.push(
    `k6 ${PROFILE} (${LABEL}): ${totals.requests} requests in ${durationS.toFixed(0)} s, ${totals.rps ?? 0} req/s, ` +
      `${totals.droppedIterations} dropped, max ${totals.maxVUs} VUs`,
  );
  const odd = Object.entries(statuses).filter(([, n]) => n > 0);
  lines.push(`non-200 responses: ${odd.length ? odd.map(([s, n]) => `${s} ×${n}`).join(', ') : 'none'}`);
  lines.push('');

  const rows = ENDPOINTS.map((e) => {
    const c = cases[e];
    const slo = SLO[e];
    const verdict = STRESS
      ? c && c.p95 <= slo.p95 && c.p99 <= slo.p99
        ? 'within'
        : c
          ? 'over'
          : 'no data'
      : !c
        ? 'no data'
        : thresholdResults[`http_req_duration{endpoint:${e}}`]
          ? 'pass'
          : 'FAIL';
    const byPersona = PERSONAS.map(([p]) => ms(cases[`${e}/${p}`]?.p95));
    return [e, c?.n ?? 0, ms(c?.p50), ms(c?.p95), ms(c?.p99), ms(c?.max), pct(c?.failedRate), `${slo.p95}/${slo.p99}`, verdict, ...byPersona];
  });
  lines.push(
    fmtTable(
      ['endpoint', 'n', 'p50', 'p95', 'p99', 'max', 'failed', 'SLO p95/p99', STRESS ? 'whole run' : 'result', ...PERSONAS.map(([p]) => `p95 ${p}`)],
      rows,
      ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'r', 'r', 'r'],
    ),
  );
  lines.push('');
  lines.push(
    `all requests: p50 ${ms(overall?.p50)}  p95 ${ms(overall?.p95)}  p99 ${ms(overall?.p99)}  max ${ms(overall?.max)} ms; ` +
      `failed ${pct(totals.failedRate)} (limit <${pct(ERROR_RATE_MAX)})${STRESS ? '' : thresholdResults.http_req_failed ? ' pass' : ' FAIL'}; ` +
      `checks ${pct(totals.checksRate)} (limit >${pct(CHECKS_RATE_MIN)})${STRESS ? '' : thresholdResults.checks ? ' pass' : ' FAIL'}`,
  );

  if (STRESS) {
    const stepS = STEP_MS / 1000;
    const steps = STEPS.map((s) => {
      const c = cases[`step:${s}`];
      const achieved = c ? c.n / stepS : 0;
      const over = ENDPOINTS.filter((e) => {
        const ce = cases[`step:${s}/${e}`];
        return ce && ce.p95 > SLO[e].p95;
      });
      const reasons = [];
      if (!c) reasons.push('no requests');
      if (c && c.failedRate >= ERROR_RATE_MAX) reasons.push(`failed ${pct(c.failedRate)}`);
      if (achieved < 0.95 * s) reasons.push(`achieved ${achieved.toFixed(1)} req/s`);
      // Named when few, counted when most are over (the full list stays in the JSON).
      if (over.length) reasons.push(`p95 over SLO: ${over.length <= 3 ? over.join(', ') : `${over.length} of ${ENDPOINTS.length} endpoints`}`);
      return { rps: s, ...(c ?? { n: 0 }), achievedRps: r2(achieved), overSlo: over, ok: reasons.length === 0, reasons };
    });
    const firstBad = steps.find((s) => !s.ok);
    const good = steps.filter((s) => s.ok && (!firstBad || s.rps < firstBad.rps));
    out.stress = {
      stepSeconds: stepS,
      steps,
      lastGoodStep: good.length ? good[good.length - 1].rps : null,
      firstBadStep: firstBad ? firstBad.rps : null,
      // Every step within SLO: one past the first breach hints the breach was noise (few samples).
      okSteps: steps.filter((s) => s.ok).map((s) => s.rps),
    };
    lines.push('');
    lines.push(
      fmtTable(
        ['step req/s', 'n', 'achieved', 'p50', 'p95', 'p99', 'max', 'failed', 'verdict'],
        steps.map((s) => [s.rps, s.n, s.achievedRps.toFixed(1), ms(s.p50), ms(s.p95), ms(s.p99), ms(s.max), pct(s.failedRate), s.ok ? 'ok' : s.reasons.join('; ')]),
        ['r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
      ),
    );
    lines.push('');
    lines.push(
      `last step within SLO: ${out.stress.lastGoodStep === null ? 'none' : `${out.stress.lastGoodStep} req/s`}; ` +
        `first step over: ${out.stress.firstBadStep === null ? 'none' : `${out.stress.firstBadStep} req/s`}` +
        `${firstBad ? ` (${firstBad.reasons.join('; ')})` : ''}`,
    );
    const later = out.stress.okSteps.filter((r) => firstBad && r > firstBad.rps);
    if (later.length) lines.push(`within SLO again at ${later.join(', ')} req/s: the first breach may be noise; try a longer STEP_DURATION`);
  } else {
    if (PHASES.length) phaseReport(cases, out, lines);
    lines.push('');
    lines.push(`THRESHOLDS ${allPassed ? 'PASSED' : 'FAILED'}${SLO_SCALE !== 1 ? ` (SLO_SCALE ${SLO_SCALE})` : ''}`);
  }

  const safeLabel = String(LABEL).replace(/[^A-Za-z0-9._-]/g, '_');
  const file = `${RESULTS_DIR}/k6-${PROFILE}-${safeLabel}.json`;
  lines.push(`→ ${file}`);
  lines.push('');
  return { [file]: JSON.stringify(out, null, 2), stdout: lines.join('\n') };
}
