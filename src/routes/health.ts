import { Router, type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';
import type { ServiceGetters } from './types.js';
import type { ServedDataFreshness } from '../services/externalDatabaseService.js';

export function createHealthRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getExternalDatabaseService } = services;

  // Liveness: is the process up? Never touches a dependency.
  router.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Readiness / comprehensive health. The served (external) ETL DB is the
  // API's only data dependency, so health is modeled on its three axes:
  // connectivity, data contract, and data freshness.
  router.get('/api/health', async (req: Request, res: Response) => {
    const externalDatabaseService = getExternalDatabaseService();
    const connected = !!externalDatabaseService?.isAvailable();

    const servedDataContract = connected
      ? await externalDatabaseService!.checkServedDataContract()
      : {
          ok: false,
          checkedAt: new Date().toISOString(),
          missing: ['connection'],
        };

    let freshness: ServedDataFreshness | null = null;
    let freshnessError = false;
    if (connected) {
      try {
        freshness = await externalDatabaseService!.getServedDataFreshness();
      } catch (error) {
        freshnessError = true;
        logger.error('Health: served DB freshness check failed', error, { requestId: req.requestId });
      }
    }

    const health: Record<string, any> = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      servedDatabase: {
        connected,
        servedDataContract,
        freshness,
      },
    };

    if (!connected) {
      health.status = 'degraded';
      health.message = 'Served (external) indexer database not connected';
    } else if (!servedDataContract.ok) {
      health.status = 'degraded';
      health.message = 'Served ETL contract check failed';
    } else if (freshnessError) {
      health.status = 'degraded';
      health.message = 'Served DB freshness check failed';
    }

    res.json(health);
  });

  return router;
}
