import { loadEnv } from './load-env.js';
import { buildApplication } from './composition.js';

// Before anything reads process.env. See load-env.ts for why this is not
// `import 'dotenv/config'`.
loadEnv();
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { seedDemoData } from './seed.js';
import { startSweepers } from './sweepers.js';

async function main(): Promise<void> {
  // Configuration is validated before anything else is constructed, so a
  // live-mode key, a missing production signing key, or in-memory persistence
  // in production stops the process here rather than surfacing later.
  const config = loadConfig();
  const application = buildApplication(config);
  const server = await buildServer({ logger: true, app: application });

  if (config.nodeEnv !== 'production') {
    const seeded = await seedDemoData(application);
    server.log.info({ ...seeded }, 'seeded demo policy');
  }

  const sweepers = startSweepers(
    application.reconciliationService,
    server.log,
    config.sweepIntervalSeconds,
  );

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down');
    sweepers.stop();
    await server.close();
    await application.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await server.listen({ port: config.port, host: config.host });
    server.log.info(
      {
        persistence: config.persistence,
        paymentProvider: application.providerName,
        url: `http://${config.host}:${config.port}`,
      },
      'TrueIntent API listening',
    );
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

/**
 * Turns a startup failure into a sentence.
 *
 * `void main()` on its own meant any rejection before `listen` — a
 * misconfiguration, an unreachable database, a failed seed — surfaced as an
 * unhandled promise rejection: thirty lines of `AggregateError [ECONNREFUSED]`
 * and a pg-pool stack, with the actual problem ("Postgres is not running")
 * nowhere in the first screen. That is a poor thing to read at any time and a
 * genuinely bad one to read in front of an audience.
 *
 * The stack is still printed after the summary, because the summary is a guess
 * about the common cases and the stack is the truth.
 */
function reportStartupFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;

  console.error('\nCaptureLock failed to start.\n');
  if (code === 'ECONNREFUSED') {
    console.error(
      '  Could not reach the database named by DATABASE_URL.\n' +
        '  Start it with:  pnpm db:up && pnpm db:migrate\n' +
        '  Or run without one:  PERSISTENCE=memory pnpm dev\n',
    );
  } else if (message.includes('relation') && message.includes('does not exist')) {
    console.error('  The database is reachable but has no schema. Run:  pnpm db:migrate\n');
  } else {
    console.error(`  ${message}\n`);
  }
  console.error('Full error follows.\n');
  console.error(error);
  process.exit(1);
}

if (process.env['NODE_ENV'] !== 'test') {
  main().catch(reportStartupFailure);
}
