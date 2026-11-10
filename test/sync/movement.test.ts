/**
 * MRR movement (SPEC F-26): each sync's list of paying subscriptions is compared with the one
 * before, and what changed is added to the day's row: new, expansion, contraction, churned. The
 * dashboard adds the window's rows up and works the churn rates out from them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDashboardData } from '../../src/data/dashboard';
import { DAY, addDays, dayKey } from '../../src/lib/time';
import { stripeAdapter } from '../../src/providers/stripe';
import type { MetricsSnapshot, SubscriptionMrr } from '../../src/providers/types';
import { cleanSnapshot, cleanSubscriptions } from '../../src/sync/aggregate';
import { syncConnection } from '../../src/sync/engine';
import { MAX_TRACKED_SUBSCRIPTIONS, addMovements, diffSubscriptions, emptyMovement, movementIsEmpty, parseState, toState } from '../../src/sync/movement';
import { seedConnection } from '../fixtures/d1';
import { NOW, SECRET, encryptedCreds, page, seedStripe, setup, teardown, type Ctx } from './helpers';

const TODAY = dayKey(NOW);

let current: Ctx | null = null;
function ctx(): Ctx {
  current = setup();
  return current;
}

afterEach(() => {
  const out = current?.out.join('\n') ?? '';
  current = null;
  teardown();
  expect(out).not.toContain(SECRET);
});

const s = (id: string, mrr: number, currency = 'USD'): SubscriptionMrr => ({ id, currency, mrr });

function snapshotOf(subscriptions: SubscriptionMrr[]): MetricsSnapshot {
  const mrr: Record<string, number> = {};
  for (const x of subscriptions) mrr[x.currency] = (mrr[x.currency] ?? 0) + x.mrr;
  return { mrr, activeSubscriptions: subscriptions.length, activeTrials: 0, revenuePeriod: null, revenuePeriodDays: null, newCustomers: null, subscriptions };
}

/** One Stripe sync that reads `subscriptions`, at `at`. */
async function syncWith(c: Ctx, subscriptions: SubscriptionMrr[], at = NOW): Promise<void> {
  vi.setSystemTime(at);
  vi.spyOn(stripeAdapter, 'fetchSnapshot').mockResolvedValue(snapshotOf(subscriptions));
  vi.spyOn(stripeAdapter, 'fetchRevenue').mockResolvedValue(page([]));
  const r = await syncConnection(c.env, 's1', 'manual');
  expect(r).toMatchObject({ ok: true, snapshot: true });
}

interface Stored {
  day: string;
  new_mrr: string;
  new_count: number;
  expansion_mrr: string;
  expansion_count: number;
  contraction_mrr: string;
  contraction_count: number;
  churned_mrr: string;
  churned_count: number;
}

const movements = (c: Ctx, id = 's1'): Stored[] =>
  c.t.rows<Stored>(
    `SELECT day, new_mrr, new_count, expansion_mrr, expansion_count, contraction_mrr, contraction_count, churned_mrr, churned_count
       FROM mrr_movements WHERE connection_id = ? ORDER BY day`,
    id,
  );

const stateOf = (c: Ctx, id = 's1') => c.t.rows<{ since: string; state: string }>('SELECT since, state FROM subscription_states WHERE connection_id = ?', id)[0];

