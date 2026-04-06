import { logger } from '../../../../utils/logger.js';
import type { DbRuntime } from '../dbRuntime.js';

export function createV06TradingActivityRepo(db: DbRuntime) {
  return {
    /**
     * Get daily trading activity from the v06_fee_volume_daily_aggregate table.
     * Returns spot + conditional breakdown with a has_conditional_volume flag per row.
     */
    async getDailyTradingActivity(options?: {
      token?: string;
      tokens?: string[];
      startDate?: string;
      endDate?: string;
    }): Promise<{
      token: string;
      date: string;
      has_conditional_volume: boolean;
      spot_buy_volume: string;
      spot_sell_volume: string;
      spot_base_volume: string;
      spot_target_volume: string;
      spot_trade_count: number;
      spot_usdc_fees: string;
      spot_token_fees: string;
      spot_token_fees_usdc: string;
      conditional_buy_volume: string | null;
      conditional_sell_volume: string | null;
      conditional_base_volume: string | null;
      conditional_target_volume: string | null;
      conditional_trade_count: number | null;
      conditional_usdc_fees: string | null;
      conditional_token_fees: string | null;
      conditional_token_fees_usdc: string | null;
      total_buy_volume: string;
      total_sell_volume: string;
      total_base_volume: string;
      total_target_volume: string;
      total_trade_count: number;
      total_usdc_fees: string;
      total_token_fees: string;
      total_token_fees_usdc: string;
      conditional_reconciled: boolean;
      pending_open_proposals: number;
    }[]> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

      try {
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

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
          (conditional_buy_volume IS NOT NULL) AS has_conditional_volume,
          (spot_buy_volume / 1e6)::text AS spot_buy_volume,
          (spot_sell_volume / 1e6)::text AS spot_sell_volume,
          (spot_base_volume / 1e6)::text AS spot_base_volume,
          (spot_target_volume / 1e6)::text AS spot_target_volume,
          spot_trade_count,
          (spot_usdc_fees / 1e6)::text AS spot_usdc_fees,
          (spot_token_fees / 1e6)::text AS spot_token_fees,
          (spot_token_fees_usdc / 1e6)::text AS spot_token_fees_usdc,
          (conditional_buy_volume / 1e6)::text AS conditional_buy_volume,
          (conditional_sell_volume / 1e6)::text AS conditional_sell_volume,
          (conditional_base_volume / 1e6)::text AS conditional_base_volume,
          (conditional_target_volume / 1e6)::text AS conditional_target_volume,
          conditional_trade_count,
          (conditional_usdc_fees / 1e6)::text AS conditional_usdc_fees,
          (conditional_token_fees / 1e6)::text AS conditional_token_fees,
          (conditional_token_fees_usdc / 1e6)::text AS conditional_token_fees_usdc,
          (total_buy_volume / 1e6)::text AS total_buy_volume,
          (total_sell_volume / 1e6)::text AS total_sell_volume,
          (total_base_volume / 1e6)::text AS total_base_volume,
          (total_target_volume / 1e6)::text AS total_target_volume,
          total_trade_count,
          (total_usdc_fees / 1e6)::text AS total_usdc_fees,
          (total_token_fees / 1e6)::text AS total_token_fees,
          (total_token_fees_usdc / 1e6)::text AS total_token_fees_usdc,
          conditional_reconciled,
          pending_open_proposals
         FROM v06_fee_volume_daily_aggregate
         ${whereClause}
         ORDER BY token, date ASC`,
          params
        );

        return result.rows;
      } catch (error: any) {
        logger.error('[Database] Error getting daily trading activity:', error);
        return [];
      }
    },
  };
}

export type V06TradingActivityRepo = ReturnType<typeof createV06TradingActivityRepo>;
