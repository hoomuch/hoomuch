/**
 * Provider webhooks (SPEC F-17) through the real request pipeline: a valid call queues one delayed
 * sync and nothing else; every invalid URL looks the same; the body is never read, stored or logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { getConnectionDetail } from '../../src/data/connections';
import * as cryptoLib from '../../src/lib/crypto';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY, MINUTE } from '../../src/lib/time';
import { receiveWebhook, setWebhook, webhookPath, webhookToken } from '../../src/services/webhooks';
import { createTestD1, seedConnection, seedUser, TEST_ENCRYPTION_KEY, testEnv, type TestD1 } from '../fixtures/d1';
import { deliver, queueOf } from '../fixtures/queue';
import { htmlOf } from '../fixtures/html';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const DEMO = '22222222-2222-4222-8222-222222222222';
const BUYER_EMAIL = 'buyer@example.com';
const WRONG_TOKEN = 'A'.repeat(43);

let t: TestD1;
let env: ReturnType<typeof testEnv>;
let logs: string[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  seedUser(t, { id: 'u1' });
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
  seedConnection(t, { id: ID, userId: 'u1', provider: 'stripe', name: 'Acme', status: 'ok', lastSyncedAt: NOW - 3_600_000, lastSyncStartedAt: NOW - 3_600_000 });
  seedConnection(t, { id: OTHER, userId: 'u1', provider: 'stripe', name: 'Other' });
  seedConnection(t, { id: DEMO, userId: 'u1', provider: 'demo', name: 'Demo data' });
  env = testEnv(t.db);
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
});

afterEach(() => {
  expect(logs.join('\n')).not.toContain(BUYER_EMAIL);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function on(id = ID): Promise<string> {
  expect(await setWebhook(env, 'u1', id, 'on')).toBe(true);
  const nonce = t.rows<{ webhook_nonce: string }>('SELECT webhook_nonce FROM connections WHERE id = ?', id)[0]!.webhook_nonce;
  return webhookPath(env, id, nonce);
}

const tokenOf = (path: string) => path.split('/').at(-1)!;

/** A provider's call: no cookie, no Origin, a body full of customer data hoomuch must ignore. */
function providerRequest(path: string, opts: { method?: string; form?: boolean } = {}): Request {
  const body = opts.form
    ? new URLSearchParams({ email: BUYER_EMAIL, price: '500' }).toString()
    : JSON.stringify({ type: 'invoice.paid', data: { object: { customer_email: BUYER_EMAIL } } });
  return new Request(`${ORIGIN}${path}`, {
    method: opts.method ?? 'POST',
    headers: { 'content-type': opts.form ? 'application/x-www-form-urlencoded' : 'application/json', 'user-agent': 'Stripe/1.0' },
    body: (opts.method ?? 'POST') === 'POST' ? body : undefined,
  });
}

function send(req: Request, e: typeof env = env): Promise<Response> {
  return worker.fetch!(req as never, e, { waitUntil() {}, passThroughOnException() {} } as never) as Promise<Response>;
}

function call(path: string, opts: { method?: string; form?: boolean; env?: typeof env } = {}): Promise<Response> {
  return send(providerRequest(path, opts), opts.env);
}

/** The token, derived here with WebCrypto alone: URLs already pasted into providers depend on it. */
async function expectedToken(keyB64: string, id: string, nonce: string): Promise<string> {
  const te = new TextEncoder();
  const raw = Uint8Array.from(atob(keyB64), (ch) => ch.charCodeAt(0));
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode('hoomuch webhook url v1') },
    ikm,
    256,
  );
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(`${id}:${nonce}`)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A rate limit binding that records the key of every call. */
function recordingLimit(keys: string[], success = true): RateLimit {
  return { limit: async ({ key }: { key: string }) => (keys.push(key), { success }) } as unknown as RateLimit;
}