describe('diffSubscriptions', () => {
  it('sorts every change into one bucket', () => {
    const before = toState([s('a', 1000), s('b', 2000), s('c', 3000), s('d', 500), s('e', 900, 'EUR')]);
    const after = toState([s('a', 1000), s('b', 2500), s('c', 1000), s('f', 700), s('g', 400, 'EUR'), s('e', 900, 'EUR')]);
    expect(diffSubscriptions(before, after)).toEqual({
      new: { mrr: { USD: 700, EUR: 400 }, count: 2 },
      expansion: { mrr: { USD: 500 }, count: 1 },
      contraction: { mrr: { USD: 2000 }, count: 1 },
      churned: { mrr: { USD: 500 }, count: 1 },
    });
  });

  it('finds nothing between two equal lists, whatever their order', () => {
    const d = diffSubscriptions(toState([s('a', 1), s('b', 2)]), toState([s('b', 2), s('a', 1)]));
    expect(movementIsEmpty(d)).toBe(true);
    expect(d).toEqual(emptyMovement());
  });

  it('reads a change of currency as one subscription gone and one new', () => {
    const d = diffSubscriptions(toState([s('a', 1000, 'USD')]), toState([s('a', 900, 'EUR')]));
    expect(d.churned).toEqual({ mrr: { USD: 1000 }, count: 1 });
    expect(d.new).toEqual({ mrr: { EUR: 900 }, count: 1 });
  });

  it('reads an unknown amount that gets a price as the same subscription paying more', () => {
    const d = diffSubscriptions(toState([s('a', 0, 'XXX')]), toState([s('a', 900, 'EUR')]));
    expect(d.expansion).toEqual({ mrr: { EUR: 900 }, count: 1 });
    expect(d.new.count + d.churned.count).toBe(0);
  });

  it('keeps ids that spell object properties apart from them', () => {
    const state = toState([s('__proto__', 100), s('constructor', 200)]);
    expect(Object.keys(parseState(JSON.stringify(state))!).sort()).toEqual(['__proto__', 'constructor']);
    expect(diffSubscriptions(toState([]), state).new).toEqual({ mrr: { USD: 300 }, count: 2 });
    expect(diffSubscriptions(state, toState([])).churned.count).toBe(2);
  });

  it('adds a day’s movements up', () => {
    const a = diffSubscriptions(toState([]), toState([s('a', 100)]));
    const b = diffSubscriptions(toState([s('a', 100)]), toState([s('b', 50, 'EUR')]));
    expect(addMovements(a, b)).toEqual({
      new: { mrr: { USD: 100, EUR: 50 }, count: 2 },
      expansion: { mrr: {}, count: 0 },
      contraction: { mrr: {}, count: 0 },
      churned: { mrr: { USD: 100 }, count: 1 },
    });
  });

  it('turns down a stored list it can’t read', () => {
    expect(parseState(null)).toBeNull();
    expect(parseState('nope')).toBeNull();
    expect(parseState('[1]')).toBeNull();
    expect(parseState('{"a":[1.5,"USD"]}')).toBeNull();
    expect(parseState('{"a":[100,"USD"]}')).toEqual({ a: [100, 'USD'] });
  });
});

describe('cleanSubscriptions', () => {
  it('keeps a whole list, with currencies normalised', () => {
    expect(cleanSubscriptions([{ id: 'sub_1', currency: 'usd', mrr: 1000 }])).toEqual([s('sub_1', 1000)]);
    expect(cleanSnapshot(snapshotOf([s('a', 5)])).snapshot.subscriptions).toEqual([s('a', 5)]);
  });

  it('drops the list, not the entry, when any of it can’t be read: a partial list would read as churn', () => {
    expect(cleanSubscriptions([s('a', 100), { id: '', currency: 'USD', mrr: 1 }])).toBeNull();
    expect(cleanSubscriptions([s('a', 100), { id: 'b', currency: 'USD', mrr: -1 }])).toBeNull();
    expect(cleanSubscriptions([s('a', 100), { id: 'b', currency: 'dollars', mrr: 1 }])).toBeNull();
    expect(cleanSubscriptions(Array.from({ length: MAX_TRACKED_SUBSCRIPTIONS + 1 }, (_, i) => s(`s${i}`, 1)))).toBeNull();
    expect(cleanSubscriptions(undefined)).toBeNull();
    // The snapshot itself is still stored.
    expect(cleanSnapshot({ ...snapshotOf([s('a', 5)]), subscriptions: [{ id: 7 }] }).snapshot.subscriptions).toBeUndefined();
  });
});

