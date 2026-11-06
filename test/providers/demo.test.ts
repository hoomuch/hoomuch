import { describe, expect, it } from 'vitest';
import { DEMO_HISTORY_DAYS, DEMO_PLANS, demoAdapter, demoSnapshotHistory } from '../../src/providers/demo';
import { DAY, addDays, dayKey } from '../../src/lib/time';
import { makeCtx, NOW } from '../fixtures/harness';

const noNetwork = (() => {
  throw new Error('demo adapter must not use the network');
}) as unknown as typeof fetch;

const config = { seed: 'abc123', anchor: '2026-11-05' };
const input = { credentials: {}, config };

describe('demo adapter', () => {
  it('verifies without a key or network and returns a random seed + anchor day', async () => {
    const a = await demoAdapter.verify({ credentials: {}, config: {} }, makeCtx(noNetwork));
    const b = await demoAdapter.verify({ credentials: {}, config: {} }, makeCtx(noNetwork));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.config['seed']).toMatch(/^[a-z0-9]+$/);
    expect(a.config['seed']).not.toBe(b.config['seed']);
    expect(a.config['anchor']).toBe(dayKey(NOW));
    expect(a.testMode).toBe(false);
  });

  it('produces a deterministic multi-currency snapshot', async () => {
    const s1 = await demoAdapter.fetchSnapshot(input, makeCtx(noNetwork));
    const s2 = await demoAdapter.fetchSnapshot(input, makeCtx(noNetwork));
    expect(s1).toEqual(s2);
    expect(Object.keys(s1.mrr).sort()).toEqual(['EUR', 'GBP', 'USD']);
    for (const v of Object.values(s1.mrr)) expect(Number.isInteger(v) && v > 0).toBe(true);
    expect(s1.activeSubscriptions).toBeGreaterThan(300);
    expect(s1.activeTrials).toBeGreaterThan(0);
    expect(s1.revenuePeriodDays).toBe(30);

    const other = await demoAdapter.fetchSnapshot({ credentials: {}, config: { seed: 'zzz', anchor: '2026-11-05' } }, makeCtx(noNetwork));
    expect(other.mrr).not.toEqual(s1.mrr);
  });

  it('exposes 90 days of slowly growing MRR history ending yesterday', () => {
    const h = demoSnapshotHistory(config, NOW);
    expect(h).toHaveLength(DEMO_HISTORY_DAYS);
    expect(h[0]!.day).toBe(addDays(dayKey(NOW), -90));
    expect(h.at(-1)!.day).toBe(addDays(dayKey(NOW), -1));
    const first = h[0]!.snapshot.mrr['USD']!;
    const last = h.at(-1)!.snapshot.mrr['USD']!;
    expect(last).toBeGreaterThan(first);
    expect(last / first).toBeLessThan(1.4); // slow growth, not a hockey stick
    expect(demoSnapshotHistory(config, NOW)).toEqual(h);
  });

  it('counts history back from the owner’s local today, not the UTC one', async () => {
    // NOW is 2026-11-05T12:00Z, already 11-06 in Auckland: the day before it must not be left out.
    const h = await demoAdapter.fetchSnapshotHistory!(input, { days: 90, today: '2026-11-06' }, makeCtx(noNetwork));
    expect(h).toHaveLength(90);
    expect(h[0]!.day).toBe('2026-08-08');
    expect(h.at(-1)!.day).toBe('2026-11-05');
  });

  it('returns deterministic revenue events within [since, now] with charges, fees and occasional refunds', async () => {
    const since = NOW - 90 * DAY;
    const r1 = await demoAdapter.fetchRevenue(input, { since, cursor: null }, makeCtx(noNetwork));
    const r2 = await demoAdapter.fetchRevenue(input, { since, cursor: null }, makeCtx(noNetwork));
    expect(r1).toEqual(r2);
    expect(r1.done).toBe(true);
    expect(r1.nextCursor).toBeNull();
    expect(r1.daily).toEqual([]);

    const ids = new Set(r1.events.map((e) => e.externalId));
    expect(ids.size).toBe(r1.events.length);
    expect(r1.events.length).toBeGreaterThan(500);
    for (const e of r1.events) {
      expect(e.occurredAt).toBeGreaterThanOrEqual(since);
      expect(e.occurredAt).toBeLessThanOrEqual(NOW);
      expect(Number.isInteger(e.amount)).toBe(true);
      expect(['USD', 'EUR', 'GBP']).toContain(e.currency);
      if (e.type === 'charge') expect(e.amount).toBeGreaterThan(0);
      else expect(e.amount).toBeLessThan(0);
      expect(DEMO_PLANS.map((p) => p.name)).toContain(e.description);
    }
    const refunds = r1.events.filter((e) => e.type === 'refund');
    expect(refunds.length).toBeGreaterThan(0);
    expect(refunds.length).toBeLessThan(r1.events.length / 20);
  });

  it('is stable across time: a later sync re-emits the same ids for the same day', async () => {
    const early = await demoAdapter.fetchRevenue(input, { since: NOW - 3 * DAY, cursor: null }, makeCtx(noNetwork, { now: NOW }));
    const later = await demoAdapter.fetchRevenue(
      input,
      { since: NOW - 3 * DAY, cursor: null },
      makeCtx(noNetwork, { now: NOW + 6 * 3600_000 }),
    );
    const laterById = new Map(later.events.map((e) => [e.externalId, e]));
    expect(early.events.length).toBeGreaterThan(0); // otherwise the loop below proves nothing
    for (const e of early.events) expect(laterById.get(e.externalId)).toEqual(e);
    expect(later.events.length).toBeGreaterThanOrEqual(early.events.length);
  });

  it('clips `since` to the 90-day history window', async () => {
    const r = await demoAdapter.fetchRevenue(input, { since: 0, cursor: null }, makeCtx(noNetwork));
    expect(r.events.length).toBeGreaterThan(0); // Math.min of nothing is Infinity, which would pass
    const oldest = Math.min(...r.events.map((e) => e.occurredAt));
    const windowStart = Date.parse(`${addDays(dayKey(NOW), -90)}T00:00:00Z`);
    expect(oldest).toBeGreaterThanOrEqual(windowStart);
    expect(oldest).toBeLessThan(windowStart + DAY); // clipped to the window's first day, not later
    // Clipping is the whole effect of since=0: the result equals asking for the window start.
    const clipped = await demoAdapter.fetchRevenue(input, { since: windowStart, cursor: null }, makeCtx(noNetwork));
    expect(r.events).toEqual(clipped.events);
  });
});
