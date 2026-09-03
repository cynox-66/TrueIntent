import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    // Database-backed tests are opt-in: `pnpm test` must run offline and
    // deterministically. `pnpm test:db` runs them against a real Postgres.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.test.ts'],
  },
  resolve: {
    alias: {
      '@capturelock/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@capturelock/policy': path.resolve(__dirname, './packages/policy/src/index.ts'),
      '@capturelock/evidence': path.resolve(__dirname, './packages/evidence/src/index.ts'),
      '@capturelock/integrations': path.resolve(__dirname, './packages/integrations/src/index.ts'),
      '@capturelock/kernel': path.resolve(__dirname, './packages/kernel/src/index.ts'),
      '@capturelock/persistence': path.resolve(__dirname, './packages/persistence/src/index.ts'),
    },
  },
});
