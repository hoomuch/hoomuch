import { describe, expect, it } from 'vitest';
import {
  BACKFILL_DAYS,
  MAX_DESCRIPTION_LENGTH,
  MAX_FUTURE_SKEW_MS,
  MAX_SNAPSHOT_PRODUCTS,
  MIN_PLAUSIBLE_TIME,
  REVENUE_OVERLAP_MS,
  advanceRevenue,
  affectedDayRange,
  cleanCurrency,
  cleanDailyPoints,
  cleanEvents,
  cleanSnapshot,
  cleanSnapshotHistory,
  dailyFromEvents,
  decodeBackfill,
  encodeBackfill,
  isDayKey,
  planRevenue,
  rangeBounds,
} from '../../src/sync/aggregate';
import { jsonChunks } from '../../src/sync/repo';
import { DAY, HOUR } from '../../src/lib/time';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');

const ev = (over: Record<string, unknown> = {}) => ({
  externalId: 'ch_1',
  occurredAt: NOW - HOUR,
  type: 'charge',
  amount: 1200,
  currency: 'USD',
  fee: 65,
  description: 'Pro',
  ...over,
});

describe('cleanCurrency / isDayKey', () => {
  it('upper-cases and validates ISO-looking codes', () => {
    expect(cleanCurrency('usd')).toBe('USD');
    expect(cleanCurrency(' eur ')).toBe('EUR');
    expect(cleanCurrency('US')).toBeNull();
    expect(cleanCurrency('USDT')).toBeNull();
    expect(cleanCurrency('U$D')).toBeNull();
    expect(cleanCurrency(840)).toBeNull();
  });

  it('accepts only real calendar days', () => {
    expect(isDayKey('2026-11-05')).toBe(true);
    expect(isDayKey('2028-02-29')).toBe(true);
    expect(isDayKey('2026-02-29')).toBe(false);
    expect(isDayKey('2026-02-30')).toBe(false);
    expect(isDayKey('2026-13-01')).toBe(false);
    expect(isDayKey('2026-1-05')).toBe(false);
    expect(isDayKey(20261105)).toBe(false);
  });
});

