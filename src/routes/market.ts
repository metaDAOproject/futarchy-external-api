import { Router, type Request, type Response } from 'express';
import { parseDateParam, parseCommaSeparatedList } from '../utils/validation.js';
import { config } from '../config.js';
import type { ServiceGetters } from './types.js';

export function createMarketRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getDatabaseService } = services;

  // Get daily market data with date range and optional token filtering
  // When USE_DUNE_DATA=false, sources from v0.6 indexer aggregate table;
  // otherwise uses the Dune-sourced daily_volumes table.
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

      const useV06 = !config.useDuneData;

      const [futarchyData, meteoraData] = await Promise.all([
        useV06
          ? databaseService.getDailyTradingActivity(queryOptions)
          : databaseService.getDailyBuySellVolumes(queryOptions),
        databaseService.getDailyMeteoraVolumes(queryOptions),
      ]);
      
      res.json({
        filters: {
          tokens: tokensResult.value || 'all',
          startDate: startDateResult.value,
          endDate: endDateResult.value,
        },
        source: useV06 ? 'v06-indexer' : 'dune',
        futarchyAMM: {
          count: futarchyData.length,
          data: futarchyData,
        },
        meteora: {
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
