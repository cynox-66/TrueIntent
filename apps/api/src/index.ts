import 'dotenv/config';
import { buildServer } from './server.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';

async function main() {
  const server = await buildServer({ logger: true });

  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`CaptureLock API listening on http://${HOST}:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Only execute when run directly
if (process.env['NODE_ENV'] !== 'test') {
  main();
}
