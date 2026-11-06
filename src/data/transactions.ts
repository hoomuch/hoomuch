/**
 * Transactions read model. Owner: Data Plane. Signature is part of the contract (SPEC §9.1).
 * One D1 round trip: the page (+1 row to detect `hasMore`) and the FX table in one batch.
 */

import type { Bindings, SessionUser } from '../env';
import { normalizeCurrency } from '../lib/money';
import { addDays, UTC, zonedDayKey, zonedDayStart } from '../lib/time';
import { getProviderMeta } from '../providers/registry';
import type { ProviderId } from '../providers/types';
import { FxConverter, FxHistory, LATEST_FX_SQL, fxHistoryStatement, latestFx } from '../sync/fx';
import type { TransactionPage, TransactionRow } from './types';

export const TRANSACTIONS_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Deep OFFSETs get slow; nobody pages 2,000 pages into a list. */
const MAX_PAGE = 2_000;

interface Row {
  connection_id: string;
  connection_name: string;
  provider: ProviderId;
  external_id: string;
  occurred_at: number;
  type: 'charge' | 'refund';
  amount: number;
  currency: string;
  description: string | null;
}

export async function listTransactions(
  env: Bindings,
  user: SessionUser,
  /** `day`: one of the user's local days ('YYYY-MM-DD', already validated), or null for every day. */
  opts: { provider: ProviderId | null; page: number; pageSize?: number; day?: string | null },
): Promise<TransactionPage> {
  const currency = normalizeCurrency(user.baseCurrency || 'USD');
  const tz = user.timeZone || UTC;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize ?? TRANSACTIONS_PAGE_SIZE)));
  const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number.isFinite(opts.page) ? opts.page : 1)));
  const offset = (page - 1) * pageSize;
  const db = env.DB;

  const day = opts.day ?? null;
  const conds = ['c.user_id = ?'];
  const binds: Array<string | number> = [user.id];
  if (opts.provider) {
    conds.push('c.provider = ?');
    binds.push(opts.provider);
  }
  if (day) {
    // The user's local day (SPEC §6).
    conds.push('t.occurred_at >= ? AND t.occurred_at < ?');
    binds.push(zonedDayStart(day, tz), zonedDayStart(addDays(day, 1), tz));
  }
  const where = conds.join(' AND ');
  const [pageR, fxR, histR] = await db.batch([
    db
      .prepare(
        `SELECT t.connection_id, c.name AS connection_name, c.provider, t.external_id, t.occurred_at,
                t.type, t.amount, t.currency, t.description
           FROM transactions t JOIN connections c ON c.id = t.connection_id
          WHERE ${where}
          ORDER BY t.occurred_at DESC, t.connection_id, t.external_id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...binds, pageSize + 1, offset),
    db.prepare(LATEST_FX_SQL),
    // A page can reach back to any day: the user's whole (slimmed) rate history, or just its day.
    fxHistoryStatement(db, user.id, currency, day, day ?? zonedDayKey(Date.now(), tz)),
  ]);

  const rows = (pageR!.results ?? []) as unknown as Row[];
  type FxRows = { day: string; base: string; rates: string }[] | undefined;
  const cv = new FxConverter(currency, latestFx(fxR!.results as FxRows), new FxHistory(histR!.results as FxRows));
  const items: TransactionRow[] = rows.slice(0, pageSize).map((r) => {
    const meta = getProviderMeta(r.provider);
    const original = normalizeCurrency(r.currency);
    return {
      connectionId: r.connection_id,
      connectionName: r.connection_name,
      provider: r.provider,
      color: meta.color,
      dotClass: meta.dotClass,
      externalId: r.external_id,
      occurredAt: r.occurred_at,
      type: r.type,
      amount: r.amount,
      originalCurrency: original,
      // At the rate of the day the money moved (SPEC §6).
      displayAmount: cv.tryAmountOn(r.amount, original, zonedDayKey(r.occurred_at, tz)),
      description: r.description,
    };
  });

  return { currency, provider: opts.provider, day, items, page, pageSize, hasMore: rows.length > pageSize };
}
