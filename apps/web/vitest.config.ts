import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The console's tests.
 *
 * Kept in their own config because they need a DOM, while the rest of the
 * repository's suite is deliberately node-only. `pnpm test` runs both.
 *
 * Every test stubs `fetch` and asserts on what the component did with the
 * response. Nothing here talks to a real API, and no production code path has a
 * fixture behind it — the mocks live only in these files.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@capturelock/core/reason-codes': path.resolve(
        here,
        '../../packages/core/src/reason-codes.ts',
      ),
      '@capturelock/api-contracts': path.resolve(here, '../api/src/routes/contracts.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    root: here,
  },
});
