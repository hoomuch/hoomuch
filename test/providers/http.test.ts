import { describe, expect, it } from 'vitest';
import {
  BudgetExhaustedError,
  buildUrl,
  fetchJson,
  hasBudget,
  sanitizeErrorText,
} from '../../src/providers/http';
import { ProviderError } from '../../src/providers/types';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, recordSleeps, route } from '../fixtures/harness';

const URL_ = 'https://api.example.com/v1/things?limit=1';
const spec = (extra: Partial<Parameters<typeof fetchJson>[1]> = {}) => ({
  provider: 'Example',
  url: URL_,
  headers: { Authorization: 'Bearer sk_live_supersecret123456' },
  ...extra,
});

async function catchErr(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProviderError) return e;
    throw e;
  }
  throw new Error('expected a ProviderError');
}

describe('fetchJson', () => {
  it('returns parsed JSON and spends one unit of budget', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/things', { json: { ok: 1 } })]);
    const ctx = makeCtx(fetch, { pageBudget: 2 });
    await expect(fetchJson(ctx, spec())).resolves.toEqual({ ok: 1 });
    expect(ctx.pageBudget).toBe(1);
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk_live_supersecret123456');
    expect(calls[0]!.headers['accept']).toBe('application/json');
  });

  it('refuses to call when the budget is exhausted', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/things', { json: {} })]);
    const ctx = makeCtx(fetch, { pageBudget: 0 });
    expect(hasBudget(ctx)).toBe(false);
    await expect(fetchJson(ctx, spec())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toHaveLength(0);
  });

  it('retries 5xx with backoff and succeeds without spending extra budget', async () => {
    const sleeps = recordSleeps();
    const { fetch, calls } = fakeFetch([
      route('/v1/things', [{ status: 502, body: 'bad gateway' }, { status: 503, json: {} }, { json: { ok: true } }]),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    await expect(fetchJson(ctx, spec())).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]! - 200); // exponential, with jitter
    expect(ctx.pageBudget).toBe(4);
  });

  it('honours Retry-After seconds on 429', async () => {
    const sleeps = recordSleeps();
    const { fetch } = fakeFetch([
      route('/v1/things', [{ status: 429, headers: { 'retry-after': '2' }, json: {} }, { json: { ok: 1 } }]),
    ]);
    await fetchJson(makeCtx(fetch), spec());
    expect(sleeps).toEqual([2000]);
  });

  it('honours RevenueCat-style backoff_ms in the body', async () => {
    const sleeps = recordSleeps();
    const { fetch } = fakeFetch([
      route('/v1/things', [{ status: 429, json: { type: 'rate_limit_error', backoff_ms: 750 } }, { json: {} }]),
    ]);
    await fetchJson(makeCtx(fetch), spec());
    expect(sleeps).toEqual([750]);
  });

  it('gives up with rate_limit after 3 attempts', async () => {
    recordSleeps();
    const { fetch, calls } = fakeFetch([route('/v1/things', { status: 429, json: {} })]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec()));
    expect(err.kind).toBe('rate_limit');
    expect(calls).toHaveLength(3);
  });

  it('does not sleep through an excessive Retry-After', async () => {
    const sleeps = recordSleeps();
    const { fetch, calls } = fakeFetch([route('/v1/things', { status: 429, headers: { 'retry-after': '120' }, json: {} })]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec()));
    expect(err.kind).toBe('rate_limit');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('maps 401 to auth on the apiKey field', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/things', { status: 401, json: { error: { message: 'Invalid API Key provided: sk_live_****3456' } } })]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec()));
    expect(err.kind).toBe('auth');
    expect(err.field).toBe('apiKey');
    expect(calls).toHaveLength(1); // never retried
  });

  it('maps 403 to permission, naming the permission and Stripe scope', async () => {
    const { fetch } = fakeFetch([
      route('/v1/things', {
        status: 403,
        json: {
          error: {
            message:
              "The provided key 'rk_live_51HabcdefGHIJKLmnop' does not have the required permissions for this endpoint on account 'acct_1Abc'. Having the 'rak_subscription_read' permission would allow this request to continue.",
          },
        },
      }),
    ]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec({ permission: 'Subscriptions: Read' })));
    expect(err.kind).toBe('permission');
    expect(err.message).toBe('The Example key is missing the “Subscriptions: Read” permission (rak_subscription_read).');
  });

  it('maps 403 without a declared permission to the sanitised provider message', async () => {
    const { fetch } = fakeFetch([route('/v1/things', { status: 403, json: { errors: [{ detail: 'Key rk_live_abcdefgh is not allowed' }] } })]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec()));
    expect(err.kind).toBe('permission');
    expect(err.message).toContain('rk_live_***');
    expect(err.message).not.toContain('abcdefgh');
  });

  it('maps 404 to not_found with the caller message and field', async () => {
    const { fetch } = fakeFetch([route('/v1/things', { status: 404, json: { message: 'nope' } })]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec({ notFoundMessage: 'Project not found.', field: 'projectId' })));
    expect(err.kind).toBe('not_found');
    expect(err.message).toBe('Project not found.');
    expect(err.field).toBe('projectId');
  });

  it('maps exhausted 5xx, network errors, timeouts and bad JSON to upstream', async () => {
    recordSleeps();
    const cases: Array<[Parameters<typeof route>[1], RegExp]> = [
      [{ status: 500, body: '<html>oops</html>' }, /HTTP 500/],
      [{ networkError: true }, /Couldn’t reach Example/],
      [{ body: 'not json' }, /couldn’t read/],
      [{ body: '' }, /couldn’t read/],
    ];
    for (const [responder, msg] of cases) {
      const { fetch } = fakeFetch([route('/v1/things', responder)]);
      const err = await catchErr(fetchJson(makeCtx(fetch), spec()));
      expect(err.kind).toBe('upstream');
      expect(err.message).toMatch(msg);
    }
    const { fetch, calls } = fakeFetch([route('/v1/things', { hang: true })]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec({ timeoutMs: 5 })));
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/did not respond in time/);
    expect(calls).toHaveLength(3);
  });

  it('never follows redirects (the request carries the key) and treats 3xx as upstream', async () => {
    let redirectMode: RequestInit['redirect'];
    const { fetch, calls } = fakeFetch([
      route('/v1/things', (_url, init) => {
        redirectMode = init?.redirect;
        return { status: 302, headers: { location: 'https://evil.example.net/steal' }, body: '' };
      }),
    ]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec()));
    expect(redirectMode).toBe('manual');
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/HTTP 302/);
    expect(calls).toHaveLength(1);
  });

  it('maps other 4xx to upstream with a truncated, masked detail and no retry', async () => {
    const long = 'x'.repeat(50) + ' customer jane@example.com used sk_live_abcdefghijkl ' + 'y '.repeat(400);
    const { fetch, calls } = fakeFetch([route('/v1/things', { status: 400, json: { error: { message: long } } })]);
    const ctx = makeCtx(fetch);
    const err = await catchErr(fetchJson(ctx, spec()));
    expect(err.kind).toBe('upstream');
    expect(err.message.length).toBeLessThanOrEqual(340);
    expect(err.message).not.toContain('jane@example.com');
    expect(err.message).not.toContain('abcdefghijkl');
    expect(calls).toHaveLength(1);
    expectNoSecretsInLogs(ctx, ['sk_live_supersecret123456', 'jane@example.com', 'sk_live_abcdefghijkl']);
    expect(JSON.stringify(ctx.logs)).not.toContain('limit=1'); // only the path is logged
  });
});

describe('sanitizeErrorText', () => {
  it('masks keys, tokens, bearer headers and e-mails, and truncates', () => {
    const s = sanitizeErrorText(
      'Bearer abc.def rk_test_51Habc sk_9f8e7d6c5b4a eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig a@b.co ' +
        'A'.repeat(40),
    );
    expect(s).toBe('Bearer *** rk_test_*** sk_*** [token] [email] [redacted]');
    expect(sanitizeErrorText('z'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});

describe('buildUrl', () => {
  it('joins paths and encodes repeated and bracketed params', () => {
    const u = buildUrl('https://api.stripe.com/v1/', '/subscriptions', {
      limit: 100,
      'expand[]': ['data.discounts', 'data.items.data.price'],
      starting_after: undefined,
      status: null,
    });
    const parsed = new URL(u);
    expect(parsed.pathname).toBe('/v1/subscriptions');
    expect(parsed.searchParams.getAll('expand[]')).toEqual(['data.discounts', 'data.items.data.price']);
    expect(parsed.searchParams.has('starting_after')).toBe(false);
    expect(parsed.searchParams.has('status')).toBe(false);
  });
});
