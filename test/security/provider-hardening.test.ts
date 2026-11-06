/**
 * Outbound-request and untrusted-API regressions from the OWASP review (2026-11-05; OWASP API
 * Security Top 10 API7 SSRF, API10 Unsafe Consumption of APIs, API4 Unrestricted Resource Use).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildUrl, fetchJson, MAX_RESPONSE_BYTES, sanitizeErrorText } from '../../src/providers/http';
import { foreignKeyOwner, getProviderMeta, splitInput } from '../../src/providers/registry';
import { ProviderError } from '../../src/providers/types';
import { rotateCredentials } from '../../src/services/connections';
import { cleanMoneyMap } from '../../src/sync/aggregate';
import { rowToFx } from '../../src/sync/fx';
import { acquireSyncLock } from '../../src/sync/repo';
import { DAY, HOUR } from '../../src/lib/time';
import { seedConnection } from '../fixtures/d1';
import { fakeFetch, makeCtx, route } from '../fixtures/harness';
import { FX_BODY, NOW, conn, encryptedCreds, setup, teardown, type Ctx } from '../sync/helpers';

describe('sanitizeErrorText', () => {
  it('stays fast on a long unbroken run of word characters (no quadratic backtracking)', () => {
    const blob = 'A.b-C_d'.repeat(30_000); // ~210 KB, the shape that used to take ~20 s
    const started = performance.now();
    const out = sanitizeErrorText(`upstream failed: ${blob}`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it('still masks emails and keys', () => {
    const out = sanitizeErrorText('user jane.doe@example.com with key sk_live_51Abcdefghijklmnop failed');
    expect(out).not.toContain('jane.doe@example.com');
    expect(out).not.toContain('51Abcdefghijklmnop');
  });
});

describe('buildUrl', () => {
  const BASE = 'https://api.stripe.com/v1';

  it('joins relative paths onto the provider base', () => {
    expect(buildUrl(BASE, '/subscriptions', { limit: 100 })).toBe('https://api.stripe.com/v1/subscriptions?limit=100');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/x'],
    ['an http URL', 'http://evil.example/x'],
    ['a scheme-relative URL', '//evil.example/x'],
    ['a backslash trick', '/\\evil.example/x'],
    ['another scheme', 'javascript:alert(1)'],
  ])('refuses %s, so a keyed request never leaves the provider host', (_label, path) => {
    expect(() => buildUrl(BASE, path)).toThrow();
  });
});

describe('response size limit', () => {
  function streamOf(bytes: number): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
  }

  it('gives up on a body that declares itself too large, without retrying', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('{}', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
    }) as typeof fetch;
    const err = await fetchJson(makeCtx(fetchImpl), { provider: 'Stripe', url: 'https://api.stripe.com/v1/x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'upstream' });
    expect(calls).toBe(1);
  });

  it('stops reading a streamed body once it passes the limit', async () => {
    let pulled = 0;
    const fetchImpl = (async () => {
      const body = streamOf(MAX_RESPONSE_BYTES * 4).pipeThrough(
        new TransformStream({ transform: (c, ctl) => ((pulled += c.byteLength), ctl.enqueue(c)) }),
      );
      return new Response(body);
    }) as typeof fetch;
    const err = await fetchJson(makeCtx(fetchImpl), { provider: 'Stripe', url: 'https://api.stripe.com/v1/x' }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'upstream' });
    expect(pulled).toBeLessThan(MAX_RESPONSE_BYTES * 2);
  });
});

describe('a key pasted into the wrong provider form', () => {
  const STRIPE_LIVE = 'sk_live_51AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

  it.each(['chargebee', 'lemonsqueezy', 'gumroad', 'revenuecat', 'superwall'] as const)(
    'is refused before anything is sent (%s)',
    (provider) => {
      const meta = getProviderMeta(provider);
      const keyField = meta.fields.find((f) => f.secret)!;
      const raw: Record<string, string> = { [keyField.name]: STRIPE_LIVE };
      for (const f of meta.fields) if (!f.secret) raw[f.name] = f.name === 'site' ? 'acme' : '12345';
      const { credentials, errors } = splitInput(meta, raw);
      expect(credentials[keyField.name]).toBeUndefined();
      expect(errors[keyField.name]).toBe(`That looks like a Stripe key. Paste your ${meta.name} key here.`);
    },
  );

  it.each([
    ['paddle', 'pdl_live_apikey_01gtgztp8f4kek3yd4g1wrksa3_q6TGTJyvoIz7LDtXT65bX7_AQO', 'Paddle'],
    ['polar', 'polar_oat_FakeTokenForTestsOnly0000000000000000000000000', 'Polar'],
    ['dodo', 'dodo_live_FakeKeyForTestsOnly0000000000000000', 'Dodo Payments'],
    ['adapty', 'secret_live_abcdefgh.0123456789abcdef0123456789abcdef', 'Adapty'],
  ] as const)('names the provider a %s key belongs to', (owner, key, name) => {
    expect(foreignKeyOwner('chargebee', key)).toBe(owner);
    expect(getProviderMeta(owner).name).toBe(name);
  });

  it('refuses a private key file pasted into another provider’s form', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----';
    const sa = JSON.stringify({ type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com', private_key: pem });
    expect(foreignKeyOwner('chargebee', pem)).toBe('appstore');
    expect(foreignKeyOwner('stripe', sa)).toBe('googleplay');
    expect(foreignKeyOwner('appstore', sa)).toBe('googleplay');
    expect(foreignKeyOwner('appstore', pem)).toBeNull();
    expect(foreignKeyOwner('googleplay', sa)).toBeNull();
    const { credentials, errors } = splitInput(getProviderMeta('revenuecat'), { apiKey: pem, projectId: 'proj1a2b3c4d' });
    expect(credentials['apiKey']).toBeUndefined();
    expect(errors['apiKey']).toBe('That looks like an App Store Connect key. Paste your RevenueCat key here.');
  });

  it("accepts each provider's own key, and RevenueCat's sk_ keys", () => {
    expect(foreignKeyOwner('stripe', STRIPE_LIVE)).toBeNull();
    expect(foreignKeyOwner('revenuecat', 'sk_AbCdEfGhIjKlMnOpQrStUvWxYz012345')).toBeNull();
    expect(foreignKeyOwner('paddle', 'pdl_sdbx_apikey_01gtgztp8f4kek3yd4g1wrksa3_q6TGTJyvoIz7LDtXT65bX7_AQO')).toBeNull();
  });
});

describe('untrusted numbers', () => {
  it('drops FX rates with non-ISO codes or implausible magnitudes', () => {
    const fx = rowToFx({
      day: '2026-11-04',
      base: 'USD',
      rates: JSON.stringify({ EUR: 0.92, __proto__x: 1, usd1: 1, XAU: 1e12, ZZZ: 1e-9, try: 34.1, BAD: Infinity }),
    });
    expect(fx?.rates).toEqual({ EUR: 0.92, TRY: 34.1 });
  });

  it('drops snapshot amounts beyond safe-integer range', () => {
    expect(cleanMoneyMap({ USD: 1e300, EUR: 500, GBP: Number.MAX_SAFE_INTEGER + 10 })).toEqual({ map: { EUR: 500 }, dropped: 2 });
  });
});

describe('replacing a key', () => {
  let c: Ctx;
  afterEach(() => teardown());

  function execCtx(): ExecutionContext {
    return { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  }

  async function seed(id: string, startedAt = NOW - HOUR): Promise<void> {
    seedConnection(c.t, {
      id,
      userId: c.userId,
      provider: 'stripe',
      credentialsEnc: await encryptedCreds({ apiKey: 'rk_test_old' }),
      testMode: true,
      lastSyncedAt: NOW - HOUR,
      lastSyncStartedAt: startedAt,
    });
    c.t.exec(
      "INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency) VALUES (?, 'txn_old', ?, 'charge', 1000, 'USD')",
      id,
      NOW - 3 * DAY,
    );
  }

  const emptyList = { object: 'list', data: [], has_more: false };

  it('is refused when a sync started during verification', async () => {
    c = setup();
    await seed('k');
    // A cron tick takes the lock while the new key is being checked with Stripe.
    const { fetch } = fakeFetch([
      route('/v1/latest', { json: FX_BODY }),
      route(/\/v1\//, async () => {
        await acquireSyncLock(c.env.DB, 'k', NOW, NOW - 5 * 60_000);
        return { json: emptyList };
      }),
    ]);
    vi.stubGlobal('fetch', fetch);
    const r = await rotateCredentials(c.env, execCtx(), c.userId, 'k', { apiKey: 'rk_live_new' });
    expect(r).toMatchObject({ ok: false, error: 'A sync is running for this connection. Try again in a minute.' });
    // Nothing was swapped or purged under the running sync.
    expect(c.t.rows<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE connection_id = ?', 'k')[0]!.n).toBe(1);
    expect(c.t.rows<{ test_mode: number }>('SELECT test_mode FROM connections WHERE id = ?', 'k')[0]!.test_mode).toBe(1);
  });

  it('holds the lock through the swap, so a cron run between check and write is turned away', async () => {
    c = setup();
    await seed('k');
    const { fetch } = fakeFetch([route('/v1/latest', { json: FX_BODY }), route(/\/v1\//, { json: emptyList })]);
    vi.stubGlobal('fetch', fetch);
    // Right before the credentials are written (after every check has passed), a cron tick tries
    // to take the lock. It must fail: otherwise it syncs with the old key and commits after the purge.
    const realDb = c.env.DB;
    let cronGotLock: boolean | null = null;
    const db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes('SET credentials_enc')) return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                run: async () => {
                  cronGotLock = (await acquireSyncLock(realDb, 'k', NOW + 1, NOW + 1 - 5 * 60_000)) !== null;
                  return bound.run();
                },
              };
            },
          };
        };
      },
    });
    const r = await rotateCredentials({ ...c.env, DB: db }, execCtx(), c.userId, 'k', { apiKey: 'rk_live_new' });
    expect(r).toMatchObject({ ok: true });
    expect(cronGotLock).toBe(false);
  });

  it('releases the lock it took, so the new sync can run and finish', async () => {
    c = setup();
    await seed('k');
    const { fetch } = fakeFetch([route('/v1/latest', { json: FX_BODY }), route(/\/v1\//, { json: emptyList })]);
    vi.stubGlobal('fetch', fetch);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} };
    const r = await rotateCredentials(c.env, ctx as unknown as ExecutionContext, c.userId, 'k', { apiKey: 'rk_live_new' });
    expect(r).toMatchObject({ ok: true });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(conn(c.t, 'k').status).toBe('ok');
    expect(conn(c.t, 'k').last_sync_started_at).toBe(NOW);
  });

  it('has the same one-minute cooldown as Sync now', async () => {
    c = setup();
    await seed('k', NOW - 30_000);
    const { fetch, calls } = fakeFetch([route(/.*/, { json: emptyList })]);
    vi.stubGlobal('fetch', fetch);
    const r = await rotateCredentials(c.env, execCtx(), c.userId, 'k', { apiKey: 'rk_test_new' });
    expect(r).toMatchObject({ ok: false, error: 'Synced moments ago. Try again in a minute.' });
    expect(calls).toHaveLength(0); // the key wasn't even sent for verification
  });
});
