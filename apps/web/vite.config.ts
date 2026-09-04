import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The console is a browser app inside a Node monorepo, so it resolves the
 * workspace by path rather than by package entry point.
 *
 * `@capturelock/core/reason-codes` is a deliberate deep import. That module is
 * dependency-free — a frozen table of the 79 reason codes with their stage,
 * severity and description — so the console can explain a refusal using the
 * same text the kernel documents, instead of a second hand-written glossary
 * that would drift. Importing the package root instead would drag zod and
 * node:crypto into the bundle for no benefit.
 *
 * `@capturelock/api-contracts` is type-only and erases at build time; nothing
 * from the API is bundled.
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
  server: {
    port: 5173,
    // The API sets permissive CORS, but proxying keeps the operator key on a
    // same-origin request and means no API base URL has to be configured.
    proxy: {
      '/v1': {
        target: process.env['CAPTURELOCK_API'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
      '/health': {
        target: process.env['CAPTURELOCK_API'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
