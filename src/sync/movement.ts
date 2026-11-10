/**
 * MRR movement (SPEC F-26): what changed between two syncs' lists of paying subscriptions.
 * Owner: Data Plane. Pure: the engine reads and writes the rows (sync/repo.ts).
 */

import { addToMoney, normalizeCurrency, type MoneyMap } from '../lib/money';
import type { SubscriptionMrr } from '../providers/types';

/**
 * Most subscriptions one connection's movement is tracked for. The list is stored as one JSON
 * value (about 50 bytes a subscription), and D1 holds 2 MB in one.
 */
export const MAX_TRACKED_SUBSCRIPTIONS = 20_000;
/** Most bytes of JSON a stored list may take, well inside that. A longer one isn't tracked. */
export const MAX_STATE_BYTES = 1_000_000;

/** A connection's subscriptions as of one sync: id → [monthly minor units, currency]. */
export type SubscriptionState = Record<string, [number, string]>;

/** One bucket of a movement: the MRR it moved (positive, by currency) and how many subscriptions. */
export interface MovementPart {
  mrr: MoneyMap;
  count: number;
}

export interface Movement {
  /** Subscriptions that started paying. */
  new: MovementPart;
  /** Subscriptions that pay more than before; `mrr` is the increase. */
  expansion: MovementPart;
  /** Subscriptions that pay less than before; `mrr` is the decrease. */
  contraction: MovementPart;
  /** Subscriptions that no longer count; `mrr` is what they paid. */
  churned: MovementPart;
}

const part = (): MovementPart => ({ mrr: {}, count: 0 });

export function emptyMovement(): Movement {
  return { new: part(), expansion: part(), contraction: part(), churned: part() };
}

export function movementIsEmpty(m: Movement): boolean {
  return m.new.count + m.expansion.count + m.contraction.count + m.churned.count === 0;
}

function add(p: MovementPart, currency: string, amount: number): void {
  p.count += 1;
  if (amount > 0) addToMoney(p.mrr, currency, amount);
}

/** The list as it's stored. A repeated id keeps its first entry. */
export function toState(subscriptions: readonly SubscriptionMrr[]): SubscriptionState {
  // No prototype: a provider's id is the key, whatever it spells.
  const state = Object.create(null) as SubscriptionState;
  for (const s of subscriptions) if (!(s.id in state)) state[s.id] = [s.mrr, normalizeCurrency(s.currency)];
  return state;
}

/** A stored list back from its JSON, or null when it isn't one (the next sync starts over). */
export function parseState(json: string | null | undefined): SubscriptionState | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const state = Object.create(null) as SubscriptionState;
    for (const [id, entry] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(entry) || !Number.isSafeInteger(entry[0]) || typeof entry[1] !== 'string') return null;
      state[id] = [entry[0] as number, entry[1]];
    }
    return state;
  } catch {
    return null;
  }
}

/** Two entries of one subscription that can't be compared: both priced, in different currencies. */
const otherCurrency = (a: [number, string], b: [number, string]): boolean => a[1] !== b[1] && a[0] > 0 && b[0] > 0;

/**
 * What changed from `before` to `after`. A subscription whose currency changed counts as one that
 * churned and one that's new: its two amounts can't be compared. One whose amount was unknown (0)
 * and is now priced, or the other way round, is the same subscription paying more or less.
 */
export function diffSubscriptions(before: SubscriptionState, after: SubscriptionState): Movement {
  const m = emptyMovement();
  for (const [id, [mrr, currency]] of Object.entries(after)) {
    const was = before[id];
    if (!was || otherCurrency(was, [mrr, currency])) add(m.new, currency, mrr);
    else if (mrr > was[0]) add(m.expansion, currency, mrr - was[0]);
    else if (mrr < was[0]) add(m.contraction, currency, was[0] - mrr);
  }
  for (const [id, [mrr, currency]] of Object.entries(before)) {
    const now = after[id];
    if (!now || otherCurrency(now, [mrr, currency])) add(m.churned, currency, mrr);
  }
  return m;
}

/** `a` and `b` added up: a day's movement so far plus this sync's. */
export function addMovements(a: Movement, b: Movement): Movement {
  const sum = (x: MovementPart, y: MovementPart): MovementPart => {
    const mrr: MoneyMap = { ...x.mrr };
    for (const [currency, amount] of Object.entries(y.mrr)) addToMoney(mrr, currency, amount);
    return { mrr, count: x.count + y.count };
  };
  return {
    new: sum(a.new, b.new),
    expansion: sum(a.expansion, b.expansion),
    contraction: sum(a.contraction, b.contraction),
    churned: sum(a.churned, b.churned),
  };
}
