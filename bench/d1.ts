/**
 * D1 for the read-model benchmark: the D1Database subset the read models use, over a SQLite file
 * (node:sqlite, the engine D1 runs), counting round trips. Self-contained on purpose: bench/ab.mjs
 * copies bench/ into a checkout of another commit, which may not have the same test fixtures.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

type Bindable = null | number | bigint | string | Uint8Array;

function toBindable(v: unknown, i: number): Bindable {
  if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for parameter ${i + 1}`);
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for parameter ${i + 1}`);
}

export interface BenchD1 {
  db: D1Database;
  /** D1 calls made so far (a batch counts once). */
  roundTrips: () => number;
  /** Time spent per statement (its SQL, whitespace collapsed) since the last call, slowest first. */
  takeProfile: () => Array<{ sql: string; ms: number; calls: number }>;
}

export function benchD1(sqlite: DatabaseSync): BenchD1 {
  let trips = 0;
  const spent = new Map<string, { ms: number; calls: number }>();
  const timed = <T>(sql: string, f: () => T): T => {
    const start = performance.now();
    try {
      return f();
    } finally {
      const e = spent.get(sql) ?? { ms: 0, calls: 0 };
      e.ms += performance.now() - start;
      e.calls++;
      spent.set(sql, e);
    }
  };
  // Prepared once per SQL text, as D1 caches statements.
  const cache = new Map<string, StatementSync>();
  const compiled = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };

  class Statement {
    constructor(
      readonly sql: string,
      private readonly params: Bindable[] = [],
    ) {}
    bind(...values: unknown[]) {
      return new Statement(this.sql, values.map(toBindable));
    }
    execute() {
      return timed(this.sql, () => {
        const s = compiled(this.sql);
        if (s.columns().length > 0) return { results: s.all(...this.params).map((r) => ({ ...r })), changes: 0 };
        return { results: [] as Record<string, unknown>[], changes: Number(s.run(...this.params).changes) };
      });
    }
    async first<T>(column?: string): Promise<T | null> {
      trips++;
      const row = timed(this.sql, () => compiled(this.sql).get(...this.params)) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? (row[column] ?? null) : { ...row }) as T;
    }
    async all<T>() {
      trips++;
      return { results: this.execute().results as T[], success: true, meta: { duration: 0 } };
    }
    async run() {
      trips++;
      const r = this.execute();
      return { results: r.results, success: true, meta: { changes: r.changes, duration: 0 } };
    }
    async raw<T>() {
      trips++;
      return this.execute().results.map((r) => Object.values(r)) as T[];
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      trips++;
      return statements.map((s) => ({ results: s.execute().results, success: true, meta: { duration: 0 } }));
    },
    withSession: () => db,
  };
  return {
    db: db as unknown as D1Database,
    roundTrips: () => trips,
    takeProfile: () => {
      const out = [...spent].map(([sql, e]) => ({ sql: sql.replace(/\s+/g, ' ').trim(), ...e })).sort((a, b) => b.ms - a.ms);
      spent.clear();
      return out;
    },
  };
}
