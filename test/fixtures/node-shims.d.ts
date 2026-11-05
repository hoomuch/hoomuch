// Minimal ambient types for the Node built-ins the Data Plane tests use (the project has no @types/node).

declare module 'node:sqlite' {
  type SQLValue = null | number | bigint | string | Uint8Array;
  interface RunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    all(...params: SQLValue[]): Record<string, SQLValue>[];
    get(...params: SQLValue[]): Record<string, SQLValue> | undefined;
    run(...params: SQLValue[]): RunResult;
    columns(): Array<{ name: string }>;
  }
  export class DatabaseSync {
    constructor(path: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

// Vite's `?raw` import suffix (used to load migrations/*.sql in tests).
declare module '*?raw' {
  const content: string;
  export default content;
}
