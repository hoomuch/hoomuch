/**
 * Lead: account, session and throttling rules from SPEC §8, on the in-memory D1 (real migration).
 * Includes regressions for the web-layer security review (open redirect, throttle race, IPv6
 * buckets, signup throttle, session lifetime, connection cap).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, confirmPassword, ipBucket, registerUser, safeNext } from '../../src/lib/auth';
import { relativeTime } from '../../src/lib/time';
import { createTestD1, testEnv, type TestD1 } from '../fixtures/d1';
import { getSessionWithUser, getUserByEmail, insertConnection, insertSession } from '../../src/db/queries';

const IP = '203.0.113.7';
const PW = 'correct horse battery';

let t: TestD1 | null = null;
afterEach(() => {
  t?.sqlite.close();
  t = null;
});

function setup(overrides: Parameters<typeof testEnv>[1] = {}) {
  t = createTestD1();
  return { t, env: testEnv(t.db, overrides) };
}

async function newUser(env: ReturnType<typeof testEnv>, email: string, ip = IP): Promise<string> {
  const r = await registerUser(env, email, PW, ip);
  if (!r.ok) throw new Error(`setup failed: ${r.error}`);
  return r.userId;
}

describe('registerUser', () => {
  it('creates an account and normalises the email', async () => {
    const { env } = setup();
    expect((await registerUser(env, '  Ada@Example.COM ', PW, IP)).ok).toBe(true);
    expect((await getUserByEmail(env.DB, 'ada@example.com'))?.email).toBe('ada@example.com');
  });

  it('turns a concurrent duplicate sign-up into a friendly error instead of a 500', async () => {
    const { env } = setup();
    const results = await Promise.all([
      registerUser(env, 'race@example.com', PW, IP),
      registerUser(env, 'race@example.com', PW, IP),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser && !loser.ok && loser.error).toMatch(/already exists/);
  });

  it('respects ALLOW_SIGNUP=false', async () => {
    const { env } = setup({ ALLOW_SIGNUP: 'false' });
    expect(await registerUser(env, 'x@example.com', PW, IP)).toEqual({
      ok: false,
      error: 'Sign-ups are closed on this instance.',
    });
  });

  it('throttles sign-up attempts per network, successful or not', async () => {
    const { env } = setup();
    for (let i = 0; i < 10; i++) {
      // Mix of new and already-taken emails: both count (bounds account creation AND probing).
      const r = await registerUser(env, i % 2 ? `probe${i}@example.com` : 'taken@example.com', PW, '2001:db8:1:2::10');
      // The limit is exactly 10: none of these is throttled (a lower limit would fail here).
      expect(r.ok === false && r.throttled).toBeFalsy();
    }
    const r = await registerUser(env, 'fresh@example.com', PW, '2001:db8:1:2:ffff::1'); // same /64
    expect(r).toMatchObject({ ok: false, throttled: true });
    expect((await registerUser(env, 'fresh@example.com', PW, '198.51.100.1')).ok).toBe(true);
  });
});

describe('authenticate', () => {
  it('flags the throttled state after 10 attempts from the same email + network', async () => {
    const { env } = setup();
    await newUser(env, 'bob@example.com');
    for (let i = 0; i < 10; i++) {
      const r = await authenticate(env, 'bob@example.com', 'wrong password!', '1.2.3.4');
      expect(r).toMatchObject({ ok: false });
      expect(r.ok === false && r.throttled).toBeFalsy();
    }
    expect(await authenticate(env, 'bob@example.com', PW, '1.2.3.4')).toMatchObject({ ok: false, throttled: true });
    // A different network is a different bucket.
    expect((await authenticate(env, 'bob@example.com', PW, '5.6.7.8')).ok).toBe(true);
  });

  it('cannot be raced: parallel guesses beyond the limit are rejected before hashing', async () => {
    const { env } = setup();
    await newUser(env, 'race@example.com');
    // PBKDF2 runs through crypto.subtle.deriveBits: count the hashes the guesses actually cost.
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => authenticate(env, 'race@example.com', `guess-${i}-xxxx`, '1.2.3.4')),
    );
    expect(results.filter((r) => !r.ok && r.throttled)).toHaveLength(15);
    expect(derive).toHaveBeenCalledTimes(10);
    derive.mockRestore();
  });

  it('groups IPv6 clients by /64', async () => {
    const { env } = setup();
    await newUser(env, 'v6@example.com', '198.51.100.9');
    for (let i = 0; i < 10; i++) {
      await authenticate(env, 'v6@example.com', 'wrong password!', `2001:db8:aa:bb::${(i + 1).toString(16)}`);
    }
    expect(await authenticate(env, 'v6@example.com', PW, '2001:db8:aa:bb:1:2:3:4')).toMatchObject({ throttled: true });
    // Negative control: the neighbouring /64 is its own bucket (a global bucket would fail here).
    expect(await authenticate(env, 'v6@example.com', PW, '2001:db8:aa:bc::1')).toMatchObject({ ok: true });
  });
});

describe('confirmPassword', () => {
  it('is throttled per user, so a hijacked session cannot brute-force the password', async () => {
    const { env } = setup();
    const userId = await newUser(env, 'eve@example.com');
    for (let i = 0; i < 10; i++) {
      expect(await confirmPassword(env, userId, `guess-${i}-xxxxxx`)).toEqual({
        ok: false,
        error: 'Password is incorrect.',
        throttled: false,
      });
    }
    expect(await confirmPassword(env, userId, PW)).toMatchObject({ ok: false, throttled: true });
  });

  it('clears the attempt count after a correct password', async () => {
    const { env, t } = setup();
    const userId = await newUser(env, 'sam@example.com');
    const before = t.rows('SELECT * FROM login_attempts').length;
    await confirmPassword(env, userId, 'nope-nope-nope');
    expect(t.rows('SELECT * FROM login_attempts')).toHaveLength(before + 1); // the password-check bucket
    expect(await confirmPassword(env, userId, PW)).toEqual({ ok: true });
    expect(t.rows('SELECT * FROM login_attempts')).toHaveLength(before); // …cleared again
  });
});

describe('safeNext', () => {
  it('keeps same-site paths', () => {
    expect(safeNext('/connections?x=1')).toBe('/connections?x=1');
    expect(safeNext('/dashboard?range=90&poll=2')).toBe('/dashboard?range=90&poll=2');
    expect(safeNext('/a%20b')).toBe('/a%20b');
  });

  it('rejects anything a browser could turn into another origin', () => {
    for (const bad of [
      '//evil.com',
      '/\\evil.com',
      '/\t/evil.com', // browsers strip tabs → //evil.com
      '/\n/evil.com',
      '/\r/evil.com',
      '/%09/evil.com'.replace('%09', '\t'),
      '/a\\b',
      '/ /evil.com',
      'https://evil.com',
      'evil.com',
      '',
      undefined,
      null,
    ]) {
      expect(safeNext(bad as string | undefined | null)).toBe('/dashboard');
    }
  });
});

describe('ipBucket', () => {
  it('keeps IPv4 and groups IPv6 by /64', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('2001:db8:aa:bb::1')).toBe('2001:db8:aa:bb::/64');
    expect(ipBucket('2001:0DB8:00aa:00bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipBucket('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(ipBucket('unknown')).toBe('unknown');
  });
});

describe('sessions', () => {
  it('reject a session past its expiry', async () => {
    const { env } = setup();
    const userId = await newUser(env, 'gone@example.com');
    const now = Date.now();
    await insertSession(env.DB, 'sess-expired', userId, now - 1);
    await insertSession(env.DB, 'sess-live', userId, now + 60_000);
    expect(await getSessionWithUser(env.DB, 'sess-expired', now, now - 90 * 86_400_000)).toBeNull();
    expect((await getSessionWithUser(env.DB, 'sess-live', now, now - 90 * 86_400_000))?.user_id).toBe(userId);
  });

  it('enforce an absolute lifetime even when the expiry keeps sliding', async () => {
    const { env, t } = setup();
    const userId = await newUser(env, 'old@example.com');
    const now = Date.now();
    await insertSession(env.DB, 'sess-old', userId, now + 86_400_000);
    t.exec('UPDATE sessions SET created_at = ? WHERE id = ?', now - 91 * 86_400_000, 'sess-old');
    await insertSession(env.DB, 'sess-new', userId, now + 86_400_000);
    const minCreatedAt = now - 90 * 86_400_000;
    expect(await getSessionWithUser(env.DB, 'sess-old', now, minCreatedAt)).toBeNull();
    expect((await getSessionWithUser(env.DB, 'sess-new', now, minCreatedAt))?.user_id).toBe(userId);
  });
});

describe('insertConnection cap', () => {
  it('is atomic: the conditional insert refuses once the user is at the limit', async () => {
    const { env } = setup();
    const userId = await newUser(env, 'cap@example.com');
    const base = { userId, provider: 'demo' as const, name: 'Demo', credentialsEnc: 'v1.x.y', keyHint: null, config: {}, testMode: false };
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => insertConnection(env.DB, { ...base, id: `00000000-0000-4000-8000-00000000000${i}` }, 2)),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  it('spells out days and shows older dates as a short date', () => {
    expect(relativeTime(now - 30_000, now)).toBe('just now');
    expect(relativeTime(now - 4 * 60_000, now)).toBe('4 min ago');
    expect(relativeTime(now - 86_400_000, now)).toBe('1 day ago');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3 days ago');
    expect(relativeTime(Date.parse('2026-09-25T08:00:00Z'), now)).toBe('Sep 25, 2026');
  });

  it('covers the hour branch and both sides of the 30-day cutoff', () => {
    expect(relativeTime(now - 59 * 60_000, now)).toBe('59 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 23 * 3_600_000 - 59 * 60_000, now)).toBe('23 h ago');
    expect(relativeTime(now - 29 * 86_400_000, now)).toBe('29 days ago');
    expect(relativeTime(now - 30 * 86_400_000, now)).toBe('Oct 6, 2026');
  });

  it('treats a timestamp in the future (clock skew) as just now', () => {
    expect(relativeTime(now + 5 * 60_000, now)).toBe('just now');
  });
});
