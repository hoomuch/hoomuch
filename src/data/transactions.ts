/**
 * Transactions read model. Owner: Data Plane. Signature is part of the contract (SPEC §9.1).
 * One D1 round trip: the page (+1 row to detect `hasMore`) and the FX table in one batch.
 */

import type { Bindings, SessionUser } from '../env';
import { normalizeCurrency } from '../lib/money';
import { getProviderMeta } from '../providers/registry';
import type { ProviderId } from '../providers/types';
import { FxConverter, LATEST_FX_SQL, rowToFx } from '../sync/fx';
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
  opts: { provider: ProviderId | null; page: number; pageSize?: number },
): Promise<TransactionPage> {
  const currency = normalizeCurrency(user.baseCurrency || 'USD');
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize ?? TRANSACTIONS_PAGE_SIZE)));
  const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number.isFinite(opts.page) ? opts.page : 1)));
  const offset = (page - 1) * pageSize;
  const db = env.DB;

  const where = opts.provider ? 'c.user_id = ? AND c.provider = ?' : 'c.user_id = ?';
  const binds: Array<string | number> = opts.provider ? [user.id, opts.provider] : [user.id];
  const [pageR, fxR] = await db.batch([
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
  ]);

  const rows = (pageR!.results ?? []) as unknown as Row[];
  const cv = new FxConverter(currency, rowToFx((fxR!.results?.[0] ?? null) as { day: string; base: string; rates: string } | null));
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
      displayAmount: cv.tryAmount(r.amount, original),
      description: r.description,
    };
  });

  return { currency, provider: opts.provider, items, page, pageSize, hasMore: rows.length > pageSize };
}
