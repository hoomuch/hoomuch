/**
 * The weekly email digest (SPEC F-25): due on Monday at 08:00 in the owner's zone, queued by the cron, mailed once
 * by the consumer with the calendar's own figures, stopped from Settings or from the mail's link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import type { Bindings } from '../../src/env';
import { sha256Hex } from '../../src/lib/crypto';
import { DAY, HOUR } from '../../src/lib/time';
import { DIGEST_STOP_PATH, digestMessage, nextDigestAt, queueDueDigests, sendDigest, type DigestFigures } from '../../src/services/digest';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';
import { htmlOf } from '../fixtures/html';
import { deliver, queueOf } from '../fixtures/queue';

/** Thursday 5 November 2026, noon UTC. */
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const ORIGIN = 'https://hoomuch.test';
const TOKEN = 'test-session-token';
const MAIL_ON: Partial<Bindings> = { RESEND_API_KEY: 're_test_key_0123456789', MAIL_FROM: 'hoomuch <hello@hoomuch.test>' };

interface SentMail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

let t: TestD1;
let env: Bindings;
let mails: SentMail[];
let mailStatus: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestD1();
  env = testEnv(t.db, MAIL_ON);
  mails = [];
  mailStatus = 200;
  vi.stubGlobal('fetch', (async (_url: string, init: RequestInit) => {
    if (mailStatus === 200) mails.push(JSON.parse(String(init.body)) as SentMail);
    return new Response(JSON.stringify({ id: 'mail_1' }), { status: mailStatus });
  }) as unknown as typeof fetch);

  seedUser(t, { id: 'u1', email: 'owner@example.com', timeZone: 'Europe/Istanbul' });
  t.exec('UPDATE users SET email_verified_at = 1');
  t.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex(TOKEN), 'u1', NOW + DAY, NOW);
  seedConnection(t, { id: 'c1', userId: 'u1', provider: 'stripe', name: 'Main <shop>' });
  for (const [day, mrr, subs, trials] of [
    ['2026-11-03', 500000, 210, 13],
    ['2026-11-04', 504000, 212, 12],
  ] as const) {
    t.exec(
      'INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
      'c1',
      day,
      JSON.stringify({ USD: mrr }),
      subs,
      trials,
      NOW,
    );
  }
  // Two charges and a refund on the 4th, Istanbul time (UTC+3); one charge the day before.
  for (const [id, at, amount] of [
    ['ch_1', '2026-11-04T06:00:00Z', 2900],
    ['ch_2', '2026-11-04T18:00:00Z', 9900],
    ['re_1', '2026-11-04T19:00:00Z', -2900],
    ['ch_0', '2026-11-03T10:00:00Z', 1000],
  ] as const) {
    t.exec(
      'INSERT INTO transactions (connection_id, external_id, occurred_at, type, amount, currency) VALUES (?, ?, ?, ?, ?, ?)',
      'c1',
      id,
      Date.parse(at),
      amount < 0 ? 'refund' : 'charge',
      amount,
      'USD',
    );
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function turnOn(nextAt: number, userId = 'u1'): void {
  t.exec("UPDATE users SET digest = 'weekly', digest_next_at = ?, digest_origin = ? WHERE id = ?", nextAt, ORIGIN, userId);
}

function userRow(id = 'u1'): { digest: string; digest_next_at: number | null; digest_sent_day: string | null; digest_origin: string | null } {
  return t.rows<{ digest: string; digest_next_at: number | null; digest_sent_day: string | null; digest_origin: string | null }>(
    'SELECT digest, digest_next_at, digest_sent_day, digest_origin FROM users WHERE id = ?',
    id,
  )[0]!;
}

function request(path: string, init: { method?: string; body?: Record<string, string>; session?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.session !== false) headers.cookie = `__Host-hm_session=${TOKEN}`;
  if (init.body) {
    headers.origin = ORIGIN;
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const req = new Request(`${ORIGIN}${path}`, { method: init.method ?? (init.body ? 'POST' : 'GET'), headers, body: init.body ? new URLSearchParams(init.body).toString() : undefined });
  return worker.fetch!(req as never, env, { waitUntil() {}, passThroughOnException() {} } as never) as Promise<Response>;
}

describe('nextDigestAt', () => {
  it('is the next Monday at 08:00 in the owner’s zone', () => {
    expect(nextDigestAt('weekly', 'UTC', NOW)).toBe(Date.parse('2026-11-09T08:00:00Z'));
    // 08:00 in Istanbul is 05:00 UTC; in Los Angeles, 16:00 UTC.
    expect(nextDigestAt('weekly', 'Europe/Istanbul', NOW)).toBe(Date.parse('2026-11-09T05:00:00Z'));
    expect(nextDigestAt('weekly', 'America/Los_Angeles', NOW)).toBe(Date.parse('2026-11-09T16:00:00Z'));
    expect(nextDigestAt('off', 'UTC', NOW)).toBeNull();
  });

  it('is the same day before 08:00 on a Monday, and a week on after it', () => {
    expect(nextDigestAt('weekly', 'UTC', Date.parse('2026-11-09T07:00:00Z'))).toBe(Date.parse('2026-11-09T08:00:00Z'));
    expect(nextDigestAt('weekly', 'UTC', Date.parse('2026-11-09T08:00:00Z'))).toBe(Date.parse('2026-11-16T08:00:00Z'));
  });
});

describe('queueDueDigests', () => {
  it('queues one message for a due digest and moves it to next Monday', async () => {
    turnOn(NOW - HOUR);
    seedUser(t, { id: 'u2', email: 'later@example.com' });
    turnOn(NOW + HOUR, 'u2');

    expect(await queueDueDigests(env, NOW)).toBe(1);
    expect(queueOf(env).take().map((m) => m.body)).toEqual([{ v: 1, digest: { userId: 'u1' } }]);
    expect(userRow().digest_next_at).toBe(Date.parse('2026-11-09T05:00:00Z'));
    // The same tick again finds nothing due.
    expect(await queueDueDigests(env, NOW)).toBe(0);
  });

  it('does nothing on an instance that sends no mail', async () => {
    turnOn(NOW - HOUR);
    const quiet = testEnv(t.db);
    expect(await queueDueDigests(quiet, NOW)).toBe(0);
    expect(queueOf(quiet).sent).toHaveLength(0);
  });
});

describe('sendDigest', () => {
  it('mails last week’s figures from the calendar, once', async () => {
    turnOn(NOW + DAY);
    expect(await sendDigest(env, 'u1')).toBe('sent');
    expect(mails).toHaveLength(1);
    const m = mails[0]!;
    expect(m.to).toEqual(['owner@example.com']);
    expect(m.subject).toBe('Last week: $109.00 revenue, MRR $5,040.00');
    expect(m.text).toContain('October 29 to November 4');
    expect(m.text).toContain('Revenue: $109.00 (3 charges, 1 refund)');
    expect(m.text).toContain('MRR: $5,040.00\n');
    expect(m.text).toContain('Active subscriptions: 212\n');
    expect(m.text).toContain('Trials: 12\n');
    expect(m.text).toContain(`Dashboard: ${ORIGIN}/dashboard\n`);
    expect(m.text).toContain('You get this every Monday');
    const stop = /Stop these emails: (\S+)/.exec(m.text)![1]!;
    expect(stop.startsWith(`${ORIGIN}${DIGEST_STOP_PATH}?u=u1&t=`)).toBe(true);
    expect(m.headers).toEqual({ 'List-Unsubscribe': `<${stop}>` });
    expect(userRow().digest_sent_day).toBe('2026-11-05');

    // The queue delivering the message a second time mails nothing more.
    expect(await sendDigest(env, 'u1')).toBe('skipped');
    expect(mails).toHaveLength(1);
  });

  it('says how the week changed things, and names a connection that can’t sync', async () => {
    turnOn(NOW + DAY);
    // A snapshot from before the week, to compare its end with.
    t.exec(
      'INSERT INTO snapshots (connection_id, day, mrr, active_subscriptions, active_trials, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
      'c1',
      '2026-10-28',
      JSON.stringify({ USD: 480000 }),
      200,
      15,
      NOW,
    );
    t.exec("UPDATE connections SET status = 'error', last_error = 'The key was revoked.' WHERE id = 'c1'");
    expect(await sendDigest(env, 'u1')).toBe('sent');
    const m = mails[0]!;
    expect(m.text).toContain('MRR: $5,040.00 (+$240.00)');
    expect(m.text).toContain('Active subscriptions: 212 (+12)');
    expect(m.text).toContain('Trials: 12 (−3)');
    expect(m.text).toContain('Couldn’t sync: Main <shop>.');
    // The connection's name is the owner's own text: escaped in the HTML copy.
    expect(m.html).toContain('Main &lt;shop&gt;');
    expect(m.html).not.toContain('<shop>');
  });

  it('skips an account with nothing to report, one that’s off and one that isn’t verified', async () => {
    seedUser(t, { id: 'u2', email: 'empty@example.com' });
    t.exec("UPDATE users SET email_verified_at = 1 WHERE id = 'u2'");
    turnOn(NOW + DAY, 'u2');
    expect(await sendDigest(env, 'u2')).toBe('skipped');
    expect(await sendDigest(env, 'u1')).toBe('skipped'); // off
    turnOn(NOW + DAY);
    t.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'u1'");
    expect(await sendDigest(env, 'u1')).toBe('skipped');
    expect(mails).toHaveLength(0);
  });

  it('reports a mail that didn’t go out, so the queue tries again', async () => {
    turnOn(NOW + DAY);
    mailStatus = 500;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await deliver(env, { v: 1, digest: { userId: 'u1' } })).toMatchObject({ outcome: 'retry' });
    expect(userRow().digest_sent_day).toBeNull();
    // Nothing of the owner's is in the logs.
    expect(errors.mock.calls.flat().join(' ')).not.toContain('owner@example.com');

    mailStatus = 200;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await deliver(env, { v: 1, digest: { userId: 'u1' } })).toMatchObject({ outcome: 'ack' });
    expect(mails).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe('digestMessage', () => {
  const base: DigestFigures = {
    currency: 'USD',
    from: '2026-10-29',
    to: '2026-11-04',
    revenue: null,
    charges: 0,
    refunds: 0,
    mrr: 120000,
    mrrChange: 0,
    subscriptions: 40,
    subscriptionsChange: null,
    trials: null,
    trialsChange: null,
    failing: [],
  };

  it('leaves out what it doesn’t know and changes that are zero', () => {
    const m = digestMessage('hoomuch', 'a@example.com', base, { dashboard: 'https://x.test/dashboard', stop: 'https://x.test/stop' });
    expect(m.subject).toBe('Last week: MRR $1,200.00');
    expect(m.text).not.toContain('Revenue');
    expect(m.text).not.toContain('Trials');
    expect(m.text).toContain('MRR: $1,200.00\n');
    expect(m.text).toContain('Active subscriptions: 40\n');
  });
});

describe('Settings and the stop link', () => {
  it('turns the digest on from Settings and reschedules it when the zone changes', async () => {
    const page = await htmlOf(await request('/settings'));
    expect(page).toMatch(/<form[^>]*action="\/settings\/digest"/);

    const saved = await request('/settings/digest', { body: { digest: 'weekly' } });
    expect(saved.status).toBe(303);
    expect(userRow()).toMatchObject({ digest: 'weekly', digest_next_at: Date.parse('2026-11-09T05:00:00Z'), digest_origin: ORIGIN });

    await request('/settings/timezone', { body: { timezone: 'America/Los_Angeles' } });
    expect(userRow().digest_next_at).toBe(Date.parse('2026-11-09T16:00:00Z'));

    await request('/settings/digest', { body: { digest: 'off' } });
    expect(userRow()).toMatchObject({ digest: 'off', digest_next_at: null });
    expect((await request('/settings/digest', { body: { digest: 'daily' } })).status).toBe(303);
    expect(userRow().digest).toBe('off');
  });

  it('has no digest on an instance that sends no mail', async () => {
    env = testEnv(t.db);
    expect(await htmlOf(await request('/settings'))).not.toContain('/settings/digest');
    await request('/settings/digest', { body: { digest: 'weekly' } });
    expect(userRow().digest).toBe('off');
  });

  it('stops from the mailed link without a session: the GET only shows a button', async () => {
    turnOn(NOW + DAY);
    await sendDigest(env, 'u1');
    const stop = new URL(/Stop these emails: (\S+)/.exec(mails[0]!.text)![1]!);

    const shown = await request(`${stop.pathname}${stop.search}`, { session: false });
    expect(shown.status).toBe(200);
    expect(await htmlOf(shown)).toMatch(/<form[^>]*action="\/digest\/stop"/);
    expect(userRow().digest).toBe('weekly');

    const done = await request(DIGEST_STOP_PATH, { session: false, body: { u: 'u1', t: stop.searchParams.get('t')! } });
    expect(done.status).toBe(200);
    expect(userRow()).toMatchObject({ digest: 'off', digest_next_at: null });
  });

  it('turns down a link that isn’t ours', async () => {
    turnOn(NOW + DAY);
    expect((await request(`${DIGEST_STOP_PATH}?u=u1&t=${'A'.repeat(43)}`, { session: false })).status).toBe(400);
    expect((await request(DIGEST_STOP_PATH, { session: false, body: { u: 'u1', t: 'A'.repeat(43) } })).status).toBe(400);
    expect(userRow().digest).toBe('weekly');
  });
});
