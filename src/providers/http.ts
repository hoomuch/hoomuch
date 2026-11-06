/**
 * Shared HTTP client for provider adapters. Owner: Data Plane.
 *
 * Every upstream call goes through `fetchJson` (or `fetchBytes`, for report files), which
 *   - enforces a per-request timeout,
 *   - retries 429 / 5xx / network failures (max 3 attempts, honours Retry-After),
 *   - spends one unit of `ctx.pageBudget` per logical request (retries are free),
 *   - starts nothing after `ctx.deadline`, and stops at once when `ctx.signal` aborts,
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
/** Input cap for sanitizeErrorText (a provider controls the text, so its size is untrusted). */
const SANITIZE_INPUT_MAX = 16 * 1024;
/**
 * Largest response body read from a provider. Real pages are well under 1 MB; anything bigger is a
 * provider fault, and reading it whole could exhaust the Worker's 128 MB memory.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** How much of an error body is read for its message. */
const ERROR_BODY_MAX_BYTES = 64 * 1024;

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
  /**
   * OAuth 2.0 token request only (Google's service-account JWT grant): sent as `POST` with
   * `Content-Type: application/x-www-form-urlencoded`. It trades a signed assertion for a short-lived
   * access token at the identity provider; it never creates or changes anything in the account.
   */
  tokenForm?: Record<string, string>;
}

/** A report file download (`fetchBytes`). */
export interface DownloadSpec extends RequestSpec {
  /** Largest body accepted, in bytes. Defaults to `MAX_REPORT_BYTES`. */
  maxBytes?: number;
}

/**
 * Largest report file read from a provider (App Store Connect's gzip reports, Google Play's zipped
 * monthly sales report). Bigger than `MAX_RESPONSE_BYTES` because these are compressed exports of a
 * whole day or month, not pages; they are decompressed as a stream, never held expanded in memory.
 */
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;

/**
 * Thrown when a request can't start: `ctx.pageBudget` is spent (`reason: 'budget'`), or the context's
 * deadline has passed or its signal aborted (`'deadline'`). Adapters should check `hasBudget` first
 * and return a cursor.
 */
export class BudgetExhaustedError extends ProviderError {
  readonly reason: 'budget' | 'deadline';

