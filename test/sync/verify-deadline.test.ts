/** The add-connection form's live key check stops starting requests after VERIFY_DEADLINE_MS (20 s). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from '../../src/services/connections';
import { fakeFetch, route } from '../fixtures/harness';
import { NOW, setup, teardown } from './helpers';

afterEach(() => teardown());

const emptyList = { object: 'list', data: [], has_more: false };

/** Stripe's verify reads five endpoints in turn; the first answer arrives `firstAnswerMs` after it was asked. */
function stubSlowStripe(firstAnswerMs: number) {
  const ff = fakeFetch([
    route('/v1/subscriptions', () => {
      vi.setSystemTime(NOW + firstAnswerMs);
      return { json: emptyList };
    }),
    route('/v1/prices', { json: emptyList }),
    route('/v1/balance_transactions', { json: emptyList }),
    route('/v1/coupons', { json: emptyList }),
    route('/v1/products', { json: emptyList }),
  ]);
  vi.stubGlobal('fetch', ff.fetch);
  return ff;
}

const paths = (calls: Array<{ url: string }>) => calls.map((c) => new URL(c.url).pathname);

describe('createConnection verify deadline', () => {
  it('starts no request after 20 s and says the provider couldn’t be reached, saving nothing', async () => {
    const c = setup();
    const { calls } = stubSlowStripe(21_000);
    const r = await createConnection(c.env, c.userId, 'stripe', undefined, { apiKey: 'rk_test_x' });
    expect(r).toEqual({ ok: false, error: 'Couldn’t reach Stripe. Try again in a few minutes.', fieldErrors: {} });
    expect(paths(calls)).toEqual(['/v1/subscriptions']);
    expect(c.t.rows('SELECT id FROM connections')).toEqual([]);
  });

  it('still finishes a check that is slow but inside the 20 s', async () => {
    const c = setup();
    const { calls } = stubSlowStripe(19_000);
    const r = await createConnection(c.env, c.userId, 'stripe', undefined, { apiKey: 'rk_test_x' });
    expect(r).toMatchObject({ ok: true });
    expect(paths(calls)).toEqual(['/v1/subscriptions', '/v1/prices', '/v1/balance_transactions', '/v1/coupons', '/v1/products']);
  });
});
