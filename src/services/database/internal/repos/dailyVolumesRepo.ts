import { logger } from '../../../../utils/logger.js';
import type { DbRuntime } from '../dbRuntime.js';
import type { Rolling24hMetrics } from '../../../databaseService.js';

export function createDailyVolumesRepo(db: DbRuntime) {
  return {
    /**
     * Get rolling 24h metrics from v06_spot_ohlcv_1m table.
     * Sources FutarchyAMM rolling-24h volume from the v0.6 indexer.
     * Amounts in this table are raw integers (6 decimals) — caller divides by 1e6.
     */
    async getV06Rolling24hMetrics(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return new Map();

      try {
        const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        let whereClause = 'WHERE bucket >= $1';
        let params: any[] = [cutoffTime];

        if (tokens && tokens.length > 0) {
          const placeholders = tokens.map((_, i) => `$${i + 2}`).join(', ');
          whereClause += ` AND token IN (${placeholders})`;
          params = [cutoffTime, ...tokens];
        }

        const result = await pool.query(
          `SELECT
            token,
            (SUM(base_volume) / 1e6)::text AS base_volume_24h,
            (SUM(target_volume) / 1e6)::text AS target_volume_24h,
            MAX(high)::text AS high_24h,
            MIN(CASE WHEN low > 0 THEN low END)::text AS low_24h,
            SUM(trade_count)::int AS trade_count_24h
           FROM v06_spot_ohlcv_1m
           ${whereClause}
           GROUP BY token`,
          params
        );

        const metricsMap = new Map<string, Rolling24hMetrics>();
        for (const row of result.rows) {
          metricsMap.set(row.token, {
            token: row.token,
            base_volume_24h: row.base_volume_24h || '0',
            target_volume_24h: row.target_volume_24h || '0',
            high_24h: row.high_24h || '0',
            low_24h: row.low_24h || '0',
            trade_count_24h: row.trade_count_24h || 0,
          });
        }
        return metricsMap;
      } catch (error: any) {
        logger.error('[Database] Error getting v0.6 rolling 24h metrics:', error);
        return new Map();
      }
    },
  };
}

export type DailyVolumesRepo = ReturnType<typeof createDailyVolumesRepo>;
