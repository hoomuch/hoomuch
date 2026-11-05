/**
 * Password policy (OWASP ASVS v5 6.2.x, NIST SP 800-63B): length, plus no common or
 * context-derived passwords, at sign-up and on change. No composition rules.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { registerUser } from '../../src/lib/auth';
import { createTestD1, testEnv, type TestD1 } from '../fixtures/d1';

let t: TestD1 | null = null;
afterEach(() => {
  t?.sqlite.close();
  t = null;
});

async function signup(email: string, password: string) {
  t?.sqlite.close();
  t = createTestD1();
  return registerUser(testEnv(t.db), email, password, '198.51.100.7');
}

const GUESSABLE = 'That password is too easy to guess. Try a few unrelated words.';

describe('password policy', () => {
  it.each([
    ['digit run', '1234567890'],
    ['reversed digit run', '0987654321'],
    ['keyboard row', 'qwertyuiop'],
    ['keyboard row, reversed', 'poiuytrewq'],
    ['keyboard columns', '1qaz2wsx3edc'],
    ['alphabet run', 'abcdefghijk'],
    ['one character', 'aaaaaaaaaaaa'],
    ['two characters', '1212121212'],
    ['short cycle', 'abcabcabcabc'],
    ['common word + digits', 'password123'],
    ['common word + year + symbol', 'Qwerty2026!'],
    ['leetspeak common word', 'P@ssw0rd2026'],
    ['digits + common word', '2026password'],
    ['common word + punctuation', 'letmein!!!!'],
    ['the email name padded out', 'adalovelace1'],
    ['the whole email', 'adalovelace@example.com'],
    ['the app name padded out', 'hoomuch2026!'],
  ])('rejects a guessable password: %s', async (_label, pw) => {
    expect(await signup('adalovelace@example.com', pw)).toEqual({ ok: false, error: GUESSABLE, field: 'password' });
  });

  it.each([
    ['a passphrase', 'correct horse battery'],
    ['a common word inside a longer phrase', 'my password is long enough'],
    ['the email name inside a longer phrase', 'adalovelace wrote the first program'],
    ['random characters', 'k7#Qv9!mZp2w'],
    ['ten random digits', '4829175036'],
  ])('accepts a reasonable password: %s', async (_label, pw) => {
    expect(await signup('adalovelace@example.com', pw)).toMatchObject({ ok: true });
  });

  it('checks length before anything else', async () => {
    expect(await signup('x@example.com', 'aaaa')).toMatchObject({ ok: false, error: 'Use at least 10 characters.' });
  });
});

describe('changing the password', () => {
  it('applies the same policy, and keeps the old password working', async () => {
    const { default: worker } = await import('../../src/index');
    const { sha256Hex } = await import('../../src/lib/crypto');
    const { authenticate } = await import('../../src/lib/auth');
    const r = await signup('owner@example.com', 'correct horse battery');
    if (!r.ok) throw new Error('setup failed');
    const env = testEnv(t!.db);
    t!.exec('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', await sha256Hex('tok'), r.userId, Date.now() + 86_400_000, Date.now());
    const req = new Request('https://hoomuch.test/settings/password', {
      method: 'POST',
      headers: { origin: 'https://hoomuch.test', 'content-type': 'application/x-www-form-urlencoded', cookie: '__Host-hm_session=tok' },
      body: new URLSearchParams({ current_password: 'correct horse battery', new_password: 'owner2026!!' }).toString(),
    });
    const res = await worker.fetch!(req as never, env, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('too easy to guess');
    expect(await authenticate(env, 'owner@example.com', 'correct horse battery', '192.0.2.1')).toMatchObject({ ok: true });
  });
});