describe('cleanEvents', () => {
  it('keeps valid events and normalises them', () => {
    const { events, skipped } = cleanEvents(
      [ev({ currency: 'usd', description: '  Pro \n plan ', occurredAt: NOW - HOUR + 0.7 }), ev({ externalId: 're_1', type: 'refund', amount: -1200, fee: null })],
      NOW,
    );
    expect(skipped).toEqual({});
    expect(events).toEqual([
      { externalId: 'ch_1', occurredAt: NOW - HOUR, type: 'charge', amount: 1200, currency: 'USD', fee: 65, description: 'Pro plan' },
      { externalId: 're_1', occurredAt: NOW - HOUR, type: 'refund', amount: -1200, currency: 'USD', fee: null, description: 'Pro' },
    ]);
  });

  it('skips and counts bad rows by reason', () => {
    const { events, skipped } = cleanEvents(
      [
        null,
        'x',
        ev({ externalId: '' }),
        ev({ externalId: 'x'.repeat(256) }),
        ev({ externalId: 42 }),
        ev({ occurredAt: Number.NaN }),
        ev({ occurredAt: Math.floor(NOW / 1000) }), // seconds instead of ms
        ev({ occurredAt: NOW + 2 * DAY }), // far future
        ev({ occurredAt: '2026-11-05' }),
        ev({ type: 'payout' }),
        ev({ amount: 12.99 }), // major units
        ev({ amount: '1200' }),
        ev({ amount: -1200 }), // charge with a negative amount
        ev({ type: 'refund', amount: 500 }), // refund with a positive amount
        ev({ amount: 0 }),
        ev({ amount: Number.MAX_SAFE_INTEGER + 2 }),
        ev({ currency: 'dollars' }),
        ev({ currency: null }),
        ev({ externalId: 'ok' }),
      ],
      NOW,
    );
    expect(events.map((e) => e.externalId)).toEqual(['ok']);
    expect(skipped).toEqual({ shape: 2, external_id: 3, occurred_at: 4, type: 1, amount: 6, currency: 2 });
  });

  it('accepts timestamps up to the plausibility bounds inclusive, and nothing past them', () => {
    const at = (occurredAt: number, externalId: string) => ev({ occurredAt, externalId });
    const { events, skipped } = cleanEvents(
      [
        at(MIN_PLAUSIBLE_TIME, 'oldest-ok'),
        at(MIN_PLAUSIBLE_TIME - 1, 'too-old'),
        at(NOW + MAX_FUTURE_SKEW_MS, 'skew-ok'),
        at(NOW + MAX_FUTURE_SKEW_MS + 1, 'too-new'),
      ],
      NOW,
    );
    expect(events.map((e) => e.externalId)).toEqual(['oldest-ok', 'skew-ok']);
    expect(skipped).toEqual({ occurred_at: 2 });
  });

  it('dedupes by externalId, last one wins', () => {
    const { events, skipped } = cleanEvents([ev({ amount: 1000 }), ev({ externalId: 'ch_2' }), ev({ amount: 1500 })], NOW);
    expect(events.map((e) => [e.externalId, e.amount])).toEqual([
      ['ch_1', 1500],
      ['ch_2', 1200],
    ]);
    expect(skipped).toEqual({ duplicate: 1 });
  });

  it('nulls bad fees and caps descriptions instead of dropping the row', () => {
    const { events } = cleanEvents([ev({ fee: 1.5, description: 'd'.repeat(500) }), ev({ externalId: 'b', fee: 'x', description: '   ' })], NOW);
    expect(events[0]!.fee).toBeNull();
    expect(events[0]!.description).toHaveLength(MAX_DESCRIPTION_LENGTH);
    expect(events[1]!.fee).toBeNull();
    expect(events[1]!.description).toBeNull();
  });

  it('treats a missing list as empty and a non-list as a contract issue', () => {
    expect(cleanEvents(undefined, NOW)).toEqual({ events: [], skipped: {} });
    expect(cleanEvents({ data: [] }, NOW)).toEqual({ events: [], skipped: { not_an_array: 1 } });
  });
});

describe('cleanDailyPoints', () => {
  it('validates days, currencies and non-negative integers; last duplicate wins', () => {
    const { points, skipped } = cleanDailyPoints([
      { day: '2026-11-01', currency: 'usd', gross: 1000, refunds: 0, count: 3 },
      { day: '2026-11-01', currency: 'USD', gross: 1100, refunds: 10, count: 4 },
      { day: '2026-02-30', currency: 'USD', gross: 1, refunds: 0, count: 1 },
      { day: '2026-11-02', currency: 'USD', gross: -5, refunds: 0, count: 1 },
      { day: '2026-11-02', currency: 'USD', gross: 5.5, refunds: 0, count: 1 },
      { day: '2026-11-02', currency: 'XX', gross: 5, refunds: 0, count: 1 },
      { day: '2026-11-02', currency: 'EUR', gross: 5, refunds: 0 },
      7,
    ]);
    expect(points).toEqual([{ day: '2026-11-01', currency: 'USD', gross: 1100, refunds: 10, count: 4 }]);
    expect(skipped).toEqual({ duplicate: 1, day: 1, amount: 3, currency: 1, shape: 1 });
  });
});

