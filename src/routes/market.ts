import { Router, type Request, type Response } from 'express';
import { parseDateParam, parseCommaSeparatedList, parseSolanaAddress, orBadRequest } from '../utils/validation.js';
import { AppError, asyncHandler } from '../middleware/errorHandler.js';
import type { ServiceGetters } from './types.js';
import { config } from '../config.js';

// Bounds the `token = ANY($1)` list a single request can send to the served DB.
const MAX_TOKENS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createMarketRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getExternalDatabaseService } = services;

  // Daily market data with date range + optional token filtering.
  // BOTH FutarchyAMM and Meteora are served from the unified user_pool ETL in
  // the served DB (futarchy.user_pool_daily), via externalDatabase.
  router.get('/api/market-data', asyncHandler(async (req: Request, res: Response) => {
    // Validate client input BEFORE touching the served DB, so a malformed/missing
    // parameter always returns a 400 — independent of DB state. (Checking DB
    // availability first would turn a client error into a 503 during an outage.)
    const startDate = orBadRequest(parseDateParam(req.query.startDate as string, 'startDate', { required: true }))!;
    const endDate = orBadRequest(parseDateParam(req.query.endDate as string, 'endDate', { required: true }))!;
    if (startDate > endDate) {
      throw AppError.badRequest('startDate must be on or before endDate', 'INVALID_QUERY_PARAMETER', 'startDate');
    }
    const maxDays = config.marketData.maxRangeDays;
    const rangeDays = (Date.parse(endDate) - Date.parse(startDate)) / DAY_MS + 1;
    if (maxDays > 0 && rangeDays > maxDays) {
      throw AppError.badRequest(
        `Date range spans ${rangeDays} days; at most ${maxDays} are allowed per request — split it into smaller ranges`,
        'INVALID_QUERY_PARAMETER',
        'endDate',
      );
    }

    const rawTokens = req.query.tokens as string | undefined;
    const tokens = orBadRequest(parseCommaSeparatedList(rawTokens, 'tokens', { maxLength: MAX_TOKENS }));
    // A blank `tokens=` still means "all tokens"; a non-blank list with no
    // entries (`tokens=,,`) must not silently widen to every token.
    if (rawTokens?.trim() && !tokens) {
      throw AppError.badRequest('tokens must contain at least one mint address', 'INVALID_QUERY_PARAMETER', 'tokens');
    }
    // Tokens are base mints; anything else can only ever match nothing, so
    // reject it instead of answering a typo with a silent empty 200.
    for (const token of tokens ?? []) orBadRequest(parseSolanaAddress(token, 'tokens'));

    // The served DB is the source of truth for market data; surface its absence/failure
    // rather than masking it as empty (a financial feed must never read a DB outage as
    // "zero volume"). Query failures propagate to the error handler as a generic 500.
    const externalDatabaseService = getExternalDatabaseService();
    if (!externalDatabaseService?.isAvailable()) {
      throw AppError.serviceUnavailable('Served database not available', 'SERVED_DB_UNAVAILABLE');
    }

    const queryOptions = { tokens, startDate, endDate };
    const [futarchyData, meteoraData] = await Promise.all([
      externalDatabaseService.getFutarchyAmmDailyActivity(queryOptions),
      externalDatabaseService.getDailyMeteoraVolumes(queryOptions),
    ]);

    res.json({
      filters: {
        tokens: tokens || 'all',
        startDate,
        endDate,
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
  }));

  return router;
}