describe('POST /webhooks/:id/:token', () => {
  it('queues one sync a minute later and answers 200, without a session or CSRF check', async () => {
    const path = await on();
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(queueOf(env).sent).toEqual([{ body: { v: 1, connectionId: ID, kind: 'webhook', at: NOW }, delaySeconds: 60 }]);
    expect(t.rows('SELECT queued_at, webhook_last_at FROM connections WHERE id = ?', ID)).toEqual([{ queued_at: NOW, webhook_last_at: NOW }]);
  });

  it('a burst of calls is one sync; each call still counts as the latest', async () => {
    const path = await on();
    await call(path);
    vi.setSystemTime(NOW + 2_000);
    await call(path, { form: true }); // Gumroad posts form-encoded: still no CSRF 403
    vi.setSystemTime(NOW + 4_000);
    expect((await call(path)).status).toBe(200);
    expect(queueOf(env).sent).toHaveLength(1);
    expect(t.rows('SELECT webhook_last_at FROM connections WHERE id = ?', ID)).toEqual([{ webhook_last_at: NOW + 4_000 }]);
  });

  it('waits out the 5-minute gap after the last sync started, and never less than a minute', async () => {
    const path = await on();
    t.exec('UPDATE connections SET last_sync_started_at = ? WHERE id = ?', NOW - MINUTE, ID);
    await call(path);
    t.exec('UPDATE connections SET queued_at = NULL, last_sync_started_at = ? WHERE id = ?', NOW - 4.5 * MINUTE, ID);
    await call(path);
    expect(queueOf(env).sent.map((m) => m.delaySeconds)).toEqual([240, 60]);
  });

  it('two calls in the same millisecond queue one sync', async () => {
    const token = tokenOf(await on());
    expect(await receiveWebhook(env, ID, token, NOW)).toEqual({ scheduled: true });
    expect(await receiveWebhook(env, ID, token, NOW)).toEqual({ scheduled: false });
    expect(queueOf(env).sent).toHaveLength(1);
    expect(t.rows('SELECT queued_at, webhook_last_at FROM connections WHERE id = ?', ID)).toEqual([{ queued_at: NOW, webhook_last_at: NOW }]);
  });

  it('queues again once the sync on its way is presumed lost (15 minutes, as the cron and Sync now)', async () => {
    const token = tokenOf(await on());
    t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW - 15 * MINUTE + 1, ID);
    expect(await receiveWebhook(env, ID, token, NOW)).toEqual({ scheduled: false });
    t.exec('UPDATE connections SET queued_at = ? WHERE id = ?', NOW - 15 * MINUTE, ID);
    expect(await receiveWebhook(env, ID, token, NOW)).toEqual({ scheduled: true });
    expect(queueOf(env).sent).toHaveLength(1);
    expect(t.rows('SELECT queued_at FROM connections WHERE id = ?', ID)).toEqual([{ queued_at: NOW }]);
  });

  it('a URL replaced between the read and the write schedules nothing', async () => {
    const token = tokenOf(await on());
    // Every statement after the SELECT finds the nonce already replaced ("New URL" in another tab).
    const DB = {
      ...t.db,
      prepare: (sql: string) => {
        if (!sql.trimStart().startsWith('SELECT')) t.exec("UPDATE connections SET webhook_nonce = 'replaced' WHERE id = ?", ID);
        return t.db.prepare(sql);
      },
    } as D1Database;
    expect(await receiveWebhook({ ...env, DB }, ID, token, NOW)).toBeNull();
    expect(queueOf(env).sent).toEqual([]);
    expect(t.rows('SELECT queued_at, webhook_last_at FROM connections WHERE id = ?', ID)).toEqual([{ queued_at: null, webhook_last_at: null }]);
  });

  it('compares the token in constant time', async () => {
    const spy = vi.spyOn(cryptoLib, 'timingSafeEqual');
    const token = tokenOf(await on());
    await call(`/webhooks/${ID}/${WRONG_TOKEN}`);
    expect(spy).toHaveBeenCalledWith(token, WRONG_TOKEN);
  });

  it('never reads the body, and stores it nowhere', async () => {
    const req = providerRequest(await on());
    expect((await send(req)).status).toBe(200);
    expect(req.bodyUsed).toBe(false);
    const tables = t.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.length).toBeGreaterThan(5);
    for (const { name } of tables) expect(JSON.stringify(t.rows(`SELECT * FROM "${name}"`)), name).not.toContain(BUYER_EMAIL);
  });

  it('answers every invalid URL the same way, and writes nothing', async () => {
    const path = await on();
    const otherPath = await on(OTHER);
    await setWebhook(env, 'u1', OTHER, 'off');
    const token = path.split('/').at(-1)!;
    const wrong = [
      `/webhooks/${ID}/${WRONG_TOKEN}`, // wrong token
      `/webhooks/${ID}/${token.slice(0, -1)}`, // malformed token
      `/webhooks/${OTHER}/${token}`, // another connection's token
      otherPath, // webhooks turned off
      `/webhooks/44444444-4444-4444-8444-444444444444/${token}`, // no such connection
      `/webhooks/not-a-uuid/${token}`,
      `/webhooks/${ID}`,
      `${path}/`, // trailing slash: a malformed path, not the URL
    ];
    for (const p of wrong) {
      const res = await call(p);
      expect(res.status, p).toBe(404);
      expect(await res.json()).toEqual({ ok: false });
    }
    expect(queueOf(env).sent).toEqual([]);
    expect(t.rows('SELECT webhook_last_at FROM connections WHERE id = ?', ID)).toEqual([{ webhook_last_at: null }]);
  });

  it('answers other methods on the URL with the same JSON 404', async () => {
    const path = await on();
    for (const method of ['GET', 'PUT', 'HEAD']) {
      const res = await call(path, { method });
      expect(res.status, method).toBe(404);
      expect(res.headers.get('content-type'), method).toMatch(/^application\/json/);
      if (method !== 'HEAD') expect(await res.json()).toEqual({ ok: false });
    }
    expect(queueOf(env).sent).toEqual([]);
  });

  it('refuses a provider hoomuch offers no webhook for, even with a nonce set', async () => {
    const RC = '55555555-5555-4555-8555-555555555555';
    seedConnection(t, { id: RC, userId: 'u1', provider: 'revenuecat', name: 'RevenueCat' });
    t.exec("UPDATE connections SET webhook_nonce = 'n0nce' WHERE id = ?", RC);
    const res = await call(await webhookPath(env, RC, 'n0nce'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false });
    expect(queueOf(env).sent).toEqual([]);
    expect(t.rows('SELECT webhook_last_at FROM connections WHERE id = ?', RC)).toEqual([{ webhook_last_at: null }]);
  });

  it('a replaced URL stops working at once', async () => {
    const old = await on();
    expect(await setWebhook(env, 'u1', ID, 'rotate')).toBe(true);
    expect((await call(old)).status).toBe(404);
    const nonce = t.rows<{ webhook_nonce: string }>('SELECT webhook_nonce FROM connections WHERE id = ?', ID)[0]!.webhook_nonce;
    expect((await call(await webhookPath(env, ID, nonce))).status).toBe(200);
  });

  it('asks the provider to retry when the queue refuses, and leaves nothing marked', async () => {
    const path = await on();
    queueOf(env).failNext = true;
    expect((await call(path)).status).toBe(503);
    expect(t.rows('SELECT queued_at FROM connections WHERE id = ?', ID)).toEqual([{ queued_at: null }]);
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ event: 'webhook_failed', connectionId: ID, message: 'Error' }]);
  });

  it('logs only the name of what failed (D1, a bad ENCRYPTION_KEY), never the token or the key', async () => {
    const path = await on();
    const d1Down = {
      ...t.db,
      prepare: () => {
        throw new TypeError(`D1_ERROR: network connection lost while reading ${path}`);
      },
    } as unknown as D1Database;
    const badKey = btoa('sixteen byte key');
    expect((await call(path, { env: { ...env, DB: d1Down } })).status).toBe(503);
    expect((await call(path, { env: { ...env, ENCRYPTION_KEY: badKey } })).status).toBe(503);
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { event: 'webhook_failed', connectionId: ID, message: 'TypeError' },
      { event: 'webhook_failed', connectionId: ID, message: 'Error' },
    ]);
    for (const secret of [tokenOf(path), badKey, TEST_ENCRYPTION_KEY, 'ENCRYPTION_KEY must']) expect(logs.join('\n')).not.toContain(secret);
    expect(queueOf(env).sent).toEqual([]);
  });

  it('has its own per-connection limit, and is exempt from the per-network one', async () => {
    const path = await on();
    const no = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect((await call(path, { env: { ...env, RL_REQUESTS: no } })).status).toBe(200);
    const limited = await call(path, { env: { ...env, RL_WEBHOOKS: no } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    // The exemption is for /webhooks/ alone, not every path that starts with the word.
    expect((await call('/webhooksx', { method: 'GET', env: { ...env, RL_REQUESTS: no } })).status).toBe(429);
  });

  it('counts every call per connection, before the token is checked against D1', async () => {
    const path = await on();
    const requests: string[] = [];
    const hooks: string[] = [];
    const recorded = { ...env, RL_REQUESTS: recordingLimit(requests), RL_WEBHOOKS: recordingLimit(hooks) };
    expect((await call(path, { env: recorded })).status).toBe(200);
    expect((await call(`/webhooks/${OTHER}/${WRONG_TOKEN}`, { env: recorded })).status).toBe(404);
    expect(hooks).toEqual([`hook|${ID}`, `hook|${OTHER}`]);
    expect(requests).toEqual([]);

    // Over the limit, even a wrong token is turned away without a D1 read (SPEC §8, rate-limit.ts).
    const trips = t.roundTrips();
    const res = await call(`/webhooks/${ID}/${WRONG_TOKEN}`, { env: { ...env, RL_WEBHOOKS: recordingLimit([], false) } });
    expect(res.status).toBe(429);
    expect(t.roundTrips()).toBe(trips);
  });
});

