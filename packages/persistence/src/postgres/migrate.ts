/**
 * Migration runner.
 *
 * Deliberately small: numbered SQL files, applied in order, each inside its own
 * transaction, recorded in `schema_migrations`. No ORM, no DSL, no generated
 * SQL — the security-relevant parts of this schema are a `WHERE` clause on a
 * unique index and a `plpgsql` trigger, and neither is something a generator
 * expresses. They should be readable in one file by anyone auditing the system.
 *
 * Each file is applied inside a transaction that also records the row, so a
 * failure part-way leaves neither a half-applied schema nor a false record of
 * having applied it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './client.js';

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        VARCHAR(128) PRIMARY KEY,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`;

export async function runMigrations(db: Database, directory?: string): Promise<MigrationResult> {
  const dir = directory ?? join(dirname(fileURLToPath(import.meta.url)), 'migrations');

  await db.query(LEDGER);
  const done = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map(r => r.name),
  );

  const files = readdirSync(dir)
    .filter(name => name.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const name of files) {
    if (done.has(name)) {
      alreadyApplied.push(name);
      continue;
    }
    const sql = readFileSync(join(dir, name), 'utf8');
    await db.transaction(async client => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    applied.push(name);
  }

  return { applied, alreadyApplied };
}
