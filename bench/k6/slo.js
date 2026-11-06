/**
 * Service-level objectives for the end-to-end load test (bench/k6/app.js), per endpoint, in ms.
 * bench/README.md ("Objectives") says where they come from: the production targets minus room for
 * three Worker-to-D1 round trips, which `wrangler dev` doesn't have. They hold under the `load`
 * profile on a developer machine; keep the keys in step with the endpoints app.js sends.
 *
 * SLO_SCALE multiplies every latency limit (SLO_SCALE=2 on a slower machine, 0.5 to tighten). The
 * error and check rates never scale.
 */

const BASE = {
  dashboard: { p95: 250, p99: 500 },
  dashboard_month: { p95: 250, p99: 500 },
  transactions: { p95: 100, p99: 200 },
  transactions_deep: { p95: 150, p99: 300 },
  transactions_day: { p95: 100, p99: 200 },
  connection: { p95: 100, p99: 200 },
  connections: { p95: 75, p99: 150 },
  settings: { p95: 75, p99: 150 },
};

/** At most 0.1% of requests may fail (non-200, timeout, connection error). */
export const ERROR_RATE_MAX = 0.001;
/** At least 99.9% of checks (status 200, a rendered page) must pass. */
export const CHECKS_RATE_MIN = 0.999;

export const SLO_SCALE = Number(__ENV.SLO_SCALE || 1);
if (!(SLO_SCALE > 0)) throw new Error(`SLO_SCALE must be a positive number, got "${__ENV.SLO_SCALE}"`);

const round = (x) => Math.round(x * 100) / 100;

/** Per-endpoint latency limits after SLO_SCALE: { endpoint: { p95, p99 } } in ms. */
export const SLO = Object.fromEntries(
  Object.entries(BASE).map(([endpoint, s]) => [endpoint, { p95: round(s.p95 * SLO_SCALE), p99: round(s.p99 * SLO_SCALE) }]),
);

/** The pass/fail thresholds: global error and check rates, then p95 and p99 per endpoint. */
export function sloThresholds() {
  const t = {
    http_req_failed: [`rate<${ERROR_RATE_MAX}`],
    checks: [`rate>${CHECKS_RATE_MIN}`],
  };
  for (const [endpoint, s] of Object.entries(SLO)) {
    t[`http_req_duration{endpoint:${endpoint}}`] = [`p(95)<${s.p95}`, `p(99)<${s.p99}`];
  }
  return t;
}
