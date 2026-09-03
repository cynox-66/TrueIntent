/**
 * Applies pending migrations. `--reset` drops everything first.
 *
 * `--reset` is refused when NODE_ENV is production: a convenience flag that can
 * destroy a real ledger is not a convenience.
 */

import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, runMigrations } from '@capturelock/persistence';

/**
 * Migrations live in source, not in `dist`.
 *
 * `tsc` copies `.ts` output only, so a path resolved relative to the compiled
 * runner would point at an empty directory. Naming the source directory here
 * keeps the runner honest about where the SQL actually is.
 */
const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'persistence',
  'src',
  'postgres',
  'migrations',
);

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined) {
    console.error('DATABASE_URL is not set. Start Postgres with `pnpm db:up`.');
    process.exit(1);
  }

  const reset = process.argv.includes('--reset');
  if (reset && process.env['NODE_ENV'] === 'production') {
    console.error('Refusing to --reset in production.');
    process.exit(1);
  }

  const db = new Database({ connectionString });
  try {
    if (reset) {
      await db.reset();
      console.info('Dropped all CaptureLock tables.');
    }
    const result = await runMigrations(db, MIGRATIONS);
    for (const name of result.alreadyApplied) console.info(`  = ${name} (already applied)`);
    for (const name of result.applied) console.info(`  + ${name}`);
    console.info(
      result.applied.length === 0
        ? 'Schema is up to date.'
        : `Applied ${result.applied.length} migration(s).`,
    );
  } finally {
    await db.close();
  }
}

void main();
