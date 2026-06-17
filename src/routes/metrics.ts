import { Router, type Request, type Response } from 'express';
import { metricsService } from '../services/metricsService.js';
import type { ServiceGetters } from './types.js';
import { logger } from '../utils/logger.js';

export function createMetricsRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getExternalDatabaseService, getFutarchyService } = services;

  // Refresh scrape-time gauges. The heartbeat keeps these up to date too; this
  // just guarantees a scrape never reads values older than the last heartbeat.
  async function updateMetricsSnapshot(): Promise<void> {
    metricsService.setServedDbConnected(!!getExternalDatabaseService()?.isAvailable());

    try {
      const daos = await getFutarchyService().getAllDaos();
      metricsService.setActiveDaosCount(daos.length);
    } catch {
      // Ignore errors during metrics collection
    }
  }

  // Prometheus metrics endpoint
  router.get('/metrics', async (req: Request, res: Response) => {
    try {
      await updateMetricsSnapshot();

      res.set('Content-Type', metricsService.getContentType());
      res.end(await metricsService.getMetrics());
    } catch (error: any) {
      logger.error('[Metrics] Error generating metrics:', error);
      res.status(500).end('Error generating metrics');
    }
  });

  return router;
}