describe('the webhook token', () => {
  it('is HMAC-SHA256 of "<id>:<nonce>" under an HKDF key from ENCRYPTION_KEY, in base64url', async () => {
    const token = await webhookToken(env, ID, 'n0nce');
    expect(token).toBe(await expectedToken(TEST_ENCRYPTION_KEY, ID, 'n0nce'));
    // Worked out with openssl (kdf HKDF, then dgst -mac HMAC). Changing it breaks every pasted URL.
    expect(token).toBe('XwRWSLeCsXl1tqVkOiqzXjqULMsK24NVIE4cWqOF1ZE');
  });

  it('changes with ENCRYPTION_KEY, even after another key was used in the same process', async () => {
    const otherKey = btoa(String.fromCharCode(...Array<number>(32).fill(7)));
    const first = await webhookToken(env, ID, 'n0nce');
    const second = await webhookToken({ ENCRYPTION_KEY: otherKey }, ID, 'n0nce');
    expect(second).toBe(await expectedToken(otherKey, ID, 'n0nce'));
    expect(second).not.toBe(first);
  });
});

describe('the consumer and webhook syncs', () => {
  it('a webhook sync that finds the connection busy comes back a minute later', async () => {
    t.exec("UPDATE connections SET status = 'syncing', last_sync_started_at = ? WHERE id = ?", NOW - MINUTE, ID);
    const d = await deliver(env, { v: 1, connectionId: ID, kind: 'webhook', at: NOW });
    expect(d).toMatchObject({ outcome: 'retry', retryDelaySeconds: 60 });
  });
});

