/**
 * In-memory D1 for tests (Data Plane): the real migration on Node's built-in SQLite.
 * Implements the subset of D1Database the app uses — prepare/bind/first/all/run/raw, batch, exec —
 * with D1's semantics where they matter: foreign keys ON, `undefined` binds rejected,
 * booleans stored as 0/1, `batch` atomic.
 *
 *   const { db, rows } = createTestD1();
 *   const env = testEnv(db);
 *   rows('SELECT * FROM snapshots');
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import schema from '../../migrations/0001_init.sql?raw';
import currencySource from '../../migrations/0002_currency_source.sql?raw';
import providerIds from '../../migrations/0003_provider_ids.sql?raw';
import type { Bindings } from '../../src/env';

type Bindable = null | number | bigint | string | Uint8Array;

function toBindable(v: unknown, i: number): Bindable {
  if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for parameter ${i + 1}`);
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for parameter ${i + 1}`);
}

const plain = (r: Record<string, unknown>) => ({ ...r });

class TestStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    private readonly params: Bindable[] = [],
  ) {}

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.sqlite, this.sql, values.map(toBindable));
  }

  private stmt(): StatementSync {
    return this.sqlite.prepare(this.sql);
  }

  /** Synchronous execution shared by run/all/batch. */
  execute(): { results: Record<string, unknown>[]; changes: number; lastRowId: number } {
    const s = this.stmt();
    if (s.columns().length > 0) {
      return { results: s.all(...this.params).map(plain), changes: 0, lastRowId: 0 };
    }
    const r = s.run(...this.params);
    return { results: [], changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.stmt().get(...this.params);
    if (!row) return null;
    if (column) return ((row as Record<string, unknown>)[column] ?? null) as T;
    return plain(row) as T;
  }

  async all<T = Record<string, unknown>>() {
    const { results } = this.execute();
    return { results: results as T[], success: true, meta: { changes: 0, duration: 0 } };
  }

  async run() {
    const r = this.execute();
    return {
      results: r.results,
      success: true,
      meta: { changes: r.changes, last_row_id: r.lastRowId, changed_db: r.changes > 0, duration: 0 },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.execute().results.map((r) => Object.values(r)) as T[];
  }
}

export interface TestD1 {
  db: D1Database;
  sqlite: DatabaseSync;
  /** Synchronous SELECT helper for assertions. */
  rows: <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => T[];
  /** Synchronous write helper for seeding. */
  exec: (sql: string, ...params: unknown[]) => void;
  /** Number of D1 calls made through `db` (round trips; a batch counts once). */
  roundTrips: () => number;
}

export function createTestD1(): TestD1 {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(schema);
  sqlite.exec(currencySource);
  sqlite.exec(providerIds);
  let trips = 0;

  const countTrip = <T extends object>(stmt: TestStatement): T => {
    return new Proxy(stmt, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === 'bind') return (...a: unknown[]) => countTrip(target.bind(...a));
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
          return (...a: unknown[]) => {
            trips++;
            return (v as (...x: unknown[]) => unknown).apply(target, a);
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as unknown as T;
  };

  const db = {
    prepare: (sql: string) => countTrip(new TestStatement(sqlite, sql)),
    async batch(statements: TestStatement[]) {
      trips++;
      sqlite.exec('BEGIN');
      try {
        const out = statements.map((s) => {
          const r = (s as TestStatement).execute();
          return { results: r.results, success: true, meta: { changes: r.changes, last_row_id: r.lastRowId, duration: 0 } };
        });
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql: string) {
      trips++;
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    withSession() {
      return db;
    },
    dump() {
      throw new Error('not supported in tests');
    },
  };

  return {
    db: db as unknown as D1Database,
    sqlite,
    rows: <T,>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params.map(toBindable)).map(plain) as T[],
    exec: (sql: string, ...params: unknown[]) => {
      sqlite.prepare(sql).run(...params.map(toBindable));
    },
    roundTrips: () => trips,
  };
}

/** 32 zero-to-31 bytes, base64 — a valid ENCRYPTION_KEY for tests. */
export const TEST_ENCRYPTION_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

export function testEnv(db: D1Database, overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: db,
    ASSETS: {} as Fetcher,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    APP_NAME: 'hoomuch',
    ALLOW_SIGNUP: 'true',
    SYNC_INTERVAL_MINUTES: '60',
    ...overrides,
  };
}

/** Inserts a user and returns its id. */
export function seedUser(t: TestD1, opts: { id?: string; email?: string; baseCurrency?: string } = {}): string {
  const id = opts.id ?? 'user-1';
  t.exec(
    'INSERT INTO users (id, email, password_hash, base_currency, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
    id,
    opts.email ?? `${id}@example.com`,
    'pbkdf2$1$x$y',
    opts.baseCurrency ?? 'USD',
  );
  return id;
}

/** Inserts a connection row (credentials_enc must already be encrypted, or any string if never decrypted). */
export function seedConnection(
  t: TestD1,
  c: {
    id: string;
    userId: string;
    provider: 'stripe' | 'lemonsqueezy' | 'revenuecat' | 'demo';
    name?: string;
    credentialsEnc?: string;
    config?: Record<string, string>;
    status?: 'pending' | 'syncing' | 'ok' | 'error';
    lastSyncedAt?: number | null;
    lastSyncStartedAt?: number | null;
    lastError?: string | null;
    testMode?: boolean;
    createdAt?: number;
  },
): void {
  t.exec(
    `INSERT INTO connections (id, user_id, provider, name, credentials_enc, key_hint, config, test_mode, status,
       last_synced_at, last_sync_started_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id,
    c.userId,
    c.provider,
    c.name ?? c.id,
    c.credentialsEnc ?? 'v1.x.y',
    JSON.stringify(c.config ?? {}),
    c.testMode ? 1 : 0,
    c.status ?? 'ok',
    c.lastSyncedAt ?? null,
    c.lastSyncStartedAt ?? null,
    c.lastError ?? null,
    c.createdAt ?? 0,
    c.createdAt ?? 0,
  );
}
