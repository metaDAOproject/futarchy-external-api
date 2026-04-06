import { logger } from '../../../../utils/logger.js';
import type { DbRuntime } from '../dbRuntime.js';
import type { DailyVolumeRecord, TokenVolumeAggregate, Rolling24hMetrics } from '../../../databaseService.js';

export function createDailyVolumesRepo(db: DbRuntime) {
  return {
    /**
     * Get the latest date we have data for (across all tokens)
     */
    async getLatestDate(): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT MAX(date) as latest_date FROM daily_volumes'
        );
        return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
      } catch (error: any) {
        logger.error('[Database] Error getting latest date:', error);
        return null;
      }
    },

    /**
     * Get the latest date for a specific token
     */
    async getLatestDateForToken(token: string): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT MAX(date) as latest_date FROM daily_volumes WHERE token = $1',
          [token]
        );
        return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
      } catch (error: any) {
        logger.error('[Database] Error getting latest date for token:', error);
        return null;
      }
    },

    /**
     * Upsert daily volume records using batched inserts for performance
     */
    async upsertDailyVolumes(records: DailyVolumeRecord[]): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected() || records.length === 0) return 0;

      const BATCH_SIZE = 500; // Insert 500 records per batch
      let totalUpserted = 0;

      try {
        const client = await pool.connect();

        try {
          await client.query('BEGIN');

          // Process in batches
          for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE);
            
            // Build multi-value INSERT statement
            const values: any[] = [];
            const valuePlaceholders: string[] = [];
            
            batch.forEach((record, idx) => {
              const offset = idx * 6; // 6 parameters per record
              valuePlaceholders.push(
                `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, CURRENT_TIMESTAMP)`
              );
              values.push(
                record.token,
                record.date,
                record.base_volume,
                record.target_volume,
                record.high,
                record.low
              );
            });

            const batchSQL = `
              INSERT INTO daily_volumes (token, date, base_volume, target_volume, high, low, updated_at)
              VALUES ${valuePlaceholders.join(', ')}
              ON CONFLICT (token, date) 
              DO UPDATE SET 
                -- Only update if existing values are NULL or 0 (preserve existing data)
                base_volume = COALESCE(NULLIF(daily_volumes.base_volume, 0), EXCLUDED.base_volume),
                target_volume = COALESCE(NULLIF(daily_volumes.target_volume, 0), EXCLUDED.target_volume),
                high = GREATEST(COALESCE(daily_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
                low = LEAST(
                  CASE WHEN daily_volumes.low > 0 THEN daily_volumes.low ELSE EXCLUDED.low END,
                  CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE daily_volumes.low END
                ),
                updated_at = CURRENT_TIMESTAMP
            `;

            await client.query(batchSQL, values);
            totalUpserted += batch.length;
            
            // Log progress for large batches
            if (records.length > BATCH_SIZE) {
              logger.info(`[Database] Daily volume batch progress: ${totalUpserted}/${records.length}`);
            }
          }

          await client.query('COMMIT');
          logger.info(`[Database] Upserted ${totalUpserted} daily volume records`);
          return totalUpserted;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error: any) {
        logger.error('[Database] Error upserting daily volumes:', error);
        return 0;
      }
    },

    /**
     * Get all daily volumes for a token
     */
    async getDailyVolumesForToken(token: string): Promise<DailyVolumeRecord[]> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

      try {
        const result = await pool.query(
          `SELECT token, date::text, 
                  base_volume::text, target_volume::text, 
                  high::text, low::text
           FROM daily_volumes 
           WHERE token = $1 
           ORDER BY date ASC`,
          [token]
        );
        return result.rows;
      } catch (error: any) {
        logger.error('[Database] Error getting daily volumes for token:', error);
        return [];
      }
    },

    /**
     * Get daily volumes for multiple tokens
     */
    async getDailyVolumesForTokens(tokens: string[]): Promise<Map<string, DailyVolumeRecord[]>> {
      const pool = db.getPool();
      if (!pool || !db.isConnected() || tokens.length === 0) {
        return new Map();
      }

      try {
        const placeholders = tokens.map((_, i) => `$${i + 1}`).join(', ');
        const result = await pool.query(
          `SELECT token, date::text, 
                  base_volume::text, target_volume::text, 
                  high::text, low::text
           FROM daily_volumes 
           WHERE token IN (${placeholders})
           ORDER BY token, date ASC`,
          tokens
        );

        const tokenMap = new Map<string, DailyVolumeRecord[]>();
        for (const row of result.rows) {
          if (!tokenMap.has(row.token)) {
            tokenMap.set(row.token, []);
          }
          tokenMap.get(row.token)!.push(row);
        }
        return tokenMap;
      } catch (error: any) {
        logger.error('[Database] Error getting daily volumes for tokens:', error);
        return new Map();
      }
    },

    /**
     * Get aggregated volume data for all tokens (for API responses)
     */
    async getAggregatedVolumes(tokens?: string[]): Promise<TokenVolumeAggregate[]> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

      try {
        let whereClause = '';
        let params: string[] = [];

        if (tokens && tokens.length > 0) {
          const placeholders = tokens.map((_, i) => `$${i + 1}`).join(', ');
          whereClause = `WHERE token IN (${placeholders})`;
          params = [...tokens];
        }

        // Get aggregates
        const aggregateResult = await pool.query(
          `SELECT 
            token,
            MIN(date)::text as first_trade_date,
            MAX(date)::text as last_trade_date,
            SUM(base_volume)::text as total_base_volume,
            SUM(target_volume)::text as total_target_volume,
            MAX(high)::text as all_time_high,
            MIN(CASE WHEN low > 0 THEN low END)::text as all_time_low,
            COUNT(*)::int as trading_days
           FROM daily_volumes
           ${whereClause}
           GROUP BY token
           ORDER BY SUM(base_volume) DESC`,
          params
        );

        // Get daily data for each token
        const dailyDataMap = await this.getDailyVolumesForTokens(
          aggregateResult.rows.map((r: any) => r.token)
        );

        return aggregateResult.rows.map((row: any) => ({
          token: row.token,
          first_trade_date: row.first_trade_date,
          last_trade_date: row.last_trade_date,
          total_base_volume: row.total_base_volume || '0',
          total_target_volume: row.total_target_volume || '0',
          all_time_high: row.all_time_high || '0',
          all_time_low: row.all_time_low || '0',
          trading_days: row.trading_days,
          daily_data: dailyDataMap.get(row.token) || [],
        }));
      } catch (error: any) {
        logger.error('[Database] Error getting aggregated volumes:', error);
        return [];
      }
    },

    /**
     * Get 24h rolling volume data (last 24 hours from current time)
     * This queries data from today and yesterday to cover the 24h window
     */
    async get24hVolumes(tokens?: string[]): Promise<Map<string, { base_volume: string; target_volume: string; high: string; low: string }>> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return new Map();

      try {
        // Get today and yesterday's date
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        let whereClause = 'WHERE date >= $1';
        let params: any[] = [yesterday];

        if (tokens && tokens.length > 0) {
          const placeholders = tokens.map((_, i) => `$${i + 2}`).join(', ');
          whereClause += ` AND token IN (${placeholders})`;
          params = [yesterday, ...tokens];
        }

        const result = await pool.query(
          `SELECT 
            token,
            SUM(base_volume)::text as base_volume,
            SUM(target_volume)::text as target_volume,
            MAX(high)::text as high,
            MIN(CASE WHEN low > 0 THEN low END)::text as low
           FROM daily_volumes
           ${whereClause}
           GROUP BY token`,
          params
        );

        const volumeMap = new Map();
        for (const row of result.rows) {
          volumeMap.set(row.token, {
            base_volume: row.base_volume || '0',
            target_volume: row.target_volume || '0',
            high: row.high || '0',
            low: row.low || '0',
          });
        }
        return volumeMap;
      } catch (error: any) {
        logger.error('[Database] Error getting 24h volumes:', error);
        return new Map();
      }
    },

    /**
     * Get total daily volume record count
     */
    async getRecordCount(): Promise<number> {
      return this.getDailyRecordCount();
    },

    /**
     * Get total daily volume record count
     */
    async getDailyRecordCount(): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query('SELECT COUNT(*) as count FROM daily_volumes');
        return parseInt(result.rows[0]?.count || '0');
      } catch (error: any) {
        logger.error('[Database] Error getting daily record count:', error);
        return 0;
      }
    },

    /**
     * Get unique token count
     */
    async getTokenCount(): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query('SELECT COUNT(DISTINCT token) as count FROM daily_volumes');
        return parseInt(result.rows[0]?.count || '0');
      } catch (error: any) {
        logger.error('[Database] Error getting token count:', error);
        return 0;
      }
    },

    /**
     * Get rolling 24h metrics from v06_spot_ohlcv_1m table.
     * Used when USE_DUNE_DATA=false to source FutarchyAMM volume from the v0.6 indexer.
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

    /**
     * Get the first trade date for each token (when trading started)
     * Returns a Map of token address -> first trade date (YYYY-MM-DD)
     */
    async getFirstTradeDates(): Promise<Map<string, string>> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return new Map();

      try {
        const result = await pool.query(
          `SELECT token, MIN(date)::text AS first_date
           FROM daily_buy_sell_volumes
           GROUP BY token`
        );

        const map = new Map<string, string>();
        for (const row of result.rows) {
          map.set(row.token, row.first_date);
        }
        return map;
      } catch (error: any) {
        logger.error('[Database] Error getting first trade dates:', error);
        return new Map();
      }
    },
  };
}

export type DailyVolumesRepo = ReturnType<typeof createDailyVolumesRepo>;
