/**
 * Shared HTTP client for provider adapters. Owner: Data Plane.
 *
 * Every upstream call goes through `fetchJson`, which
 *   - enforces a per-request timeout,
 *   - retries 429 / 5xx / network failures (max 3 attempts, honours Retry-After),
 *   - spends one unit of `ctx.pageBudget` per logical request (retries are free),
 *   - maps failures to `ProviderError` with user-safe messages,
 *   - never logs headers, keys, query strings or response bodies verbatim.
 */

import { ProviderError, type ProviderContext } from './types';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Longest Retry-After we are willing to sleep through; beyond this we give up with `rate_limit`. */
export const MAX_RETRY_WAIT_MS = 10_000;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 4_000;
const ERROR_TEXT_MAX = 300;

export interface RequestSpec {
  /** Display name used in messages and logs, e.g. "Stripe". */
  provider: string;
  url: string;
  headers?: Record<string, string>;
  /** Human-readable permission this endpoint needs; used verbatim in 403 messages. */
  permission?: string;
  /** User-facing message for a 404, e.g. "Project not found. Check the Project ID." */
  notFoundMessage?: string;
  /** Form field a 403/404 belongs to, if any (surfaced on the add-connection form). */
  field?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /**
   * What a 429 does. 'retry' (default) sleeps through a short Retry-After / backoff and retries.
   * 'yield' gives up at once and empties `ctx.pageBudget`, for providers whose limit is a per-minute
   * window with no usable Retry-After (Lemon Squeezy), or that block for longer than we'd wait (Paddle:
   * 60 s per IP). Resumable callers catch `RateLimitedError` and return their cursor.
   */
  rateLimit?: 'retry' | 'yield';
  /**
   * Provider-specific error mapping for non-2xx responses, tried before the generic status mapping.
   * Return null to fall through. E.g. Paddle answers an invalid key with 403, not 401.
   */
  mapError?: (status: number, body: unknown, detail: string) => ProviderError | null;
  /**
   * JSON query for read endpoints that take their query as a POST body (Adapty's analytics export,
   * Superwall's chart data query). Sent as `POST` with `Content-Type: application/json`. Only for
   * endpoints documented as read-only queries: hoomuch never creates or changes anything at a provider.
   */
  readQuery?: unknown;
}