describe('cleanSnapshotHistory', () => {
  const snap = { mrr: { USD: 100 }, activeSubscriptions: 2 };

  it('keeps real past days, oldest first, one row per day (the first wins)', () => {
    const { rows, skipped } = cleanSnapshotHistory(
      [
        { day: '2026-11-03', snapshot: { ...snap, mrr: { USD: 3 } } },
        { day: '2026-11-01', snapshot: snap },
        { day: '2026-11-03', snapshot: { ...snap, mrr: { USD: 999 } } },
        { day: '2026-11-05', snapshot: snap }, // today
        { day: '2026-02-30', snapshot: snap },
        { day: '2026-11-02', snapshot: { mrr: {} } }, // no subscription count
        'junk',
      ],
      '2026-11-05',
      90,
    );
    expect(rows.map((r) => [r.day, r.snapshot.mrr])).toEqual([
      ['2026-11-01', { USD: 100 }],
      ['2026-11-03', { USD: 3 }],
    ]);
    expect(skipped).toBe(5);
  });

  it('keeps only the newest maxDays', () => {
    const input = ['2026-11-01', '2026-11-02', '2026-11-03'].map((day) => ({ day, snapshot: snap }));
    const { rows, skipped } = cleanSnapshotHistory(input, '2026-11-05', 2);
    expect(rows.map((r) => r.day)).toEqual(['2026-11-02', '2026-11-03']);
    expect(skipped).toBe(1);
  });

  it('treats a missing list as empty and anything else as one skip', () => {
    expect(cleanSnapshotHistory(undefined, '2026-11-05', 90)).toEqual({ rows: [], skipped: 0 });
    expect(cleanSnapshotHistory({}, '2026-11-05', 90)).toEqual({ rows: [], skipped: 1 });
  });
});

describe('cleanSnapshot', () => {
  it('rounds amounts, upper-cases codes and drops non-money entries', () => {
    const { snapshot, dropped } = cleanSnapshot({
      mrr: { usd: 1000.4, EUR: 200, BAD: 'x', JPY: Number.NaN },
      activeSubscriptions: 12,
      activeTrials: null,
      revenuePeriod: { usd: 5000 },
      revenuePeriodDays: 28,
      newCustomers: undefined,
    });
    expect(snapshot).toEqual({
      mrr: { EUR: 200, USD: 1000 },
      activeSubscriptions: 12,
      activeTrials: null,
      revenuePeriod: { USD: 5000 },
      revenuePeriodDays: 28,
      newCustomers: null,
      mrrByProduct: null,
    });
    expect(dropped).toBe(2);
  });

  it('keeps an MRR split by product: names on one line and capped, money cleaned, biggest first', () => {
    const { snapshot, dropped } = cleanSnapshot({
      mrr: { USD: 9000 },
      activeSubscriptions: 3,
      mrrByProduct: [
        { name: '  Starter\n plan ', mrr: { usd: 1000.4 }, subscriptions: 1 },
        { name: 'P'.repeat(MAX_DESCRIPTION_LENGTH + 50), mrr: { USD: 5000 }, subscriptions: 2.2 },
        { name: '   ', mrr: { USD: 3000 } }, // no name left: kept, without one
        { name: 'Free', mrr: { USD: 0 }, subscriptions: 4 }, // no MRR
        { name: 'Broken', mrr: 'x' },
        'not an entry',
      ],
    });
    expect(snapshot.mrrByProduct).toEqual([
      { name: 'P'.repeat(MAX_DESCRIPTION_LENGTH), mrr: { USD: 5000 }, subscriptions: 2 },
      { name: null, mrr: { USD: 3000 }, subscriptions: 0 },
      { name: 'Starter plan', mrr: { USD: 1000 }, subscriptions: 1 },
    ]);
    expect(dropped).toBe(3);
    expect(cleanSnapshot({ mrr: {}, activeSubscriptions: 0, mrrByProduct: {} }).snapshot.mrrByProduct).toBeNull();
    expect(cleanSnapshot({ mrr: {}, activeSubscriptions: 0, mrrByProduct: [] }).snapshot.mrrByProduct).toEqual([]);
  });

  it('keeps at most MAX_SNAPSHOT_PRODUCTS products, the biggest', () => {
    const many = Array.from({ length: MAX_SNAPSHOT_PRODUCTS + 2 }, (_, i) => ({ name: `P${i}`, mrr: { USD: i + 1 }, subscriptions: 1 }));
    const { snapshot, dropped } = cleanSnapshot({ mrr: { USD: 1 }, activeSubscriptions: 1, mrrByProduct: many });
    expect(snapshot.mrrByProduct).toHaveLength(MAX_SNAPSHOT_PRODUCTS);
    expect(snapshot.mrrByProduct?.[0]?.name).toBe(`P${MAX_SNAPSHOT_PRODUCTS + 1}`);
    expect(snapshot.mrrByProduct?.some((p) => p.name === 'P0' || p.name === 'P1')).toBe(false);
    expect(dropped).toBe(2);
  });

  it('drops revenuePeriodDays when there is no period', () => {
    const { snapshot } = cleanSnapshot({ mrr: {}, activeSubscriptions: 0, revenuePeriod: null, revenuePeriodDays: 30 });
    expect(snapshot.revenuePeriod).toBeNull();
    expect(snapshot.revenuePeriodDays).toBeNull();
  });

  it('refuses snapshots it cannot store truthfully', () => {
    expect(() => cleanSnapshot(null)).toThrow();
    expect(() => cleanSnapshot({ activeSubscriptions: 1 })).toThrow(/mrr/);
    expect(() => cleanSnapshot({ mrr: {}, activeSubscriptions: -1 })).toThrow(/activeSubscriptions/);
    expect(() => cleanSnapshot({ mrr: {}, activeSubscriptions: Number.NaN })).toThrow(/activeSubscriptions/);
  });
});

