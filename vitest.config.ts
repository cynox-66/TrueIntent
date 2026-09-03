import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  resolve: {
    alias: {
      '@capturelock/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@capturelock/policy': path.resolve(__dirname, './packages/policy/src/index.ts'),
      '@capturelock/evidence': path.resolve(__dirname, './packages/evidence/src/index.ts'),
      '@capturelock/integrations': path.resolve(__dirname, './packages/integrations/src/index.ts'),
    },
  },
});
