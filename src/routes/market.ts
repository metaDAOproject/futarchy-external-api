import { Router, type Request, type Response } from 'express';
import { parseDateParam, parseCommaSeparatedList } from '../utils/validation.js';
import { logger } from '../utils/logger.js';
import type { ServiceGetters } from './types.js';

export function createMarketRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getExternalDatabaseService } = services;

  // Daily market data with date range + optional token filtering.
  // BOTH FutarchyAMM and Meteora are served from the unified user_pool ETL in
  // the served DB (futarchy.user_pool_daily), via externalDatabase.
  // FutarchyAMM no longer reads the flat-0.5% app-DB v06_fee_volume_daily_aggregate.
  router.get('/api/market-data', async (req: Request, res: Response) => {
    // Validate client input BEFORE touching the served DB, so a malformed/missing
    // parameter always returns a 400 — independent of DB state. (Checking DB
    // availability first would turn a client error into a 503 during an outage.)
    const startDateResult = parseDateParam(req.query.startDate as string, 'startDate', { required: true });
    if (!startDateResult.success) {
      return res.status(400).json(startDateResult.error);
    }

    const endDateResult = parseDateParam(req.query.endDate as string, 'endDate', { required: true });
    if (!endDateResult.success) {
      return res.status(400).json(endDateResult.error);
    }

    const tokensResult = parseCommaSeparatedList(req.query.tokens as string, 'tokens');
    if (!tokensResult.success) {
      return res.status(400).json(tokensResult.error);
    }

    // The served DB is the source of truth for market data; surface its absence/failure
    // rather than masking it as empty (a financial feed must never read a DB outage as
    // "zero volume").
    const externalDatabaseService = getExternalDatabaseService();
    if (!externalDatabaseService || !externalDatabaseService.isAvailable()) {
      return res.status(503).json({
        error: 'Served database not available',
        message: 'Market data source (served indexer DB) is not connected',
      });
    }

    try {
      const queryOptions = {
        tokens: tokensResult.value,
        startDate: startDateResult.value!,
        endDate: endDateResult.value!,
      };

      const [futarchyData, meteoraData] = await Promise.all([
        externalDatabaseService.getFutarchyAmmDailyActivity(queryOptions),
        externalDatabaseService.getDailyMeteoraVolumes(queryOptions),
      ]);

      res.json({
        filters: {
          tokens: tokensResult.value || 'all',
          startDate: startDateResult.value,
          endDate: endDateResult.value,
        },
        source: 'user-pool-etl',
        futarchyAMM: {
          source: 'etl-user-pool-daily',
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
      // Log the detail server-side; do NOT return raw error.message to the client
      // (it can leak SQL/schema internals). Mirrors the global errorHandler's
      // generic-500 behavior for unexpected errors.
      logger.error('Failed to get market data', error, { requestId: req.requestId });
      res.status(500).json({
        error: 'Failed to get market data',
        requestId: req.requestId,
      });
    }
  });

  return router;
}
