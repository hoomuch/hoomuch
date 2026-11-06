// Minimal ambient types for the Node built-ins the read-model benchmark uses (the project has no
// @types/node; node:sqlite comes from test/fixtures/node-shims.d.ts).

declare module 'node:child_process' {
  export function execSync(command: string, options?: { encoding: 'utf8' }): string;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
}

declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  stdout: { write(s: string): boolean };
};
