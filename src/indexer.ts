import { saveHealthSnapshots } from './routes/health.js';
import { createServiceGetters } from './routes/types.js';
import { closeDataStores, createServices, initializeRuntimeDataStores } from './runtime/services.js';
import { logger } from './utils/logger.js';
import { scheduleDailyAtUTC, scheduleWithoutPileup, type ScheduledTask } from './utils/scheduling.js';
import type { Services } from './app.js';

async function startIndexingServices(services: Services): Promise<void> {
  if (services.externalDatabaseService?.isAvailable() && services.v06ReconciliationService) {
    logger.info('Starting v0.6 Reconciliation service');
    services.v06ReconciliationService.start();
    logger.info('v0.6 Reconciliation service started');
  }
}

function startIndexerScheduledTasks(services: Services): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  const serviceGetters = createServiceGetters(services);

  const healthSnapshotTask = scheduleWithoutPileup(
    async () => {
      await saveHealthSnapshots(serviceGetters);
    },
    {
      name: 'IndexerHealthSnapshot',
      intervalMs: 5 * 60 * 1000,
      onError: (error) => logger.error('Error saving indexer health snapshot', error),
    }
  );
  tasks.push(healthSnapshotTask);
  logger.info('Indexer health snapshots scheduled every 5 minutes');

  const metricsPruneTask = scheduleDailyAtUTC(
    async () => {
      if (services.databaseService.isAvailable()) {
        await services.databaseService.pruneOldMetrics(30);
        logger.info('Old metrics pruned (keeping last 30 days)');
      }
    },
    {
      name: 'IndexerMetricsPrune',
      hourUTC: 3,
      onError: (error) => logger.error('Error pruning indexer metrics', error),
    }
  );
  tasks.push(metricsPruneTask);
  logger.info('Indexer metrics pruning scheduled daily at 03:00 UTC');

  return tasks;
}

async function stopIndexingServices(services: Services, scheduledTasks: ScheduledTask[]): Promise<void> {
  scheduledTasks.forEach(task => task.stop());
  services.v06ReconciliationService?.stop();
  await closeDataStores(services);
}

async function main(): Promise<void> {
  const services = createServices('indexer');
  let scheduledTasks: ScheduledTask[] = [];

  await initializeRuntimeDataStores(services, 'Indexer', { ensureAppSchema: true });
  await startIndexingServices(services);
  scheduledTasks = startIndexerScheduledTasks(services);

  const serviceGetters = createServiceGetters(services);
  setTimeout(async () => {
    try {
      await saveHealthSnapshots(serviceGetters);
      logger.info('Initial indexer health snapshot saved');
    } catch (error) {
      logger.error('Error saving initial indexer health snapshot', error);
    }
  }, 10000);

  logger.info('Indexer runtime started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down indexer gracefully`);
    await stopIndexingServices(services, scheduledTasks);
    logger.info('Indexer stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('Failed to start indexer runtime', error);
  process.exit(1);
});
