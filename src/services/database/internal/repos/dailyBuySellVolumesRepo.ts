import { logger } from '../../../../utils/logger.js';
import type { DbRuntime } from '../dbRuntime.js';
import type { DailyBuySellVolumeRecord, CumulativeVolumeData } from '../../../databaseService.js';

export function createDailyBuySellVolumesRepo(db: DbRuntime) {
  return {
    /**
     * Get the latest complete date from daily_buy_sell_volumes table
     */
    async getLatestBuySellDate(): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT MAX(date) as latest_date FROM daily_buy_sell_volumes WHERE is_complete = true'
        );
        return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
      } catch (error: any) {
        logger.error('[Database] Error getting latest buy/sell date:', error);
        return null;
      }
    },

    async upsertDailyBuySellVolumes(records: DailyBuySellVolumeRecord[], markComplete: boolean = false): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected() || records.length === 0) {
        return 0;
      }

      const BATCH_SIZE = 500;
      let totalUpserted = 0;

      try {
        const client = await pool.connect();

        try {
          await client.query('BEGIN');

          for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE);
            
            const values: any[] = [];
            const valuePlaceholders: string[] = [];
            
            batch.forEach((record, idx) => {
              const offset = idx * 9; // 9 parameters per record
              valuePlaceholders.push(
                `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, ${markComplete}, CURRENT_TIMESTAMP)`
              );
              values.push(
                record.token,
                record.date,
                record.base_volume,
                record.target_volume,
                record.buy_usdc_volume,
                record.sell_token_volume,
                record.high,
                record.low,
                record.trade_count || 0
              );
            });

            const batchSQL = `
              INSERT INTO daily_buy_sell_volumes (token, date, base_volume, target_volume, buy_usdc_volume, sell_token_volume, high, low, trade_count, is_complete, updated_at)
              VALUES ${valuePlaceholders.join(', ')}
              ON CONFLICT (token, date) 
              DO UPDATE SET 
                base_volume = EXCLUDED.base_volume,
                target_volume = EXCLUDED.target_volume,
                buy_usdc_volume = EXCLUDED.buy_usdc_volume,
                sell_token_volume = EXCLUDED.sell_token_volume,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                trade_count = EXCLUDED.trade_count,
                is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE daily_buy_sell_volumes.is_complete END,
                updated_at = CURRENT_TIMESTAMP
            `;

            await client.query(batchSQL, values);
            totalUpserted += batch.length;
            
            if (records.length > BATCH_SIZE) {
              logger.info(`[Database] Buy/sell volume batch progress: ${totalUpserted}/${records.length}`);
            }
          }

          await client.query('COMMIT');
          logger.info(`[Database] Upserted ${totalUpserted} daily buy/sell volume records`);
          return totalUpserted;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error: any) {
        logger.error('[Database] Error upserting daily buy/sell volumes:', error);
        return 0;
      }
    },

    /**
     * Get daily buy/sell volumes with cumulative totals calculated from DB
     * Cumulative values are computed on-the-fly using window functions
     */
    async getDailyBuySellVolumesWithCumulative(token?: string): Promise<CumulativeVolumeData[]> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

      try {
        let whereClause = '';
        let params: any[] = [];

        if (token) {
          whereClause = 'WHERE token = $1';
          params = [token];
        }

        const result = await pool.query(
          `SELECT 
            token,
            date::text,
            base_volume::text,
            target_volume::text,
            buy_usdc_volume::text,
            sell_token_volume::text,
            SUM(target_volume) OVER (
              PARTITION BY token
              ORDER BY date
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::text AS cumulative_target_volume,
            SUM(base_volume) OVER (
              PARTITION BY token
              ORDER BY date
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::text AS cumulative_base_volume,
            SUM(buy_usdc_volume) OVER (
              PARTITION BY token
              ORDER BY date
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::text AS cumulative_buy_usdc_volume,
            SUM(sell_token_volume) OVER (
              PARTITION BY token
              ORDER BY date
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::text AS cumulative_sell_token_volume,
            high::text,
            low::text
           FROM daily_buy_sell_volumes
           ${whereClause}
           ORDER BY token, date ASC`,
          params
        );

        return result.rows;
      } catch (error: any) {
        logger.error('[Database] Error getting cumulative volumes:', error);
        return [];
      }
    },

    /**
     * Get daily buy/sell volumes with date range filtering
     * @param options.token Filter by specific token
     * @param options.startDate Start date (inclusive) in YYYY-MM-DD format
     * @param options.endDate End date (inclusive) in YYYY-MM-DD format
     */
    async getDailyBuySellVolumes(options?: {
      token?: string;
      tokens?: string[];
      startDate?: string;
      endDate?: string;
    }): Promise<{
      token: string;
      date: string;
      base_volume: string;
      target_volume: string;
      buy_usdc_volume: string;
      sell_token_volume: string;
      high: string;
      low: string;
      trade_count: number;
      average_price: string;
      usdc_fees: string;
      token_fees: string;
      token_fees_usdc: string;
      sell_volume_usdc: string;
      sell_volume: string;
      buy_volume: string;
    }[]> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

      try {
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        // Support both single token and array of tokens
        if (options?.tokens && options.tokens.length > 0) {
          const placeholders = options.tokens.map((_, i) => `$${paramIndex + i}`).join(', ');
          conditions.push(`token IN (${placeholders})`);
          params.push(...options.tokens);
          paramIndex += options.tokens.length;
        } else if (options?.token) {
          conditions.push(`token = $${paramIndex}`);
          params.push(options.token);
          paramIndex++;
        }

        if (options?.startDate) {
          conditions.push(`date >= $${paramIndex}`);
          params.push(options.startDate);
          paramIndex++;
        }

        if (options?.endDate) {
          conditions.push(`date <= $${paramIndex}`);
          params.push(options.endDate);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await pool.query(
          `SELECT 
            token,
            date::text,
            base_volume::text,
            target_volume::text,
            buy_volume::text,
            buy_volume::text as buy_usdc_volume,
            sell_volume::text,
            sell_volume::text as sell_token_volume,
            high::text,
            low::text,
            trade_count,
            average_price::text,
            usdc_fees::text,
            token_fees::text,
            token_fees_usdc::text,
            sell_volume_usdc::text
           FROM daily_volumes
           ${whereClause}
           ORDER BY token, date ASC`,
          params
        );

        return result.rows;
      } catch (error: any) {
        logger.error('[Database] Error getting daily buy/sell volumes:', error);
        return [];
      }
    },

    /**
     * Get aggregated buy/sell stats for all tokens
     */
    async getBuySellAggregates(tokens?: string[]): Promise<Map<string, {
      total_buy_usdc: string;
      total_sell_token: string;
      total_base_volume: string;
      total_target_volume: string;
      first_date: string;
      last_date: string;
      trading_days: number;
    }>> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return new Map();

      try {
        let whereClause = '';
        let params: any[] = [];

        if (tokens && tokens.length > 0) {
          const placeholders = tokens.map((_, i) => `$${i + 1}`).join(', ');
          whereClause = `WHERE token IN (${placeholders})`;
          params = [...tokens];
        }

        const result = await pool.query(
          `SELECT 
            token,
            SUM(buy_usdc_volume)::text AS total_buy_usdc,
            SUM(sell_token_volume)::text AS total_sell_token,
            SUM(base_volume)::text AS total_base_volume,
            SUM(target_volume)::text AS total_target_volume,
            MIN(date)::text AS first_date,
            MAX(date)::text AS last_date,
            COUNT(*)::int AS trading_days
           FROM daily_buy_sell_volumes
           ${whereClause}
           GROUP BY token
           ORDER BY SUM(target_volume) DESC`,
          params
        );

        const aggregates = new Map();
        for (const row of result.rows) {
          aggregates.set(row.token, {
            total_buy_usdc: row.total_buy_usdc || '0',
            total_sell_token: row.total_sell_token || '0',
            total_base_volume: row.total_base_volume || '0',
            total_target_volume: row.total_target_volume || '0',
            first_date: row.first_date,
            last_date: row.last_date,
            trading_days: row.trading_days || 0,
          });
        }
        return aggregates;
      } catch (error: any) {
        logger.error('[Database] Error getting buy/sell aggregates:', error);
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

    /**
     * Get buy/sell volume record count
     */
    async getBuySellRecordCount(): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query('SELECT COUNT(*) as count FROM daily_buy_sell_volumes');
        return parseInt(result.rows[0]?.count || '0');
      } catch (error: any) {
        logger.error('[Database] Error getting buy/sell record count:', error);
        return 0;
      }
    },

    /**
     * Mark days as complete (called when day boundary passes)
     */
    async markBuySellDaysComplete(beforeDate: string): Promise<void> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return;

      try {
        await pool.query(
          `UPDATE daily_buy_sell_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
           WHERE date < $1 AND is_complete = false`,
          [beforeDate]
        );
        logger.info(`[Database] Marked buy/sell days before ${beforeDate} as complete`);
      } catch (error: any) {
        logger.error('[Database] Error marking buy/sell days complete:', error);
      }
    },
  };
}