describe('setWebhook and the connection page', () => {
  it('turns on once, rotates, and off; providers without webhook setup refuse', async () => {
    const first = await on();
    expect(await on()).toBe(first); // "Turn on" twice keeps the URL already pasted
    await setWebhook(env, 'u1', ID, 'rotate');
    const detail = await getConnectionDetail(env, { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD', timeZone: 'UTC' }, ID);
    expect(detail!.webhook!.path).toMatch(/^\/webhooks\/11111111-1111-4111-8111-111111111111\/[A-Za-z0-9_-]{43}$/);
    expect(detail!.webhook!.path).not.toBe(first);
    expect((await call(detail!.webhook!.path!)).status).toBe(200);
    expect(t.rows('SELECT webhook_last_at FROM connections WHERE id = ?', ID)).toEqual([{ webhook_last_at: NOW }]);
    expect(await setWebhook(env, 'u1', ID, 'off')).toBe(true);
    expect((await getConnectionDetail(env, { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD', timeZone: 'UTC' }, ID))!.webhook).toEqual({ path: null, lastCallAt: null });
    expect(t.rows('SELECT webhook_nonce, webhook_last_at FROM connections WHERE id = ?', ID)).toEqual([{ webhook_nonce: null, webhook_last_at: null }]);
    expect(await setWebhook(env, 'u1', DEMO, 'on')).toBe(false);
    expect(await setWebhook(env, 'u2', ID, 'on')).toBe(false);
  });

  it('the page offers Turn on, then shows the full URL with its origin and the provider’s steps', async () => {
    const page = (cookie: string[] = []) =>
      worker.fetch!(
        new Request(`${ORIGIN}/connections/${ID}`, { headers: { cookie: [`__Host-hm_session=${TOKEN}`, ...cookie].join('; ') } }) as never,
        env,
        { waitUntil() {}, passThroughOnException() {} } as never,
      ) as Promise<Response>;
    const off = await htmlOf(await page());
    expect(off).toContain('Real-time updates');
    expect(off).toContain(`action="/connections/${ID}/webhook"`);
    expect(off).toContain('>Turn on<');

    const res = (await worker.fetch!(
      new Request(`${ORIGIN}/connections/${ID}/webhook`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-hm_session=${TOKEN}` },
        body: 'action=on',
        redirect: 'manual',
      }) as never,
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    )) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/connections/${ID}#realtime`);

    const html = await htmlOf(await page());
    const nonce = t.rows<{ webhook_nonce: string }>('SELECT webhook_nonce FROM connections WHERE id = ?', ID)[0]!.webhook_nonce;
    expect(html).toContain(`${ORIGIN}${await webhookPath(env, ID, nonce)}`);
    expect(html).toContain('Waiting for the first call from Stripe.');
    expect(html).toContain('customer.subscription.updated');
    expect(html).not.toContain('Demo data</h2>');
  });

  it('the demo connection’s page offers no real-time updates', async () => {
    const res = (await worker.fetch!(
      new Request(`${ORIGIN}/connections/${DEMO}`, { headers: { cookie: `__Host-hm_session=${TOKEN}` } }) as never,
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    )) as Response;
    expect(await htmlOf(res)).not.toContain('Real-time updates');
  });
});