describe('the sync engine', () => {
  it('stores the first list without a movement, then each sync’s changes on its day', async () => {
    const c = ctx();
    await seedStripe(c, 's1');

    await syncWith(c, [s('a', 1000), s('b', 2000), s('c', 3000)], NOW - DAY);
    expect(movements(c)).toEqual([]);
    expect(stateOf(c)).toMatchObject({ since: addDays(TODAY, -1) });

    // Same day, an hour on: b upgrades.
    await syncWith(c, [s('a', 1000), s('b', 2500), s('c', 3000)], NOW - DAY + 3_600_000);
    // The next day: c cancels, d joins. Later that day: a downgrades.
    await syncWith(c, [s('a', 1000), s('b', 2500), s('d', 700)]);
    await syncWith(c, [s('a', 400), s('b', 2500), s('d', 700)], NOW + 3_600_000);

    expect(movements(c)).toEqual([
      {
        day: addDays(TODAY, -1),
        new_mrr: '{}',
        new_count: 0,
        expansion_mrr: '{"USD":500}',
        expansion_count: 1,
        contraction_mrr: '{}',
        contraction_count: 0,
        churned_mrr: '{}',
        churned_count: 0,
      },
      {
        day: TODAY,
        new_mrr: '{"USD":700}',
        new_count: 1,
        expansion_mrr: '{}',
        expansion_count: 0,
        contraction_mrr: '{"USD":600}',
        contraction_count: 1,
        churned_mrr: '{"USD":3000}',
        churned_count: 1,
      },
    ]);
    // The list is today's, and still says when tracking began.
    expect(stateOf(c)).toEqual({ since: addDays(TODAY, -1), state: JSON.stringify(toState([s('a', 400), s('b', 2500), s('d', 700)])) });
  });

  it('writes nothing when nothing changed', async () => {
    const c = ctx();
    await seedStripe(c, 's1');
    await syncWith(c, [s('a', 1000), s('b', 2000)], NOW - DAY);
    const before = c.t.rows<{ updated_at: number }>('SELECT updated_at FROM subscription_states')[0]!.updated_at;
    await syncWith(c, [s('b', 2000), s('a', 1000)]);
    expect(movements(c)).toEqual([]);
    expect(c.t.rows<{ updated_at: number }>('SELECT updated_at FROM subscription_states')[0]!.updated_at).toBe(before);
  });

  it('leaves the stored list alone when a sync brings none, and compares with it the next time', async () => {
    const c = ctx();
    await seedStripe(c, 's1');
    await syncWith(c, [s('a', 1000), s('b', 2000)], NOW - 2 * DAY);
    vi.setSystemTime(NOW - DAY);
    vi.spyOn(stripeAdapter, 'fetchSnapshot').mockResolvedValue({ ...snapshotOf([s('a', 1000)]), subscriptions: null });
    await syncConnection(c.env, 's1', 'manual');
    expect(movements(c)).toEqual([]);

    await syncWith(c, [s('a', 1000)]);
    expect(movements(c).map((m) => [m.day, m.churned_count, m.churned_mrr])).toEqual([[TODAY, 1, '{"USD":2000}']]);
  });

  it('still writes the snapshot when the stored list is unreadable, and starts over from this sync', async () => {
    const c = ctx();
    await seedStripe(c, 's1');
    await syncWith(c, [s('a', 1000)], NOW - DAY);
    c.t.exec("UPDATE subscription_states SET state = 'broken'");
    await syncWith(c, [s('a', 1000), s('b', 500)]);
    expect(movements(c)).toEqual([]);
    expect(stateOf(c)).toMatchObject({ since: TODAY });
    expect(c.t.rows('SELECT day FROM snapshots WHERE connection_id = ?', 's1')).toHaveLength(2);
  });

  it('starts the demo with its history’s movement, so a new dashboard has churn to show', async () => {
    const c = ctx();
    seedConnection(c.t, { id: 'demo-1', userId: c.userId, provider: 'demo', credentialsEnc: await encryptedCreds({}), config: { seed: 'm', anchor: '2026-08-01' }, status: 'pending' });
    await syncConnection(c.env, 'demo-1', 'initial');

    const rows = movements(c, 'demo-1');
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => r.day > addDays(TODAY, -90) && r.day <= TODAY)).toBe(true);
    expect(rows.reduce((n, r) => n + r.churned_count, 0)).toBeGreaterThan(0);
    expect(stateOf(c, 'demo-1')).toMatchObject({ since: addDays(TODAY, -90) });

    // The movement accounts for the whole change in subscriptions since the first day.
    const snaps = c.t.rows<{ day: string; active_subscriptions: number }>('SELECT day, active_subscriptions FROM snapshots WHERE connection_id = ? ORDER BY day', 'demo-1');
    const net = rows.reduce((n, r) => n + r.new_count - r.churned_count, 0);
    expect(net).toBe(snaps.at(-1)!.active_subscriptions - snaps[0]!.active_subscriptions);
  });
});