describe('day ranges and dailyFromEvents', () => {
  it('affectedDayRange spans the min and max day', () => {
    expect(affectedDayRange([])).toBeNull();
    expect(affectedDayRange([Number.NaN])).toBeNull();
    expect(affectedDayRange([Date.parse('2026-11-03T23:59:59.999Z'), Date.parse('2026-10-30T00:00:00Z'), NOW])).toEqual({
      from: '2026-10-30',
      to: '2026-11-05',
    });
  });

  it('rangeBounds is [start of first day, end of last day)', () => {
    expect(rangeBounds({ from: '2026-11-01', to: '2026-11-02' })).toEqual({
      start: Date.parse('2026-11-01T00:00:00Z'),
      end: Date.parse('2026-11-03T00:00:00Z'),
    });
  });

  it('groups by UTC day and currency; refunds are positive; count includes refunds', () => {
    const d1 = Date.parse('2026-11-01T23:59:59.999Z');
    const d2 = Date.parse('2026-11-02T00:00:00.000Z');
    expect(
      dailyFromEvents([
        { occurredAt: d1, amount: 1000, currency: 'USD' },
        { occurredAt: d1, amount: 500, currency: 'EUR' },
        { occurredAt: d1, amount: -300, currency: 'USD' },
        { occurredAt: d2, amount: -1000, currency: 'USD' },
        { occurredAt: d1 - HOUR, amount: 250, currency: 'USD' },
      ]),
    ).toEqual([
      { day: '2026-11-01', currency: 'EUR', gross: 500, refunds: 0, count: 1 },
      { day: '2026-11-01', currency: 'USD', gross: 1250, refunds: 300, count: 3 },
      { day: '2026-11-02', currency: 'USD', gross: 0, refunds: 1000, count: 1 },
    ]);
  });
});

