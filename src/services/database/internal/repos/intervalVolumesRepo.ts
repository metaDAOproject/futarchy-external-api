import { logger } from '../../../../utils/logger.js';
import type { DbRuntime } from '../dbRuntime.js';
import type { HourlyVolumeRecord, TenMinuteVolumeRecord, Rolling24hMetrics } from '../../../databaseService.js';

export function createIntervalVolumesRepo(db: DbRuntime) {
  return {
    // ============================================
    // SYNC METADATA
    // ============================================

    async setSyncMetadata(key: string, value: string): Promise<void> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return;

      try {
        await pool.query(
          `INSERT INTO sync_metadata (key, value, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
          [key, value]
        );
      } catch (error: any) {
        logger.error('[Database] Error setting sync metadata:', error);
      }
    },

    async getSyncMetadata(key: string): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT value FROM sync_metadata WHERE key = $1',
          [key]
        );
        return result.rows[0]?.value || null;
      } catch (error: any) {
        logger.error('[Database] Error getting sync metadata:', error);
        return null;
      }
    },

    // ============================================
    // HOURLY VOLUME METHODS
    // ============================================

    async getLatestHour(): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT MAX(hour) as latest_hour FROM hourly_volumes'
        );
        return result.rows[0]?.latest_hour?.toISOString() || null;
      } catch (error: any) {
        logger.error('[Database] Error getting latest hour:', error);
        return null;
      }
    },

    async getLatestCompleteHour(): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT MAX(hour) as latest_hour FROM hourly_volumes WHERE is_complete = true'
        );
        return result.rows[0]?.latest_hour?.toISOString() || null;
      } catch (error: any) {
        logger.error('[Database] Error getting latest complete hour:', error);
        return null;
      }
    },

    async upsertHourlyVolumes(records: HourlyVolumeRecord[], markComplete: boolean = false): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected() || records.length === 0) return 0;

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
              const offset = idx * 14;
              valuePlaceholders.push(
                `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, ${markComplete}, CURRENT_TIMESTAMP)`
              );
              values.push(
                record.token,
                record.hour,
                record.base_volume,
                record.target_volume,
                record.buy_volume || '0',
                record.sell_volume || '0',
                record.high,
                record.low,
                record.average_price || '0',
                record.trade_count || 0,
                record.usdc_fees || '0',
                record.token_fees || '0',
                record.token_fees_usdc || '0',
                record.sell_volume_usdc || '0'
              );
            });

            const batchSQL = `
            INSERT INTO hourly_volumes (token, hour, base_volume, target_volume, buy_volume, sell_volume, high, low, average_price, trade_count, usdc_fees, token_fees, token_fees_usdc, sell_volume_usdc, is_complete, updated_at)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT (token, hour) 
            DO UPDATE SET 
              base_volume = COALESCE(NULLIF(hourly_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(hourly_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(hourly_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN hourly_volumes.low > 0 THEN hourly_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE hourly_volumes.low END
              ),
              trade_count = GREATEST(COALESCE(hourly_volumes.trade_count, 0), COALESCE(EXCLUDED.trade_count, 0)),
              buy_volume = COALESCE(NULLIF(hourly_volumes.buy_volume, 0), EXCLUDED.buy_volume),
              sell_volume = COALESCE(NULLIF(hourly_volumes.sell_volume, 0), EXCLUDED.sell_volume),
              average_price = COALESCE(NULLIF(hourly_volumes.average_price, 0), EXCLUDED.average_price),
              usdc_fees = COALESCE(NULLIF(hourly_volumes.usdc_fees, 0), EXCLUDED.usdc_fees),
              token_fees = COALESCE(NULLIF(hourly_volumes.token_fees, 0), EXCLUDED.token_fees),
              token_fees_usdc = COALESCE(NULLIF(hourly_volumes.token_fees_usdc, 0), EXCLUDED.token_fees_usdc),
              sell_volume_usdc = COALESCE(NULLIF(hourly_volumes.sell_volume_usdc, 0), EXCLUDED.sell_volume_usdc),
              is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE hourly_volumes.is_complete END,
              updated_at = CURRENT_TIMESTAMP
          `;

            await client.query(batchSQL, values);
            totalUpserted += batch.length;

            if (records.length > BATCH_SIZE) {
              logger.info(`[Database] Hourly volume batch progress: ${totalUpserted}/${records.length}`);
            }
          }

          await client.query('COMMIT');
          logger.info(`[Database] Upserted ${totalUpserted} hourly volume records (complete: ${markComplete})`);
          return totalUpserted;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error: any) {
        logger.error('[Database] Error upserting hourly volumes:', error);
        return 0;
      }
    },

    async markHoursComplete(beforeHour: string): Promise<void> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return;

      try {
        await pool.query(
          `UPDATE hourly_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
         WHERE hour < $1 AND is_complete = false`,
          [beforeHour]
        );
        logger.info(`[Database] Marked hours before ${beforeHour} as complete`);
      } catch (error: any) {
        logger.error('[Database] Error marking hours complete:', error);
      }
    },

    async getRolling24hMetrics(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return new Map();

      try {
        const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        let whereClause = 'WHERE hour >= $1';
        let params: any[] = [cutoffTime];

        if (tokens && tokens.length > 0) {
          const placeholders = tokens.map((_, i) => `$${i + 2}`).join(', ');
          whereClause += ` AND token IN (${placeholders})`;
          params = [cutoffTime, ...tokens];
        }

        const result = await pool.query(
          `SELECT 
          token,
          SUM(base_volume)::text as base_volume_24h,
          SUM(target_volume)::text as target_volume_24h,
          MAX(high)::text as high_24h,
          MIN(CASE WHEN low > 0 THEN low END)::text as low_24h,
          SUM(trade_count)::int as trade_count_24h
         FROM hourly_volumes
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
        logger.error('[Database] Error getting rolling 24h metrics:', error);
        return new Map();
      }
    },

    async getHourlyVolumes(startHour: string, endHour?: string, tokens?: string[]): Promise<HourlyVolumeRecord[]> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

      try {
        let whereClause = 'WHERE hour >= $1';
        let params: any[] = [startHour];
        let paramIndex = 2;

        if (endHour) {
          whereClause += ` AND hour <= $${paramIndex}`;
          params.push(endHour);
          paramIndex++;
        }

        if (tokens && tokens.length > 0) {
          const placeholders = tokens.map((_, i) => `$${paramIndex + i}`).join(', ');
          whereClause += ` AND token IN (${placeholders})`;
          params = [...params, ...tokens];
        }

        const result = await pool.query(
          `SELECT 
          token,
          hour::text,
          base_volume::text,
          target_volume::text,
          high::text,
          low::text,
          trade_count
         FROM hourly_volumes
         ${whereClause}
         ORDER BY token, hour ASC`,
          params
        );

        return result.rows;
      } catch (error: any) {
        logger.error('[Database] Error getting hourly volumes:', error);
        return [];
      }
    },

    async getHourlyRecordCount(): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query('SELECT COUNT(*) as count FROM hourly_volumes');
        return parseInt(result.rows[0]?.count || '0');
      } catch (error: any) {
        logger.error('[Database] Error getting hourly record count:', error);
        return 0;
      }
    },

    async getHourlyTokenCount(): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query('SELECT COUNT(DISTINCT token) as count FROM hourly_volumes');
        return parseInt(result.rows[0]?.count || '0');
      } catch (error: any) {
        logger.error('[Database] Error getting hourly token count:', error);
        return 0;
      }
    },

    async pruneOldHourlyData(keepHours: number = 48): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const cutoffTime = new Date(Date.now() - keepHours * 60 * 60 * 1000).toISOString();
        const result = await pool.query(
          'DELETE FROM hourly_volumes WHERE hour < $1 RETURNING id',
          [cutoffTime]
        );
        const deletedCount = result.rowCount || 0;
        if (deletedCount > 0) {
          logger.info(`[Database] Pruned ${deletedCount} hourly records older than ${keepHours} hours`);
        }
        return deletedCount;
      } catch (error: any) {
        logger.error('[Database] Error pruning old hourly data:', error);
        return 0;
      }
    },

    // ============================================
    // 10-MINUTE VOLUME METHODS
    // ============================================

    async upsertTenMinuteVolumes(records: TenMinuteVolumeRecord[], markComplete: boolean = false): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected() || records.length === 0) return 0;

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
              const offset = idx * 14;
              valuePlaceholders.push(
                `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, ${markComplete}, CURRENT_TIMESTAMP)`
              );
              values.push(
                record.token,
                record.bucket,
                record.base_volume,
                record.target_volume,
                record.buy_volume || '0',
                record.sell_volume || '0',
                record.high,
                record.low,
                record.average_price || '0',
                record.trade_count || 0,
                record.usdc_fees || '0',
                record.token_fees || '0',
                record.token_fees_usdc || '0',
                record.sell_volume_usdc || '0'
              );
            });

            const batchSQL = `
            INSERT INTO ten_minute_volumes (token, bucket, base_volume, target_volume, buy_volume, sell_volume, high, low, average_price, trade_count, usdc_fees, token_fees, token_fees_usdc, sell_volume_usdc, is_complete, updated_at)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT (token, bucket) 
            DO UPDATE SET 
              base_volume = COALESCE(NULLIF(ten_minute_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(ten_minute_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(ten_minute_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN ten_minute_volumes.low > 0 THEN ten_minute_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE ten_minute_volumes.low END
              ),
              buy_volume = COALESCE(NULLIF(ten_minute_volumes.buy_volume, 0), EXCLUDED.buy_volume),
              sell_volume = COALESCE(NULLIF(ten_minute_volumes.sell_volume, 0), EXCLUDED.sell_volume),
              average_price = COALESCE(NULLIF(ten_minute_volumes.average_price, 0), EXCLUDED.average_price),
              trade_count = GREATEST(COALESCE(ten_minute_volumes.trade_count, 0), COALESCE(EXCLUDED.trade_count, 0)),
              usdc_fees = COALESCE(NULLIF(ten_minute_volumes.usdc_fees, 0), EXCLUDED.usdc_fees),
              token_fees = COALESCE(NULLIF(ten_minute_volumes.token_fees, 0), EXCLUDED.token_fees),
              token_fees_usdc = COALESCE(NULLIF(ten_minute_volumes.token_fees_usdc, 0), EXCLUDED.token_fees_usdc),
              sell_volume_usdc = COALESCE(NULLIF(ten_minute_volumes.sell_volume_usdc, 0), EXCLUDED.sell_volume_usdc),
              is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE ten_minute_volumes.is_complete END,
              updated_at = CURRENT_TIMESTAMP
          `;

            await client.query(batchSQL, values);
            totalUpserted += batch.length;

            if (records.length > BATCH_SIZE) {
              logger.info(`[Database] 10-min volume batch progress: ${totalUpserted}/${records.length}`);
            }
          }

          await client.query('COMMIT');
          logger.info(`[Database] Upserted ${totalUpserted} 10-minute volume records (complete: ${markComplete})`);
          return totalUpserted;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error: any) {
        logger.error('[Database] Error upserting 10-minute volumes:', error);
        return 0;
      }
    },

    async markTenMinuteBucketsComplete(beforeBucket: string): Promise<void> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return;

      try {
        await pool.query(
          `UPDATE ten_minute_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
         WHERE bucket < $1 AND is_complete = false`,
          [beforeBucket]
        );
      } catch (error: any) {
        logger.error('[Database] Error marking 10-min buckets complete:', error);
      }
    },

    async backfillMissingFields(): Promise<{
      tenMinuteUpdated: number;
      hourlyUpdated: number;
      dailyUpdated: number;
    }> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) {
        return { tenMinuteUpdated: 0, hourlyUpdated: 0, dailyUpdated: 0 };
      }

      logger.info('[Database] Starting backfill of missing extended fields using DB aggregation functions...');
      const results = {
        tenMinuteUpdated: 0,
        hourlyUpdated: 0,
        dailyUpdated: 0,
      };

      try {
        // 1. Find all hours that have 10-minute data but missing/zero extended fields
        logger.info('[Database] Finding hours with missing extended fields that have 10-minute data...');
        const hoursToUpdate = await pool.query(`
        SELECT DISTINCT 
          hv.token,
          hv.hour
        FROM hourly_volumes hv
        WHERE EXISTS (
          SELECT 1 
          FROM ten_minute_volumes tmv 
          WHERE tmv.token = hv.token 
            AND date_trunc('hour', tmv.bucket) = hv.hour
        )
        AND (
          hv.average_price IS NULL OR hv.average_price = 0 OR
          hv.usdc_fees IS NULL OR hv.usdc_fees = 0 OR
          hv.sell_volume_usdc IS NULL OR hv.sell_volume_usdc = 0 OR
          hv.buy_volume IS NULL OR hv.buy_volume = 0 OR
          hv.sell_volume IS NULL OR hv.sell_volume = 0 OR
          hv.token_fees IS NULL OR hv.token_fees = 0 OR
          hv.token_fees_usdc IS NULL OR hv.token_fees_usdc = 0
        )
        ORDER BY hv.token, hv.hour
      `);

        logger.info(`[Database] Found ${hoursToUpdate.rows.length} hours to update from 10-minute data`);

        if (hoursToUpdate.rows.length > 0) {
          logger.info('[Database] Backfilling hourly records from 10-minute data using aggregate_10min_to_hourly function...');

          for (const row of hoursToUpdate.rows) {
            const tokenValue = String(row.token);
            const hourValue = row.hour instanceof Date ? row.hour.toISOString() : String(row.hour);

            try {
              const client = await pool.connect();
              try {
                const escapedToken = client.escapeLiteral(tokenValue);
                const escapedHour = client.escapeLiteral(hourValue);

                const aggregated = await client.query(
                  `SELECT * FROM aggregate_10min_to_hourly(${escapedToken}::VARCHAR, ${escapedHour}::TIMESTAMPTZ)`
                );

                if (aggregated.rows.length > 0) {
                  const agg = aggregated.rows[0];

                  if (agg.average_price != null || agg.usdc_fees != null || agg.sell_volume_usdc != null) {
                    const buyVolume = agg.buy_volume != null ? Number(agg.buy_volume) : null;
                    const sellVolume = agg.sell_volume != null ? Number(agg.sell_volume) : null;
                    const averagePrice = agg.average_price != null ? Number(agg.average_price) : null;
                    const usdcFees = agg.usdc_fees != null ? Number(agg.usdc_fees) : null;
                    const tokenFees = agg.token_fees != null ? Number(agg.token_fees) : null;
                    const tokenFeesUsdc = agg.token_fees_usdc != null ? Number(agg.token_fees_usdc) : null;
                    const sellVolumeUsdc = agg.sell_volume_usdc != null ? Number(agg.sell_volume_usdc) : null;

                    logger.debug(`[Database] Updating hour ${hourValue} for token ${tokenValue}`, {
                      buyVolume, sellVolume, averagePrice, usdcFees, tokenFees, tokenFeesUsdc, sellVolumeUsdc,
                      tokenValue, hourValue, rawAgg: agg
                    });

                    await client.query(
                      `UPDATE hourly_volumes
                    SET 
                      buy_volume = CASE WHEN $1::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(buy_volume, 0), $1::NUMERIC) ELSE buy_volume END,
                      sell_volume = CASE WHEN $2::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(sell_volume, 0), $2::NUMERIC) ELSE sell_volume END,
                      average_price = CASE WHEN $3::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(average_price, 0), $3::NUMERIC) ELSE average_price END,
                      usdc_fees = CASE WHEN $4::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(usdc_fees, 0), $4::NUMERIC) ELSE usdc_fees END,
                      token_fees = CASE WHEN $5::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(token_fees, 0), $5::NUMERIC) ELSE token_fees END,
                      token_fees_usdc = CASE WHEN $6::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(token_fees_usdc, 0), $6::NUMERIC) ELSE token_fees_usdc END,
                      sell_volume_usdc = CASE WHEN $7::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(sell_volume_usdc, 0), $7::NUMERIC) ELSE sell_volume_usdc END,
                      updated_at = CURRENT_TIMESTAMP
                    WHERE token = $8::VARCHAR AND hour = $9::TIMESTAMPTZ
                      AND (
                        average_price IS NULL OR average_price = 0 OR
                        usdc_fees IS NULL OR usdc_fees = 0 OR
                        sell_volume_usdc IS NULL OR sell_volume_usdc = 0 OR
                        buy_volume IS NULL OR buy_volume = 0 OR
                        sell_volume IS NULL OR sell_volume = 0 OR
                        token_fees IS NULL OR token_fees = 0 OR
                        token_fees_usdc IS NULL OR token_fees_usdc = 0
                      )`,
                      [buyVolume, sellVolume, averagePrice, usdcFees, tokenFees, tokenFeesUsdc, sellVolumeUsdc, tokenValue, hourValue]
                    );
                    results.hourlyUpdated++;
                  }
                }
              } finally {
                client.release();
              }
            } catch (error: any) {
              logger.error(`[Database] Error updating hour ${row.hour} for token ${row.token}:`, {
                error: error.message, stack: error.stack,
                token: row.token, hour: row.hour, tokenValue, hourValue,
                tokenType: typeof row.token, hourType: typeof row.hour,
                hourIsDate: row.hour instanceof Date, hourRawValue: row.hour,
              });
            }
          }
          logger.info(`[Database] Updated ${results.hourlyUpdated} hourly records with missing fields`);
        }

        // 2. Find all days that have hourly data but missing/zero extended fields
        logger.info('[Database] Finding days with missing extended fields that have hourly data...');
        const daysToUpdate = await pool.query(`
        SELECT DISTINCT 
          dv.token,
          dv.date
        FROM daily_volumes dv
        WHERE EXISTS (
          SELECT 1 
          FROM hourly_volumes hv 
          WHERE hv.token = dv.token 
            AND date_trunc('day', hv.hour)::DATE = dv.date
        )
        AND (
          dv.average_price IS NULL OR dv.average_price = 0 OR
          dv.usdc_fees IS NULL OR dv.usdc_fees = 0 OR
          dv.sell_volume_usdc IS NULL OR dv.sell_volume_usdc = 0 OR
          dv.buy_volume IS NULL OR dv.buy_volume = 0 OR
          dv.sell_volume IS NULL OR dv.sell_volume = 0 OR
          dv.token_fees IS NULL OR dv.token_fees = 0 OR
          dv.token_fees_usdc IS NULL OR dv.token_fees_usdc = 0
        )
        ORDER BY dv.token, dv.date
      `);

        logger.info(`[Database] Found ${daysToUpdate.rows.length} days to update from hourly data`);

        if (daysToUpdate.rows.length > 0) {
          logger.info('[Database] Backfilling daily records from hourly data using aggregate_hourly_to_daily function...');

          for (const row of daysToUpdate.rows) {
            const tokenValue = String(row.token);
            const dateValue = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date);

            try {
              const client = await pool.connect();
              try {
                const escapedToken = client.escapeLiteral(tokenValue);
                const escapedDate = client.escapeLiteral(dateValue);

                const aggregated = await client.query(
                  `SELECT * FROM aggregate_hourly_to_daily(${escapedToken}::VARCHAR, ${escapedDate}::DATE)`
                );

                if (aggregated.rows.length > 0) {
                  const agg = aggregated.rows[0];

                  if (agg.average_price != null || agg.usdc_fees != null || agg.sell_volume_usdc != null) {
                    const buyVolume = agg.buy_volume != null ? Number(agg.buy_volume) : null;
                    const sellVolume = agg.sell_volume != null ? Number(agg.sell_volume) : null;
                    const averagePrice = agg.average_price != null ? Number(agg.average_price) : null;
                    const tradeCount = agg.trade_count != null ? Number(agg.trade_count) : null;
                    const usdcFees = agg.usdc_fees != null ? Number(agg.usdc_fees) : null;
                    const tokenFees = agg.token_fees != null ? Number(agg.token_fees) : null;
                    const tokenFeesUsdc = agg.token_fees_usdc != null ? Number(agg.token_fees_usdc) : null;
                    const sellVolumeUsdc = agg.sell_volume_usdc != null ? Number(agg.sell_volume_usdc) : null;
                    const cumulativeUsdcFees = agg.cumulative_usdc_fees != null ? Number(agg.cumulative_usdc_fees) : null;
                    const cumulativeTokenInUsdcFees = agg.cumulative_token_in_usdc_fees != null ? Number(agg.cumulative_token_in_usdc_fees) : null;
                    const cumulativeTargetVolume = agg.cumulative_target_volume != null ? Number(agg.cumulative_target_volume) : null;
                    const cumulativeTokenVolume = agg.cumulative_token_volume != null ? Number(agg.cumulative_token_volume) : null;

                    logger.debug(`[Database] Updating day ${dateValue} for token ${tokenValue}`, {
                      buyVolume, sellVolume, averagePrice, tradeCount, usdcFees, tokenFees, tokenFeesUsdc,
                      sellVolumeUsdc, cumulativeUsdcFees, cumulativeTokenInUsdcFees, cumulativeTargetVolume,
                      cumulativeTokenVolume, tokenValue, dateValue, rawAgg: agg
                    });

                    await client.query(
                      `UPDATE daily_volumes
                    SET 
                      buy_volume = CASE WHEN $1::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(buy_volume, 0), $1::NUMERIC) ELSE buy_volume END,
                      sell_volume = CASE WHEN $2::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(sell_volume, 0), $2::NUMERIC) ELSE sell_volume END,
                      average_price = CASE WHEN $3::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(average_price, 0), $3::NUMERIC) ELSE average_price END,
                      trade_count = CASE WHEN $4::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(trade_count, 0), $4::NUMERIC) ELSE trade_count END,
                      usdc_fees = CASE WHEN $5::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(usdc_fees, 0), $5::NUMERIC) ELSE usdc_fees END,
                      token_fees = CASE WHEN $6::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(token_fees, 0), $6::NUMERIC) ELSE token_fees END,
                      token_fees_usdc = CASE WHEN $7::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(token_fees_usdc, 0), $7::NUMERIC) ELSE token_fees_usdc END,
                      sell_volume_usdc = CASE WHEN $8::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(sell_volume_usdc, 0), $8::NUMERIC) ELSE sell_volume_usdc END,
                      cumulative_usdc_fees = CASE WHEN $9::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(cumulative_usdc_fees, 0), $9::NUMERIC) ELSE cumulative_usdc_fees END,
                      cumulative_token_in_usdc_fees = CASE WHEN $10::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(cumulative_token_in_usdc_fees, 0), $10::NUMERIC) ELSE cumulative_token_in_usdc_fees END,
                      cumulative_target_volume = CASE WHEN $11::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(cumulative_target_volume, 0), $11::NUMERIC) ELSE cumulative_target_volume END,
                      cumulative_token_volume = CASE WHEN $12::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(cumulative_token_volume, 0), $12::NUMERIC) ELSE cumulative_token_volume END,
                      updated_at = CURRENT_TIMESTAMP
                    WHERE token = $13::VARCHAR AND date = $14::DATE
                      AND (
                        average_price IS NULL OR average_price = 0 OR
                        usdc_fees IS NULL OR usdc_fees = 0 OR
                        sell_volume_usdc IS NULL OR sell_volume_usdc = 0 OR
                        buy_volume IS NULL OR buy_volume = 0 OR
                        sell_volume IS NULL OR sell_volume = 0 OR
                        token_fees IS NULL OR token_fees = 0 OR
                        token_fees_usdc IS NULL OR token_fees_usdc = 0
                      )`,
                      [buyVolume, sellVolume, averagePrice, tradeCount, usdcFees, tokenFees, tokenFeesUsdc,
                        sellVolumeUsdc, cumulativeUsdcFees, cumulativeTokenInUsdcFees, cumulativeTargetVolume,
                        cumulativeTokenVolume, tokenValue, dateValue]
                    );
                    results.dailyUpdated++;
                  }
                }
              } finally {
                client.release();
              }
            } catch (error: any) {
              logger.error(`[Database] Error updating day ${row.date} for token ${row.token}:`, {
                error: error.message, stack: error.stack,
                token: row.token, date: row.date, tokenValue, dateValue,
                tokenType: typeof row.token, dateType: typeof row.date,
                dateIsDate: row.date instanceof Date, dateRawValue: row.date,
              });
            }
          }
          logger.info(`[Database] Updated ${results.dailyUpdated} daily records with missing fields`);
        }

        logger.info('[Database] Backfill completed:', { results });
        return results;
      } catch (error: any) {
        logger.error('[Database] Error during backfill:', error);
        return results;
      }
    },

    async getRolling24hFromTenMinute(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return new Map();

      try {
        const metricsMap = new Map<string, Rolling24hMetrics>();

        if (tokens && tokens.length > 0) {
          for (const token of tokens) {
            const result = await pool.query(
              `SELECT * FROM calculate_rolling_24h($1)`,
              [token]
            );

            for (const row of result.rows) {
              metricsMap.set(row.token, {
                token: row.token,
                base_volume_24h: row.base_volume_24h?.toString() || '0',
                target_volume_24h: row.target_volume_24h?.toString() || '0',
                high_24h: row.high_24h?.toString() || '0',
                low_24h: row.low_24h?.toString() || '0',
                trade_count_24h: row.trade_count_24h || 0,
              });
            }
          }
        } else {
          const result = await pool.query(
            `SELECT * FROM calculate_rolling_24h(NULL)`
          );

          for (const row of result.rows) {
            metricsMap.set(row.token, {
              token: row.token,
              base_volume_24h: row.base_volume_24h?.toString() || '0',
              target_volume_24h: row.target_volume_24h?.toString() || '0',
              high_24h: row.high_24h?.toString() || '0',
              low_24h: row.low_24h?.toString() || '0',
              trade_count_24h: row.trade_count_24h || 0,
            });
          }
        }

        return metricsMap;
      } catch (error: any) {
        logger.error('[Database] Error getting rolling 24h from 10-min data:', error);
        return new Map();
      }
    },

    async aggregate10MinToHourly(token?: string, hour?: string): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query(
          `SELECT * FROM aggregate_10min_to_hourly(CAST($1 AS VARCHAR), CAST($2 AS TIMESTAMPTZ))`,
          [token || null, hour || null]
        );

        if (result.rows.length === 0) {
          return 0;
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          for (const row of result.rows) {
            await client.query(
              `INSERT INTO hourly_volumes (
              token, hour, base_volume, target_volume, buy_volume, sell_volume,
              high, low, average_price, trade_count, usdc_fees, token_fees,
              token_fees_usdc, sell_volume_usdc, is_complete, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, CURRENT_TIMESTAMP)
            ON CONFLICT (token, hour) DO UPDATE SET
              base_volume = COALESCE(NULLIF(hourly_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(hourly_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(hourly_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN hourly_volumes.low > 0 THEN hourly_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE hourly_volumes.low END
              ),
              trade_count = GREATEST(COALESCE(hourly_volumes.trade_count, 0), COALESCE(EXCLUDED.trade_count, 0)),
              buy_volume = COALESCE(NULLIF(hourly_volumes.buy_volume, 0), EXCLUDED.buy_volume),
              sell_volume = COALESCE(NULLIF(hourly_volumes.sell_volume, 0), EXCLUDED.sell_volume),
              average_price = COALESCE(NULLIF(hourly_volumes.average_price, 0), EXCLUDED.average_price),
              usdc_fees = COALESCE(NULLIF(hourly_volumes.usdc_fees, 0), EXCLUDED.usdc_fees),
              token_fees = COALESCE(NULLIF(hourly_volumes.token_fees, 0), EXCLUDED.token_fees),
              token_fees_usdc = COALESCE(NULLIF(hourly_volumes.token_fees_usdc, 0), EXCLUDED.token_fees_usdc),
              sell_volume_usdc = COALESCE(NULLIF(hourly_volumes.sell_volume_usdc, 0), EXCLUDED.sell_volume_usdc),
              is_complete = true,
              updated_at = CURRENT_TIMESTAMP`,
              [
                row.token, row.hour, row.base_volume, row.target_volume,
                row.buy_volume, row.sell_volume, row.high, row.low,
                row.average_price, row.trade_count, row.usdc_fees, row.token_fees,
                row.token_fees_usdc, row.sell_volume_usdc,
              ]
            );
          }

          await client.query('COMMIT');
          logger.info(`[Database] Aggregated ${result.rows.length} hourly records from 10-minute data`);
          return result.rows.length;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error: any) {
        logger.error('[Database] Error aggregating 10-min to hourly:', error);
        return 0;
      }
    },

    async aggregateHourlyToDaily(token?: string, date?: string): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query(
          `SELECT * FROM aggregate_hourly_to_daily(CAST($1 AS VARCHAR), CAST($2 AS DATE))`,
          [token || null, date || null]
        );

        if (result.rows.length === 0) {
          return 0;
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          for (const row of result.rows) {
            await client.query(
              `INSERT INTO daily_volumes (
              token, date, base_volume, target_volume, buy_volume, sell_volume,
              high, low, average_price, trade_count, usdc_fees, token_fees,
              token_fees_usdc, sell_volume_usdc, cumulative_usdc_fees,
              cumulative_token_in_usdc_fees, cumulative_target_volume,
              cumulative_token_volume, is_complete, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, true, CURRENT_TIMESTAMP)
            ON CONFLICT (token, date) DO UPDATE SET
              base_volume = COALESCE(NULLIF(daily_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(daily_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(daily_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN daily_volumes.low > 0 THEN daily_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE daily_volumes.low END
              ),
              trade_count = GREATEST(COALESCE(daily_volumes.trade_count, 0), COALESCE(EXCLUDED.trade_count, 0)),
              buy_volume = COALESCE(NULLIF(daily_volumes.buy_volume, 0), EXCLUDED.buy_volume),
              sell_volume = COALESCE(NULLIF(daily_volumes.sell_volume, 0), EXCLUDED.sell_volume),
              average_price = COALESCE(NULLIF(daily_volumes.average_price, 0), EXCLUDED.average_price),
              usdc_fees = COALESCE(NULLIF(daily_volumes.usdc_fees, 0), EXCLUDED.usdc_fees),
              token_fees = COALESCE(NULLIF(daily_volumes.token_fees, 0), EXCLUDED.token_fees),
              token_fees_usdc = COALESCE(NULLIF(daily_volumes.token_fees_usdc, 0), EXCLUDED.token_fees_usdc),
              sell_volume_usdc = COALESCE(NULLIF(daily_volumes.sell_volume_usdc, 0), EXCLUDED.sell_volume_usdc),
              cumulative_usdc_fees = COALESCE(NULLIF(daily_volumes.cumulative_usdc_fees, 0), EXCLUDED.cumulative_usdc_fees),
              cumulative_token_in_usdc_fees = COALESCE(NULLIF(daily_volumes.cumulative_token_in_usdc_fees, 0), EXCLUDED.cumulative_token_in_usdc_fees),
              cumulative_target_volume = COALESCE(NULLIF(daily_volumes.cumulative_target_volume, 0), EXCLUDED.cumulative_target_volume),
              cumulative_token_volume = COALESCE(NULLIF(daily_volumes.cumulative_token_volume, 0), EXCLUDED.cumulative_token_volume),
              is_complete = true,
              updated_at = CURRENT_TIMESTAMP`,
              [
                row.token, row.date, row.base_volume, row.target_volume,
                row.buy_volume, row.sell_volume, row.high, row.low,
                row.average_price, row.trade_count, row.usdc_fees, row.token_fees,
                row.token_fees_usdc, row.sell_volume_usdc, row.cumulative_usdc_fees,
                row.cumulative_token_in_usdc_fees, row.cumulative_target_volume,
                row.cumulative_token_volume,
              ]
            );
          }

          await client.query('COMMIT');
          logger.info(`[Database] Aggregated ${result.rows.length} daily records from hourly data`);
          return result.rows.length;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error: any) {
        logger.error('[Database] Error aggregating hourly to daily:', error);
        return 0;
      }
    },

    async getLatestTenMinuteBucket(): Promise<string | null> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return null;

      try {
        const result = await pool.query(
          'SELECT MAX(bucket) as latest_bucket FROM ten_minute_volumes'
        );
        return result.rows[0]?.latest_bucket?.toISOString() || null;
      } catch (error: any) {
        logger.error('[Database] Error getting latest 10-min bucket:', error);
        return null;
      }
    },

    async getTenMinuteRecordCount(): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const result = await pool.query('SELECT COUNT(*) as count FROM ten_minute_volumes');
        return parseInt(result.rows[0]?.count || '0');
      } catch (error: any) {
        logger.error('[Database] Error getting 10-min record count:', error);
        return 0;
      }
    },

    async pruneOldTenMinuteData(keepHours: number = 25): Promise<number> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return 0;

      try {
        const cutoffTime = new Date(Date.now() - keepHours * 60 * 60 * 1000).toISOString();
        const result = await pool.query(
          'DELETE FROM ten_minute_volumes WHERE bucket < $1 RETURNING id',
          [cutoffTime]
        );
        const deletedCount = result.rowCount || 0;
        if (deletedCount > 0) {
          logger.info(`[Database] Pruned ${deletedCount} 10-minute records older than ${keepHours} hours`);
        }
        return deletedCount;
      } catch (error: any) {
        logger.error('[Database] Error pruning old 10-min data:', error);
        return 0;
      }
    },
  };
}

export type IntervalVolumesRepo = ReturnType<typeof createIntervalVolumesRepo>;