/** Thrown when `ctx.pageBudget` is exhausted. Adapters should check `hasBudget` first and return a cursor. */
export class BudgetExhaustedError extends ProviderError {
  constructor(provider: string) {
    super('upstream', `Stopped after the per-sync request limit for ${provider}.`);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * A 429 under `rateLimit: 'yield'`. The context's budget is already 0, so loops that check `hasBudget`
 * stop on their own; a resumable adapter catches this and returns its cursor, keeping what it read.
 */
export class RateLimitedError extends ProviderError {
  constructor(provider: string, status: number) {
    super('rate_limit', `${provider} is rate-limiting requests. Try again in a minute.`, { status });
    this.name = 'RateLimitedError';
  }
}

/** True when at least `n` more upstream requests are allowed for this call. */
export function hasBudget(ctx: ProviderContext, n = 1): boolean {
  return ctx.pageBudget >= n;
}

// ---------- sleeping (overridable in tests) ----------

let sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tests replace the sleeper so retries don't wait. Pass null to restore the real one. */
export function setSleepForTesting(fn: ((ms: number) => Promise<void> | void) | null): void {
  sleepImpl = fn
    ? async (ms) => {
        await fn(ms);
      }
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- URL helpers ----------

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;

/** Joins base + path and appends query params; arrays become repeated keys, null/undefined are skipped. */
export function buildUrl(base: string, path: string, query: Record<string, QueryValue> = {}): string {
  const url = new URL(path.startsWith('http') ? path : base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// ---------- sanitising ----------

const MASKS: Array<[RegExp, string]> = [
  [/(Bearer|Basic)\s+[^\s"',]+/gi, '$1 ***'],
  // Paddle (pdl_live_apikey_…, pdl_sdbx_apikey_…), Polar (polar_oat_…, polar_pat_…), Dodo, Creem.
  [/\b(pdl_(?:live|sdbx)_apikey|polar_[a-z]{2,4}|dodo_(?:live|test)|creem(?:_test)?)_[A-Za-z0-9_]+/g, '$1_***'],
  // Adapty secret / public SDK keys: secret_live_XXXXXXXX.<32 chars>.
  [/\b(secret|public)_([a-z]+)_[A-Za-z0-9._-]+/g, '$1_$2_***'],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, '$1_$2_***'],
  [/\b(sk|rk|atk|whsec)_[A-Za-z0-9_]{6,}/g, '$1_***'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*\.?[A-Za-z0-9_-]*/g, '[token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/[A-Za-z0-9_-]{32,}/g, '[redacted]'],
];

/** Collapses whitespace, masks key-like strings and e-mail addresses, truncates to ≤ `max` chars. */
export function sanitizeErrorText(input: string, max = ERROR_TEXT_MAX): string {
  let s = input.replace(/\s+/g, ' ').trim();
  for (const [re, rep] of MASKS) s = s.replace(re, rep);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Pulls a human message out of the common error shapes (Stripe, JSON:API, RevenueCat v2). */
function extractProviderMessage(body: unknown, raw: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const err = b['error'];
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>)['message'] === 'string') {
      return (err as Record<string, string>)['message']!;
    }
    if (typeof err === 'string') return err;
    const errors = b['errors'];
    if (Array.isArray(errors) && errors.length > 0 && errors[0] && typeof errors[0] === 'object') {
      const e0 = errors[0] as Record<string, unknown>;
      const detail = typeof e0['detail'] === 'string' ? e0['detail'] : undefined;
      const title = typeof e0['title'] === 'string' ? e0['title'] : undefined;
      if (detail || title) return detail ?? title!;
    }
    if (typeof b['message'] === 'string') return b['message'];
  }
  return raw;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
}

// ---------- retry timing ----------

/** Parses Retry-After (seconds or HTTP date) or RevenueCat's `backoff_ms`; null when absent. */
export function retryAfterMs(res: Response, body: unknown, now: number): number | null {
  const h = res.headers.get('retry-after');
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  if (body && typeof body === 'object') {
    const b = (body as Record<string, unknown>)['backoff_ms'];
    if (typeof b === 'number' && b >= 0) return b;
  }
  return null;
}

function backoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return exp + Math.floor(Math.random() * 200);
}

// ---------- the client ----------

class RetryableNetworkError extends Error {}

async function fetchWithTimeout(
  ctx: ProviderContext,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  body: string | undefined,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow redirects: the request carries the provider key, and these APIs don't redirect.
    const method = body === undefined ? 'GET' : 'POST';
    const res = await ctx.fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
    const text = await res.text();
    return { res, text };
  } catch (err) {
    throw new RetryableNetworkError(controller.signal.aborted ? 'timeout' : err instanceof Error ? err.name : 'network');
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // distinguishes "not JSON" from "empty"
  }
}

/**
 * GETs `spec.url` (or POSTs `spec.readQuery` to a read-only query endpoint) and returns the parsed JSON
 * body. Throws `ProviderError` on every failure. Read-only by design: hoomuch never writes to a provider.
 */
export async function fetchJson<T = unknown>(ctx: ProviderContext, spec: RequestSpec): Promise<T> {
  if (!hasBudget(ctx)) throw new BudgetExhaustedError(spec.provider);
  ctx.pageBudget -= 1;

  const provider = spec.provider;
  const path = pathOf(spec.url);
  const maxAttempts = Math.max(1, spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = { Accept: 'application/json', ...spec.headers };
  const queryBody = spec.readQuery === undefined ? undefined : JSON.stringify(spec.readQuery);
  if (queryBody !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    let text: string;
    try {
      ({ res, text } = await fetchWithTimeout(ctx, spec.url, headers, timeoutMs, queryBody));
    } catch (err) {
      const reason = err instanceof RetryableNetworkError ? err.message : 'network';
      if (attempt < maxAttempts) {
        ctx.log('http_retry', { provider, path, attempt, reason });
        await sleepImpl(backoffMs(attempt));
        continue;
      }
      ctx.log('http_error', { provider, path, attempt, reason });
      throw new ProviderError(
        'upstream',
        reason === 'timeout' ? `${provider} did not respond in time.` : `Couldn’t reach ${provider}.`,
      );
    }

    const body = parseJsonOrNull(text);

    if (res.ok) {
      if (body === undefined || body === null) {
        ctx.log('http_error', { provider, path, status: res.status, reason: 'bad_json' });
        throw new ProviderError('upstream', `${provider} returned a response hoomuch couldn’t read.`, {
          status: res.status,
        });
      }
      return body as T;
    }

    const status = res.status;
    if (status === 429 && spec.rateLimit === 'yield') {
      ctx.pageBudget = 0;
      ctx.log('http_rate_limited', { provider, path, attempt });
      throw new RateLimitedError(provider, status);
    }
    const retryable = status === 429 || status >= 500;
    if (retryable && attempt < maxAttempts) {
      const hinted = retryAfterMs(res, body, ctx.now());
      if (hinted === null || hinted <= MAX_RETRY_WAIT_MS) {
        const wait = hinted ?? backoffMs(attempt);
        ctx.log('http_retry', { provider, path, status, attempt, waitMs: wait });
        await sleepImpl(wait);
        continue;
      }
    }

    const detail = sanitizeErrorText(extractProviderMessage(body, text));
    ctx.log('http_error', { provider, path, status, attempt, message: detail });
    throw spec.mapError?.(status, body, detail) ?? mapStatus(spec, status, detail);
  }
}

function mapStatus(spec: RequestSpec, status: number, detail: string): ProviderError {
  const { provider } = spec;
  const opts = { status, field: spec.field };
  if (status === 401) {
    return new ProviderError('auth', `${provider} rejected the API key.`, { status, field: 'apiKey' });
  }
  if (status === 403) {
    // Stripe names the exact scope, e.g. "Having the 'rak_subscription_read' permission would allow…".
    const scope = /'(rak_[a-z0-9_]+)'/.exec(detail)?.[1];
    const msg = spec.permission
      ? `The ${provider} key is missing the “${spec.permission}” permission${scope ? ` (${scope})` : ''}.`
      : `${provider} denied access${detail ? `: ${detail}` : '.'}`;
    return new ProviderError('permission', msg, { status, field: spec.field ?? 'apiKey' });
  }
  if (status === 404) {
    return new ProviderError('not_found', spec.notFoundMessage ?? `${provider} couldn’t find ${pathOf(spec.url)}.`, opts);
  }
  if (status === 429) {
    return new ProviderError('rate_limit', `${provider} is rate-limiting requests. Try again in a minute.`, { status });
  }
  if (status >= 500) {
    return new ProviderError('upstream', `${provider} is having problems right now (HTTP ${status}).`, { status });
  }
  return new ProviderError('upstream', `${provider} returned HTTP ${status}${detail ? `: ${detail}` : '.'}`, opts);
}
