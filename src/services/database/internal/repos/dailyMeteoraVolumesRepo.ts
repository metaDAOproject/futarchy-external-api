import { logger } from '../../../../utils/logger.js';
import type { DbRuntime } from '../dbRuntime.js';
import type { DailyMeteoraVolumeRecord } from '../../../databaseService.js';

export function createDailyMeteoraVolumesRepo(db: DbRuntime) {
  return {
    /**
     * Get daily Meteora volumes with date range filtering
     * @param options.token Filter by specific token
     * @param options.tokens Filter by array of tokens
     * @param options.startDate Start date (inclusive) in YYYY-MM-DD format
     * @param options.endDate End date (inclusive) in YYYY-MM-DD format
     */
    async getDailyMeteoraVolumes(options?: {
      token?: string;
      tokens?: string[];
      startDate?: string;
      endDate?: string;
    }): Promise<{
      token: string;
      date: string;
      base_volume: string;
      target_volume: string;
      buy_volume: string;
      sell_volume: string;
      trade_count: number;
      average_price: string;
      usdc_fees: string;
      token_fees: string;
      token_fees_usdc: string;
      token_per_usdc: string;
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
            sell_volume::text,
            trade_count,
            average_price::text,
            usdc_fees::text,
            token_fees::text,
            token_fees_usdc::text,
            token_per_usdc::text
           FROM daily_meteora_volumes
           ${whereClause}
           ORDER BY token, date ASC`,
          params
        );

        return result.rows;
      } catch (error: any) {
        logger.error('[Database] Error getting daily Meteora volumes:', error);
        return [];
      }
    },

    /**
     * Get the latest complete date from daily_meteora_volumes table
     */
    async getLatestMeteoraDate(): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT MAX(date) as latest_date FROM daily_meteora_volumes WHERE is_complete = true'
        );
        return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
      } catch (error: any) {
        logger.error('[Database] Error getting latest Meteora date:', error);
        return null;
      }
    },

    /**
     * Upsert daily Meteora volume records using batched inserts
     * @param records Array of daily Meteora volume records
     * @param markComplete Whether to mark records as complete
     * @returns Number of records upserted
     */
    async upsertDailyMeteoraVolumes(records: DailyMeteoraVolumeRecord[], markComplete: boolean = false): Promise<number> {
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
              const offset = idx * 15; // 15 parameters per record (14 data fields + is_complete)
              valuePlaceholders.push(
                `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, CURRENT_TIMESTAMP)`
              );
              values.push(
                record.token,
                record.date,
                record.base_volume,
                record.target_volume,
                record.trade_count,
                record.buy_volume,
                record.sell_volume,
                record.usdc_fees,
                record.token_fees,
                record.token_fees_usdc,
                record.token_per_usdc,
                record.average_price,
                record.ownership_share,
                record.earned_fee_usdc,
                markComplete ? true : (record.is_complete ?? false)
              );
            });

            const batchSQL = `
              INSERT INTO daily_meteora_volumes (token, date, base_volume, target_volume, trade_count, buy_volume, sell_volume, usdc_fees, token_fees, token_fees_usdc, token_per_usdc, average_price, ownership_share, earned_fee_usdc, is_complete, updated_at)
              VALUES ${valuePlaceholders.join(', ')}
              ON CONFLICT (token, date) 
              DO UPDATE SET 
                base_volume = EXCLUDED.base_volume,
                target_volume = EXCLUDED.target_volume,
                trade_count = EXCLUDED.trade_count,
                buy_volume = EXCLUDED.buy_volume,
                sell_volume = EXCLUDED.sell_volume,
                usdc_fees = EXCLUDED.usdc_fees,
                token_fees = EXCLUDED.token_fees,
                token_fees_usdc = EXCLUDED.token_fees_usdc,
                token_per_usdc = EXCLUDED.token_per_usdc,
                average_price = EXCLUDED.average_price,
                ownership_share = EXCLUDED.ownership_share,
                earned_fee_usdc = EXCLUDED.earned_fee_usdc,
                is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE daily_meteora_volumes.is_complete END,
                updated_at = CURRENT_TIMESTAMP
            `;

            await client.query(batchSQL, values);
            totalUpserted += batch.length;
            
            if (records.length > BATCH_SIZE) {
              logger.info(`[Database] Meteora volume batch progress: ${totalUpserted}/${records.length}`);
            }
          }

          await client.query('COMMIT');
          logger.info(`[Database] Upserted ${totalUpserted} daily Meteora volume records`);
          return totalUpserted;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error: any) {
        logger.error('[Database] Error upserting daily Meteora volumes:', error);
        return 0;
      }
    },

    /**
     * Mark Meteora volume days as complete before a given date
     */
    async markMeteoraDaysComplete(beforeDate: string): Promise<void> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return;

      try {
        await pool.query(
          `UPDATE daily_meteora_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
           WHERE date < $1 AND is_complete = false`,
          [beforeDate]
        );
        logger.info(`[Database] Marked Meteora days before ${beforeDate} as complete`);
      } catch (error: any) {
        logger.error('[Database] Error marking Meteora days complete:', error);
      }
    },

    /**
     * Get count of Meteora volume records
     */
    async getMeteoraRecordCount(): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query('SELECT COUNT(*) as count FROM daily_meteora_volumes');
        return parseInt(result.rows[0]?.count || '0');
      } catch (error: any) {
        logger.error('[Database] Error getting Meteora record count:', error);
        return 0;
      }
    },
  };
}

export type DailyMeteoraVolumesRepo = ReturnType<typeof createDailyMeteoraVolumesRepo>;