  constructor(provider: string, reason: 'budget' | 'deadline' = 'budget') {
    super(
      'upstream',
      reason === 'deadline'
        ? `Stopped at the per-sync time limit for ${provider}.`
        : `Stopped after the per-sync request limit for ${provider}.`,
    );
    this.name = 'BudgetExhaustedError';
    this.reason = reason;
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

/** Contexts whose deadline was already logged (once per context). */
const deadlineLogged = new WeakSet<ProviderContext>();

/** True once the context's deadline has passed or its signal fired. Logs the first time. */
export function outOfTime(ctx: ProviderContext): boolean {
  const late = ctx.signal?.aborted === true || (ctx.deadline !== undefined && ctx.now() >= ctx.deadline);
  if (late && !deadlineLogged.has(ctx)) {
    deadlineLogged.add(ctx);
    ctx.log('sync_deadline_reached', { unusedBudget: Math.max(0, ctx.pageBudget) });
  }
  return late;
}

/** True when at least `n` more upstream requests are allowed for this call (budget and time). */
export function hasBudget(ctx: ProviderContext, n = 1): boolean {
  return ctx.pageBudget >= n && !outOfTime(ctx);
}

/**
 * Lowers `ctx.pageBudget` to at most `max` for the rest of the call, for a provider whose per-minute rate
 * limit is below the sync's own budget. Requests run back to back, so a sync that may only make `max` of
 * them can't go over a limit it stays under in total; running out then reads as an empty budget
 * (`BudgetExhaustedError`), not as a 429 that the next sync would hit again.
 */
export function capBudget(ctx: ProviderContext, max: number): void {
  if (ctx.pageBudget > max) ctx.pageBudget = max;
}

/** A retry wait that would end past the deadline isn't worth starting: the retry could never run. */
function canWait(ctx: ProviderContext, ms: number): boolean {
  return ctx.deadline === undefined || ctx.now() + ms < ctx.deadline;
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
  // Paths are always relative to the provider's base: a request carrying a key never leaves its
  // host, even if an absolute URL or a scheme-relative "//host" ever reached here from data.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) {
    throw new Error('buildUrl: path must be relative to the provider base');
  }
  const url = new URL(base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
  if (url.origin !== new URL(base).origin) throw new Error('buildUrl: path left the provider host');
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// ---------- sanitising ----------

const MASKS: Array<[RegExp, string]> = [
  // PEM private keys (App Store Connect .p8 files, Google service-account keys), whole or cut short.
  [/-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----[\s\S]{0,8192}?(-----END [A-Z ]{0,20}PRIVATE KEY-----|$)/g, '[private key]'],
  [/(Bearer|Basic)\s+[^\s"',]+/gi, '$1 ***'],
  // Google OAuth access tokens.
  [/\bya29\.[A-Za-z0-9._-]+/g, 'ya29.***'],
  // Paddle (pdl_live_apikey_…, pdl_sdbx_apikey_…), Polar (polar_oat_…, polar_pat_…), Dodo, Creem.
  [/\b(pdl_(?:live|sdbx)_apikey|polar_[a-z]{2,4}|dodo_(?:live|test)|creem(?:_test)?)_[A-Za-z0-9_]+/g, '$1_***'],
  // Adapty secret / public SDK keys: secret_live_XXXXXXXX.<32 chars>.
  [/\b(secret|public)_([a-z]+)_[A-Za-z0-9._-]+/g, '$1_$2_***'],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, '$1_$2_***'],
  [/\b(sk|rk|atk|whsec)_[A-Za-z0-9_]{6,}/g, '$1_***'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*\.?[A-Za-z0-9_-]*/g, '[token]'],
  // Bounded quantifiers: unbounded ones backtrack quadratically on a long run of word characters
  // (a base64 blob in an error body took ~20 s of CPU at 200 KB).
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g, '[email]'],
  [/[A-Za-z0-9_-]{32,}/g, '[redacted]'],
];

/** Collapses whitespace, masks key-like strings and e-mail addresses, truncates to ≤ `max` chars. */
export function sanitizeErrorText(input: string, max = ERROR_TEXT_MAX): string {
  // Only the first few KB can survive truncation anyway; don't spend CPU masking the rest.
  let s = input.slice(0, SANITIZE_INPUT_MAX).replace(/\s+/g, ' ').trim();
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

export class ResponseTooLargeError extends Error {}

/** Reads the body as bytes, giving up (and cancelling the stream) once it passes `max` bytes. */
export async function readBytesBounded(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Reads the body as text, giving up (and cancelling the stream) once it passes `max` bytes. */
export async function readTextBounded(res: Response, max: number): Promise<string> {
  return new TextDecoder().decode(await readBytesBounded(res, max));
}

interface WireRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | undefined;
}

/** The context's signal fired mid-request: the sync is out of time, so nothing is retried. */
class AbortedBySyncError extends Error {}

async function fetchWithTimeout(ctx: ProviderContext, url: string, req: WireRequest, timeoutMs: number, maxBytes: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
  try {
    // Never follow redirects: the request carries the provider key, and these APIs don't redirect.
    const res = await ctx.fetch(url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal,
      redirect: 'manual',
    });
    const bytes = await readBytesBounded(res, maxBytes);
    return { res, bytes };
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw err; // not a network blip: retrying won't help
    if (ctx.signal?.aborted) throw new AbortedBySyncError();
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
 * GETs `spec.url` (or POSTs `spec.readQuery` to a read-only query endpoint, or `spec.tokenForm` to an
 * OAuth token endpoint) and returns the parsed JSON body. Throws `ProviderError` on every failure.
 * Read-only by design: hoomuch never writes to a provider.
 */
export async function fetchJson<T = unknown>(ctx: ProviderContext, spec: RequestSpec): Promise<T> {
  return (await request(ctx, spec, 'json', MAX_RESPONSE_BYTES)) as T;
}

/**
 * GETs a report file (gzip, zip, CSV) and returns its bytes, with the same budget, retry, redirect
 * and error rules as `fetchJson`. Error bodies are still read as JSON for their message.
 */
export async function fetchBytes(ctx: ProviderContext, spec: DownloadSpec): Promise<Uint8Array> {
  return (await request(ctx, spec, 'bytes', spec.maxBytes ?? MAX_REPORT_BYTES)) as Uint8Array;
}

function wireRequest(spec: RequestSpec, mode: 'json' | 'bytes'): WireRequest {
  const headers: Record<string, string> = { Accept: mode === 'json' ? 'application/json' : '*/*', ...spec.headers };
  if (spec.tokenForm !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return { method: 'POST', headers, body: new URLSearchParams(spec.tokenForm).toString() };
  }
  if (spec.readQuery !== undefined) {
    headers['Content-Type'] = 'application/json';
    return { method: 'POST', headers, body: JSON.stringify(spec.readQuery) };
  }
  return { method: 'GET', headers, body: undefined };
}

async function request(ctx: ProviderContext, spec: RequestSpec, mode: 'json' | 'bytes', maxBytes: number): Promise<unknown> {
  if (outOfTime(ctx)) throw new BudgetExhaustedError(spec.provider, 'deadline');
  if (ctx.pageBudget < 1) throw new BudgetExhaustedError(spec.provider);
  ctx.pageBudget -= 1;

  const provider = spec.provider;
  const path = pathOf(spec.url);
  const maxAttempts = Math.max(1, spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wire = wireRequest(spec, mode);

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    let bytes: Uint8Array;
    try {
      ({ res, bytes } = await fetchWithTimeout(ctx, spec.url, wire, timeoutMs, maxBytes));
    } catch (err) {
      if (err instanceof AbortedBySyncError) {
        outOfTime(ctx); // logs the deadline once
        ctx.log('http_error', { provider, path, attempt, reason: 'aborted' });
        throw new BudgetExhaustedError(provider, 'deadline');
      }
      if (err instanceof ResponseTooLargeError) {
        ctx.log('http_error', { provider, path, attempt, reason: 'too_large' });
        throw new ProviderError(
          'upstream',
          mode === 'bytes'
            ? `${provider} sent a report file too large to read (over ${Math.round(maxBytes / (1024 * 1024))} MB).`
            : `${provider} sent a response too large to read.`,
        );
      }
      const reason = err instanceof RetryableNetworkError ? err.message : 'network';
      const wait = backoffMs(attempt);
      if (attempt < maxAttempts && canWait(ctx, wait) && !ctx.signal?.aborted) {
        ctx.log('http_retry', { provider, path, attempt, reason });
        await sleepImpl(wait);
        continue;
      }
      ctx.log('http_error', { provider, path, attempt, reason });
      throw new ProviderError(
        'upstream',
        reason === 'timeout' ? `${provider} did not respond in time.` : `Couldn’t reach ${provider}.`,
      );
    }

    if (res.ok && mode === 'bytes') return bytes;

    // Error bodies are small JSON; a report-sized one is a fault, and only its start can matter.
    const text = new TextDecoder().decode(res.ok ? bytes : bytes.subarray(0, ERROR_BODY_MAX_BYTES));
    const body = parseJsonOrNull(text);

    if (res.ok) {
      if (body === undefined || body === null) {
        ctx.log('http_error', { provider, path, status: res.status, reason: 'bad_json' });
        throw new ProviderError('upstream', `${provider} returned a response hoomuch couldn’t read.`, {
          status: res.status,
        });
      }
      return body;
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
      const wait = hinted ?? backoffMs(attempt);
      if (wait <= MAX_RETRY_WAIT_MS && canWait(ctx, wait) && !ctx.signal?.aborted) {
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
