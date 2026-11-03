import type { Request } from 'express';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';
import type { ExternalDatabaseService } from '../services/externalDatabaseService.js';
import { sendAlert } from '../utils/alerts.js';
import { logger } from '../utils/logger.js';

const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * The served DB for a feed that reports rolling-24h volume (/api/tickers,
 * /cmc/summary, /cmc/ticker), or a 503 when its numbers can't be trusted:
 *
 * - SERVED_DB_UNAVAILABLE: not connected — reporting zero volume would be a
 *   false financial claim.
 * - SERVED_DATA_STALE: connected, but the newest FutarchyAMM spot swap (the
 *   source of these feeds' volume, not Meteora) is older than
 *   SERVED_DATA_MAX_AGE_SECONDS. A stalled ETL otherwise reads as a market
 *   whose 24h volume drains to zero; a 503 makes pollers keep their last good
 *   data instead. A failed freshness query propagates as a 5xx.
 */
export async function requireFreshServedDb(
  externalDatabaseService: ExternalDatabaseService | null,
  req: Request,
  feed: string,
): Promise<ExternalDatabaseService> {
  if (!externalDatabaseService?.isAvailable()) {
    logger.warn('Served database unavailable', { requestId: req.requestId, feed });
    sendAlert(`Served database unavailable for ${feed} — refusing to report zero volume`, {
      cooldownKey: `${feed}-served-db-unavailable`,
      cooldownMs: ALERT_COOLDOWN_MS,
    });
    throw AppError.serviceUnavailable('Served database not available', 'SERVED_DB_UNAVAILABLE');
  }

  const maxAgeSeconds = config.externalDatabase.maxDataAgeSeconds;
  if (maxAgeSeconds > 0) {
    const { ageSeconds, latestSwapAt } = await externalDatabaseService.getFutarchySpotFreshness();
    if (ageSeconds === null || ageSeconds > maxAgeSeconds) {
      logger.warn('Served data is stale; refusing to serve 24h volume', { requestId: req.requestId, feed, ageSeconds, latestSwapAt });
      sendAlert(
        `Served data is stale for ${feed} (newest swap ${latestSwapAt ?? 'missing'}, threshold ${Math.round(maxAgeSeconds / 60)}min) — serving 503 instead of draining volume`,
        { cooldownKey: `${feed}-served-data-stale`, cooldownMs: ALERT_COOLDOWN_MS },
      );
      throw AppError.serviceUnavailable('Served market data is stale', 'SERVED_DATA_STALE');
    }
  }

  return externalDatabaseService;
}