describe('planRevenue / advanceRevenue', () => {
  const firstSince = Date.parse('2026-08-08T00:00:00.000Z'); // 2026-08-08 … 2026-11-05 is 90 days

  it('first sync covers exactly the 90 days the dashboard can show, from midnight', () => {
    expect(BACKFILL_DAYS).toBe(90);
    expect(planRevenue({ revenue_cursor: null, revenue_synced_until: null }, NOW)).toEqual({
      since: firstSince,
      cursor: null,
      startedAt: NOW,
    });
  });

  it('incremental sync overlaps the high-water mark by 2 days (never past now)', () => {
    const hw = NOW - 3 * HOUR;
    expect(planRevenue({ revenue_cursor: null, revenue_synced_until: hw }, NOW)).toEqual({
      since: hw - REVENUE_OVERLAP_MS,
      cursor: null,
      startedAt: NOW,
    });
    expect(planRevenue({ revenue_cursor: null, revenue_synced_until: NOW + 10 * DAY }, NOW).since).toBe(NOW);
  });

  it('a resumed pass reuses the stored since and start time', () => {
    const stored = encodeBackfill({ cursor: 'txn_42', since: firstSince, startedAt: NOW - 2 * HOUR });
    expect(planRevenue({ revenue_cursor: stored, revenue_synced_until: null }, NOW)).toEqual({
      since: firstSince,
      cursor: 'txn_42',
      startedAt: NOW - 2 * HOUR,
    });
  });

  it('a bare (non-envelope) cursor is resumed with the usual window', () => {
    expect(planRevenue({ revenue_cursor: 'txn_42', revenue_synced_until: NOW - DAY }, NOW)).toEqual({
      since: NOW - DAY - REVENUE_OVERLAP_MS,
      cursor: 'txn_42',
      startedAt: NOW,
    });
  });

  it('envelopes round-trip; adapter JSON cursors and garbage are not envelopes', () => {
    const s = { cursor: '{"page":3}', since: 1, startedAt: 2 };
    expect(decodeBackfill(encodeBackfill(s))).toEqual(s);
    expect(decodeBackfill('{"page":3}')).toBeNull();
    expect(decodeBackfill('{"v":1,"cursor":"","since":1,"startedAt":2}')).toBeNull();
    expect(decodeBackfill('{"v":1,"cursor":"c","since":"1","startedAt":2}')).toBeNull();
    expect(decodeBackfill('{not json')).toBeNull();
    expect(decodeBackfill('txn_1')).toBeNull();
  });

  const plan = { since: firstSince, cursor: null, startedAt: NOW - HOUR };

  it('a cursor keeps the high-water mark and stores an envelope', () => {
    const a = advanceRevenue(plan, { nextCursor: 'c1', done: false }, 123);
    expect(a).toMatchObject({ syncedUntil: 123, done: false, contractIssue: null });
    expect(decodeBackfill(a.cursor!)).toEqual({ cursor: 'c1', since: firstSince, startedAt: NOW - HOUR });
  });

  it('done clears the cursor and moves the high-water mark to the pass start', () => {
    expect(advanceRevenue(plan, { nextCursor: null, done: true }, 123)).toEqual({
      cursor: null,
      syncedUntil: NOW - HOUR,
      done: true,
      contractIssue: null,
    });
  });

  it('contract violations: cursor wins over done; neither means done', () => {
    expect(advanceRevenue(plan, { nextCursor: 'c', done: true }, null)).toMatchObject({ done: false, contractIssue: 'cursor_and_done' });
    expect(advanceRevenue(plan, { nextCursor: null, done: false }, null)).toMatchObject({
      cursor: null,
      done: true,
      contractIssue: 'neither_cursor_nor_done',
    });
    expect(advanceRevenue(plan, { nextCursor: '', done: true }, null)).toMatchObject({ cursor: null, done: true });
  });
});

describe('jsonChunks', () => {
  it('splits by row count and by bytes, never producing empty chunks', () => {
    expect(jsonChunks([])).toEqual([]);
    expect(jsonChunks([1, 2, 3, 4, 5], 2)).toEqual(['[1,2]', '[3,4]', '[5]']);
    const big = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)]; // 62 bytes each: two never fit in 100
    const chunks = jsonChunks(big, 100, 100);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(JSON.parse(c)).toHaveLength(1);
    // A single row larger than the byte budget still gets its own chunk.
    expect(jsonChunks(['x'.repeat(500)], 100, 100)).toHaveLength(1);
  });
});
