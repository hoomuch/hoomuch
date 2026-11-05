import { describe, expect, it } from 'vitest';
import { BudgetExhaustedError } from '../../src/providers/http';
import { ProviderError } from '../../src/providers/types';
import {
  DECRYPT_ERROR,
  MAX_SYNC_ERROR_LENGTH,
  SyncError,
  describeSyncError,
  errorLogFields,
  exhaustedMessage,
  isStaleCursorError,
} from '../../src/sync/errors';

const stripe = { name: 'Stripe' };

describe('describeSyncError', () => {
  it('auth and rate_limit get fixed, provider-named sentences', () => {
    expect(describeSyncError(new ProviderError('auth', 'Stripe rejected the API key.', { status: 401 }), stripe)).toBe(
      "Stripe rejected the key. If it was revoked, replace the key.",
    );
    expect(describeSyncError(new ProviderError('rate_limit', 'whatever', { status: 429 }), stripe)).toBe(
      'Stripe is rate-limiting requests; the next sync will retry.',
    );
  });

  it.each(['permission', 'not_found', 'invalid_input', 'upstream'] as const)('%s passes the user-facing message through', (kind) => {
    expect(describeSyncError(new ProviderError(kind, `The Stripe key is missing “Balance: Read”.`), stripe)).toBe(
      'The Stripe key is missing “Balance: Read”.',
    );
  });

  it('passes BudgetExhaustedError and SyncError messages through', () => {
    // http.ts owns that wording; the engine maps budget errors itself (see exhaustedMessage).
    expect(describeSyncError(new BudgetExhaustedError('Stripe'), stripe)).toBe(new BudgetExhaustedError('Stripe').message);
    expect(describeSyncError(new SyncError(DECRYPT_ERROR), stripe)).toBe(DECRYPT_ERROR);
  });

  it('anything else gets a generic message that leaks nothing', () => {
    const err = new Error('D1_ERROR: no such column: rk_live_abcdef123456 in SELECT …');
    const msg = describeSyncError(err, stripe);
    expect(msg).toBe('Something went wrong while syncing Stripe. The next sync will retry.');
    expect(describeSyncError('a string', stripe)).toBe(msg);
    expect(describeSyncError(undefined, stripe)).toBe(msg);
  });

  it('is sanitised and at most 300 chars even if an adapter message is not', () => {
    const long = new ProviderError('upstream', `Stripe returned HTTP 400: ${'x '.repeat(400)} sk_live_abcdef1234567 ops@example.com`);
    const msg = describeSyncError(long, stripe);
    expect(msg.length).toBeLessThanOrEqual(MAX_SYNC_ERROR_LENGTH);
    const leaky = describeSyncError(new ProviderError('permission', 'denied for sk_live_abcdef1234567 (ops@example.com)'), stripe);
    expect(leaky).not.toContain('abcdef1234567');
    expect(leaky).not.toContain('ops@example.com');
  });

  it('an empty provider message falls back to the generic text', () => {
    expect(describeSyncError(new ProviderError('upstream', '   '), stripe)).toBe(
      'Something went wrong while syncing Stripe. The next sync will retry.',
    );
  });
});

describe('errorLogFields', () => {
  it('describes errors with sanitised messages', () => {
    expect(errorLogFields(new ProviderError('upstream', 'HTTP 500 for rk_test_abc123', { status: 500 }))).toEqual({
      errorKind: 'upstream',
      status: 500,
      message: 'HTTP 500 for rk_test_***',
    });
    expect(errorLogFields(new TypeError('Bearer sk_live_zzz'))).toEqual({
      errorKind: 'internal',
      errorName: 'TypeError',
      message: 'Bearer ***',
    });
  });

  it('never throws, even for values whose toString throws', () => {
    expect(errorLogFields(Object.create(null))).toEqual({ errorKind: 'internal', message: 'unprintable error' });
  });
});

describe('isStaleCursorError', () => {
  it.each([
    [new ProviderError('not_found', 'gone', { status: 404 }), true],
    [new ProviderError('invalid_input', 'bad cursor'), true],
    [new ProviderError('upstream', 'HTTP 400', { status: 400 }), true],
    [new ProviderError('upstream', 'HTTP 410', { status: 410 }), true],
    [new ProviderError('upstream', 'HTTP 503', { status: 503 }), false],
    [new ProviderError('upstream', 'network'), false],
    [new BudgetExhaustedError('Stripe'), false],
    [new ProviderError('rate_limit', '429', { status: 429 }), false],
    [new ProviderError('auth', '401', { status: 401 }), false],
    [new ProviderError('permission', '403', { status: 403 }), false],
    [new Error('boom'), false],
  ])('%s → %s', (err, expected) => {
    expect(isStaleCursorError(err)).toBe(expected);
  });
});

describe('exhaustedMessage', () => {
  it('is honest about snapshots, which cannot resume', () => {
    expect(exhaustedMessage('snapshot', 'Stripe', false)).toBe("Stripe has more subscriptions than one sync can read, so MRR wasn’t updated.");
    expect(exhaustedMessage('snapshot', 'Stripe', true)).toBe(
      "Stripe responded too slowly to read every subscription in one sync, so MRR wasn’t updated. The next sync will retry.",
    );
    expect(exhaustedMessage('revenue', 'Lemon Squeezy', false)).toBe(
      "Lemon Squeezy has more revenue history than one sync can read, so revenue wasn’t updated.",
    );
    expect(exhaustedMessage('revenue', 'RevenueCat', true)).toMatch(/^RevenueCat responded too slowly/);
    for (const phase of ['snapshot', 'revenue'] as const) {
      for (const deadline of [false, true]) {
        const msg = exhaustedMessage(phase, 'Lemon Squeezy', deadline);
        expect(msg.length).toBeLessThanOrEqual(MAX_SYNC_ERROR_LENGTH);
        expect(msg).not.toMatch(/continues/);
      }
    }
  });
});
