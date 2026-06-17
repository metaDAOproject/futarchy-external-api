import { createApp } from './app.js';
import { config } from './config.js';
import { closeDataStores, createServices, initializeRuntimeDataStores } from './runtime/services.js';
import { startHeartbeat } from './runtime/heartbeat.js';
import { logger } from './utils/logger.js';
import type { Server } from 'http';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const services = createServices();
  const app = createApp({ services });

  await initializeRuntimeDataStores(services, 'API');

  const heartbeat = startHeartbeat(services);

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

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down API gracefully`);

    heartbeat?.stop();

    // Order matters: stop accepting requests and drain in-flight ones FIRST,
    // close the DB pools after — closing pools first makes every in-flight
    // request fail during a deploy.
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    server.close(() => {
      closeDataStores(services)
        .catch((error) => logger.error('Error closing data stores during shutdown', error))
        .finally(() => {
          clearTimeout(forceExit);
          logger.info('API server closed');
          process.exit(0);
        });
    });

    // Idle keep-alive sockets would otherwise hold close() open for up to
    // keepAliveTimeout (5 min by default).
    server.closeIdleConnections?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('Failed to start API server', error);
  process.exit(1);
});
