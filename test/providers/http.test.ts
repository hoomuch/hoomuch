import { describe, expect, it } from 'vitest';
import {
  BudgetExhaustedError,
  buildUrl,
  fetchBytes,
  fetchJson,
  hasBudget,
  MAX_RETRY_WAIT_MS,
  RateLimitedError,
  sanitizeErrorText,
} from '../../src/providers/http';
import { ProviderError } from '../../src/providers/types';
import { expectNoSecretsInLogs, fakeFetch, makeCtx, NOW, recordSleeps, route } from '../fixtures/harness';

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
    // Exponential from 400 ms, plus up to 200 ms of jitter: attempt 1 waits [400, 600), attempt 2 [800, 1000).
    // (The old `sleeps[1] > sleeps[0] - 200` also passed for a constant backoff.)
    expect(sleeps[0]!).toBeGreaterThanOrEqual(400);
    expect(sleeps[0]!).toBeLessThan(600);
    expect(sleeps[1]!).toBeGreaterThanOrEqual(800);
    expect(sleeps[1]!).toBeLessThan(1000);
    expect(ctx.pageBudget).toBe(4);
  });

  it('honours Retry-After as an HTTP date, measured against the injected clock', async () => {
    const sleeps = recordSleeps();
    const at = new Date(NOW + 3_000).toUTCString(); // whole seconds, so exactly 3 s after NOW
    const { fetch } = fakeFetch([route('/v1/things', [{ status: 503, headers: { 'retry-after': at }, json: {} }, { json: { ok: 1 } }])]);
    await expect(fetchJson(makeCtx(fetch, { now: NOW }), spec())).resolves.toEqual({ ok: 1 });
    expect(sleeps).toEqual([3_000]);
  });

  it('sleeps through a Retry-After of exactly the 10 s cap, but not one second more', async () => {
    const sleeps = recordSleeps();
    const ok = fakeFetch([route('/v1/things', [{ status: 429, headers: { 'retry-after': '10' }, json: {} }, { json: { ok: 1 } }])]);
    await expect(fetchJson(makeCtx(ok.fetch), spec())).resolves.toEqual({ ok: 1 });
    expect(sleeps).toEqual([MAX_RETRY_WAIT_MS]);

    const over = fakeFetch([route('/v1/things', { status: 429, headers: { 'retry-after': '11' }, json: {} })]);
    const err = await catchErr(fetchJson(makeCtx(over.fetch), spec()));
    expect(err.kind).toBe('rate_limit');
    expect(over.calls).toHaveLength(1);
    expect(sleeps).toEqual([MAX_RETRY_WAIT_MS]); // no second sleep
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

  it('gives up with rate_limit after 3 attempts, spending one unit of budget', async () => {
    const sleeps = recordSleeps();
    const { fetch, calls } = fakeFetch([route('/v1/things', { status: 429, json: {} })]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const err = await catchErr(fetchJson(ctx, spec()));
    expect(err.kind).toBe('rate_limit');
    expect(err.status).toBe(429);
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2); // no sleep after the last attempt
    expect(ctx.pageBudget).toBe(4);
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

  it('maps 404 without a caller message to the path only, never the query string', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/things', { status: 404, json: { message: 'nope' } })]);
    const err = await catchErr(fetchJson(makeCtx(fetch), spec({ url: 'https://api.example.com/v1/things?api_key=sk_live_x1y2z3' })));
    expect(err.kind).toBe('not_found');
    expect(err.message).toBe('Example couldn’t find /v1/things.');
    expect(calls).toHaveLength(1); // 4xx are never retried
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

describe('fetchJson deadline and signal', () => {
  it('starts nothing after the deadline: reason "deadline", no budget spent, logged once', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/things', { json: {} })]);
    const ctx = { ...makeCtx(fetch, { pageBudget: 3, now: NOW }), deadline: NOW };
    const err = await catchErr(fetchJson(ctx, spec()));
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).reason).toBe('deadline');
    expect(hasBudget(ctx)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(ctx.pageBudget).toBe(3);
    expect(ctx.logs.filter((l) => l.event === 'sync_deadline_reached')).toHaveLength(1);
  });

  it('a budget that ran out says "budget", not "deadline"', async () => {
    const { fetch } = fakeFetch([route('/v1/things', { json: {} })]);
    const ctx = { ...makeCtx(fetch, { pageBudget: 0, now: NOW }), deadline: NOW + 60_000 };
    const err = await catchErr(fetchJson(ctx, spec()));
    expect((err as BudgetExhaustedError).reason).toBe('budget');
  });

  it('does not start a retry wait that would end past the deadline', async () => {
    const sleeps = recordSleeps();
    const { fetch, calls } = fakeFetch([route('/v1/things', [{ status: 503, headers: { 'retry-after': '5' }, json: {} }, { json: { ok: 1 } }])]);
    const ctx = { ...makeCtx(fetch, { now: NOW }), deadline: NOW + 4_000 };
    const err = await catchErr(fetchJson(ctx, spec()));
    expect(err.message).toMatch(/HTTP 503/);
    expect(sleeps).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('the signal aborts a request in flight without retrying it', async () => {
    recordSleeps();
    const { fetch, calls } = fakeFetch([route('/v1/things', { hang: true })]);
    const controller = new AbortController();
    const ctx = { ...makeCtx(fetch), signal: controller.signal };
    const pending = catchErr(fetchJson(ctx, spec()));
    await Promise.resolve();
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).reason).toBe('deadline');
    expect(calls).toHaveLength(1);
    expect(ctx.logs.some((l) => l.event === 'http_retry')).toBe(false);
  });

  it('an already-aborted signal stops the request before it starts', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/things', { json: {} })]);
    const ctx = { ...makeCtx(fetch), signal: AbortSignal.abort() };
    expect(hasBudget(ctx)).toBe(false);
    await expect(fetchJson(ctx, spec())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toHaveLength(0);
  });
});

describe('sanitizeErrorText private keys and Google tokens', () => {
  it('masks PEM keys, whole or cut short, and ya29 access tokens', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49\n-----END PRIVATE KEY-----';
    expect(sanitizeErrorText(`bad key ${pem} here`)).toBe('bad key [private key] here');
    expect(sanitizeErrorText('-----BEGIN PRIVATE KEY----- MIGTAgEAMBMGBy')).toBe('[private key]');
    expect(sanitizeErrorText('token ya29.c.b0AXv0zTOabc-def_ghi rejected')).toBe('token ya29.*** rejected');
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

  it('masks Paddle, Polar, Dodo and Creem keys and Basic auth', () => {
    const s = sanitizeErrorText(
      'pdl_sdbx_apikey_01gtgztp8f_abc polar_oat_Xy12 dodo_test_k3y creem_test_abc creem_live1 Basic dXNlcjo=',
    );
    expect(s).toBe('pdl_sdbx_apikey_*** polar_oat_*** dodo_test_*** creem_test_*** creem_*** Basic ***');
    expect(sanitizeErrorText('key secret_live_AbCd1234.0123456789abcdef and public_live_xyz.123')).toBe(
      'key secret_live_*** and public_live_***',
    );
  });
});

describe('fetchJson rateLimit: yield', () => {
  it('gives up on the first 429, empties the budget and does not sleep', async () => {
    const sleeps = recordSleeps();
    const { fetch, calls } = fakeFetch([route('/v1/things', [{ status: 429, json: {} }, { json: { ok: 1 } }])]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const err = await catchErr(fetchJson(ctx, spec({ rateLimit: 'yield' })));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.kind).toBe('rate_limit');
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect(hasBudget(ctx)).toBe(false);
  });

  it('still retries 5xx', async () => {
    recordSleeps();
    const { fetch } = fakeFetch([route('/v1/things', [{ status: 503, json: {} }, { json: { ok: 1 } }])]);
    await expect(fetchJson(makeCtx(fetch, { pageBudget: 5 }), spec({ rateLimit: 'yield' }))).resolves.toEqual({ ok: 1 });
  });
});

describe('fetchJson readQuery', () => {
  it('POSTs the JSON query to a read endpoint, and GETs when there is none', async () => {
    const { fetch, calls } = fakeFetch([
      route('/v1/things', { json: { ok: 'post' } }, { method: 'POST' }),
      route('/v1/things', { json: { ok: 'get' } }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    await expect(fetchJson(ctx, spec({ readQuery: { chart_id: 'mrr' } }))).resolves.toEqual({ ok: 'post' });
    await expect(fetchJson(ctx, spec())).resolves.toEqual({ ok: 'get' });
    expect(calls[0]).toMatchObject({ method: 'POST', body: '{"chart_id":"mrr"}' });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[1]).toMatchObject({ method: 'GET' });
    expect(calls[1]!.body).toBeUndefined();
    expect(calls[1]!.headers['content-type']).toBeUndefined();
  });
});

describe('fetchJson tokenForm', () => {
  it('POSTs a form-encoded OAuth token request', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/things', { json: { access_token: 'ya29.x' } }, { method: 'POST' })]);
    const ctx = makeCtx(fetch);
    await expect(fetchJson(ctx, spec({ tokenForm: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'a.b.c' } }))).resolves.toEqual({
      access_token: 'ya29.x',
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.body).toBe('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=a.b.c');
  });
});

describe('fetchBytes', () => {
  const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00]);

  it('returns the raw body and spends one unit of budget', async () => {
    const { fetch, calls } = fakeFetch([route('/v1/things', { bytes })]);
    const ctx = makeCtx(fetch, { pageBudget: 2 });
    expect(await fetchBytes(ctx, spec())).toEqual(bytes);
    expect(ctx.pageBudget).toBe(1);
    expect(calls[0]!.headers['accept']).toBe('*/*');
  });

  it('retries 5xx and maps error bodies like fetchJson', async () => {
    const { fetch } = fakeFetch([
      route('/v1/things', [{ status: 503, body: 'busy' }, { bytes }]),
      route('/v1/other', { status: 404, json: { errors: [{ detail: 'There were no sales for the date specified.' }] } }),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    expect(await fetchBytes(ctx, spec())).toEqual(bytes);
    const err = await catchErr(fetchBytes(ctx, spec({ url: 'https://api.example.com/v1/other', notFoundMessage: 'No report.' })));
    expect(err).toMatchObject({ kind: 'not_found', message: 'No report.' });
  });

  it('gives up on a report larger than maxBytes, naming the limit', async () => {
    const { fetch } = fakeFetch([route('/v1/things', { bytes: new Uint8Array(3 * 1024 * 1024) })]);
    const err = await catchErr(fetchBytes(makeCtx(fetch), { ...spec(), maxBytes: 2 * 1024 * 1024 }));
    expect(err.kind).toBe('upstream');
    expect(err.message).toMatch(/too large to read \(over 2 MB\)/);
  });
});

describe('fetchJson mapError', () => {
  it('lets the provider map an error first and falls back to the status mapping on null', async () => {
    const { fetch } = fakeFetch([
      route('/v1/things', [
        { status: 403, json: { error: { code: 'invalid_token', detail: 'bad' } } },
        { status: 403, json: { error: { code: 'forbidden', detail: 'nope' } } },
      ]),
    ]);
    const ctx = makeCtx(fetch, { pageBudget: 5 });
    const mapError = (status: number, body: unknown) => {
      const code = (body as { error?: { code?: string } })?.error?.code;
      return status === 403 && code === 'invalid_token' ? new ProviderError('auth', 'Example rejected the key.') : null;
    };
    expect((await catchErr(fetchJson(ctx, spec({ mapError })))).kind).toBe('auth');
    expect((await catchErr(fetchJson(ctx, spec({ mapError })))).kind).toBe('permission');
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
