import { defineConfig } from 'vitest/config';

// Unit tests run in Node: provider adapters, money math and crypto are pure and
// take an injected `fetch`, so they don't need the Workers runtime.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
