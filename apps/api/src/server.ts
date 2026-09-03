import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

export interface ServerOptions {
  logger?: boolean;
}

/**
 * Builds and configures the Fastify server instance.
 */
export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  await app.register(cors, {
    origin: true,
  });

  // Root endpoint
  app.get('/', async () => {
    return {
      service: 'capturelock-api',
      version: '0.0.1',
      phase: 'Phase 0 - Environment Bootstrap',
      documentation: '/docs',
    };
  });

  // Healthcheck endpoint
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'capturelock-api',
      environment: process.env['NODE_ENV'] ?? 'development',
      timestamp: new Date().toISOString(),
    };
  });

  return app;
}
