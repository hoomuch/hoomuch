/**
 * Test harness for provider adapters (Data Plane). Not a test file itself.
 *
 *   const { fetch, calls } = fakeFetch([
 *     route('/v1/subscriptions', { json: fixture }, { query: { status: 'active' } }),
 *     route(/\/v1\/prices\/.+/, (url) => ({ json: priceFor(url) })),
 *   ]);
 *   const ctx = makeCtx(fetch, { now: Date.parse('2026-11-05T12:00:00Z') });
 *
 * Unmatched requests throw, so a test fails loudly when an adapter calls an unexpected URL.
 * Importing this module also turns retry sleeps into no-ops (see `recordSleeps`).
 */

import { setSleepForTesting } from '../../src/providers/http';
import type { MetricsSnapshot, ProviderContext } from '../../src/providers/types';

export const NOW = Date.parse('2026-11-05T12:00:00.000Z');

export interface FakeResponse {
  status?: number;
  /** Serialised with JSON.stringify. */
  json?: unknown;
  /** Raw body (wins over `json`). */
  body?: string;
  /** Binary body, e.g. a gzip or zip report (wins over `body` and `json`). */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  /** Never resolves until the request is aborted (timeout tests). */
  hang?: boolean;
  /** Reject like a network failure. */
  networkError?: boolean;
}

export type Responder = FakeResponse | ((url: URL, init: RequestInit | undefined) => FakeResponse | Promise<FakeResponse>);

export interface Route {
  method: string;
  test: (url: URL) => boolean;
  /** One responder, or a sequence (the last one repeats). */
  responders: Responder[];
  hits: number;
  label: string;
}

export interface RouteOptions {
  method?: string;
  /** Every listed param must be present with exactly this value (arrays: all values, in order). */
  query?: Record<string, string | string[]>;
  /** Params that must be absent. */
  absent?: string[];
}

/** Matches on pathname (string = exact, RegExp = test) plus optional query constraints. */
export function route(path: string | RegExp, responder: Responder | Responder[], opts: RouteOptions = {}): Route {
  const test = (url: URL): boolean => {
    const okPath = typeof path === 'string' ? url.pathname === path : path.test(url.pathname);
    if (!okPath) return false;
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      const got = url.searchParams.getAll(k);
      const want = Array.isArray(v) ? v : [v];
      if (got.length !== want.length || got.some((g, i) => g !== want[i])) return false;
    }
    for (const k of opts.absent ?? []) if (url.searchParams.has(k)) return false;
    return true;
  };
  return {
    method: (opts.method ?? 'GET').toUpperCase(),
    test,
    responders: Array.isArray(responder) ? responder : [responder],
    hits: 0,
    label: `${String(path)} ${JSON.stringify(opts.query ?? {})}`,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Request body (POST read queries), if any. */
  body?: string;
}

export function fakeFetch(routes: Route[]): { fetch: typeof fetch; calls: RecordedCall[]; routes: Route[] } {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: url.toString(), method, headers, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });

    const r = routes.find((x) => x.method === method && x.test(url));
    if (!r) throw new Error(`fakeFetch: no route for ${method} ${url.toString()}`);
    const responder = r.responders[Math.min(r.hits, r.responders.length - 1)]!;
    r.hits += 1;
    const spec = typeof responder === 'function' ? await responder(url, init) : responder;

    if (spec.networkError) throw new TypeError('fetch failed');
    if (spec.hang) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    if (spec.bytes) {
      return new Response(spec.bytes.slice(), {
        status: spec.status ?? 200,
        headers: { 'content-type': 'application/octet-stream', ...spec.headers },
      });
    }
    const body = spec.body ?? (spec.json === undefined ? '' : JSON.stringify(spec.json));
    return new Response(body, {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json', ...spec.headers },
    });
  };
  return { fetch: impl as typeof fetch, calls, routes };
}

export interface TestCtx extends ProviderContext {
  logs: Array<{ event: string; data?: Record<string, unknown> }>;
}

export function makeCtx(fetchImpl: typeof fetch, opts: { now?: number; pageBudget?: number } = {}): TestCtx {
  const logs: TestCtx['logs'] = [];
  return {
    fetch: fetchImpl,
    now: () => opts.now ?? NOW,
    log: (event, data) => logs.push({ event, data }),
    pageBudget: opts.pageBudget ?? 50,
    logs,
  };
}

/** Records requested retry sleeps instead of waiting. Call again to reset. */
export function recordSleeps(): number[] {
  const sleeps: number[] = [];
  setSleepForTesting((ms) => {
    sleeps.push(ms);
  });
  return sleeps;
}

// Default for every test file that imports the harness: retries never actually wait.
setSleepForTesting(() => undefined);

/**
 * Fails the test unless the snapshot lists every subscription it counts, once each, and their
 * amounts add up to its MRR (`MetricsSnapshot.subscriptions`, for the movement diff).
 */
export function expectSubscriptionsAddUp(snap: MetricsSnapshot): void {
  const list = snap.subscriptions ?? null;
  if (!list) throw new Error('the snapshot lists no subscriptions');
  if (list.length !== snap.activeSubscriptions) throw new Error(`${list.length} subscriptions listed, ${snap.activeSubscriptions} counted`);
  if (new Set(list.map((s) => s.id)).size !== list.length) throw new Error('a subscription is listed twice');
  const sum: Record<string, number> = {};
  for (const s of list) {
    if (!Number.isInteger(s.mrr) || s.mrr < 0) throw new Error(`subscription ${s.id}: mrr ${s.mrr}`);
    if (s.mrr > 0) sum[s.currency.toUpperCase()] = (sum[s.currency.toUpperCase()] ?? 0) + s.mrr;
  }
  const sorted = (m: Record<string, number>) => JSON.stringify(Object.entries(m).sort());
  if (sorted(sum) !== sorted(snap.mrr)) throw new Error(`subscriptions add up to ${sorted(sum)}, MRR is ${sorted(snap.mrr)}`);
}

/** Fails the test if any log line contains a secret-looking value. */
export function expectNoSecretsInLogs(ctx: TestCtx, secrets: string[]): void {
  const dump = JSON.stringify(ctx.logs);
  for (const s of secrets) {
    if (s && dump.includes(s)) throw new Error(`log output leaked a secret: ${s.slice(0, 6)}…`);
  }
}
