import { createApp } from './app.js';
import { config } from './config.js';
import { closeDataStores, createServices, initializeRuntimeDataStores } from './runtime/services.js';
import { startHeartbeat } from './runtime/heartbeat.js';
import { logger } from './utils/logger.js';
import { startDraining } from './routes/health.js';
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

    if (!config.metrics.token) {
      logger.warn('METRICS_TOKEN is not set: /metrics is publicly readable. Set it and give your Prometheus scraper the bearer token.');
    }
  });

  // Backstop only: the request-timeout middleware answers 503 at
  // requestTimeout; this closes sockets that stay silent a little longer.
  // 0 keeps meaning "no timeout".
  server.timeout = config.server.requestTimeout === 0 ? 0 : config.server.requestTimeout + 5_000;
  server.keepAliveTimeout = config.server.keepAliveTimeout;
  server.headersTimeout = config.server.keepAliveTimeout + 1000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down API gracefully`);

    heartbeat?.stop();

    // Order matters:
    // 1. Report not-ready and keep serving for shutdownDrainMs, so the load
    //    balancer stops routing here before the listener closes (closing at
    //    once refuses requests still being routed to this container).
    // 2. Stop accepting requests and drain in-flight ones.
    // 3. Close the DB pools last — closing them first fails in-flight requests.
    startDraining();
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, config.server.shutdownDrainMs + SHUTDOWN_TIMEOUT_MS);

    setTimeout(() => closeServer(forceExit), config.server.shutdownDrainMs);
  };

  const closeServer = (forceExit: ReturnType<typeof setTimeout>): void => {
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