describe('the dashboard', () => {
  it('adds the window up, in the display currency, with the churn rates', async () => {
    const c = ctx();
    await seedStripe(c, 's1', { name: 'Main' });
    seedConnection(c.t, { id: 'rc', userId: c.userId, provider: 'revenuecat', name: 'App' });
    // 10 subscriptions at $10 forty days ago.
    await syncWith(c, Array.from({ length: 10 }, (_, i) => s(`s${i}`, 1000)), NOW - 40 * DAY);
    // Ten days ago: s0 churns, s1 upgrades to $15, s2 downgrades to $6, two join at $20.
    await syncWith(c, [s('s1', 1500), s('s2', 600), ...Array.from({ length: 7 }, (_, i) => s(`s${i + 3}`, 1000)), s('n1', 2000), s('n2', 2000)], NOW - 10 * DAY);
    vi.setSystemTime(NOW);

    const d = await getDashboardData(c.env, { id: c.userId, email: 'a@example.com', baseCurrency: 'USD', timeZone: 'UTC' }, 30);
    expect(d.movement).toEqual({
      new: { amount: 4000, count: 2 },
      expansion: { amount: 500, count: 1 },
      contraction: { amount: 400, count: 1 },
      churned: { amount: 1000, count: 1 },
      net: 3100,
      // 1 of the 10 subscriptions at the start; $14 of the $100 MRR at the start.
      subscriptionChurnPct: 10,
      mrrChurnPct: expect.closeTo(14, 6),
      since: null,
      notIncluded: ['RevenueCat'],
    });

    // A window that starts before tracking did says since when.
    const d90 = await getDashboardData(c.env, { id: c.userId, email: 'a@example.com', baseCurrency: 'USD', timeZone: 'UTC' }, 90);
    expect(d90.movement).toMatchObject({ net: 3100, since: addDays(TODAY, -40) });
    // A window after the change has the card, with nothing in it.
    const d7 = await getDashboardData(c.env, { id: c.userId, email: 'a@example.com', baseCurrency: 'USD', timeZone: 'UTC' }, 7);
    expect(d7.movement).toMatchObject({ net: 0, subscriptionChurnPct: 0, mrrChurnPct: 0 });
  });

  it('has no movement when no connection lists its subscriptions', async () => {
    const c = ctx();
    seedConnection(c.t, { id: 'rc', userId: c.userId, provider: 'revenuecat', name: 'App' });
    const d = await getDashboardData(c.env, { id: c.userId, email: 'a@example.com', baseCurrency: 'USD', timeZone: 'UTC' }, 30);
    expect(d.movement).toBeNull();
  });

  it('forgets a connection’s movement with the connection', async () => {
    const c = ctx();
    await seedStripe(c, 's1');
    await syncWith(c, [s('a', 1000)], NOW - DAY);
    await syncWith(c, [s('b', 1000)]);
    expect(movements(c)).toHaveLength(1);
    c.t.exec("DELETE FROM connections WHERE id = 's1'");
    expect(c.t.rows('SELECT 1 FROM mrr_movements')).toHaveLength(0);
    expect(c.t.rows('SELECT 1 FROM subscription_states')).toHaveLength(0);
  });
});
