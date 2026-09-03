import 'dotenv/config';
import { buildApplication } from './composition.js';
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
      'CaptureLock API listening',
    );
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

if (process.env['NODE_ENV'] !== 'test') {
  void main();
}
