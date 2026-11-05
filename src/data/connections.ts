/**
 * Connection read models. Owner: Data Plane (initial version by Lead). Signatures are contract.
 */

import type { Bindings, SessionUser } from '../env';
import { listConnections, parseConfig, type ConnectionRow } from '../db/queries';
import { normalizeCurrency, parseMoneyMap } from '../lib/money';
import { getProviderMeta } from '../providers/registry';
import { FxConverter, LATEST_FX_SQL, rowToFx } from '../sync/fx';
import type { ConnectionDetail, ConnectionSummary, SnapshotRow, SyncRunRow } from './types';

export function toSummary(row: ConnectionRow): ConnectionSummary {
  const meta = getProviderMeta(row.provider);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    color: meta.color,
    dotClass: meta.dotClass,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    testMode: row.test_mode === 1,
  };
}

export async function listConnectionSummaries(env: Bindings, userId: string): Promise<ConnectionSummary[]> {
  return (await listConnections(env.DB, userId)).map(toSummary);
}

interface SnapRow {
  day: string;
  mrr: string;
  active_subscriptions: number;
  active_trials: number | null;
}

interface RunRow {
  kind: SyncRunRow['kind'];
  started_at: number;
  finished_at: number | null;
  ok: number | null;
  events: number;
  message: string | null;
}

/** One round trip: the connection, its last 30 snapshots, last 10 runs and the FX table. */
export async function getConnectionDetail(
  env: Bindings,
  user: SessionUser,
  connectionId: string,
): Promise<ConnectionDetail | null> {
  const db = env.DB;
  const currency = normalizeCurrency(user.baseCurrency || 'USD');
  const [connR, snapR, runR, fxR] = await db.batch([
    db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').bind(connectionId, user.id),
    db
      .prepare(
        `SELECT s.day, s.mrr, s.active_subscriptions, s.active_trials FROM snapshots s
           JOIN connections c ON c.id = s.connection_id
          WHERE s.connection_id = ? AND c.user_id = ? ORDER BY s.day DESC LIMIT 30`,
      )
      .bind(connectionId, user.id),
    db
      .prepare(
        `SELECT r.kind, r.started_at, r.finished_at, r.ok, r.events, r.message FROM sync_runs r
           JOIN connections c ON c.id = r.connection_id
          WHERE r.connection_id = ? AND c.user_id = ? ORDER BY r.started_at DESC, r.id DESC LIMIT 10`,
      )
      .bind(connectionId, user.id),
    db.prepare(LATEST_FX_SQL),
  ]);

  const row = (connR!.results?.[0] ?? null) as ConnectionRow | null;
  if (!row) return null;
  const cv = new FxConverter(currency, rowToFx((fxR!.results?.[0] ?? null) as { day: string; base: string; rates: string } | null));

  const snapshots: SnapshotRow[] = ((snapR!.results ?? []) as unknown as SnapRow[]).map((s) => ({
    day: s.day,
    mrr: cv.map(parseMoneyMap(s.mrr)),
    activeSubscriptions: s.active_subscriptions,
    activeTrials: s.active_trials,
  }));
  const recentRuns: SyncRunRow[] = ((runR!.results ?? []) as unknown as RunRow[]).map((r) => ({
    kind: r.kind,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ok: r.ok === null ? null : r.ok === 1,
    events: r.events,
    message: r.message,
  }));

  return {
    ...toSummary(row),
    createdAt: row.created_at,
    keyHint: row.key_hint,
    config: parseConfig(row.config),
    currency,
    snapshots,
    recentRuns,
  };
}
