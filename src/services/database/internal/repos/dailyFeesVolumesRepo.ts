import { logger } from '../../../../utils/logger.js';
import type { DbRuntime } from '../dbRuntime.js';
import type { DailyFeesVolumeRecord } from '../../../databaseService.js';

export function createDailyFeesVolumesRepo(db: DbRuntime) {
  return {
    /**
     * Get the latest date we have fees data for
     */
    async getLatestFeesDate(): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT MAX(trading_date) as latest_date FROM daily_fees_volumes WHERE is_complete = true'
        );
        return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
      } catch (error: any) {
        logger.error('[Database] Error getting latest fees date:', error);
        return null;
      }
    },

    /**
     * Upsert daily fees volume records using batched inserts
     * @param records Array of daily fees volume records
     * @param markComplete If true, marks these days as complete (for historical data)
     */
    async upsertDailyFeesVolumes(records: DailyFeesVolumeRecord[], markComplete: boolean = false): Promise<number> {
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
              const offset = idx * 17; // 17 parameters per record
              valuePlaceholders.push(
                `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, ${markComplete}, CURRENT_TIMESTAMP)`
              );
              values.push(
                record.token,
                record.trading_date,
                record.base_volume,
                record.target_volume,
                record.usdc_fees,
                record.token_fees_usdc,
                record.token_fees,
                record.buy_volume,
                record.sell_volume,
                record.sell_volume_usdc,
                record.cumulative_usdc_fees,
                record.cumulative_token_in_usdc_fees,
                record.cumulative_target_volume,
                record.cumulative_token_volume,
                record.high,
                record.average_price,
                record.low
              );
            });

            const batchSQL = `
              INSERT INTO daily_fees_volumes (token, trading_date, base_volume, target_volume, usdc_fees, token_fees_usdc, token_fees, buy_volume, sell_volume, sell_volume_usdc, cumulative_usdc_fees, cumulative_token_in_usdc_fees, cumulative_target_volume, cumulative_token_volume, high, average_price, low, is_complete, updated_at)
              VALUES ${valuePlaceholders.join(', ')}
              ON CONFLICT (token, trading_date) 
              DO UPDATE SET 
                base_volume = EXCLUDED.base_volume,
                target_volume = EXCLUDED.target_volume,
                usdc_fees = EXCLUDED.usdc_fees,
                token_fees_usdc = EXCLUDED.token_fees_usdc,
                token_fees = EXCLUDED.token_fees,
                buy_volume = EXCLUDED.buy_volume,
                sell_volume = EXCLUDED.sell_volume,
                sell_volume_usdc = EXCLUDED.sell_volume_usdc,
                cumulative_usdc_fees = EXCLUDED.cumulative_usdc_fees,
                cumulative_token_in_usdc_fees = EXCLUDED.cumulative_token_in_usdc_fees,
                cumulative_target_volume = EXCLUDED.cumulative_target_volume,
                cumulative_token_volume = EXCLUDED.cumulative_token_volume,
                high = EXCLUDED.high,
                average_price = EXCLUDED.average_price,
                low = EXCLUDED.low,
                is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE daily_fees_volumes.is_complete END,
                updated_at = CURRENT_TIMESTAMP
            `;

            await client.query(batchSQL, values);
            totalUpserted += batch.length;
            
            if (records.length > BATCH_SIZE) {
              logger.info(`[Database] Fees volume batch progress: ${totalUpserted}/${records.length}`);
            }
          }

          await client.query('COMMIT');
          logger.info(`[Database] Upserted ${totalUpserted} daily fees volume records`);
          return totalUpserted;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error: any) {
        logger.error('[Database] Error upserting daily fees volumes:', error);
        return 0;
      }
    },

    /**
     * Get daily fees volumes with date range filtering
     * @param options.token Filter by specific token
     * @param options.startDate Start date (inclusive) in YYYY-MM-DD format
     * @param options.endDate End date (inclusive) in YYYY-MM-DD format
     */
    async getDailyFeesVolumes(options?: {
      token?: string;
      startDate?: string;
      endDate?: string;
    }): Promise<DailyFeesVolumeRecord[]> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

      try {
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (options?.token) {
          conditions.push(`token = $${paramIndex}`);
          params.push(options.token);
          paramIndex++;
        }

        if (options?.startDate) {
          conditions.push(`trading_date >= $${paramIndex}`);
          params.push(options.startDate);
          paramIndex++;
        }

        if (options?.endDate) {
          conditions.push(`trading_date <= $${paramIndex}`);
          params.push(options.endDate);
          paramIndex++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await pool.query(
          `SELECT 
            token,
            trading_date::text,
            base_volume::text,
            target_volume::text,
            usdc_fees::text,
            token_fees_usdc::text,
            token_fees::text,
            buy_volume::text,
            sell_volume::text,
            sell_volume_usdc::text,
            cumulative_usdc_fees::text,
            cumulative_token_in_usdc_fees::text,
            cumulative_target_volume::text,
            cumulative_token_volume::text,
            high::text,
            average_price::text,
            low::text
           FROM daily_fees_volumes
           ${whereClause}
           ORDER BY token, trading_date ASC`,
          params
        );

        return result.rows;
      } catch (error: any) {
        logger.error('[Database] Error getting daily fees volumes:', error);
        return [];
      }
    },

    /**
     * Mark days as complete (called when day boundary passes)
     */
    async markFeesDaysComplete(beforeDate: string): Promise<void> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return;

      try {
        await pool.query(
          `UPDATE daily_fees_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
           WHERE trading_date < $1 AND is_complete = false`,
          [beforeDate]
        );
        logger.info(`[Database] Marked fees days before ${beforeDate} as complete`);
      } catch (error: any) {
        logger.error('[Database] Error marking fees days complete:', error);
      }
    },

    /**
     * Get fees volume record count
     */
    async getFeesRecordCount(): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query('SELECT COUNT(*) as count FROM daily_fees_volumes');
        return parseInt(result.rows[0]?.count || '0');
      } catch (error: any) {
        logger.error('[Database] Error getting fees record count:', error);
        return 0;
      }
    },
  };
}
