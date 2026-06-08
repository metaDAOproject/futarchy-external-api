import { Router, type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';
import type { ServiceGetters } from './types.js';

export function createHealthRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getDatabaseService, getExternalDatabaseService } = services;

  // Basic health check
  router.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Comprehensive health check
  router.get('/api/health', async (req: Request, res: Response) => {
    const databaseService = getDatabaseService();
    const externalDatabaseService = getExternalDatabaseService();
    // The served (external) indexer DB now backs Meteora, tickers, DexScreener and
    // first-trade-dates — it's a core dependency, so health must reflect it.
    const externalConnected = !!externalDatabaseService?.isAvailable();
    const servedDataContract = externalConnected
      ? await externalDatabaseService!.checkServedDataContract()
      : {
          ok: false,
          checkedAt: new Date().toISOString(),
          missing: ['connection'],
        };

    const health: Record<string, any> = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {},
      database: {
        connected: databaseService.isAvailable(),
      },
      externalDatabase: {
        connected: externalConnected,
        servedDataContract,
      },
    };

    const hasUnhealthyService = Object.values(health.services).some(
      (s: any) => s.initialized === false
    );

    if (!databaseService.isAvailable()) {
      health.status = 'degraded';
      health.message = 'App database not connected';
    } else if (!externalConnected) {
      health.status = 'degraded';
      health.message = 'Served (external) indexer database not connected';
    } else if (!servedDataContract.ok) {
      health.status = 'degraded';
      health.message = 'Served ETL contract check failed';
    } else if (hasUnhealthyService) {
      health.status = 'degraded';
      health.message = 'One or more services not initialized';
    }

    res.json(health);
  });

  // Health history
  router.get('/api/health/history', async (req: Request, res: Response) => {
    const databaseService = getDatabaseService();
    
    if (!databaseService.isAvailable()) {
      return res.status(503).json({
        error: 'Database not connected',
        message: 'Health history requires database connection',
      });
    }

    try {
      const serviceName = req.query.service as string | undefined;
      const hours = parseInt(req.query.hours as string) || 24;

      const data = await databaseService.getServiceHealthHistory(serviceName, hours);
      
      res.json({
        service: serviceName || 'all',
        hours,
        count: data.length,
        data,
      });
    } catch (error: any) {
      logger.error('Failed to get health history', error, { requestId: req.requestId });
      res.status(500).json({
        error: 'Failed to get health history',
        requestId: req.requestId,
      });
    }
  });

  // Manual health snapshot trigger
  router.post('/api/health/snapshot', async (req: Request, res: Response) => {
    const databaseService = getDatabaseService();
    
    if (!databaseService.isAvailable()) {
      return res.status(503).json({
        error: 'Database not connected',
      });
    }

    try {
      await saveHealthSnapshots(services);
      res.json({ message: 'Health snapshot saved successfully' });
    } catch (error: any) {
      logger.error('Failed to save health snapshot', error, { requestId: req.requestId });
      res.status(500).json({
        error: 'Failed to save health snapshot',
        requestId: req.requestId,
      });
    }
  });

  return router;
}

// Helper function to save health snapshots
export async function saveHealthSnapshots(services: ServiceGetters): Promise<void> {
  const databaseService = services.getDatabaseService();

  if (!databaseService.isAvailable()) return;

  // The Dune-sourced volume tables were removed; there are no per-table record
  // counts to snapshot here anymore. DB connectivity is reported via /api/health.
}
