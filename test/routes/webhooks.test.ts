/**
 * Provider webhooks (SPEC F-17) through the real request pipeline: a valid call queues one delayed
 * sync and nothing else; every invalid URL looks the same; the body is never read or logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { getConnectionDetail } from '../../src/data/connections';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY, MINUTE } from '../../src/lib/time';
import { setWebhook, webhookPath, WEBHOOK_MIN_GAP_MS } from '../../src/services/webhooks';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { deliver, queueOf } from '../fixtures/queue';
import { htmlOf } from '../fixtures/html';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const DEMO = '22222222-2222-4222-8222-222222222222';
const BUYER_EMAIL = 'buyer@example.com';

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

/** A provider's call: no cookie, no Origin, a body full of customer data hoomuch must ignore. */
function call(path: string, opts: { method?: string; form?: boolean; env?: typeof env } = {}): Promise<Response> {
  const body = opts.form
    ? new URLSearchParams({ email: BUYER_EMAIL, price: '500' }).toString()
    : JSON.stringify({ type: 'invoice.paid', data: { object: { customer_email: BUYER_EMAIL } } });
  const req = new Request(`${ORIGIN}${path}`, {
    method: opts.method ?? 'POST',
    headers: { 'content-type': opts.form ? 'application/x-www-form-urlencoded' : 'application/json', 'user-agent': 'Stripe/1.0' },
    body: (opts.method ?? 'POST') === 'POST' ? body : undefined,
  });
  return worker.fetch!(req as never, opts.env ?? env, { waitUntil() {}, passThroughOnException() {} } as never) as Promise<Response>;
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

  it('waits out the 5-minute gap after the last sync started', async () => {
    const path = await on();
    t.exec('UPDATE connections SET last_sync_started_at = ? WHERE id = ?', NOW - MINUTE, ID);
    await call(path);
    expect(queueOf(env).sent[0]!.delaySeconds).toBe((WEBHOOK_MIN_GAP_MS - MINUTE) / 1000);
  });

  it('answers every invalid URL the same way, and writes nothing', async () => {
    const path = await on();
    const otherPath = await on(OTHER);
    await setWebhook(env, 'u1', OTHER, 'off');
    const token = path.split('/').at(-1)!;
    const wrong = [
      `/webhooks/${ID}/${'A'.repeat(43)}`, // wrong token
      `/webhooks/${ID}/${token.slice(0, -1)}`, // malformed token
      `/webhooks/${OTHER}/${token}`, // another connection's token
      otherPath, // webhooks turned off
      `/webhooks/44444444-4444-4444-8444-444444444444/${token}`, // no such connection
      `/webhooks/not-a-uuid/${token}`,
      `/webhooks/${ID}`,
    ];
    for (const p of wrong) {
      const res = await call(p);
      expect(res.status, p).toBe(404);
      expect(await res.json()).toEqual({ ok: false });
    }
    expect((await call(path, { method: 'GET' })).status).toBe(404);
    expect(queueOf(env).sent).toEqual([]);
    expect(t.rows('SELECT webhook_last_at FROM connections WHERE id = ?', ID)).toEqual([{ webhook_last_at: null }]);
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
  });

  it('has its own per-connection limit, and is exempt from the per-network one', async () => {
    const path = await on();
    const no = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect((await call(path, { env: { ...env, RL_REQUESTS: no } })).status).toBe(200);
    const limited = await call(path, { env: { ...env, RL_WEBHOOKS: no } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
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
    const detail = await getConnectionDetail(env, { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD' }, ID);
    expect(detail!.webhook!.path).toMatch(/^\/webhooks\/11111111-1111-4111-8111-111111111111\/[A-Za-z0-9_-]{43}$/);
    expect(detail!.webhook!.path).not.toBe(first);
    expect(await setWebhook(env, 'u1', ID, 'off')).toBe(true);
    expect((await getConnectionDetail(env, { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD' }, ID))!.webhook).toEqual({ path: null, lastCallAt: null });
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
