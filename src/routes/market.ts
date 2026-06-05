import { Router, type Request, type Response } from 'express';
import { parseDateParam, parseCommaSeparatedList } from '../utils/validation.js';
import type { ServiceGetters } from './types.js';

export function createMarketRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getDatabaseService, getExternalDatabaseService } = services;

  // Get daily market data with date range and optional token filtering.
  // FutarchyAMM rows are sourced from the v0.6 indexer aggregate table.
  router.get('/api/market-data', async (req: Request, res: Response) => {
    const databaseService = getDatabaseService();
    
    if (!databaseService || !databaseService.isAvailable()) {
      return res.status(503).json({
        error: 'Database not available',
        message: 'Service is initializing or database is not connected',
      });
    }

    // Validate date parameters
    const startDateResult = parseDateParam(req.query.startDate as string, 'startDate', { required: true });
    if (!startDateResult.success) {
      return res.status(400).json(startDateResult.error);
    }
    
    const endDateResult = parseDateParam(req.query.endDate as string, 'endDate', { required: true });
    if (!endDateResult.success) {
      return res.status(400).json(endDateResult.error);
    }
    
    // Validate tokens list
    const tokensResult = parseCommaSeparatedList(req.query.tokens as string, 'tokens');
    if (!tokensResult.success) {
      return res.status(400).json(tokensResult.error);
    }

    try {
      const queryOptions = {
        tokens: tokensResult.value,
        startDate: startDateResult.value!,
        endDate: endDateResult.value!,
      };

      // Meteora rows are served directly from our meteora accounting ETL
      // (futarchy.meteora_daily in the served DB, via externalDatabase).
      const externalDatabaseService = getExternalDatabaseService();

      const [futarchyData, meteoraData] = await Promise.all([
        databaseService.getDailyTradingActivity(queryOptions),
        externalDatabaseService?.isAvailable()
          ? externalDatabaseService.getDailyMeteoraVolumes(queryOptions)
          : Promise.resolve([]),
      ]);

      res.json({
        filters: {
          tokens: tokensResult.value || 'all',
          startDate: startDateResult.value,
          endDate: endDateResult.value,
        },
        source: 'v06-indexer',
        futarchyAMM: {
          count: futarchyData.length,
          data: futarchyData,
        },
        meteora: {
          source: 'etl-meteora-daily',
          count: meteoraData.length,
          data: meteoraData,
        },
      });
    } catch (error: any) {
      res.status(500).json({
        error: 'Failed to get market data',
        message: error.message,
      });
    }
  });

  return router;
}
