import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Database-backed suite.
 *
 * Kept entirely separate from the default config so `pnpm test` stays offline
 * and deterministic. These tests need `pnpm db:up` and prove the concurrency
 * properties an in-memory store cannot: partial unique indexes, compare-and-set
 * under real contention, and the append-only triggers.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.db.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // These suites share tables, so they must not run in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@capturelock/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@capturelock/policy': path.resolve(__dirname, './packages/policy/src/index.ts'),
      '@capturelock/evidence': path.resolve(__dirname, './packages/evidence/src/index.ts'),
      '@capturelock/integrations': path.resolve(__dirname, './packages/integrations/src/index.ts'),
      '@capturelock/agent': path.resolve(__dirname, './packages/agent/src/index.ts'),
      '@capturelock/kernel': path.resolve(__dirname, './packages/kernel/src/index.ts'),
      '@capturelock/persistence': path.resolve(__dirname, './packages/persistence/src/index.ts'),
    },
  },
});
