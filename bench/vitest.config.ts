import { defineConfig } from 'vitest/config';

// The read-model benchmark (bench/readmodels.bench.ts). Kept apart from `npm test`: it needs the
// seeded database (bench/README.md) and takes minutes, not seconds.
export default defineConfig({
  resolve: {
    alias: { '@': decodeURIComponent(new URL('../src', import.meta.url).pathname) },
  },
  test: {
    root: decodeURIComponent(new URL('..', import.meta.url).pathname),
    environment: 'node',
    // Exactly this file: bench/.state/ab/ holds another checkout with its own copy (bench/ab.mjs).
    include: ['bench/readmodels.bench.ts'],
    exclude: ['bench/.state/**', 'node_modules/**'],
    testTimeout: 60 * 60_000,
    // One file, one worker: nothing else competes for the CPU while it measures.
    fileParallelism: false,
  },
});
