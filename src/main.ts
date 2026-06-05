import { createApp } from './app.js';
import { config } from './config.js';
import { closeDataStores, createServices, initializeRuntimeDataStores } from './runtime/services.js';
import { logger } from './utils/logger.js';
import type { Server } from 'http';

async function stopApi(services: ReturnType<typeof createServices>): Promise<void> {
  await closeDataStores(services);
}

async function main(): Promise<void> {
  const services = createServices('api');
  const app = createApp({ services });

  await initializeRuntimeDataStores(services, 'API', { ensureAppSchema: false });

  const server: Server = app.listen(config.server.port, () => {
    logger.info('API server started', {
      port: config.server.port,
      tickersUrl: `http://localhost:${config.server.port}/api/tickers`,
      healthUrl: `http://localhost:${config.server.port}/health`,
    });

    logger.info('Trusted API keys loaded', {
      count: config.server.trustedApiKeys.size,
    });
  });

  server.timeout = config.server.requestTimeout;
  server.keepAliveTimeout = config.server.keepAliveTimeout;
  server.headersTimeout = config.server.keepAliveTimeout + 1000;

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down API gracefully`);
    await stopApi(services);
    server.close(() => {
      logger.info('API server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('Failed to start API server', error);
  process.exit(1);
});
